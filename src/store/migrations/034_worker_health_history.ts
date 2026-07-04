/**
 * Migration 034: worker_health_history 审计表
 *
 * T18: 心跳历史快照表 — 每次 worker 心跳都会插入一行，记录当时模块健康状态。
 * 配合 workers 表已有的 4 列（last_heartbeat_at / last_heartbeat_ok /
 * da_version / uptime_seconds，来自 migration 029）使用。
 *
 * 设计原则：
 * - 审计表只 INSERT + DELETE-by-worker，不 UPDATE（高频写入场景简化）
 * - workers 表的 4 列是"当前态"（latest），worker_health_history 是"历史态"（log）
 * - ON DELETE CASCADE：worker 被删除时自动清理历史行
 *
 * 向后兼容：CREATE TABLE IF NOT EXISTS；不修改任何现有表结构。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS worker_health_history (
      id              BIGSERIAL PRIMARY KEY,
      worker_id       TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      status          TEXT NOT NULL,
      module_health   JSONB NOT NULL,
      resource_usage  JSONB,
      da_version      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_whh_worker_time
      ON worker_health_history(worker_id, recorded_at DESC);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP INDEX IF EXISTS idx_whh_worker_time;`);
  await query(`DROP TABLE IF EXISTS worker_health_history;`);
}
