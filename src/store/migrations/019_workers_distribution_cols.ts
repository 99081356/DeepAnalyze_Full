/**
 * Migration 019: workers 表增加分发与部署元数据列
 *
 * - assigned_user_id: 该 DA 容器所属员工的 user_id（章节 4.5）
 * - da_url: DA 实例的访问 URL（如 https://da-alice.corp.com）
 * - ssh_target_host/port/user: 远程拉起用 SSH 凭证目标
 * - ssh_key_encrypted: AES 加密后的 SSH 私钥（明文永不存盘）
 * - current_image_tag: 当前运行的镜像版本（如 v0.9.0）
 * - last_health_status: 最近一次心跳摘要 JSON
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE workers
      ADD COLUMN IF NOT EXISTS assigned_user_id TEXT,
      ADD COLUMN IF NOT EXISTS da_url TEXT,
      ADD COLUMN IF NOT EXISTS ssh_target_host TEXT,
      ADD COLUMN IF NOT EXISTS ssh_target_port INT DEFAULT 22,
      ADD COLUMN IF NOT EXISTS ssh_user TEXT,
      ADD COLUMN IF NOT EXISTS ssh_key_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS current_image_tag TEXT,
      ADD COLUMN IF NOT EXISTS last_health_status JSONB;
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE workers
      DROP COLUMN IF EXISTS last_health_status,
      DROP COLUMN IF EXISTS current_image_tag,
      DROP COLUMN IF EXISTS ssh_key_encrypted,
      DROP COLUMN IF EXISTS ssh_user,
      DROP COLUMN IF EXISTS ssh_target_port,
      DROP COLUMN IF EXISTS ssh_target_host,
      DROP COLUMN IF EXISTS da_url,
      DROP COLUMN IF EXISTS assigned_user_id;
  `);
}
