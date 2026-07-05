// =============================================================================
// DeepAnalyze - SettingsPanel Component
// Settings panel with internal left sidebar navigation
// Designed for rendering inside the RightPanel
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import type { ProviderConfig, ProviderSettings, ProviderMetadata, ProviderDefaults, AgentSettings } from "../../types/index";
import { ChannelsPanel } from "../channels/ChannelsPanel";
import { useToast } from "../../hooks/useToast";
import { useUIStore, type ThemeMode } from "../../store/ui";
import { useHubStore } from "../../store/hub";
import { ModelsPanel } from "./ModelsPanel";
import { MCPServersPanel } from "./MCPServersPanel";
import { Spinner } from "../ui/Spinner";
import {
  CheckCircle2,
  XCircle,
  Trash2,
  Star,
  Save,
  Wifi,
  ShieldCheck,
  Server,
  Globe,
  Info,
  Settings2,
  Plus,
  MessageCircle,
  Cloud,
  RefreshCw,
} from "lucide-react";
import { AuthPanel } from "./AuthPanel";
import { HubConnectionPanel } from "./HubConnectionPanel";
import { ConfigSyncPanel } from "./ConfigSyncPanel";

// ---------------------------------------------------------------------------
// Settings tab type
// ---------------------------------------------------------------------------

type SettingsTabId = "models" | "channels" | "mcp" | "general" | "auth" | "hub" | "sync";

const settingsTabs: { id: SettingsTabId; label: string; icon: React.ReactNode }[] = [
  { id: "models", label: "模型配置", icon: <Server size={16} /> },
  { id: "channels", label: "通信渠道", icon: <MessageCircle size={16} /> },
  { id: "mcp", label: "MCP 服务", icon: <Cloud size={16} /> },
  { id: "general", label: "通用", icon: <Globe size={16} /> },
  { id: "auth", label: "认证", icon: <ShieldCheck size={16} /> },
  { id: "hub", label: "Hub", icon: <Cloud size={16} /> },
  { id: "sync", label: "配置同步", icon: <RefreshCw size={16} /> },
];

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SettingsPanel
// ---------------------------------------------------------------------------

export function SettingsPanel() {
  const { success, error: showError } = useToast();
  const themeMode = useUIStore((s) => s.themeMode);
  const setThemeMode = useUIStore((s) => s.setThemeMode);
  const isWorkerMode = useHubStore((s) => s.isWorkerMode);
  const syncState = useHubStore((s) => s.syncState);
  const syncing = useHubStore((s) => s.syncing);
  const hubSyncConfig = useHubStore((s) => s.syncConfig);

  const [activeTab, setActiveTab] = useState<SettingsTabId>("models");

  // Provider data (shared across sub-tabs)
  const [registry, setRegistry] = useState<ProviderMetadata[]>([]);
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState(""); // Registry type ID
  const [configId, setConfigId] = useState(""); // Unique config ID (user-defined)
  const [configName, setConfigName] = useState(""); // Display name
  const [apiKey, setApiKey] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [modelName, setModelName] = useState("");
  const [maxTokens, setMaxTokens] = useState(0);
  const [temperature, setTemperature] = useState(1.0);
  const [contextWindow, setContextWindow] = useState(200000);
  const [enabled, setEnabled] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // About tab state
  const [healthInfo, setHealthInfo] = useState<{ status: string; version: string } | null>(null);

  // Per-provider API key presence from /api/health (used to badge providers
  // that are configured but missing an API key). See issue #79.
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});

  // Agent settings
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [agentSaving, setAgentSaving] = useState(false);

  // Load data
  const loadData = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const [regData, settingsData, healthData] = await Promise.all([
        api.getProviderRegistry(),
        api.getProviders(),
        api.health().catch(() => null), // non-fatal — badges just stay hidden
      ]);
      setRegistry(regData);
      setSettings(settingsData);
      if (healthData) {
        const map: Record<string, boolean> = {};
        for (const p of healthData.llm?.providersWithKey ?? []) {
          map[p.id] = p.hasKey;
        }
        setKeyStatus(map);
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-fill form when editing an existing config (configId changes)
  useEffect(() => {
    if (!configId || !settings) return;
    const configured = settings.providers.find((p) => p.id === configId);
    if (!configured) return;
    const meta = registry.find((p) => p.id === (configured.registryId ?? configured.id));

    setSelectedProvider(configured.registryId ?? configured.id);
    setConfigName(configured.name);
    setApiKey(configured.apiKey);
    setApiBase(configured.endpoint);
    setModelName(configured.model);
    setMaxTokens(configured.maxTokens ?? 0);
    const modelMeta = meta?.models?.find((m) => m.id === configured.model);
    setTemperature(configured.temperature ?? modelMeta?.recommendedTemperature?.default ?? 1.0);
    setContextWindow(configured.contextWindow ?? meta?.contextWindow ?? 200000);
    setEnabled(configured.enabled);
    setTestResult(null);
  }, [configId, settings, registry]);

  // When provider type changes (new config), reset form with defaults
  useEffect(() => {
    if (!selectedProvider || configId) return; // Don't reset if editing existing
    const meta = registry.find((p) => p.id === selectedProvider);
    setConfigName("");
    setUserCustomizedName(false);
    setApiKey("");
    setApiBase(meta?.apiBase ?? "");
    setModelName(meta?.defaultModel ?? "");
    setMaxTokens(meta?.recommendedMaxTokens ?? 0);
    const defaultModelMeta = meta?.models?.find((m) => m.id === meta?.defaultModel);
    setTemperature(defaultModelMeta?.recommendedTemperature?.default ?? 1.0);
    setContextWindow(meta?.contextWindow ?? 200000);
    setEnabled(true);
    setTestResult(null);
  }, [selectedProvider, configId, registry]);

  // Auto-generate configName when model name changes (only for new configs without user-set name)
  const [userCustomizedName, setUserCustomizedName] = useState(false);
  useEffect(() => {
    if (configId || userCustomizedName || !modelName || !selectedProvider) return;
    const meta = registry.find((p) => p.id === selectedProvider);
    const providerLabel = meta?.name ?? selectedProvider;
    setConfigName(`${providerLabel}+${modelName}`);
  }, [modelName, selectedProvider, configId, userCustomizedName, registry]);

  // Initialize with current default
  useEffect(() => {
    if (settings && !selectedProvider) {
      if (settings.defaults.main) {
        const defaultProvider = settings.providers.find((p) => p.id === settings.defaults.main);
        if (defaultProvider) {
          setSelectedProvider(defaultProvider.registryId ?? defaultProvider.id);
          setConfigId(defaultProvider.id);
        } else {
          setSelectedProvider(settings.defaults.main);
        }
      } else if (settings.providers.length > 0) {
        const first = settings.providers[0];
        setSelectedProvider(first.registryId ?? first.id);
        setConfigId(first.id);
      }
    }
  }, [settings, selectedProvider]);

  // Load health info
  useEffect(() => {
    api.health().then((info) => setHealthInfo(info)).catch(() => setHealthInfo(null));
  }, []);

  // Load agent settings when general tab is active
  useEffect(() => {
    if (activeTab !== "general") return;
    api.getAgentSettings().then((s) => setAgentSettings(s)).catch(() => setAgentSettings(null));
  }, [activeTab]);

  const currentMeta = registry.find((p) => p.id === selectedProvider);
  const isLocal = currentMeta?.isLocal ?? false;

  // Determine the effective config ID for saving: use configId if editing, or derive from configName
  const effectiveConfigId = configId || configName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-");

  // --- Provider CRUD handlers ---

  /** Internal save without user-facing toast (used by test button) */
  const handleSaveInternal = async () => {
    if (!selectedProvider) return;
    const id = effectiveConfigId;
    if (!id) {
      throw new Error("请填写模型名称以自动生成配置 ID");
    }
    const provider: ProviderConfig = {
      id,
      name: configName || currentMeta?.name || id,
      type: "openai-compatible",
      registryId: selectedProvider,
      endpoint: apiBase,
      apiKey,
      model: modelName,
      maxTokens: maxTokens > 0 ? maxTokens : undefined,
      temperature,
      contextWindow,
      supportsToolUse: true,
      enabled,
    };
    await api.saveProvider(provider);
    setConfigId(id);
    await loadData();
  };

  const handleSave = async () => {
    if (!selectedProvider) return;
    setSaving(true);
    try {
      await handleSaveInternal();
      success("配置已保存");
    } catch {
      showError("保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!selectedProvider) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Save first so test endpoint can read current config from DB
      await handleSaveInternal();
      const result = await api.testProvider(effectiveConfigId);
      setTestResult({
        success: result.success,
        message: result.success
          ? result.models && result.models.length > 0
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

  const handleSetDefault = async (role: string) => {
    try {
      await api.saveDefaults({ [role]: effectiveConfigId });
      success("默认模型已更新");
      await loadData();
    } catch {
      showError("更新默认模型失败");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteProvider(id);
      success("提供商已删除");
      if (configId === id) {
        setConfigId("");
      }
      await loadData();
    } catch {
      showError("删除失败");
    }
  };

  const handleAgentSave = async () => {
    if (!agentSettings) return;
    setAgentSaving(true);
    try {
      const result = await api.saveAgentSettings(agentSettings);
      setAgentSettings(result.settings);
      success("Agent 设置已保存");
    } catch {
      showError("保存 Agent 设置失败");
    } finally {
      setAgentSaving(false);
    }
  };

  // =====================================================================
  // Render
  // =====================================================================

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Left sidebar navigation */}
      <nav style={{
        width: 64,
        minWidth: 64,
        borderRight: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "var(--space-2) var(--space-1)",
        overflowY: "auto",
      }}>
        {settingsTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
              padding: "var(--space-2) var(--space-1)",
              border: "none",
              borderRadius: "var(--radius-md)",
              background: activeTab === tab.id ? "var(--interactive-light)" : "transparent",
              color: activeTab === tab.id ? "var(--interactive)" : "var(--text-secondary)",
              cursor: "pointer",
              transition: "all var(--transition-fast)",
              position: "relative" as const,
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-primary)";
              }
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--text-secondary)";
              }
            }}
          >
            {tab.icon}
            <span style={{ fontSize: "var(--text-xs)", lineHeight: 1 }}>{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Main content area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--space-4)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>

          {/* ============================================================= */}
          {/* Models Tab */}
          {/* ============================================================= */}
          {activeTab === "models" && (
            settingsLoading && !settings ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-8)", gap: "var(--space-2)", color: "var(--text-tertiary)" }}>
                <Spinner size="md" />
                <span style={{ fontSize: "var(--text-sm)" }}>加载配置...</span>
              </div>
            ) : (
              <>
              {/* Provider management section */}
              <div>
                <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0, marginBottom: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <Server size={14} />
                  Provider 管理
                </h3>

                {/* Provider selection + config form */}
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                  <div>
                    <label style={labelStyle}>选择提供商</label>
                    <select
                      value={selectedProvider}
                      onChange={(e) => {
                        setSelectedProvider(e.target.value);
                        setConfigId(""); // New config — clear existing config ID
                        setConfigName("");
                      }}
                      style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}
                    >
                      <option value="">-- 选择 --</option>
                      <optgroup label="远端 API">
                        {registry.filter((p) => !p.isLocal).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="本地模型">
                        {registry.filter((p) => p.isLocal).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </optgroup>
                    </select>
                  </div>

                  {selectedProvider && (
                    <div style={{
                      display: "flex", flexDirection: "column", gap: "var(--space-3)",
                      background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-xl)", padding: "var(--space-4)",
                    }}>
                      <div>
                        <label style={labelStyle}>
                          配置名称 {!configId && <span style={{ color: "var(--interactive)", fontSize: "var(--text-xs)" }}>(新配置)</span>}
                        </label>
                        <input
                          type="text"
                          value={configName}
                          onChange={(e) => { setConfigName(e.target.value); setUserCustomizedName(true); }}
                          placeholder={configId ? currentMeta?.name ?? "" : "输入唯一名称，如 OpenAI兼容+GLM-5.1"}
                          style={inputStyle}
                        />
                        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, marginTop: 2 }}>
                          {configId ? `ID: ${configId}` : "同一提供商类型下可创建多个模型配置"}
                        </p>
                      </div>
                      <div>
                        <label style={labelStyle}>模型名称</label>
                        {currentMeta && currentMeta.models && currentMeta.models.length > 0 ? (
                          <>
                            <input
                              list={`sp-models-${selectedProvider}`}
                              type="text"
                              value={modelName}
                              onChange={(e) => setModelName(e.target.value)}
                              placeholder={currentMeta.defaultModel || "模型 ID"}
                              style={inputStyle}
                            />
                            <datalist id={`sp-models-${selectedProvider}`}>
                              {currentMeta.models.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                              ))}
                            </datalist>
                          </>
                        ) : (
                          <input type="text" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder={currentMeta?.defaultModel || "模型 ID"} style={inputStyle} />
                        )}
                      </div>
                      <div>
                        <label style={labelStyle}>API Key {isLocal && <span style={{ color: "var(--text-tertiary)" }}>(可选)</span>}</label>
                        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={isLocal ? "本地模型无需 API Key" : "sk-..."} style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>API 地址</label>
                        <input type="text" value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder={currentMeta?.apiBase || "https://..."} style={inputStyle} />
                        {currentMeta?.apiBase && <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, marginTop: 2 }}>默认: {currentMeta.apiBase}</p>}
                      </div>
                      <div>
                        <label style={labelStyle}>最大 Tokens</label>
                        <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(parseInt(e.target.value) || 0)} min={0} style={inputStyle} />
                        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0, marginTop: 2 }}>设为 0 表示由 API 自动决定（推荐）</p>
                      </div>
                      <div>
                        <label style={labelStyle}>
                          温度: <span style={{ color: "var(--interactive)", fontWeight: 600 }}>{temperature.toFixed(1)}</span>
                        </label>
                        <input type="range" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} style={{ width: "100%", accentColor: "var(--interactive)" }} />
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                          <span>精确 (0)</span>
                          <span>创意 (2)</span>
                        </div>
                      </div>
                      <div>
                        <label style={labelStyle}>上下文窗口 (tokens)</label>
                        <input type="number" value={contextWindow} onChange={(e) => setContextWindow(parseInt(e.target.value) || 200000)} style={inputStyle} />
                      </div>
                      <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
                        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 16, height: 16 }} />
                        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>启用</span>
                      </label>

                      {testResult && (
                        <div style={{
                          display: "flex", alignItems: "flex-start", gap: "var(--space-2)",
                          padding: "8px var(--space-3)", borderRadius: "var(--radius-lg)", fontSize: "var(--text-sm)",
                          background: testResult.success ? "var(--success-light)" : "var(--error-light)",
                          border: `1px solid ${testResult.success ? "var(--success)" : "var(--error)"}`,
                          color: testResult.success ? "var(--success)" : "var(--error)",
                        }}>
                          {testResult.success ? <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} /> : <XCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />}
                          <span>{testResult.message}</span>
                        </div>
                      )}

                      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" as const }}>
                        <button onClick={handleSave} disabled={saving} style={{
                          display: "flex", alignItems: "center", gap: "var(--space-1)",
                          padding: "var(--space-2) var(--space-4)", background: "var(--interactive)", color: "#fff",
                          fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", borderRadius: "var(--radius-lg)",
                          border: "none", cursor: "pointer", opacity: saving ? 0.5 : 1,
                        }}><Save size={14} />{saving ? "保存中..." : "保存"}</button>
                        <button onClick={handleTest} disabled={testing || (!isLocal && !apiKey)} style={{
                          display: "flex", alignItems: "center", gap: "var(--space-1)",
                          padding: "var(--space-2) var(--space-4)", background: "var(--bg-hover)", color: "var(--text-secondary)",
                          fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", borderRadius: "var(--radius-lg)",
                          border: "none", cursor: "pointer", opacity: testing || (!isLocal && !apiKey) ? 0.5 : 1,
                        }}><Wifi size={14} />{testing ? "测试中..." : "测试连接"}</button>
                        <button onClick={() => handleSetDefault("main")} style={{
                          display: "flex", alignItems: "center", gap: "var(--space-1)",
                          padding: "var(--space-2) var(--space-4)", background: "var(--success-light)", color: "var(--success)",
                          fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", borderRadius: "var(--radius-lg)",
                          border: "none", cursor: "pointer",
                        }}><ShieldCheck size={14} />设为默认</button>
                      </div>
                    </div>
                  )}

                  {/* Configured providers list */}
                  {settings && settings.providers.length > 0 && (
                    <div style={{ marginTop: "var(--space-3)" }}>
                      <h4 style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-tertiary)", margin: 0, marginBottom: "var(--space-2)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                        已配置 ({settings.providers.length})
                      </h4>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {settings.providers.map((p) => {
                          // true  → has key (or local endpoint, no badge needed)
                          // false → key missing, show subtle badge so user can spot it at a glance
                          // undefined → unknown (e.g. health fetch failed), stay silent
                          const missingKey = keyStatus[p.id] === false;
                          return (
                          <div key={p.id} onClick={() => {
                            setSelectedProvider(p.registryId ?? p.id);
                            setConfigId(p.id);
                          }} style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "var(--space-2) var(--space-3)", background: "var(--bg-secondary)",
                            border: "1px solid", borderColor: p.id === configId ? "var(--interactive-light)" : "var(--border-primary)",
                            borderRadius: "var(--radius-md)", cursor: "pointer", transition: "border-color var(--transition-fast)",
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                              <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.enabled ? "var(--success)" : "var(--text-tertiary)" }} />
                              <div>
                                <span style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", fontWeight: 500 }}>
                                  {p.name}
                                  {settings.defaults.main === p.id && <span style={{ marginLeft: "var(--space-1)", fontSize: "var(--text-xs)", color: "var(--interactive)" }}>★</span>}
                                </span>
                                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginLeft: "var(--space-2)" }}>
                                  {p.model}
                                </span>
                                {missingKey && (
                                  <span title="该 provider 尚未配置 API key，聊天/检索将不可用或走兜底" style={{
                                    marginLeft: "var(--space-2)",
                                    fontSize: "var(--text-xs)",
                                    color: "var(--text-tertiary)",
                                    background: "var(--bg-tertiary)",
                                    padding: "1px 6px",
                                    borderRadius: "var(--radius-sm)",
                                    border: "1px solid var(--border-primary)",
                                    fontWeight: 500,
                                  }}>
                                    无 key
                                  </span>
                                )}
                              </div>
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }} style={{
                              padding: 2, border: "none", background: "transparent", color: "var(--text-tertiary)", cursor: "pointer",
                            }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Model role configuration section */}
              <div style={{ borderTop: "1px solid var(--border-primary)", paddingTop: "var(--space-4)" }}>
                <ModelsPanel
                  providers={settings?.providers ?? []}
                  settings={settings}
                  registry={registry}
                  onSettingsChanged={loadData}
                />
              </div>
            </>
          )
          )}

          {/* ============================================================= */}
          {/* Channels Tab */}
          {/* ============================================================= */}
          {activeTab === "channels" && (
            <ChannelsPanel />
          )}

          {/* ============================================================= */}
          {/* MCP Servers Tab */}
          {/* ============================================================= */}
          {activeTab === "mcp" && (
            <MCPServersPanel />
          )}

          {/* ============================================================= */}
          {/* General Tab */}
          {/* ============================================================= */}
          {activeTab === "general" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              {/* Theme */}
              <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
                <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0, marginBottom: "var(--space-3)" }}>
                  主题
                </h3>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  {([
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                    { value: "system", label: "跟随系统" },
                  ] as const).map((opt) => (
                    <button key={opt.value} onClick={() => setThemeMode(opt.value)} style={{
                      padding: "var(--space-2) var(--space-4)", border: "1px solid",
                      borderColor: themeMode === opt.value ? "var(--interactive)" : "var(--border-primary)",
                      borderRadius: "var(--radius-lg)",
                      background: themeMode === opt.value ? "var(--interactive-light)" : "var(--bg-primary)",
                      color: themeMode === opt.value ? "var(--interactive)" : "var(--text-secondary)",
                      fontSize: "var(--text-sm)", fontWeight: themeMode === opt.value ? 500 : 400,
                      cursor: "pointer", transition: "all var(--transition-fast)",
                    }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Server Connection (Worker mode only) */}
              {isWorkerMode && (
                <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                    <Cloud size={16} style={{ color: "var(--interactive)" }} />
                    <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0 }}>
                      服务器连接
                    </h3>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                    {/* Connection status */}
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <div style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: syncState?.serverReachable ? "var(--success)" : "var(--error)",
                        flexShrink: 0,
                      }} />
                      <span style={{ fontSize: "var(--text-sm)", color: syncState?.serverReachable ? "var(--success)" : "var(--error)", fontWeight: 500 }}>
                        {syncState?.serverReachable ? "已连接" : "未连接"}
                      </span>
                    </div>
                    {/* Sync button */}
                    <button
                      onClick={() => hubSyncConfig()}
                      disabled={syncing}
                      style={{
                        display: "flex", alignItems: "center", gap: "var(--space-1)",
                        padding: "var(--space-2) var(--space-4)", background: "var(--interactive)", color: "#fff",
                        fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", borderRadius: "var(--radius-lg)",
                        border: "none", cursor: syncing ? "not-allowed" : "pointer", opacity: syncing ? 0.5 : 1,
                        alignSelf: "flex-start",
                      }}
                    >
                      <RefreshCw size={14} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
                      {syncing ? "同步中..." : "同步配置"}
                    </button>
                    {/* Sync info */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                      {syncState?.lastConfigSync && (
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "var(--space-1) 0", borderBottom: "1px solid var(--border-primary)" }}>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>上次同步</span>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-primary)", fontWeight: 500 }}>
                            {new Date(syncState.lastConfigSync).toLocaleString()}
                          </span>
                        </div>
                      )}
                      {syncState?.configVersionCached && (
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "var(--space-1) 0", borderBottom: "1px solid var(--border-primary)" }}>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>配置版本</span>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-primary)", fontWeight: 500 }}>
                            {syncState.configVersionCached}
                          </span>
                        </div>
                      )}
                      {syncState?.registeredWorkerId && (
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "var(--space-1) 0" }}>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>Worker ID</span>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-primary)", fontWeight: 500, fontFamily: "monospace" }}>
                            {syncState.registeredWorkerId}
                          </span>
                        </div>
                      )}
                    </div>
                    {/* Pending notifications */}
                    {syncState?.pendingNotifications && syncState.pendingNotifications.length > 0 && (
                      <div style={{ marginTop: "var(--space-2)" }}>
                        <h4 style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-tertiary)", margin: "0 0 var(--space-2) 0", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                          待处理通知 ({syncState.pendingNotifications.length})
                        </h4>
                        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                          {syncState.pendingNotifications.map((n, i) => (
                            <div key={i} style={{ padding: "var(--space-2) var(--space-3)", background: "var(--bg-primary)", borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                              <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>[{n.type}]</span> {n.message}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Agent settings */}
              <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
                  <Settings2 size={16} style={{ color: "var(--interactive)" }} />
                  <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0 }}>
                    Agent 运行参数
                  </h3>
                </div>
                <p style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 0, marginBottom: "var(--space-4)" }}>
                  修改后即时生效，无需重启。
                </p>

                {agentSettings ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                    <div>
                      <label style={labelStyle}>最大轮次</label>
                      <select value={agentSettings.maxTurns} onChange={(e) => setAgentSettings({ ...agentSettings, maxTurns: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={-1}>无限制（默认）</option>
                        <option value={100}>100 轮</option>
                        <option value={500}>500 轮</option>
                        <option value={1000}>1000 轮</option>
                        <option value={9999}>9999 轮</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>上下文窗口</label>
                      <select value={agentSettings.contextWindow} onChange={(e) => setAgentSettings({ ...agentSettings, contextWindow: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={32000}>32K</option>
                        <option value={64000}>64K</option>
                        <option value={128000}>128K</option>
                        <option value={200000}>200K (默认)</option>
                        <option value={256000}>256K</option>
                        <option value={512000}>512K</option>
                        <option value={1000000}>1M</option>
                        <option value={2000000}>2M</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>输出 Token 预算</label>
                      <select value={agentSettings.outputTokenBudget} onChange={(e) => setAgentSettings({ ...agentSettings, outputTokenBudget: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={0}>0 (模型默认)</option>
                        <option value={8192}>8K</option>
                        <option value={16384}>16K</option>
                        <option value={32768}>32K</option>
                        <option value={65536}>64K</option>
                        <option value={131072}>128K</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>压缩缓冲区</label>
                      <select value={agentSettings.compactionBuffer} onChange={(e) => setAgentSettings({ ...agentSettings, compactionBuffer: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={8000}>8K</option>
                        <option value={13000}>13K (默认)</option>
                        <option value={20000}>20K</option>
                        <option value={30000}>30K</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>压缩触发比例</label>
                      <select
                        value={`${agentSettings.proactiveCompactLowerRatio ?? 0.7}-${agentSettings.proactiveCompactUpperRatio ?? 0.85}`}
                        onChange={(e) => {
                          const [lower, upper] = e.target.value.split("-").map(Number);
                          setAgentSettings({ ...agentSettings, proactiveCompactLowerRatio: lower, proactiveCompactUpperRatio: upper });
                        }}
                        style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}
                      >
                        <option value="0.6-0.75">保守 (60%-75%)</option>
                        <option value="0.7-0.85">标准 (70%-85%) (默认)</option>
                        <option value="0.8-0.92">宽松 (80%-92%)</option>
                        <option value="0.85-0.95">极宽 (85%-95%)</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>工具结果上限</label>
                      <select value={agentSettings.toolResultMaxTokens} onChange={(e) => setAgentSettings({ ...agentSettings, toolResultMaxTokens: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={4000}>4K</option>
                        <option value={8000}>8K (默认)</option>
                        <option value={16000}>16K</option>
                        <option value={32000}>32K</option>
                        <option value={64000}>64K</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>子Agent最大轮次</label>
                      <select value={agentSettings.subAgentMaxTurns} onChange={(e) => setAgentSettings({ ...agentSettings, subAgentMaxTurns: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={50}>50 轮</option>
                        <option value={100}>100 轮</option>
                        <option value={200}>200 轮 (默认)</option>
                        <option value={300}>300 轮</option>
                        <option value={500}>500 轮</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>连续错误阈值</label>
                      <select value={agentSettings.consecutiveErrorThreshold} onChange={(e) => setAgentSettings({ ...agentSettings, consecutiveErrorThreshold: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={2}>2 次</option>
                        <option value={3}>3 次 (默认)</option>
                        <option value={5}>5 次</option>
                        <option value={8}>8 次</option>
                        <option value={10}>10 次</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>卡住检测阈值</label>
                      <select value={agentSettings.stuckDetectionThreshold} onChange={(e) => setAgentSettings({ ...agentSettings, stuckDetectionThreshold: parseInt(e.target.value) })} style={{ ...inputStyle, padding: "8px var(--space-3)", cursor: "pointer" }}>
                        <option value={3}>3 次</option>
                        <option value={5}>5 次 (默认)</option>
                        <option value={8}>8 次</option>
                        <option value={10}>10 次</option>
                        <option value={15}>15 次</option>
                      </select>
                    </div>
                    <button onClick={handleAgentSave} disabled={agentSaving} style={{
                      display: "flex", alignItems: "center", gap: "var(--space-1)",
                      padding: "var(--space-2) var(--space-4)", background: "var(--interactive)", color: "#fff",
                      fontSize: "var(--text-sm)", borderRadius: "var(--radius-lg)", border: "none",
                      cursor: agentSaving ? "not-allowed" : "pointer", opacity: agentSaving ? 0.5 : 1, alignSelf: "flex-start",
                    }}>
                      <Save size={14} /> {agentSaving ? "保存中..." : "保存设置"}
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: "var(--text-sm)", color: "var(--text-tertiary)" }}>加载中...</p>
                )}
              </div>

              {/* About */}
              <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                  <Info size={16} style={{ color: "var(--interactive)" }} />
                  <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0 }}>
                    关于
                  </h3>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "var(--space-1) 0", borderBottom: "1px solid var(--border-primary)" }}>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>版本</span>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", fontWeight: 500 }}>{healthInfo?.version ?? "---"}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "var(--space-1) 0" }}>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>状态</span>
                    <span style={{ fontSize: "var(--text-sm)", color: healthInfo?.status === "ok" ? "var(--success)" : "var(--text-tertiary)", fontWeight: 500 }}>
                      {healthInfo?.status === "ok" ? "正常" : "---"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================= */}
          {/* Auth Tab */}
          {/* ============================================================= */}
          {activeTab === "auth" && (
            <AuthPanel />
          )}

          {/* ============================================================= */}
          {/* Hub Tab */}
          {/* ============================================================= */}
          {activeTab === "hub" && (
            <HubConnectionPanel />
          )}
          {activeTab === "sync" && (
            <ConfigSyncPanel />
          )}
        </div>
      </div>

      {/* Inline keyframes for sync button animation */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
