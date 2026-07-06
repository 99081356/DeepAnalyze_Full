import { useEffect, useRef, useState } from "react";
import { Save, Star } from "lucide-react";
import { ModuleCard } from "./ModuleCard";
import { ModelConfigCard } from "./ModelConfigCard";
import { api } from "../../api/client";
import type {
  ProviderConfig,
  ProviderDefaults,
  ProviderMetadata,
} from "../../types/index.js";

interface ASRModelConfigProps {
  providers: ProviderConfig[];
  defaults: ProviderDefaults | null;
  registry: ProviderMetadata[];
  onSetDefault: (role: string, providerId: string) => void;
  onSaveProvider: (provider: ProviderConfig) => Promise<void>;
}

/**
 * ASR (Whisper) 配置 — 双视图.
 *
 * 上半部分: ModuleCard (本地 Whisper 部署 install/start/stop + 远端 OpenAI 兼容端点)
 * 下半部分: 基于 ModelConfigCard 的 Provider 配置区
 *          (provider 选择 + model + temperature + maxTokens + enabled + 测试)
 *
 * 数据流:
 * - 本地部署生命周期 → /api/modules/asr/*
 * - Provider 推理参数 → /api/settings/providers/:id
 * - 默认 ASR Provider → /api/settings/defaults (audio_transcribe 角色)
 */
export function ASRModelConfig({
  providers,
  defaults,
  registry,
  onSetDefault,
  onSaveProvider,
}: ASRModelConfigProps) {
  const defaultId = defaults?.audio_transcribe ?? "";
  const currentProvider = providers.find((p) => p.id === defaultId);

  const [providerId, setProviderId] = useState(defaultId);
  const [model, setModel] = useState(currentProvider?.model ?? "");
  const [temperature, setTemperature] = useState(
    currentProvider?.temperature ?? 0,
  );
  const [maxTokens, setMaxTokens] = useState(currentProvider?.maxTokens ?? 0);
  const [enabled, setEnabled] = useState(currentProvider?.enabled ?? false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const originalRef = useRef({ model, temperature, maxTokens });
  const [savedSnapshot, setSavedSnapshot] = useState({
    model,
    temperature,
    maxTokens,
  });

  // 当 defaults.audio_transcribe 切换时，重置到新的 provider
  useEffect(() => {
    const p = providers.find((x) => x.id === defaultId);
    setProviderId(defaultId);
    setModel(p?.model ?? "");
    setTemperature(p?.temperature ?? 0);
    setMaxTokens(p?.maxTokens ?? 0);
    setEnabled(p?.enabled ?? false);
    originalRef.current = {
      model: p?.model ?? "",
      temperature: p?.temperature ?? 0,
      maxTokens: p?.maxTokens ?? 0,
    };
    setSavedSnapshot(originalRef.current);
    setTestResult(null);
  }, [defaultId, providers]);

  const isDirty =
    !!providerId &&
    (model !== savedSnapshot.model ||
      temperature !== savedSnapshot.temperature ||
      maxTokens !== savedSnapshot.maxTokens);

  const handleConfigChange = (cfg: {
    providerId: string;
    model: string;
    temperature: number;
    maxTokens: number;
    enabled: boolean;
  }) => {
    setProviderId(cfg.providerId);
    setModel(cfg.model);
    setTemperature(cfg.temperature);
    setMaxTokens(cfg.maxTokens);
    setEnabled(cfg.enabled);
  };

  const handleTest = async () => {
    if (!providerId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testProvider(providerId);
      setTestResult({
        success: r.success,
        message: r.success ? "ASR Provider 连接成功!" : (r.error ?? "连接失败"),
      });
    } catch (err: unknown) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!providerId) return;
    const p = providers.find((x) => x.id === providerId);
    if (!p) return;
    const updated: ProviderConfig = {
      ...p,
      model,
      temperature,
      maxTokens,
      enabled,
    };
    await onSaveProvider(updated);
    originalRef.current = { model, temperature, maxTokens };
    setSavedSnapshot({ model, temperature, maxTokens });
  };

  const handleSetDefault = () => {
    if (!providerId) return;
    onSetDefault("audio_transcribe", providerId);
  };

  return (
    <div className="asr-config">
      {/* 上半部分: ModuleCard (本地 Whisper 部署) */}
      <ModuleCard moduleId="asr" />

      {/* 下半部分: Provider 推理参数配置 */}
      <div style={{ marginTop: 12 }}>
        <ModelConfigCard
          title="ASR Provider 推理参数"
          description="选择一个 OpenAI 兼容 Whisper 端点作为 ASR 服务，可调节推理参数。本地 Whisper 部署由上方卡片管理。"
          providerId={providerId}
          model={model}
          temperature={temperature}
          maxTokens={maxTokens}
          maxTokensLimit={0}
          enabled={enabled}
          showEnable={true}
          providers={providers}
          registry={registry}
          onConfigChange={handleConfigChange}
          onTest={handleTest}
          testing={testing}
          testResult={testResult}
          extra={
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                marginTop: "var(--space-2)",
              }}
            >
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSave}
                disabled={!providerId || !isDirty}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "var(--space-2) var(--space-4)",
                  background: isDirty ? "var(--interactive)" : "var(--bg-hover)",
                  color: isDirty ? "white" : "var(--text-tertiary)",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--font-medium)",
                  borderRadius: "var(--radius-lg)",
                  border: "none",
                  cursor: isDirty ? "pointer" : "not-allowed",
                  opacity: providerId ? 1 : 0.5,
                  transition: "background var(--transition-fast)",
                }}
              >
                <Save size={14} />
                {isDirty ? "保存配置" : "无变更"}
              </button>
              {enabled && defaults?.audio_transcribe !== providerId && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleSetDefault}
                  disabled={!providerId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "var(--space-2) var(--space-4)",
                  }}
                >
                  <Star size={14} />
                  设为默认 ASR 模型
                </button>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
