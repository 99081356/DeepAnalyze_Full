// =============================================================================
// DeepAnalyze - MainModelConfig
// Main agent model configuration (主模型)
// =============================================================================

import { useState, useEffect, useRef } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ModelConfigCard } from "./ModelConfigCard";
import type { ProviderConfig, ProviderDefaults, ProviderMetadata } from "../../types/index";
import { ShieldCheck, Save } from "lucide-react";

interface MainModelConfigProps {
  providers: ProviderConfig[];
  defaults: ProviderDefaults | null;
  registry: ProviderMetadata[];
  onSetDefault: (role: string, providerId: string) => void;
  onSaveProvider: (provider: ProviderConfig) => Promise<void>;
}

export function MainModelConfig({ providers, defaults, registry, onSetDefault, onSaveProvider }: MainModelConfigProps) {
  const { success, error: showError } = useToast();

  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState(1.0);
  const [maxTokens, setMaxTokens] = useState(0);
  const [maxIterations, setMaxIterations] = useState(50);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Track original values for dirty detection
  const originalRef = useRef({ model: "", temperature: 1.0, maxTokens: 0 });

  /** Look up recommended temperature from registry for a provider */
  const getRegistryDefaults = (pid: string) => {
    const meta = registry.find((r) => r.id === pid);
    const modelMeta = meta?.models?.find((m) => m.id === model);
    return {
      temperature: modelMeta?.recommendedTemperature?.default ?? 1.0,
      maxTokens: meta?.recommendedMaxTokens ?? 0,
    };
  };

  // Initialize from defaults
  useEffect(() => {
    if (defaults?.main) {
      const p = providers.find((pr) => pr.id === defaults.main);
      const regDefaults = getRegistryDefaults(defaults.main);
      const initModel = p?.model ?? "";
      const initTemp = p?.temperature ?? regDefaults.temperature;
      const initMaxTokens = p?.maxTokens ?? regDefaults.maxTokens;
      setProviderId(defaults.main);
      setModel(initModel);
      setTemperature(initTemp);
      setMaxTokens(initMaxTokens);
      originalRef.current = { model: initModel, temperature: initTemp, maxTokens: initMaxTokens };
    }
  }, [defaults, providers]);

  const isDirty = providerId && (
    model !== originalRef.current.model ||
    temperature !== originalRef.current.temperature ||
    maxTokens !== originalRef.current.maxTokens
  );

  const handleConfigChange = (config: { providerId: string; model: string; temperature: number; maxTokens: number }) => {
    if (config.providerId !== providerId) {
      // Provider changed — use saved config or registry defaults
      const p = providers.find((pr) => pr.id === config.providerId);
      const regDefaults = getRegistryDefaults(config.providerId);
      const newModel = config.model;
      const newTemp = p?.temperature ?? regDefaults.temperature;
      const newMaxTokens = p?.maxTokens ?? regDefaults.maxTokens;
      setTemperature(newTemp);
      setMaxTokens(newMaxTokens);
      originalRef.current = { model: newModel, temperature: newTemp, maxTokens: newMaxTokens };
    }
    setProviderId(config.providerId);
    setModel(config.model);
    setTemperature(config.temperature);
    setMaxTokens(config.maxTokens);
  };

  const handleTest = async () => {
    if (!providerId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProvider(providerId);
      setTestResult({
        success: result.success,
        message: result.success
          ? result.models?.length
            ? `连接成功! 可用模型: ${result.models.slice(0, 5).join(", ")}`
            : "连接成功!"
          : result.error ?? "连接失败",
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
      };
      await onSaveProvider(updated);
      originalRef.current = { model, temperature, maxTokens };
      success("主模型配置已保存");
    } catch (err) {
      showError("保存失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // Current default info banner
  const defaultProvider = defaults?.main ? providers.find((p) => p.id === defaults.main) : null;

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
          <span style={{ color: "var(--text-tertiary)" }}>当前主模型:</span>{" "}
          <span style={{ fontWeight: "var(--font-medium)", color: "var(--interactive)" }}>
            {defaultProvider.name} / {defaultProvider.model}
          </span>
        </div>
      )}

      <ModelConfigCard
        title="主模型"
        description="主要对话和分析使用的模型，承担核心任务处理。"
        providerId={providerId}
        model={model}
        temperature={temperature}
        maxTokens={maxTokens}
        maxTokensLimit={0}
        enabled={true}
        providers={providers}
        registry={registry}
        onConfigChange={handleConfigChange}
        onTest={handleTest}
        testing={testing}
        testResult={testResult}
        extra={
          <>
            {/* Max iterations slider */}
            <div style={{ marginTop: "var(--space-2)" }}>
              <label style={{ display: "block", fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", color: "var(--text-secondary)", marginBottom: "var(--space-1)" }}>
                最大迭代: <span style={{ color: "var(--interactive)", fontWeight: 600 }}>{maxIterations}</span>
              </label>
              <input
                type="range"
                min={1}
                max={9999}
                step={1}
                value={maxIterations}
                onChange={(e) => setMaxIterations(parseInt(e.target.value))}
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

              {/* Set as default button */}
              {providerId && defaults?.main !== providerId && (
                <button
                  onClick={() => onSetDefault("main", providerId)}
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
                  设为默认主模型
                </button>
              )}
            </div>
          </>
        }
      />
    </div>
  );
}
