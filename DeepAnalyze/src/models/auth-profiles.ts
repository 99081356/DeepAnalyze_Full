// =============================================================================
// DeepAnalyze - Auth Profile Rotation
// =============================================================================
// Multi-API-key per provider with cooldown tracking and LRU/round-robin selection.
//
// Motivation:
//   - Rate limits (429) are per-key, so rotating keys distributes load
//   - Billing errors may disable a key temporarily
//   - Auth errors invalidate a key permanently
//   - LRU selection avoids hammering the same key repeatedly
//
// Design:
//   Each provider can have multiple API keys configured via `apiKeys` array
//   in the provider config. The AuthProfileManager tracks per-key usage stats
//   and selects the best available key on each request.
//
// Cooldown strategy:
//   - Rate limit (429): stepped backoff (30s → 60s → 5min)
//   - Billing/auth errors: exponential backoff (5min base, 60min max)
//   - Model-scoped cooldown: only blocks the specific model that triggered 429

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CooldownReason =
  | "rate_limit"     // HTTP 429
  | "billing"        // HTTP 402 / billing-related errors
  | "auth_permanent" // HTTP 401/403 (invalid/expired key)
  | "transient"      // Network timeout, 5xx errors
  | "aborted";       // User-initiated cancellation via AbortController

export interface ApiKeyProfile {
  /** The API key string */
  key: string;
  /** User-friendly label */
  label?: string;
}

export interface ProfileUsageStats {
  /** Timestamp of last successful use */
  lastUsed: number;
  /** Cooldown end timestamp */
  cooldownUntil: number;
  /** Reason for current cooldown */
  cooldownReason?: CooldownReason;
  /** Model that triggered rate limit (for model-scoped cooldown) */
  cooldownModel?: string;
  /** Consecutive error count */
  errorCount: number;
  /** Timestamp of last failure */
  lastFailureAt: number;
}

// ---------------------------------------------------------------------------
// Cooldown calculation
// ---------------------------------------------------------------------------

/**
 * Stepped backoff for transient/rate-limit failures.
 * Returns cooldown duration in milliseconds.
 */
function calculateTransientCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  if (normalized <= 1) return 30_000;   // 30 seconds
  if (normalized <= 2) return 60_000;   // 1 minute
  return 5 * 60_000;                    // 5 minutes max
}

/**
 * Exponential backoff for billing/auth_permanent failures.
 * Returns cooldown duration in milliseconds.
 */
function calculatePermanentCooldownMs(
  errorCount: number,
  baseMs: number = 5 * 60_000,  // 5 minutes
  maxMs: number = 60 * 60_000,  // 60 minutes
): number {
  const exponent = Math.min(errorCount - 1, 10);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, raw);
}

// ---------------------------------------------------------------------------
// AuthProfileManager
// ---------------------------------------------------------------------------

export class AuthProfileManager {
  /** Per-provider stats, keyed by `${providerId}:${apiKeyPrefix}` */
  private stats = new Map<string, ProfileUsageStats>();
  /** Per-provider last-good key prefix (for LRU) */
  private lastGood = new Map<string, string>();

  /**
   * Get a cache key for a provider+key pair.
   * Uses first 8 chars of API key for privacy (never log full keys).
   */
  private statsKey(providerId: string, apiKey: string): string {
    return `${providerId}:${apiKey.slice(0, 8)}`;
  }

  /**
   * Get or create usage stats for a key.
   */
  private getStats(providerId: string, apiKey: string): ProfileUsageStats {
    const key = this.statsKey(providerId, apiKey);
    let stats = this.stats.get(key);
    if (!stats) {
      stats = {
        lastUsed: 0,
        cooldownUntil: 0,
        cooldownReason: undefined,
        cooldownModel: undefined,
        errorCount: 0,
        lastFailureAt: 0,
      };
      this.stats.set(key, stats);
    }
    return stats;
  }

  /**
   * Select the best available API key for a provider.
   * Returns the key to use, or the primary key if no rotation configured.
   *
   * Selection priority:
   * 1. Keys not in cooldown, sorted by least-recently-used (round-robin)
   * 2. Keys in model-scoped cooldown that can be bypassed
   * 3. Keys in cooldown with soonest expiry (as fallback)
   * 4. Primary key (last resort)
   *
   * @param providerId - Provider identifier
   * @param primaryApiKey - The primary (default) API key
   * @param alternateKeys - Optional array of additional keys
   * @param model - Optional model ID for model-scoped cooldown bypass
   */
  selectApiKey(
    providerId: string,
    primaryApiKey: string,
    alternateKeys: ApiKeyProfile[] | undefined,
    model?: string,
  ): string {
    // If no alternate keys configured, return primary
    if (!alternateKeys || alternateKeys.length === 0) {
      return primaryApiKey;
    }

    const now = Date.now();
    const allKeys = [
      { key: primaryApiKey, label: "primary" },
      ...alternateKeys,
    ];

    // Partition keys into available, model-bypassable, and cooling
    const available: Array<{ key: string; stats: ProfileUsageStats }> = [];
    const bypassable: Array<{ key: string; stats: ProfileUsageStats }> = [];
    const cooling: Array<{ key: string; stats: ProfileUsageStats }> = [];

    for (const kp of allKeys) {
      const stats = this.getStats(providerId, kp.key);

      // Check if in cooldown
      if (stats.cooldownUntil > now) {
        // Check model-scoped bypass
        if (
          model &&
          stats.cooldownReason === "rate_limit" &&
          stats.cooldownModel &&
          stats.cooldownModel !== model
        ) {
          bypassable.push({ key: kp.key, stats });
        } else {
          cooling.push({ key: kp.key, stats });
        }
      } else {
        // Clear expired cooldown stats
        if (stats.cooldownUntil > 0 && stats.cooldownUntil <= now) {
          stats.errorCount = 0;
          stats.cooldownUntil = 0;
          stats.cooldownReason = undefined;
          stats.cooldownModel = undefined;
        }
        available.push({ key: kp.key, stats });
      }
    }

    // Select from available (LRU order = least recently used first)
    if (available.length > 0) {
      available.sort((a, b) => a.stats.lastUsed - b.stats.lastUsed);
      const selected = available[0];
      selected.stats.lastUsed = now;
      this.lastGood.set(providerId, selected.key.slice(0, 8));
      return selected.key;
    }

    // Try model-bypassable keys
    if (bypassable.length > 0) {
      bypassable.sort((a, b) => a.stats.lastUsed - b.stats.lastUsed);
      const selected = bypassable[0];
      selected.stats.lastUsed = now;
      this.lastGood.set(providerId, selected.key.slice(0, 8));
      return selected.key;
    }

    // All in cooldown — use the one with soonest expiry
    if (cooling.length > 0) {
      cooling.sort((a, b) => a.stats.cooldownUntil - b.stats.cooldownUntil);
      const selected = cooling[0];
      console.warn(
        `[AuthProfiles] All keys for ${providerId} in cooldown. ` +
        `Using key ending ...${selected.key.slice(-4)} (expires in ${Math.round((selected.stats.cooldownUntil - now) / 1000)}s)`
      );
      return selected.key;
    }

    // Fallback to primary
    return primaryApiKey;
  }

  /**
   * Record a successful API call for a key.
   */
  recordSuccess(providerId: string, apiKey: string): void {
    const stats = this.getStats(providerId, apiKey);
    stats.errorCount = 0;
    stats.cooldownUntil = 0;
    stats.cooldownReason = undefined;
    stats.cooldownModel = undefined;
    this.lastGood.set(providerId, apiKey.slice(0, 8));
  }

  /**
   * Record a failed API call for a key.
   * Applies appropriate cooldown based on the failure reason.
   *
   * @param providerId - Provider identifier
   * @param apiKey - The API key that failed
   * @param reason - Classification of the failure
   * @param model - Optional model being used (for model-scoped cooldown)
   * @param statusCode - HTTP status code (if available)
   */
  recordFailure(
    providerId: string,
    apiKey: string,
    reason: CooldownReason,
    model?: string,
    statusCode?: number,
  ): void {
    const stats = this.getStats(providerId, apiKey);
    stats.errorCount++;
    stats.lastFailureAt = Date.now();

    let cooldownMs: number;
    switch (reason) {
      case "rate_limit":
        cooldownMs = calculateTransientCooldownMs(stats.errorCount);
        stats.cooldownModel = model;
        break;
      case "billing":
        cooldownMs = calculatePermanentCooldownMs(
          stats.errorCount,
          5 * 60_000,  // 5 min base
          24 * 60 * 60_000,  // 24 hours max
        );
        break;
      case "auth_permanent":
        cooldownMs = calculatePermanentCooldownMs(
          stats.errorCount,
          10 * 60_000,  // 10 min base
          60 * 60_000,  // 60 min max
        );
        break;
      case "transient":
      default:
        cooldownMs = calculateTransientCooldownMs(stats.errorCount);
        break;
      case "aborted":
        // User-initiated cancellation: do not penalize the API key.
        // The key didn't fail — the caller cancelled. Roll back the
        // errorCount bump so subsequent requests aren't penalized either.
        cooldownMs = 0;
        stats.errorCount = Math.max(0, stats.errorCount - 1);
        break;
    }

    stats.cooldownUntil = Date.now() + cooldownMs;
    stats.cooldownReason = reason;

    console.warn(
      `[AuthProfiles] Key ...${apiKey.slice(-4)} for ${providerId} ` +
      `failed (${reason}, status=${statusCode ?? "N/A"}). ` +
      `Cooldown ${Math.round(cooldownMs / 1000)}s (error #${stats.errorCount})`
    );
  }

  /**
   * Classify an HTTP error into a CooldownReason.
   */
  classifyError(error: unknown): CooldownReason {
    if (error && typeof error === "object") {
      const status = (error as { status?: number }).status
        ?? (error as { statusCode?: number }).statusCode;

      if (status === 429) return "rate_limit";
      if (status === 402) return "billing";
      if (status === 401 || status === 403) return "auth_permanent";
      if (status && status >= 500) return "transient";
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      const name = (error as { name?: string }).name?.toLowerCase() ?? "";
      // User-initiated cancellation via AbortController — distinguish from
      // server-side timeouts. AbortError / DOMException names vary by runtime.
      if (
        name === "aborterror"
        || msg.includes("aborted")
        || msg.includes("the user aborted a request")
        || msg.includes("the operation was aborted")
      ) {
        return "aborted";
      }
      if (msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limit";
      if (msg.includes("billing") || msg.includes("quota") || msg.includes("insufficient")) return "billing";
      if (msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("invalid api key")) return "auth_permanent";
      if (msg.includes("timeout") || msg.includes("econnrefused") || msg.includes("network")) return "transient";
    }
    return "transient";
  }

  /**
   * Get current stats summary for debugging/monitoring.
   */
  getStatsSummary(): Array<{
    providerId: string;
    keyPrefix: string;
    cooldownRemaining: number;
    reason?: string;
    errorCount: number;
  }> {
    const now = Date.now();
    const result: Array<{
      providerId: string;
      keyPrefix: string;
      cooldownRemaining: number;
      reason?: string;
      errorCount: number;
    }> = [];

    for (const [key, stats] of this.stats) {
      const [providerId, keyPrefix] = key.split(":");
      result.push({
        providerId,
        keyPrefix,
        cooldownRemaining: Math.max(0, stats.cooldownUntil - now),
        reason: stats.cooldownReason,
        errorCount: stats.errorCount,
      });
    }

    return result;
  }
}

/** Singleton instance */
let instance: AuthProfileManager | null = null;

export function getAuthProfileManager(): AuthProfileManager {
  if (!instance) {
    instance = new AuthProfileManager();
  }
  return instance;
}

// ---------------------------------------------------------------------------
// User-friendly LLM error helper
// ---------------------------------------------------------------------------

export interface FriendlyLLMError {
  category: CooldownReason;
  userMessage: string;
  isRetryable: boolean;
}

/**
 * Classify an LLM/API error into a user-friendly message.
 *
 * Used by agent-runner's terminal-error path (after retries are exhausted)
 * to give the user actionable guidance instead of raw HTTP error text.
 * The returned userMessage is Chinese to match the rest of the user-facing
 * agent output.
 */
export function friendlyLLMError(error: unknown): FriendlyLLMError {
  const category = getAuthProfileManager().classifyError(error);
  const isRetryable = category === "transient" || category === "rate_limit";

  const messages: Record<CooldownReason, string> = {
    rate_limit: "请求过于频繁（rate limit），请稍候重试",
    billing: "Provider 账户余额不足或配额耗尽，请到 provider 控制台检查",
    auth_permanent: "API key 无效或已过期，请在设置中检查模型配置",
    transient: "Provider 网络或服务暂时不可用（5xx / timeout / connection）",
    aborted: "请求已被取消（用户主动中止或父任务取消）",
  };

  return { category, userMessage: messages[category], isRetryable };
}
