import { useEffect, useState, useCallback } from "react";
import { api, type PendingWorker } from "../api/client.js";

export function WorkerApproval() {
  const [pending, setPending] = useState<PendingWorker[]>([]);
  const [all, setAll] = useState<PendingWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvedToken, setApprovedToken] = useState<{ id: string; token: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, a] = await Promise.all([api.getPendingWorkers(), api.getAllWorkers()]);
      setPending(p.workers);
      setAll(a.workers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (id: string) => {
    try {
      const resp = await api.approveWorker(id);
      setApprovedToken({ id, token: resp.worker_token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve worker");
    }
  };

  const handleReject = async (id: string) => {
    const reason = prompt("拒绝原因（可选）:");
    try {
      await api.rejectWorker(id, reason || undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject worker");
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Worker 审批</h2>

      {error && (
        <div style={{ padding: 12, background: "#fee2e2", color: "#991b1b", borderRadius: 4, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {approvedToken && (
        <div style={{
          padding: 16, background: "#d1fae5", border: "1px solid #6ee7b7",
          borderRadius: 4, marginBottom: 16,
        }}>
          <div style={{ fontWeight: 500, color: "#065f46", marginBottom: 8 }}>
            ✅ Worker {approvedToken.id.slice(0, 12)} 已批准
          </div>
          <div style={{ fontSize: 12, color: "#064e3b", fontFamily: "monospace", wordBreak: "break-all" }}>
            Token: {approvedToken.token}
          </div>
          <button
            onClick={() => setApprovedToken(null)}
            style={{ marginTop: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
          >关闭</button>
        </div>
      )}

      <h3 style={{ fontSize: 16, fontWeight: 500, margin: "24px 0 12px" }}>待审批 ({pending.length})</h3>
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>加载中...</div>
      ) : pending.length === 0 ? (
        <div style={{ padding: 20, background: "white", borderRadius: 8, textAlign: "center", color: "#6b7280", fontSize: 13 }}>
          无待审批 Worker
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {pending.map((w) => (
            <div key={w.id} style={{ background: "white", padding: 16, borderRadius: 8, borderLeft: "4px solid #f59e0b" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{w.name}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                    hostname: {w.hostname} · protocol: v{w.protocol_version} · applied: {w.applied_at ? new Date(w.applied_at).toLocaleString("zh-CN") : "-"}
                  </div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "monospace" }}>
                    {w.id}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => handleApprove(w.id)}
                    style={{ padding: "6px 16px", background: "#059669", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
                  >批准</button>
                  <button
                    onClick={() => handleReject(w.id)}
                    style={{ padding: "6px 16px", background: "#dc2626", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 }}
                  >拒绝</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: 16, fontWeight: 500, margin: "24px 0 12px" }}>所有 Worker ({all.length})</h3>
      <div style={{ background: "white", borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th style={thStyle}>名称</th>
              <th style={thStyle}>Hostname</th>
              <th style={thStyle}>协议</th>
              <th style={thStyle}>状态</th>
            </tr>
          </thead>
          <tbody>
            {all.map((w) => (
              <tr key={w.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                <td style={tdStyle}>{w.name}</td>
                <td style={tdStyle}>{w.hostname}</td>
                <td style={tdStyle}>v{w.protocol_version}</td>
                <td style={tdStyle}>
                  <span style={{
                    padding: "1px 8px", borderRadius: 10, fontSize: 11,
                    background: w.status === "approved" ? "#d1fae5" : w.status === "pending" ? "#fef3c7" : "#fee2e2",
                    color: w.status === "approved" ? "#065f46" : w.status === "pending" ? "#92400e" : "#991b1b",
                  }}>{w.status}</span>
                </td>
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
