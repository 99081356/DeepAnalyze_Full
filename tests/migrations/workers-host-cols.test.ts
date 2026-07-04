// deepanalyze-hub/tests/migrations/workers-host-cols.test.ts
// T04 smoke tests: verify migration 029 applied correctly + resolveHostServerSsh boundaries
import { describe, test, expect } from "bun:test";
import { query } from "../../src/store/pg";

describe("migration 029: workers host cols", () => {
  test("workers table has all 10 new columns", async () => {
    const { rows } = await query<{
      column_name: string; is_nullable: string; column_default: string | null;
    }>(`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'workers'
        AND column_name IN (
          'host_id', 'host_port', 'port_block_size', 'gpu_device',
          'decommissioned_at', 'labels',
          'last_heartbeat_at', 'last_heartbeat_ok', 'da_version', 'uptime_seconds'
        )
      ORDER BY column_name
    `);
    const names = rows.map((r) => r.column_name);
    // Should contain all 10 expected columns
    expect(names).toContain("host_id");
    expect(names).toContain("host_port");
    expect(names).toContain("port_block_size");
    expect(names).toContain("gpu_device");
    expect(names).toContain("decommissioned_at");
    expect(names).toContain("labels");
    expect(names).toContain("last_heartbeat_at");
    expect(names).toContain("last_heartbeat_ok");
    expect(names).toContain("da_version");
    expect(names).toContain("uptime_seconds");
  });

  test("host_id is nullable (向后兼容)", async () => {
    const { rows } = await query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'workers' AND column_name = 'host_id'`,
    );
    expect(rows[0]?.is_nullable).toBe("YES");
  });

  test("status CHECK constraint includes 'decommissioned'", async () => {
    const { rows } = await query<{ constraint_def: string }>(`
      SELECT pg_get_constraintdef(oid) AS constraint_def
      FROM pg_constraint
      WHERE conname = 'workers_status_check' AND conrelid = 'workers'::regclass
    `);
    expect(rows[0]?.constraint_def).toContain("decommissioned");
  });

  test("resolveHostServerSsh returns null for unknown id", async () => {
    const { resolveHostServerSsh } = await import("../../src/domain/worker-deployment");
    const result = await resolveHostServerSsh("hst_does_not_exist");
    expect(result).toBeNull();
  });

  test("resolveHostServerSsh returns null for inactive host", async () => {
    const { resolveHostServerSsh } = await import("../../src/domain/worker-deployment");
    const { rows: hsRows } = await query(
      `INSERT INTO host_servers (id, hostname, ssh_target_host, status)
       VALUES ('hst_test_inactive', 'test-inactive-t04', '1.1.1.1', 'maintenance')
       RETURNING id`,
    );
    const result = await resolveHostServerSsh(hsRows[0].id);
    expect(result).toBeNull();
    await query(`DELETE FROM host_servers WHERE id = $1`, [hsRows[0].id]);
  });
});
