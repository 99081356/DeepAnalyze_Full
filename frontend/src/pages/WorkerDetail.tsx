import { useState, useEffect, useCallback, type CSSProperties } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../api/client.js";
import { useUIStore } from "../store/ui.js";
import { Button } from "../components/ui/Button.js";
import { Badge } from "../components/ui/Badge.js";
import { UpgradeWorkerModal } from "../components/hub/UpgradeWorkerModal.js";
import type { WorkerDetail, WorkerBackup } from "../api/client.js";

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function WorkerDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [backups, setBackups] = useState<WorkerBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "backups">(
    "overview",
  );
  const addToast = useUIStore((s) => s.addToast);
  const showConfirm = useUIStore((s) => s.showConfirm);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [w, b] = await Promise.all([
        api.deploy.getWorker(id),
        api.deploy.listBackups(id),
      ]);
      setWorker(w);
      setBackups(b.items);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载失败";
      addToast("error", `加载 worker 失败: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [id, addToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleManualBackup = async () => {
    try {
      await api.deploy.createBackup(id, "manual");
      addToast("success", "已创建手动备份记录");
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "创建失败";
      addToast("error", `创建备份失败: ${msg}`);
    }
  };

  const handleRollbackToBackup = async (
    backupId: string,
    fromTag: string | null,
  ) => {
    const ok = await showConfirm({
      title: "回滚到此备份",
      message: fromTag
        ? `将回滚到版本 ${fromTag}。当前正在运行的容器将被替换。确认继续？`
        : "将回滚到此备份对应的版本。确认继续？",
      confirmLabel: "确认回滚",
      variant: "warning",
    });
    if (!ok) return;
    try {
      await api.deploy.rollback(id, backupId);
      addToast("success", "回滚任务已启动");
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "回滚失败";
      addToast("error", `回滚失败: ${msg}`);
    }
  };

  const handleDeleteBackup = async (backupId: string) => {
    const ok = await showConfirm({
      title: "删除备份",
      message: "删除备份记录（不会自动删除远端文件）。确认继续？",
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.deploy.deleteBackup(id, backupId);
      addToast("success", "备份已删除");
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      addToast("error", `删除失败: ${msg}`);
    }
  };

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };
  const headerStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-4)",
  };
  const titleRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  };
  const tabNavStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-1)",
    borderBottom: "1px solid var(--border-primary)",
  };
  const tabBtnBase: CSSProperties = {
    padding: "var(--space-2) var(--space-4)",
    fontSize: "var(--text-sm)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    borderBottom: "2px solid transparent",
  };
  const tabBtnActive: CSSProperties = {
    ...tabBtnBase,
    borderBottom: "2px solid var(--brand-primary)",
    color: "var(--brand-primary)",
    fontWeight: 600,
  };
  const cardsGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "var(--space-3)",
  };
  const cardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  };
  const cardLabelStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
  };
  const cardValueStyle: CSSProperties = {
    fontSize: "var(--text-base)",
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
  };
  const tableWrapperStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-lg)",
    overflow: "hidden",
  };
  const thStyle: CSSProperties = {
    padding: "var(--space-2) var(--space-3)",
    textAlign: "left",
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    borderBottom: "1px solid var(--border-primary)",
    background: "var(--bg-secondary)",
  };
  const tdStyle: CSSProperties = {
    padding: "var(--space-2) var(--space-3)",
    fontSize: "var(--text-sm)",
    borderBottom: "1px solid var(--border-secondary)",
  };
  const actionsColStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-1)",
  };
  const loadingStyle: CSSProperties = {
    padding: "var(--space-5)",
    color: "var(--text-secondary)",
  };

  if (loading) {
    return <div style={loadingStyle}>加载中...</div>;
  }

  if (!worker) {
    return (
      <div style={loadingStyle}>
        Worker 不存在或加载失败。{" "}
        <Link to="/workers">返回列表</Link>
      </div>
    );
  }

  const backupStatusVariant = (
    s: WorkerBackup["status"],
  ): "success" | "warning" | "error" | "default" => {
    if (s === "verified" || s === "restored") return "success";
    if (s === "created") return "warning";
    if (s === "failed" || s === "expired") return "error";
    return "default";
  };

  return (
    <div style={pageStyle}>
      <div>
        <Link
          to="/workers"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-1)",
            color: "var(--text-secondary)",
            fontSize: "var(--text-sm)",
            textDecoration: "none",
          }}
        >
          <ArrowLeft size={14} /> Worker 列表
        </Link>
      </div>

      <div style={headerStyle}>
        <div style={titleRowStyle}>
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-xl)",
              fontWeight: 600,
            }}
          >
            {worker.hostname}
          </h2>
          <Badge
            variant={
              worker.status === "online" || worker.status === "approved"
                ? "success"
                : "default"
            }
            size="sm"
          >
            {worker.status}
          </Badge>
        </div>
        <Button variant="primary" size="md" onClick={() => setShowUpgrade(true)}>
          升级
        </Button>
      </div>

      <div style={tabNavStyle}>
        <button
          style={activeTab === "overview" ? tabBtnActive : tabBtnBase}
          onClick={() => setActiveTab("overview")}
        >
          概览
        </button>
        <button
          style={activeTab === "backups" ? tabBtnActive : tabBtnBase}
          onClick={() => setActiveTab("backups")}
        >
          备份历史 {backups.length > 0 && `(${backups.length})`}
        </button>
      </div>

      {activeTab === "overview" && (
        <div style={cardsGridStyle}>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>当前版本</span>
            <span style={cardValueStyle}>
              {worker.current_image_tag ?? "（未设置）"}
            </span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>DA 版本</span>
            <span style={cardValueStyle}>{worker.da_version ?? "-"}</span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>主机</span>
            <span style={cardValueStyle}>
              {worker.ssh_target_host ?? worker.host_name ?? "-"}
            </span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>端口</span>
            <span style={cardValueStyle}>{worker.host_port ?? "-"}</span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>最近心跳</span>
            <span style={cardValueStyle}>
              {worker.last_heartbeat_at
                ? new Date(worker.last_heartbeat_at).toLocaleString("zh-CN")
                : "从未"}
            </span>
          </div>
          <div style={cardStyle}>
            <span style={cardLabelStyle}>心跳状态</span>
            <span style={cardValueStyle}>
              {worker.last_heartbeat_ok === null
                ? "未知"
                : worker.last_heartbeat_ok
                  ? "正常"
                  : "异常"}
            </span>
          </div>
        </div>
      )}

      {activeTab === "backups" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleManualBackup}
            >
              创建手动备份
            </Button>
          </div>
          <div style={tableWrapperStyle}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>类型</th>
                  <th style={thStyle}>从版本</th>
                  <th style={thStyle}>到版本</th>
                  <th style={thStyle}>大小</th>
                  <th style={thStyle}>创建时间</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {backups.length === 0 ? (
                  <tr>
                    <td style={tdStyle} colSpan={7}>
                      <span style={{ color: "var(--text-secondary)" }}>
                        暂无备份记录
                      </span>
                    </td>
                  </tr>
                ) : (
                  backups.map((b) => (
                    <tr key={b.id}>
                      <td style={tdStyle}>{b.backup_type}</td>
                      <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
                        {b.from_tag ?? "-"}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
                        {b.to_tag ?? "-"}
                      </td>
                      <td style={tdStyle}>
                        {b.size_bytes
                          ? `${(b.size_bytes / 1e9).toFixed(2)} GB`
                          : "-"}
                      </td>
                      <td style={tdStyle}>
                        {new Date(b.created_at).toLocaleString("zh-CN")}
                      </td>
                      <td style={tdStyle}>
                        <Badge
                          variant={backupStatusVariant(b.status)}
                          size="sm"
                        >
                          {b.status}
                        </Badge>
                      </td>
                      <td style={tdStyle}>
                        <div style={actionsColStyle}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              handleRollbackToBackup(b.id, b.from_tag)
                            }
                          >
                            回滚
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteBackup(b.id)}
                          >
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <UpgradeWorkerModal
        workerId={worker.id}
        currentTag={worker.current_image_tag}
        hostname={worker.hostname}
        open={showUpgrade}
        onClose={() => setShowUpgrade(false)}
        onUpgraded={() => {
          setShowUpgrade(false);
          void refresh();
        }}
      />
    </div>
  );
}

export default WorkerDetailPage;
