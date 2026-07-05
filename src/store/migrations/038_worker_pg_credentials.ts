/**
 * Migration 038: workers 表加 PG 凭据列
 *
 * Spec 2.1 重构 worker 部署模型为 B 模式（每 worker 一对 da-app + da-pg 容器）。
 * Hub 现在显式管理每个 worker 的 PG 凭据：
 *   - pg_database:  worker 专属 PG 容器内的 database 名（默认 'deepanalyze'）
 *   - pg_username:  worker 专属 PG 用户名（默认 'da'）
 *   - pg_password_encrypted: AES-256-GCM 加密的密码（用 src/core/crypto.ts 的 encryptString）
 *
 * 现有 worker 这三列为 NULL（pg_password_encrypted）；迁移脚本
 * (scripts/migrate-workers-to-b.ts) 负责回填。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(
    `ALTER TABLE workers
       ADD COLUMN IF NOT EXISTS pg_database TEXT NOT NULL DEFAULT 'deepanalyze',
       ADD COLUMN IF NOT EXISTS pg_username TEXT NOT NULL DEFAULT 'da',
       ADD COLUMN IF NOT EXISTS pg_password_encrypted TEXT`,
  );
}

export async function down(query: QueryFn): Promise<void> {
  // 加列是向后兼容的扩展，down 不写（按设计原则：跨版本回滚靠备份）
}
