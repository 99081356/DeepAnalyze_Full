/**
 * SkillSharing domain — cross-org 双边审批流程.
 *
 * Flow:
 *   1. Source org admin initiates sharing (POST /sharings)
 *   2. Target org admin approves or rejects (POST /sharings/:id/approve|reject)
 *   3. On approve: auto-create org_share subscription for target org
 *   4. Either side or super_admin can revoke (DELETE /sharings/:id)
 *      - Auto-removes target org subscriptions
 *      - Enqueues kill instruction for affected workers
 *
 * Restrictions JSONB supports:
 *   max_users: number       — cap subscribers
 *   expires_at: ISO string  — auto-revoke after this time
 *   data_classification_max: 'public' | 'internal' | 'secret' | 'confidential'
 */

import { randomUUID } from "crypto";
import { query } from "../store/pg.js";
import * as auditLog from "./skill-audit-log.js";
import * as skillSub from "./skill-subscription.js";

export type SharingStatus = "pending" | "approved" | "rejected" | "revoked";

export interface SkillSharing {
  id: string;
  package_id: string;
  source_org_id: string;
  target_org_id: string;
  status: SharingStatus;
  initiated_by: string;
  approved_by: string | null;
  restrictions: Record<string, unknown>;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export interface SharingRestrictions {
  max_users?: number;
  expires_at?: string;
  data_classification_max?: "public" | "internal" | "secret" | "confidential";
}

/**
 * Source org admin initiates sharing request.
 * Validates:
 *   - source_org_id must own the package
 *   - target_org_id must exist and differ from source
 *   - No existing pending/approved sharing for same pair
 */
export async function requestSharing(params: {
  package_id: string;
  source_org_id: string;
  target_org_id: string;
  initiated_by: string;
  restrictions?: SharingRestrictions;
  usage_intent?: string;
  business_justification?: string;
}): Promise<{ sharing: SkillSharing; error?: string }> {
  if (params.source_org_id === params.target_org_id) {
    return { sharing: null as never, error: "Cannot share within the same org" };
  }

  // Validate package ownership
  const { rows: pkgRows } = await query<{ org_id: string | null; scope: string; name: string }>(
    `SELECT org_id, scope, name FROM skill_packages WHERE id = $1`,
    [params.package_id],
  );
  if (pkgRows.length === 0) {
    return { sharing: null as never, error: "Package not found" };
  }
  if (pkgRows[0].org_id !== params.source_org_id) {
    return { sharing: null as never, error: "Package does not belong to source org" };
  }

  // Validate target org exists
  const { rows: targetRows } = await query<{ id: string }>(
    `SELECT id FROM organizations WHERE id = $1`,
    [params.target_org_id],
  );
  if (targetRows.length === 0) {
    return { sharing: null as never, error: "Target org not found" };
  }

  // Check duplicate
  const { rows: dupRows } = await query<{ id: string; status: string }>(
    `SELECT id, status FROM skill_sharings
     WHERE package_id = $1 AND source_org_id = $2 AND target_org_id = $3
       AND status IN ('pending', 'approved')`,
    [params.package_id, params.source_org_id, params.target_org_id],
  );
  if (dupRows.length > 0) {
    return {
      sharing: null as never,
      error: `Active sharing already exists (status=${dupRows[0].status})`,
    };
  }

  const id = `shr_${randomUUID().replace(/-/g, "")}`;
  let inserted: SkillSharing | null = null;
  try {
    const { rows } = await query<SkillSharing>(
      `INSERT INTO skill_sharings
        (id, package_id, source_org_id, target_org_id, status, initiated_by, restrictions, usage_intent, business_justification)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        params.package_id,
        params.source_org_id,
        params.target_org_id,
        params.initiated_by,
        JSON.stringify(params.restrictions ?? {}),
        params.usage_intent ?? null,
        params.business_justification ?? null,
      ],
    );
    inserted = rows[0];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("uq_sharing_active_pair") || msg.includes("unique")) {
      return {
        sharing: null as never,
        error: "Active sharing already exists (race condition)",
      };
    }
    throw err;
  }

  await auditLog.log({
    package_id: params.package_id,
    actor_id: params.initiated_by,
    action: "share_initiated",
    details: {
      sharing_id: id,
      source_org_id: params.source_org_id,
      target_org_id: params.target_org_id,
      restrictions: params.restrictions ?? {},
    },
  });

  return { sharing: inserted };
}

/**
 * Target org admin approves the sharing.
 * Side effects:
 *   - Auto-create org_share subscription for target org (is_forced=true)
 *   - Audit log
 */
export async function approveSharing(
  sharingId: string,
  approvedBy: string,
): Promise<{ sharing: SkillSharing; error?: string }> {
  const { rows } = await query<SkillSharing>(
    `SELECT * FROM skill_sharings WHERE id = $1 FOR UPDATE`,
    [sharingId],
  );
  if (rows.length === 0) {
    return { sharing: null as never, error: "Sharing not found" };
  }
  const sharing = rows[0];
  if (sharing.status !== "pending") {
    return { sharing: null as never, error: `Sharing is ${sharing.status}, not pending` };
  }

  const { rows: updated } = await query<SkillSharing>(
    `UPDATE skill_sharings
     SET status = 'approved', approved_by = $1, approved_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [approvedBy, sharingId],
  );

  // Auto-subscribe target org (forced, source=org_share)
  await skillSub.subscribe({
    package_id: sharing.package_id,
    subscriber_type: "org",
    subscriber_id: sharing.target_org_id,
    is_forced: true,
    source: "org_share",
  });

  await auditLog.log({
    package_id: sharing.package_id,
    actor_id: approvedBy,
    action: "share_approved",
    details: {
      sharing_id: sharingId,
      source_org_id: sharing.source_org_id,
      target_org_id: sharing.target_org_id,
    },
  });

  return { sharing: updated[0] };
}

/**
 * Target org admin rejects the sharing.
 */
export async function rejectSharing(
  sharingId: string,
  rejectedBy: string,
  reason: string,
): Promise<{ sharing: SkillSharing; error?: string }> {
  const { rows } = await query<SkillSharing>(
    `SELECT * FROM skill_sharings WHERE id = $1`,
    [sharingId],
  );
  if (rows.length === 0) {
    return { sharing: null as never, error: "Sharing not found" };
  }
  if (rows[0].status !== "pending") {
    return { sharing: null as never, error: `Sharing is ${rows[0].status}, not pending` };
  }

  const { rows: updated } = await query<SkillSharing>(
    `UPDATE skill_sharings
     SET status = 'rejected', approved_by = $1, approved_at = NOW(), revoke_reason = $2
     WHERE id = $3
     RETURNING *`,
    [rejectedBy, reason, sharingId],
  );

  await auditLog.log({
    package_id: rows[0].package_id,
    actor_id: rejectedBy,
    action: "share_rejected",
    details: { sharing_id: sharingId, reason },
  });

  return { sharing: updated[0] };
}

/**
 * Revoke an approved sharing.
 * Side effects:
 *   - Remove target org subscription
 *   - Enqueue kill instruction for affected workers (via sync queue)
 *   - Audit log
 */
export async function revokeSharing(
  sharingId: string,
  revokedBy: string,
  reason: string,
): Promise<{ sharing: SkillSharing; error?: string; killed_workers: number }> {
  const { rows } = await query<SkillSharing>(
    `SELECT * FROM skill_sharings WHERE id = $1`,
    [sharingId],
  );
  if (rows.length === 0) {
    return { sharing: null as never, error: "Sharing not found", killed_workers: 0 };
  }
  const sharing = rows[0];
  if (sharing.status !== "approved") {
    return {
      sharing: null as never,
      error: `Cannot revoke sharing with status ${sharing.status}`,
      killed_workers: 0,
    };
  }

  const { rows: updated } = await query<SkillSharing>(
    `UPDATE skill_sharings
     SET status = 'revoked', revoked_at = NOW(), revoked_by = $1, revoke_reason = $2
     WHERE id = $3
     RETURNING *`,
    [revokedBy, reason, sharingId],
  );

  // Remove target org subscription (org_share only)
  await query(
    `DELETE FROM skill_subscriptions
     WHERE package_id = $1 AND subscriber_type = 'org' AND subscriber_id = $2
       AND source = 'org_share'`,
    [sharing.package_id, sharing.target_org_id],
  );

  // Enqueue kill instruction for affected workers in target org
  const killId = `que_${randomUUID().replace(/-/g, "")}`;
  await query(
    `INSERT INTO skill_sync_queue
      (id, package_id, action, scope, target_org_ids, reason, priority, created_by)
     VALUES ($1, $2, 'kill', 'org', $3, $4, 90, $5)`,
    [
      killId,
      sharing.package_id,
      JSON.stringify([sharing.target_org_id]),
      reason,
      revokedBy,
    ],
  );

  // Count affected workers for reporting
  const { rows: countRows } = await query<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM workers WHERE organization_id = $1`,
    [sharing.target_org_id],
  );

  await auditLog.log({
    package_id: sharing.package_id,
    actor_id: revokedBy,
    action: "share_revoked",
    details: {
      sharing_id: sharingId,
      target_org_id: sharing.target_org_id,
      reason,
      killed_workers: countRows[0].count,
    },
  });

  return { sharing: updated[0], killed_workers: countRows[0].count };
}

export interface ListSharingsFilter {
  status?: SharingStatus;
  org_role?: "source" | "target" | "either";
  org_id?: string;
  package_id?: string;
}

export async function listSharings(
  filter: ListSharingsFilter,
  limit = 50,
): Promise<SkillSharing[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filter.status) {
    clauses.push(`status = $${idx++}`);
    params.push(filter.status);
  }
  if (filter.package_id) {
    clauses.push(`package_id = $${idx++}`);
    params.push(filter.package_id);
  }
  if (filter.org_id && filter.org_role) {
    const col = filter.org_role === "source" ? "source_org_id" : "target_org_id";
    clauses.push(`${col} = $${idx++}`);
    params.push(filter.org_id);
  } else if (filter.org_id) {
    clauses.push(`($${idx} = source_org_id OR $${idx + 1} = target_org_id)`);
    params.push(filter.org_id, filter.org_id);
    idx += 2;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await query<SkillSharing>(
    `SELECT * FROM skill_sharings ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...params, limit],
  );
  return rows;
}

export async function getSharing(id: string): Promise<SkillSharing | null> {
  const { rows } = await query<SkillSharing>(
    `SELECT * FROM skill_sharings WHERE id = $1`,
    [id],
  );
  return rows.length > 0 ? rows[0] : null;
}
