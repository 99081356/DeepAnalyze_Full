// Tests for deployWorkerStack orchestration: network -> pg -> deployWorker
// Strategy: dependency injection — pass mock ssh / mock deployWorker / mock query.
// This avoids bun:test mock.module limitations and tests real orchestration
// behavior end-to-end (call order, argument propagation, error handling).
//
// The brief explicitly permits the DI deviation:
//   "可以重构 deployWorkerStack 接受可选的依赖注入参数 ... 这是允许的偏离"
import { describe, test, expect, mock } from "bun:test";
import type { SshExecutor, SshExecResult } from "../../src/domain/ssh-executor";
import type { PgCredentials } from "../../src/domain/worker-pg-credentials";
import type { DeployResult } from "../../src/domain/worker-deployment";
import { deployWorkerStack } from "../../src/domain/worker-deployment";

// Build a scripted SshExecutor mock — records every exec() call in order.
function makeMockSsh(scripts: Array<{ match: RegExp; response: SshExecResult }>): {
  ssh: SshExecutor;
  calls: string[];
} {
  const calls: string[] = [];
  const queue = [...scripts];
  const ssh: SshExecutor = {
    async exec(cmd: string): Promise<SshExecResult> {
      calls.push(cmd);
      const idx = queue.findIndex(s => s.match.test(cmd));
      if (idx === -1) {
        throw new Error(`mock ssh: unexpected command: ${cmd}`);
      }
      const [entry] = queue.splice(idx, 1);
      return entry.response;
    },
    async pullFile(): Promise<void> { throw new Error("not used"); },
    async pushFile(): Promise<void> { throw new Error("not used"); },
    close(): void { /* noop */ },
  };
  return { ssh, calls };
}

const FAKE_CREDS: PgCredentials = {
  database: "deepanalyze",
  username: "da",
  password: "testpass123",
};

const SUCCESS_DEPLOY_RESULT: DeployResult = {
  jobId: "dpl_test_success",
  success: true,
  logs: [{ ts: new Date().toISOString(), level: "info", msg: "deployed" }],
};

describe("deployWorkerStack", () => {
  test("编排顺序: ensureNetwork -> ensurePgContainer -> deployWorker", async () => {
    // Scripted SSH responses for the orchestrator's two ensure* calls.
    // Network exists (inspect succeeds), PG container exists (ps filter matches).
    // deployWorker is mocked, so it makes no SSH calls of its own.
    const { ssh, calls } = makeMockSsh([
      { match: /docker network inspect/, response: { stdout: '[{"Name":"da-net-w1"}]\n', stderr: "", exitCode: 0 } },
      { match: /docker ps -a --filter/, response: { stdout: "da-pg-w1\n", stderr: "", exitCode: 0 } },
    ]);

    const deployWorkerMock = mock(() => Promise.resolve(SUCCESS_DEPLOY_RESULT));
    const queryMock = mock(() => Promise.resolve({
      rows: [{
        ssh_target_host: "1.2.3.4",
        ssh_target_port: 22,
        ssh_user: "root",
        ssh_key_encrypted: "enc",
        host_id: null,
      }],
    }));

    const result = await deployWorkerStack(
      { workerId: "w1", imageTag: "da-base-v1", initiatedBy: "u1" },
      {
        ssh,
        deployWorker: deployWorkerMock,
        // deno-lint-ignore no-explicit-any
        query: queryMock as any,
        decryptSshKey: async () => "PEM",
        connectRealSsh: async () => ssh,
        ensurePgCredentials: async () => FAKE_CREDS,
      },
    );

    expect(result.success).toBe(true);
    // Verify orchestration: network inspected first, pg ps checked second.
    expect(calls[0]).toMatch(/docker network inspect da-net-w1/);
    // Second ssh call is the PG container existence check.
    expect(calls[1]).toMatch(/docker ps -a --filter/);
    expect(calls[1]).toMatch(/da-pg-w1/);
    expect(calls.length).toBe(2);  // deployWorker didn't run any ssh calls (mocked)
    expect(deployWorkerMock).toHaveBeenCalledTimes(1);
  });

  test("PG 已存在则不重建, 但 deployWorker 仍执行", async () => {
    const { ssh, calls } = makeMockSsh([
      { match: /docker network inspect/, response: { stdout: "", stderr: "no such", exitCode: 1 } },
      { match: /docker network create da-net-w2/, response: { stdout: "netid\n", stderr: "", exitCode: 0 } },
      { match: /docker ps -a --filter/, response: { stdout: "da-pg-w2\n", stderr: "", exitCode: 0 } },
    ]);

    const deployWorkerMock = mock(() => Promise.resolve(SUCCESS_DEPLOY_RESULT));
    const queryMock = mock(() => Promise.resolve({
      rows: [{
        ssh_target_host: "1.2.3.4",
        ssh_target_port: 22,
        ssh_user: "root",
        ssh_key_encrypted: "enc",
        host_id: null,
      }],
    }));

    const result = await deployWorkerStack(
      { workerId: "w2", imageTag: "da-base-v1", initiatedBy: "u1" },
      {
        ssh,
        deployWorker: deployWorkerMock,
        // deno-lint-ignore no-explicit-any
        query: queryMock as any,
        decryptSshKey: async () => "PEM",
        connectRealSsh: async () => ssh,
        ensurePgCredentials: async () => FAKE_CREDS,
      },
    );

    expect(result.success).toBe(true);
    // Network had to be created; PG existed already (no docker run for pg).
    const pgRunCalls = calls.filter(c => /docker run -d/.test(c) && /da-pg-w2/.test(c));
    expect(pgRunCalls.length).toBe(0);
    expect(deployWorkerMock).toHaveBeenCalledTimes(1);
    // Verify deployWorker got PG env vars
    const callOpts = deployWorkerMock.mock.calls[0][0] as { envVars: Record<string, string> };
    expect(callOpts.envVars.PG_HOST).toBe("da-pg-w2");
    expect(callOpts.envVars.PG_PORT).toBe("5432");
    expect(callOpts.envVars.PG_USER).toBe("da");
    expect(callOpts.envVars.PG_PASSWORD).toBe("testpass123");
    expect(callOpts.envVars.PG_DATABASE).toBe("deepanalyze");
  });

  test("ensurePgContainer 失败时 stack 失败, 不调 deployWorker", async () => {
    // PG container create fails (docker run returns exitCode 1).
    const { ssh } = makeMockSsh([
      { match: /docker network inspect/, response: { stdout: '[{"Name":"da-net-w3"}]\n', stderr: "", exitCode: 0 } },
      { match: /docker ps -a --filter/, response: { stdout: "", stderr: "", exitCode: 0 } },
      { match: /docker run -d/, response: { stdout: "", stderr: "image not found\n", exitCode: 1 } },
    ]);

    const deployWorkerMock = mock(() => Promise.resolve(SUCCESS_DEPLOY_RESULT));
    const queryMock = mock(() => Promise.resolve({
      rows: [{
        ssh_target_host: "1.2.3.4",
        ssh_target_port: 22,
        ssh_user: "root",
        ssh_key_encrypted: "enc",
        host_id: null,
      }],
    }));

    await expect(deployWorkerStack(
      { workerId: "w3", imageTag: "da-base-v1", initiatedBy: "u1" },
      {
        ssh,
        deployWorker: deployWorkerMock,
        // deno-lint-ignore no-explicit-any
        query: queryMock as any,
        decryptSshKey: async () => "PEM",
        connectRealSsh: async () => ssh,
        ensurePgCredentials: async () => FAKE_CREDS,
      },
    )).rejects.toThrow(/image not found/);

    expect(deployWorkerMock).not.toHaveBeenCalled();
  });
});
