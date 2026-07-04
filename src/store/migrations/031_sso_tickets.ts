/**
 * Migration 031: sso_tickets 表
 *
 * Hub→DA SSO 一次性票据：Hub 签发 → 浏览器跳转 DA → DA 用 worker_token 兑换 Hub access_token。
 * - 10s TTL（防重放窗口）
 * - 单次使用（consumed_at 设置后不可重置）
 * - da_worker_id 锁定兑换方（只允许持有正确 worker_token 的 DA 容器兑换）
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS sso_tickets (
      id              TEXT PRIMARY KEY,
      ticket          TEXT NOT NULL UNIQUE,
      user_id         TEXT NOT NULL REFERENCES users(id),
      da_worker_id    TEXT NOT NULL REFERENCES workers(id),
      expires_at      TIMESTAMPTZ NOT NULL,
      consumed_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      client_ip       INET,
      user_agent      TEXT
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_sso_tickets_active
    ON sso_tickets(ticket) WHERE consumed_at IS NULL
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_sso_tickets_expire
    ON sso_tickets(expires_at)
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS sso_tickets`);
}
