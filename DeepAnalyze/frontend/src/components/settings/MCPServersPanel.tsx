// =============================================================================
// DeepAnalyze - MCP Servers Panel
// Management UI for MCP (Model Context Protocol) server connections
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import type { MCPServerConfig, MCPServerStatus } from "../../types/index";
import { useToast } from "../../hooks/useToast";
import {
  Plus,
  Trash2,
  RefreshCw,
  Plug,
  PlugZap,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Wrench,
  Server,
} from "lucide-react";

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
// ServerEditor — add/edit form
// ---------------------------------------------------------------------------

function ServerEditor({
  onSave,
  onCancel,
}: {
  onSave: (server: MCPServerConfig) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<MCPServerConfig["type"]>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");

  const isValid = id.trim() && name.trim() &&
    (type === "stdio" ? command.trim() : url.trim());

  const handleSave = () => {
    if (!isValid) return;
    const env: Record<string, string> = {};
    if (envText.trim()) {
      for (const line of envText.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
    }
    onSave({
      id: id.trim(),
      name: name.trim(),
      type,
      command: type === "stdio" ? command.trim() : undefined,
      args: type === "stdio" && args.trim() ? args.trim().split(/\s+/) : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      url: type !== "stdio" ? url.trim() : undefined,
      enabled: true,
    });
  };

  const needsCommand = type === "stdio";
  const needsUrl = type !== "stdio";

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: "var(--space-3)",
      background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-xl)", padding: "var(--space-4)",
    }}>
      <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)" }}>
        添加 MCP 服务器
      </h3>

      <div style={{ display: "flex", gap: "var(--space-3)" }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>ID *</label>
          <input type="text" value={id} onChange={(e) => setId(e.target.value)}
            placeholder="unique-server-id" style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>名称 *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="My MCP Server" style={inputStyle} />
        </div>
      </div>

      <div>
        <label style={labelStyle}>连接类型</label>
        <div style={{ display: "flex", gap: 2, background: "var(--bg-primary)", borderRadius: "var(--radius-lg)", padding: 2 }}>
          {(["stdio", "sse", "streamable-http", "websocket"] as const).map((t) => (
            <button key={t} onClick={() => setType(t)} style={{
              flex: 1, padding: "var(--space-1) var(--space-2)",
              border: "none", borderRadius: "var(--radius-md)",
              background: type === t ? "var(--interactive-light)" : "transparent",
              color: type === t ? "var(--interactive)" : "var(--text-secondary)",
              fontSize: "var(--text-xs)", fontWeight: type === t ? 500 : 400,
              cursor: "pointer", transition: "all var(--transition-fast)",
            }}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {needsCommand && (
        <>
          <div>
            <label style={labelStyle}>命令 *</label>
            <input type="text" value={command} onChange={(e) => setCommand(e.target.value)}
              placeholder="npx" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>参数</label>
            <input type="text" value={args} onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-github" style={inputStyle} />
          </div>
        </>
      )}

      {needsUrl && (
        <div>
          <label style={labelStyle}>URL *</label>
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3001/sse" style={inputStyle} />
        </div>
      )}

      <div>
        <label style={labelStyle}>环境变量 (KEY=VALUE, 每行一个)</label>
        <textarea value={envText} onChange={(e) => setEnvText(e.target.value)}
          placeholder={"GITHUB_TOKEN=ghp_..."}
          rows={3} style={{ ...inputStyle, resize: "vertical", minHeight: 60, fontFamily: "monospace" }} />
      </div>

      <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{
          padding: "var(--space-2) var(--space-4)", border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-lg)", background: "var(--bg-primary)", color: "var(--text-secondary)",
          fontSize: "var(--text-sm)", cursor: "pointer",
        }}>
          取消
        </button>
        <button onClick={handleSave} disabled={!isValid} style={{
          padding: "var(--space-2) var(--space-4)", border: "none",
          borderRadius: "var(--radius-lg)", fontSize: "var(--text-sm)", fontWeight: 500,
          background: isValid ? "var(--interactive)" : "var(--bg-hover)",
          color: isValid ? "#fff" : "var(--text-tertiary)",
          cursor: isValid ? "pointer" : "not-allowed",
        }}>
          添加
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServerCard — displays a single server with actions
// ---------------------------------------------------------------------------

function ServerCard({
  config,
  status,
  onConnect,
  onDelete,
}: {
  config: MCPServerConfig;
  status: MCPServerStatus | undefined;
  onConnect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const statusIcon = status?.status === "connected"
    ? <CheckCircle2 size={12} style={{ color: "var(--success)" }} />
    : status?.status === "failed"
      ? <XCircle size={12} style={{ color: "var(--error)" }} />
      : <RefreshCw size={12} style={{ color: "var(--text-tertiary)" }} />;

  const statusLabel = status?.status === "connected"
    ? `已连接 (${status.toolCount} 工具)`
    : status?.status === "failed"
      ? "连接失败"
      : "未连接";

  return (
    <div style={{
      border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-xl)",
      background: "var(--bg-primary)",
      padding: "var(--space-3)",
      display: "flex", flexDirection: "column", gap: "var(--space-2)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Server size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {config.name}
          </div>
          <div style={{
            fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
            display: "flex", alignItems: "center", gap: "var(--space-1)", marginTop: 2,
          }}>
            <code style={{ background: "var(--bg-secondary)", padding: "0 var(--space-1)", borderRadius: "var(--radius-sm)" }}>
              {config.type}
            </code>
            {statusIcon}
            <span>{statusLabel}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          <button onClick={() => onConnect(config.id)} title="连接" style={actionBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--interactive)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
            <Plug size={14} />
          </button>
          <button onClick={() => onDelete(config.id)} title="删除" style={actionBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Details */}
      {config.type === "stdio" && config.command && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", background: "var(--bg-secondary)", padding: "var(--space-1) var(--space-2)", borderRadius: "var(--radius-md)" }}>
          {config.command} {config.args?.join(" ") ?? ""}
        </div>
      )}
      {config.type !== "stdio" && config.url && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", background: "var(--bg-secondary)", padding: "var(--space-1) var(--space-2)", borderRadius: "var(--radius-md)" }}>
          {config.url}
        </div>
      )}
      {status?.error && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--error)", display: "flex", alignItems: "flex-start", gap: "var(--space-1)" }}>
          <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ wordBreak: "break-word" }}>{status.error}</span>
        </div>
      )}
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 28, height: 28, borderRadius: "var(--radius-md)",
  border: "none", background: "transparent",
  color: "var(--text-tertiary)", cursor: "pointer",
  transition: "color var(--transition-fast)",
};

// ---------------------------------------------------------------------------
// MCPServersPanel — main component
// ---------------------------------------------------------------------------

export function MCPServersPanel() {
  const { success, error: showError } = useToast();
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [statuses, setStatuses] = useState<MCPServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [serverList, statusList] = await Promise.all([
        api.listMCPServers(),
        api.getMCPStatus().catch(() => []),
      ]);
      setServers(Array.isArray(serverList) ? serverList : []);
      setStatuses(Array.isArray(statusList) ? statusList : []);
    } catch (err) {
      console.error("Failed to load MCP servers:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAdd = async (server: MCPServerConfig) => {
    try {
      await api.addMCPServer(server);
      success(`MCP 服务器 "${server.name}" 已添加`);
      setShowAdd(false);
      await loadData();
    } catch (err) {
      showError(err instanceof Error ? err.message : "添加失败");
    }
  };

  const handleConnect = async (id: string) => {
    if (connecting) return;
    setConnecting(id);
    try {
      await api.connectMCPServer(id);
      success("连接成功");
      await loadData();
    } catch (err) {
      showError(err instanceof Error ? err.message : "连接失败");
    } finally {
      setConnecting(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteMCPServer(id);
      success("已删除");
      await loadData();
    } catch (err) {
      showError("删除失败");
    }
  };

  const getStatus = (id: string) => statuses.find(s => s.id === id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", padding: "var(--space-4)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Wrench size={16} />
          MCP 服务
        </h3>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button onClick={loadData} title="刷新" style={{
            ...actionBtnStyle, width: 32, height: 32,
            border: "1px solid var(--border-primary)",
          }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
             onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setShowAdd(true)} style={{
            display: "flex", alignItems: "center", gap: "var(--space-1)",
            padding: "var(--space-1) var(--space-3)",
            background: "var(--interactive)", color: "#fff",
            fontSize: "var(--text-sm)", fontWeight: 500,
            borderRadius: "var(--radius-lg)", border: "none", cursor: "pointer",
          }}>
            <Plus size={14} /> 添加
          </button>
        </div>
      </div>

      {/* Info text */}
      <div style={{
        fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
        background: "var(--bg-secondary)", padding: "var(--space-2) var(--space-3)",
        borderRadius: "var(--radius-md)", lineHeight: 1.5,
      }}>
        MCP (Model Context Protocol) 允许连接外部工具服务器（如 GitHub、Slack、数据库等），
        让 Agent 可以调用这些工具。添加服务器后点击"连接"发现可用工具。
      </div>

      {/* Add form */}
      {showAdd && (
        <ServerEditor onSave={handleAdd} onCancel={() => setShowAdd(false)} />
      )}

      {/* Server list */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "var(--space-8)", color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
          加载中...
        </div>
      ) : servers.length === 0 ? (
        <div style={{ textAlign: "center", padding: "var(--space-8)", color: "var(--text-tertiary)" }}>
          <Server size={32} style={{ marginBottom: "var(--space-3)", opacity: 0.4 }} />
          <p style={{ fontSize: "var(--text-sm)", margin: 0 }}>暂无 MCP 服务器</p>
          <p style={{ fontSize: "var(--text-xs)", margin: 0, marginTop: "var(--space-1)" }}>
            点击「添加」配置第一个 MCP 服务器
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div style={{
            display: "flex", gap: "var(--space-4)", padding: "var(--space-2) var(--space-3)",
            background: "var(--bg-secondary)", borderRadius: "var(--radius-lg)",
            fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
          }}>
            <span>共 {servers.length} 个服务器</span>
            <span style={{ color: "var(--success)" }}>{statuses.filter(s => s.status === "connected").length} 已连接</span>
          </div>
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              config={server}
              status={getStatus(server.id)}
              onConnect={handleConnect}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
