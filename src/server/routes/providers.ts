// =============================================================================
// Provider Registry routes
// =============================================================================
// 暴露 DA 的 provider-registry（src/data/provider-registry.ts 副本）给 Hub 前端，
// 供配置模板表单的 provider 下拉、模型建议、能力提示使用。
//
// 端点：
//   GET /api/v1/providers/registry        — 全部 provider 列表
//   GET /api/v1/providers/registry/:id     — 单个 provider 完整元数据
//   POST /api/v1/providers/test             — 测试 provider 连通性
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

  // POST /api/v1/providers/test — 测试 provider 连通性
  // Body: { endpoint: string, apiKey?: string, model?: string }
  // 尝试调 OpenAI-compatible 的 GET {endpoint}/models（覆盖大多数 provider），
  // 失败则尝试 Anthropic 风格。返回模型数量和延迟。
  app.post("/test", jwtAuth, async (c) => {
    const body = await c.req.json<{ endpoint: string; apiKey?: string; model?: string }>();
    const endpoint = body.endpoint?.trim();
    if (!endpoint) return c.json({ ok: false, error: "endpoint required" }, 400);

    const apiKey = body.apiKey?.trim() || "";
    const t0 = Date.now();

    // 策略 1: OpenAI-compatible GET /models
    const openAiHeaders: Record<string, string> = {
      "Accept": "application/json",
    };
    if (apiKey) openAiHeaders["Authorization"] = `Bearer ${apiKey}`;

    try {
      // 去掉尾部斜杠
      const base = endpoint.replace(/\/+$/, "");
      const resp = await fetch(`${base}/models`, {
        method: "GET",
        headers: openAiHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      const latency = Date.now() - t0;

      if (resp.ok) {
        const data = await resp.json() as { data?: unknown[] };
        const count = Array.isArray(data?.data) ? data.data.length : 0;
        return c.json({
          ok: true,
          protocol: "openai-compatible",
          latency_ms: latency,
          model_count: count,
          message: count > 0
            ? `连接成功，/models 返回 ${count} 个模型`
            : "连接成功（/models 返回空列表）",
        });
      }

      // 401/403 → 认证问题（endpoint 可达但 key 无效）
      if (resp.status === 401 || resp.status === 403) {
        // 再试不带 key？可能 provider 允许匿名访问 /models
        if (apiKey) {
          const anonResp = await fetch(`${base}/models`, {
            method: "GET",
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(8_000),
          });
          if (anonResp.ok) {
            const data = await anonResp.json() as { data?: unknown[] };
            const count = Array.isArray(data?.data) ? data.data.length : 0;
            return c.json({
              ok: true,
              protocol: "openai-compatible (no auth)",
              latency_ms: Date.now() - t0,
              model_count: count,
              message: `连接成功（无需 API key 即可访问 /models，返回 ${count} 个模型）`,
            });
          }
        }
        return c.json({
          ok: false,
          protocol: "openai-compatible",
          latency_ms: latency,
          error: `HTTP ${resp.status}: 认证失败（endpoint 可达，但 API key 被拒）`,
        });
      }

      // 其他 HTTP 错误 → 可能不是 OpenAI 协议，试 Anthropic
    } catch (err) {
      const latency = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      // 网络层错误（DNS/超时/连接拒绝）
      return c.json({ ok: false, latency_ms: latency, error: `网络错误: ${msg}` });
    }

    // 策略 2: Anthropic-compatible GET /v1/models
    const anthroHeaders: Record<string, string> = {
      "Accept": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) anthroHeaders["x-api-key"] = apiKey;

    try {
      const base = endpoint.replace(/\/+$/, "");
      const resp = await fetch(`${base}/v1/models`, {
        method: "GET",
        headers: anthroHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      const latency = Date.now() - t0;

      if (resp.ok) {
        const data = await resp.json() as { data?: unknown[] };
        const count = Array.isArray(data?.data) ? data.data.length : 0;
        return c.json({
          ok: true,
          protocol: "anthropic",
          latency_ms: latency,
          model_count: count,
          message: `连接成功（Anthropic 协议），/v1/models 返回 ${count} 个模型`,
        });
      }

      return c.json({
        ok: false,
        protocol: "anthropic",
        latency_ms: latency,
        error: `HTTP ${resp.status}: Anthropic 协议未成功（${resp.statusText || "未知错误"}）`,
      });
    } catch (err) {
      const latency = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, latency_ms: latency, error: `两种协议均失败: ${msg}` });
    }
  });

  return app;
}
