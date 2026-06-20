/**
 * Migration 009: workers 表 — 添加 current_task 字段（v2 协议）
 *
 * v2 heartbeat 携带 current_task（"idle" | "busy" | 任务摘要），
 * 用于 Hub 后台实时展示 Worker 当前工作状态。
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS current_task TEXT`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS current_task`);
}
