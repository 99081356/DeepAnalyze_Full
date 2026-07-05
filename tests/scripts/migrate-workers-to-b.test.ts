// Tests for migrate-workers-to-b.ts migration script.
// Strategy: dependency injection — pass mock ssh / mock query / mock deps.
// This follows the T6/T7 pattern (see tests/domain/worker-deployment-stack.test.ts).
//
// The brief's placeholder tests (expect(true).toBe(true)) are intentionally
// replaced here with real behavioral tests; the brief's placeholder-scan
// self-review note explicitly authorized this:
//   "如果 implementer 写不出 mock，应当 fallback 到依赖注入"
//
// We test `migrateWorker` directly via DI (not main()), and unit-test
// `extractOldPgConfig` for parsing correctness.
import { describe, test, expect } from "bun:test";
import {
  migrateWorker,
  extractOldPgConfig,
} from "../../scripts/migrate-workers-to-b";
import { MockSshExecutor, type SshExecutor, type SshExecResult } from "../../src/domain/ssh-executor";
import type { PgCredentials } from "../../src/domain/worker-pg-credentials";

// Helper: build a recording SshExecutor with custom matchers + a call log.
// Unlike MockSshExecutor (which consumes responses FIFO), this records every
// call so tests can assert call order and command contents.
//
// `sticky: true` entries are NOT consumed — they match every time. Useful for
// healthcheck polling where the same command repeats.
function makeRecordingSsh(scripts: Array<{ match: RegExp; response: SshExecResult; sticky?: boolean }>): {
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
        throw new Error(`recording ssh: unexpected command: ${cmd}`);
      }
      const entry = queue[idx];
      if (!entry.sticky) queue.splice(idx, 1);
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

const WORKER_DB_ROW = {
  ssh_target_host: "10.0.0.5",
  ssh_target_port: 22,
  ssh_user: "deploy",
  ssh_key_encrypted: "encrypted-key-blob",
  host_id: null,
  current_image_tag: "da-base-v0.9.0-amd64",
};

// Helper: build a recording query mock that returns scripted rows by SQL match.
function makeRecordingQuery(scripts: Array<{ match: RegExp; rows: unknown[] }>): {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  calls: string[];
} {
  const calls: string[] = [];
  const queue = [...scripts];
  const q = async (text: string, _params?: unknown[]): Promise<{ rows: unknown[] }> => {
    calls.push(text);
    const idx = queue.findIndex(s => s.match.test(text));
    if (idx === -1) {
      throw new Error(`recording query: unexpected SQL: ${text}`);
    }
    const [entry] = queue.splice(idx, 1);
    return { rows: entry.rows };
  };
  return { query: q, calls };
}

describe("migrate-workers-to-b script", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: --dry-run does NOT call `docker run`
  // ─────────────────────────────────────────────────────────────────────────
  test("--dry-run 不调用 docker run（仅 inspect 类只读操作）", async () => {
    // Script: pgContainerExists=false, old container exists with PG env.
    const { ssh, calls } = makeRecordingSsh([
      // pgContainerExists probe → empty (not yet migrated)
      { match: /docker ps -a --filter name=\^\/da-pg-/, response: { stdout: "", stderr: "", exitCode: 0 } },
      // old container name probe → returns the old name
      { match: /docker ps -a --filter name=\^\/da-[\w]{12}\$/, response: { stdout: "da-abcdef123456\n", stderr: "", exitCode: 0 } },
      // extractOldPgConfig inspect → PG_HOST line present
      {
        match: /docker inspect da-abcdef123456 --format/,
        response: {
          stdout: "PG_HOST=old-pg\nPG_PORT=5432\nPG_USER=da\nPG_PASSWORD=secret\nPG_DATABASE=deepanalyze\n",
          stderr: "", exitCode: 0,
        },
      },
    ]);

    const { query } = makeRecordingQuery([
      { match: /SELECT ssh_target_host/, rows: [WORKER_DB_ROW] },
    ]);

    // Pre-connect the ssh so connectRealSsh mock returns it directly.
    const connectRealSsh = async () => ssh;

    const result = await migrateWorker(
      "abcdef1234567890abcdef1234567890",
      { dryRun: true, concurrency: 1 },
      {
        // deno-lint-ignore no-explicit-any
        query: query as any,
        ssh,
        connectRealSsh,
        decryptString: () => "PRIVATE-PEM",
        ensurePgCredentials: async () => FAKE_CREDS,
        ensureWorkerNetwork: async () => {},
        ensurePgContainer: async () => {},
        pgContainerExists: async () => false,
      },
    );

    expect(result.success).toBe(true);
    // No `docker run` should have been issued in dry-run mode.
    const dockerRunCalls = calls.filter(c => c.includes("docker run"));
    expect(dockerRunCalls.length).toBe(0);
    // No `docker stop` either — dry-run is read-only.
    const dockerStopCalls = calls.filter(c => c.includes("docker stop"));
    expect(dockerStopCalls.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: Already-migrated worker (pgContainerExists=true) is skipped
  // ─────────────────────────────────────────────────────────────────────────
  test("已迁移 worker (da-pg-<id> 存在) 被跳过，不触发后续操作", async () => {
    // pgContainerExists returns true via the DI mock — the SSH probe should
    // NOT even be called for this (we short-circuit at the deps level).
    const { ssh, calls } = makeRecordingSsh([]);

    const { query } = makeRecordingQuery([
      { match: /SELECT ssh_target_host/, rows: [WORKER_DB_ROW] },
    ]);

    const connectRealSsh = async () => ssh;

    const result = await migrateWorker(
      "w-migrated-id-1234567890abcdef",
      { dryRun: false, concurrency: 1 },
      {
        // deno-lint-ignore no-explicit-any
        query: query as any,
        ssh,
        connectRealSsh,
        decryptString: () => "PRIVATE-PEM",
        ensurePgCredentials: async () => FAKE_CREDS,
        ensureWorkerNetwork: async () => { throw new Error("should not be called"); },
        ensurePgContainer: async () => { throw new Error("should not be called"); },
        pgContainerExists: async () => true, // already migrated
      },
    );

    expect(result.success).toBe(true);
    // Since pgContainerExists short-circuited, no SSH probes for old container.
    expect(calls.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: No-old-container worker (no da-<slice12>) → success, no work done
  // ─────────────────────────────────────────────────────────────────────────
  test("无老容器的 worker 视为 fresh deploy，提前返回成功", async () => {
    const { ssh, calls } = makeRecordingSsh([
      // pgContainerExists probe → empty
      { match: /docker ps -a --filter name=\^\/da-pg-/, response: { stdout: "", stderr: "", exitCode: 0 } },
      // old container name probe → empty (no old container)
      { match: /docker ps -a --filter name=\^\/da-[\w]{12}\$/, response: { stdout: "", stderr: "", exitCode: 0 } },
    ]);

    const { query } = makeRecordingQuery([
      { match: /SELECT ssh_target_host/, rows: [WORKER_DB_ROW] },
    ]);

    const connectRealSsh = async () => ssh;

    const result = await migrateWorker(
      "freshworkerid1234567890abcdef",
      { dryRun: false, concurrency: 1 },
      {
        // deno-lint-ignore no-explicit-any
        query: query as any,
        ssh,
        connectRealSsh,
        decryptString: () => "PRIVATE-PEM",
        ensurePgCredentials: async () => { throw new Error("should not be called"); },
        ensureWorkerNetwork: async () => { throw new Error("should not be called"); },
        ensurePgContainer: async () => { throw new Error("should not be called"); },
        pgContainerExists: async () => false,
      },
    );

    expect(result.success).toBe(true);
    // Only the pgExists + oldName probes should have run — no docker run / stop.
    const dockerRunCalls = calls.filter(c => c.includes("docker run"));
    expect(dockerRunCalls.length).toBe(0);
    const dockerStopCalls = calls.filter(c => c.includes("docker stop"));
    expect(dockerStopCalls.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: Healthcheck failure triggers rollback (restart old container)
  // ─────────────────────────────────────────────────────────────────────────
  test("健康检查失败时回滚（删除新容器 + 启动老容器）", async () => {
    // Strategy: script SSH so old container exists + PG config extractable +
    // docker run succeeds, but healthcheck polling always returns FAIL. To
    // avoid waiting 180s for the real deadline, we patch Date.now to jump
    // past the deadline after the first health poll. This forces the loop
    // to exit with healthy=false, triggering the rollback path: docker rm -f
    // <newName> + docker start <oldName>.
    //
    // workerId chosen so slice(0,12) = "healthfailid" exactly (12 chars).
    const WORKER_ID = "healthfailid1234567890abcdef";
    const OLD_NAME = "da-healthfailid"; // da- + slice(0,12)

    const { ssh, calls } = makeRecordingSsh([
      // pgContainerExists is via DI → no SSH here.
      // old container name probe → exists
      { match: /docker ps -a --filter name=\^\/da-[\w]{12}\$/, response: { stdout: OLD_NAME + "\n", stderr: "", exitCode: 0 } },
      // extractOldPgConfig inspect (command ends with "|| true")
      {
        match: /docker inspect da-healthfailid --format.*\|\| true/,
        response: {
          stdout: "PG_HOST=old-pg\nPG_PORT=5432\nPG_USER=da\nPG_PASSWORD=secret\nPG_DATABASE=deepanalyze\n",
          stderr: "", exitCode: 0,
        },
      },
      // pg_dump | pg_restore (any exit code is fine — non-fatal)
      { match: /pg_dump .* \| .* pg_restore/, response: { stdout: "", stderr: "warning: owner", exitCode: 1 } },
      // docker stop old
      { match: /docker stop da-healthfailid/, response: { stdout: OLD_NAME + "\n", stderr: "", exitCode: 0 } },
      // docker inspect for inherit envs (command ends with "{{end}}'" — no || true)
      {
        match: /docker inspect da-healthfailid --format.*\{end\}\}'$/,
        response: { stdout: "DA_AUTH_MODE=token\nNODE_ENV=production\n", stderr: "", exitCode: 0 },
      },
      // docker run new → success
      { match: /docker run -d --name da-app-/, response: { stdout: "newcontainerid\n", stderr: "", exitCode: 0 } },
      // healthcheck polls → FAIL (sticky so multiple polls all fail)
      { match: /docker exec da-app-.* curl .*\/api\/health/, response: { stdout: "FAIL\n", stderr: "", exitCode: 0 }, sticky: true },
      // rollback: docker rm -f new container
      { match: /docker rm -f da-app-/, response: { stdout: "", stderr: "", exitCode: 0 } },
      // rollback: docker start old container
      { match: /docker start da-healthfailid/, response: { stdout: OLD_NAME + "\n", stderr: "", exitCode: 0 } },
    ]);

    const { query } = makeRecordingQuery([
      { match: /SELECT ssh_target_host/, rows: [WORKER_DB_ROW] },
    ]);

    const connectRealSsh = async () => ssh;

    // Patch Date.now so the FIRST healthcheck poll is within the deadline,
    // but the SECOND poll (3s later via setTimeout) is past the deadline.
    // The script computes `deadline = Date.now() + 180_000` once at the top
    // of the healthcheck block; then loops while Date.now() < deadline.
    // We make Date.now advance 200_000ms after the first poll.
    const realNow = Date.now;
    let pollCount = 0;
    Date.now = () => {
      // First poll: return a value that is < the captured deadline.
      // After first poll, jump ahead so the while condition fails next.
      pollCount++;
      if (pollCount <= 2) {
        // Initial deadline computation + first poll entry — return real time.
        return realNow();
      }
      // Subsequent calls (loop re-check): past deadline.
      return realNow() + 300_000;
    };

    try {
      const result = await migrateWorker(
        WORKER_ID,
        { dryRun: false, concurrency: 1 },
        {
          // deno-lint-ignore no-explicit-any
          query: query as any,
          ssh,
          connectRealSsh,
          decryptString: () => "PRIVATE-PEM",
          ensurePgCredentials: async () => FAKE_CREDS,
          ensureWorkerNetwork: async () => {},
          ensurePgContainer: async () => {},
          pgContainerExists: async () => false,
        },
      );

      // Should have failed with healthcheck timeout.
      expect(result.success).toBe(false);
      expect(result.error).toBe("healthcheck timeout");

      // Rollback assertions: `docker rm -f da-app-<id>` AND `docker start <old>`.
      const rmForceCalls = calls.filter(c => c.includes("docker rm -f da-app-"));
      expect(rmForceCalls.length).toBeGreaterThanOrEqual(1);
      const startOldCalls = calls.filter(c => c.includes(`docker start ${OLD_NAME}`));
      expect(startOldCalls.length).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5 (unit): extractOldPgConfig parses PG_* env vars correctly
  // ─────────────────────────────────────────────────────────────────────────
  test("extractOldPgConfig 正确解析 PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE", async () => {
    // Use the real MockSshExecutor (scripted .when().resolve() pattern) to
    // verify the parsing logic of extractOldPgConfig.
    const ssh = new MockSshExecutor();
    ssh.when(/docker inspect old-container --format/).resolve({
      stdout: [
        "PG_HOST=old-pg-host",
        "PG_PORT=6543",
        "PG_USER=legacyuser",
        "PG_PASSWORD=p@ss w0rd",
        "PG_DATABASE=legacydb",
        "PATH=/usr/local/bin:/usr/bin",
        "NODE_ENV=production",
        "",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const result = await extractOldPgConfig(ssh, "old-container");

    expect(result).not.toBeNull();
    expect(result!.host).toBe("old-pg-host");
    expect(result!.port).toBe("6543");
    expect(result!.user).toBe("legacyuser");
    expect(result!.password).toBe("p@ss w0rd");
    expect(result!.database).toBe("legacydb");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6 (unit): extractOldPgConfig returns null when PG_HOST missing
  // ─────────────────────────────────────────────────────────────────────────
  test("extractOldPgConfig 无 PG_HOST 时返回 null（视为 localhost fallback）", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker inspect no-pg-host --format/).resolve({
      stdout: "PATH=/usr/bin\nNODE_ENV=production\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await extractOldPgConfig(ssh, "no-pg-host");
    expect(result).toBeNull();
  });
});
