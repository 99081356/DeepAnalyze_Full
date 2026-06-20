/**
 * Skill usage logging — async usage reporting + statistics.
 *
 * Workers (and other executors) report skill invocations here.
 * Aggregations power admin dashboards and billing feeds.
 */

import { query } from "../store/pg.js";

export type UsageStatus = "success" | "failure" | "timeout" | "blocked";
export type ExecutorType = "main_agent" | "sub_agent" | "workflow" | "worker";

export interface UsageLogEntry {
  id: number;
  package_id: string;
  version_id: string | null;
  worker_id: string | null;
  user_id: string | null;
  executor_type: ExecutorType;
  status: UsageStatus;
  duration_ms: number | null;
  session_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

/**
 * Append a usage log entry. Called by worker after skill execution.
 */
export async function logUsage(params: {
  package_id: string;
  version_id?: string | null;
  worker_id?: string | null;
  user_id?: string | null;
  executor_type?: ExecutorType;
  status: UsageStatus;
  duration_ms?: number | null;
  session_id?: string | null;
  details?: Record<string, unknown>;
}): Promise<UsageLogEntry> {
  const { rows } = await query<UsageLogEntry>(
    `INSERT INTO skill_usage_logs
      (package_id, version_id, worker_id, user_id, executor_type, status,
       duration_ms, session_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      params.package_id,
      params.version_id ?? null,
      params.worker_id ?? null,
      params.user_id ?? null,
      params.executor_type ?? "main_agent",
      params.status,
      params.duration_ms ?? null,
      params.session_id ?? null,
      JSON.stringify(params.details ?? {}),
    ],
  );
  return rows[0];
}

export interface UsageStats {
  package_id: string;
  total: number;
  success: number;
  failure: number;
  timeout: number;
  blocked: number;
  success_rate: number;
  avg_duration_ms: number | null;
  unique_workers: number;
  unique_users: number;
  last_24h: number;
  last_7d: number;
}

/**
 * Aggregate usage stats for a package within an optional time window.
 */
export async function getStats(packageId: string): Promise<UsageStats> {
  const { rows } = await query<{
    total: number;
    success: number;
    failure: number;
    timeout: number;
    blocked: number;
    avg_duration_ms: number | null;
    unique_workers: number;
    unique_users: number;
    last_24h: number;
    last_7d: number;
  }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'success')::int AS success,
       COUNT(*) FILTER (WHERE status = 'failure')::int AS failure,
       COUNT(*) FILTER (WHERE status = 'timeout')::int AS timeout,
       COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
       AVG(duration_ms)::float AS avg_duration_ms,
       COUNT(DISTINCT worker_id)::int AS unique_workers,
       COUNT(DISTINCT user_id)::int AS unique_users,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last_7d
     FROM skill_usage_logs
     WHERE package_id = $1`,
    [packageId],
  );

  const r = rows[0];
  const total = r.total || 0;
  return {
    package_id: packageId,
    total,
    success: r.success,
    failure: r.failure,
    timeout: r.timeout,
    blocked: r.blocked,
    success_rate: total > 0 ? r.success / total : 0,
    avg_duration_ms: r.avg_duration_ms,
    unique_workers: r.unique_workers,
    unique_users: r.unique_users,
    last_24h: r.last_24h,
    last_7d: r.last_7d,
  };
}

/**
 * Top-N most-used packages globally (admin dashboard).
 */
export async function getTopPackages(
  limit = 20,
  windowHours = 24 * 7,
): Promise<Array<{
  package_id: string;
  package_name: string;
  calls: number;
  success_rate: number;
}>> {
  const { rows } = await query<{
    package_id: string;
    package_name: string;
    calls: number;
    success_rate: number;
  }>(
    `SELECT
       u.package_id,
       p.name AS package_name,
       COUNT(*)::int AS calls,
       CASE WHEN COUNT(*) > 0
         THEN COUNT(*) FILTER (WHERE u.status = 'success')::float / COUNT(*)
         ELSE 0 END AS success_rate
     FROM skill_usage_logs u
     JOIN skill_packages p ON p.id = u.package_id
     WHERE u.created_at > NOW() - ($1 || ' hours')::INTERVAL
     GROUP BY u.package_id, p.name
     ORDER BY calls DESC
     LIMIT $2`,
    [String(windowHours), limit],
  );
  return rows;
}

/**
 * List recent usage entries for a package.
 */
export async function listRecent(
  packageId: string,
  limit = 50,
): Promise<UsageLogEntry[]> {
  const { rows } = await query<UsageLogEntry>(
    `SELECT * FROM skill_usage_logs
     WHERE package_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [packageId, limit],
  );
  return rows;
}
