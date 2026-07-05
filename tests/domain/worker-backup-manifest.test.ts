import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest, writeManifest, readManifest, type BackupManifest,
} from "../../src/domain/worker-backup-manifest";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "manifest-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildManifest", () => {
  test("两个文件都存在时 manifest.files 含两个 entry", async () => {
    await writeFile(join(tempDir, "pg.dump"), Buffer.from("dump-bytes"));
    await writeFile(join(tempDir, "app-data.tar.gz"), Buffer.from("tar-bytes"));

    const m = await buildManifest({
      backupId: "bkp_abc", workerId: "w1",
      workerImageTag: "v1.0.0", pgVersion: "16.4",
      backupDir: tempDir,
      expiresAt: new Date("2026-08-05T10:00:00Z"),
    });

    expect(m.backupId).toBe("bkp_abc");
    expect(m.workerId).toBe("w1");
    expect(m.workerImageTag).toBe("v1.0.0");
    expect(m.pgVersion).toBe("16.4");
    expect(m.pgDumpFormat).toBe("custom");
    expect(m.files["pg.dump"]).toBeDefined();
    expect(m.files["pg.dump"]!.sizeBytes).toBe(10);
    expect(m.files["pg.dump"]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.files["app-data.tar.gz"]).toBeDefined();
    expect(m.files["app-data.tar.gz"]!.sizeBytes).toBe(9);
    expect(m.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(m.expiresAt).toBe("2026-08-05T10:00:00.000Z");
  });

  test("只有 pg.dump 时 manifest.files 只含一个 entry", async () => {
    await writeFile(join(tempDir, "pg.dump"), Buffer.from("dump-only"));

    const m = await buildManifest({
      backupId: "bkp_xyz", workerId: "w2",
      workerImageTag: null, pgVersion: null,
      backupDir: tempDir,
      expiresAt: new Date("2026-08-05T10:00:00Z"),
    });

    expect(m.files["pg.dump"]).toBeDefined();
    expect(m.files["app-data.tar.gz"]).toBeUndefined();
    expect(m.workerImageTag).toBeNull();
    expect(m.pgVersion).toBeNull();
  });

  test("sha256 对相同内容稳定", async () => {
    await writeFile(join(tempDir, "pg.dump"), Buffer.from("consistent"));

    const m1 = await buildManifest({
      backupId: "a", workerId: "w", workerImageTag: null, pgVersion: null,
      backupDir: tempDir, expiresAt: new Date("2026-08-05T10:00:00Z"),
    });
    const m2 = await buildManifest({
      backupId: "b", workerId: "w", workerImageTag: null, pgVersion: null,
      backupDir: tempDir, expiresAt: new Date("2026-08-05T10:00:00Z"),
    });

    expect(m1.files["pg.dump"]!.sha256).toBe(m2.files["pg.dump"]!.sha256);
  });

  test("目录无文件时抛错", async () => {
    await expect(
      buildManifest({
        backupId: "x", workerId: "w", workerImageTag: null, pgVersion: null,
        backupDir: tempDir, expiresAt: new Date("2026-08-05T10:00:00Z"),
      }),
    ).rejects.toThrow(/no backup files|empty backup/i);
  });

  test("sha256 流式处理大文件（流式 hash 与一次性 hash 一致）", async () => {
    // 写 1MB 随机数据，验证 sha256 与一次性 crypto.createHash 一致
    const bytes = Buffer.alloc(1024 * 1024, 42);
    await writeFile(join(tempDir, "pg.dump"), bytes);

    const m = await buildManifest({
      backupId: "x", workerId: "w", workerImageTag: null, pgVersion: null,
      backupDir: tempDir, expiresAt: new Date("2026-08-05T10:00:00Z"),
    });

    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(m.files["pg.dump"]!.sha256).toBe(expected);
  });
});

describe("writeManifest + readManifest", () => {
  test("往返：write 后 read 等价", async () => {
    await writeFile(join(tempDir, "pg.dump"), Buffer.from("dump"));

    const original = await buildManifest({
      backupId: "bkp_round", workerId: "w",
      workerImageTag: "v1", pgVersion: "16.4",
      backupDir: tempDir,
      expiresAt: new Date("2026-08-05T10:00:00Z"),
    });

    await writeManifest(original, tempDir);

    const json = JSON.parse(
      (await readFile(join(tempDir, "manifest.json"))).toString(),
    );
    expect(json.backupId).toBe("bkp_round");

    const round = await readManifest(tempDir);
    expect(round).toEqual(original);
  });

  test("readManifest 缺失文件时抛错", async () => {
    await expect(readManifest(tempDir)).rejects.toThrow(/manifest\.json|not found/i);
  });
});
