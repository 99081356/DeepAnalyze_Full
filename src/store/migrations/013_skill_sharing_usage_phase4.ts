/**
 * Migration 013: Phase 4 — 跨组织 SkillSharing + 使用日志
 *
 * - skill_sharings: 双边审批流程（pending/approved/rejected/revoked）
 * - skill_usage_logs: 异步使用日志（success/failure/timeout + duration_ms）
 * - 新增权限：skill:share, usage:read
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // ─── skill_sharings ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_sharings (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
      source_org_id TEXT NOT NULL,
      target_org_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      initiated_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      approved_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      restrictions JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ NULL,
      revoked_at TIMESTAMPTZ NULL,
      revoked_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      revoke_reason TEXT
    )
  `);
  // Partial unique — only blocks concurrent pending/approved, allows
  // history-preserving re-creation after rejection/revocation.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sharing_active_pair
    ON skill_sharings(package_id, source_org_id, target_org_id)
    WHERE status IN ('pending', 'approved')
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_sharing_source ON skill_sharings(source_org_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sharing_target ON skill_sharings(target_org_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sharing_pkg ON skill_sharings(package_id, status)`);
  await query(`
    ALTER TABLE skill_sharings DROP CONSTRAINT IF EXISTS skill_sharings_status_check
  `);
  await query(`
    ALTER TABLE skill_sharings ADD CONSTRAINT skill_sharings_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'revoked'))
  `);

  // ─── skill_usage_logs ─────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_usage_logs (
      id BIGSERIAL PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
      version_id TEXT NULL REFERENCES skill_versions(id) ON DELETE SET NULL,
      worker_id TEXT NULL REFERENCES workers(id) ON DELETE SET NULL,
      user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      executor_type TEXT NOT NULL DEFAULT 'main_agent',
      status TEXT NOT NULL DEFAULT 'success',
      duration_ms INT NULL,
      session_id TEXT NULL,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_usage_pkg ON skill_usage_logs(package_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_usage_worker ON skill_usage_logs(worker_id, created_at DESC)`);
  await query(`
    ALTER TABLE skill_usage_logs DROP CONSTRAINT IF EXISTS skill_usage_logs_status_check
  `);
  await query(`
    ALTER TABLE skill_usage_logs ADD CONSTRAINT skill_usage_logs_status_check
    CHECK (status IN ('success', 'failure', 'timeout', 'blocked'))
  `);

  // ─── 新权限：skill:share + usage:read ──────────────────────────────
  const newPerms: Array<[string, string, string, string, string]> = [
    ["perm_skill_share", "skill:share", "skill", "share", "system"],
    ["perm_usage_read", "usage:read", "usage", "read", "system"],
  ];
  for (const [id, code, resource, action, type] of newPerms) {
    await query(
      `INSERT INTO permissions (id, code, resource, action, type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [id, code, resource, action, type],
    );
  }

  // Grant to super_admin role
  for (const permId of ["perm_skill_share", "perm_usage_read"]) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ('role_super_admin', $1)
       ON CONFLICT DO NOTHING`,
      [permId],
    );
  }

  // Grant usage:read to org_admin (visibility into org skill usage)
  await query(
    `INSERT INTO role_permissions (role_id, permission_id)
     VALUES ('role_org_admin', 'perm_usage_read')
     ON CONFLICT DO NOTHING`,
  );

  // Grant skill:share to org_admin (initiate sharing on behalf of org)
  await query(
    `INSERT INTO role_permissions (role_id, permission_id)
     VALUES ('role_org_admin', 'perm_skill_share')
     ON CONFLICT DO NOTHING`,
  );
}

export async function down(query: QueryFn): Promise<void> {
  const permIds = ["perm_skill_share", "perm_usage_read"];
  for (const id of permIds) {
    await query(`DELETE FROM role_permissions WHERE permission_id = $1`, [id]);
  }
  await query(`DROP TABLE IF EXISTS skill_usage_logs CASCADE`);
  await query(`DROP TABLE IF EXISTS skill_sharings CASCADE`);
  await query(`DELETE FROM permissions WHERE id = ANY($1::text[])`, [permIds]);
}
