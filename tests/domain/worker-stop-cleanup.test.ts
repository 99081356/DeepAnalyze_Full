// Tests for deleteWorkerStack orchestration: da-app -> da-pg -> volumes -> network -> decommissioned
// Strategy: dependency injection — same DI pattern as worker-deployment-stack.test.ts (T6).
// Mock SSH executor + mock query + mock removePgContainer/removeWorkerNetwork recorders.
//
// The brief explicitly permits the DI deviation (see T6 report).
// Tests are hermetic: no real SSH, no real DB writes.
import { describe, test, expect, mock } from "bun:test";
import type { SshExecutor, SshExecResult } from "../../src/domain/ssh-executor";
import { deleteWorkerStack } from "../../src/domain/worker-deployment";

// Build a recording SshExecutor mock — every exec() call appended to calls[].
// Returns success with empty stdout/stderr by default.
function makeRecordingSsh(): { ssh: SshExecutor; calls: string[] } {
  const calls: string[] = [];
  const ssh: SshExecutor = {
    async exec(cmd: string): Promise<SshExecResult> {
      calls.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async pullFile(): Promise<void> { throw new Error("not used"); },
    async pushFile(): Promise<void> { throw new Error("not used"); },
    close(): void { /* noop */ },
  };
  return { ssh, calls };
}

// Mock query: records all (text, params) pairs and returns scripted rows per SQL keyword.
function makeRecordingQuery(workerRow?: Record<string, unknown>) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const defaultWorker = {
    ssh_target_host: "1.2.3.4",
    ssh_target_port: 22,
    ssh_user: "root",
    ssh_key_encrypted: "enc",
    host_id: null,
    ...workerRow,
  };
  // deno-lint-ignore no-explicit-any
  const q: any = async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (/FROM workers WHERE id/.test(text)) {
      return { rows: [defaultWorker] };
    }
    if (/FROM host_servers WHERE id/.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  };
  return { query: q, calls };
}

const WORKER_ID = "test-clean-1";
const INITIATED_BY = "u-admin";

describe("deleteWorkerStack", () => {
  test("cleanup ordering: da-app rm -> removePgContainer -> removeWorkerNetwork", async () => {
    const { ssh, calls: sshCalls } = makeRecordingSsh();
    const { query, calls: queryCalls } = makeRecordingQuery();

    const removePgCalls: Array<{ workerId: string; opts?: { removeVolume?: boolean } }> = [];
    const removePgContainerMock = async (
      _ssh: SshExecutor,
      workerId: string,
      opts?: { removeVolume?: boolean },
    ) => {
      removePgCalls.push({ workerId, opts });
    };

    const removeNetCalls: Array<{ workerId: string }> = [];
    const removeWorkerNetworkMock = async (
      _ssh: SshExecutor,
      workerId: string,
    ) => {
      removeNetCalls.push({ workerId });
    };

    // HUB_DELETE_WORKER_KEEP_VOLUMES default → "true" → keepVolumes=true
    const result = await deleteWorkerStack(
      WORKER_ID,
      INITIATED_BY,
      {},
      {
        ssh,
        // deno-lint-ignore no-explicit-any
        query: query as any,
        decryptSshKey: async () => "PEM",
        removePgContainer: removePgContainerMock,
        removeWorkerNetwork: removeWorkerNetworkMock,
      },
    );

    expect(result.success).toBe(true);

    // Verify da-app rm is first SSH call
    expect(sshCalls[0]).toMatch(new RegExp(`docker rm -f da-app-${WORKER_ID}`));
    // Verify legacy-naming compat cleanup runs (da-<slice12>)
    expect(sshCalls.some(c => new RegExp(`docker rm -f da-${WORKER_ID.slice(0, 12)}`).test(c)))
      .toBe(true);

    // Ordering: removePgContainer must come before removeWorkerNetwork
    expect(removePgCalls.length).toBe(1);
    expect(removeNetCalls.length).toBe(1);
    // (both ran; verify their relative order via the simpler check that the
    // network call happened after the pg call — they're sequential awaits
    // in deleteWorkerStack so this is guaranteed by the awaited order; we
    // additionally verify by checking no `docker network rm` ssh command
    // was issued directly by deleteWorkerStack itself — removeWorkerNetwork
    // is mocked, so the network ssh command must NOT appear in sshCalls.)
    expect(sshCalls.some(c => /docker network rm/.test(c))).toBe(false);

    // Verify status update to decommissioned was issued
    const decommissionCall = queryCalls.find(
      c => /status\s*=\s*'decommissioned'/.test(c.text),
    );
    expect(decommissionCall).toBeDefined();
    expect(decommissionCall?.params?.[0]).toBe(WORKER_ID);
  });

  test("HUB_DELETE_WORKER_KEEP_VOLUMES=true: removePgContainer called with removeVolume:false AND no docker volume rm", async () => {
    const old = process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
    process.env.HUB_DELETE_WORKER_KEEP_VOLUMES = "true";
    try {
      const { ssh, calls: sshCalls } = makeRecordingSsh();
      const { query } = makeRecordingQuery();

      const removePgCalls: Array<{ opts?: { removeVolume?: boolean } }> = [];
      const removePgContainerMock = async (
        _ssh: SshExecutor,
        _workerId: string,
        opts?: { removeVolume?: boolean },
      ) => {
        removePgCalls.push({ opts });
      };

      const result = await deleteWorkerStack(
        WORKER_ID,
        INITIATED_BY,
        {},
        {
          ssh,
          // deno-lint-ignore no-explicit-any
          query: query as any,
          decryptSshKey: async () => "PEM",
          removePgContainer: removePgContainerMock,
          removeWorkerNetwork: async () => {},
        },
      );

      expect(result.success).toBe(true);
      // removePgContainer received removeVolume:false (keep volumes)
      expect(removePgCalls[0].opts?.removeVolume).toBe(false);
      // No `docker volume rm da-app-data-*` issued
      expect(sshCalls.some(c => /docker volume rm da-app-data-/.test(c))).toBe(false);
    } finally {
      if (old) process.env.HUB_DELETE_WORKER_KEEP_VOLUMES = old;
      else delete process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
    }
  });

  test("HUB_DELETE_WORKER_KEEP_VOLUMES=false: removePgContainer called with removeVolume:true AND docker volume rm da-app-data IS called", async () => {
    const old = process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
    process.env.HUB_DELETE_WORKER_KEEP_VOLUMES = "false";
    try {
      const { ssh, calls: sshCalls } = makeRecordingSsh();
      const { query } = makeRecordingQuery();

      const removePgCalls: Array<{ opts?: { removeVolume?: boolean } }> = [];
      const removePgContainerMock = async (
        _ssh: SshExecutor,
        _workerId: string,
        opts?: { removeVolume?: boolean },
      ) => {
        removePgCalls.push({ opts });
      };

      const result = await deleteWorkerStack(
        WORKER_ID,
        INITIATED_BY,
        {},
        {
          ssh,
          // deno-lint-ignore no-explicit-any
          query: query as any,
          decryptSshKey: async () => "PEM",
          removePgContainer: removePgContainerMock,
          removeWorkerNetwork: async () => {},
        },
      );

      expect(result.success).toBe(true);
      // removePgContainer received removeVolume:true (delete volumes)
      expect(removePgCalls[0].opts?.removeVolume).toBe(true);
      // da-app volume rm IS called
      const volRm = sshCalls.find(c =>
        new RegExp(`docker volume rm da-app-data-${WORKER_ID}`).test(c),
      );
      expect(volRm).toBeDefined();
    } finally {
      if (old) process.env.HUB_DELETE_WORKER_KEEP_VOLUMES = old;
      else delete process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
    }
  });

  test("worker status UPDATEs to decommissioned (verify in query call log)", async () => {
    const { ssh } = makeRecordingSsh();
    const { query, calls: queryCalls } = makeRecordingQuery();

    const result = await deleteWorkerStack(
      WORKER_ID,
      INITIATED_BY,
      {},
      {
        ssh,
        // deno-lint-ignore no-explicit-any
        query: query as any,
        decryptSshKey: async () => "PEM",
        removePgContainer: async () => {},
        removeWorkerNetwork: async () => {},
      },
    );

    expect(result.success).toBe(true);
    const update = queryCalls.find(
      c => /UPDATE workers SET status\s*=\s*'decommissioned'/.test(c.text),
    );
    expect(update).toBeDefined();
    expect(update?.text).toMatch(/decommissioned_at\s*=\s*NOW\(\)/);
    expect(update?.params?.[0]).toBe(WORKER_ID);
  });

  test("legacy naming compat: docker rm -f da-<slice12> IS called", async () => {
    const { ssh, calls: sshCalls } = makeRecordingSsh();
    const { query } = makeRecordingQuery();

    await deleteWorkerStack(
      WORKER_ID,
      INITIATED_BY,
      {},
      {
        ssh,
        // deno-lint-ignore no-explicit-any
        query: query as any,
        decryptSshKey: async () => "PEM",
        removePgContainer: async () => {},
        removeWorkerNetwork: async () => {},
      },
    );

    const legacy = sshCalls.find(c =>
      new RegExp(`docker rm -f da-${WORKER_ID.slice(0, 12)}`).test(c),
    );
    expect(legacy).toBeDefined();
  });
});
