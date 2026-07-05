/**
 * Migration 040: workers 表 status CHECK 约束扩展
 *
 * 本地 Docker 部署模式（src/domain/local-deployment.ts + routes/users.ts 的
 * deploy-worker API）需要以下新状态：
 *   - 'deploying'     — 容器栈创建中（PG + DA 启动中）
 *   - 'error'         — 部署失败（容器创建/启动异常）
 *   - 'decommissioned' — 用户 Worker 已删除（容器栈已清理）
 *
 * 现有约束（migration 021）只允许：
 *   'pending', 'approved', 'rejected', 'revoked',
 *   'online', 'offline', 'draining', 'deactivated'
 *
 * 本 migration 在保留以上状态的基础上追加三个新状态。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check;
    ALTER TABLE workers
      ADD CONSTRAINT workers_status_check
        CHECK (status IN (
          'pending', 'approved', 'rejected', 'revoked',
          'online', 'offline', 'draining', 'deactivated',
          'deploying', 'error', 'decommissioned'
        ));
  `);
}

export async function down(query: QueryFn): Promise<void> {
  // 回滚到 migration 021 的约束（移除 deploying/error/decommissioned）
  await query(`
    ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check;
    ALTER TABLE workers
      ADD CONSTRAINT workers_status_check
        CHECK (status IN (
          'pending', 'approved', 'rejected', 'revoked',
          'online', 'offline', 'draining', 'deactivated'
        ));
  `);
}
