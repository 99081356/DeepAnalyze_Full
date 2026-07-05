// =============================================================================
// DeepAnalyze - ChannelsPanel Component
// Communication channel management with inline config forms
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import type {
  ChannelId,
  ChannelInfo,
  ChannelsConfig,
  ChannelTestResult,
  FeishuConfig,
  DingTalkConfig,
  WeChatConfig,
  QQConfig,
  TelegramConfig,
  DiscordConfig,
} from "../../types/index";
import { useToast } from "../../hooks/useToast";
import {
  MessageCircle,
  Bell,
  Smartphone,
  Users,
  Send,
  Hash,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronUp,
  Wifi,
  Save,
  Play,
  Square,
  Radio,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Channel icon mapping
// ---------------------------------------------------------------------------

const CHANNEL_ICONS: Record<ChannelId, React.ReactNode> = {
  feishu: <MessageCircle size={20} />,
  dingtalk: <Bell size={20} />,
  wechat: <Smartphone size={20} />,
  qq: <Users size={20} />,
  telegram: <Send size={20} />,
  discord: <Hash size={20} />,
};

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
// Config form fields helper
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string;
  label: string;
  type?: "text" | "password" | "number";
  placeholder?: string;
  required?: boolean;
}

function ConfigFields({
  fields,
  config,
  onChange,
}: {
  fields: FieldDef[];
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {fields.map((f) => (
        <div key={f.key}>
          <label style={labelStyle}>
            {f.label}
            {f.required && <span style={{ color: "var(--error)", marginLeft: 2 }}>*</span>}
          </label>
          <input
            type={f.type ?? "text"}
            value={config[f.key] ?? ""}
            onChange={(e) => onChange(f.key, e.target.value)}
            placeholder={f.placeholder}
            style={inputStyle}
          />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel-specific config forms
// ---------------------------------------------------------------------------

function FeishuConfigForm({
  config,
  onChange,
}: {
  config: FeishuConfig;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <ConfigFields
      fields={[
        { key: "app_id", label: "App ID", placeholder: "cli_a5d0...", required: true },
        { key: "app_secret", label: "App Secret", type: "password", placeholder: "应用密钥", required: true },
        { key: "encrypt_key", label: "Encrypt Key", type: "password", placeholder: "加密密钥 (可选)" },
        { key: "verification_token", label: "Verification Token", type: "password", placeholder: "验证令牌 (可选)" },
      ]}
      config={config}
      onChange={onChange}
    />
  );
}

function DingTalkConfigForm({
  config,
  onChange,
}: {
  config: DingTalkConfig;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <ConfigFields
      fields={[
        { key: "client_id", label: "Client ID (AppKey)", placeholder: "ding...", required: true },
        { key: "client_secret", label: "Client Secret", type: "password", placeholder: "应用密钥", required: true },
      ]}
      config={config}
      onChange={onChange}
    />
  );
}

function WeChatConfigForm({
  config,
  onChange,
}: {
  config: WeChatConfig;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <ConfigFields
      fields={[
        { key: "app_id", label: "App ID", placeholder: "wx...", required: true },
        { key: "app_secret", label: "App Secret", type: "password", placeholder: "应用密钥", required: true },
        { key: "token", label: "Token", placeholder: "消息校验令牌", required: true },
        { key: "encoding_aes_key", label: "EncodingAESKey", type: "password", placeholder: "消息加解密密钥 (可选)" },
      ]}
      config={config}
      onChange={onChange}
    />
  );
}

function QQConfigForm({
  config,
  onChange,
}: {
  config: QQConfig;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <ConfigFields
        fields={[
          { key: "app_id", label: "App ID", placeholder: "QQ 应用 ID", required: true },
          { key: "app_secret", label: "App Secret", type: "password", placeholder: "应用密钥", required: true },
        ]}
        config={config}
        onChange={onChange}
      />
      <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={config.markdown_enabled ?? true}
          onChange={(e) => onChange("markdown_enabled", e.target.checked)}
          style={{ width: 16, height: 16 }}
        />
        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>启用 Markdown (私聊)</span>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={config.group_markdown_enabled ?? true}
          onChange={(e) => onChange("group_markdown_enabled", e.target.checked)}
          style={{ width: 16, height: 16 }}
        />
        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>启用 Markdown (群聊)</span>
      </label>
    </div>
  );
}

function TelegramConfigForm({
  config,
  onChange,
}: {
  config: TelegramConfig;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <ConfigFields
      fields={[
        { key: "token", label: "Bot Token", type: "password", placeholder: "123456:ABC-DEF...", required: true },
        { key: "proxy", label: "API 代理地址", placeholder: "https://api.telegram.org (默认)" },
      ]}
      config={config}
      onChange={onChange}
    />
  );
}

function DiscordConfigForm({
  config,
  onChange,
}: {
  config: DiscordConfig;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <ConfigFields
      fields={[
        { key: "token", label: "Bot Token", type: "password", placeholder: "Bot Token", required: true },
        { key: "application_id", label: "Application ID", placeholder: "Discord Application ID (可选)" },
        { key: "guild_id", label: "Guild ID (服务器)", placeholder: "Discord 服务器 ID (可选)" },
      ]}
      config={config}
      onChange={onChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Channel config form selector
// ---------------------------------------------------------------------------

const CONFIG_FORMS: Record<ChannelId, React.FC<{ config: any; onChange: (k: string, v: any) => void }>> = {
  feishu: FeishuConfigForm,
  dingtalk: DingTalkConfigForm,
  wechat: WeChatConfigForm,
  qq: QQConfigForm,
  telegram: TelegramConfigForm,
  discord: DiscordConfigForm,
};

// ---------------------------------------------------------------------------
// ChannelCard — expandable card with config form
// ---------------------------------------------------------------------------

function ChannelCard({
  channel,
  config,
  testResult,
  testing,
  saving,
  onConfigChange,
  onSave,
  onTest,
  onToggle,
  onStart,
  onStop,
}: {
  channel: ChannelInfo;
  config: Record<string, any>;
  testResult: ChannelTestResult | null;
  testing: boolean;
  saving: boolean;
  onConfigChange: (key: string, value: any) => void;
  onSave: () => void;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ConfigForm = CONFIG_FORMS[channel.id];

  return (
    <div style={{
      border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-xl)",
      background: "var(--bg-primary)",
      overflow: "hidden",
      opacity: channel.configured || !channel.enabled ? 1 : 0.85,
      transition: "border-color var(--transition-fast)",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: "var(--space-3)",
        padding: "var(--space-3) var(--space-4)",
      }}>
        {/* Icon */}
        <div style={{
          width: 36, height: 36, borderRadius: "var(--radius-lg)",
          background: channel.enabled ? "var(--interactive-light)" : "var(--bg-secondary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: channel.enabled ? "var(--interactive)" : "var(--text-tertiary)",
          flexShrink: 0,
        }}>
          {CHANNEL_ICONS[channel.id]}
        </div>

        {/* Name + description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)",
            display: "flex", alignItems: "center", gap: "var(--space-2)",
          }}>
            {channel.name}
            {channel.running && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 2,
                fontSize: "var(--text-xs)", color: "var(--success)",
              }}>
                <Radio size={10} /> 运行中
              </span>
            )}
            {channel.configured && !channel.running && channel.enabled && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>已配置</span>
            )}
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 2 }}>
            {channel.description}
          </div>
        </div>

        {/* Toggle */}
        <button
          onClick={() => onToggle(!channel.enabled)}
          title={channel.enabled ? "点击禁用" : "点击启用"}
          style={{
            padding: 0, border: "none", background: "transparent",
            cursor: "pointer", color: channel.enabled ? "var(--success)" : "var(--text-tertiary)",
            display: "flex", alignItems: "center", flexShrink: 0,
          }}
        >
          {channel.enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
        </button>

        {/* Expand/collapse */}
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-primary)", background: "transparent",
            color: "var(--text-tertiary)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Expanded config form */}
      {expanded && (
        <div style={{
          padding: "0 var(--space-4) var(--space-4)",
          borderTop: "1px solid var(--border-primary)",
        }}>
          <div style={{
            display: "flex", flexDirection: "column", gap: "var(--space-3)",
            paddingTop: "var(--space-3)",
          }}>
            {ConfigForm && <ConfigForm config={config} onChange={onConfigChange} />}

            {/* Test result */}
            {testResult && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: "var(--space-2)",
                padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-lg)",
                fontSize: "var(--text-xs)",
                background: testResult.success ? "var(--success-light)" : "var(--error-light)",
                border: `1px solid ${testResult.success ? "var(--success)" : "var(--error)"}`,
                color: testResult.success ? "var(--success)" : "var(--error)",
              }}>
                {testResult.success
                  ? <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  : <XCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />}
                <span>{testResult.message}</span>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              <button onClick={onSave} disabled={saving} style={{
                display: "flex", alignItems: "center", gap: "var(--space-1)",
                padding: "var(--space-2) var(--space-4)",
                background: "var(--interactive)", color: "#fff",
                fontSize: "var(--text-sm)", fontWeight: 500,
                borderRadius: "var(--radius-lg)", border: "none",
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.5 : 1,
              }}>
                <Save size={14} /> {saving ? "保存中..." : "保存"}
              </button>
              <button onClick={onTest} disabled={testing} style={{
                display: "flex", alignItems: "center", gap: "var(--space-1)",
                padding: "var(--space-2) var(--space-4)",
                background: "var(--bg-hover)", color: "var(--text-secondary)",
                fontSize: "var(--text-sm)", fontWeight: 500,
                borderRadius: "var(--radius-lg)", border: "none",
                cursor: testing ? "not-allowed" : "pointer",
                opacity: testing ? 0.5 : 1,
              }}>
                <Wifi size={14} /> {testing ? "测试中..." : "测试连接"}
              </button>
              {channel.configured && channel.enabled && (
                channel.running ? (
                  <button onClick={onStop} style={{
                    display: "flex", alignItems: "center", gap: "var(--space-1)",
                    padding: "var(--space-2) var(--space-4)",
                    background: "var(--error-light)", color: "var(--error)",
                    fontSize: "var(--text-sm)", fontWeight: 500,
                    borderRadius: "var(--radius-lg)", border: "none", cursor: "pointer",
                  }}>
                    <Square size={14} /> 停止
                  </button>
                ) : (
                  <button onClick={onStart} style={{
                    display: "flex", alignItems: "center", gap: "var(--space-1)",
                    padding: "var(--space-2) var(--space-4)",
                    background: "var(--success-light)", color: "var(--success)",
                    fontSize: "var(--text-sm)", fontWeight: 500,
                    borderRadius: "var(--radius-lg)", border: "none", cursor: "pointer",
                  }}>
                    <Play size={14} /> 启动
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChannelsPanel — main component
// ---------------------------------------------------------------------------

export function ChannelsPanel() {
  const { success, error: showError } = useToast();
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [configs, setConfigs] = useState<Record<string, Record<string, any>>>({});
  const [loading, setLoading] = useState(true);
  const [testResults, setTestResults] = useState<Record<string, ChannelTestResult | null>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const loadData = useCallback(async () => {
    try {
      const [channelsData, configsData] = await Promise.all([
        api.listChannels(),
        api.getChannelConfigs(),
      ]);
      setChannels(channelsData);
      setConfigs(configsData as unknown as Record<string, Record<string, any>>);
    } catch (err) {
      console.error("Failed to load channels:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleConfigChange = (channelId: ChannelId, key: string, value: any) => {
    setConfigs((prev) => ({
      ...prev,
      [channelId]: {
        ...(prev[channelId] ?? {}),
        [key]: value,
      },
    }));
  };

  const handleSave = async (channelId: ChannelId) => {
    setSaving((prev) => ({ ...prev, [channelId]: true }));
    try {
      await api.updateChannel(channelId, configs[channelId] ?? {});
      success(`${channels.find((c) => c.id === channelId)?.name ?? channelId} 配置已保存`);
      await loadData();
    } catch (err) {
      showError("保存失败");
    } finally {
      setSaving((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleTest = async (channelId: ChannelId) => {
    setTesting((prev) => ({ ...prev, [channelId]: true }));
    setTestResults((prev) => ({ ...prev, [channelId]: null }));
    try {
      // Save first so test uses latest config
      await api.updateChannel(channelId, configs[channelId] ?? {});
      const result = await api.testChannel(channelId);
      setTestResults((prev) => ({ ...prev, [channelId]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [channelId]: { success: false, message: err instanceof Error ? err.message : "测试失败" },
      }));
    } finally {
      setTesting((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleToggle = async (channelId: ChannelId, enabled: boolean) => {
    try {
      await api.updateChannel(channelId, { ...configs[channelId], enabled });
      success(`${channels.find((c) => c.id === channelId)?.name ?? channelId} 已${enabled ? "启用" : "禁用"}`);
      await loadData();
    } catch {
      showError("操作失败");
    }
  };

  const handleStart = async (channelId: ChannelId) => {
    try {
      await api.startChannel(channelId);
      success("渠道已启动");
      await loadData();
    } catch {
      showError("启动失败");
    }
  };

  const handleStop = async (channelId: ChannelId) => {
    try {
      await api.stopChannel(channelId);
      success("渠道已停止");
      await loadData();
    } catch {
      showError("停止失败");
    }
  };

  const enabledCount = channels.filter((c) => c.enabled).length;
  const runningCount = channels.filter((c) => c.running).length;

  // =====================================================================
  // Render
  // =====================================================================

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", padding: "var(--space-4)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{
          margin: 0, fontSize: "var(--text-base)", fontWeight: "var(--font-semibold)",
          color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "var(--space-2)",
        }}>
          <Send size={16} />
          通信渠道
        </h3>
        <button onClick={loadData} title="刷新" style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 32, height: 32, borderRadius: "var(--radius-lg)",
          border: "1px solid var(--border-primary)", background: "transparent",
          color: "var(--text-tertiary)", cursor: "pointer",
        }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Stats */}
      <div style={{
        display: "flex", gap: "var(--space-4)", padding: "var(--space-2) var(--space-3)",
        background: "var(--bg-secondary)", borderRadius: "var(--radius-lg)",
        fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
      }}>
        <span>共 {channels.length} 个渠道</span>
        <span style={{ color: "var(--success)" }}>{enabledCount} 启用</span>
        <span style={{ color: "var(--interactive)" }}>{runningCount} 运行中</span>
      </div>

      {/* Channel list */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "var(--space-8)", color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
          加载中...
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {channels.map((ch) => (
            <ChannelCard
              key={ch.id}
              channel={ch}
              config={configs[ch.id] ?? {}}
              testResult={testResults[ch.id] ?? null}
              testing={testing[ch.id] ?? false}
              saving={saving[ch.id] ?? false}
              onConfigChange={(key, value) => handleConfigChange(ch.id, key, value)}
              onSave={() => handleSave(ch.id)}
              onTest={() => handleTest(ch.id)}
              onToggle={(enabled) => handleToggle(ch.id, enabled)}
              onStart={() => handleStart(ch.id)}
              onStop={() => handleStop(ch.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
