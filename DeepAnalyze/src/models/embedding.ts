// =============================================================================
// DeepAnalyze - Embedding Model Management
// Provides embedding generation via OpenAI-compatible APIs or a hash-based
// fallback when no embedding model is configured.
// =============================================================================

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ModelRouter } from "./router.js";
import { getProviderMetadata } from "./provider-registry.js";
import { withRetry } from "../utils/retry.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Result of embedding a single piece of text. */
export interface EmbeddingResult {
  /** The embedding vector. */
  embedding: Float32Array;
  /** The original text that was embedded. */
  text: string;
  /** Estimated token count for the text. */
  tokenCount: number;
}

/** Contract for an embedding provider. */
export interface EmbeddingProvider {
  /** Human-readable name for this provider. */
  readonly name: string;
  /** Dimensionality of the embedding vectors. */
  readonly dimension: number;
  /** Generate embeddings for a batch of texts. */
  embed(texts: string[]): Promise<EmbeddingResult[]>;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible embedding provider
// ---------------------------------------------------------------------------

export interface OpenAIEmbeddingOptions {
  name: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  dimension: number;
}

/**
 * Embedding provider that calls an OpenAI-compatible /v1/embeddings endpoint.
 * Works with Ollama, vLLM, LiteLLM, and any server implementing the protocol.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(opts: OpenAIEmbeddingOptions) {
    this.name = opts.name;
    this.dimension = opts.dimension;
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const url = `${this.endpoint}/embeddings`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const body = {
      model: this.model,
      input: texts,
    };

    const response = await withRetry(
      async () => {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "unknown error");
          throw new Error(
            `Embedding provider "${this.name}" returned HTTP ${resp.status}: ${errorText}`,
          );
        }

        return resp;
      },
      {
        maxRetries: 2,
        isRetryable: (err) => {
          if (err instanceof Error) {
            const msg = err.message;
            return /HTTP (429|500|502|503|504)/.test(msg) ||
                   /timeout|ECONNREFUSED|ECONNRESET|fetch failed|rate.?limit|too many requests/i.test(msg);
          }
          return false;
        },
      },
    );

    const data = (await response.json()) as {
      data: Array<{
        embedding: number[];
        index: number;
      }>;
      usage?: {
        prompt_tokens: number;
        total_tokens: number;
      };
    };

    if (!data.data || data.data.length === 0) {
      throw new Error(
        `Embedding provider "${this.name}" returned no embeddings`,
      );
    }

    // Sort by index to ensure correct ordering
    const sorted = [...data.data].sort((a, b) => a.index - b.index);

    return sorted.map((item, i) => ({
      embedding: new Float32Array(item.embedding),
      text: texts[i] ?? "",
      tokenCount: Math.ceil((texts[i] ?? "").length / 4),
    }));
  }
}

// ---------------------------------------------------------------------------
// Hash-based fallback embedding provider
// ---------------------------------------------------------------------------

/**
 * Simple hash-based embedding provider for when no real embedding model is
 * available. Uses overlapping n-gram hashing to create pseudo-embeddings.
 *
 * This allows the system to function without a real embedding model, but
 * will NOT provide meaningful semantic search -- only approximate lexical
 * matching. The vectors are deterministic for the same input text.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash-fallback";
  readonly dimension: number;

  constructor(dimension: number = 256) {
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map((text) => ({
      embedding: this.hashEmbed(text),
      text,
      tokenCount: Math.ceil(text.length / 4),
    }));
  }

  /**
   * Create a fixed-dimension pseudo-embedding from text using n-gram hashing.
   * Splits text into overlapping character n-grams, hashes each, and maps
   * hash values into vector positions, then normalizes the result.
   */
  private hashEmbed(text: string): Float32Array {
    const dim = this.dimension;
    const vec = new Float32Array(dim);

    if (text.length === 0) {
      return vec;
    }

    // Generate overlapping n-grams of sizes 2, 3, and 4
    const ngramSizes = [2, 3, 4];

    for (const n of ngramSizes) {
      for (let i = 0; i <= text.length - n; i++) {
        const ngram = text.substring(i, i + n);

        // Hash the n-gram using MD5 and extract two 32-bit values
        const hash = createHash("md5").update(ngram).digest();
        const h1 = hash.readUInt32LE(0);
        const h2 = hash.readUInt32LE(4);

        // Map to vector positions
        const pos1 = h1 % dim;
        const pos2 = h2 % dim;

        // Add weighted contributions
        vec[pos1] += 1.0;
        vec[pos2] -= 0.5;
      }
    }

    // Also hash individual words for single-word signals
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length === 0) continue;
      const hash = createHash("md5").update(word).digest();
      const h = hash.readUInt32LE(0);
      const pos = h % dim;
      vec[pos] += 2.0;
    }

    // Normalize to unit length
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }
}

// ---------------------------------------------------------------------------
// EmbeddingManager - unified entry point
// ---------------------------------------------------------------------------

/** Module-level singleton for cross-module access (e.g. search-test routes). */
let managerInstance: EmbeddingManager | null = null;

/**
 * Get the global EmbeddingManager instance.
 * Throws if setEmbeddingManager() has not been called yet.
 */
export function getEmbeddingManager(): EmbeddingManager {
  if (!managerInstance) {
    throw new Error("EmbeddingManager not initialized. Call setEmbeddingManager() first.");
  }
  return managerInstance;
}

/** Register the global EmbeddingManager instance after creation. */
export function setEmbeddingManager(mgr: EmbeddingManager): void {
  managerInstance = mgr;
}

/**
 * Manages embedding generation. Resolution priority:
 *   1. DB settings table (providers key, embedding default)
 *   2. Provider with "embedding" in its name/id (auto-discovery)
 *   3. YAML config file (config/default.yaml)
 *   4. Hash-based fallback
 */
export class EmbeddingManager {
  private provider: EmbeddingProvider | null = null;
  private initPromise: Promise<void> | null = null;
  private loadedVersion = -1;
  /** Timestamp when we last fell back to hash due to connection failure. */
  private degradedAt = 0;
  /** Original provider before degradation (to retry later). */
  private originalProvider: EmbeddingProvider | null = null;
  /** How long (ms) to stay degraded before retrying the real provider. */
  private static readonly DEGRADATION_COOLDOWN = 60_000; // 1 minute

  constructor(private router: ModelRouter) {}

  /** Initialize the manager — resolves provider, registers global singleton, checks dimension changes. */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    this.provider = await this.resolveProvider();
    setEmbeddingManager(this);
    this.loadedVersion = 0; // Sync with router's initial version
    await this.checkDimensionChange();
  }

  /**
   * Ensure the embedding provider is current. Re-resolves if the global
   * config version has changed (triggered by settings API updates).
   */
  private async ensureCurrent(): Promise<void> {
    // Import bumpConfigVersion's version counter to check staleness
    try {
      const router = this.router as any;
      const currentVersion = router.loadedVersion;
      // Router reloaded → we should also re-resolve
      // We track our own version: if router's loadedVersion changed, re-resolve
      if (this.loadedVersion >= 0 && currentVersion !== this.loadedVersion) {
        const newProvider = await this.resolveProvider();
        if (newProvider.name !== this.provider?.name || newProvider.dimension !== this.provider?.dimension) {
          console.log(`[EmbeddingManager] Provider changed: "${this.provider?.name}" (${this.provider?.dimension}) → "${newProvider.name}" (${newProvider.dimension})`);
          this.provider = newProvider;
          await this.checkDimensionChange();
        }
        this.loadedVersion = currentVersion;
      }
    } catch {
      // Non-critical, keep using existing provider
    }
  }

  /**
   * Compare current embedding dimension with previously stored value.
   * If different, mark all existing embeddings as stale and log a warning.
   * The actual reindex should be triggered separately via the knowledge route
   * or processing queue.
   */
  private async checkDimensionChange(): Promise<void> {
    try {
      const { getRepos } = await import("../store/repos/index.js");
      const repos = await getRepos();
      const storedDimStr = await repos.settings.get("embedding_dimension");
      const currentDim = this.provider.dimension;

      if (storedDimStr === null) {
        // First run — store current dimension
        await repos.settings.set("embedding_dimension", String(currentDim));
        return;
      }

      const storedDim = parseInt(storedDimStr, 10);
      if (storedDim === currentDim) return;

      // Dimension changed — mark all embeddings as stale
      console.warn(
        `[EmbeddingManager] Dimension changed: ${storedDim} → ${currentDim}. ` +
        `Marking all existing embeddings as stale. Trigger reindex to rebuild.`,
      );

      await repos.embedding.markAllStale();

      // Trigger background reindex for affected knowledge bases
      console.info(`[EmbeddingManager] Triggering background reindex for stale embeddings...`);
      this.triggerBackgroundReindex(repos).catch((err) => {
        console.error("[EmbeddingManager] Background reindex failed:", err instanceof Error ? err.message : String(err));
      });

      // Update stored dimension
      await repos.settings.set("embedding_dimension", String(currentDim));
    } catch (err) {
      // Non-critical — dimension check failure should not prevent startup
      console.warn(
        "[EmbeddingManager] Dimension change check failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Generate an embedding for a single piece of text. */
  async embed(text: string): Promise<EmbeddingResult> {
    if (!this.provider) throw new Error("EmbeddingManager not initialized. Call initialize() first.");
    await this.ensureCurrent();
    try {
      const results = await this.provider.embed([text]);
      // Success — clear degradation if we were degraded
      if (this.degradedAt > 0) {
        console.log("[EmbeddingManager] Provider recovered, clearing degradation");
        this.degradedAt = 0;
      }
      return results[0];
    } catch (err) {
      return this.handleEmbeddingFailure(err, [text]).then(r => r[0]);
    }
  }

  /** Generate embeddings for a batch of texts. */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.provider) throw new Error("EmbeddingManager not initialized. Call initialize() first.");
    if (texts.length === 0) return [];
    await this.ensureCurrent();

    // Process in chunks of 64 to avoid overloading the API
    const batchSize = 64;
    const allResults: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      try {
        const results = await this.provider.embed(chunk);
        // Success — clear degradation if we were degraded
        if (this.degradedAt > 0) {
          console.log("[EmbeddingManager] Provider recovered, clearing degradation");
          this.degradedAt = 0;
        }
        allResults.push(...results);
      } catch (err) {
        const fallbackResults = await this.handleEmbeddingFailure(err, chunk);
        allResults.push(...fallbackResults);
      }
    }

    return allResults;
  }

  /** Get the dimensionality of the current embedding provider. */
  get dimension(): number {
    if (!this.provider) throw new Error("EmbeddingManager not initialized. Call initialize() first.");
    return this.provider.dimension;
  }

  /** Get the name of the current embedding provider. */
  get providerName(): string {
    if (!this.provider) return "uninitialized";
    return this.provider.name;
  }

  /**
   * Whether the manager is currently in temporary hash-fallback degradation
   * (configured provider failed within the last DEGRADATION_COOLDOWN).
   * Distinct from providerName === "hash-fallback" (no provider configured
   * at all) — here a real provider is configured but temporarily unreachable,
   * so the search route should still warn the user that results are degraded.
   */
  get isDegraded(): boolean {
    if (this.degradedAt <= 0) return false;
    return Date.now() - this.degradedAt < EmbeddingManager.DEGRADATION_COOLDOWN;
  }

  /**
   * Check whether there are stale embeddings in the database.
   * Returns the count of stale embedding rows, or 0 if none.
   */
  async getStaleCount(): Promise<number> {
    try {
      const { getRepos } = await import("../store/repos/index.js");
      const repos = await getRepos();
      return await repos.embedding.getStaleCount();
    } catch {
      return 0;
    }
  }

  /** List all providers that can serve as embedding providers */
  async listEmbeddingProviders(): Promise<Array<{
    id: string;
    name: string;
    model: string;
    dimension: number;
    isAvailable: boolean;
  }>> {
    try {
      const { getRepos } = await import("../store/repos/index.js");
      const repos = await getRepos();
      const settings = await repos.settings.getProviderSettings();
      const providers: Array<{ id: string; name: string; model: string; dimension: number; isAvailable: boolean }> = [];

      for (const p of settings.providers) {
        if (!p.enabled) continue;
        // Check if provider has embedding capability
        const meta = getProviderMetadata(p.id);
        if (meta?.features.embeddings || p.id.toLowerCase().includes("embedding") || p.name.toLowerCase().includes("embedding") || p.dimension) {
          providers.push({
            id: p.id,
            name: p.name,
            model: p.model,
            dimension: p.dimension ?? 1024,
            isAvailable: true,
          });
        }
      }

      // Always include local hash fallback as an option
      providers.push({
        id: 'hash-fallback',
        name: 'Hash Fallback (no semantic search)',
        model: 'hash',
        dimension: 256,
        isAvailable: true,
      });

      return providers;
    } catch {
      return [{
        id: 'hash-fallback',
        name: 'Hash Fallback (no semantic search)',
        model: 'hash',
        dimension: 256,
        isAvailable: true,
      }];
    }
  }

  // -----------------------------------------------------------------------
  // Status reporting — used by /api/health and frontend banners
  // -----------------------------------------------------------------------

  /**
   * Return the current embedding provider state for observability.
   * `degraded === true` means the system is using hash fallback (no real
   * semantic search) — the frontend should surface a banner so the user
   * knows retrieval quality is reduced.
   */
  getStatus(): {
    provider: string | null;
    dimension: number | null;
    degraded: boolean;
    degradedAtMs: number | null;
    cooldownRemainingMs: number;
  } {
    const now = Date.now();
    const cooldownRemaining = this.degradedAt > 0
      ? Math.max(0, EmbeddingManager.DEGRADATION_COOLDOWN - (now - this.degradedAt))
      : 0;
    return {
      provider: this.provider?.name ?? null,
      dimension: this.provider?.dimension ?? null,
      degraded: this.degradedAt > 0 && cooldownRemaining > 0,
      degradedAtMs: this.degradedAt > 0 ? this.degradedAt : null,
      cooldownRemainingMs: cooldownRemaining,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Handle an embedding provider failure by falling back to hash embeddings.
   * After DEGRADATION_COOLDOWN ms, the real provider will be retried.
   */
  private async handleEmbeddingFailure(err: unknown, texts: string[]): Promise<EmbeddingResult[]> {
    const now = Date.now();

    // Check if we should retry the real provider
    if (this.degradedAt > 0 && now - this.degradedAt < EmbeddingManager.DEGRADATION_COOLDOWN) {
      // Still in cooldown — use hash fallback silently (match parent dimension)
      return new HashEmbeddingProvider(this.provider?.dimension ?? 256).embed(texts);
    }

    // First failure or cooldown expired — log warning and degrade
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[EmbeddingManager] Embedding provider "${this.provider?.name}" failed: ${errMsg}. ` +
      `Falling back to hash embeddings for ${EmbeddingManager.DEGRADATION_COOLDOWN / 1000}s.`,
    );

    this.degradedAt = now;
    return new HashEmbeddingProvider(this.provider?.dimension ?? 256).embed(texts);
  }

  private async resolveProvider(): Promise<EmbeddingProvider> {
    // Priority 1: DB settings table (explicit embedding default)
    const fromDB = await this.tryCreateFromDBSettings();
    if (fromDB) return fromDB;

    // Priority 2: Auto-discover a provider with "embedding" in its name/id
    const discovered = await this.tryDiscoverEmbeddingProvider();
    if (discovered) return discovered;

    // Priority 3: YAML config via ModelRouter
    try {
      const modelName = this.router.getDefaultModel("embedding");
      this.router.getProvider(modelName);
      return this.tryCreateFromConfig(modelName);
    } catch {
      // No embedding model configured or provider not found
    }

    // Priority 4: Hash fallback
    console.warn("[EmbeddingManager] No embedding provider found, using hash fallback (no semantic search)");
    return new HashEmbeddingProvider();
  }

  /**
   * Try to find a provider that looks like an embedding provider by checking
   * provider IDs and names for "embedding" keywords. This auto-discovers
   * providers like "minimax-embedding" without requiring explicit defaults.
   */
  private async tryDiscoverEmbeddingProvider(): Promise<EmbeddingProvider | null> {
    try {
      const { getRepos } = await import("../store/repos/index.js");
      const repos = await getRepos();
      const settings = await repos.settings.getProviderSettings();

      // Look for a provider with "embedding" in its id or name
      const embeddingProvider = settings.providers.find(
        (p) => p.enabled && (p.id.toLowerCase().includes("embedding") || p.name.toLowerCase().includes("embedding")),
      );

      if (!embeddingProvider) return null;

      const dimension = embeddingProvider.dimension ?? 1024;
      console.log(`[EmbeddingManager] Auto-discovered embedding provider: "${embeddingProvider.id}" (${embeddingProvider.model}, dim=${dimension})`);

      return new OpenAIEmbeddingProvider({
        name: embeddingProvider.id,
        endpoint: embeddingProvider.endpoint,
        apiKey: embeddingProvider.apiKey || undefined,
        model: embeddingProvider.model,
        dimension,
      });
    } catch {
      return null;
    }
  }

  /**
   * Attempt to create a provider from DB settings table.
   * Uses the unified SettingsRepo which reads from PG.
   * Returns null if DB is unavailable or no embedding provider is configured.
   */
  private async tryCreateFromDBSettings(): Promise<EmbeddingProvider | null> {
    try {
      const { getRepos } = await import("../store/repos/index.js");
      const repos = await getRepos();
      const settings = await repos.settings.getProviderSettings();
      const embeddingDefaultId = settings.defaults?.embedding;

      if (!embeddingDefaultId) return null;

      const providerConfig = settings.providers.find(
        (p) => p.id === embeddingDefaultId && p.enabled,
      );

      if (!providerConfig) return null;

      const dimension = providerConfig.dimension ?? 1024;

      return new OpenAIEmbeddingProvider({
        name: providerConfig.id,
        endpoint: providerConfig.endpoint,
        apiKey: providerConfig.apiKey || undefined,
        model: providerConfig.model,
        dimension,
      });
    } catch {
      // DB not initialized or settings unavailable
      return null;
    }
  }

  /**
   * Attempt to create an OpenAIEmbeddingProvider by reading the config file
   * directly. Falls back to HashEmbeddingProvider on any failure.
   */
  private tryCreateFromConfig(modelName: string): EmbeddingProvider {
    try {
      const configPath = resolve("config/default.yaml");
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(raw);
      const modelConfig = parsed?.models?.[modelName];

      if (!modelConfig) {
        return new HashEmbeddingProvider();
      }

      // Determine dimension from the model config or use a reasonable default
      const dimension = modelConfig.dimension ?? 1024;

      return new OpenAIEmbeddingProvider({
        name: modelName,
        endpoint: modelConfig.endpoint,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        dimension,
      });
    } catch {
      return new HashEmbeddingProvider();
    }
  }

  /** Fire-and-forget background reindex of all knowledge bases with stale embeddings */
  private async triggerBackgroundReindex(repos: any): Promise<void> {
    try {
      // Find all knowledge bases and queue reindex tasks
      const kbs = await repos.knowledgeBase.list();
      for (const kb of kbs) {
        const staleCount = await repos.embedding.countStaleByKnowledgeBase(kb.id);
        if (staleCount > 0) {
          console.info(`[EmbeddingManager] Queuing reindex for KB "${kb.name}" (${staleCount} stale embeddings)`);
          // Mark for reindex - the processing queue will pick this up
          await repos.knowledgeBase.update(kb.id, { status: "needs_reindex" } as any);
        }
      }
    } catch (err) {
      console.error("[EmbeddingManager] Background reindex error:", err instanceof Error ? err.message : String(err));
    }
  }
}
