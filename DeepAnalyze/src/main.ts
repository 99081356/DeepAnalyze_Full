// =============================================================================
// DeepAnalyze - Server Entry Point
// =============================================================================

// Clear system HTTP proxy env vars before any fetch() calls.
// Bun's fetch() automatically routes through http_proxy/https_proxy,
// which can break API calls when the proxy is unreliable (e.g., VPN tools
// on WSL2).  DeepAnalyze providers have their own endpoint configuration;
// the web_fetch tool reads proxy config separately.
if (!process.env.DEEPANALYZE_KEEP_PROXY) {
  // Save proxy URL for web_fetch tool before deleting from env
  const savedProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (savedProxy) {
    process.env.DEEPANALYZE_WEB_PROXY = savedProxy;
  }
  delete process.env.http_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;
}

import { createApp } from "./server/app.ts";
import { DEEPANALYZE_CONFIG } from "./core/config.js";
import { errorMessage } from "./utils/errors.ts";
import { logError } from "./utils/logger.ts";
import {
  handleOpen,
  handleMessage,
  handleClose,
  type WsServerMessage,
} from "./server/ws.ts";
import { getAuthMode } from "./server/middleware/auth.js";
import { refreshHubJwks, startJwksRefreshTimer } from "./services/auth/hub-jwks.js";
import { getModelSupervisor } from "./server/model-supervisor.ts";

// ---------------------------------------------------------------------------
// Generate recovery.key on first startup (for emergency-reset CLI)
// ---------------------------------------------------------------------------
try {
  const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { randomBytes } = await import("node:crypto");
  const { resolve: resolvePath } = await import("node:path");
  const recoveryKeyPath = resolvePath(process.cwd(), "data/auth/recovery.key");
  if (!existsSync(recoveryKeyPath)) {
    mkdirSync(resolvePath(recoveryKeyPath, ".."), { recursive: true });
    writeFileSync(recoveryKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    console.log("[startup] Generated recovery.key for emergency-reset CLI");
  }
} catch {
  // Non-critical — emergency reset is a recovery tool, not a core feature
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
const app = await createApp();

// ---------------------------------------------------------------------------
// PostgreSQL initialization (must complete before accepting requests)
// ---------------------------------------------------------------------------
console.log("[PG] Initializing PostgreSQL...");

const port = parseInt(process.env.PORT || "21000");

async function initDatabase(): Promise<void> {
  const { getPool, migratePG } = await import("./store/pg.ts");
  const m001 = await import("./store/pg-migrations/001_init.ts");
  const m002 = await import("./store/pg-migrations/002_anchors_structure.ts");
  const m003 = await import("./store/pg-migrations/003_minimax_providers.ts");
  const m004 = await import("./store/pg-migrations/004_reports_and_teams.ts");
  const m005 = await import("./store/pg-migrations/005_embedding_stale.ts");
  const m006 = await import("./store/pg-migrations/006_document_status_expand.ts");
  const m007 = await import("./store/pg-migrations/007_provider_defaults_main.ts");
  const m008 = await import("./store/pg-migrations/008_fts_content_truncate.ts");
  const m009 = await import("./store/pg-migrations/009_dual_format_page_types.ts");
  const m010 = await import("./store/pg-migrations/010_fix_minimax_model_name.ts");
  const m011 = await import("./store/pg-migrations/011_cron_action_column.ts");
  const m012 = await import("./store/pg-migrations/012_agent_skills.ts");
  const m013 = await import("./store/pg-migrations/013_workflow_logs.ts");
  const m014 = await import("./store/pg-migrations/014_skill_anti_hallucination_test.ts");
  const m015 = await import("./store/pg-migrations/015_search_index_column.ts");
  const m016 = await import("./store/pg-migrations/016_wiki_page_session_id.ts");
  const m017 = await import("./store/pg-migrations/017_document_folder_path.ts");
  const m018 = await import("./store/pg-migrations/018_document_updated_at.ts");
  const m019 = await import("./store/pg-migrations/019_self_evolution.ts");
  const m020 = await import("./store/pg-migrations/020_skill_source_tracking.ts");
  const m021 = await import("./store/pg-migrations/021_cron_agent_fields.ts");
  const m022 = await import("./store/pg-migrations/022_skill_metadata_enhancement.ts");
  const m023 = await import("./store/pg-migrations/023_document_quality_audit_status.ts");
  const m024 = await import("./store/pg-migrations/024_anchor_line_start.ts");
  const m025 = await import("./store/pg-migrations/025_minimax_m3.ts");
  const m026 = await import("./store/pg-migrations/026_fix_cascade_deletes.ts");
  const m027 = await import("./store/pg-migrations/027_agent_tasks_cancelled_status.ts");
  const m028 = await import("./store/pg-migrations/028_workflows.ts");
  const m029 = await import("./store/pg-migrations/029_module_states.ts");
  const m030 = await import("./store/pg-migrations/030_config_versions_and_sync.ts");
  await getPool();
  await migratePG([m001.migration, m002.migration, m003.migration, m004.migration, m005.migration, m006.migration, m007.migration, m008.migration, m009.migration, m010.migration, m011.migration, m012.migration, m013.migration, m014.migration, m015.migration, m016.migration, m017.migration, m018.migration, m019.migration, m020.migration, m021.migration, m022.migration, m023.migration, m024.migration, m025.migration, m026.migration, m027.migration, m028.migration, m029.migration, m030.migration]);
  console.log("[PG] PostgreSQL ready with pgvector + zhparser");
}

async function shutdown() {
  console.log("\n[Server] Shutting down...");
  try {
    const { getProcessingQueue, resetProcessingQueue } = await import("./services/processing-queue.js");
    getProcessingQueue().stopWatchdog();
    resetProcessingQueue();
  } catch { /* queue not initialized */ }
  try {
    const { getCronScheduler } = await import("./services/cron/scheduler-lifecycle.js");
    getCronScheduler()?.stop();
  } catch { /* cron not initialized */ }
  try {
    const { runCleanupFunctions } = await import("./utils/cleanupRegistry.ts");
    await runCleanupFunctions();
  } catch { /* cleanup registry not available */ }
  try {
    const { closePool } = await import("./store/pg.ts");
    await closePool();
  } catch { /* PG not initialized */ }
  try {
    const { getModelSupervisor } = await import("./server/model-supervisor.ts");
    await getModelSupervisor().stopAll();
  } catch { /* supervisor not initialized */ }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception:", err);
  // Don't exit immediately — let the server try to continue
  // The agent-runner has per-task error isolation
});
process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled promise rejection:", reason);
  // As of Node.js 15+, unhandled rejections terminate the process by default.
  // Override to log and continue — agent tasks have their own error handling.
});

// ---------------------------------------------------------------------------
// Start: init DB first, then auto-configure embedding, then start HTTP server
// ---------------------------------------------------------------------------
// Startup profiler helpers (no-op when DA_PROFILE_STARTUP is not set)
let profileCheckpoint: (name: string) => void = () => {};
let profileReport: () => void = () => {};
try {
  const sp = await import("./utils/startupProfiler.ts");
  profileCheckpoint = sp.profileCheckpoint;
  profileReport = sp.profileReport;
} catch { /* profiler not available */ }

initDatabase().then(async () => {
  profileCheckpoint("pg_ready");

  // --- CLI setup wizard (first-run gate) ---
  // Runs interactively when: stdout is a TTY, setup not yet complete,
  // and DA_SKIP_WIZARD env var is not set. Web wizard (G3) remains
  // available via /api/setup/* for non-TTY (e.g. Docker) environments.
  if (process.stdout.isTTY && !process.env.DA_SKIP_WIZARD) {
    const { isSetupComplete } = await import("./setup/wizard.js");
    if (!isSetupComplete()) {
      const { runCliWizard } = await import("./setup/cli-wizard.js");
      await runCliWizard();
    }
  }

  await autoConfigureEmbedding();
  profileCheckpoint("embedding_configured");
  await autoConfigureVLM();
  await autoConfigureASR();
  await ensureDoclingConfig();
  await restoreProcessingConcurrency();
  profileCheckpoint("providers_configured");
  await recoverAndWatchStuckDocuments();
  await recoverStaleAgentTasks();
  await migrateFolderStructure();
  await migrateProviderEndpoints();
  await backfillManifests();
  await ensureBuiltinSkills();
  profileCheckpoint("data_ready");

  // JWKS preload (hub mode only)
  if (getAuthMode() === "hub") {
    await refreshHubJwks().catch(err =>
      console.warn(`[startup] JWKS refresh failed: ${err instanceof Error ? err.message : err}`),
    );
    startJwksRefreshTimer();
    console.log("[startup] Hub JWKS preloaded, 6h refresh timer started");
  }

  // Model service supervisor: per-module start happens via /api/modules/:moduleId/start
  // (driven by module_states). Embedding/Whisper subprocesses are launched by start.py
  // based on module_states.mode='local' + status='running'. The supervisor instance is
  // initialized lazily by getModelSupervisor(); shutdown uses stopAll() below.
  getModelSupervisor();

  await startHttpServer();
  profileCheckpoint("http_server_ready");
  profileReport();
}).catch((err) => {
  console.error(
    "[PG] Initialization failed:",
    errorMessage(err),
  );
  logError(err);
  process.exit(1);
});

/**
 * Recover documents stuck in intermediate states (parsing, compiling, indexing, linking)
 * that were interrupted by a server restart. Uses ProcessingQueue.recoverStaleJobs()
 * which both resets their status AND re-enqueues them for processing.
 * Also starts a periodic watchdog to catch future hangs.
 */
async function recoverAndWatchStuckDocuments(): Promise<void> {
  try {
    const { getProcessingQueue } = await import("./services/processing-queue.js");
    const queue = getProcessingQueue();
    const recovered = await queue.recoverStaleJobs();

    if (recovered > 0) {
      console.log(`[Startup] Recovered ${recovered} stale document(s), re-enqueued for processing`);
    }

    // Start watchdog: check every 60s, recover jobs stuck for >15 minutes
    queue.startWatchdog(60_000, 900_000);
  } catch (err) {
    console.warn(
      "[Startup] Failed to recover stuck documents:",
      errorMessage(err),
    );
  }
}

/**
 * Auto-configure the local BGE-M3 embedding server as a provider if:
 * 1. The embedding server is reachable (started by start.py on EMBEDDING_PORT)
 * 2. No embedding default is already configured
 *
 * If the local server is not available, tries to fall back to a configured
 * remote embedding provider (e.g. MiniMax-embedding).
 */
async function autoConfigureEmbedding(): Promise<void> {
  const embeddingPort = process.env.EMBEDDING_PORT ?? "11435";
  // In Docker deployment, EMBEDDING_HOST is set to the service name (e.g. "embedding")
  const embeddingHost = process.env.EMBEDDING_HOST ?? "127.0.0.1";
  const embeddingEndpoint = `http://${embeddingHost}:${embeddingPort}/v1`;
  const { getRepos } = await import("./store/repos/index.ts");
  const repos = await getRepos();
  const settings = await repos.settings.getProviderSettings();

  // Check if the local embedding server is reachable.
  // Gate by module_states: only auto-configure local BGE-M3 when the embedding
  // module is in mode=local + status=running. This prevents stale auto-config
  // when the user has switched to remote or disabled the module.
  const { getPool } = await import("./store/pg.ts");
  const { PgModuleStatesRepo } = await import("./store/repos/module-states.ts");
  const moduleRepo = new PgModuleStatesRepo(await getPool());
  const embeddingState = await moduleRepo.get("embedding");
  const moduleAllowsLocal = embeddingState?.mode === "local" && embeddingState?.status === "running";

  let localAvailable = false;
  if (moduleAllowsLocal) {
    try {
      const resp = await fetch(`http://${embeddingHost}:${embeddingPort}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      localAvailable = resp.ok;
    } catch {
      localAvailable = false;
    }
  }

  if (localAvailable) {
    // Local embedding server is running — configure it
    try {
      // Check if a local embedding provider already exists
      const existingLocal = settings.providers.find(
        (p) => p.id === "local-bge-m3" || (p.endpoint && p.endpoint.includes(`:${embeddingPort}`)),
      );
      if (existingLocal && existingLocal.enabled) {
        // Update the endpoint to match the currently running server
        let needsSave = false;
        if (existingLocal.endpoint !== embeddingEndpoint) {
          console.log(`[Embedding] Updating endpoint: ${existingLocal.endpoint} -> ${embeddingEndpoint}`);
          existingLocal.endpoint = embeddingEndpoint;
          needsSave = true;
        }
        // Ensure it's set as the embedding default
        if (settings.defaults?.embedding !== existingLocal.id) {
          settings.defaults.embedding = existingLocal.id;
          needsSave = true;
        }
        if (needsSave) {
          await repos.settings.saveProviderSettings(settings);
          console.log(`[Embedding] Updated local embedding config (default: ${existingLocal.id})`);
        }
        return;
      }

      // Register the local BGE-M3 embedding provider
      const localEmbeddingProvider = {
        id: "local-bge-m3",
        name: "BGE-M3 (本地嵌入)",
        type: "openai-compatible",
        endpoint: embeddingEndpoint,
        apiKey: "",
        model: "bge-m3",
        maxTokens: 8192,
        supportsToolUse: false,
        enabled: true,
        dimension: 1024,
      };

      if (existingLocal) {
        const idx = settings.providers.findIndex((p) => p.id === existingLocal.id);
        if (idx >= 0) settings.providers[idx] = localEmbeddingProvider;
      } else {
        settings.providers.push(localEmbeddingProvider);
      }

      settings.defaults.embedding = "local-bge-m3";
      await repos.settings.saveProviderSettings(settings);
      console.log("[Embedding] Auto-configured local BGE-M3 embedding (dim=1024)");
    } catch (err) {
      console.warn(
        "[Embedding] Failed to auto-configure BGE-M3:",
        errorMessage(err),
      );
    }
    return;
  }

  // Local server not available — clean up stale local config
  if (settings.defaults?.embedding === "local-bge-m3") {
    settings.defaults.embedding = "";
    await repos.settings.saveProviderSettings(settings);
    console.log("[Embedding] Removed unavailable local-bge-m3 from defaults");
  }

  // Try to fall back to a remote embedding provider
  const remoteEmbedding = settings.providers.find(
    (p) =>
      p.enabled &&
      p.id !== "local-bge-m3" &&
      (p.id.toLowerCase().includes("embedding") || p.name.toLowerCase().includes("embedding")),
  );

  if (remoteEmbedding && settings.defaults?.embedding !== remoteEmbedding.id) {
    // Check if the remote provider is reachable before setting it as default
    try {
      const testResp = await fetch(`${remoteEmbedding.endpoint.replace(/\/+$/, "")}/models`, {
        headers: remoteEmbedding.apiKey ? { Authorization: `Bearer ${remoteEmbedding.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (testResp.ok) {
        settings.defaults.embedding = remoteEmbedding.id;
        await repos.settings.saveProviderSettings(settings);
        console.log(`[Embedding] Fell back to remote provider: ${remoteEmbedding.id} (${remoteEmbedding.model})`);
      } else {
        console.warn(`[Embedding] Remote provider ${remoteEmbedding.id} returned ${testResp.status}, not setting as default`);
      }
    } catch (err) {
      console.warn(
        `[Embedding] Remote provider ${remoteEmbedding.id} unreachable:`,
        errorMessage(err),
      );
    }
  }

  if (!settings.defaults?.embedding) {
    console.warn("[Embedding] No embedding provider available. System will use hash fallback (no semantic search).");
    console.warn("[Embedding] To enable semantic search, start the local BGE-M3 service or configure a remote embedding provider in Settings.");
  }
}

/**
 * Migrate legacy documents from UUID-based directory structure to preserved
 * folder structure. Safe to call on every startup — idempotent.
 */
async function migrateFolderStructure(): Promise<void> {
  try {
    const { migrateFolderStructure: doMigrate } = await import("./services/folder-migration.js");
    await doMigrate();
  } catch (err) {
    console.warn(
      "[Startup] Folder structure migration failed:",
      errorMessage(err),
    );
  }
}

/**
 * Migrate legacy GLM provider endpoints from /api/paas/v4 (OpenAI protocol)
 * to /api/anthropic (official Anthropic-compatible protocol). Idempotent.
 */
async function migrateProviderEndpoints(): Promise<void> {
  try {
    const { migrateProviderEndpoints: doMigrate } = await import("./services/provider-endpoint-migration.js");
    const result = await doMigrate();
    if (result.checked > 0 && result.migrated === 0) {
      // Silent on no-op runs to avoid log noise on every startup.
    }
  } catch (err) {
    console.warn(
      "[Startup] Provider endpoint migration failed:",
      errorMessage(err),
    );
  }
}

/**
 * Backfill manifest.json for all existing knowledge bases.
 * Ensures KBs created before this feature get their manifests generated.
 */
async function backfillManifests(): Promise<void> {
  try {
    const { getRepos } = await import("./store/repos/index.ts");
    const repos = await getRepos();
    const kbs = await repos.knowledgeBase.list();
    if (kbs.length === 0) return;
    const { updateManifest } = await import("./wiki/manifest.js");
    for (const kb of kbs) {
      await updateManifest(kb.id);
    }
    console.log(`[Startup] Backfilled manifests for ${kbs.length} knowledge base(s)`);
  } catch (err) {
    console.warn(
      "[Startup] Manifest backfill failed:",
      errorMessage(err),
    );
  }
}

/**
 * Restore processing queue concurrency from saved docling_config settings.
 * The queue defaults to 5, but users can configure parallelism via the settings UI.
 */
async function restoreProcessingConcurrency(): Promise<void> {
  try {
    const { getRepos } = await import("./store/repos/index.ts");
    const repos = await getRepos();
    const raw = await repos.settings.get("docling_config");
    if (raw) {
      const config = JSON.parse(raw);
      if (config.parallelism && typeof config.parallelism === "number") {
        const { getProcessingQueue } = await import("./services/processing-queue.js");
        getProcessingQueue().setConcurrency(config.parallelism);
        console.log(`[Startup] Processing queue concurrency: ${config.parallelism}`);
      }
    }
  } catch {
    // Settings not available yet — queue uses default concurrency
  }
}

/**
 * Auto-configure a local Ollama vision model (VLM) as provider if:
 * 1. Ollama is reachable at localhost:11434
 * 2. A vision-capable model is installed (minicpm-v, llava, gemma3, etc.)
 * 3. No VLM default is already configured
 */
async function autoConfigureVLM(): Promise<void> {
  const { getRepos } = await import("./store/repos/index.ts");
  const repos = await getRepos();
  const settings = await repos.settings.getProviderSettings();

  // Skip if VLM is already configured
  if (settings.defaults?.vlm) return;

  // Check if Ollama is reachable
  let ollamaTags: any = null;
  try {
    const resp = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      ollamaTags = await resp.json();
    }
  } catch {
    return; // Ollama not available
  }

  if (!ollamaTags?.models || !Array.isArray(ollamaTags.models)) return;

  // Vision model name patterns (Ollama models with vision capability)
  const visionPatterns = [
    /minicpm-v/i,
    /llava/i,
    /gemma3/i,
    /qwen.*vl/i,
    /qwen2.*vl/i,
    /cogvlm/i,
    /llama.*vision/i,
    /pixtral/i,
    /bakllava/i,
    /moondream/i,
  ];

  const visionModel = ollamaTags.models.find((m: any) =>
    visionPatterns.some((pat) => pat.test(m.name || "")),
  );

  if (!visionModel) return;

  const modelName = (visionModel.name as string).split(":")[0]; // Remove tag like :latest

  // Register local Ollama VLM provider
  const localVlmProvider = {
    id: "local-ollama-vlm",
    name: `${modelName} (本地VLM)`,
    type: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    apiKey: "",
    model: visionModel.name,
    maxTokens: 4096,
    supportsToolUse: false,
    enabled: true,
  };

  // Check if provider already exists
  const existingIdx = settings.providers.findIndex((p: any) => p.id === "local-ollama-vlm");
  if (existingIdx >= 0) {
    settings.providers[existingIdx] = localVlmProvider;
  } else {
    settings.providers.push(localVlmProvider);
  }

  settings.defaults.vlm = "local-ollama-vlm";
  await repos.settings.saveProviderSettings(settings);
  console.log(`[VLM] Auto-configured local Ollama VLM: ${visionModel.name}`);
}

/**
 * Auto-configure a local Whisper HTTP service as ASR provider if:
 * 1. The whisper HTTP service is reachable at localhost:WHISPER_HTTP_PORT
 * 2. No audio_transcribe default is already configured
 *
 * If the service is not available, the AudioProcessor will still fall back
 * to subprocess mode, so this is non-blocking.
 */
async function autoConfigureASR(): Promise<void> {
  const { getRepos } = await import("./store/repos/index.ts");
  const repos = await getRepos();
  const settings = await repos.settings.getProviderSettings();

  // Skip if ASR is already configured
  if (settings.defaults?.audio_transcribe) return;

  const whisperPort = process.env.WHISPER_HTTP_PORT ?? "9877";

  // Gate by module_states: only auto-configure local Whisper when the ASR
  // module is in mode=local + status=running. This prevents stale auto-config
  // when the user has switched to remote or disabled the module.
  const { getPool } = await import("./store/pg.ts");
  const { PgModuleStatesRepo } = await import("./store/repos/module-states.ts");
  const moduleRepo = new PgModuleStatesRepo(await getPool());
  const asrState = await moduleRepo.get("asr");
  const moduleAllowsLocal = asrState?.mode === "local" && asrState?.status === "running";

  // Check if local whisper HTTP service is reachable
  let whisperAvailable = false;
  if (moduleAllowsLocal) {
    try {
      const resp = await fetch(`http://127.0.0.1:${whisperPort}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      whisperAvailable = resp.ok;
    } catch {
      whisperAvailable = false;
    }
  }

  if (!whisperAvailable) return;

  // Register local Whisper ASR provider
  const localWhisperProvider = {
    id: "local-whisper",
    name: "Whisper (本地语音转写)",
    type: "openai-compatible",
    endpoint: `http://127.0.0.1:${whisperPort}/v1`,
    apiKey: "",
    model: "whisper",
    maxTokens: 0,
    supportsToolUse: false,
    enabled: true,
  };

  const existingIdx = settings.providers.findIndex((p: any) => p.id === "local-whisper");
  if (existingIdx >= 0) {
    settings.providers[existingIdx] = localWhisperProvider;
  } else {
    settings.providers.push(localWhisperProvider);
  }

  settings.defaults.audio_transcribe = "local-whisper";
  await repos.settings.saveProviderSettings(settings);
  console.log(`[ASR] Auto-configured local Whisper HTTP service (port ${whisperPort})`);
}

/**
 * Ensure Docling default configuration exists in settings.
 * Docling is lazy-loaded as a subprocess, no service startup needed.
 */
async function ensureDoclingConfig(): Promise<void> {
  const { getRepos } = await import("./store/repos/index.ts");
  const repos = await getRepos();
  const raw = await repos.settings.get("docling_config");

  if (raw) return; // Already configured

  // Write sensible defaults: rapidocr + accurate table mode
  const defaultConfig = {
    pipeline: "rapidocr",
    table_mode: "accurate",
    parallelism: 5,
    ocr_engine: "rapidocr",
  };

  await repos.settings.set("docling_config", JSON.stringify(defaultConfig));
  console.log("[Docling] Set default configuration (rapidocr + accurate tables)");
}

/**
 * Ensure all built-in skills are registered in the agent_skills table.
 * Called eagerly at startup so skills are available in the UI immediately,
 * without waiting for the first agent request to trigger lazy initialization.
 */
async function ensureBuiltinSkills(): Promise<void> {
  try {
    const { getRepos } = await import("./store/repos/index.ts");
    const repos = await getRepos();
    const { ensureBuiltinSkills: doEnsure } = await import("./services/agent/builtin-skills.js");
    await doEnsure(repos);
  } catch (err) {
    console.warn(
      "[Startup] Built-in skills initialization failed:",
      errorMessage(err),
    );
  }
}

/**
 * Pre-warm the agent system by triggering the lazy initialization in the background.
 * This ensures the first real request to /api/agents/* doesn't block on expensive
 * initialization (ModelRouter, provider connections, etc.).
 * The initialization runs in parallel with normal server operation and is idempotent.
 */
function preWarmAgentSystem(): void {
  // Run in background — don't block server startup
  setImmediate(async () => {
    try {
      console.log("[AgentSystem] Pre-warming agent system in background...");
      const { getOrchestrator } = await import("./services/agent/agent-system.js");
      await getOrchestrator();
      console.log("[AgentSystem] Pre-warming complete.");
    } catch (err) {
      console.warn(
        "[AgentSystem] Pre-warming failed (will retry on first request):",
        errorMessage(err),
      );
    }
  });
}

/**
 * Recover agent tasks stuck in "running" status from a previous server instance.
 * These are tasks that were in-progress when the server was killed/crashed.
 * Mark them as failed with a descriptive error so they don't remain stuck forever.
 */
async function recoverStaleAgentTasks(): Promise<void> {
  try {
    const { getPool } = await import("./store/pg.js");
    const pool = await getPool();
    const { rows } = await pool.query(
      `UPDATE agent_tasks
       SET status = 'failed', error = 'Server restarted while task was running', completed_at = now()
       WHERE status = 'running'
       RETURNING id, session_id, agent_type`,
    );
    if (rows.length > 0) {
      console.log(`[Startup] Recovered ${rows.length} stale agent task(s) marked as failed`);
    }
  } catch (err) {
    // Table may not exist yet during first startup, or other transient issues
    console.warn("[Startup] Could not recover stale agent tasks:", errorMessage(err));
  }
}

async function startHttpServer() {
  if (typeof Bun !== "undefined") {
    Bun.serve({
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws" && server.upgrade(req)) {
          return;
        }
        return app.fetch(req, server);
      },
      websocket: {
        open(ws) { handleOpen(ws as unknown as WebSocket); },
        message(ws, message) { handleMessage(ws as unknown as WebSocket, message as string); },
        close(ws) { handleClose(ws as unknown as WebSocket); },
      },
      idleTimeout: 0,
    });
  } else {
    import("@hono/node-server").then(({ serve }) => {
      const server = serve({ fetch: app.fetch, port });
      server.setTimeout(0);
      (server as any).requestTimeout = 0;
      (server as any).headersTimeout = 0;
      (server as any).keepAliveTimeout = 0;

      let wssPromise: Promise<InstanceType<typeof import("ws").WebSocketServer>> | null = null;

      server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (url.pathname === "/ws") {
          if (!wssPromise) {
            wssPromise = import("ws").then(({ WebSocketServer }) => new WebSocketServer({ noServer: true }));
          }
          wssPromise.then((wss) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
              handleOpen(ws as any);
              ws.on("message", (data) => { handleMessage(ws as any, data as Buffer); });
              ws.on("close", () => { handleClose(ws as any); });
            });
          }).catch((err) => {
            console.error("[WS] Failed to initialize WebSocketServer:", err);
            logError(err);
            wssPromise = null;
            socket.destroy();
          });
        }
      });
    });
  }

  console.log(`DeepAnalyze server running on http://localhost:${port}`);
  console.log(`[WS] WebSocket endpoint available at ws://localhost:${port}/ws`);

  // Pre-warm agent system in background so first request doesn't block
  // on the expensive lazy initialization (ModelRouter, embeddings, etc.)
  preWarmAgentSystem();

  // Start cron scheduler at boot (not lazy on first API call)
  try {
    const { startCronScheduler } = await import("./services/cron/scheduler-lifecycle.js");
    startCronScheduler();
  } catch (err) {
    console.warn("[Startup] Failed to start cron scheduler:", errorMessage(err));
  }

  // ─── Worker mode initialization ────────────────────────────────────────
  if (DEEPANALYZE_CONFIG.runMode === "worker") {
    try {
      const { HubClient } = await import("./services/hub/hub-client.js");
      const { getOrCreateWorkerId } = await import("./services/hub/worker-identity.js");

      const workerId = DEEPANALYZE_CONFIG.workerId === "auto"
        ? getOrCreateWorkerId(DEEPANALYZE_CONFIG.dataDir)
        : DEEPANALYZE_CONFIG.workerId;

      const hubClient = new HubClient({
        runMode: "worker",
        serverUrl: DEEPANALYZE_CONFIG.serverUrl,
        workerId,
        workerToken: DEEPANALYZE_CONFIG.workerToken,
      });

      // join_token path: auto-register using DA_JOIN_TOKEN at startup
      const joinToken = process.env.DA_JOIN_TOKEN;
      if (joinToken) {
        try {
          const result = await hubClient.connectToHub(DEEPANALYZE_CONFIG.serverUrl, joinToken);
          console.log(`[Hub] Auto-registered via join_token, workerId: ${result.workerId}`);
          // Clear the env var so it's not re-used on subsequent in-process logic
          delete process.env.DA_JOIN_TOKEN;
        } catch (err) {
          console.error(`[Hub] join_token registration failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        const regResult = await hubClient.register();
        if (regResult) {
          console.log(`[Hub] Registered with server, workerId: ${workerId}, serverVersion: ${regResult.serverVersion}`);
          hubClient.startHeartbeat(30_000);
        } else {
          console.log(`[Hub] Server unreachable at ${DEEPANALYZE_CONFIG.serverUrl}, running in standalone mode`);
        }
      }

      globalThis.__hubClient = hubClient;

      // T16: First-build auto-sync from Hub (only runs if last_hub_sync_at IS NULL).
      // Placed AFTER globalThis.__hubClient assignment so the function can read it
      // directly without a circular import on routes/hub.ts.
      try {
        const { maybeAutoSyncOnStartup } = await import("./services/hub/sync-from-hub.js");
        await maybeAutoSyncOnStartup();
      } catch (err) {
        console.warn(`[Hub] Auto-sync on startup failed: ${err instanceof Error ? err.message : err}`);
      }
    } catch (err) {
      console.warn(`[Hub] Worker mode initialization failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
