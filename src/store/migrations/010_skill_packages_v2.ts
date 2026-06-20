/**
 * Migration 010: Skill 企业级管理表（Phase 2）
 *
 * - skill_packages: 企业级管理单元（org/system/user scope）
 * - skill_versions: 不可变版本（Phase 2 仅 draft/published，状态机在 Phase 3）
 * - skill_subscriptions: 订阅关系（user/worker/org 三种订阅者）
 *
 * 注意：Phase 2 不实现完整审核工作流，所有 created 版本默认 published。
 * Phase 3 会扩展 status 枚举和审批逻辑。
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // ─── skill_packages ─────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      description TEXT,
      org_id TEXT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      author_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      scope TEXT NOT NULL DEFAULT 'user',
      category TEXT NOT NULL DEFAULT 'custom',
      tags JSONB NOT NULL DEFAULT '[]',
      icon TEXT,
      stats JSONB NOT NULL DEFAULT '{"downloads":0,"subscriptions":0,"rating_avg":0}',
      trust_level TEXT NOT NULL DEFAULT 'community',
      active_version_id TEXT NULL,
      is_kill_switched BOOL NOT NULL DEFAULT FALSE,
      kill_switch_reason TEXT,
      kill_switched_at TIMESTAMPTZ NULL,
      kill_switched_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(name, org_id, scope)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_pkg_org_scope ON skill_packages(org_id, scope)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_pkg_slug ON skill_packages(slug)`);

  // ─── skill_versions ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_versions (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      content TEXT,
      when_to_use TEXT,
      paths JSONB NOT NULL DEFAULT '[]',
      allowed_tools JSONB NOT NULL DEFAULT '[]',
      data_classification TEXT NOT NULL DEFAULT 'public',
      hooks JSONB NOT NULL DEFAULT '{}',
      test_cases JSONB NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      change_summary TEXT,
      created_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ NULL,
      UNIQUE(package_id, version)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_version_pkg_status ON skill_versions(package_id, status)`);

  // ─── skill_subscriptions ───────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS skill_subscriptions (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
      subscriber_type TEXT NOT NULL,
      subscriber_id TEXT NOT NULL,
      is_forced BOOL NOT NULL DEFAULT FALSE,
      pinned BOOL NOT NULL DEFAULT FALSE,
      auto_update BOOL NOT NULL DEFAULT TRUE,
      source TEXT NOT NULL DEFAULT 'market',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(package_id, subscriber_type, subscriber_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_sub_subscriber ON skill_subscriptions(subscriber_type, subscriber_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sub_package ON skill_subscriptions(package_id)`);

  // ─── worker_skill_cache: 跟踪 worker 已确认的 sync 指令 ──────────
  await query(`
    CREATE TABLE IF NOT EXISTS worker_skill_cache (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL,
      version_id TEXT NULL,
      version TEXT NULL,
      content_hash TEXT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(worker_id, package_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_wsc_worker ON worker_skill_cache(worker_id)`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS worker_skill_cache CASCADE`);
  await query(`DROP TABLE IF EXISTS skill_subscriptions CASCADE`);
  await query(`DROP TABLE IF EXISTS skill_versions CASCADE`);
  await query(`DROP TABLE IF EXISTS skill_packages CASCADE`);
}
