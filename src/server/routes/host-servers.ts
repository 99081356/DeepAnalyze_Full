// deepanalyze-hub/src/server/routes/host-servers.ts
import { Hono } from "hono";
import { z } from "zod";
import { HostServerRepo, CreateHostServerInput } from "../../domain/host-server";
import type { HostServer } from "../../domain/host-server";
import { getPortUsage } from "../../domain/port-allocation";
import { getPool } from "../../store/pg";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission";

export function createHostServerRoutes(): Hono {
  const router = new Hono();
  const repo = new HostServerRepo(() => getPool());

  /**
   * PATCH 输入校验：列白名单 + 类型检查 + 严格拒绝未知 key。
   * 配合 domain 层的 UPDATEABLE_HOST_SERVER_FIELDS 形成防御纵深。
   * 注意：ssh_key_encrypted 字段客户端应传明文 PEM，加密由后续 task 处理（本 task 范围外）。
   */
  const patchHostServerSchema = z.object({
    hostname: z.string().min(1).optional(),
    ssh_target_host: z.string().min(1).optional(),
    ssh_target_port: z.number().int().min(1).max(65535).optional(),
    ssh_user: z.string().min(1).optional(),
    ssh_key_encrypted: z.string().optional(),
    ssh_key_salt: z.string().optional(),
    port_range_start: z.number().int().min(1).max(65535).optional(),
    port_range_end: z.number().int().min(1).max(65535).optional(),
    port_block_size: z.number().int().min(1).max(100).optional(),
    cpu_cores: z.number().int().positive().optional(),
    memory_gb: z.number().int().positive().optional(),
    gpu_count: z.number().int().nonnegative().optional(),
    gpu_vram_mb: z.number().int().nonnegative().optional(),
    gpu_model: z.string().optional(),
    labels: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional(),
    status: z.enum(["active", "maintenance", "retired"]).optional(),
  }).strict();

  // 所有 host-server 操作都要 super_admin（或显式 host_server:manage 权限）
  // 必须先经过 jwtAuth 设置 c.get("isSuperAdmin") / c.get("userPermissions")，
  // 否则 requirePermission 内部 matchPermission 会因 permissions=undefined 抛 TypeError
  router.use("*", jwtAuth, requirePermission("host_server:manage"));

  router.post("/", async (c) => {
    const body = await c.req.json<CreateHostServerInput>();
    if (!body.hostname || !body.ssh_target_host) {
      return c.json({ error: "hostname and ssh_target_host required" }, 400);
    }
    try {
      const hs = await repo.create(body);
      return c.json(hs, 201);
    } catch (e) {
      if (String(e).includes("unique")) return c.json({ error: "hostname exists" }, 409);
      throw e;
    }
  });

  router.get("/", async (c) => {
    const status = c.req.query("status");
    const items = await repo.list(status ? { status } : {});
    return c.json({ items });
  });

  router.get("/:id", async (c) => {
    const hs = await repo.getById(c.req.param("id"));
    if (!hs) return c.json({ error: "not found" }, 404);
    return c.json(hs);
  });

  router.patch("/:id", async (c) => {
    const parseResult = patchHostServerSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parseResult.success) {
      return c.json(
        { error: "validation failed", issues: parseResult.error.issues },
        400,
      );
    }
    const hs = await repo.update(c.req.param("id"), parseResult.data);
    if (!hs) return c.json({ error: "not found" }, 404);
    return c.json(hs);
  });

  router.delete("/:id", async (c) => {
    await repo.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  // 端口使用情况（T03 实现具体算法）
  router.get("/:id/port-usage", async (c) => {
    const hs = await repo.getById(c.req.param("id"));
    if (!hs) return c.json({ error: "not found" }, 404);
    const usage = await getPortUsage(() => getPool(), hs.id);
    return c.json({
      host_server_id: hs.id,
      range: [hs.port_range_start, hs.port_range_end],
      block_size: hs.port_block_size,
      allocated: usage,
    });
  });

  return router;
}
