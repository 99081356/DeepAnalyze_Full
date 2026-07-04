import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  api,
  type HostServer,
  type PortUsageEntry,
} from "../api/client.js";

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function HostServerDetail() {
  const { id } = useParams<{ id: string }>();
  const [host, setHost] = useState<HostServer | null>(null);
  const [usage, setUsage] = useState<PortUsageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [hs, u] = await Promise.all([
        api.getHostServer(id),
        api.getHostServerPortUsage(id),
      ]);
      setHost(hs);
      setUsage(u.allocated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载物理机详情失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };

  const backLinkStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    color: "var(--text-secondary)",
    textDecoration: "none",
    fontSize: "var(--text-sm)",
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
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

  const infoCardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-4) var(--space-5)",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "var(--space-3)",
    fontSize: "var(--text-sm)",
    color: "var(--text-primary)",
  };

  const labelStyle: CSSProperties = {
    color: "var(--text-tertiary)",
    marginRight: "var(--space-2)",
  };

  const sectionTitleStyle: CSSProperties = {
    fontSize: "var(--text-base)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
  };

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
    gap: "var(--space-2)",
  };

  const slotFreeStyle: CSSProperties = {
    padding: "var(--space-2)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    textAlign: "center",
    background: "var(--success-light)",
    border: "1px solid var(--success)",
    color: "var(--success-dark)",
  };

  const slotUsedStyle: CSSProperties = {
    padding: "var(--space-2)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    textAlign: "center",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    color: "var(--error-dark)",
  };

  const portMonoStyle: CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  };

  /* -- derived summary -- */

  const totalSlots = usage.length;
  const usedSlots = usage.filter((u) => u.worker_id).length;
  const freeSlots = totalSlots - usedSlots;

  if (loading) return <div style={loadingStyle}>加载中...</div>;
  if (error) return <div style={errorStyle}>{error}</div>;
  if (!host) return <div style={loadingStyle}>未找到该物理机</div>;

  return (
    <div style={pageStyle}>
      <Link to="/host-servers" style={backLinkStyle}>
        <ArrowLeft size={14} />
        返回列表
      </Link>

      <h2 style={titleStyle}>{host.hostname}</h2>

      <div style={infoCardStyle}>
        <div>
          <span style={labelStyle}>SSH:</span>
          <code style={portMonoStyle}>
            {host.ssh_user}@{host.ssh_target_host}:{host.ssh_target_port}
          </code>
        </div>
        <div>
          <span style={labelStyle}>状态:</span>
          {host.status}
        </div>
        <div>
          <span style={labelStyle}>资源:</span>
          {host.cpu_cores ?? "-"}c / {host.memory_gb ?? "-"}GB / GPU×
          {host.gpu_count}
          {host.gpu_model ? ` (${host.gpu_model})` : ""}
        </div>
        <div>
          <span style={labelStyle}>端口段:</span>
          <code style={portMonoStyle}>
            {host.port_range_start}-{host.port_range_end}
          </code>{" "}
          (block={host.port_block_size})
        </div>
        {host.notes && (
          <div style={{ gridColumn: "1 / -1" }}>
            <span style={labelStyle}>备注:</span>
            {host.notes}
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
        }}
      >
        <h3 style={sectionTitleStyle}>端口段使用情况</h3>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
          总 {totalSlots} · 已用 {usedSlots} · 空闲 {freeSlots}
        </span>
      </div>

      {usage.length === 0 ? (
        <div style={loadingStyle}>端口范围内无可用段</div>
      ) : (
        <div style={gridStyle}>
          {usage.map((u) => {
            const isFree = !u.worker_id;
            return (
              <div
                key={u.base_port}
                style={isFree ? slotFreeStyle : slotUsedStyle}
                title={
                  isFree
                    ? "空闲"
                    : `worker=${u.worker_id}${u.status ? ` status=${u.status}` : ""}`
                }
              >
                <div style={portMonoStyle}>{u.base_port}</div>
                <div style={{ marginTop: "var(--space-1)" }}>
                  {isFree ? (
                    <span>空闲</span>
                  ) : (
                    <div>
                      <div style={portMonoStyle}>
                        {(u.worker_id ?? "").slice(0, 8)}
                      </div>
                      {u.status && (
                        <div style={{ fontSize: 10, opacity: 0.8 }}>
                          {u.status}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
