// deepanalyze-hub/tests/domain/port-allocation.test.ts
import { describe, test, expect } from "bun:test";
import { allocatePortBlock, getPortUsage } from "../../src/domain/port-allocation";
import { getPool } from "../../src/store/pg";
import { HostServerRepo } from "../../src/domain/host-server";

// Helper to clean up test rows by id
async function cleanupWorkerAndHost(workerId: string, hostId: string): Promise<void> {
  const pool = getPool();
  if (workerId) {
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  }
  await pool.query(`DELETE FROM host_servers WHERE id = $1`, [hostId]);
}

describe("allocatePortBlock", () => {
  test("空 host 返回最小 base_port=21000", async () => {
    const pool = getPool();
    const repo = new HostServerRepo(() => pool);
    const hs = await repo.create({
      hostname: "test-port-alloc-empty-t03",
      ssh_target_host: "1.1.1.1",
      port_range_start: 21000,
      port_range_end: 21099,
      port_block_size: 10,
    });
    try {
      const base = await allocatePortBlock(() => pool, hs.id);
      expect(base).toBe(21000);
    } finally {
      await cleanupWorkerAndHost("", hs.id);
    }
  });

  test("已有 21000 占用时返回 21011", async () => {
    const pool = getPool();
    const repo = new HostServerRepo(() => pool);
    const hs = await repo.create({
      hostname: "test-port-alloc-used-t03",
      ssh_target_host: "1.1.1.1",
    });
    try {
      // 占用 21000 段（status='approved' 是活跃状态，应该被排除）
      await pool.query(
        `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port)
         VALUES ('wk_test_t03_used', 'test-t03-used', 'approved', 'tok_t03_used', $1, 21000)`,
        [hs.id],
      );
      const base = await allocatePortBlock(() => pool, hs.id);
      // block_size=10 → 候选 base 为 21000, 21010, 21020 ...（host_port + offset 0-6 即 7 个容器端口）
      expect(base).toBe(21010);
    } finally {
      await cleanupWorkerAndHost("wk_test_t03_used", hs.id);
    }
  });

  test("端口段耗尽返回 null", async () => {
    const pool = getPool();
    const repo = new HostServerRepo(() => pool);
    const hs = await repo.create({
      hostname: "test-port-alloc-full-t03",
      ssh_target_host: "1.1.1.1",
      port_range_start: 21000,
      port_range_end: 21009, // 只能容 1 个 worker (block_size=10, range=10)
      port_block_size: 10,
    });
    try {
      await pool.query(
        `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port)
         VALUES ('wk_test_t03_full', 'test-t03-full', 'approved', 'tok_t03_full', $1, 21000)`,
        [hs.id],
      );
      const base = await allocatePortBlock(() => pool, hs.id);
      expect(base).toBeNull();
    } finally {
      await cleanupWorkerAndHost("wk_test_t03_full", hs.id);
    }
  });

  test("decommissioned worker 不占用端口段", async () => {
    const pool = getPool();
    const repo = new HostServerRepo(() => pool);
    const hs = await repo.create({
      hostname: "test-port-alloc-decomm-t03",
      ssh_target_host: "1.1.1.1",
      port_range_start: 21000,
      port_range_end: 21009,
      port_block_size: 10,
    });
    try {
      await pool.query(
        `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port)
         VALUES ('wk_test_t03_decomm', 'test-t03-decomm', 'decommissioned', 'tok_t03_decomm', $1, 21000)`,
        [hs.id],
      );
      const base = await allocatePortBlock(() => pool, hs.id);
      expect(base).toBe(21000); // decommissioned 不算占用
    } finally {
      await cleanupWorkerAndHost("wk_test_t03_decomm", hs.id);
    }
  });
});

describe("getPortUsage", () => {
  test("返回所有端口段及占用情况", async () => {
    const pool = getPool();
    const repo = new HostServerRepo(() => pool);
    const hs = await repo.create({
      hostname: "test-port-usage-t03",
      ssh_target_host: "1.1.1.1",
      port_range_start: 21000,
      port_range_end: 21019,
      port_block_size: 10,
    });
    try {
      // 占用 21000 段
      await pool.query(
        `INSERT INTO workers (id, hostname, status, worker_token, host_id, host_port)
         VALUES ('wk_test_t03_usage', 'test-t03-usage', 'approved', 'tok_t03_usage', $1, 21000)`,
        [hs.id],
      );
      const usage = await getPortUsage(() => pool, hs.id);
      expect(usage).toHaveLength(2); // 2 个端口段
      expect(usage[0].base_port).toBe(21000);
      expect(usage[0].worker_id).toBe("wk_test_t03_usage");
      expect(usage[1].base_port).toBe(21010);
      expect(usage[1].worker_id).toBeNull(); // 空闲
    } finally {
      await cleanupWorkerAndHost("wk_test_t03_usage", hs.id);
    }
  });
});
