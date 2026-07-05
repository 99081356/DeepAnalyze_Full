import { useState, useEffect } from "react";
import { api } from "../../api/client";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<"none" | "local" | "hub" | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isSetup, setIsSetup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.auth.getAuthMode().then(d => setMode(d.mode)).catch(() => setMode("none"));
  }, []);

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      if (isSetup) {
        if (password !== confirm) {
          setError("密码不一致");
          return;
        }
        if (password.length < 6) {
          setError("密码至少 6 位");
          return;
        }
        await api.auth.setup(username, password);
      }
      await api.auth.login(username, password);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mode) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)" }}>
        <div style={{ color: "var(--text-secondary)" }}>Loading...</div>
      </div>
    );
  }

  if (mode === "none") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)" }}>
        <div style={{ color: "var(--text-secondary)" }}>无需认证</div>
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg-secondary)",
    color: "var(--text-primary)",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "var(--bg-primary)",
    }}>
      <div style={{
        width: "360px",
        padding: "32px",
        background: "var(--bg-secondary)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border-primary)",
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}>
        <h1 style={{ margin: 0, textAlign: "center", color: "var(--text-primary)", fontSize: "24px" }}>
          DeepAnalyze
        </h1>
        <p style={{ margin: 0, textAlign: "center", color: "var(--text-secondary)", fontSize: "13px", marginBottom: "8px" }}>
          {mode === "hub" ? "企业登录" : "本地登录"}
        </p>

        {error && (
          <div style={{
            padding: "8px 12px",
            background: "var(--danger-bg, rgba(220,53,69,0.1))",
            color: "var(--danger-text, #dc3545)",
            borderRadius: "var(--radius-sm)",
            fontSize: "13px",
          }}>
            {error}
          </div>
        )}

        <input
          type="text"
          placeholder="用户名"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
          style={inputStyle}
          onKeyDown={e => e.key === "Enter" && submit()}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          style={inputStyle}
          onKeyDown={e => e.key === "Enter" && submit()}
        />
        {isSetup && (
          <input
            type="password"
            placeholder="确认密码"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            style={inputStyle}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        )}

        <button
          onClick={submit}
          disabled={busy}
          style={{
            padding: "10px 12px",
            border: "none",
            borderRadius: "var(--radius-md)",
            background: busy ? "var(--btn-disabled-bg, #6c757d)" : "var(--accent-primary, #0d6efd)",
            color: "var(--btn-text, #fff)",
            fontSize: "14px",
            cursor: busy ? "not-allowed" : "pointer",
            fontWeight: 500,
          }}
        >
          {busy ? "处理中..." : isSetup ? "初始化并登录" : "登录"}
        </button>

        {mode === "local" && !isSetup && (
          <button
            onClick={() => setIsSetup(true)}
            style={{
              padding: "6px",
              border: "none",
              background: "transparent",
              color: "var(--text-link, #0d6efd)",
              fontSize: "13px",
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            首次设置管理员
          </button>
        )}
      </div>
    </div>
  );
}
