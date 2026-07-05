// =============================================================================
// DeepAnalyze - SubModelConfig
// Auxiliary/sub model configuration (辅助模型)
// =============================================================================

import { useState, useEffect, useRef } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ModelConfigCard } from "./ModelConfigCard";
import type { ProviderConfig, ProviderDefaults, ProviderMetadata } from "../../types/index";
import { ShieldCheck, Save } from "lucide-react";

interface SubModelConfigProps {
  providers: ProviderConfig[];
  defaults: ProviderDefaults | null;
  registry: ProviderMetadata[];
  onSetDefault: (role: string, providerId: string) => void;
  onSaveProvider: (provider: ProviderConfig) => Promise<void>;
}

export function SubModelConfig({ providers, defaults, registry, onSetDefault, onSaveProvider }: SubModelConfigProps) {
  const { success, error: showError } = useToast();

  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState(1.0);
  const [maxTokens, setMaxTokens] = useState(0);
  const [enabled, setEnabled] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Track original values for dirty detection
  const originalRef = useRef({ model: "", temperature: 1.0, maxTokens: 0 });

  /** Look up recommended temperature from registry for a provider+model combo */
  const getRegistryDefaults = (pid: string) => {
    const meta = registry.find((r) => r.id === pid);
    const modelMeta = meta?.models?.find((m) => m.id === model);
    return {
      temperature: modelMeta?.recommendedTemperature?.default ?? 1.0,
      maxTokens: meta?.recommendedMaxTokens ?? 0,
      contextWindow: meta?.contextWindow ?? 200000,
    };
  };

  // Initialize from defaults
  useEffect(() => {
    if (defaults?.summarizer) {
      const p = providers.find((pr) => pr.id === defaults.summarizer);
      const regDefaults = getRegistryDefaults(defaults.summarizer);
      const initModel = p?.model ?? "";
      const initTemp = p?.temperature ?? regDefaults.temperature;
      const initMaxTokens = p?.maxTokens ?? regDefaults.maxTokens;
      setProviderId(defaults.summarizer);
      setModel(initModel);
      setTemperature(initTemp);
      setMaxTokens(initMaxTokens);
      setEnabled(p?.enabled ?? true);
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
      const regDefaults = getRegistryDefaults(config.providerId);
      const newModel = config.model;
      // Use saved provider config if available, otherwise registry defaults
      const newTemp = p?.temperature ?? regDefaults.temperature;
      const newMaxTokens = p?.maxTokens ?? regDefaults.maxTokens;
      setTemperature(newTemp);
      setMaxTokens(newMaxTokens);
      // Auto-enable when a provider is selected
      setEnabled(true);
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
      // Auto-set as default summarizer if not already assigned
      if (defaults?.summarizer !== providerId) {
        await onSetDefault("summarizer", providerId);
      }
      originalRef.current = { model, temperature, maxTokens };
      success("辅助模型配置已保存");
    } catch (err) {
      showError("保存失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const defaultProvider = defaults?.summarizer ? providers.find((p) => p.id === defaults.summarizer) : null;

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
          <span style={{ color: "var(--text-tertiary)" }}>当前辅助模型:</span>{" "}
          <span style={{ fontWeight: "var(--font-medium)", color: "var(--interactive)" }}>
            {defaultProvider.name} / {defaultProvider.model}
          </span>
        </div>
      )}

      <ModelConfigCard
        title="辅助模型"
        description="用于文档编译、摘要生成等轻量任务的辅助模型（对应 summarizer 角色）。"
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
            {/* Max concurrent slider */}
            <div style={{ marginTop: "var(--space-2)" }}>
              <label style={{ display: "block", fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", color: "var(--text-secondary)", marginBottom: "var(--space-1)" }}>
                最大并发: <span style={{ color: "var(--interactive)", fontWeight: 600 }}>{maxConcurrent}</span>
              </label>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(parseInt(e.target.value))}
                style={{ width: "100%", accentColor: "var(--interactive)" }}
              />
            </div>

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
              {providerId && enabled && defaults?.summarizer !== providerId && (
                <button
                  onClick={() => onSetDefault("summarizer", providerId)}
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
                  设为默认辅助模型
                </button>
              )}
            </div>
          </>
        }
      />
    </div>
  );
}
