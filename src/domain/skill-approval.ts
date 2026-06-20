/**
 * Skill approval workflow for org/system scope publishes.
 *
 * Flow:
 *   1. Author requests publish → creates skill_approvals row (status=pending)
 *      + runs PublishGate, stores result
 *   2. Admin reviews → approves or rejects
 *   3. If approved, version transitions to published (called by transition handler)
 */

import { randomUUID } from "crypto";
import { query } from "../store/pg.js";
import * as auditLog from "./skill-audit-log.js";
import { evaluateForPublish, type PublishGateResult } from "./publish-gate.js";

export interface SkillApproval {
  id: string;
  version_id: string;
  package_id: string;
  requested_by: string;
  requested_at: string;
  status: "pending" | "approved" | "rejected" | "expired";
  reviewer_id: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  publish_gate_result: PublishGateResult | null;
  expires_at: string | null;
}

export async function requestApproval(params: {
  version_id: string;
  package_id: string;
  requested_by: string;
  content: string;
  test_cases?: unknown[];
  scope: "user" | "org" | "system";
  trust_level?: string;
}): Promise<{ approval: SkillApproval; gateResult: PublishGateResult }> {
  const id = `appr_${randomUUID().replace(/-/g, "")}`;
  const gateResult = await evaluateForPublish({
    content: params.content,
    testCases: params.test_cases,
    scope: params.scope,
    trustLevel: params.trust_level,
  });

  const { rows } = await query(
    `INSERT INTO skill_approvals
      (id, version_id, package_id, requested_by, status, publish_gate_result, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, NOW() + INTERVAL '7 days')
     RETURNING *`,
    [id, params.version_id, params.package_id, params.requested_by, JSON.stringify(gateResult)],
  );

  await auditLog.log({
    version_id: params.version_id,
    package_id: params.package_id,
    actor_id: params.requested_by,
    action: "approval_requested",
    details: {
      approval_id: id,
      gate_blocked: gateResult.blocked,
      gate_score: gateResult.overall,
    },
  });

  return { approval: rows[0] as SkillApproval, gateResult };
}

export async function approve(
  approvalId: string,
  reviewerId: string,
  notes?: string,
): Promise<SkillApproval> {
  const { rows } = await query<SkillApproval>(
    `UPDATE skill_approvals
     SET status = 'approved', reviewer_id = $1, reviewed_at = NOW(), review_notes = $2
     WHERE id = $3 AND status = 'pending'
     RETURNING *`,
    [reviewerId, notes ?? null, approvalId],
  );
  if (rows.length === 0) {
    throw new Error("Approval not found or not pending");
  }

  await auditLog.log({
    version_id: rows[0].version_id,
    package_id: rows[0].package_id,
    actor_id: reviewerId,
    action: "approval_approved",
    details: { approval_id: approvalId, notes },
  });

  return rows[0];
}

export async function reject(
  approvalId: string,
  reviewerId: string,
  reason: string,
): Promise<SkillApproval> {
  const { rows } = await query<SkillApproval>(
    `UPDATE skill_approvals
     SET status = 'rejected', reviewer_id = $1, reviewed_at = NOW(), review_notes = $2
     WHERE id = $3 AND status = 'pending'
     RETURNING *`,
    [reviewerId, reason, approvalId],
  );
  if (rows.length === 0) {
    throw new Error("Approval not found or not pending");
  }

  await auditLog.log({
    version_id: rows[0].version_id,
    package_id: rows[0].package_id,
    actor_id: reviewerId,
    action: "approval_rejected",
    details: { approval_id: approvalId, reason },
  });

  return rows[0];
}

export async function listPending(limit = 50): Promise<SkillApproval[]> {
  const { rows } = await query<SkillApproval>(
    `SELECT a.*, p.name as package_name, p.scope as package_scope, v.version as version_str
     FROM skill_approvals a
     JOIN skill_packages p ON p.id = a.package_id
     JOIN skill_versions v ON v.id = a.version_id
     WHERE a.status = 'pending'
     ORDER BY a.requested_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getById(id: string): Promise<SkillApproval | null> {
  const { rows } = await query<SkillApproval>(`SELECT * FROM skill_approvals WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
