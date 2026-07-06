// =============================================================================
// DeepAnalyze - Settings & Provider API Routes
// =============================================================================
// REST API for managing model provider configurations and system settings.
// =============================================================================

import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { getRepos } from "../../store/repos/index.js";
import type { ProviderConfig, ProviderDefaults, DoclingConfig } from "../../store/repos/index.js";
import { getAllProviders, getProviderMetadata, type ProviderMetadata } from "../../models/provider-registry.js";
import { bumpConfigVersion } from "../../models/router.js";
import { DEFAULT_AGENT_SETTINGS } from "../../services/agent/types.js";
import type { AgentSettings } from "../../services/agent/types.js";
import {
  DEFAULT_EVOLUTION_CONFIG,
  parseEvolutionConfig,
  setCachedEvolutionConfig,
  invalidateEvolutionConfigCache,
  type SelfEvolutionConfig,
} from "../../services/agent/evolution-config.js";
import { getAuthMode } from "../middleware/auth.js";

const DEFAULT_DOCLING_CONFIG: DoclingConfig = {
  layout_model: "docling-project/docling-layout-heron",
  ocr_engine: "rapidocr",
  ocr_backend: "torch",
  table_mode: "accurate",
  use_vlm: false,
  vlm_model: "zai-org/GLM-OCR",
  vlm_mode: "inline",
  parallelism: 5,
};

const EMPTY_PROVIDER_DEFAULTS: ProviderDefaults = {
  main: "", summarizer: "", embedding: "", vlm: "",
  tts: "", image_gen: "", video_gen: "", music_gen: "",
  audio_transcribe: "", video_understand: "",
};

export function createSettingsRoutes(): Hono {
  const router = new Hono();

  // -----------------------------------------------------------------------
  // Root — endpoint discovery
  // -----------------------------------------------------------------------

  router.get("/", (c) => c.json({
    status: "ok",
    message: "Settings API",
    endpoints: [
      "GET    /registry — List all known provider types",
      "GET    /registry/:id — Get provider type metadata",
      "GET    /providers — List configured providers",
      "GET    /providers/:id — Get provider settings",
      "PUT    /providers/:id — Create/update provider",
      "DELETE /providers/:id — Delete provider",
      "POST   /providers/:id/test — Test provider connectivity",
      "GET    /defaults — Get default role assignments",
      "PUT    /defaults — Update default role assignments",
      "GET    /agent — Get agent runtime settings",
      "PUT    /agent — Update agent runtime settings",
      "GET    /key/:key — Get a single setting value",
      "PUT    /key/:key — Set a single setting value",
      "GET    /enhanced-models — List enhanced model configs",
      "PUT    /enhanced-models — Update enhanced model configs",
      "POST   /auto-configure — Auto-discover and configure providers from env vars",
    ],
  }));

  // -----------------------------------------------------------------------
  // Provider registry (read-only metadata about all known providers)
  // -----------------------------------------------------------------------

  /** List all known provider types from the registry */
  router.get("/registry", (c) => {
    return c.json(getAllProviders());
  });

  /** Get metadata for a single provider type */
  router.get("/registry/:id", (c) => {
    const meta = getProviderMetadata(c.req.param("id"));
    if (!meta) {
      return c.json({ error: "Provider type not found in registry" }, 404);
    }
    return c.json(meta);
  });

  // -----------------------------------------------------------------------
  // Provider CRUD (user-configured instances)
  // -----------------------------------------------------------------------

  /** List all configured providers */
  router.get("/providers", async (c) => {
    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();
    return c.json(settings);
  });

  /** Get a single provider */
  router.get("/providers/:id", async (c) => {
    const repos = await getRepos();
    const allSettings = await repos.settings.getProviderSettings();
    const provider = allSettings.providers.find((p: ProviderConfig) => p.id === c.req.param("id"));
    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }
    return c.json(provider);
  });

  /** Create or update a provider */
  router.put("/providers/:id", async (c) => {
    const body = await c.req.json<ProviderConfig>();
    const id = c.req.param("id");

    if (body.id !== id) {
      return c.json({ error: "Provider ID in body does not match URL" }, 400);
    }

    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();
    const idx = settings.providers.findIndex((p: ProviderConfig) => p.id === id);
    if (idx >= 0) {
      settings.providers[idx] = body;
    } else {
      settings.providers.push(body);
    }

    // Auto-assign as default main provider if no default is set yet
    if (!settings.defaults.main && body.enabled) {
      console.log(`[Settings] Auto-assigning "${id}" as default main provider`);
      settings.defaults.main = id;
    }

    await repos.settings.saveProviderSettings(settings);

    bumpConfigVersion();
    return c.json({ success: true, provider: body, defaults: settings.defaults });
  });

  /** Delete a provider */
  router.delete("/providers/:id", async (c) => {
    const repos = await getRepos();
    const id = c.req.param("id");
    const settings = await repos.settings.getProviderSettings();
    const before = settings.providers.length;
    settings.providers = settings.providers.filter((p: ProviderConfig) => p.id !== id);
    if (settings.providers.length === before) {
      return c.json({ error: "Provider not found" }, 404);
    }
    // Clear any defaults that reference the deleted provider
    const defaults = settings.defaults as unknown as Record<string, string>;
    for (const key of Object.keys(defaults)) {
      if (defaults[key] === id) {
        defaults[key] = "";
      }
    }
    await repos.settings.saveProviderSettings(settings);
    bumpConfigVersion();
    console.log(`[Settings] Deleted provider "${id}", cleared stale default references`);
    return c.json({ success: true });
  });

  // -----------------------------------------------------------------------
  // Default role assignments
  // -----------------------------------------------------------------------

  /** Get current defaults */
  router.get("/defaults", async (c) => {
    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();
    return c.json(settings.defaults);
  });

  /** Update default role assignments */
  router.put("/defaults", async (c) => {
    const body = await c.req.json<Partial<ProviderDefaults>>();
    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();

    // Validate that referenced providers exist and have API keys configured.
    // Local endpoints (Ollama, native BGE-M3 on :11435, Whisper on :9877, etc.)
    // are exempt from the apiKey check — they don't require one.
    const providers = settings.providers ?? [];
    const isLocalEndpoint = (ep: unknown): boolean =>
      typeof ep === "string" && /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(ep);
    for (const [role, providerId] of Object.entries(body)) {
      if (!providerId) continue;
      const provider = (providers as Array<Record<string, unknown>>).find(p => p.id === providerId);
      if (!provider) {
        return c.json({ success: false, error: `Provider "${providerId}" not found (cannot set as ${role})` }, 400);
      }
      if (!provider.enabled) {
        return c.json({ success: false, error: `Provider "${providerId}" is disabled (cannot set as ${role})` }, 400);
      }
      if (!provider.apiKey && !isLocalEndpoint(provider.endpoint)) {
        return c.json({ success: false, error: `Provider "${providerId}" has no API key configured (cannot set as ${role})` }, 400);
      }
    }

    const oldEmbedding = settings.defaults.embedding;
    settings.defaults = { ...settings.defaults, ...body };
    console.log(`[Settings] Updating defaults:`, JSON.stringify(body), `→ main="${settings.defaults.main}"`);
    await repos.settings.saveProviderSettings(settings);
    bumpConfigVersion();

    // Trigger async reindex if embedding provider changed
    if (body.embedding !== undefined && body.embedding !== oldEmbedding && body.embedding !== "") {
      console.log(`[Settings] Embedding provider changed: "${oldEmbedding}" → "${body.embedding}", triggering reindex...`);
      import("../../services/embedding-reindex.js").then(({ reindexAllEmbeddings }) => {
        reindexAllEmbeddings((progress) => {
          if (progress.status !== "running") {
            console.log(`[Settings] Embedding reindex ${progress.status}: ${progress.completed}/${progress.total} (failed: ${progress.failed})`);
          }
        }).catch((err) => {
          console.error("[Settings] Embedding reindex failed:", err instanceof Error ? err.message : String(err));
        });
      }).catch(() => { /* ignore if module not available */ });
    }

    return c.json({ success: true, defaults: settings.defaults });
  });

  // -----------------------------------------------------------------------
  // Test provider connectivity
  // -----------------------------------------------------------------------

  /** Test if a provider endpoint is reachable */
  router.post("/providers/:id/test", async (c) => {
    const repos = await getRepos();
    const allSettings = await repos.settings.getProviderSettings();
    const provider = allSettings.providers.find((p: ProviderConfig) => p.id === c.req.param("id"));
    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    try {
      // Anthropic-compatible providers use /messages endpoint with x-api-key auth.
      // Must be tested with Anthropic protocol, not OpenAI /chat/completions.
      if (provider.type === "anthropic-compatible") {
        const messagesUrl = provider.endpoint.replace(/\/+$/, "") + "/messages";
        const anthropicHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "x-api-key": provider.apiKey,
          "anthropic-version": "2023-06-01",
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(messagesUrl, {
          signal: controller.signal,
          headers: anthropicHeaders,
          method: "POST",
          body: JSON.stringify({
            model: provider.model || "default",
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 5,
          }),
        });
        clearTimeout(timeout);
        if (resp.ok) {
          return c.json({ success: true, status: resp.status, models: [provider.model] });
        }
        const errorBody = await resp.text().catch(() => "");
        return c.json({
          success: false,
          status: resp.status,
          error: `HTTP ${resp.status}: ${errorBody.slice(0, 200)}`,
        });
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.apiKey) {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
      }

      // Strategy 1: Try /models endpoint (standard OpenAI-compatible)
      const modelsUrl = provider.endpoint.replace(/\/+$/, "") + "/models";
      const controller1 = new AbortController();
      const timeout1 = setTimeout(() => controller1.abort(), 8000);

      const modelsResp = await fetch(modelsUrl, {
        signal: controller1.signal,
        headers: { Authorization: headers["Authorization"] },
      }).catch(() => null);
      clearTimeout(timeout1);

      if (modelsResp?.ok) {
        const data = await modelsResp.json();
        return c.json({
          success: true,
          status: modelsResp.status,
          models: data.data?.map?.((m: { id: string }) => m.id) ?? [],
        });
      }

      // Strategy 2: Fallback to a minimal chat completion request
      // Many providers (MiniMax, Qwen Coding Plan) don't implement /models
      const chatUrl = provider.endpoint.replace(/\/+$/, "") + "/chat/completions";
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 15000);

      const chatResp = await fetch(chatUrl, {
        signal: controller2.signal,
        headers,
        method: "POST",
        body: JSON.stringify({
          model: provider.model || "default",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
      });
      clearTimeout(timeout2);

      if (chatResp.ok) {
        return c.json({
          success: true,
          status: chatResp.status,
          models: [provider.model],
        });
      }

      // Both failed — check if this provider is the default for any role
      const errorBody = await chatResp.text().catch(() => "");
      const defaults = allSettings.defaults as Record<string, string> | undefined;
      const affectedRoles: string[] = [];
      if (defaults) {
        for (const [role, defaultId] of Object.entries(defaults)) {
          if (defaultId === provider.id) {
            affectedRoles.push(role);
          }
        }
      }
      return c.json({
        success: false,
        status: chatResp.status,
        error: `HTTP ${chatResp.status}: ${errorBody.slice(0, 200)}`,
        ...(affectedRoles.length > 0 ? {
          warning: `此 Provider 是以下角色的默认模型: ${affectedRoles.join(", ")}。建议更换默认模型或修复 API Key。`,
          affectedRoles,
        } : {}),
      });
    } catch (err) {
      return c.json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // -----------------------------------------------------------------------
  // Agent settings (runtime-configurable)
  // -----------------------------------------------------------------------

  /** Get agent runtime settings */
  router.get("/agent", async (c) => {
    const repos = await getRepos();
    const raw = await repos.settings.get("agent_settings");
    if (!raw) return c.json({ ...DEFAULT_AGENT_SETTINGS });
    try {
      const parsed = JSON.parse(raw) as Partial<AgentSettings>;
      return c.json({ ...DEFAULT_AGENT_SETTINGS, ...parsed });
    } catch {
      return c.json({ ...DEFAULT_AGENT_SETTINGS });
    }
  });

  /** Update agent runtime settings */
  router.put("/agent", async (c) => {
    const body = await c.req.json<Partial<AgentSettings>>();
    const repos = await getRepos();

    // Get current settings
    const raw = await repos.settings.get("agent_settings");
    let current = { ...DEFAULT_AGENT_SETTINGS };
    if (raw) {
      try { current = { ...DEFAULT_AGENT_SETTINGS, ...JSON.parse(raw) }; } catch {}
    }
    const merged = { ...current, ...body };
    await repos.settings.set("agent_settings", JSON.stringify(merged));

    return c.json({ success: true, settings: merged });
  });

  // -----------------------------------------------------------------------
  // Self-evolution configuration
  // -----------------------------------------------------------------------

  /** Get self-evolution config */
  router.get("/evolution", async (c) => {
    const repos = await getRepos();
    const raw = await repos.settings.get("self_evolution_config");
    const config = parseEvolutionConfig(raw);
    setCachedEvolutionConfig(config);
    return c.json(config);
  });

  /** Update self-evolution config */
  router.put("/evolution", async (c) => {
    const body = await c.req.json<Partial<SelfEvolutionConfig>>();
    const repos = await getRepos();

    // Get current
    const raw = await repos.settings.get("self_evolution_config");
    const current = parseEvolutionConfig(raw);

    // Merge
    const merged: SelfEvolutionConfig = {
      enabled: body.enabled ?? current.enabled,
      modules: {
        persistentMemory: body.modules?.persistentMemory ?? current.modules.persistentMemory,
        memoryAccumulation: body.modules?.memoryAccumulation ?? current.modules.memoryAccumulation,
        skillEvolution: body.modules?.skillEvolution ?? current.modules.skillEvolution,
        skillMaintenance: body.modules?.skillMaintenance ?? current.modules.skillMaintenance,
        historyRecall: body.modules?.historyRecall ?? current.modules.historyRecall,
        autoDream: body.modules?.autoDream ?? current.modules.autoDream,
      },
      params: {
        nudgeInterval: body.params?.nudgeInterval ?? current.params.nudgeInterval,
        curatorIntervalDays: body.params?.curatorIntervalDays ?? current.params.curatorIntervalDays,
        archiveAfterDays: body.params?.archiveAfterDays ?? current.params.archiveAfterDays,
        staleAfterDays: body.params?.staleAfterDays ?? current.params.staleAfterDays,
      },
    };

    await repos.settings.set("self_evolution_config", JSON.stringify(merged));
    setCachedEvolutionConfig(merged);
    return c.json({ success: true, config: merged });
  });

  // -----------------------------------------------------------------------
  // Evolution data endpoints
  // -----------------------------------------------------------------------

  /** List agent memory entries */
  router.get("/evolution/memories", async (c) => {
    const repos = await getRepos();
    const category = c.req.query("category");
    const memories = await repos.agentMemory.list({ category });
    const count = await repos.agentMemory.count();
    return c.json({ memories, count });
  });

  /** Delete a single memory entry */
  router.delete("/evolution/memories/:id", async (c) => {
    const repos = await getRepos();
    const id = c.req.param("id");
    const ok = await repos.agentMemory.remove(id);
    return ok ? c.json({ success: true }) : c.json({ error: "Not found" }, 404);
  });

  /** Clear all memory entries */
  router.delete("/evolution/memories", async (c) => {
    const repos = await getRepos();
    const count = await repos.agentMemory.removeAll();
    return c.json({ success: true, deleted: count });
  });

  /** Get evolution stats */
  router.get("/evolution/stats", async (c) => {
    const repos = await getRepos();
    const [memoryCount, skillStats] = await Promise.all([
      repos.agentMemory.count(),
      repos.skillUsage.count(),
    ]);
    return c.json({ memoryCount, skillStats });
  });

  // -----------------------------------------------------------------------
  // Generic settings
  // -----------------------------------------------------------------------

  /** Get a setting value */
  router.get("/key/:key", async (c) => {
    const repos = await getRepos();
    const value = await repos.settings.get(c.req.param("key"));
    if (value === null) {
      return c.json({ error: "Setting not found" }, 404);
    }
    return c.json({ key: c.req.param("key"), value });
  });

  /** Set a setting value */
  router.put("/key/:key", async (c) => {
    try {
      const body = await c.req.json();
      const key = c.req.param("key");
      if (!key) return c.json({ error: "Missing key" }, 400);
      // JSON-encode the value so it's valid for the jsonb column
      const serialized = JSON.stringify(body?.value ?? body);
      const repos = await getRepos();
      await repos.settings.set(key, serialized);
      return c.json({ key, value: body?.value ?? body });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // Enhanced models
  // -----------------------------------------------------------------------

  /** Get enhanced model entries */
  router.get("/enhanced-models", async (c) => {
    const repos = await getRepos();
    const raw = await repos.settings.get("enhanced_models");
    if (!raw) return c.json([]);
    try {
      return c.json(JSON.parse(raw));
    } catch {
      return c.json([]);
    }
  });

  /** Save enhanced model entries */
  router.put("/enhanced-models", async (c) => {
    const models = await c.req.json<unknown[]>();
    const repos = await getRepos();
    await repos.settings.set("enhanced_models", JSON.stringify(models));
    bumpConfigVersion();
    return c.json({ success: true, count: models.length });
  });

  // -----------------------------------------------------------------------
  // Auto-configure providers from env vars
  // -----------------------------------------------------------------------

  /** Auto-discover and configure providers from environment variables */
  router.post("/auto-configure", async (c) => {
    const results: Array<{ provider: string; status: string; error?: string }> = [];

    // Map of env var names to provider registry IDs
    const envToProvider: Record<string, { id: string; modelRole: string; model: string; extraModels?: Array<{ id: string; model: string; role: string }> }> = {
      MINIMAX_API_KEY: {
        id: "minimax",
        modelRole: "main",
        model: "MiniMax-M3",
        extraModels: [
          { id: "minimax-embedding", model: "embo-01", role: "embedding" },
          { id: "minimax-tts", model: "Speech-2.8", role: "tts" },
          { id: "minimax-image", model: "image-01", role: "image_gen" },
          { id: "minimax-video", model: "Hailuo-2.3-768p-6s", role: "video_gen" },
          { id: "minimax-music", model: "Music-2.6", role: "music_gen" },
        ],
      },
      OPENAI_API_KEY: {
        id: "openai",
        modelRole: "main",
        model: "gpt-5.4",
      },
      ANTHROPIC_API_KEY: {
        id: "anthropic",
        modelRole: "main",
        model: "claude-sonnet-4-20250514",
      },
      DEEPSEEK_API_KEY: {
        id: "deepseek",
        modelRole: "main",
        model: "deepseek-chat",
      },
      OPENROUTER_API_KEY: {
        id: "openrouter",
        modelRole: "main",
        model: "anthropic/claude-4.5-sonnet",
      },
      DASHSCOPE_API_KEY: {
        id: "qwen",
        modelRole: "main",
        model: "qwen3.5-plus",
      },
      MOONSHOT_API_KEY: {
        id: "moonshot",
        modelRole: "main",
        model: "kimi-k2.5",
      },
      ZHIPUAI_API_KEY: {
        id: "zhipu",
        modelRole: "main",
        model: "glm-5.1",
      },
      GROQ_API_KEY: {
        id: "groq",
        modelRole: "main",
        model: "llama-3.3-70b-versatile",
      },
      MISTRAL_API_KEY: {
        id: "mistral",
        modelRole: "main",
        model: "mistral-large-latest",
      },
      GEMINI_API_KEY: {
        id: "gemini",
        modelRole: "main",
        model: "gemini-2.5-pro",
      },
    };

    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();
    const existingIds = new Set(settings.providers.map((p) => p.id));

    // Per-provider recommended max output tokens.
    // 0 = let the API provider decide automatically (recommended).
    const RECOMMENDED_MAX_TOKENS: Record<string, number> = {
      openai: 0,
      anthropic: 64000,
      deepseek: 0,
      minimax: 0,
      qwen: 0,
      moonshot: 0,
      zhipu: 0,
      openrouter: 0,
      groq: 0,
      mistral: 0,
      gemini: 0,
    };

    for (const [envKey, config] of Object.entries(envToProvider)) {
      const apiKey = process.env[envKey];
      if (!apiKey) {
        results.push({ provider: config.id, status: "skipped", error: `Env var ${envKey} not set` });
        continue;
      }

      const meta = getProviderMetadata(config.id);
      if (!meta) {
        results.push({ provider: config.id, status: "skipped", error: "Provider not in registry" });
        continue;
      }

      // Create main provider
      const provider: ProviderConfig = {
        id: config.id,
        name: meta.name,
        type: "openai-compatible",
        endpoint: meta.apiBase,
        apiKey,
        model: config.model,
        maxTokens: RECOMMENDED_MAX_TOKENS[config.id] ?? 16384,
        supportsToolUse: true,
        enabled: true,
      };

      if (!existingIds.has(config.id)) {
        settings.providers.push(provider);
      } else {
        const idx = settings.providers.findIndex((p) => p.id === config.id);
        if (idx >= 0) settings.providers[idx] = provider;
      }

      results.push({ provider: config.id, status: "configured" });

      // Create extra models (e.g. embedding, TTS, etc.)
      if (config.extraModels) {
        for (const extra of config.extraModels) {
          const extraProvider: ProviderConfig = {
            id: extra.id,
            name: `${meta.name} (${extra.model})`,
            type: "openai-compatible",
            endpoint: meta.apiBase,
            apiKey,
            model: extra.model,
            maxTokens: 8192,
            supportsToolUse: false,
            enabled: true,
          };

          if (!existingIds.has(extra.id)) {
            settings.providers.push(extraProvider);
          } else {
            const idx = settings.providers.findIndex((p) => p.id === extra.id);
            if (idx >= 0) settings.providers[idx] = extraProvider;
          }

          results.push({ provider: extra.id, status: "configured" });
        }
      }

      // Set as default for its primary role if not already set
      const roleKey = config.modelRole as string;
      if (!(settings.defaults as Record<string, string>)[roleKey]) {
        (settings.defaults as Record<string, string>)[roleKey] = config.id;
      }
    }

    // Save updated settings
    await repos.settings.saveProviderSettings(settings);
    bumpConfigVersion();

    return c.json({
      success: true,
      configured: results.filter((r) => r.status === "configured").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    });
  });

  // -----------------------------------------------------------------------
  // Docling document processing configuration
  // -----------------------------------------------------------------------

  /** Get current Docling config */
  router.get("/docling-config", async (c) => {
    const repos = await getRepos();
    const raw = await repos.settings.get("docling_config");
    if (!raw) return c.json({ ...DEFAULT_DOCLING_CONFIG });
    try {
      const parsed = JSON.parse(raw) as Partial<DoclingConfig>;
      return c.json({ ...DEFAULT_DOCLING_CONFIG, ...parsed });
    } catch {
      return c.json({ ...DEFAULT_DOCLING_CONFIG });
    }
  });

  /** Update Docling config */
  router.put("/docling-config", async (c) => {
    const body = await c.req.json<Partial<DoclingConfig>>();
    const repos = await getRepos();

    // Get current config
    const raw = await repos.settings.get("docling_config");
    let current = { ...DEFAULT_DOCLING_CONFIG };
    if (raw) {
      try { current = { ...DEFAULT_DOCLING_CONFIG, ...JSON.parse(raw) }; } catch {}
    }
    const merged = { ...current, ...body };
    await repos.settings.set("docling_config", JSON.stringify(merged));

    // Update queue concurrency if parallelism changed
    if (merged.parallelism) {
      try {
        const { getProcessingQueue } = await import("../../services/processing-queue.js");
        getProcessingQueue().setConcurrency(merged.parallelism);
      } catch { /* queue not yet initialized */ }
    }

    // Auto-manage PaddleOCR-VL container based on VLM mode
    if (body.use_vlm !== undefined || body.vlm_mode !== undefined) {
      const useVlm = merged.use_vlm;
      const vlmMode = (merged as Record<string, unknown>).vlm_mode as string | undefined;

      if (useVlm && vlmMode === "api") {
        // VLM API mode requested — start container in background
        import("../../services/paddleocr-vl-manager.js").then(({ startVlmContainer }) => {
          startVlmContainer().then((info) => {
            console.log(`[Settings] PaddleOCR-VL container: ${info.status}`, info.error ?? "");
          }).catch((err) => {
            console.error("[Settings] Failed to start PaddleOCR-VL container:", err);
          });
        }).catch(() => { /* module not available */ });
      }
    }

    return c.json({ success: true, config: merged });
  });

  /** Scan data/models/docling/ directory for available models.
   *  Supports two layouts:
   *    (1) Category layout:  data/models/docling/{layout,table,vlm,ocr}/<org>--<model>/
   *    (2) Flat layout:      data/models/docling/<org>--<model>/  (produced by docling's
   *        download_models(), and the layout the docling engine reads via
   *        PdfPipelineOptions.artifacts_path — see parser.py:137-140).
   *  Flat-layout entries are classified by recognizing known model families:
   *    - "docling-layout" in name  → layout
   *    - "docling-models" in name  → table (TableFormer lives in this repo)
   *    - "RapidOcr"/"rapidocr"     → ocr
   *    - everything else           → layout (default, safest)
   */
  router.get("/docling-models", (c) => {
    const dataDir = process.env.DATA_DIR ?? "data";
    const doclingDir = path.resolve(dataDir, "models", "docling");

    const categories = ["layout", "table", "vlm", "ocr"] as const;
    const result: Record<string, Array<{ id: string; name: string; path: string }>> = {};
    for (const cat of categories) result[cat] = [];

    const addEntry = (cat: typeof categories[number], dirName: string, fullPath: string) => {
      const repoId = dirName.replace("--", "/");
      result[cat].push({ id: repoId, name: dirName, path: fullPath });
    };

    // (1) Category layout: data/models/docling/<cat>/<org>--<model>/
    for (const cat of categories) {
      const catDir = path.join(doclingDir, cat);
      try {
        const entries = fs.readdirSync(catDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            addEntry(cat, entry.name, path.join(catDir, entry.name));
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    }

    // (2) Flat layout: data/models/docling/<org>--<model>/  (download_models output)
    try {
      const entries = fs.readdirSync(doclingDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const name = entry.name;
        // Skip the category subdirectories themselves (handled above)
        if ((categories as readonly string[]).includes(name)) continue;
        // Only treat as a model dir if it looks like one (contains "--" for org/model
        // namespacing, or is a known model family like RapidOcr).
        const fullPath = path.join(doclingDir, name);
        const lower = name.toLowerCase();
        let cat: typeof categories[number];
        if (lower.includes("rapidocr")) cat = "ocr";
        else if (lower.includes("docling-models") || lower.includes("tableformer")) cat = "table";
        else if (lower.includes("vlm") || lower.includes("glm-ocr") || lower.includes("paddleocr")) cat = "vlm";
        else cat = "layout"; // default: docling-layout-* and anything unrecognized
        addEntry(cat, name, fullPath);
      }
    } catch {
      // docling dir doesn't exist, nothing to add
    }

    return c.json(result);
  });

  /** Get PaddleOCR-VL container status */
  router.get("/vlm-container-status", async (c) => {
    try {
      const { getVlmContainerStatus } = await import("../../services/paddleocr-vl-manager.js");
      const status = await getVlmContainerStatus();
      return c.json(status);
    } catch {
      return c.json({ status: "unavailable", port: 8600, healthUrl: "http://localhost:8600/health", error: "Manager not available" });
    }
  });

  /** Start PaddleOCR-VL container */
  router.post("/vlm-container-start", async (c) => {
    try {
      const { startVlmContainer } = await import("../../services/paddleocr-vl-manager.js");
      const status = await startVlmContainer();
      return c.json(status);
    } catch (err) {
      return c.json({ status: "error", port: 8600, healthUrl: "http://localhost:8600/health", error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Stop PaddleOCR-VL container */
  router.post("/vlm-container-stop", async (c) => {
    try {
      const { stopVlmContainer } = await import("../../services/paddleocr-vl-manager.js");
      const status = await stopVlmContainer();
      return c.json(status);
    } catch (err) {
      return c.json({ status: "error", port: 8600, healthUrl: "http://localhost:8600/health", error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -----------------------------------------------------------------------
  // MinerU document processing configuration
  // -----------------------------------------------------------------------

  /** Get current MinerU config */
  router.get("/mineru-config", async (c) => {
    const repos = await getRepos();
    const raw = await repos.settings.get("mineru_config");
    if (!raw) {
      const { DEFAULT_MINERU_CONFIG } = await import("../../services/document-processors/mineru-client.js");
      return c.json({ ...DEFAULT_MINERU_CONFIG });
    }
    try {
      const { DEFAULT_MINERU_CONFIG } = await import("../../services/document-processors/mineru-client.js");
      return c.json({ ...DEFAULT_MINERU_CONFIG, ...JSON.parse(raw) });
    } catch {
      const { DEFAULT_MINERU_CONFIG } = await import("../../services/document-processors/mineru-client.js");
      return c.json({ ...DEFAULT_MINERU_CONFIG });
    }
  });

  /** Update MinerU config */
  router.put("/mineru-config", async (c) => {
    const body = await c.req.json();
    const repos = await getRepos();

    const raw = await repos.settings.get("mineru_config");
    const { DEFAULT_MINERU_CONFIG } = await import("../../services/document-processors/mineru-client.js");
    let current = { ...DEFAULT_MINERU_CONFIG };
    if (raw) {
      try { current = { ...DEFAULT_MINERU_CONFIG, ...JSON.parse(raw) }; } catch {}
    }
    const merged = { ...current, ...body };
    await repos.settings.set("mineru_config", JSON.stringify(merged));
    return c.json({ success: true, config: merged });
  });

  /** Check MinerU API connectivity */
  router.get("/mineru-status", async (c) => {
    try {
      const repos = await getRepos();
      const raw = await repos.settings.get("mineru_config");
      const { DEFAULT_MINERU_CONFIG, MinerUClient } = await import("../../services/document-processors/mineru-client.js");
      const config = raw
        ? { ...DEFAULT_MINERU_CONFIG, ...JSON.parse(raw) }
        : { ...DEFAULT_MINERU_CONFIG };

      if (!config.enabled) {
        return c.json({ connected: false, enabled: false });
      }

      const client = new MinerUClient(config);
      const connected = await client.healthCheck();

      // Try to get version info
      let version: string | undefined;
      if (connected) {
        try {
          const resp = await fetch(`${config.apiUrl.replace(/\/+$/, "")}/health`);
          const data = await resp.json() as { version?: string };
          version = data.version;
        } catch { /* ignore */ }
      }

      return c.json({ connected, enabled: true, version, apiUrl: config.apiUrl });
    } catch (err) {
      return c.json({ connected: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -----------------------------------------------------------------------
  // Pipeline strategy configuration
  // -----------------------------------------------------------------------

  /** Get current pipeline strategies */
  router.get("/pipeline-strategies", async (c) => {
    const repos = await getRepos();
    const raw = await repos.settings.get("pipeline_strategies");
    if (!raw) {
      const { DEFAULT_STRATEGIES } = await import("../../services/document-processors/pipeline-strategies.js");
      return c.json(DEFAULT_STRATEGIES);
    }
    try {
      return c.json(JSON.parse(raw));
    } catch {
      const { DEFAULT_STRATEGIES } = await import("../../services/document-processors/pipeline-strategies.js");
      return c.json(DEFAULT_STRATEGIES);
    }
  });

  /** Update pipeline strategies */
  router.put("/pipeline-strategies", async (c) => {
    const body = await c.req.json();
    const repos = await getRepos();
    await repos.settings.set("pipeline_strategies", JSON.stringify(body));
    return c.json({ success: true });
  });

  // -----------------------------------------------------------------------
  // Hooks API — CRUD for agent hooks
  // -----------------------------------------------------------------------

  // GET /hooks — list all hooks
  router.get("/hooks", async (c) => {
    const repos = await getRepos();
    const raw = await repos.settings.get("agent_hooks");
    const hooks = raw ? JSON.parse(raw) : [];
    return c.json({ hooks });
  });

  // PUT /hooks — save all hooks (replace)
  router.put("/hooks", async (c) => {
    const body = await c.req.json<{ hooks: unknown[] }>();
    if (!Array.isArray(body.hooks)) {
      return c.json({ error: "hooks must be an array" }, 400);
    }
    const repos = await getRepos();
    await repos.settings.set("agent_hooks", JSON.stringify(body.hooks));

    // Reload hook manager in the runner
    try {
      const { getRunner } = await import("../../services/agent/agent-system.js");
      const runner = await getRunner();
      const { HookManager } = await import("../../services/agent/hooks.js");
      const hm = new HookManager();
      await hm.loadFromSettings();
      runner.setHookManager(hm);
    } catch {
      // Runner may not be initialized yet — hooks will load on first use
    }

    return c.json({ success: true, count: body.hooks.length });
  });

  // -----------------------------------------------------------------------
  // Auth & Hub connection settings
  // -----------------------------------------------------------------------

  /** GET /auth — get auth settings (mode + any stored config) */
  router.get("/auth", async (c) => {
    const repo = (await getRepos()).settings;
    const raw = await repo.get("auth");
    const settings = raw ? JSON.parse(raw) : { mode: getAuthMode() };
    return c.json(settings);
  });

  /** PUT /auth — update auth settings (merge with existing) */
  // Fields that MUST NOT be settable via this endpoint (auth-bypass prevention).
  const SENSITIVE_AUTH_FIELDS = new Set([
    "passwordHash",
    "password",
    "mode",
    "username",
  ]);

  router.put("/auth", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();

    // Reject any attempt to set sensitive fields directly
    for (const key of Object.keys(body)) {
      if (SENSITIVE_AUTH_FIELDS.has(key)) {
        return c.json(
          { error: `field "${key}" is not settable via this endpoint` },
          400,
        );
      }
    }

    const repo = (await getRepos()).settings;
    const raw = await repo.get("auth");
    const existing = raw ? JSON.parse(raw) : {};
    const merged = { ...existing, ...body };
    await repo.set("auth", JSON.stringify(merged));
    return c.json({ ok: true, settings: merged });
  });

  /** GET /hub — get Hub connection settings + live status (sanitized) */
  router.get("/hub", async (c) => {
    const repo = (await getRepos()).settings;
    const raw = await repo.get("hub_connection");
    const stored = raw ? JSON.parse(raw) : { connected: false };

    // Build a sanitized response — never expose workerToken or other secrets
    const sanitized: Record<string, unknown> = {
      connected: stored.connected ?? false,
      hubUrl: stored.hubUrl ?? "",
    };
    if (stored.connectedAt !== undefined) {
      sanitized.connectedAt = stored.connectedAt;
    }
    if (stored.workerId !== undefined) {
      sanitized.workerId = stored.workerId;
    }

    // Augment with live HubClient status if available
    const client = globalThis.__hubClient;
    if (client && typeof (client as any).isConnected === "function") {
      sanitized.liveConnected = (client as any).isConnected();
    }
    return c.json(sanitized);
  });

  /** POST /hub/connect — store Hub connection and attempt to connect */
  router.post("/hub/connect", async (c) => {
    const body = await c.req.json<{ hubUrl: string; joinToken: string }>();
    const repo = (await getRepos()).settings;

    // Store connection info
    await repo.set("hub_connection", JSON.stringify({
      connected: true,
      hubUrl: body.hubUrl,
      connectedAt: new Date().toISOString(),
    }));

    // Try to actually connect via HubClient if method exists (Task H1)
    const client = globalThis.__hubClient as any;
    if (client && typeof client.connectToHub === "function") {
      try {
        const result = await client.connectToHub(body.hubUrl, body.joinToken);
        return c.json({ ok: true, ...result });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }

    // HubClient not initialized or connectToHub not yet implemented
    return c.json({ ok: true, note: "connection settings stored; HubClient connect pending" });
  });

  /** POST /hub/disconnect — clear Hub connection */
  router.post("/hub/disconnect", async (c) => {
    const client = globalThis.__hubClient as any;
    if (client && typeof client.disconnectFromHub === "function") {
      try { await client.disconnectFromHub(); } catch { /* ignore */ }
    }
    const repo = (await getRepos()).settings;
    await repo.set("hub_connection", JSON.stringify({ connected: false }));
    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Subservice status (from ModelServiceSupervisor)
  // -----------------------------------------------------------------------

  router.get("/services", async (c) => {
    // Returns module_states for all 4 infrastructure modules.
    // Replaces the old supervisor-based getStatus() which returned a
    // discriminated union only for currently-running services.
    try {
      const { getPool } = await import("../../store/pg.ts");
      const { PgModuleStatesRepo } = await import("../../store/repos/module-states.ts");
      const repo = new PgModuleStatesRepo(await getPool());
      const states = await repo.list();
      // Emit as { moduleId: { status, mode } } map for easy frontend consumption.
      const result: Record<string, { status: string; mode: string }> = {};
      for (const s of states) {
        result[s.moduleId] = { status: s.status, mode: s.mode };
      }
      return c.json(result);
    } catch {
      // module_states unavailable — return empty object (frontend treats
      // missing modules as 'not_installed' / 'disabled').
      return c.json({});
    }
  });

  return router;
}
