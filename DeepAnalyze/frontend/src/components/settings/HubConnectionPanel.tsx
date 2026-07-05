import { useState, useEffect } from "react";
import { api } from "../../api/client";
import { Cloud } from "lucide-react";

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
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--font-medium)",
  color: "var(--text-secondary)",
  marginBottom: "var(--space-1)",
};

export function HubConnectionPanel() {
  const [hubUrl, setHubUrl] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState(false);

  const loadStatus = async () => {
    try {
      const d = await api.get<{ connected?: boolean; hubUrl?: string }>("/api/settings/hub");
      setConnected(!!d.connected);
      setHubUrl(d.hubUrl || "");
    } catch {}
  };

  useEffect(() => { loadStatus(); }, []);

  const connect = async () => {
    setMsg(""); setError(false);
    try {
      const data = await api.post<{ ok?: boolean; error?: string }>("/api/settings/hub/connect", { hubUrl, joinToken });
      if (data.ok) { setConnected(true); setMsg("已连接"); }
      else { setError(true); setMsg(data.error || "连接失败"); }
    } catch (e) {
      setError(true);
      setMsg(e instanceof Error ? e.message : "连接失败");
    }
  };

  const disconnect = async () => {
    setMsg(""); setError(false);
    try {
      await api.post("/api/settings/hub/disconnect", {});
      setConnected(false); setMsg("已断开");
    } catch (e) {
      setError(true);
      setMsg(e instanceof Error ? e.message : "断开失败");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
        <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0, marginBottom: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Cloud size={14} />
          Hub 连接状态
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <div style={{
            width: 10, height: 10, borderRadius: "50%",
            background: connected ? "var(--success)" : "var(--error)",
            flexShrink: 0,
          }} />
          <span style={{ fontSize: "var(--text-sm)", color: connected ? "var(--success)" : "var(--error)", fontWeight: 500 }}>
            {connected ? "已连接" : "未连接"}
          </span>
        </div>
      </div>

      {!connected ? (
        <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
          <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0, marginBottom: "var(--space-3)" }}>
            连接到 Hub
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div>
              <label style={labelStyle}>Hub URL</label>
              <input placeholder="http://hub.example.com:22000" value={hubUrl}
                onChange={e => setHubUrl(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Join Token</label>
              <input placeholder="从 Hub 管理员获取" value={joinToken}
                onChange={e => setJoinToken(e.target.value)} style={inputStyle} />
            </div>
            <button onClick={connect} disabled={!hubUrl || !joinToken}
              style={{
                padding: "var(--space-2) var(--space-4)", alignSelf: "flex-start",
                background: "var(--interactive)", color: "#fff", border: "none",
                borderRadius: "var(--radius-lg)", fontSize: "var(--text-sm)",
                fontWeight: "var(--font-medium)", cursor: "pointer",
                opacity: (!hubUrl || !joinToken) ? 0.5 : 1,
              }}>
              连接
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
          <button onClick={disconnect}
            style={{
              padding: "var(--space-2) var(--space-4)",
              background: "transparent", color: "var(--error)",
              border: "1px solid var(--error)", borderRadius: "var(--radius-lg)",
              fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)",
              cursor: "pointer",
            }}>
            断开连接
          </button>
        </div>
      )}

      {msg && (
        <div style={{
          padding: "var(--space-3)", fontSize: "var(--text-sm)",
          color: error ? "var(--error)" : "var(--success)",
          background: error ? "var(--error-light)" : "var(--success-light)",
          borderRadius: "var(--radius-lg)",
        }}>
          {msg}
        </div>
      )}
    </div>
  );
}
