import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createAuthRoutes } from "../../src/server/routes/auth";
import { issueTokenPair } from "../../src/domain/auth";
import { getPool } from "../../src/store/pg";

// ─── Inline fixtures (same shape as sso.test.ts) ─────────────────────────

async function seedFixture(label: string): Promise<{
  userId: string;
  workerId: string;
  hostServerId: string;
  orgId: string;
  daUrl: string;
}> {
  const pool = getPool();
  const orgId = `org_test_${label}`;
  const userId = `usr_test_${label}`;
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  const workerToken = `wkt_test_${label}_${randomUUID().replace(/-/g, "")}`;
  const daUrl = `http://test-host-${label}.local:21000`;

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
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [hostServerId, `test-host-${label}`, `test-host-${label}.local`],
  );
  // Use workers.da_url column (already exists from migration 019)
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port, assigned_user_id, da_url)
     VALUES ($1, $2, 'approved', $3, $4, 21000, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [workerId, `test-worker-${label}`, workerToken, hostServerId, userId, daUrl],
  );

  return { userId, workerId, hostServerId, orgId, daUrl };
}

async function cleanupFixture(label: string): Promise<void> {
  const pool = getPool();
  const userId = `usr_test_${label}`;
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  const orgId = `org_test_${label}`;
  await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  await pool.query(`DELETE FROM host_servers WHERE id = $1`, [hostServerId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/auth", createAuthRoutes());
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/v1/auth/me — da_url extension", () => {
  test("已分配 worker 的用户拿到 da_url + da_worker_id", async () => {
    const f = await seedFixture("me-1");
    try {
      const app = buildApp();
      const { access_token } = issueTokenPair(f.userId);
      const res = await app.request("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(f.userId);
      // Existing flat fields still present
      expect(body.username).toBe(f.userId);
      expect(body.display_name).toBe(`Test User me-1`);
      // New fields
      expect(body.da_url).toBe(f.daUrl);
      expect(body.da_worker_id).toBe(f.workerId);
    } finally {
      await cleanupFixture("me-1");
    }
  });

  test("未分配 worker 的用户拿到 da_url=null + da_worker_id=null", async () => {
    // Seed user without worker
    const pool = getPool();
    const label = "me-2";
    const orgId = `org_test_${label}`;
    const userId = `usr_test_${label}`;
    try {
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

      const app = buildApp();
      const { access_token } = issueTokenPair(userId);
      const res = await app.request("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(userId);
      expect(body.da_url).toBeNull();
      expect(body.da_worker_id).toBeNull();
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    }
  });

  test("未登录 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });
});
