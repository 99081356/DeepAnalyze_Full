import { useEffect, useState, useCallback } from "react";
import { api, type MeResponse, type UserListResponse } from "../api/client.js";

// 部署操作的 in-flight 反馈（按钮形态由持久化的 u.da_url 决定，这里只管 loading/error）
interface DeployState {
  loading: boolean;
  error?: string;
}

// Worker 状态 → 徽章颜色
function workerBadge(status: string | null): { text: string; color: string } | null {
  if (!status) return null;
  switch (status) {
    case "approved":
    case "online":
      return { text: status, color: "#059669" };
    case "deploying":
      return { text: "部署中", color: "#f59e0b" };
    case "error":
      return { text: "错误", color: "#dc2626" };
    case "decommissioned":
      return { text: "已下线", color: "#6b7280" };
    default:
      return { text: status, color: "#6b7280" };
  }
}

export function UserList({ user: currentUser }: { user: MeResponse }) {
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
  // 每个用户的部署/删除操作 in-flight 状态
  const [deployStates, setDeployStates] = useState<Record<string, DeployState>>({});
  // 编辑目标
  const [editing, setEditing] = useState<{
    id: string;
    display_name: string;
    email: string;
    organization_id: string;
    is_org_admin: boolean;
    password: string; // 留空表示不改
  } | null>(null);

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

  const handleUpdate = async () => {
    if (!editing) return;
    try {
      const patch: Parameters<typeof api.updateUser>[1] = {
        display_name: editing.display_name || undefined,
        email: editing.email || null,
        organization_id: editing.organization_id || null,
        is_org_admin: editing.is_org_admin,
      };
      if (editing.password) patch.password = editing.password;
      await api.updateUser(editing.id, patch);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update user");
    }
  };

  const handleDisableUser = async (userId: string) => {
    if (!confirm("确定要禁用该用户吗？（软操作，可恢复；用户无法再登录，Worker 容器保持不动）")) return;
    try {
      await api.disableUser(userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable user");
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm("⚠️ 确定要永久删除该用户吗？\n\n此操作不可恢复，将连带清除其所有 Worker 容器及相关数据。")) return;
    try {
      await api.deleteUser(userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  const handleDeploy = async (userId: string) => {
    setDeployStates(prev => ({ ...prev, [userId]: { loading: true } }));
    try {
      await api.deployUserWorker(userId);
      setDeployStates(prev => ({ ...prev, [userId]: { loading: false } }));
      // 重新加载列表，让按钮形态由持久化的 da_url 决定（刷新页面也能保持）
      await load();
    } catch (err) {
      setDeployStates(prev => ({
        ...prev,
        [userId]: {
          loading: false,
          error: err instanceof Error ? err.message : "部署失败",
        },
      }));
    }
  };

  const handleDeleteWorker = async (userId: string) => {
    if (!confirm("确定要删除该用户的 Worker 容器吗？")) return;
    setDeployStates(prev => ({ ...prev, [userId]: { loading: true } }));
    try {
      await api.deleteUserWorker(userId);
      setDeployStates(prev => ({ ...prev, [userId]: { loading: false } }));
      await load();
    } catch (err) {
      setDeployStates(prev => ({
        ...prev,
        [userId]: {
          loading: false,
          error: err instanceof Error ? err.message : "删除失败",
        },
      }));
    }
  };

  const startEdit = (u: UserListResponse["users"][number]) => {
    setEditing({
      id: u.id,
      display_name: u.display_name ?? "",
      email: "", // 列表未返回 email，留空表示不改；用户可主动填写
      organization_id: u.organization_id ?? "",
      is_org_admin: u.is_org_admin,
      password: "",
    });
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

      {editing && (
        <div style={{
          background: "white", padding: 16, marginBottom: 16, borderRadius: 8,
          display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end",
          border: "1px solid #f59e0b",
        }}>
          <div style={{ width: "100%", fontSize: 14, fontWeight: 600, color: "#92400e", marginBottom: 4 }}>
            编辑用户（留空表示不修改该字段）
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>显示名</label>
            <input value={editing.display_name} onChange={(e) => setEditing({ ...editing, display_name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>邮箱</label>
            <input placeholder="留空不改" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>组织 ID</label>
            <input value={editing.organization_id} onChange={(e) => setEditing({ ...editing, organization_id: e.target.value })} style={inputStyle} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
            <input type="checkbox" checked={editing.is_org_admin} onChange={(e) => setEditing({ ...editing, is_org_admin: e.target.checked })} />
            组织管理员
          </label>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>重置密码</label>
            <input type="password" placeholder="留空不改" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} style={inputStyle} />
          </div>
          <button onClick={handleUpdate} style={{ padding: "8px 16px", background: "#2563eb", color: "white", border: "none", borderRadius: 4, cursor: "pointer" }}>
            保存
          </button>
          <button onClick={() => setEditing(null)} style={{ padding: "8px 16px", background: "#e5e7eb", color: "#374151", border: "none", borderRadius: 4, cursor: "pointer" }}>
            取消
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
              <th style={thStyle}>Worker</th>
              <th style={thStyle}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "#6b7280" }}>加载中...</td></tr>
            ) : data?.users.map((u) => {
              const ds = deployStates[u.id];
              const hasWorker = !!u.da_url;
              const badge = workerBadge(u.worker_status);
              return (
                <tr key={u.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={tdStyle}>
                    {u.username}
                    {u.status && u.status !== "active" && (
                      <span style={{ marginLeft: 6, fontSize: 11, color: "#dc2626" }}>({u.status})</span>
                    )}
                  </td>
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
                  <td style={tdStyle}>
                    {ds?.error ? (
                      <span style={{ color: "#dc2626", fontSize: 12 }}>{ds.error}</span>
                    ) : hasWorker ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {badge && (
                          <span style={{
                            padding: "1px 6px", fontSize: 11, borderRadius: 8,
                            background: `${badge.color}1a`, color: badge.color, border: `1px solid ${badge.color}40`,
                          }}>
                            {badge.text}
                          </span>
                        )}
                        <a href={u.da_url!} target="_blank" rel="noopener noreferrer" style={{ color: "#059669", fontSize: 12 }}>
                          {u.da_url}
                        </a>
                      </div>
                    ) : (
                      <span style={{ color: "#9ca3af" }}>-</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        onClick={() => startEdit(u)}
                        style={{
                          padding: "4px 10px",
                          background: "#2563eb",
                          color: "white",
                          border: "none",
                          borderRadius: 4,
                          fontSize: 12,
                          cursor: "pointer",
                        }}
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleDeploy(u.id)}
                        disabled={ds?.loading}
                        style={{
                          padding: "4px 10px",
                          background: hasWorker ? "#f59e0b" : "#059669",
                          color: "white",
                          border: "none",
                          borderRadius: 4,
                          fontSize: 12,
                          cursor: ds?.loading ? "not-allowed" : "pointer",
                          opacity: ds?.loading ? 0.6 : 1,
                        }}
                      >
                        {ds?.loading ? "部署中..." : hasWorker ? "重新部署" : "部署Worker"}
                      </button>
                      {hasWorker && (
                        <button
                          onClick={() => handleDeleteWorker(u.id)}
                          disabled={ds?.loading}
                          style={{
                            padding: "4px 10px",
                            background: "#f97316",
                            color: "white",
                            border: "none",
                            borderRadius: 4,
                            fontSize: 12,
                            cursor: "pointer",
                          }}
                        >
                          删除Worker
                        </button>
                      )}
                      {/* 不允许操作自己 */}
                      {u.id !== currentUser.id && (
                        <>
                          {/* 禁用：org_admin 即可（user:update 权限），软操作可恢复 */}
                          {(currentUser.is_super_admin || currentUser.is_org_admin) && (
                            <button
                              onClick={() => handleDisableUser(u.id)}
                              style={{
                                padding: "4px 10px",
                                background: "#f97316",
                                color: "white",
                                border: "none",
                                borderRadius: 4,
                                fontSize: 12,
                                cursor: "pointer",
                              }}
                            >
                              禁用
                            </button>
                          )}
                          {/* 删除：仅 super_admin（user:delete 权限），物理删除不可恢复 */}
                          {currentUser.is_super_admin && (
                            <button
                              onClick={() => handleDeleteUser(u.id)}
                              style={{
                                padding: "4px 10px",
                                background: "#dc2626",
                                color: "white",
                                border: "none",
                                borderRadius: 4,
                                fontSize: 12,
                                cursor: "pointer",
                              }}
                            >
                              删除
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
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
