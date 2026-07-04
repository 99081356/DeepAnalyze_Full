// tests/routes/monitoring.test.ts
//
// T18: /monitoring routes 测试
// 覆盖：
//   - GET /overview 用 super_admin JWT → 200
//   - GET /overview 无 JWT → 401
//   - GET /overview 用 org_admin JWT → 403 (requirePermission + isSuperAdmin 双层校验)
//   - GET /workers/:id/history → 200 + items 数组
//
// Pattern: inline seedFixture + issueTokenPair(userId) (T13 风格)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { getPool } from "../../src/store/pg";
import { issueTokenPair } from "../../src/domain/auth";
import { createMonitoringRoutes } from "../../src/server/routes/monitoring";

const TEST_SUPER_ADMIN_ID = "usr_test_monitoring_admin";
const TEST_ORG_ADMIN_ID = "usr_test_monitoring_org";
const TEST_ORG_ID = "org_test_monitoring";
const TEST_WORKER_ID = "wkr_test_monitoring_worker";

async function seedSuperAdmin() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, username, display_name, is_super_admin, status)
     VALUES ($1, 'monitoring-admin', 'Test Admin', true, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_SUPER_ADMIN_ID],
  );
}

async function seedOrgAdmin() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
     VALUES ($1, $2, $2, NULL, 0, $1, 'root', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_ORG_ID, "Test Org Monitoring"],
  );
  await pool.query(
    `INSERT INTO users (id, username, display_name, organization_id, is_org_admin, status)
     VALUES ($1, $2, $3, $4, true, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_ORG_ADMIN_ID, TEST_ORG_ADMIN_ID, "Org Admin Monitoring", TEST_ORG_ID],
  );
  // role_org_admin 角色 → 通过 migration 033 自动有 config_template:*；
  // 但 worker:read 由 migration 005 授予 role_org_admin
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'role_org_admin')
     ON CONFLICT DO NOTHING`,
    [TEST_ORG_ADMIN_ID],
  );
}

async function seedWorker() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token)
     VALUES ($1, 'monitoring-host', 'approved', 'test-token-monitoring')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKER_ID],
  );
}

async function cleanupFixture() {
  const pool = getPool();
  await pool.query(`DELETE FROM worker_health_history WHERE worker_id = $1`, [
    TEST_WORKER_ID,
  ]);
  await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [
    TEST_ORG_ADMIN_ID,
  ]);
  await pool.query(`DELETE FROM workers WHERE id = $1`, [TEST_WORKER_ID]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
    TEST_SUPER_ADMIN_ID,
    TEST_ORG_ADMIN_ID,
  ]);
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [TEST_ORG_ID]);
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/monitoring", createMonitoringRoutes());
  return app;
}

describe("GET /api/v1/monitoring/overview", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedSuperAdmin();
    await seedWorker();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("super_admin JWT returns overview with workers", async () => {
    const { access_token } = issueTokenPair(TEST_SUPER_ADMIN_ID);
    const app = buildApp();
    const res = await app.request("/api/v1/monitoring/overview", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.online).toBeDefined();
    expect(body.workers).toBeInstanceOf(Array);
  });

  test("missing JWT returns 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/monitoring/overview");
    expect(res.status).toBe(401);
  });

  test("org_admin JWT returns 403 (super_admin only)", async () => {
    await seedOrgAdmin();
    const { access_token } = issueTokenPair(TEST_ORG_ADMIN_ID);
    const app = buildApp();
    const res = await app.request("/api/v1/monitoring/overview", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/monitoring/workers/:id/history", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedSuperAdmin();
    await seedWorker();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("returns history items for worker", async () => {
    // 先种入一条心跳记录
    await getPool().query(
      `INSERT INTO worker_health_history (worker_id, status, module_health)
       VALUES ($1, 'healthy', '{}'::jsonb)`,
      [TEST_WORKER_ID],
    );
    const { access_token } = issueTokenPair(TEST_SUPER_ADMIN_ID);
    const app = buildApp();
    const res = await app.request(
      `/api/v1/monitoring/workers/${TEST_WORKER_ID}/history`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });
});
