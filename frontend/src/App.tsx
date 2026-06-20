import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from "react-router-dom";
import { api, type MeResponse } from "./api/client.js";
import { Login } from "./pages/Login.js";
import { Dashboard } from "./pages/Dashboard.js";
import { OrgTree } from "./pages/OrgTree.js";
import { UserList } from "./pages/UserList.js";
import { WorkerApproval } from "./pages/WorkerApproval.js";

function Layout({ user, onLogout, children }: { user: MeResponse; onLogout: () => void; children: React.ReactNode }) {
  const location = useLocation();
  const navItems = [
    { to: "/", label: "仪表盘" },
    { to: "/orgs", label: "组织树" },
    { to: "/users", label: "用户" },
    { to: "/workers", label: "Worker 审批" },
  ];
  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <aside style={{ width: 220, background: "#1f2937", color: "#e5e7eb", padding: "20px 0" }}>
        <div style={{ padding: "0 20px 24px", fontSize: 18, fontWeight: 600 }}>
          DeepAnalyze Hub
        </div>
        <nav>
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              style={{
                display: "block",
                padding: "10px 20px",
                color: location.pathname === item.to ? "#ffffff" : "#9ca3af",
                textDecoration: "none",
                background: location.pathname === item.to ? "#374151" : "transparent",
                fontSize: 14,
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, background: "#f3f4f6" }}>
        <header style={{
          padding: "12px 24px",
          background: "white",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <div />
          <div style={{ fontSize: 14 }}>
            <span style={{ color: "#4b5563" }}>{user.display_name || user.username}</span>
            {user.is_super_admin && (
              <span style={{ marginLeft: 8, color: "#dc2626", fontSize: 12 }}>超级管理员</span>
            )}
            <button
              onClick={onLogout}
              style={{ marginLeft: 16, padding: "4px 12px", cursor: "pointer", border: "1px solid #d1d5db", background: "white" }}
            >
              退出
            </button>
          </div>
        </header>
        <div style={{ padding: 24 }}>{children}</div>
      </main>
    </div>
  );
}

function ProtectedRoute({ user, setUser, children }: { user: MeResponse | null; setUser: (u: MeResponse | null) => void; children: React.ReactNode }) {
  const [loading, setLoading] = useState(!user);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem("hub_access_token");
    if (!token) {
      navigate("/login");
      return;
    }
    if (!user) {
      api.me()
        .then((u) => {
          setUser(u);
          setLoading(false);
        })
        .catch(() => {
          localStorage.removeItem("hub_access_token");
          navigate("/login");
        });
    }
  }, [user, setUser, navigate]);

  if (loading || !user) {
    return <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>加载中...</div>;
  }

  return <Layout user={user} onLogout={() => { localStorage.removeItem("hub_access_token"); setUser(null); navigate("/login"); }}>{children}</Layout>;
}

export default function App() {
  const [user, setUser] = useState<MeResponse | null>(null);

  return (
    <Routes>
      <Route path="/login" element={<Login onLogin={setUser} />} />
      <Route path="/" element={<ProtectedRoute user={user} setUser={setUser}><Dashboard /></ProtectedRoute>} />
      <Route path="/orgs" element={<ProtectedRoute user={user} setUser={setUser}><OrgTree /></ProtectedRoute>} />
      <Route path="/users" element={<ProtectedRoute user={user} setUser={setUser}><UserList /></ProtectedRoute>} />
      <Route path="/workers" element={<ProtectedRoute user={user} setUser={setUser}><WorkerApproval /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
