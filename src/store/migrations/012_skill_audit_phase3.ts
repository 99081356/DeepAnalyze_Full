/**
 * Migration 012: Phase 3 — 完整审核工作流
 *
 * - skill_approvals: 版本发布审批
 * - skill_audit_logs: 不可篡改审计日志（INSERT + SELECT only）
 * - skill_sync_queue: 持久化的强制同步指令（force_update / kill_switch）
 * - 扩展 skill_versions.status 枚举（draft/internal_test/canary/published/deprecated/rolled_back）
 * - 添加 skill_packages.rollout_strategy 详细字段
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // ─── skill_approvals ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_approvals (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ NULL,
      review_notes TEXT,
      publish_gate_result JSONB NULL,
      expires_at TIMESTAMPTZ NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_approval_version ON skill_approvals(version_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_approval_status ON skill_approvals(status, requested_at DESC)`);

  // ─── skill_audit_logs (immutable) ──────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      version_id TEXT NULL REFERENCES skill_versions(id) ON DELETE SET NULL,
      package_id TEXT NULL REFERENCES skill_packages(id) ON DELETE SET NULL,
      actor_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      from_status TEXT NULL,
      to_status TEXT NULL,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_pkg ON skill_audit_logs(package_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_version ON skill_audit_logs(version_id, created_at DESC)`);
  // Note: For full immutability, we should REVOKE UPDATE, DELETE from app role.
  // In development we leave this as a soft guarantee (enforced by repository API).

  // ─── skill_sync_queue (persistent forced instructions) ─────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_sync_queue (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'all',
      target_worker_ids JSONB NULL,
      target_org_ids JSONB NULL,
      reason TEXT,
      priority INT NOT NULL DEFAULT 50,
      deadline TIMESTAMPTZ NULL,
      created_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NULL,
      is_active BOOL NOT NULL DEFAULT TRUE
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_queue_active ON skill_sync_queue(is_active, priority DESC, created_at)`);

  // ─── skill_versions.status 枚举扩展 ────────────────────────────────
  // Phase 2 默认 'draft'，Phase 3 增加 internal_test/canary/published/deprecated/rolled_back
  // 我们用 TEXT 类型 + CHECK 约束（无需 ALTER TYPE）
  await query(`ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS skill_versions_status_check`);
  await query(`
    ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_status_check
    CHECK (status IN ('draft', 'internal_test', 'canary', 'published', 'deprecated', 'rolled_back'))
  `);

  // 添加 canary_rollout 字段到 skill_packages
  await query(`ALTER TABLE skill_packages ADD COLUMN IF NOT EXISTS canary_rollout JSONB NOT NULL DEFAULT '{}'`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE skill_packages DROP COLUMN IF EXISTS canary_rollout`);
  await query(`ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS skill_versions_status_check`);
  await query(`ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_status_check
    CHECK (status IN ('draft', 'published'))`);
  await query(`DROP TABLE IF EXISTS skill_sync_queue CASCADE`);
  await query(`DROP TABLE IF EXISTS skill_audit_logs CASCADE`);
  await query(`DROP TABLE IF EXISTS skill_approvals CASCADE`);
}
