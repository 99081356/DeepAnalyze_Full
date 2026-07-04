// tests/domain/worker-heartbeat.test.ts
//
// T18: worker-heartbeat domain 测试
// 覆盖：computeStatus / recordHeartbeat / getHealthHistory / getOverview
//
// Pattern: inline seedFixture + cleanupFixture (T08/T12/T13 风格)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getPool } from "../../src/store/pg";
import {
  computeStatus,
  recordHeartbeat,
  getOverview,
  getHealthHistory,
} from "../../src/domain/worker-heartbeat";

const TEST_WORKER_ID = "wkr_test_whh_domain";

async function seedFixture() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token)
     VALUES ($1, 'test-host-whh', 'approved', 'test-token-whh-domain')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKER_ID],
  );
}

async function cleanupFixture() {
  const pool = getPool();
  await pool.query(`DELETE FROM worker_health_history WHERE worker_id = $1`, [
    TEST_WORKER_ID,
  ]);
  await pool.query(`DELETE FROM workers WHERE id = $1`, [TEST_WORKER_ID]);
}

// ─── computeStatus (pure function, no DB) ─────────────────────────────────

describe("computeStatus", () => {
  test("all healthy → healthy", () => {
    expect(
      computeStatus({ a: { status: "healthy" }, b: { status: "healthy" } }),
    ).toBe("healthy");
  });

  test("any degraded → degraded", () => {
    expect(
      computeStatus({ a: { status: "healthy" }, b: { status: "degraded" } }),
    ).toBe("degraded");
  });

  test("any down → down (overrides degraded)", () => {
    expect(
      computeStatus({ a: { status: "down" }, b: { status: "degraded" } }),
    ).toBe("down");
  });

  test("empty/undefined → healthy", () => {
    expect(computeStatus(undefined)).toBe("healthy");
    expect(computeStatus({})).toBe("healthy");
  });
});

// ─── recordHeartbeat + getHealthHistory (DB-backed) ───────────────────────

describe("recordHeartbeat + getHealthHistory", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedFixture();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("inserts history row + updates 4 worker columns", async () => {
    await recordHeartbeat(getPool, {
      workerId: TEST_WORKER_ID,
      daVersion: "0.7.6",
      uptime: 42,
      moduleHealth: {
        embedding: { status: "healthy" },
        pg: { status: "healthy" },
      },
    });

    const { rows } = await getPool().query(
      `SELECT last_heartbeat_at, last_heartbeat_ok, da_version, uptime_seconds
       FROM workers WHERE id = $1`,
      [TEST_WORKER_ID],
    );
    expect(rows[0].last_heartbeat_at).not.toBeNull();
    expect(rows[0].last_heartbeat_ok).toBe(true);
    expect(rows[0].da_version).toBe("0.7.6");
    expect(rows[0].uptime_seconds).toBe(42);

    const history = await getHealthHistory(getPool, TEST_WORKER_ID, 1);
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("healthy");
  });

  test("marks last_heartbeat_ok false on degraded", async () => {
    await recordHeartbeat(getPool, {
      workerId: TEST_WORKER_ID,
      moduleHealth: { mineru: { status: "down" } },
    });
    const { rows } = await getPool().query(
      `SELECT last_heartbeat_ok FROM workers WHERE id = $1`,
      [TEST_WORKER_ID],
    );
    expect(rows[0].last_heartbeat_ok).toBe(false);
  });
});

// ─── getOverview (DB-backed) ──────────────────────────────────────────────

describe("getOverview", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedFixture();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("worker with no heartbeat → unknown", async () => {
    const overview = await getOverview(getPool);
    const w = overview.workers.find((x) => x.id === TEST_WORKER_ID);
    expect(w?.health_status).toBe("unknown");
    expect(overview.unknown).toBeGreaterThanOrEqual(1);
  });

  test("worker with recent healthy heartbeat → online", async () => {
    await recordHeartbeat(getPool, {
      workerId: TEST_WORKER_ID,
      moduleHealth: { pg: { status: "healthy" } },
    });
    const overview = await getOverview(getPool);
    const w = overview.workers.find((x) => x.id === TEST_WORKER_ID);
    expect(w?.health_status).toBe("online");
  });
});
