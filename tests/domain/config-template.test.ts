import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  deepMerge,
  upsertGlobalTemplate,
  upsertOrgTemplate,
  getMergedTemplate,
  getHistory,
} from "../../src/domain/config-template";
import { getPool } from "../../src/store/pg";

// ─── Inline fixtures (T08 pattern) ─────────────────────────────────────────

async function seedOrgAndUser(label: string): Promise<{ orgId: string; userId: string }> {
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
    `INSERT INTO users (id, username, display_name, organization_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [userId, userId, `Test User ${label}`, orgId],
  );
  return { orgId, userId };
}

async function cleanupOrgAndUser(label: string): Promise<void> {
  const pool = getPool();
  const orgId = `org_test_${label}`;
  const userId = `usr_test_${label}`;
  // Clean config_template_history + config_templates first (FK to users/orgs)
  await pool.query(`DELETE FROM config_template_history WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM config_template_history WHERE scope = 'global'`);
  await pool.query(`DELETE FROM config_templates WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM config_templates WHERE scope = 'global'`);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("deepMerge", () => {
  test("对象递归、数组替换、null 删除字段", () => {
    const merged = deepMerge(
      { a: 1, b: { x: 1, y: 2 }, c: [1, 2, 3] },
      { b: { y: 99, z: 3 }, c: [4, 5], d: null },
    );
    expect(merged).toEqual({ a: 1, b: { x: 1, y: 99, z: 3 }, c: [4, 5] });
  });

  test("lockedPaths 取并集（全局锁定不能被组织解锁）", () => {
    const merged = deepMerge(
      { fieldLocks: { lockedPaths: ["main.provider", "moduleStates.mineru"] } },
      { fieldLocks: { lockedPaths: ["main.provider", "embeddings.model"] } },
    );
    expect((merged as any).fieldLocks.lockedPaths.sort()).toEqual(
      ["embeddings.model", "main.provider", "moduleStates.mineru"],
    );
  });

  test("基线是空对象时直接返回 override（删除字段是 no-op）", () => {
    const merged = deepMerge({}, { a: 1, b: null });
    expect(merged).toEqual({ a: 1 });
  });
});

describe("config-template domain", () => {
  test("upsertGlobalTemplate + getMergedTemplate（无组织）", async () => {
    const label = "ct-global";
    const f = await seedOrgAndUser(label);
    try {
      await upsertGlobalTemplate(() => getPool(), {
        content: { main: { provider: "openai" }, embeddings: { model: "bge-m3" } } as any,
        updatedBy: f.userId,
      });
      const merged = await getMergedTemplate(() => getPool(), { workerId: null });
      expect((merged as any).main.provider).toBe("openai");
      expect((merged as any).embeddings.model).toBe("bge-m3");
    } finally {
      await cleanupOrgAndUser(label);
    }
  });

  test("upsertOrgTemplate override 覆盖全局（仅 override 字段）", async () => {
    const label = "ct-org";
    const f = await seedOrgAndUser(label);
    try {
      await upsertGlobalTemplate(() => getPool(), {
        content: { main: { provider: "openai", model: "gpt-4" } } as any,
        updatedBy: f.userId,
      });
      await upsertOrgTemplate(() => getPool(), {
        orgId: f.orgId,
        content: { main: { provider: "deepseek" } } as any,  // override provider only
        updatedBy: f.userId,
      });
      const merged = await getMergedTemplate(() => getPool(), {
        workerId: null,
        orgId: f.orgId,
      });
      expect((merged as any).main.provider).toBe("deepseek");  // overridden
      expect((merged as any).main.model).toBe("gpt-4");         // preserved from global
    } finally {
      await cleanupOrgAndUser(label);
    }
  });

  test("getMergedTemplate 用 workerId 反查 organization_id", async () => {
    const label = "ct-worker";
    const f = await seedOrgAndUser(label);
    const pool = getPool();
    const workerId = `wkr_test_${label}`;
    try {
      // Seed a worker assigned to the user (so workerId → user → org resolution works)
      const hostId = `hst_test_${label}`;
      await pool.query(
        `INSERT INTO host_servers (id, hostname, ssh_target_host, status)
         VALUES ($1, $2, '127.0.0.1', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [hostId, `host-${label}`],
      );
      await pool.query(
        `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port, assigned_user_id)
         VALUES ($1, $2, 'approved', $3, $4, 21000, $5)
         ON CONFLICT (id) DO NOTHING`,
        [workerId, `worker-${label}`, `wkt_${label}_${randomUUID().replace(/-/g, "")}`,
         hostId, f.userId],
      );

      await upsertGlobalTemplate(() => getPool(), {
        content: { main: { provider: "openai" } } as any,
        updatedBy: f.userId,
      });
      await upsertOrgTemplate(() => getPool(), {
        orgId: f.orgId,
        content: { main: { provider: "anthropic" } } as any,
        updatedBy: f.userId,
      });

      // Pass workerId only (no orgId) — domain should resolve via DB
      const merged = await getMergedTemplate(() => getPool(), { workerId });
      expect((merged as any).main.provider).toBe("anthropic");  // org override wins
    } finally {
      await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
      await pool.query(`DELETE FROM host_servers WHERE id = $1`,
        [`hst_test_${label}`]);
      await cleanupOrgAndUser(label);
    }
  });

  test("upsertGlobalTemplate 多次调用递增 version + 写历史", async () => {
    const label = "ct-history";
    const f = await seedOrgAndUser(label);
    try {
      await upsertGlobalTemplate(() => getPool(), {
        content: { main: { provider: "openai" } } as any,
        updatedBy: f.userId,
      });
      await upsertGlobalTemplate(() => getPool(), {
        content: { main: { provider: "deepseek" } } as any,
        updatedBy: f.userId,
      });

      const pool = getPool();
      const { rows: tmplRows } = await pool.query(
        `SELECT version FROM config_templates WHERE id = 'tmpl_global'`,
      );
      expect(tmplRows[0].version).toBe(2);

      const history = await getHistory(() => getPool(), { scope: "global" }, 10);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].version).toBeGreaterThan(history[1].version);
    } finally {
      await cleanupOrgAndUser(label);
    }
  });
});
