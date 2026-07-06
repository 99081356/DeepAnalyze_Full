import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  XCircle,
  Save,
  Wifi,
} from "lucide-react";
import { ModuleCard } from "./ModuleCard";
import { api } from "../../api/client";
import type {
  ProviderConfig,
  ProviderDefaults,
} from "../../types/index.js";

interface TestResult {
  success: boolean;
  message: string;
}

interface EmbeddingModelConfigProps {
  providers: ProviderConfig[];
  defaults: ProviderDefaults | null;
  onSave: (providerId: string) => Promise<void>;
  onTest: (providerId: string) => Promise<TestResult>;
}

type EmbeddingTab = "bge-local" | "custom";
type CustomMode = "provider" | "custom-endpoint";

const CUSTOM_EMBEDDING_ID = "__custom_embedding__";

/**
 * 嵌入模型配置 — 双 Tab 设计.
 *
 * Tab A (BGE-M3 本地部署):
 *   使用 ModuleCard 的 local/remote/disabled 三模式切换,
 *   适合 BGE-M3 本地权重部署或简单的远端 endpoint.
 *
 * Tab B (自定义嵌入端点):
 *   恢复 v0.6.1 的完整自定义端点配置:
 *   - 复用已有 Provider 模式 (从已配置 Provider 中选择嵌入模型)
 *   - 自定义端点模式 (endpoint + model + apiKey + dimension + 测试连接)
 *   适配现场使用 qwen3-embedding-8b / OpenAI text-embedding-3-small / Jina / Cohere 等场景.
 */
export function EmbeddingModelConfig({
  providers,
  defaults,
  onSave,
  onTest,
}: EmbeddingModelConfigProps) {
  const [tab, setTab] = useState<EmbeddingTab>("bge-local");

  // --- Tab B: 自定义嵌入端点 ---
  const [customMode, setCustomMode] = useState<CustomMode>("custom-endpoint");
  const [embeddingProviderId, setEmbeddingProviderId] = useState("");
  const [providerTesting, setProviderTesting] = useState(false);
  const [providerTestResult, setProviderTestResult] =
    useState<TestResult | null>(null);

  const [customEndpoint, setCustomEndpoint] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customDimension, setCustomDimension] = useState(1024);
  const [customTesting, setCustomTesting] = useState(false);
  const [customTestResult, setCustomTestResult] =
    useState<TestResult | null>(null);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  // Embedding-capable providers (exclude __custom_embedding__ which is managed by Tab B custom mode)
  const embeddingProviders = providers.filter(
    (p) =>
      p.id !== CUSTOM_EMBEDDING_ID &&
      (p.id.toLowerCase().includes("embed") ||
        p.name.toLowerCase().includes("embed") ||
        (p.model ?? "").toLowerCase().includes("embed") ||
        (p.dimension ?? 0) > 0),
  );

  // 初始化: 根据 defaults.embedding 判断当前应显示哪个 Tab
  useEffect(() => {
    const currentDefault = defaults?.embedding;
    if (!currentDefault) {
      setTab("bge-local");
      return;
    }
    if (currentDefault === CUSTOM_EMBEDDING_ID) {
      setTab("custom");
      setCustomMode("custom-endpoint");
      const p = providers.find((x) => x.id === CUSTOM_EMBEDDING_ID);
      if (p) {
        setCustomEndpoint(p.endpoint ?? "");
        setCustomModel(p.model ?? "");
        setCustomApiKey(p.apiKey ?? "");
        setCustomDimension(p.dimension ?? 1024);
      }
    } else {
      // 非自定义嵌入 Provider — 走"复用 Provider"模式
      setTab("custom");
      setCustomMode("provider");
      setEmbeddingProviderId(currentDefault);
    }
  }, [providers, defaults]);

  // --- 测试连接: 复用 Provider 模式 ---
  const handleProviderTest = async () => {
    if (!embeddingProviderId) return;
    setProviderTesting(true);
    setProviderTestResult(null);
    try {
      const r = await onTest(embeddingProviderId);
      setProviderTestResult(r);
    } catch (err: unknown) {
      setProviderTestResult({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProviderTesting(false);
    }
  };

  const handleProviderSetDefault = async () => {
    if (!embeddingProviderId) return;
    await onSave(embeddingProviderId);
  };

  // --- 测试连接: 自定义端点模式 (直 fetch /embeddings, 自动检测维度) ---
  const handleCustomTest = async () => {
    if (!customEndpoint || !customModel) {
      setCustomTestResult({
        success: false,
        message: "请填写端点地址和模型名称",
      });
      return;
    }
    setCustomTesting(true);
    setCustomTestResult(null);
    try {
      const endpoint = customEndpoint.replace(/\/+$/, "");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (customApiKey) {
        headers["Authorization"] = `Bearer ${customApiKey}`;
      }

      const resp = await fetch(`${endpoint}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: customModel,
          input: ["DeepAnalyze 嵌入模型测试"],
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${text}`.trim());
      }
      const data = await resp.json();
      const dim: number = data?.data?.[0]?.embedding?.length ?? 0;
      if (dim > 0) {
        setCustomDimension(dim); // 自动回填实际维度
      }
      const tokens = data?.usage?.total_tokens ?? "N/A";
      setCustomTestResult({
        success: true,
        message: `连接成功！向量维度: ${dim}，用量: ${tokens} tokens`,
      });
    } catch (err: unknown) {
      setCustomTestResult({
        success: false,
        message: `连接失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setCustomTesting(false);
    }
  };

  // --- 保存: 自定义端点模式 (创建/更新 __custom_embedding__ Provider) ---
  const handleCustomSave = async () => {
    if (!customEndpoint || !customModel) {
      setCustomError("请填写端点地址和模型名称");
      return;
    }
    setCustomSaving(true);
    setCustomError(null);
    try {
      const provider: ProviderConfig = {
        id: CUSTOM_EMBEDDING_ID,
        name: `自定义嵌入 (${customModel})`,
        type: "openai-compatible",
        endpoint: customEndpoint,
        apiKey: customApiKey,
        model: customModel,
        dimension: customDimension,
        maxTokens: customDimension, // v0.6.1 兼容性: 维度同时写入 maxTokens
        supportsToolUse: false,
        enabled: true,
      };
      await api.saveProvider(provider);
      await onSave(CUSTOM_EMBEDDING_ID);
    } catch (err: unknown) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomSaving(false);
    }
  };

  const tabButtonStyle = (isActive: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: "var(--space-2) var(--space-3)",
    border: "1px solid var(--border-primary)",
    borderBottom: isActive ? "none" : "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md) var(--radius-md) 0 0",
    background: isActive ? "var(--bg-primary)" : "var(--bg-secondary)",
    color: isActive ? "var(--interactive)" : "var(--text-secondary)",
    fontSize: "var(--text-sm)",
    fontWeight: isActive ? 500 : 400,
    cursor: "pointer",
  });

  return (
    <div className="embedding-config">
      {/* Tab 切换 */}
      <div style={{ display: "flex", gap: 0, marginBottom: -1 }}>
        <button
          type="button"
          style={tabButtonStyle(tab === "bge-local")}
          onClick={() => setTab("bge-local")}
        >
          BGE-M3 本地部署
        </button>
        <button
          type="button"
          style={tabButtonStyle(tab === "custom")}
          onClick={() => setTab("custom")}
        >
          自定义嵌入端点
        </button>
      </div>

      {/* Tab A: ModuleCard (BGE-M3 本地/远端/禁用三模式) */}
      {tab === "bge-local" && (
        <div
          style={{
            border: "1px solid var(--border-primary)",
            borderTop: "none",
            padding: "var(--space-3)",
            background: "var(--bg-primary)",
            borderRadius: "0 var(--radius-md) var(--radius-md) var(--radius-md)",
          }}
        >
          <ModuleCard moduleId="embedding" />
          <div
            style={{
              marginTop: 8,
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
            }}
          >
            如需使用非 BGE-M3 的嵌入模型（如 qwen3-embedding-8b、OpenAI
            text-embedding-3-small、Jina、Cohere 等），请切换到"自定义嵌入端点" Tab。
          </div>
        </div>
      )}

      {/* Tab B: 自定义嵌入端点 */}
      {tab === "custom" && (
        <div
          style={{
            border: "1px solid var(--border-primary)",
            borderTop: "none",
            padding: "var(--space-3)",
            background: "var(--bg-primary)",
            borderRadius: "0 var(--radius-md) var(--radius-md) var(--radius-md)",
          }}
        >
          {/* 模式切换 */}
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              marginBottom: "var(--space-3)",
            }}
          >
            <button
              type="button"
              className={`btn ${
                customMode === "provider" ? "btn-primary" : "btn-secondary"
              }`}
              onClick={() => setCustomMode("provider")}
            >
              复用已有 Provider
            </button>
            <button
              type="button"
              className={`btn ${
                customMode === "custom-endpoint"
                  ? "btn-primary"
                  : "btn-secondary"
              }`}
              onClick={() => setCustomMode("custom-endpoint")}
            >
              自定义端点
            </button>
          </div>

          {/* 模式 A: 复用 Provider */}
          {customMode === "provider" && (
            <div className="module-card__field">
              <label className="module-card__field">
                <span>选择嵌入模型 Provider</span>
                <select
                  value={embeddingProviderId}
                  onChange={(e) => {
                    setEmbeddingProviderId(e.target.value);
                    setProviderTestResult(null);
                  }}
                >
                  <option value="">— 请选择 —</option>
                  {embeddingProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.model})
                      {p.dimension ? ` [${p.dimension}d]` : ""}
                    </option>
                  ))}
                </select>
              </label>

              {providerTestResult && (
                <div
                  className={`module-card__${
                    providerTestResult.success ? "info-row" : "error-row"
                  }`}
                  style={{
                    color: providerTestResult.success
                      ? "var(--success)"
                      : "var(--danger)",
                  }}
                >
                  {providerTestResult.success ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <XCircle size={14} />
                  )}
                  {providerTestResult.message}
                </div>
              )}

              <div className="module-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleProviderTest}
                  disabled={!embeddingProviderId || providerTesting}
                >
                  {providerTesting ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Wifi size={14} />
                  )}
                  测试连接
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleProviderSetDefault}
                  disabled={
                    !embeddingProviderId ||
                    defaults?.embedding === embeddingProviderId
                  }
                >
                  设为默认嵌入模型
                </button>
              </div>
            </div>
          )}

          {/* 模式 B: 自定义端点 */}
          {customMode === "custom-endpoint" && (
            <div>
              <label className="module-card__field">
                <span>端点地址</span>
                <input
                  type="text"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </label>

              <label className="module-card__field">
                <span>模型名称</span>
                <input
                  type="text"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="qwen3-embedding-8b, text-embedding-3-small, bge-m3"
                />
              </label>

              <label className="module-card__field">
                <span>API Key（可选，本地服务可留空）</span>
                <input
                  type="password"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder="sk-… (本地服务可留空)"
                />
              </label>

              <label className="module-card__field">
                <span>向量维度</span>
                <input
                  type="number"
                  min={1}
                  max={8192}
                  value={customDimension}
                  onChange={(e) =>
                    setCustomDimension(
                      Math.max(1, Math.min(8192, Number(e.target.value) || 1024)),
                    )
                  }
                />
                <small style={{ color: "var(--text-tertiary)" }}>
                  点击"测试连接"会自动检测实际维度并回填
                </small>
              </label>

              {customTestResult && (
                <div
                  className="module-card__info-row"
                  style={{
                    color: customTestResult.success
                      ? "var(--success)"
                      : "var(--danger)",
                  }}
                >
                  {customTestResult.success ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <XCircle size={14} />
                  )}
                  {customTestResult.message}
                </div>
              )}

              {customError && (
                <div className="module-card__error">
                  <AlertCircle size={14} /> {customError}
                </div>
              )}

              <div className="module-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCustomTest}
                  disabled={customTesting}
                >
                  {customTesting ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Wifi size={14} />
                  )}
                  测试连接
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleCustomSave}
                  disabled={customSaving}
                >
                  <Save size={14} /> {customSaving ? "保存中…" : "保存配置"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
