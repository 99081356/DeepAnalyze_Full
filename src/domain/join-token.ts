// =============================================================================
// DeepAnalyze Hub - Join Token Domain
// =============================================================================
// 一次性 join_token 生成与消费。Hub Admin 生成后发给员工，
// 员工在自己 DA 的"设置 → Hub 连接"填入此 token 即可加入。
// =============================================================================

import { randomUUID } from "node:crypto";
import { query } from "../store/pg.js";

export interface JoinTokenRow {
  id: string;
  token: string;
  organization_id: string;
  assigned_user_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  use_count: number;
  max_uses: number;
}

export interface CreateJoinTokenOpts {
  organizationId: string;
  assignedUserId?: string;
  createdBy: string;
  expiresInHours?: number;
  maxUses?: number;
  notes?: string;
}

export async function createJoinToken(
  opts: CreateJoinTokenOpts,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const id = `jtk_${randomUUID().replace(/-/g, "")}`;
  const token = `djt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const expiresInHours = opts.expiresInHours ?? 24;
  const maxUses = opts.maxUses ?? 1;

  const result = await query<{ expires_at: Date }>(
    `INSERT INTO join_tokens (id, token, organization_id, assigned_user_id, created_by,
                              expires_at, max_uses, notes)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour' * $6, $7, $8)
     RETURNING expires_at`,
    [id, token, opts.organizationId, opts.assignedUserId ?? null,
     opts.createdBy, expiresInHours, maxUses, opts.notes ?? null],
  );

  return {
    id,
    token,
    expiresAt: result.rows[0].expires_at,
  };
}

export interface ConsumeResult {
  valid: boolean;
  reason?: string;
  meta?: {
    id: string;
    organizationId: string;
    assignedUserId: string | null;
  };
}

export async function consumeJoinToken(
  token: string,
): Promise<ConsumeResult> {
  const rows = await query<JoinTokenRow>(
    `SELECT * FROM join_tokens WHERE token = $1 FOR UPDATE`,
    [token],
  );
  if (rows.rows.length === 0) {
    return { valid: false, reason: "join_token not found" };
  }
  const row = rows.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: "join_token expired" };
  }
  if (row.use_count >= row.max_uses) {
    return { valid: false, reason: "join_token already consumed" };
  }

  await query(
    `UPDATE join_tokens
     SET use_count = use_count + 1,
         consumed_at = CASE WHEN use_count + 1 >= max_uses THEN NOW() ELSE consumed_at END
     WHERE id = $1`,
    [row.id],
  );

  return {
    valid: true,
    meta: {
      id: row.id,
      organizationId: row.organization_id,
      assignedUserId: row.assigned_user_id,
    },
  };
}

export async function listJoinTokens(
  organizationId?: string,
): Promise<JoinTokenRow[]> {
  const sql = organizationId
    ? `SELECT * FROM join_tokens WHERE organization_id = $1 ORDER BY created_at DESC`
    : `SELECT * FROM join_tokens ORDER BY created_at DESC`;
  const params = organizationId ? [organizationId] : [];
  const result = await query<JoinTokenRow>(sql, params);
  return result.rows;
}
