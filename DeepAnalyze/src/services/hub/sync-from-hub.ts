// sync-from-hub.ts — Lock-aware selective config sync from Hub to local DA.
//
// Consumes T13's `/api/v1/config-templates/by-worker/merged` endpoint via an
// injected `fetcher` (so tests don't need a real HubClient). Hub admin authors
// a merged template blob; this module decides what to apply locally based on
// lock semantics:
//   - locked field → force-apply (admin override)
//   - local empty (null / not set) → apply (fill empty)
//   - otherwise → skip (preserve local custom value)

import { query } from "../../store/pg.js";
import { getPool } from "../../store/pg.js";
import { getRepos } from "../../store/repos/index.js";
import { PgModuleStatesRepo } from "../../store/repos/module-states.js";
import { bumpConfigVersion } from "../../models/router.js";
import type { RecommendedConfig, ModuleStateTemplate } from "./types.js";

/** Top-level settings keys that sync tracks. */
const SYNC_KEYS = [
  "providers",
  "agentSettings",
  "doclingConfig",
  "enhancedModels",
  "hooks",
] as const;
type SyncKey = (typeof SYNC_KEYS)[number];

/** Map RecommendedConfig camelCase keys to settings table keys. */
const SETTINGS_KEY_MAP: Record<SyncKey, string> = {
  providers: "providers", // saveProviderSettings handles this specially
  agentSettings: "agent_settings",
  doclingConfig: "docling_config",
  enhancedModels: "enhanced_models",
  hooks: "agent_hooks",
};

/**
 * Decide whether to apply a hub-side field to local.
 * - locked or force-selected: always apply (override)
 * - local null/undefined: apply (fill empty)
 * - otherwise: skip (preserve local custom value)
 *
 * forceFields are the per-sync overrides the user selected in the confirm
 * dialog (transient — not persisted in the template's fieldLocks).
 */
export function shouldApplyField(
  fieldPath: string,
  localValue: unknown,
  hubValue: unknown,
  lockedPaths: string[],
  forceFields: string[] = [],
): boolean {
  if (lockedPaths.includes(fieldPath) || forceFields.includes(fieldPath)) return true;
  if (localValue == null) return true;
  return false;
}

export interface SyncResult {
  appliedFields: string[];
  skippedFields: string[];
}

/**
 * Fetch merged template from Hub and selectively apply to local settings.
 * Lock-aware: locked fields force-apply; non-locked only fill empties.
 *
 * @param fetcher - injected so tests don't need to mock HubClient.
 *                  T16 wraps it as `() => hubClient.fetchMergedTemplate()`.
 * @param opts.dryRun     - when true, compute applied/skipped but write nothing.
 *                         Used by the confirm dialog's pre-check.
 * @param opts.forceFields - per-sync overrides the user selected in the confirm
 *                         dialog (transient; not persisted in fieldLocks).
 */
export async function syncConfigFromHub(
  fetcher: () => Promise<RecommendedConfig | null>,
  opts?: { dryRun?: boolean; forceFields?: string[] },
): Promise<SyncResult> {
  const template = await fetcher();
  if (!template) {
    return { appliedFields: [], skippedFields: [] };
  }

  const dryRun = opts?.dryRun ?? false;
  const forceFields = opts?.forceFields ?? [];
  const lockedPaths = template.fieldLocks?.lockedPaths ?? [];
  const repos = await getRepos();
  const pool = await getPool();
  const moduleStatesRepo = new PgModuleStatesRepo(pool);
  const applied: string[] = [];
  const skipped: string[] = [];

  // ─── Settings JSON keys ───
  for (const key of SYNC_KEYS) {
    const hubValue = template[key];
    if (hubValue == null) continue; // template doesn't specify this key

    // Read local value (raw settings row, may be null)
    const localRaw = await repos.settings.get(SETTINGS_KEY_MAP[key]);
    const localValue = localRaw ? JSON.parse(localRaw) : null;

    if (shouldApplyField(key, localValue, hubValue, lockedPaths, forceFields)) {
      if (!dryRun) {
        if (key === "providers") {
          await repos.settings.saveProviderSettings(
            hubValue as RecommendedConfig["providers"],
          );
        } else {
          await repos.settings.set(SETTINGS_KEY_MAP[key], JSON.stringify(hubValue));
        }
      }
      applied.push(key);
    } else {
      skipped.push(key);
    }
  }

  // ─── Module states ───
  if (template.moduleStates) {
    for (const moduleId of Object.keys(template.moduleStates)) {
      const hubState: ModuleStateTemplate = template.moduleStates[moduleId];
      const fieldPath = `moduleStates.${moduleId}`;
      const local = await moduleStatesRepo.get(moduleId as any);

      const localIsEmpty = !local || local.status === "not_installed";
      // Locked paths (from template) OR user-selected force fields both trigger
      // an override. Use the same prefix-match as lockedPaths so locking a
      // parent ("moduleStates") or a specific module works identically.
      const overridePaths = [...lockedPaths, ...forceFields];
      const isOverridden = overridePaths.some(
        (p) => p === fieldPath || p.startsWith(`${fieldPath}.`),
      );

      if (isOverridden || localIsEmpty) {
        if (!dryRun) {
          await moduleStatesRepo.upsert({
            moduleId: moduleId as any,
            status: hubState.status,
            mode: hubState.mode,
            remoteEndpoint: hubState.endpoint ?? null,
          });
        }
        applied.push(fieldPath);
      } else {
        skipped.push(fieldPath);
      }
    }
  }

  // ─── Hot-reload trigger + sync timestamp (skip in dry-run) ───
  if (!dryRun) {
    if (applied.length > 0) {
      bumpConfigVersion();
    }
    await query(
      `UPDATE config_versions SET last_hub_sync_at = now(), updated_at = now() WHERE id = 'singleton'`,
    );
  }

  return { appliedFields: applied, skippedFields: skipped };
}

/**
 * Whether to trigger auto-sync on first build.
 * Only in hub auth mode and only if we've never synced.
 */
export async function shouldAutoSyncOnFirstBuild(): Promise<boolean> {
  if (process.env.DA_AUTH_MODE !== "hub") return false;
  const { rows } = await query(
    `SELECT last_hub_sync_at FROM config_versions WHERE id = 'singleton'`,
  );
  return rows[0]?.last_hub_sync_at == null;
}

/**
 * Trigger auto-sync on first hub-mode build.
 * Reads globalThis.__hubClient directly to avoid circular import with routes/hub.ts.
 * Returns silently if not in hub mode, already synced, or HubClient not initialized.
 */
export async function maybeAutoSyncOnStartup(): Promise<void> {
  if (process.env.DA_AUTH_MODE !== "hub") return;
  if (!(await shouldAutoSyncOnFirstBuild())) return;

  const hubClient = (
    globalThis as { __hubClient?: { fetchMergedTemplate(): Promise<RecommendedConfig | null> } }
  ).__hubClient;
  if (!hubClient) {
    console.error("[startup] auto-sync skipped: HubClient not initialized");
    return;
  }

  try {
    console.log("[startup] first hub build detected, auto-syncing config...");
    const result = await syncConfigFromHub(() => hubClient.fetchMergedTemplate());
    console.log(
      `[startup] auto-sync done: applied=${result.appliedFields.length}, skipped=${result.skippedFields.length}`,
    );
  } catch (e) {
    console.error("[startup] auto-sync failed:", e);
  }
}
