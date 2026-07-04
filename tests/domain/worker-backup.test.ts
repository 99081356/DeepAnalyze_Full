// tests/domain/worker-backup.test.ts
//
// T19: worker-backup domain 测试
// 覆盖：createBackupRecord / updateBackupStatus / listBackups / getBackup / deleteBackup
//
// Pattern: inline seedFixture + cleanupFixture (T12/T18 风格)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getPool } from "../../src/store/pg";
import {
  createBackupRecord,
  updateBackupStatus,
  listBackups,
  getBackup,
  deleteBackup,
} from "../../src/domain/worker-backup";

const TEST_WORKER_ID = "test-backup-worker";
const TEST_USER_ID = "test-backup-admin";

async function seedFixture() {
  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, username, display_name, is_super_admin, status)
     VALUES ($1, 'backup-admin', 'Test Admin', true, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID],
  );
  await pool.query(
    `INSERT INTO workers (id, hostname, status, worker_token, current_image_tag)
     VALUES ($1, 'backup-host', 'approved', 'test-token-backup', '0.7.5')
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

describe("worker-backup domain", () => {
  beforeEach(async () => {
    await cleanupFixture();
    await seedFixture();
  });
  afterEach(async () => {
    await cleanupFixture();
  });

  test("createBackupRecord inserts row with defaults", async () => {
    const backup = await createBackupRecord(getPool, {
      workerId: TEST_WORKER_ID,
      backupType: "pre_upgrade",
      fromTag: "0.7.5",
      toTag: "0.7.6",
      createdBy: TEST_USER_ID,
    });
    expect(backup.id).toMatch(/^bkp_/);
    expect(backup.worker_id).toBe(TEST_WORKER_ID);
    expect(backup.status).toBe("created");
    expect(backup.from_tag).toBe("0.7.5");
    expect(backup.to_tag).toBe("0.7.6");
    expect(backup.expires_at).toBeDefined();
  });

  test("updateBackupStatus transitions created → verified", async () => {
    const created = await createBackupRecord(getPool, {
      workerId: TEST_WORKER_ID,
      backupType: "pre_upgrade",
      createdBy: TEST_USER_ID,
    });
    const updated = await updateBackupStatus(getPool, created.id, "verified", 12345);
    expect(updated?.status).toBe("verified");
    expect(updated?.size_bytes).toBe(12345);
  });

  test("updateBackupStatus transitions created → failed", async () => {
    const created = await createBackupRecord(getPool, {
      workerId: TEST_WORKER_ID,
      backupType: "pre_upgrade",
      createdBy: TEST_USER_ID,
    });
    const updated = await updateBackupStatus(getPool, created.id, "failed");
    expect(updated?.status).toBe("failed");
  });

  test("listBackups returns DESC by created_at", async () => {
    const a = await createBackupRecord(getPool, {
      workerId: TEST_WORKER_ID, backupType: "manual", createdBy: TEST_USER_ID,
    });
    // tiny sleep to ensure different created_at
    await new Promise((r) => setTimeout(r, 50));
    const b = await createBackupRecord(getPool, {
      workerId: TEST_WORKER_ID, backupType: "manual", createdBy: TEST_USER_ID,
    });
    const list = await listBackups(getPool, TEST_WORKER_ID);
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(b.id);  // newer first
    expect(list[1].id).toBe(a.id);
  });

  test("getBackup returns null for unknown id", async () => {
    const result = await getBackup(getPool, "bkp_nonexistent");
    expect(result).toBeNull();
  });

  test("deleteBackup returns true on success, false on missing", async () => {
    const backup = await createBackupRecord(getPool, {
      workerId: TEST_WORKER_ID, backupType: "manual", createdBy: TEST_USER_ID,
    });
    const ok = await deleteBackup(getPool, backup.id);
    expect(ok).toBe(true);
    const second = await deleteBackup(getPool, backup.id);
    expect(second).toBe(false);
  });

  test("expires_at defaults to 30 days", async () => {
    const backup = await createBackupRecord(getPool, {
      workerId: TEST_WORKER_ID, backupType: "manual", createdBy: TEST_USER_ID,
    });
    const expires = new Date(backup.expires_at).getTime();
    const created = new Date(backup.created_at).getTime();
    const days = (expires - created) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThanOrEqual(29.9);
    expect(days).toBeLessThanOrEqual(30.1);
  });
});
