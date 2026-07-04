import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createSsoRoutes } from "../../src/server/routes/sso";
import { issueTokenPair } from "../../src/domain/auth";
import { getPool } from "../../src/store/pg";

// ─── Inline fixtures (same pattern as T08) ────────────────────────────────

async function seedFixture(label: string): Promise<{
  userId: string;
  workerId: string;
  workerToken: string;
  hostServerId: string;
  orgId: string;
}> {
  const pool = getPool();
  const orgId = `org_test_${label}`;
  const userId = `usr_test_${label}`;
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  const workerToken = `wkt_test_${label}_${randomUUID().replace(/-/g, "")}`;

  await pool.query(
    `INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
     VALUES ($1, $2, $2, NULL, 0, $1, 'root', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [orgId, `Test Org ${label}`],
  );
  await pool.query(
    `INSERT INTO users (id, username, display_name, organization_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [userId, userId, `Test User ${label}`, orgId],
  );
  await pool.query(
    `INSERT INTO host_servers (id, hostname, ssh_target_host, status)
     VALUES ($1, $2, '127.0.0.1', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [hostServerId, `test-host-${label}`],
  );
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port, assigned_user_id)
     VALUES ($1, $2, 'approved', $3, $4, 21000, $5)
     ON CONFLICT (id) DO NOTHING`,
    [workerId, `test-worker-${label}`, workerToken, hostServerId, userId],
  );

  return { userId, workerId, workerToken, hostServerId, orgId };
}

async function cleanupFixture(label: string): Promise<void> {
  const pool = getPool();
  const userId = `usr_test_${label}`;
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  const orgId = `org_test_${label}`;
  await pool.query(`DELETE FROM sso_tickets WHERE user_id = $1 OR da_worker_id = $2`, [userId, workerId]);
  await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  await pool.query(`DELETE FROM host_servers WHERE id = $1`, [hostServerId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
}

// ─── Test app builder ─────────────────────────────────────────────────────

function buildApp(): Hono {
  const app = new Hono();
  // Mount ONLY sso routes; real jwtAuth runs on /ticket, /exchange is public
  app.route("/api/v1/auth/sso", createSsoRoutes());
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("POST /api/v1/auth/sso/ticket", () => {
  test("已登录用户能创建 ticket", async () => {
    const f = await seedFixture("sso-route-1");
    try {
      const app = buildApp();
      const { access_token } = issueTokenPair(f.userId);
      const res = await app.request("/api/v1/auth/sso/ticket", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ da_worker_id: f.workerId }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ticket).toMatch(/^sst_/);
      expect(body.redirect_url).toContain("/api/auth/sso/callback");
      expect(body.expires_in).toBe(10);
    } finally {
      await cleanupFixture("sso-route-1");
    }
  });

  test("未登录 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/auth/sso/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ da_worker_id: "wk_does_not_exist" }),
    });
    expect(res.status).toBe(401);
  });

  test("worker 不属于该用户 403", async () => {
    const f1 = await seedFixture("sso-route-3a");
    const f2 = await seedFixture("sso-route-3b");
    try {
      const app = buildApp();
      // f1 user tries to ticket for f2 worker
      const { access_token } = issueTokenPair(f1.userId);
      const res = await app.request("/api/v1/auth/sso/ticket", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ da_worker_id: f2.workerId }),
      });
      expect(res.status).toBe(403);
    } finally {
      await cleanupFixture("sso-route-3a");
      await cleanupFixture("sso-route-3b");
    }
  });
});

describe("POST /api/v1/auth/sso/exchange", () => {
  test("DA 后端用 worker_token 兑换 access_token", async () => {
    const f = await seedFixture("sso-route-2");
    try {
      const app = buildApp();
      // 先创建 ticket（用 user 身份）
      const { access_token: userJwt } = issueTokenPair(f.userId);
      const ticketRes = await app.request("/api/v1/auth/sso/ticket", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userJwt}`,
        },
        body: JSON.stringify({ da_worker_id: f.workerId }),
      });
      expect(ticketRes.status).toBe(200);
      const { ticket } = await ticketRes.json();

      // 用 worker_token 兑换（无 jwtAuth）
      const res = await app.request("/api/v1/auth/sso/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket, da_worker_token: f.workerToken }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.access_token).toBeTruthy();
      expect(body.user.id).toBe(f.userId);
    } finally {
      await cleanupFixture("sso-route-2");
    }
  });

  test("缺 da_worker_token 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/auth/sso/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: "sst_xxx" }),
    });
    expect(res.status).toBe(400);
  });

  test("无效 worker_token 401", async () => {
    const f = await seedFixture("sso-route-4");
    try {
      const app = buildApp();
      // Create a real ticket first
      const { access_token: userJwt } = issueTokenPair(f.userId);
      const ticketRes = await app.request("/api/v1/auth/sso/ticket", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userJwt}`,
        },
        body: JSON.stringify({ da_worker_id: f.workerId }),
      });
      const { ticket } = await ticketRes.json();

      // Try to exchange with wrong token
      const res = await app.request("/api/v1/auth/sso/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket, da_worker_token: "wkt_wrong_token_xxx" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await cleanupFixture("sso-route-4");
    }
  });
});
