// =============================================================================
// DeepAnalyze - VLMModelConfig
// Vision Language Model configuration (图像理解模型)
// =============================================================================

import { useState, useEffect, useRef } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ModelConfigCard } from "./ModelConfigCard";
import type { ProviderConfig, ProviderDefaults, ProviderMetadata } from "../../types/index";
import { ShieldCheck, Save } from "lucide-react";

interface VLMModelConfigProps {
  providers: ProviderConfig[];
  defaults: ProviderDefaults | null;
  registry: ProviderMetadata[];
  onSetDefault: (role: string, providerId: string) => void;
  onSaveProvider: (provider: ProviderConfig) => Promise<void>;
}

export function VLMModelConfig({ providers, defaults, registry, onSetDefault, onSaveProvider }: VLMModelConfigProps) {
  const { success, error: showError } = useToast();

  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState(0.5);
  const [maxTokens, setMaxTokens] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Track original values for dirty detection
  const originalRef = useRef({ model: "", temperature: 0.5, maxTokens: 0 });

  // Initialize from defaults
  useEffect(() => {
    const defaultId = defaults?.vlm;
    if (defaultId) {
      const p = providers.find((pr) => pr.id === defaultId);
      const initModel = p?.model ?? "";
      const initTemp = p?.temperature ?? 0.5;
      const initMaxTokens = p?.maxTokens ?? 0;
      setProviderId(defaultId);
      setModel(initModel);
      setTemperature(initTemp);
      setMaxTokens(initMaxTokens);
      setEnabled(true);
      originalRef.current = { model: initModel, temperature: initTemp, maxTokens: initMaxTokens };
    }
  }, [defaults, providers]);

  const isDirty = providerId && (
    model !== originalRef.current.model ||
    temperature !== originalRef.current.temperature ||
    maxTokens !== originalRef.current.maxTokens
  );

  const handleConfigChange = (config: { providerId: string; model: string; temperature: number; maxTokens: number; enabled: boolean }) => {
    if (config.providerId !== providerId) {
      const p = providers.find((pr) => pr.id === config.providerId);
      const newModel = config.model;
      const newTemp = p?.temperature ?? 0.5;
      const newMaxTokens = p?.maxTokens ?? 0;
      setTemperature(newTemp);
      setMaxTokens(newMaxTokens);
      originalRef.current = { model: newModel, temperature: newTemp, maxTokens: newMaxTokens };
    }
    setProviderId(config.providerId);
    setModel(config.model);
    setTemperature(config.temperature);
    setMaxTokens(config.maxTokens);
    setEnabled(config.enabled);
  };

  const handleTest = async () => {
    if (!providerId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProvider(providerId);
      setTestResult({
        success: result.success,
        message: result.success ? "连接成功!" : result.error ?? "连接失败",
      });
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : "连接失败" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!providerId) return;
    const p = providers.find((pr) => pr.id === providerId);
    if (!p) return;
    setSaving(true);
    try {
      const updated: ProviderConfig = {
        ...p,
        model,
        temperature,
        maxTokens,
        enabled,
      };
      await onSaveProvider(updated);
      originalRef.current = { model, temperature, maxTokens };
      success("VLM 模型配置已保存");
    } catch (err) {
      showError("保存失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const defaultProvider = defaults?.vlm ? providers.find((p) => p.id === defaults.vlm) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {defaultProvider && (
        <div style={{
          padding: "var(--space-2) var(--space-3)",
          background: "var(--interactive-light)",
          border: "1px solid var(--interactive-light)",
          borderRadius: "var(--radius-lg)",
          fontSize: "var(--text-sm)",
        }}>
          <span style={{ color: "var(--text-tertiary)" }}>当前 VLM 模型:</span>{" "}
          <span style={{ fontWeight: "var(--font-medium)", color: "var(--interactive)" }}>
            {defaultProvider.name} / {defaultProvider.model}
          </span>
        </div>
      )}

      <ModelConfigCard
        title="VLM 图像理解模型"
        description="用于图片视觉理解的 VLM 模型，支持图片描述、OCR、内容分析等。"
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
          <>
            {/* Save + Set as default buttons */}
            <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              {/* Save config button */}
              {providerId && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "var(--space-2) var(--space-4)",
                    background: isDirty ? "var(--interactive)" : "var(--bg-hover)",
                    color: isDirty ? "white" : "var(--text-secondary)",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--font-medium)",
                    borderRadius: "var(--radius-lg)",
                    border: isDirty ? "1px solid var(--interactive)" : "1px solid var(--border-primary)",
                    cursor: saving ? "not-allowed" : "pointer",
                    opacity: saving ? 0.6 : 1,
                    transition: "all var(--transition-fast)",
                  }}
                >
                  <Save size={14} />
                  {saving ? "保存中..." : "保存配置"}
                </button>
              )}

              {/* Set as default */}
              {providerId && enabled && defaults?.vlm !== providerId && (
                <button
                  onClick={() => onSetDefault("vlm", providerId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "var(--space-2) var(--space-4)",
                    background: "var(--success-light)",
                    color: "var(--success)",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--font-medium)",
                    borderRadius: "var(--radius-lg)",
                    border: "none",
                    cursor: "pointer",
                    transition: "opacity var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                >
                  <ShieldCheck size={14} />
                  设为默认 VLM 模型
                </button>
              )}
            </div>
          </>
        }
      />
    </div>
  );
}
