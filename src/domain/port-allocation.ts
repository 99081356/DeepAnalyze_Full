// deepanalyze-hub/src/domain/port-allocation.ts
import type { Pool } from "pg";

/**
 * 在指定 host_server 上找最小可用端口段 base。
 *
 * 算法：generate_series 生成所有候选 base，过滤掉已被活跃 worker 占用的。
 * 活跃定义：status NOT IN ('deactivated', 'decommissioned')（terminal/released 状态）
 *
 * @returns base_port（如 21000、21010），或 null 表示端口段耗尽
 */
export async function allocatePortBlock(
  pool: () => Pool,
  hostId: string,
): Promise<number | null> {
  const { rows } = await pool().query<{ base_port: number | null }>(`
    WITH candidates AS (
      SELECT hs.port_range_start + (n - 1) * hs.port_block_size AS base_port
      FROM host_servers hs
      CROSS JOIN generate_series(
        1,
        GREATEST((hs.port_range_end - hs.port_range_start + 1) / hs.port_block_size, 0)
      ) AS n
      WHERE hs.id = $1
    )
    SELECT MIN(c.base_port) AS base_port
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1 FROM workers w
      WHERE w.host_id = $1
        AND w.host_port = c.base_port
        AND w.status NOT IN ('deactivated', 'decommissioned')
    )
  `, [hostId]);
  return rows[0]?.base_port ?? null;
}

export interface PortUsage {
  base_port: number;
  worker_id: string | null;
  status: string | null;
}

/**
 * 列出 host_server 上所有端口段及其占用情况（供 GET /:id/port-usage 端点用）。
 * 已 deactivated/decommissioned 的 worker 仍展示（说明端口段已释放）。
 */
export async function getPortUsage(
  pool: () => Pool,
  hostId: string,
): Promise<PortUsage[]> {
  const { rows } = await pool().query<PortUsage>(`
    WITH candidates AS (
      SELECT hs.port_range_start + (n - 1) * hs.port_block_size AS base_port
      FROM host_servers hs
      CROSS JOIN generate_series(
        1,
        GREATEST((hs.port_range_end - hs.port_range_start + 1) / hs.port_block_size, 0)
      ) AS n
      WHERE hs.id = $1
    )
    SELECT c.base_port, w.id AS worker_id, w.status
    FROM candidates c
    LEFT JOIN workers w ON w.host_id = $1 AND w.host_port = c.base_port
    ORDER BY c.base_port
  `, [hostId]);
  return rows;
}
