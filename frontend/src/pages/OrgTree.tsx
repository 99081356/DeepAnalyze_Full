import { useEffect, useState, useCallback } from "react";
import { api, type OrgNode } from "../api/client.js";

function renderNode(node: OrgNode, depth = 0): React.ReactNode {
  return (
    <div key={node.id} style={{ marginLeft: depth * 24 }}>
      <div style={{
        padding: "8px 12px",
        background: "white",
        marginBottom: 4,
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{node.name}</span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>({node.code})</span>
        <span style={{
          padding: "1px 8px", background: "#dbeafe", color: "#1e40af",
          fontSize: 11, borderRadius: 10,
        }}>{node.type}</span>
        {node.user_count !== undefined && (
          <span style={{ fontSize: 11, color: "#6b7280" }}>👥 {node.user_count}</span>
        )}
      </div>
      {node.children?.map((child) => renderNode(child, depth + 1))}
    </div>
  );
}

export function OrgTree() {
  const [tree, setTree] = useState<OrgNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newOrg, setNewOrg] = useState({ name: "", code: "", type: "department", parent_id: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.getOrgTree();
      setTree(resp.tree);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load org tree");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!newOrg.name || !newOrg.code) return;
    try {
      await api.createOrg({
        name: newOrg.name,
        code: newOrg.code,
        type: newOrg.type,
        parent_id: newOrg.parent_id || null,
      });
      setNewOrg({ name: "", code: "", type: "department", parent_id: "" });
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create org");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>组织树</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            padding: "6px 14px", background: "#2563eb", color: "white",
            border: "none", borderRadius: 4, fontSize: 13, cursor: "pointer",
          }}
        >
          {showCreate ? "取消" : "+ 新建组织"}
        </button>
      </div>

      {showCreate && (
        <div style={{
          background: "white", padding: 16, marginBottom: 16, borderRadius: 8,
          display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end",
        }}>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>名称</label>
            <input value={newOrg.name} onChange={(e) => setNewOrg({ ...newOrg, name: e.target.value })}
              style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>代码</label>
            <input value={newOrg.code} onChange={(e) => setNewOrg({ ...newOrg, code: e.target.value })}
              style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block" }}>类型</label>
            <select value={newOrg.type} onChange={(e) => setNewOrg({ ...newOrg, type: e.target.value })}
              style={inputStyle}>
              <option value="company">公司</option>
              <option value="department">部门</option>
              <option value="team">团队</option>
            </select>
          </div>
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

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>加载中...</div>
      ) : tree ? (
        renderNode(tree)
      ) : (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>无数据</div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontSize: 13,
  minWidth: 120,
};
