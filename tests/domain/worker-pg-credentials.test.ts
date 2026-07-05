import { describe, test, expect, beforeEach } from "bun:test";
import { query } from "../../src/store/pg";
import {
  generatePgCredentials,
  savePgCredentials,
  loadPgCredentials,
  ensurePgCredentials,
} from "../../src/domain/worker-pg-credentials";

// 用 fixture worker ID，前后清理
const TEST_WORKER_ID = "test-pg-cred-worker";

beforeEach(async () => {
  // 确保 fixture worker 存在（用 ON CONFLICT DO NOTHING）
  await query(
    `INSERT INTO workers (id, hostname, worker_token, status)
     VALUES ($1, 'test-host', 'test-token-pg-cred', 'pending')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKER_ID],
  );
  // 清空 PG 凭据字段
  await query(`UPDATE workers SET pg_password_encrypted = NULL WHERE id = $1`, [TEST_WORKER_ID]);
});

describe("generatePgCredentials", () => {
  test("返回默认 database / username + 32 字节随机密码", async () => {
    const c = await generatePgCredentials();
    expect(c.database).toBe("deepanalyze");
    expect(c.username).toBe("da");
    expect(c.password.length).toBeGreaterThanOrEqual(32);
    // base64 编码后是 ASCII
    expect(/^[A-Za-z0-9+/=]+$/.test(c.password)).toBe(true);
  });

  test("两次生成密码不同", async () => {
    const a = await generatePgCredentials();
    const b = await generatePgCredentials();
    expect(a.password).not.toBe(b.password);
  });
});

describe("savePgCredentials + loadPgCredentials", () => {
  test("save 后 load 返回相同明文（加密往返）", async () => {
    const creds = await generatePgCredentials();
    await savePgCredentials(TEST_WORKER_ID, creds);

    const loaded = await loadPgCredentials(TEST_WORKER_ID);
    expect(loaded.password).toBe(creds.password);
    expect(loaded.username).toBe(creds.username);
    expect(loaded.database).toBe(creds.database);
  });

  test("DB 存的是密文不是明文", async () => {
    const creds = await generatePgCredentials();
    await savePgCredentials(TEST_WORKER_ID, creds);

    const { rows } = await query<{ pg_password_encrypted: string | null }>(
      `SELECT pg_password_encrypted FROM workers WHERE id = $1`,
      [TEST_WORKER_ID],
    );
    expect(rows[0].pg_password_encrypted).not.toBeNull();
    expect(rows[0].pg_password_encrypted).not.toContain(creds.password);
  });
});

describe("ensurePgCredentials", () => {
  test("无凭据时生成 + 入库", async () => {
    const c = await ensurePgCredentials(TEST_WORKER_ID);
    expect(c.password.length).toBeGreaterThanOrEqual(32);

    const again = await ensurePgCredentials(TEST_WORKER_ID);
    expect(again.password).toBe(c.password);  // 幂等
  });

  test("有凭据时不重新生成（幂等）", async () => {
    const first = await ensurePgCredentials(TEST_WORKER_ID);
    const second = await ensurePgCredentials(TEST_WORKER_ID);
    expect(second.password).toBe(first.password);
  });
});
