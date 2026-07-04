import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type PendingWorker } from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { StatusBadge } from "../components/hub/StatusBadge.js";
import { DeployWorkerModal } from "../components/hub/DeployWorkerModal.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function WorkerApproval() {
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  const [pending, setPending] = useState<PendingWorker[]>([]);
  const [all, setAll] = useState<PendingWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvedToken, setApprovedToken] = useState<{ id: string; token: string } | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);

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
    const confirmed = await showConfirm({
      title: "批准 Worker",
      message: "确定要批准此 Worker 的接入请求吗？",
      confirmLabel: "确认批准",
      variant: "default",
    });
    if (!confirmed) return;

    try {
      const resp = await api.approveWorker(id);
      setApprovedToken({ id, token: resp.worker_token });
      addToast("success", "Worker 已批准");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to approve worker";
      setError(msg);
      addToast("error", msg);
    }
  };

  const handleReject = async (id: string) => {
    const confirmed = await showConfirm({
      title: "拒绝 Worker",
      message: "确定要拒绝此 Worker 的接入请求吗？",
      confirmLabel: "确认拒绝",
      variant: "danger",
    });
    if (!confirmed) return;

    try {
      await api.rejectWorker(id, "Rejected via admin UI");
      addToast("success", "Worker 已拒绝");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reject worker";
      setError(msg);
      addToast("error", msg);
    }
  };

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
  };

  const headerRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3)",
  };

  const sectionTitleStyle: CSSProperties = {
    fontSize: "var(--text-base)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
  };

  const errorStyle: CSSProperties = {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  };

  const tokenBannerStyle: CSSProperties = {
    padding: "var(--space-4)",
    background: "var(--success-light)",
    border: "1px solid var(--success)",
    borderRadius: "var(--radius-xl)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  const tokenTitleStyle: CSSProperties = {
    fontWeight: 600,
    color: "var(--success-dark)",
    fontSize: "var(--text-sm)",
  };

  const tokenValueStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    color: "var(--success-dark)",
    fontFamily: "var(--font-mono)",
    wordBreak: "break-all",
  };

  const loadingStyle: CSSProperties = {
    padding: "var(--space-10)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  const emptyStyle: CSSProperties = {
    padding: "var(--space-5)",
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  const pendingCardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderLeft: "4px solid var(--warning)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-4)",
  };

  const cardRowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-3)",
    flexWrap: "wrap",
  };

  const workerNameStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--text-primary)",
  };

  const workerMetaStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
  };

  const workerIdStyle: CSSProperties = {
    fontSize: 11,
    color: "var(--text-tertiary)",
    marginTop: "var(--space-1)",
    fontFamily: "var(--font-mono)",
  };

  const actionRowStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-2)",
  };

  const tableCardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    overflow: "hidden",
  };

  const thStyle: CSSProperties = {
    textAlign: "left",
    padding: "var(--space-3)",
    fontWeight: 500,
    color: "var(--text-primary)",
    fontSize: "var(--text-sm)",
    background: "var(--bg-tertiary)",
  };

  const tdStyle: CSSProperties = {
    padding: "var(--space-3)",
    color: "var(--text-primary)",
    fontSize: "var(--text-sm)",
    borderTop: "1px solid var(--border-primary)",
  };

  const sectionHeaderStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  };

  return (
    <div style={pageStyle}>
      <div style={headerRowStyle}>
        <h2 style={titleStyle}>Worker 审批</h2>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          onClick={() => setDeployOpen(true)}
        >
          添加 Worker
        </Button>
      </div>

      <DeployWorkerModal
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        onDeployed={load}
      />

      {error && <div style={errorStyle}>{error}</div>}

      {approvedToken && (
        <div style={tokenBannerStyle}>
          <div style={tokenTitleStyle}>
            Worker {approvedToken.id.slice(0, 12)} 已批准
          </div>
          <div style={tokenValueStyle}>
            Token: {approvedToken.token}
          </div>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setApprovedToken(null)}
            >
              关闭
            </Button>
          </div>
        </div>
      )}

      {/* Pending section */}
      <div style={sectionHeaderStyle}>
        <h3 style={sectionTitleStyle}>待审批</h3>
        <Badge variant="warning">{pending.length}</Badge>
      </div>

      {loading ? (
        <div style={loadingStyle}>加载中...</div>
      ) : pending.length === 0 ? (
        <div style={emptyStyle}>无待审批 Worker</div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {pending.map((w) => (
            <div key={w.id} style={pendingCardStyle}>
              <div style={cardRowStyle}>
                <div>
                  <div style={workerNameStyle}>{w.name}</div>
                  <div style={workerMetaStyle}>
                    hostname: {w.hostname} · protocol: v{w.protocol_version} · applied: {w.applied_at ? new Date(w.applied_at).toLocaleString("zh-CN") : "-"}
                  </div>
                  <div style={workerIdStyle}>{w.id}</div>
                </div>
                <div style={actionRowStyle}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleApprove(w.id)}
                  >
                    批准
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleReject(w.id)}
                  >
                    拒绝
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* All workers section */}
      <div style={sectionHeaderStyle}>
        <h3 style={sectionTitleStyle}>所有 Worker</h3>
        <Badge variant="default">{all.length}</Badge>
      </div>

      <div style={tableCardStyle}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>名称</th>
              <th style={thStyle}>Hostname</th>
              <th style={thStyle}>协议</th>
              <th style={thStyle}>状态</th>
            </tr>
          </thead>
          <tbody>
            {all.map((w) => (
              <tr key={w.id}>
                <td style={tdStyle}>
                  <Link to={`/workers/${w.id}`} style={{ color: "var(--brand-primary)", textDecoration: "none" }}>
                    {w.name}
                  </Link>
                </td>
                <td style={tdStyle}>{w.hostname}</td>
                <td style={tdStyle}>v{w.protocol_version}</td>
                <td style={tdStyle}>
                  <StatusBadge status={w.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
