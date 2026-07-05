import { describe, test, expect, mock } from "bun:test";
import { cleanupExpiredBackups } from "../../src/domain/backup-cleanup";

// Mock query 工厂：返回不同的过期 backup 列表
function makeMockQuery(rows: any[]) {
  return mock(async (text: string, params?: unknown[]) => {
    if (/SELECT id, worker_id/.test(text) && /expires_at < NOW/.test(text)) {
      return { rows };
    }
    // UPDATE — 跟踪调用
    if (/UPDATE worker_backups SET status/.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  });
}

// Mock rm — 默认成功
function makeMockRm(shouldFail: Set<string> = new Set()) {
  return mock(async (path: string) => {
    if (shouldFail.has(path)) {
      throw new Error(`EACCES: permission denied ${path}`);
    }
  });
}

describe("cleanupExpiredBackups", () => {
  test("verified + failed 过期 backup 都被处理；目录删成功 → status=expired", async () => {
    const rows = [
      { id: "bkp_1", worker_id: "w1", pg_dump_path: "w1/bkp_1/pg.dump",
        data_archive_path: null, manifest_path: "w1/bkp_1/manifest.json" },
      { id: "bkp_2", worker_id: "w1", pg_dump_path: "w1/bkp_2/pg.dump",
        data_archive_path: null, manifest_path: "w1/bkp_2/manifest.json" },
    ];
    const q = makeMockQuery(rows);
    const updates: Array<{id: string; status: string}> = [];
    q.mockImplementation(async (text: string, params?: unknown[]) => {
      if (/SELECT id, worker_id/.test(text)) return { rows };
      if (/UPDATE worker_backups SET status/.test(text)) {
        updates.push({ id: params?.[1] as string, status: params?.[0] as string });
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await cleanupExpiredBackups(
      { storageDir: "/tmp/test-backups" },
      { query: q as any, rm: makeMockRm() },
    );

    expect(result.processed).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(0);
    expect(updates).toEqual([
      { id: "bkp_1", status: "expired" },
      { id: "bkp_2", status: "expired" },
    ]);
  });

  test("rm 失败的 backup → status=deletion_failed", async () => {
    const rows = [
      { id: "bkp_1", worker_id: "w1", pg_dump_path: "w1/bkp_1/pg.dump",
        data_archive_path: null, manifest_path: "w1/bkp_1/manifest.json" },
    ];
    const q = makeMockQuery(rows);
    const updates: Array<{id: string; status: string}> = [];
    q.mockImplementation(async (text: string, params?: unknown[]) => {
      if (/SELECT id, worker_id/.test(text)) return { rows };
      if (/UPDATE worker_backups SET status/.test(text)) {
        updates.push({ id: params?.[1] as string, status: params?.[0] as string });
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await cleanupExpiredBackups(
      { storageDir: "/tmp/test-backups" },
      {
        query: q as any,
        rm: makeMockRm(new Set(["/tmp/test-backups/w1/bkp_1"])),
      },
    );

    expect(result.processed).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].backupId).toBe("bkp_1");
    expect(updates).toEqual([
      { id: "bkp_1", status: "deletion_failed" },
    ]);
  });

  test("path=null 的 backup（旧 metadata-only 记录）→ 跳过 rm，但仍标记 expired", async () => {
    const rows = [
      { id: "bkp_meta_only", worker_id: "w1",
        pg_dump_path: null, data_archive_path: null, manifest_path: null },
    ];
    const q = makeMockQuery(rows);
    const updates: Array<{id: string; status: string}> = [];
    q.mockImplementation(async (text: string, params?: unknown[]) => {
      if (/SELECT id, worker_id/.test(text)) return { rows };
      if (/UPDATE worker_backups SET status/.test(text)) {
        updates.push({ id: params?.[1] as string, status: params?.[0] as string });
        return { rows: [] };
      }
      return { rows: [] };
    });
    const rmMock = makeMockRm();

    const result = await cleanupExpiredBackups(
      { storageDir: "/tmp/test" },
      { query: q as any, rm: rmMock },
    );

    expect(result.processed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(rmMock).not.toHaveBeenCalled();  // 没 rm 因为 path=null
    expect(updates[0].status).toBe("expired");
  });

  test("空结果集：返回 processed=0", async () => {
    const q = makeMockQuery([]);

    const result = await cleanupExpiredBackups(
      { storageDir: "/tmp/test" },
      { query: q as any, rm: makeMockRm() },
    );

    expect(result.processed).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("status='expired' 的 backup 不被 SELECT（已过期但已删的不重复处理）", async () => {
    // 验证 SQL WHERE 子句只选 verified/failed/deletion_failed，不选 expired
    // （deletion_failed 包含在内以便下次 cron 重试）
    const q = mock(async (text: string) => {
      // 简单断言 SQL 文本
      expect(text).toMatch(/status IN \('verified', 'failed', 'deletion_failed'\)/);
      expect(text).toMatch(/expires_at < NOW\(\)/);
      return { rows: [] };
    });

    await cleanupExpiredBackups(
      { storageDir: "/tmp/test" },
      { query: q as any, rm: makeMockRm() },
    );
  });

  test("目录路径从 pg_dump_path 推导（<worker>/<backup>/pg.dump → 删 <worker>/<backup>）", async () => {
    const rows = [
      { id: "bkp_path", worker_id: "w_path",
        pg_dump_path: "w_path/bkp_path/pg.dump",
        data_archive_path: "w_path/bkp_path/app-data.tar.gz",
        manifest_path: "w_path/bkp_path/manifest.json" },
    ];
    const q = makeMockQuery(rows);
    q.mockImplementation(async (text: string) => {
      if (/SELECT id, worker_id/.test(text)) return { rows };
      return { rows: [] };
    });
    const rmMock = makeMockRm();

    await cleanupExpiredBackups(
      { storageDir: "/data/backups" },
      { query: q as any, rm: rmMock },
    );

    // 期望删整个 <storageDir>/<worker>/<backup> 目录
    expect(rmMock).toHaveBeenCalledWith(
      "/data/backups/w_path/bkp_path",
      expect.anything(),  // recursive: true, force: true
    );
  });
});
