// =============================================================================
// DeepAnalyze - Provider Endpoint Migration (GLM /paas/v4 → /api/anthropic)
// =============================================================================
// One-shot, idempotent migration that rewrites legacy GLM provider configs
// stored in the DB from the OpenAI-protocol endpoint (/api/paas/v4) to the
// Anthropic-protocol endpoint (/api/anthropic).
//
// Background:
//   DeepAnalyze instantiates GLM via AnthropicCompatibleProvider, which sends
//   Anthropic Messages-format request bodies. /api/paas/v4 is Zhipu's OpenAI
//   endpoint — it tolerates Anthropic-format bodies but:
//     • returns incomplete usage (input_tokens always 0 → hidden token cost)
//     • ignores cache_control markers → prefix cache optimization ineffective
//   /api/anthropic is Zhipu's official Anthropic-compatible endpoint that
//   returns the full Anthropic usage schema and honors cache_control.
//
// Idempotency:
//   Only rewrites providers whose endpoint is EXACTLY the known legacy value
//   AND whose type is "anthropic-compatible". User-customized endpoints are
//   never touched. After the first run, subsequent runs are no-ops.
// =============================================================================

import { getRepos } from "../store/repos/index.js";

const LEGACY_GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4";
const CORRECT_GLM_ENDPOINT = "https://open.bigmodel.cn/api/anthropic";

export interface ProviderEndpointMigrationResult {
  checked: number;
  migrated: number;
  details: Array<{ id: string; name: string; from: string; to: string }>;
}

/**
 * Migrate legacy GLM provider configs from /api/paas/v4 to /api/anthropic.
 * Safe to call on every startup — no-op once all matching providers are migrated.
 */
export async function migrateProviderEndpoints(): Promise<ProviderEndpointMigrationResult> {
  const repos = await getRepos();
  const settings = await repos.settings.getProviderSettings();

  const result: ProviderEndpointMigrationResult = {
    checked: 0,
    migrated: 0,
    details: [],
  };

  const providers = settings.providers ?? [];
  if (!Array.isArray(providers) || providers.length === 0) {
    return result;
  }

  let changed = false;
  for (const p of providers) {
    result.checked++;
    // Only migrate anthropic-compatible providers pointing at the exact legacy URL.
    // This protects:
    //   - OpenAI-compatible GLM configs (their /paas/v4 is correct)
    //   - User-customized endpoints (e.g. proxies, regional mirrors)
    //   - Other providers entirely
    if (
      p &&
      typeof p === "object" &&
      p.type === "anthropic-compatible" &&
      typeof p.endpoint === "string" &&
      p.endpoint === LEGACY_GLM_ENDPOINT
    ) {
      const from = p.endpoint;
      p.endpoint = CORRECT_GLM_ENDPOINT;
      result.migrated++;
      result.details.push({
        id: String(p.id ?? "<unknown>"),
        name: String(p.name ?? p.id ?? "<unknown>"),
        from,
        to: CORRECT_GLM_ENDPOINT,
      });
      changed = true;
    }
  }

  if (changed) {
    await repos.settings.saveProviderSettings(settings);
    for (const d of result.details) {
      console.log(
        `[ProviderMigration] ${d.id} (${d.name}): ${d.from} → ${d.to}`,
      );
    }
    console.log(
      `[ProviderMigration] Migrated ${result.migrated} provider(s) to /api/anthropic. ` +
        `Prompt caching and full usage reporting now available for GLM.`,
    );
  }

  return result;
}
