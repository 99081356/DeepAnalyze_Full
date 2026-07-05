import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockSshExecutor } from "../../src/domain/ssh-executor";
import { executeWorkerBackup, type BackupExecutorOpts } from "../../src/domain/worker-backup-executor";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "backup-exec-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// Helper: 测试用 createWriteStream mock — 写到 tempDir 下，不是真 SFTP
function makeMockCreateWriteStream() {
  const { createWriteStream: realCreateWriteStream } = require("node:fs");
  return (path: string) => realCreateWriteStream(path);
}

function makeOpts(workerId: string, backupId: string): BackupExecutorOpts {
  return {
    workerId, backupId,
    workerImageTag: "v1.0.0",
    hubBackupDir: tempDir,
    retentionDays: 30,
  };
}

describe("executeWorkerBackup", () => {
  test("B-mode worker：执行完整 SSH 序列 + 拉文件 + 写 manifest", async () => {
    const ssh = new MockSshExecutor();
    // pg_dump 成功（密码在 -e PGPASSWORD= 包装中，所以 da-pg- 前面有 -e PGPASSWORD=... ）
    ssh.when(/docker exec\s+-e\s+PGPASSWORD=\S+\s+da-pg-.*\s+pg_dump/).resolve({
      stdout: "", stderr: "", exitCode: 0,
    });
    // tar 成功
    ssh.when(/docker run --rm -v da-app-data-/).resolve({
      stdout: "", stderr: "", exitCode: 0,
    });
    // pg version 查询
    ssh.when(/SHOW server_version/).resolve({
      stdout: "16.4\n", stderr: "", exitCode: 0,
    });
    // host 清理 rm -f（实现用 rm -f 而非 rm）
    ssh.when(/rm -f \/tmp\//).resolve({ stdout: "", stderr: "", exitCode: 0 });

    // Bug A fix: MockSshExecutor.mockPullFile 接受 exact-string，不是 RegExp。
    // 用 opts.backupId 计算实际 remote path。
    const backupId = "bkp_1";
    const remoteDump = `/tmp/${backupId}.dump`;
    const remoteTar = `/tmp/${backupId}-data.tar.gz`;
    ssh.mockPullFile(remoteDump, Buffer.from("dump-content"));
    ssh.mockPullFile(remoteTar, Buffer.from("tar-content"));

    const result = await executeWorkerBackup(ssh, makeOpts("w-bmode", backupId), {
      pgContainerExists: async () => true,
      loadPgCredentials: async () => ({
        database: "deepanalyze", username: "da", password: "secret-pw",
      }),
      createWriteStream: makeMockCreateWriteStream(),
    });

    expect(result.success).toBe(true);
    expect(result.pgVersion).toBe("16.4");
    expect(result.pgDumpPath).toBe("w-bmode/bkp_1/pg.dump");
    expect(result.dataArchivePath).toBe("w-bmode/bkp_1/app-data.tar.gz");
    expect(result.manifestPath).toBe("w-bmode/bkp_1/manifest.json");

    // 文件落到本地
    const dumpStat = await stat(join(tempDir, "w-bmode", "bkp_1", "pg.dump"));
    expect(dumpStat.size).toBe(12);  // "dump-content"
    const tarStat = await stat(join(tempDir, "w-bmode", "bkp_1", "app-data.tar.gz"));
    expect(tarStat.size).toBe(11);

    // manifest 写好
    const manifestJson = (await readFile(join(tempDir, "w-bmode", "bkp_1", "manifest.json"))).toString();
    const manifest = JSON.parse(manifestJson);
    expect(manifest.backupId).toBe("bkp_1");
    expect(manifest.pgVersion).toBe("16.4");
    expect(manifest.files["pg.dump"].sizeBytes).toBe(12);
    expect(manifest.files["pg.dump"].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("A-mode worker (无 da-pg 容器)：跳过备份，返回 success 但 paths=null", async () => {
    const ssh = new MockSshExecutor();
    // 不注册任何 mock — 如果执行任何 SSH 命令会抛 "unexpected command"

    const result = await executeWorkerBackup(ssh, makeOpts("w-amode", "bkp_2"), {
      pgContainerExists: async () => false,
      loadPgCredentials: async () => ({
        database: "deepanalyze", username: "da", password: "x",
      }),
    });

    expect(result.success).toBe(true);
    expect(result.pgDumpPath).toBeNull();
    expect(result.dataArchivePath).toBeNull();
    expect(result.manifestPath).toBeNull();
    expect(result.pgVersion).toBeNull();
  });

  test("pg_dump 失败：返回 success=false，不继续后续步骤", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker exec\s+-e\s+PGPASSWORD=\S+\s+da-pg-.*\s+pg_dump/).resolve({
      stdout: "", stderr: "pg_dump: connection refused\n", exitCode: 1,
    });

    const result = await executeWorkerBackup(ssh, makeOpts("w-fail", "bkp_3"), {
      pgContainerExists: async () => true,
      loadPgCredentials: async () => ({
        database: "deepanalyze", username: "da", password: "x",
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pg_dump.*failed|connection refused/i);
    expect(result.pgDumpPath).toBeNull();
  });

  test("SSH 命令中无明文 PG 密码（用 PGPASSWORD env 包装）", async () => {
    const ssh = new MockSshExecutor();
    const recordedCmds: string[] = [];
    const origExec = ssh.exec.bind(ssh);
    ssh.exec = async (cmd: string) => {
      recordedCmds.push(cmd);
      // 简单 dispatch — 只对 pg_dump 返回成功
      if (/pg_dump/.test(cmd)) return { stdout: "", stderr: "", exitCode: 0 };
      if (/tar czf/.test(cmd)) return { stdout: "", stderr: "", exitCode: 0 };
      if (/SHOW server_version/.test(cmd)) return { stdout: "16.4\n", stderr: "", exitCode: 0 };
      if (/rm -f \/tmp\//.test(cmd)) return { stdout: "", stderr: "", exitCode: 0 };
      throw new Error(`unexpected: ${cmd}`);
    };

    // Bug C fix: mockPullFile 必须在 executeWorkerBackup 之前注册，
    // 否则 pullFile 调用时 Map 里没有数据会抛错。同时使用 exact-string。
    const backupId = "bkp_4";
    const remoteDump = `/tmp/${backupId}.dump`;
    const remoteTar = `/tmp/${backupId}-data.tar.gz`;
    ssh.mockPullFile(remoteDump, Buffer.from("x"));
    ssh.mockPullFile(remoteTar, Buffer.from("y"));

    await executeWorkerBackup(ssh, makeOpts("w-leak", backupId), {
      pgContainerExists: async () => true,
      loadPgCredentials: async () => ({
        database: "deepanalyze", username: "da", password: "SUPER-SECRET-PW",
      }),
      createWriteStream: makeMockCreateWriteStream(),
    });

    // Bug B fix: 不能用 not.toContain + toMatch 同一字符串同时断言（矛盾）。
    // 精确拆分：密码必须在 docker exec -e PGPASSWORD=... 包装中；
    //            密码不能出现在 pg_dump argv 部分（pg_dump 后的子串）。
    for (const cmd of recordedCmds) {
      if (/pg_dump/.test(cmd)) {
        // 密码必须在 -e PGPASSWORD= env wrapper 中
        expect(cmd).toMatch(/docker exec\s+-e\s+PGPASSWORD=SUPER-SECRET-PW\s/);
        // 密码不能出现在 pg_dump 的 argv 部分（即 pg_dump 之后的子串）
        const pgDumpIdx = cmd.indexOf("pg_dump");
        const pgDumpArgv = cmd.substring(pgDumpIdx);
        expect(pgDumpArgv).not.toContain("SUPER-SECRET-PW");
      }
    }
  });

  test("pgVersion 提取失败（非零 exit）→ pgVersion=null 但备份仍成功", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/pg_dump/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/tar czf/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/SHOW server_version/).resolve({
      stdout: "", stderr: "psql: command not found\n", exitCode: 127,
    });
    ssh.when(/rm -f \/tmp\//).resolve({ stdout: "", stderr: "", exitCode: 0 });

    // Bug A fix (同 Test #1): 用 exact-string 注册 pullFile
    const backupId = "bkp_5";
    const remoteDump = `/tmp/${backupId}.dump`;
    const remoteTar = `/tmp/${backupId}-data.tar.gz`;
    ssh.mockPullFile(remoteDump, Buffer.from("dump"));
    ssh.mockPullFile(remoteTar, Buffer.from("tar"));

    const result = await executeWorkerBackup(ssh, makeOpts("w-noversion", backupId), {
      pgContainerExists: async () => true,
      loadPgCredentials: async () => ({
        database: "deepanalyze", username: "da", password: "x",
      }),
      createWriteStream: makeMockCreateWriteStream(),
    });

    expect(result.success).toBe(true);
    expect(result.pgVersion).toBeNull();  // 非致命错误，容错
  });
});
