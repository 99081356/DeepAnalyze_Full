// =============================================================================
// DeepAnalyze - ModelConfigCard Component
// Reusable card for configuring a model role (main/sub/embedding)
// =============================================================================

import { useState, useEffect } from "react";
import type { ProviderConfig, ProviderMetadata } from "../../types/index";
import { CheckCircle2, XCircle, Wifi } from "lucide-react";

export interface ModelConfigCardProps {
  title: string;
  description?: string;
  providerId: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxTokensLimit?: number;
  enabled: boolean;
  showEnable?: boolean;
  providers: ProviderConfig[];
  /** Provider registry entries for auto-filling defaults when a provider is selected */
  registry?: ProviderMetadata[];
  onConfigChange: (config: {
    providerId: string;
    model: string;
    temperature: number;
    maxTokens: number;
    enabled: boolean;
  }) => void;
  onTest: () => void;
  testing?: boolean;
  testResult?: { success: boolean; message: string } | null;
  extra?: React.ReactNode;
  /** Whether thinking/reasoning mode is enabled */
  thinkingEnabled?: boolean;
  /** Callback when thinking mode changes */
  onThinkingChange?: (enabled: boolean) => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--radius-lg)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-primary)",
  color: "var(--text-primary)",
  outline: "none",
  boxSizing: "border-box",
  transition: "border-color var(--transition-fast)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--font-medium)",
  color: "var(--text-secondary)",
  marginBottom: "var(--space-1)",
};

export function ModelConfigCard({
  title,
  description,
  providerId,
  model,
  temperature,
  maxTokens,
  maxTokensLimit = 0,
  enabled,
  showEnable = false,
  providers,
  registry = [],
  onConfigChange,
  onTest,
  testing = false,
  testResult = null,
  extra,
  thinkingEnabled,
  onThinkingChange,
}: ModelConfigCardProps) {
  const emit = (patch: Partial<Parameters<ModelConfigCardProps["onConfigChange"]>[0]>) => {
    onConfigChange({ providerId, model, temperature, maxTokens, enabled, ...patch });
  };

  /** Look up default model from the provider registry for a given provider ID */
  const getDefaultModel = (pid: string): string => {
    const meta = registry.find((r) => r.id === pid);
    return meta?.defaultModel ?? "";
  };

  return (
    <div style={{
      padding: "var(--space-4)",
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-xl)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: description ? "var(--space-2)" : "var(--space-4)" }}>
        <div>
          <h3 style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-semibold)",
            color: "var(--text-primary)",
            margin: 0,
          }}>
            {title}
          </h3>
          {description && (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: "var(--space-1)", margin: 0, paddingTop: 2 }}>
              {description}
            </p>
          )}
        </div>
        {showEnable && (
          <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer", flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => emit({ enabled: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: "var(--interactive)" }}
            />
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>启用</span>
          </label>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {/* Provider selector */}
        <div>
          <label style={labelStyle}>提供商</label>
          <select
            value={providerId}
            onChange={(e) => {
              const selectedId = e.target.value;
              const configured = providers.find((pr) => pr.id === selectedId);
              // Use the configured model if available, otherwise fall back to registry default
              const newModel = configured?.model || getDefaultModel(selectedId);
              emit({ providerId: selectedId, model: newModel });
            }}
            style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}
          >
            <option value="">-- 选择提供商 --</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Model name */}
        <div>
          <label style={labelStyle}>模型名称</label>
          {(() => {
            const meta = registry.find((r) => r.id === providerId);
            const availableModels = meta?.models ?? [];
            if (availableModels.length > 0) {
              // Show a datalist for known providers to guide model selection
              const listId = `models-${providerId}`;
              return (
                <div style={{ display: "flex", gap: "var(--space-1)" }}>
                  <input
                    list={listId}
                    type="text"
                    value={model}
                    onChange={(e) => emit({ model: e.target.value })}
                    placeholder={meta?.defaultModel || "模型 ID"}
                    style={{ ...inputStyle, flex: 1 }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "var(--interactive-light)"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
                  />
                  <datalist id={listId}>
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </datalist>
                </div>
              );
            }
            return (
              <input
                type="text"
                value={model}
                onChange={(e) => emit({ model: e.target.value })}
                placeholder="模型 ID，如 gpt-4o, deepseek-chat"
                style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--interactive-light)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
              />
            );
          })()}
        </div>

        {/* Temperature slider */}
        <div>
          <label style={labelStyle}>
            温度: <span style={{ color: "var(--interactive)", fontWeight: 600 }}>{temperature.toFixed(1)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(e) => emit({ temperature: parseFloat(e.target.value) })}
            style={{ width: "100%", accentColor: "var(--interactive)" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            <span>精确 (0)</span>
            <span>创意 (2)</span>
          </div>
        </div>

        {/* Thinking/Reasoning toggle */}
        {(() => {
          const meta = registry.find((r) => r.id === providerId);
          const modelMeta = meta?.models?.find((m) => m.id === model);
          return modelMeta?.thinkingSupport && modelMeta.thinkingSupport !== 'unsupported' ? (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
              <label style={{ ...labelStyle, margin: 0 }}>
                Thinking / 推理模式
              </label>
              <input
                type="checkbox"
                checked={thinkingEnabled}
                onChange={(e) => onThinkingChange?.(e.target.checked)}
                style={{ accentColor: "var(--interactive)" }}
              />
              {modelMeta.thinkingSupport === 'experimental' && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>(实验性)</span>
              )}
            </div>
          ) : null;
        })()}

        {/* Max Tokens */}
        <div>
          <label style={labelStyle}>最大 Tokens</label>
          <input
            type="number"
            value={maxTokens}
            min={0}
            max={maxTokensLimit}
            onChange={(e) => emit({ maxTokens: parseInt(e.target.value) || 0 })}
            style={inputStyle}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--interactive-light)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
          />
          <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, marginTop: 2 }}>设为 0 表示由 API 自动决定（推荐）</p>
        </div>

        {/* Test result */}
        {testResult && (
          <div style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--space-2)",
            padding: "8px var(--space-3)",
            borderRadius: "var(--radius-lg)",
            fontSize: "var(--text-sm)",
            background: testResult.success ? "var(--success-light)" : "var(--error-light)",
            border: `1px solid ${testResult.success ? "var(--success)" : "var(--error)"}`,
            color: testResult.success ? "var(--success)" : "var(--error)",
          }}>
            {testResult.success ? <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} /> : <XCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />}
            <span>{testResult.message}</span>
          </div>
        )}

        {/* Test button */}
        <div>
          <button
            onClick={onTest}
            disabled={testing || !providerId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              padding: "var(--space-2) var(--space-4)",
              background: "var(--bg-hover)",
              color: "var(--text-secondary)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-medium)",
              borderRadius: "var(--radius-lg)",
              border: "none",
              cursor: testing || !providerId ? "not-allowed" : "pointer",
              opacity: testing || !providerId ? 0.5 : 1,
              transition: "background var(--transition-fast)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-tertiary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          >
            <Wifi size={14} />
            {testing ? "测试中..." : "测试连接"}
          </button>
        </div>

        {/* Extra slot */}
        {extra}
      </div>
    </div>
  );
}
