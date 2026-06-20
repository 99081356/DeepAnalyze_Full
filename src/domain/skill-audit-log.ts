/**
 * Skill audit log — immutable event log.
 *
 * Repository API exposes only log() and query() — no update/delete.
 * Database-level immutability is enforced by REVOKE in production;
 * in dev we rely on the repository contract.
 */

import { query } from "../store/pg.js";

export interface AuditLogEntry {
  id: number;
  version_id: string | null;
  package_id: string | null;
  actor_id: string | null;
  action: string;
  from_status: string | null;
  to_status: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

/**
 * Append an entry to the audit log. Cannot be modified or deleted.
 */
export async function log(params: {
  version_id?: string | null;
  package_id?: string | null;
  actor_id?: string | null;
  action: string;
  from_status?: string | null;
  to_status?: string | null;
  details?: Record<string, unknown>;
}): Promise<AuditLogEntry> {
  const { rows } = await query<AuditLogEntry>(
    `INSERT INTO skill_audit_logs
      (version_id, package_id, actor_id, action, from_status, to_status, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.version_id ?? null,
      params.package_id ?? null,
      params.actor_id ?? null,
      params.action,
      params.from_status ?? null,
      params.to_status ?? null,
      JSON.stringify(params.details ?? {}),
    ],
  );
  return rows[0];
}

export async function queryByPackage(packageId: string, limit = 50): Promise<AuditLogEntry[]> {
  const { rows } = await query<AuditLogEntry>(
    `SELECT * FROM skill_audit_logs WHERE package_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [packageId, limit],
  );
  return rows;
}

export async function queryByVersion(versionId: string, limit = 50): Promise<AuditLogEntry[]> {
  const { rows } = await query<AuditLogEntry>(
    `SELECT * FROM skill_audit_logs WHERE version_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [versionId, limit],
  );
  return rows;
}
