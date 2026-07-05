// =============================================================================
// DeepAnalyze Hub - SSO Ticket Domain
// =============================================================================
// Hub → DA 单次使用 SSO 票据。
//
// 流程：
//   1. Hub 已登录用户请求跳转到 DA → createTicket() 写入 sso_tickets 表
//      并返回 redirect_url 指向 DA 的 /api/auth/sso/callback?hub_ticket=...
//   2. 浏览器跳转 DA → DA 后端拿 hub_ticket + 自身的 da_worker_token 调
//      exchangeTicket() 换取 Hub access_token。
//
// 安全约束：
//   - TTL = 10 秒，单次使用（consumed_at 设置后不可重置）
//   - exchangeTicket 用 FOR UPDATE 行锁防并发兑换
//   - da_worker_token 校验确保只有合法 DA 容器才能兑换
// =============================================================================

import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { issueTokenPair } from "./auth.js";

export interface SSOTicket {
  ticket: string;
  expires_at: Date;
  redirect_url: string;
}

export interface CreateTicketInput {
  userId: string;
  workerId: string;
  clientIp?: string;
  userAgent?: string;
}

export interface ExchangeInput {
  ticket: string;
  daWorkerToken: string;
}

export interface ExchangeResult {
  accessToken: string;
  user: {
    id: string;
    display_name: string | null;
    organization_id: string | null;
  };
}

const TICKET_TTL_SECONDS = 10; // 短命 + 单次使用

/**
 * 签发 SSO ticket。
 * - 校验 worker 属于该 user + status IN ('approved','online','offline')
 * - 校验 worker 有 host_port（T07 deploy 后保证）
 * - 写入 sso_tickets 表（consumed_at = NULL）
 * - 返回 redirect_url：DA 容器的 /api/auth/sso/callback?hub_ticket=...
 */
export async function createTicket(
  pool: () => Pool,
  input: CreateTicketInput,
): Promise<SSOTicket> {
  const id = `sst_${randomUUID()}`;
  const ticket = `sst_${randomUUID().replace(/-/g, "")}`;
  const expiresAt = new Date(Date.now() + TICKET_TTL_SECONDS * 1000);

  const { rows: wRows } = await pool().query<{
    host_port: number | null;
    host_id: string | null;
    da_url: string | null;
  }>(
    `SELECT host_port, host_id, da_url FROM workers
     WHERE id = $1 AND assigned_user_id = $2 AND status IN ('approved', 'online', 'offline')`,
    [input.workerId, input.userId],
  );
  if (wRows.length === 0) {
    throw new Error("worker not assigned to user or not in active lifecycle (approved/online/offline)");
  }
  const worker = wRows[0];

  // 构建 DA 外部可达 URL
  let daUrl: string;
  if (worker.da_url) {
    daUrl = worker.da_url;
  } else if (worker.host_port) {
    let daHost: string | null = null;
    if (worker.host_id) {
      const { rows: hRows } = await pool().query<{ ssh_target_host: string }>(
        `SELECT ssh_target_host FROM host_servers WHERE id = $1`,
        [worker.host_id],
      );
      daHost = hRows[0]?.ssh_target_host ?? null;
    }
    const daHostForUrl = daHost ?? "localhost";
    daUrl = `http://${daHostForUrl}:${worker.host_port}`;
  } else {
    // Fallback: no host_port or da_url — use default port
    daUrl = "http://localhost:21000";
  }

  await pool().query(
    `INSERT INTO sso_tickets (id, ticket, user_id, da_worker_id, expires_at, client_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::inet, $7)`,
    [
      id,
      ticket,
      input.userId,
      input.workerId,
      expiresAt,
      input.clientIp ?? null,
      input.userAgent ?? null,
    ],
  );

  return {
    ticket,
    expires_at: expiresAt,
    redirect_url: `${daUrl}/api/auth/sso/callback?hub_ticket=${encodeURIComponent(ticket)}`,
  };
}

/**
 * 兑换 SSO ticket 为 Hub access_token。
 * - 用 daWorkerToken 找 worker（status IN ('approved','online','offline')）
 * - 用 ticket 找 sso_tickets 行（FOR UPDATE 防并发兑换）
 * - 校验未消费、未过期、worker 匹配
 * - 标记 consumed_at = now()
 * - 用 issueTokenPair(userId, {name, org_id}) 签发带用户信息的 access_token
 */
export async function exchangeTicket(
  pool: () => Pool,
  input: ExchangeInput,
): Promise<ExchangeResult> {
  const client = await pool().connect();
  try {
    // 1. 用 da_worker_token 找对应 worker
    const { rows: wRows } = await client.query<{ id: string; assigned_user_id: string }>(
      `SELECT id, assigned_user_id FROM workers
       WHERE worker_token = $1 AND status IN ('approved', 'online', 'offline')`,
      [input.daWorkerToken],
    );
    if (wRows.length === 0) throw new Error("invalid da_worker_token");
    const worker = wRows[0];

    // 2. 用 ticket 找 sso_tickets 行（FOR UPDATE 防并发）
    const { rows: tRows } = await client.query(
      `SELECT * FROM sso_tickets WHERE ticket = $1 FOR UPDATE`,
      [input.ticket],
    );
    if (tRows.length === 0) throw new Error("ticket not found");
    const t = tRows[0] as {
      id: string;
      consumed_at: Date | null;
      expires_at: Date;
      da_worker_id: string;
      user_id: string;
    };

    if (t.consumed_at) throw new Error("ticket already consumed");
    if (new Date(t.expires_at).getTime() < Date.now()) {
      throw new Error("ticket expired");
    }
    if (t.da_worker_id !== worker.id) {
      throw new Error(
        `ticket/worker mismatch: ticket for ${t.da_worker_id}, token for ${worker.id}`,
      );
    }

    // 防御纵深：校验 ticket 的 user_id 与 worker 的 assigned_user_id 一致
    if (t.user_id !== worker.assigned_user_id) {
      throw new Error(
        `ticket/user mismatch: ticket for user ${t.user_id}, worker assigned to ${worker.assigned_user_id}`,
      );
    }

    // 3. 标记 consumed
    await client.query(`UPDATE sso_tickets SET consumed_at = now() WHERE id = $1`, [t.id]);

    // 4. 取 user 信息（用 ticket 的 user_id，而非 worker.assigned_user_id，避免 TOCTOU）
    const { rows: uRows } = await client.query<{
      id: string;
      display_name: string | null;
      organization_id: string | null;
    }>(
      `SELECT id, display_name, organization_id FROM users WHERE id = $1`,
      [t.user_id],
    );
    if (uRows.length === 0) throw new Error("user not found");
    const user = uRows[0];

    // 5. 签发 access_token，把 display_name/org_id 作为 claim 写入。
    //    DA 端 verifyHubJwt 直接从 JWT payload 读 name/org_id，无需再调 Hub /users/:id。
    //    display_name 为空时回退到 user.id（保证 DA UI 不显示 "unknown"）。
    const { access_token } = issueTokenPair(user.id, {
      name: user.display_name || user.id,
      org_id: user.organization_id,
    });

    return {
      accessToken: access_token,
      user: {
        id: user.id,
        display_name: user.display_name,
        organization_id: user.organization_id,
      },
    };
  } finally {
    client.release();
  }
}
