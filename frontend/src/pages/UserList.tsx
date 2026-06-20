import { useEffect, useState, useCallback } from "react";
import { api, type UserListResponse } from "../api/client.js";

export function UserList() {
  const [data, setData] = useState<UserListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({
    username: "",
    password: "",
    display_name: "",
    organization_id: "",
    is_org_admin: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getUsers({ limit: 100 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!newUser.username || !newUser.password) return;
    try {
      await api.createUser({
        username: newUser.username,
        password: newUser.password,
        display_name: newUser.display_name || undefined,
        organization_id: newUser.organization_id || null,
        is_org_admin: newUser.is_org_admin,
      });
      setNewUser({ username: "", password: "", display_name: "", organization_id: "", is_org_admin: false });
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>用户列表 ({data?.total ?? 0})</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            padding: "6px 14px", background: "#2563eb", color: "white",
            border: "none", borderRadius: 4, fontSize: 13, cursor: "pointer",
          }}
        >
          {showCreate ? "取消" : "+ 新建用户"}
        </button>
      </div>

      {showCreate && (
        <div style={{
          background: "white", padding: 16, marginBottom: 16, borderRadius: 8,
          display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end",
        }}>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>用户名</label>
            <input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>密码</label>
            <input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>显示名</label>
            <input value={newUser.display_name} onChange={(e) => setNewUser({ ...newUser, display_name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>组织 ID</label>
            <input placeholder="可选" value={newUser.organization_id} onChange={(e) => setNewUser({ ...newUser, organization_id: e.target.value })} style={inputStyle} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
            <input type="checkbox" checked={newUser.is_org_admin} onChange={(e) => setNewUser({ ...newUser, is_org_admin: e.target.checked })} />
            组织管理员
          </label>
          <button onClick={handleCreate} style={{ padding: "8px 16px", background: "#059669", color: "white", border: "none", borderRadius: 4, cursor: "pointer" }}>
            创建
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: 12, background: "#fee2e2", color: "#991b1b", borderRadius: 4, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ background: "white", borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th style={thStyle}>用户名</th>
              <th style={thStyle}>显示名</th>
              <th style={thStyle}>角色</th>
              <th style={thStyle}>组织</th>
              <th style={thStyle}>最后登录</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ textAlign: "center", padding: 40, color: "#6b7280" }}>加载中...</td></tr>
            ) : data?.users.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                <td style={tdStyle}>{u.username}</td>
                <td style={tdStyle}>{u.display_name || "-"}</td>
                <td style={tdStyle}>
                  {u.is_super_admin ? (
                    <span style={{ color: "#dc2626", fontWeight: 500 }}>超级管理员</span>
                  ) : u.is_org_admin ? (
                    <span style={{ color: "#2563eb" }}>组织管理员</span>
                  ) : (
                    <span style={{ color: "#6b7280" }}>普通用户</span>
                  )}
                </td>
                <td style={tdStyle}>{u.organization_id?.slice(0, 8) ?? "-"}</td>
                <td style={tdStyle}>{u.last_login_at ? new Date(u.last_login_at).toLocaleString("zh-CN") : "从未"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { textAlign: "left", padding: "10px 12px", fontWeight: 500, color: "#374151" };
const tdStyle: React.CSSProperties = { padding: "10px 12px", color: "#111827" };
const inputStyle: React.CSSProperties = {
  padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 13, minWidth: 120,
};
