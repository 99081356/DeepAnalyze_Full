// tests/routes/worker-backups.test.ts
//
// T19: /api/v1/workers/:id/backups routes 测试
// 覆盖：
//   - GET  /api/v1/workers/:id/backups       用 super_admin JWT → 200 + items 数组（空）
//   - GET  /api/v1/workers/:id/backups       无 JWT → 401
//   - POST /api/v1/workers/:id/backups       创建手动 backup 记录 → 201
//   - POST /api/v1/workers/:id/backups       未知 worker → 404
//   - DELETE /api/v1/workers/:id/backups/:backupId  删除自己的 backup → 200 + ok:true
//   - DELETE /api/v1/workers/:id/backups/:backupId  未知 backup → 404
//
// Pattern: inline seedFixture + issueTokenPair(userId) (T13/T18 风格)
//
// 注意：issueTokenPair 是同步函数，不需要 await（但加了也无害）
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { getPool } from "../../src/store/pg";
import { issueTokenPair } from "../../src/domain/auth";
import { createWorkerRoutes } from "../../src/server/routes/workers";

const TEST_USER_ID = "test-backups-admin";
const TEST_WORKER_ID = "test-backups-route-worker";

async function seedSuperAdmin() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, username, display_name, is_super_admin, status)
     VALUES ($1, 'backups-admin', 'Test Admin', true, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID],
  );
}

async function seedWorker() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token, current_image_tag)
     VALUES ($1, 'backups-host', 'approved', 'test-token-backups', '0.7.5')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKER_ID],
  );
}

async function cleanupFixture() {
  const pool = getPool();
  await pool.query(`DELETE FROM worker_backups WHERE worker_id = $1`, [TEST_WORKER_ID]);
  await pool.query(`DELETE FROM workers WHERE id = $1`, [TEST_WORKER_ID]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/workers", createWorkerRoutes());
  return app;
}

describe("GET /api/v1/workers/:id/backups", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedSuperAdmin();
    await seedWorker();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("super_admin JWT returns backups list (empty)", async () => {
    const { access_token } = issueTokenPair(TEST_USER_ID);
    const app = buildApp();
    const res = await app.request(`/api/v1/workers/${TEST_WORKER_ID}/backups`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  test("missing JWT returns 401", async () => {
    const app = buildApp();
    const res = await app.request(`/api/v1/workers/${TEST_WORKER_ID}/backups`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/workers/:id/backups", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedSuperAdmin();
    await seedWorker();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("creates manual backup record with 201", async () => {
    const { access_token } = issueTokenPair(TEST_USER_ID);
    const app = buildApp();
    const res = await app.request(`/api/v1/workers/${TEST_WORKER_ID}/backups`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ backup_type: "manual" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^bkp_/);
    expect(body.worker_id).toBe(TEST_WORKER_ID);
    expect(body.backup_type).toBe("manual");
    expect(body.from_tag).toBe("0.7.5");
  });

  test("returns 404 for unknown worker", async () => {
    const { access_token } = issueTokenPair(TEST_USER_ID);
    const app = buildApp();
    const res = await app.request(`/api/v1/workers/nonexistent/backups`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/workers/:id/backups/:backupId", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedSuperAdmin();
    await seedWorker();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("deletes own worker's backup", async () => {
    // Seed a backup via the POST endpoint
    const { access_token } = issueTokenPair(TEST_USER_ID);
    const app = buildApp();
    const createRes = await app.request(`/api/v1/workers/${TEST_WORKER_ID}/backups`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const created = await createRes.json();

    const delRes = await app.request(
      `/api/v1/workers/${TEST_WORKER_ID}/backups/${created.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${access_token}` },
      },
    );
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.ok).toBe(true);
  });

  test("returns 404 for unknown backup", async () => {
    const { access_token } = issueTokenPair(TEST_USER_ID);
    const app = buildApp();
    const res = await app.request(
      `/api/v1/workers/${TEST_WORKER_ID}/backups/bkp_nonexistent`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${access_token}` },
      },
    );
    expect(res.status).toBe(404);
  });
});
