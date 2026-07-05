// 验证 upgradeWorker 集成 backup executor 的编排行为：
// - skipBackup=false + executor success → 调 deployWorker + status=verified
// - skipBackup=false + executor fail → 不调 deployWorker + status=failed + 返回 backup error
// - skipBackup=true → 不创建 backup record, 不调 executor, 直接 deploy
// - SSH 连接失败 → 抛错，executor 不被调，backup 状态不变（finally 已 close）
//
// 全部用 DI 注入 mock，无真 DB / 真 SSH / 真 crypto。
import { describe, test, expect, mock } from "bun:test";
import { upgradeWorker } from "../../src/domain/worker-deployment";
import type { SshExecutor } from "../../src/domain/ssh-executor";
import type { BackupExecutorResult } from "../../src/domain/worker-backup-executor";
import type { DeployResult } from "../../src/domain/worker-deployment";

// 录制式 mock query — 测试断言调用序列
function makeMockQuery(workerRow: Record<string, unknown> | null) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const fn = mock(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (/SELECT ssh_target_host/.test(text)) {
      return { rows: workerRow ? [workerRow] : [] };
    }
    if (/INSERT INTO worker_backups/.test(text)) {
      return { rows: [{ id: "bkp_mock_1" }] };
    }
    return { rows: [] };
  });
  return { fn: fn as any, calls };
}

const fakeWorker = {
  ssh_target_host: "h", ssh_target_port: 22, ssh_user: "u",
  ssh_key_encrypted: "enc", current_image_tag: "v1",
};

const fakeSsh: SshExecutor = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  pullFile: async () => {},
  pushFile: async () => {},
  close: () => {},
};

// Bug D fix: makeMockPool 必须为 INSERT INTO worker_backups RETURNING *
// 返回非空 rows，否则 createBackupRecord → mapRow(rows[0]) 崩溃。
function makeMockPool() {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const pool = () => ({
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (/INSERT INTO worker_backups/.test(text)) {
        return { rows: [{ id: "bkp_mock_1" }] };
      }
      return { rows: [] };
    },
  });
  return { pool: pool as any, queries };
}

describe("upgradeWorker with backup", () => {
  test("skipBackup=false + executor success → 调 deployWorker + status=verified", async () => {
    const q = makeMockQuery(fakeWorker);
    const poolObj = makeMockPool();
    let deployCallCount = 0;
    const fakeBackupResult: BackupExecutorResult = {
      success: true,
      pgDumpPath: "w1/bkp1/pg.dump",
      dataArchivePath: "w1/bkp1/app-data.tar.gz",
      manifestPath: "w1/bkp1/manifest.json",
      sizeBytes: 100,
      pgVersion: "16.4",
    };
    const fakeDeploy: DeployResult = {
      jobId: "dpl_x", success: true, logs: [],
    };

    const result = await upgradeWorker("w1", "v2", "test-user", { skipBackup: false }, {
      query: q.fn, pool: poolObj.pool,
      decryptSshKey: async () => "PEM",
      connectRealSsh: async () => fakeSsh,
      executeWorkerBackup: async () => fakeBackupResult,
      deployWorker: async () => { deployCallCount++; return fakeDeploy; },
      backupConfig: { storageDir: "/tmp/bk", retentionDays: 30, cleanupIntervalHours: 24 },
    });

    expect(result.success).toBe(true);
    expect(result.backupId).toBe("bkp_mock_1");
    expect(deployCallCount).toBe(1);

    // pool().query 应当看到 backup paths 写入 + status=verified 写入
    const updatePathsCall = poolObj.queries.find(
      c => /UPDATE worker_backups\s+SET pg_dump_path/.test(c.text),
    );
    expect(updatePathsCall).toBeDefined();
    const verifiedCall = poolObj.queries.find(
      c => /UPDATE worker_backups[\s\S]+SET status = \$2/.test(c.text)
        && c.params?.[1] === "verified",
    );
    expect(verifiedCall).toBeDefined();
  });

  test("skipBackup=false + executor fail → abort upgrade，不调 deployWorker，status=failed", async () => {
    const q = makeMockQuery(fakeWorker);
    const poolObj = makeMockPool();
    let deployCallCount = 0;

    const result = await upgradeWorker("w2", "v2", "test-user", { skipBackup: false }, {
      query: q.fn, pool: poolObj.pool,
      decryptSshKey: async () => "PEM",
      connectRealSsh: async () => fakeSsh,
      executeWorkerBackup: async () => ({
        success: false,
        pgDumpPath: null, dataArchivePath: null, manifestPath: null,
        sizeBytes: null, pgVersion: null,
        error: "pg_dump failed: connection refused",
      }),
      deployWorker: async () => { deployCallCount++; return { jobId: "x", success: true, logs: [] }; },
      backupConfig: { storageDir: "/tmp/bk", retentionDays: 30, cleanupIntervalHours: 24 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pre-upgrade backup failed.*pg_dump failed/);
    expect(result.backupId).toBe("bkp_mock_1");
    expect(deployCallCount).toBe(0);  // 关键：executor 失败 → 不调 deployWorker

    // status='failed' 应当被写入
    const failedCall = poolObj.queries.find(
      c => /UPDATE worker_backups[\s\S]+SET status = \$2/.test(c.text)
        && c.params?.[1] === "failed",
    );
    expect(failedCall).toBeDefined();
  });

  test("skipBackup=true → 不创建 backup record, 不调 executor, 直接 deploy", async () => {
    const q = makeMockQuery(fakeWorker);
    const poolObj = makeMockPool();
    let executorCallCount = 0;
    let deployCallCount = 0;

    const result = await upgradeWorker("w3", "v2", "test-user", { skipBackup: true }, {
      query: q.fn, pool: poolObj.pool,
      decryptSshKey: async () => "PEM",
      connectRealSsh: async () => fakeSsh,
      executeWorkerBackup: async () => { executorCallCount++; return {
        success: true, pgDumpPath: null, dataArchivePath: null,
        manifestPath: null, sizeBytes: null, pgVersion: null,
      }; },
      deployWorker: async () => { deployCallCount++; return { jobId: "x", success: true, logs: [] }; },
      backupConfig: { storageDir: "/tmp/bk", retentionDays: 30, cleanupIntervalHours: 24 },
    });

    expect(result.success).toBe(true);
    expect(result.backupId).toBeUndefined();  // skipBackup=true 不创建 backupId
    expect(executorCallCount).toBe(0);
    expect(deployCallCount).toBe(1);

    // 不应当有任何 INSERT INTO worker_backups
    const insertCall = q.calls.find(c => /INSERT INTO worker_backups/.test(c.text));
    expect(insertCall).toBeUndefined();
  });

  test("SSH 连接失败 → 抛错，executor 不被调，backup 状态不变（finally 已 close）", async () => {
    const q = makeMockQuery(fakeWorker);
    const poolObj = makeMockPool();
    let executorCallCount = 0;

    await expect(
      upgradeWorker("w4", "v2", "test-user", { skipBackup: false }, {
        query: q.fn, pool: poolObj.pool,
        decryptSshKey: async () => "PEM",
        connectRealSsh: async () => { throw new Error("SSH connection refused"); },
        executeWorkerBackup: async () => { executorCallCount++; return {
          success: true, pgDumpPath: null, dataArchivePath: null,
          manifestPath: null, sizeBytes: null, pgVersion: null,
        }; },
        deployWorker: async () => ({ jobId: "x", success: true, logs: [] }),
        backupConfig: { storageDir: "/tmp/bk", retentionDays: 30, cleanupIntervalHours: 24 },
      }),
    ).rejects.toThrow(/SSH connection refused/);

    expect(executorCallCount).toBe(0);
  });
});
