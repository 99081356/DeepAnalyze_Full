// =============================================================================
// Provider Registry routes
// =============================================================================
// 暴露 DA 的 provider-registry（src/data/provider-registry.ts 副本）给 Hub 前端，
// 供配置模板表单的 provider 下拉、模型建议、能力提示使用。
//
// 端点：
//   GET /api/v1/providers/registry        — 全部 provider 列表（精简版，供下拉）
//   GET /api/v1/providers/registry/:id    — 单个 provider 完整元数据
//
// 鉴权：jwtAuth（任意登录用户可见，无需特殊权限——registry 是公开的 provider
// 目录，不含密钥）。无需 DB 访问，纯静态数据返回。
// =============================================================================

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import {
  PROVIDER_REGISTRY,
  getAllProviders,
  getProviderMetadata,
} from "../../data/provider-registry.js";

export function createProviderRoutes(): Hono {
  const app = new Hono();

  // GET /api/v1/providers/registry — 全部 provider 列表
  // 返回精简字段（id/name/apiBase/defaultModel/isLocal/features），不含完整的
  // models 数组（那个走详情端点），减少列表载荷。
  app.get("/registry", jwtAuth, async (c) => {
    const list = getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      apiBase: p.apiBase,
      apiBaseCN: p.apiBaseCN,
      defaultModel: p.defaultModel,
      isLocal: p.isLocal,
      apiKeyEnvVar: p.apiKeyEnvVar,
      recommendedMaxTokens: p.recommendedMaxTokens,
      contextWindow: p.contextWindow,
      features: p.features,
      // 模型只返回 id+name（供 datalist 建议项），完整元数据走详情
      models: p.models.map((m) => ({ id: m.id, name: m.name })),
    }));
    return c.json({ providers: list, total: list.length });
  });

  // GET /api/v1/providers/registry/:id — 单个 provider 完整元数据
  app.get("/registry/:id", jwtAuth, async (c) => {
    const id = c.req.param("id");
    const meta = getProviderMetadata(id);
    if (!meta) {
      return c.json({ error: `provider '${id}' not found`, available: Object.keys(PROVIDER_REGISTRY) }, 404);
    }
    return c.json(meta);
  });

  return app;
}
