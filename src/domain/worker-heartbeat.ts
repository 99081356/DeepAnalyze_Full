/**
 * Worker heartbeat domain (T18).
 *
 * Records per-heartbeat audit rows + computes overview rollups.
 * Persistence layer for the existing POST /api/v1/workers/heartbeat handler.
 */
import type { Pool } from "pg";

// ─── Payload (camelCase, matches what DA's HubClient sends over the wire) ───

export interface HeartbeatPayload {
  workerId: string;
  status?: string;
  activeSessions?: number;
  activeTasks?: number;
  resourceUsage?: {
    cpuPercent?: number;
    memoryUsedGB?: number;
    memoryTotalGB?: number;
    diskUsedGB?: number;
    diskTotalGB?: number;
  };
  uptime?: number;
  daVersion?: string;
  moduleHealth?: Record<string, unknown>;
  currentTask?: string;
}

export type WorkerHealthStatus = "healthy" | "degraded" | "down";

/**
 * Compute rollup status from module health entries.
 * - Any "down" → "down"
 * - Any "degraded" → "degraded"
 * - Otherwise → "healthy"
 */
export function computeStatus(
  moduleHealth?: Record<string, unknown>,
): WorkerHealthStatus {
  if (!moduleHealth) return "healthy";
  const statuses = Object.values(moduleHealth)
    .map((m: unknown) => (m as { status?: string } | null | undefined)?.status)
    .filter((s): s is string => Boolean(s));
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "healthy";
}

/**
 * Record a heartbeat: insert history row + update workers current columns.
 * Health columns (last_heartbeat_at, last_heartbeat_ok, da_version, uptime_seconds)
 * come from migration 029; last_heartbeat is from migration 001 (backward compat).
 * Runtime state columns (status, active_sessions, active_tasks, resource_usage,
 * current_task) come from migration 001 and must stay fresh for GET / and GET /:id.
 */
export async function recordHeartbeat(
  pool: () => Pool,
  payload: HeartbeatPayload,
): Promise<void> {
  const status = computeStatus(
    payload.moduleHealth as Record<string, unknown> | undefined,
  );
  const moduleHealthJson = JSON.stringify(payload.moduleHealth ?? {});
  const resourceUsageJson = JSON.stringify(payload.resourceUsage ?? {});

  await pool().query(
    `INSERT INTO worker_health_history (worker_id, status, module_health, resource_usage, da_version)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
    [payload.workerId, status, moduleHealthJson, resourceUsageJson, payload.daVersion ?? null],
  );

  // Map the worker-reported runtime status onto a value that satisfies the
  // workers.status CHECK constraint. DA reports fine-grained runtime states
  // (online/busy/idle) from collectWorkerStatus, but the column only accepts
  // lifecycle values (online/offline/deactivated/...). Writing "idle"/"busy"
  // directly raised a 23514 CHECK violation on every heartbeat, so
  // last_heartbeat_at never updated. A received heartbeat always means the
  // worker is online; its load (busy/idle) is already captured by the
  // active_tasks / current_task columns.
  const dbStatus = normalizeWorkerStatus(payload.status);

  await pool().query(
    `UPDATE workers SET
      last_heartbeat_at = now(),
      last_heartbeat_ok = $2,
      last_heartbeat_status = $3,
      da_version = $4,
      uptime_seconds = $5,
      last_heartbeat = now(),
      status = $6,
      active_sessions = $7,
      active_tasks = $8,
      resource_usage = $9,
      current_task = $10
    WHERE id = $1`,
    [
      payload.workerId,
      status === "healthy",
      status, // healthy | degraded | down — persisted for down-vs-degraded distinction
      payload.daVersion ?? null,
      payload.uptime ?? 0,
      dbStatus,
      payload.activeSessions ?? 0,
      payload.activeTasks ?? 0,
      JSON.stringify(payload.resourceUsage ?? {}),
      payload.currentTask ?? null,
    ],
  );
}

/**
 * Values allowed by the workers.status CHECK constraint (migration 001/040).
 * DA's runtime states (online/busy/idle) are a superset that partly overlaps;
 * only "online" is directly valid. Any unknown/non-lifecycle value collapses
 * to "online" — a heartbeat reaching Hub proves the worker is up.
 */
const LIFECYCLE_STATUSES = new Set([
  "pending", "approved", "rejected", "revoked",
  "online", "offline", "draining", "deactivated",
  "deploying", "error", "decommissioned",
]);

function normalizeWorkerStatus(reported?: string): string {
  if (reported && LIFECYCLE_STATUSES.has(reported)) return reported;
  return "online";
}

export interface HealthHistoryEntry {
  id: number;
  worker_id: string;
  recorded_at: string;
  status: string;
  module_health: unknown;
  resource_usage: unknown;
  da_version: string | null;
}

export async function getHealthHistory(
  pool: () => Pool,
  workerId: string,
  hours = 24,
): Promise<HealthHistoryEntry[]> {
  const { rows } = await pool().query(
    `SELECT id, worker_id, recorded_at, status, module_health, resource_usage, da_version
     FROM worker_health_history
     WHERE worker_id = $1 AND recorded_at > now() - ($2 || ' hours')::interval
     ORDER BY recorded_at ASC`,
    [workerId, String(hours)],
  );
  return rows;
}

export interface MonitoringOverview {
  online: number;
  offline: number;
  degraded: number;
  /** Workers whose modules explicitly reported "down" (critical modules offline). */
  down: number;
  unknown: number;
  workers: Array<{
    id: string;
    hostname: string;
    last_heartbeat_at: string | null;
    last_heartbeat_ok: boolean | null;
    da_version: string | null;
    assigned_user_id: string | null;
    user_name: string | null;
    ssh_target_host: string | null;
    health_status: "online" | "offline" | "degraded" | "down" | "unknown";
  }>;
}

/**
 * Build overview of all approved workers. Health status precedence:
 *  1. no heartbeat ever → unknown
 *  2. heartbeat older than 15 min → offline (regardless of last reported status)
 *  3. last_heartbeat_status === "down" → down (critical modules offline)
 *  4. last_heartbeat_status === "degraded" → degraded
 *  5. last_heartbeat_ok === false → degraded (legacy fallback for workers
 *     that reported before migration 042 backfilled the status column)
 *  6. otherwise → online
 */
export async function getOverview(pool: () => Pool): Promise<MonitoringOverview> {
  const { rows } = await pool().query(`
    SELECT w.id, w.hostname, w.last_heartbeat_at, w.last_heartbeat_ok,
           w.last_heartbeat_status, w.da_version,
           w.assigned_user_id, u.display_name AS user_name,
           h.ssh_target_host
    FROM workers w
    LEFT JOIN users u ON u.id = w.assigned_user_id
    LEFT JOIN host_servers h ON h.id = w.host_id
    WHERE w.status IN ('approved', 'online', 'offline')
  `);
  const now = Date.now();
  let online = 0,
    offline = 0,
    degraded = 0,
    down = 0,
    unknown = 0;
  for (const w of rows) {
    if (!w.last_heartbeat_at) {
      unknown++;
      w.health_status = "unknown";
      continue;
    }
    const ageMs = now - new Date(w.last_heartbeat_at).getTime();
    if (ageMs > 15 * 60 * 1000) {
      offline++;
      w.health_status = "offline";
    } else if (w.last_heartbeat_status === "down") {
      down++;
      w.health_status = "down";
    } else if (w.last_heartbeat_status === "degraded" || w.last_heartbeat_ok === false) {
      degraded++;
      w.health_status = "degraded";
    } else {
      online++;
      w.health_status = "online";
    }
  }
  return { online, offline, degraded, down, unknown, workers: rows };
}
