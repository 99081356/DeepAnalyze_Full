// deepanalyze-hub/src/store/migrations/029_workers_host_cols.ts
// T04: workers 表加列 + status CHECK 扩展
//
// 新增 10 列：
//   host 关联（6 列）：host_id / host_port / port_block_size / gpu_device /
//                     decommissioned_at / labels
//   心跳（4 列）   ：last_heartbeat_at / last_heartbeat_ok / da_version /
//                     uptime_seconds
//
// status CHECK 扩展：加入 'decommissioned'（端口段释放语义）
//
// 向后兼容：所有新列 NULLABLE 或带默认值；不删除/修改现有列。
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // ── host_server 关联（企业多租户核心）─────────────────────────────
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS host_id TEXT REFERENCES host_servers(id);`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS host_port INT;`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS port_block_size INT NOT NULL DEFAULT 10;`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS gpu_device INT;`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS decommissioned_at TIMESTAMPTZ;`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS labels JSONB DEFAULT '{}'::jsonb;`);

  // ── 心跳字段（T18 用，提前加列避免后续再改）─────────────────────
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_heartbeat_ok BOOLEAN;`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS da_version TEXT;`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS uptime_seconds INT;`);

  // ── 索引：按 host 查 worker（部分索引，仅活跃 host 关联）─────────
  await query(`CREATE INDEX IF NOT EXISTS idx_workers_host ON workers(host_id) WHERE host_id IS NOT NULL;`);

  // ── status CHECK 扩展：加入 'decommissioned'（端口段释放语义）────
  // 注意：CHECK constraint 修改不属于"修改列类型"的硬约束禁止项；
  // 这里只是允许更多值，向后兼容
  await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check;`);
  await query(`
    ALTER TABLE workers ADD CONSTRAINT workers_status_check
    CHECK (status IN (
      'pending', 'approved', 'rejected', 'revoked',
      'online', 'offline', 'draining', 'deactivated',
      'decommissioned'
    ))
  `);

  // 数据迁移说明：把现有 workers.ssh_target_host 关联到 host_servers（按 hostname 分组）
  // 不会自动迁移 — 部署文档要求管理员手动建 host_servers 后批量 UPDATE
  // 例：UPDATE workers SET host_id = (SELECT id FROM host_servers WHERE hostname = '...')
  //     WHERE ssh_target_host = '...';
}

export async function down(query: QueryFn): Promise<void> {
  // 不写 down（按设计原则：跨版本回滚靠备份）
  // 加列和加约束都是向后兼容的扩展，down 没必要
}
