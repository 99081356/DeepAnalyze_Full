import { describe, test, expect } from "bun:test";
import { createTicket, exchangeTicket } from "../../src/domain/sso-ticket";
import { getPool } from "../../src/store/pg";
import { randomUUID } from "node:crypto";

// Inline fixture: seed user + worker + host_server, return IDs for cleanup
async function seedFixture(label: string): Promise<{
  userId: string;
  workerId: string;
  workerToken: string;
  hostServerId: string;
}> {
  const pool = getPool();
  const orgId = `org_test_${label}`;
  const userId = `usr_test_${label}`;
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  const workerToken = `wkt_test_${label}_${randomUUID().replace(/-/g, "")}`;

  // Seed organization
  await pool.query(
    `INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
     VALUES ($1, $2, $2, NULL, 0, $1, 'root', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [orgId, `Test Org ${label}`],
  );
  // Seed user
  await pool.query(
    `INSERT INTO users (id, username, display_name, organization_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [userId, userId, `Test User ${label}`, orgId],
  );
  // Seed host_server
  await pool.query(
    `INSERT INTO host_servers (id, hostname, ssh_target_host, status)
     VALUES ($1, $2, '127.0.0.1', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [hostServerId, `test-host-${label}`],
  );
  // Seed worker — status='approved', with host_id + host_port
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port, assigned_user_id)
     VALUES ($1, $2, 'approved', $3, $4, 21000, $5)
     ON CONFLICT (id) DO NOTHING`,
    [workerId, `test-worker-${label}`, workerToken, hostServerId, userId],
  );

  return { userId, workerId, workerToken, hostServerId };
}

async function cleanupFixture(label: string): Promise<void> {
  const pool = getPool();
  const userId = `usr_test_${label}`;
  const hostServerId = `hst_test_${label}`;
  const workerId = `wkr_test_${label}`;
  const orgId = `org_test_${label}`;
  // Order matters for FK cleanliness
  await pool.query(`DELETE FROM sso_tickets WHERE user_id = $1 OR da_worker_id = $2`, [userId, workerId]);
  await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  await pool.query(`DELETE FROM host_servers WHERE id = $1`, [hostServerId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
}

describe("sso-ticket", () => {
  test("createTicket + exchangeTicket 正常流程", async () => {
    const f = await seedFixture("normal");
    try {
      const ticket = await createTicket(() => getPool(), {
        userId: f.userId,
        workerId: f.workerId,
      });
      expect(ticket.ticket).toMatch(/^sst_/);
      expect(ticket.redirect_url).toContain("/api/auth/sso/callback?hub_ticket=");
      expect(ticket.redirect_url).toContain("21000");

      const result = await exchangeTicket(() => getPool(), {
        ticket: ticket.ticket,
        daWorkerToken: f.workerToken,
      });
      expect(result.accessToken).toBeTruthy();
      expect(result.user.id).toBe(f.userId);
      expect(result.user.organization_id).toBe(`org_test_normal`);
    } finally {
      await cleanupFixture("normal");
    }
  });

  test("重复使用同 ticket 失败 (consumed)", async () => {
    const f = await seedFixture("replay");
    try {
      const t = await createTicket(() => getPool(), {
        userId: f.userId,
        workerId: f.workerId,
      });
      await exchangeTicket(() => getPool(), {
        ticket: t.ticket,
        daWorkerToken: f.workerToken,
      });
      await expect(
        exchangeTicket(() => getPool(), {
          ticket: t.ticket,
          daWorkerToken: f.workerToken,
        }),
      ).rejects.toThrow(/consumed/);
    } finally {
      await cleanupFixture("replay");
    }
  });

  test("过期 ticket 失败 (expired)", async () => {
    const f = await seedFixture("expire");
    const pool = getPool();
    try {
      // 直接插入一个已过期的 ticket
      await pool.query(
        `INSERT INTO sso_tickets (id, ticket, user_id, da_worker_id, expires_at)
         VALUES ('sst_test_expire_id', 'sst_expired_normal', $1, $2, now() - INTERVAL '1 hour')`,
        [f.userId, f.workerId],
      );
      await expect(
        exchangeTicket(() => pool, {
          ticket: "sst_expired_normal",
          daWorkerToken: f.workerToken,
        }),
      ).rejects.toThrow(/expired/);
    } finally {
      await cleanupFixture("expire");
    }
  });

  test("跨 worker token 失败 (mismatch)", async () => {
    const f1 = await seedFixture("cross1");
    const f2 = await seedFixture("cross2");
    try {
      const t = await createTicket(() => getPool(), {
        userId: f1.userId,
        workerId: f1.workerId,
      });
      await expect(
        exchangeTicket(() => getPool(), {
          ticket: t.ticket,
          daWorkerToken: f2.workerToken,
        }),
      ).rejects.toThrow(/mismatch|worker/);
    } finally {
      await cleanupFixture("cross1");
      await cleanupFixture("cross2");
    }
  });

  test("createTicket 拒绝非 approved worker", async () => {
    const f = await seedFixture("pending");
    const pool = getPool();
    try {
      // 把 worker 改成 pending
      await pool.query(`UPDATE workers SET status = 'pending' WHERE id = $1`, [f.workerId]);
      await expect(
        createTicket(() => pool, {
          userId: f.userId,
          workerId: f.workerId,
        }),
      ).rejects.toThrow(/approved|not assigned/);
    } finally {
      await cleanupFixture("pending");
    }
  });
});
