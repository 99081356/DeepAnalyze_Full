import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, type HostServer } from "../api/client.js";
import { Button } from "../components/ui/Button.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Inline status badge (host_server-specific; not reusing worker StatusBadge) */
/* -------------------------------------------------------------------------- */

const STATUS_LABEL: Record<HostServer["status"], string> = {
  active: "运行中",
  maintenance: "维护中",
  retired: "已退役",
};

const STATUS_VARIANT: Record<
  HostServer["status"],
  { bg: string; color: string; border: string }
> = {
  active: { bg: "var(--success-light)", color: "var(--success-dark)", border: "var(--success)" },
  maintenance: { bg: "var(--warning-light)", color: "var(--warning-dark)", border: "var(--warning)" },
  retired: { bg: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "var(--border-primary)" },
};

function HostServerStatusBadge({ status }: { status: HostServer["status"] }) {
  const v = STATUS_VARIANT[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 var(--space-2)",
        borderRadius: "var(--radius-full)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--font-medium)",
        background: v.bg,
        color: v.color,
        border: `1px solid ${v.border}`,
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function HostServersPage() {
  const addToast = useUIStore((s) => s.addToast);
  const showConfirm = useUIStore((s) => s.showConfirm);
  const [items, setItems] = useState<HostServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getHostServers();
      setItems(data.items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加载物理机列表失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (id: string, hostname: string) => {
    const ok = await showConfirm({
      title: "删除物理机",
      message: `确定删除 ${hostname}？该操作不可逆，关联的 Worker 端口段可能受影响。`,
      confirmLabel: "确认删除",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.deleteHostServer(id);
      addToast("success", `已删除 ${hostname}`);
      await load();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "删除失败");
    }
  };

  /* -- styles (follow WorkerApproval.tsx pattern with CSS variables) -- */

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

  const loadingStyle: CSSProperties = {
    padding: "var(--space-10)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  const errorStyle: CSSProperties = {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
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

  const linkStyle: CSSProperties = {
    color: "var(--brand-primary)",
    textDecoration: "none",
  };

  const deleteBtnStyle: CSSProperties = {
    color: "var(--error)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    padding: 0,
  };

  return (
    <div style={pageStyle}>
      <div style={headerRowStyle}>
        <h2 style={titleStyle}>物理机管理</h2>
        <Link to="/host-servers/new">
          <Button variant="primary" size="sm" icon={<Plus size={14} />}>
            注册新机
          </Button>
        </Link>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {loading ? (
        <div style={loadingStyle}>加载中...</div>
      ) : items.length === 0 ? (
        <div style={emptyStyle}>
          暂无物理机。点击"注册新机"添加第一台。
        </div>
      ) : (
        <div style={tableCardStyle}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Hostname</th>
                <th style={thStyle}>SSH</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>端口范围</th>
                <th style={thStyle}>容量</th>
                <th style={thStyle}>CPU/MEM/GPU</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((hs) => {
                const total = Math.floor(
                  (hs.port_range_end - hs.port_range_start + 1) /
                    hs.port_block_size,
                );
                return (
                  <tr key={hs.id}>
                    <td style={tdStyle}>
                      <Link to={`/host-servers/${hs.id}`} style={linkStyle}>
                        {hs.hostname}
                      </Link>
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      {hs.ssh_user}@{hs.ssh_target_host}:{hs.ssh_target_port}
                    </td>
                    <td style={tdStyle}>
                      <HostServerStatusBadge status={hs.status} />
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      {hs.port_range_start}-{hs.port_range_end}
                    </td>
                    <td style={tdStyle}>{total} 槽</td>
                    <td style={{ ...tdStyle, fontSize: "var(--text-xs)" }}>
                      {hs.cpu_cores ?? "-"}c / {hs.memory_gb ?? "-"}GB / GPU×
                      {hs.gpu_count}
                      {hs.gpu_model ? ` (${hs.gpu_model})` : ""}
                    </td>
                    <td style={tdStyle}>
                      <Link
                        to={`/host-servers/${hs.id}/edit`}
                        style={{ ...linkStyle, marginRight: "var(--space-3)" }}
                      >
                        编辑
                      </Link>
                      <button
                        onClick={() => handleDelete(hs.id, hs.hostname)}
                        style={deleteBtnStyle}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
