import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createConfigTemplateRoutes } from "../../src/server/routes/config-templates";
import { issueTokenPair } from "../../src/domain/auth";
import { getPool } from "../../src/store/pg";

// ─── Inline fixtures (T08/T09/T11 pattern) ────────────────────────────────

async function seedSuperAdmin(label: string): Promise<{ userId: string; orgId: string }> {
  const pool = getPool();
  const orgId = `org_test_${label}`;
  const userId = `usr_test_${label}`;
  await pool.query(
    `INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
     VALUES ($1, $2, $2, NULL, 0, $1, 'root', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [orgId, `Test Org ${label}`],
  );
  await pool.query(
    `INSERT INTO users (id, username, display_name, organization_id, status, is_super_admin)
     VALUES ($1, $2, $3, $4, 'active', true)
     ON CONFLICT (id) DO NOTHING`,
    [userId, userId, `SuperAdmin ${label}`, orgId],
  );
  return { userId, orgId };
}

async function seedOrgAdmin(label: string): Promise<{ userId: string; orgId: string }> {
  const pool = getPool();
  const orgId = `org_test_${label}`;
  const userId = `usr_test_${label}`;
  await pool.query(
    `INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
     VALUES ($1, $2, $2, NULL, 0, $1, 'root', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [orgId, `Test Org ${label}`],
  );
  await pool.query(
    `INSERT INTO users (id, username, display_name, organization_id, status, is_org_admin)
     VALUES ($1, $2, $3, $4, 'active', true)
     ON CONFLICT (id) DO NOTHING`,
    [userId, userId, `OrgAdmin ${label}`, orgId],
  );
  // Attach role_org_admin so user_permissions includes config_template:* via migration 033 grants
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'role_org_admin')
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  return { userId, orgId };
}

async function seedWorker(
  label: string,
  workerToken: string,
): Promise<{
  workerId: string;
  workerToken: string;
  userId: string;
  orgId: string;
  hostServerId: string;
}> {
  // First seed an org_admin (so worker is assigned to a user with an org)
  const f = await seedOrgAdmin(label);
  const pool = getPool();
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  await pool.query(
    `INSERT INTO host_servers (id, hostname, ssh_target_host, status)
     VALUES ($1, $2, '127.0.0.1', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [hostServerId, `host-${label}`],
  );
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port, assigned_user_id)
     VALUES ($1, $2, 'approved', $3, $4, 21000, $5)
     ON CONFLICT (id) DO NOTHING`,
    [workerId, `worker-${label}`, workerToken, hostServerId, f.userId],
  );
  return { workerId, workerToken, userId: f.userId, orgId: f.orgId, hostServerId };
}

async function cleanupFixture(label: string): Promise<void> {
  const pool = getPool();
  const orgId = `org_test_${label}`;
  const userId = `usr_test_${label}`;
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  await pool.query(`DELETE FROM config_template_history WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM config_template_history WHERE scope = 'global'`);
  await pool.query(`DELETE FROM config_templates WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM config_templates WHERE scope = 'global'`);
  await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  await pool.query(`DELETE FROM host_servers WHERE id = $1`, [hostServerId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/config-templates", createConfigTemplateRoutes());
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GET/PUT /global", () => {
  test("super_admin 可写 + 读 global 模板", async () => {
    const label = "ct-route-global";
    const f = await seedSuperAdmin(label);
    try {
      const app = buildApp();
      const { access_token } = issueTokenPair(f.userId);

      const putRes = await app.request("/api/v1/config-templates/global", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ content: { main: { provider: "openai" } } }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await app.request("/api/v1/config-templates/global", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      expect(getRes.status).toBe(200);
      const body = await getRes.json();
      expect(body.content).toEqual({ main: { provider: "openai" } });
    } finally {
      await cleanupFixture(label);
    }
  });

  test("org_admin 不能写 global（即使有 config_template:manage 权限）", async () => {
    const label = "ct-route-global-deny";
    const f = await seedOrgAdmin(label);
    try {
      const app = buildApp();
      const { access_token } = issueTokenPair(f.userId);
      const res = await app.request("/api/v1/config-templates/global", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ content: { main: { provider: "openai" } } }),
      });
      expect(res.status).toBe(403);
    } finally {
      await cleanupFixture(label);
    }
  });
});

describe("GET/PUT /orgs/:orgId", () => {
  test("org_admin 可写自己组织模板", async () => {
    const label = "ct-route-org-self";
    const f = await seedOrgAdmin(label);
    try {
      const app = buildApp();
      const { access_token } = issueTokenPair(f.userId);
      const res = await app.request(`/api/v1/config-templates/orgs/${f.orgId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ content: { main: { provider: "deepseek" } } }),
      });
      expect(res.status).toBe(200);
    } finally {
      await cleanupFixture(label);
    }
  });

  test("org_admin 写别的组织 403", async () => {
    const label1 = "ct-route-org-x1";
    const label2 = "ct-route-org-x2";
    const f1 = await seedOrgAdmin(label1);
    const f2org = `org_test_${label2}`;
    try {
      // Seed f2 org (no admin needed; just the org to target)
      const pool = getPool();
      await pool.query(
        `INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
         VALUES ($1, $2, $2, NULL, 0, $1, 'root', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [f2org, `Test Org ${label2}`],
      );

      const app = buildApp();
      const { access_token } = issueTokenPair(f1.userId);
      const res = await app.request(`/api/v1/config-templates/orgs/${f2org}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ content: {} }),
      });
      expect(res.status).toBe(403);
    } finally {
      await cleanupFixture(label1);
      const pool = getPool();
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [f2org]);
    }
  });
});

describe("GET /merged", () => {
  test("super_admin 拿到合并内容（无 orgId → 仅 global）", async () => {
    const label = "ct-route-merged";
    const f = await seedSuperAdmin(label);
    try {
      const app = buildApp();
      const { access_token } = issueTokenPair(f.userId);

      // Seed global first
      await app.request("/api/v1/config-templates/global", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ content: { main: { provider: "openai" } } }),
      });

      const res = await app.request("/api/v1/config-templates/merged", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content.main.provider).toBe("openai");
    } finally {
      await cleanupFixture(label);
    }
  });
});

describe("GET /by-worker/merged", () => {
  test("DA worker 用 worker_token 拿到合并内容", async () => {
    const label = "ct-route-worker";
    const workerToken = `wkt_${label}_${randomUUID().replace(/-/g, "")}`;
    const f = await seedWorker(label, workerToken);
    try {
      const app = buildApp();

      // Seed a global template first (as super_admin)
      const adminLabel = `${label}-admin`;
      const admin = await seedSuperAdmin(adminLabel);
      try {
        const adminToken = issueTokenPair(admin.userId).access_token;
        await app.request("/api/v1/config-templates/global", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ content: { main: { provider: "openai" } } }),
        });
      } finally {
        // Don't clean up admin yet — global template must persist for worker test
        // (will be cleaned in the outer finally via the global-scope DELETE)
      }

      // Worker calls /by-worker/merged with worker_token
      const res = await app.request("/api/v1/config-templates/by-worker/merged", {
        headers: { Authorization: `Bearer ${workerToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content.main.provider).toBe("openai");

      // Cleanup admin user/org at the end
      await cleanupFixture(adminLabel);
    } finally {
      await cleanupFixture(label);
    }
  });

  test("无效 worker_token 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/config-templates/by-worker/merged", {
      headers: { Authorization: "Bearer wkt_invalid_xxx" },
    });
    expect(res.status).toBe(401);
  });

  test("无 Authorization 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/config-templates/by-worker/merged");
    expect(res.status).toBe(401);
  });
});

describe("Auth boundary", () => {
  test("未登录 401 (GET /global)", async () => {
    const app = buildApp();
    const res = await app.request("/api/v1/config-templates/global");
    expect(res.status).toBe(401);
  });
});
