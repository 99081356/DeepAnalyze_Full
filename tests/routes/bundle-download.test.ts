// =============================================================================
// T05: GET /api/v1/bundle/images/:version/download 流式下载端点测试
// =============================================================================
// 3 tests:
//   1. streaming 下载 roundtrip + content 验证（1024 字节，全 0xAB）
//   2. 不存在的版本 → 404
//   3. manifest 存在但 file_path 为 NULL → 409
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { createBundleRoutes } from "../../src/server/routes/bundle";
import { query } from "../../src/store/pg";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

const TEST_TAR = "/tmp/test-bundle-t05.tar.gz";
const TEST_MANIFEST_ID = "bdl_test_t05";
const TEST_VERSION = "0.7.6-t05-test";

// 构建仅含 bundle 路由的测试 app（端点公开，见 Correction 3）
function buildTestApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/bundle", createBundleRoutes());
  return app;
}

describe("GET /api/v1/bundle/images/:version/download", () => {
  beforeAll(() => {
    // 创建 1KB 测试文件（全 0xAB）
    writeFileSync(TEST_TAR, Buffer.alloc(1024, 0xab));
    // 写入 bundle_manifests 行（直接 SQL，见 Correction 1）
    return query(
      `INSERT INTO bundle_manifests (id, version, da_image_tag, hub_image_tag, models, skills,
                                      file_path, file_size, image_name, checksum_sha256)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb, $5, 1024, 'da-personal-full', 'sha256:test')
       ON CONFLICT (id) DO UPDATE SET file_path = $5, file_size = 1024`,
      [
        TEST_MANIFEST_ID,
        TEST_VERSION,
        `da-personal-full-${TEST_VERSION}`,
        `hub-${TEST_VERSION}`,
        TEST_TAR,
      ],
    );
  });

  afterAll(async () => {
    if (existsSync(TEST_TAR)) unlinkSync(TEST_TAR);
    await query(`DELETE FROM bundle_manifests WHERE id = $1`, [TEST_MANIFEST_ID]);
  });

  test("streaming 下载成功", async () => {
    const app = buildTestApp();
    const res = await app.request(
      `/api/v1/bundle/images/${TEST_VERSION}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(TEST_VERSION);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(1024);
    // 验证内容（全 0xAB）
    const view = new Uint8Array(buf);
    expect(view[0]).toBe(0xab);
    expect(view[1023]).toBe(0xab);
  });

  test("不存在的版本 404", async () => {
    const app = buildTestApp();
    const res = await app.request(
      `/api/v1/bundle/images/9.9.9-nonexistent/download`,
    );
    expect(res.status).toBe(404);
  });

  test("manifest 存在但 file_path 为空返回 409", async () => {
    // 插入 file_path=NULL 的行
    await query(
      `INSERT INTO bundle_manifests (id, version, da_image_tag, hub_image_tag, models, skills, file_path)
       VALUES ('bdl_test_t05_nofile', '0.7.6-t05-nofile', 'da-x', 'hub-x', '[]'::jsonb, '[]'::jsonb, NULL)
       ON CONFLICT (id) DO NOTHING`,
    );
    try {
      const app = buildTestApp();
      const res = await app.request(
        `/api/v1/bundle/images/0.7.6-t05-nofile/download`,
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/file/i);
    } finally {
      await query(`DELETE FROM bundle_manifests WHERE id = $1`, [
        "bdl_test_t05_nofile",
      ]);
    }
  });
});
