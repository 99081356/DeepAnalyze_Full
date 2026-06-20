import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type MeResponse } from "../api/client.js";

export function Login({ onLogin }: { onLogin: (u: MeResponse) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const resp = await api.login(username, password);
      localStorage.setItem("hub_access_token", resp.access_token);
      onLogin(resp.user);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#1f2937",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{
        width: 360,
        padding: 32,
        background: "white",
        borderRadius: 8,
        boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
      }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4, textAlign: "center" }}>
          DeepAnalyze Hub
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", textAlign: "center", marginBottom: 24 }}>
          管理后台登录
        </p>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{
                width: "100%", padding: "8px 12px", fontSize: 14,
                border: "1px solid #d1d5db", borderRadius: 4, boxSizing: "border-box",
              }}
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: "100%", padding: "8px 12px", fontSize: 14,
                border: "1px solid #d1d5db", borderRadius: 4, boxSizing: "border-box",
              }}
            />
          </div>
          {error && (
            <div style={{ padding: "8px 12px", background: "#fee2e2", color: "#991b1b", borderRadius: 4, fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", padding: "10px 12px", background: "#2563eb", color: "white",
              border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
        <p style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", marginTop: 16 }}>
          默认管理员: admin / admin123
        </p>
      </div>
    </div>
  );
}
