// deepanalyze-hub/tests/domain/host-server.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { HostServerRepo } from "../../src/domain/host-server";
import { getPool } from "../../src/store/pg";

describe("HostServerRepo", () => {
  const repo = new HostServerRepo(() => getPool());

  test("create + getById roundtrip", async () => {
    const hs = await repo.create({
      hostname: "test-probe-01",
      ssh_target_host: "10.0.0.1",
      ssh_target_port: 22,
      ssh_user: "root",
      port_range_start: 21000,
      port_range_end: 21099,
      port_block_size: 10,
    });
    expect(hs.id).toMatch(/^hst_/);
    expect(hs.hostname).toBe("test-probe-01");

    const got = await repo.getById(hs.id);
    expect(got?.hostname).toBe("test-probe-01");

    await repo.delete(hs.id);
  });

  test("list filters by status", async () => {
    const hs = await repo.create({ hostname: "test-list-1", ssh_target_host: "1.1.1.1" });
    const list = await repo.list({ status: "active" });
    expect(list.find((h) => h.id === hs.id)).toBeDefined();
    await repo.delete(hs.id);
  });

  test("hostname unique constraint", async () => {
    const hs = await repo.create({ hostname: "dup-1", ssh_target_host: "1.1.1.1" });
    await expect(repo.create({ hostname: "dup-1", ssh_target_host: "2.2.2.2" }))
      .rejects.toThrow();
    await repo.delete(hs.id);
  });
});
