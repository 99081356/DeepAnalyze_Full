import type { Pool } from "pg";

/**
 * RecommendedConfig — 模板内容 shape。
 *
 * Stored as JSONB; DA's `sync-from-hub.ts` consumes the merged result by
 * matching these top-level keys against its `SYNC_KEYS` (providers /
 * agentSettings / doclingConfig / enhancedModels / hooks) plus `moduleStates`.
 *
 * IMPORTANT: the top-level key names must stay aligned with the Worker's
 * `SYNC_KEYS` (see DeepAnalyze/src/services/hub/sync-from-hub.ts) — the
 * previous shape used model-role names (main/thinking/...) which the Worker
 * never recognized, silently making every non-empty template a no-op.
 *
 * Top-level fields are all optional at the storage layer (a template may
 * override just one key).
 */
export interface RecommendedConfig {
  providers?: {
    providers: unknown[];
    defaults: Record<string, string>;
  };
  agentSettings?: Record<string, unknown>;
  doclingConfig?: Record<string, unknown>;
  enhancedModels?: unknown[];
  hooks?: unknown[];
  moduleStates?: Record<string, ModuleStateTemplate>;
  fieldLocks?: { lockedPaths: string[] };
}

/**
 * ModuleStateTemplate — per-module state authored by a Hub admin.
 * The Hub stores arbitrary JSON; this is the shape the Worker coerces into.
 * `endpoint` matches the admin perspective; the Worker maps it to
 * `remoteEndpoint` when upserting (sync-from-hub.ts).
 */
export interface ModuleStateTemplate {
  status?: "not_installed" | "installing" | "installed" | "running" | "error";
  mode?: "local" | "remote" | "disabled";
  endpoint?: string;
}

/**
 * deepMerge: 全局→组织两层模板合并
 * Rules (design doc §5.4):
 * - 对象递归合并
 * - 数组直接替换（不拼接）
 * - null 表示"删除该字段"
 * - fieldLocks.lockedPaths 取并集（全局锁定不能被组织解锁）
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  // FIXME: deepMerge's signature requires T extends Record<string, unknown>,
  // but this branch handles the case where base is somehow an array at runtime
  // (T13 latent bug — callers shouldn't pass arrays, but defensive copy kept
  // to preserve existing behavior). The cast is necessary because an array
  // cannot be cleanly typed as Record<string, unknown>; fixing requires
  // narrowing deepMerge's input type or adding array overload, which is out
  // of scope for T3 cleanup. Tracked for follow-up.
  const result: Record<string, unknown> = Array.isArray(base)
    ? [...(base as unknown[])] as unknown as Record<string, unknown>
    : { ...base };

  for (const [k, v] of Object.entries(override)) {
    if (v === null) {
      delete result[k];
      continue;
    }
    // Special case: fieldLocks.lockedPaths union (must run BEFORE generic
    // object-recursion, because fieldLocks is an object and would otherwise
    // be handled by the recursion branch — lockedPaths is an array, which
    // the recursion branch would replace rather than union).
    if (
      k === "fieldLocks" &&
      typeof v === "object" && v !== null && !Array.isArray(v) &&
      typeof result[k] === "object" && result[k] !== null && !Array.isArray(result[k])
    ) {
      const baseFieldLocks = result[k] as { lockedPaths?: unknown };
      const overrideFieldLocks = v as { lockedPaths?: unknown };
      const baseLocks: string[] = Array.isArray(baseFieldLocks.lockedPaths)
        ? baseFieldLocks.lockedPaths
        : [];
      const overrideLocks: string[] = Array.isArray(overrideFieldLocks.lockedPaths)
        ? overrideFieldLocks.lockedPaths
        : [];
      const union = Array.from(new Set([...baseLocks, ...overrideLocks]));
      result[k] = { ...(baseFieldLocks as object), ...(overrideFieldLocks as object), lockedPaths: union };
      continue;
    }
    if (
      typeof v === "object" && !Array.isArray(v) &&
      typeof result[k] === "object" && result[k] !== null && !Array.isArray(result[k])
    ) {
      result[k] = deepMerge(result[k] as Record<string, unknown>, v as Record<string, unknown>);
      continue;
    }
    // Arrays and primitives: direct replace
    result[k] = v;
  }
  return result as T;
}

export interface UpsertGlobalInput {
  content: RecommendedConfig;
  updatedBy: string;
}

export async function upsertGlobalTemplate(
  pool: () => Pool,
  input: UpsertGlobalInput,
): Promise<void> {
  const id = "tmpl_global";
  // Wrap upsert + version-select + history-insert in a single transaction so
  // the audit-trail row is written iff the upsert commits. Without this, a
  // crash between the upsert and the history INSERT would leave a gap in
  // config_template_history (defeating the table's purpose).
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO config_templates (id, org_id, scope, content, version, updated_by, updated_at)
       VALUES ($1, NULL, 'global', $2::jsonb, 1, $3, now())
       ON CONFLICT (id) DO UPDATE
         SET content = $2::jsonb,
             version = config_templates.version + 1,
             updated_by = $3,
             updated_at = now()`,
      [id, JSON.stringify(input.content), input.updatedBy],
    );
    // Read version after upsert to capture the post-increment value (same
    // connection, so this sees the uncommitted write above).
    const { rows } = await client.query(
      `SELECT version FROM config_templates WHERE id = $1`,
      [id],
    );
    await client.query(
      `INSERT INTO config_template_history (template_id, org_id, scope, content, version, updated_by, updated_at)
       VALUES ($1, NULL, 'global', $2::jsonb, $3, $4, now())`,
      [id, JSON.stringify(input.content), rows[0].version, input.updatedBy],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface UpsertOrgInput {
  orgId: string;
  content: RecommendedConfig;
  updatedBy: string;
}

export async function upsertOrgTemplate(
  pool: () => Pool,
  input: UpsertOrgInput,
): Promise<void> {
  const id = `tmpl_org_${input.orgId}`;
  // Same transactional guarantee as upsertGlobalTemplate: the upsert, version
  // select, and history insert must be atomic to preserve audit-trail
  // completeness (history.version must match the row's current version).
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO config_templates (id, org_id, scope, content, version, updated_by, updated_at)
       VALUES ($1, $2, 'org', $3::jsonb, 1, $4, now())
       ON CONFLICT (id) DO UPDATE
         SET content = $3::jsonb,
             version = config_templates.version + 1,
             updated_by = $4,
             updated_at = now()`,
      [id, input.orgId, JSON.stringify(input.content), input.updatedBy],
    );
    const { rows } = await client.query(
      `SELECT version FROM config_templates WHERE id = $1`,
      [id],
    );
    await client.query(
      `INSERT INTO config_template_history (template_id, org_id, scope, content, version, updated_by, updated_at)
       VALUES ($1, $2, 'org', $3::jsonb, $4, $5, now())`,
      [id, input.orgId, JSON.stringify(input.content), rows[0].version, input.updatedBy],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface GetMergedInput {
  workerId: string | null;
  orgId?: string | null;
}

export async function getMergedTemplate(
  pool: () => Pool,
  ctx: GetMergedInput,
): Promise<RecommendedConfig> {
  // Resolve org_id from workerId if not provided
  let orgId = ctx.orgId ?? null;
  if (!orgId && ctx.workerId) {
    const { rows: wRows } = await pool().query(
      // CORRECTION 1: column is organization_id, NOT org_id
      `SELECT organization_id FROM users WHERE id = (
         SELECT assigned_user_id FROM workers WHERE id = $1
       )`,
      [ctx.workerId],
    );
    orgId = wRows[0]?.organization_id ?? null;
  }

  const [globalRes, orgRes] = await Promise.all([
    pool().query(
      `SELECT content FROM config_templates WHERE scope = 'global' ORDER BY version DESC LIMIT 1`,
    ),
    orgId
      ? pool().query(
          `SELECT content FROM config_templates WHERE scope = 'org' AND org_id = $1 ORDER BY version DESC LIMIT 1`,
          [orgId],
        )
      : Promise.resolve({ rows: [] as Array<{ content: unknown }> }),
  ]);

  const globalContent = (globalRes.rows[0]?.content ?? {}) as Record<string, unknown>;
  const orgContent = (orgRes.rows[0]?.content ?? {}) as Record<string, unknown>;
  return deepMerge(globalContent, orgContent) as RecommendedConfig;
}

export interface HistoryEntry {
  version: number;
  content: RecommendedConfig;
  updated_at: Date;
  updated_by: string;
}

export async function getHistory(
  pool: () => Pool,
  filter: { scope: "global" | "org"; orgId?: string | null },
  limit = 20,
): Promise<HistoryEntry[]> {
  if (filter.scope === "global") {
    const { rows } = await pool().query(
      `SELECT version, content, updated_at, updated_by
       FROM config_template_history
       WHERE scope = 'global'
       ORDER BY version DESC
       LIMIT $1`,
      [limit],
    );
    return rows as HistoryEntry[];
  }
  if (!filter.orgId) {
    return [];
  }
  const { rows } = await pool().query(
    `SELECT version, content, updated_at, updated_by
     FROM config_template_history
     WHERE scope = 'org' AND org_id = $1
     ORDER BY version DESC
     LIMIT $2`,
    [filter.orgId, limit],
  );
  return rows as HistoryEntry[];
}
