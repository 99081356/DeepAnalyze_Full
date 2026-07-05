import { useState, useEffect } from "react";
import { api } from "../../api/client";
import { ShieldCheck } from "lucide-react";

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

export function AuthPanel() {
  const [settings, setSettings] = useState<{ mode?: string }>({});
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get<{ mode?: string }>("/api/settings/auth")
      .then(setSettings)
      .catch(() => {});
  }, []);

  const changePassword = async () => {
    setMsg(""); setError(false);
    try {
      await api.post("/api/auth/change-password", { current: currentPassword, next: newPassword });
      setMsg("密码已修改"); setCurrentPassword(""); setNewPassword("");
    } catch (e) {
      setError(true);
      setMsg(e instanceof Error ? e.message : "修改失败");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
        <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0, marginBottom: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <ShieldCheck size={14} />
          认证模式
        </h3>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
          当前模式：<strong style={{ color: "var(--text-primary)" }}>{settings.mode || "加载中..."}</strong>
        </div>
      </div>

      {settings.mode === "local" && (
        <div style={{ padding: "var(--space-4)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-xl)" }}>
          <h3 style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)", color: "var(--text-primary)", margin: 0, marginBottom: "var(--space-3)" }}>
            修改密码
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div>
              <label style={labelStyle}>当前密码</label>
              <input type="password" placeholder="当前密码" value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>新密码（至少6位）</label>
              <input type="password" placeholder="新密码" value={newPassword}
                onChange={e => setNewPassword(e.target.value)} style={inputStyle} />
            </div>
            <button onClick={changePassword}
              disabled={!currentPassword || !newPassword}
              style={{
                padding: "var(--space-2) var(--space-4)", alignSelf: "flex-start",
                background: "var(--interactive)", color: "#fff", border: "none",
                borderRadius: "var(--radius-lg)", fontSize: "var(--text-sm)",
                fontWeight: "var(--font-medium)", cursor: "pointer",
                opacity: (!currentPassword || !newPassword) ? 0.5 : 1,
              }}>
              提交
            </button>
            {msg && (
              <div style={{ fontSize: "var(--text-sm)", color: error ? "var(--error)" : "var(--success)" }}>
                {msg}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
