// deepanalyze-hub/frontend/src/pages/Monitoring.tsx
//
// Worker 监控页（T18）：展示所有 approved worker 的健康状态。
// - 4 色统计卡（在线/降级/离线/未知）
// - worker 表格（hostname / 用户 / host / 版本 / 最近心跳 / 状态徽章）
// - 30 秒自动刷新
//
// 样式约定：全程 inline CSSProperties + CSS 变量（NOT Tailwind）
// API 约定：全程 api.client.ts（NOT raw fetch）
// 错误反馈：addToast(type, message) 位置参数（NOT alert）
import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { api } from "../api/client.js";
import { useUIStore } from "../store/ui.js";
import type { MeResponse, MonitoringOverview } from "../api/client.js";

interface MonitoringProps {
  user: MeResponse;
}

export function Monitoring({ user }: MonitoringProps) {
  const [overview, setOverview] = useState<MonitoringOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const addToast = useUIStore((s) => s.addToast);

  const refresh = useCallback(async () => {
    try {
      const data = await api.monitoring.overview();
      setOverview(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载失败";
      addToast("error", `加载监控数据失败: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000); // 30s 自动刷新
    return () => clearInterval(t);
  }, [refresh]);

  // 权限网关：仅 super_admin 可见
  if (!user.is_super_admin) {
    return (
      <div style={{ padding: "var(--space-5)", color: "var(--text-secondary)" }}>
        仅超级管理员可访问监控页。
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: "var(--space-5)", color: "var(--text-secondary)" }}>
        加载中...
      </div>
    );
  }

  if (!overview) {
    return null;
  }

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };

  const cardsRowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "var(--space-4)",
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
    fontSize: 12,
    color: "var(--text-secondary)",
    borderBottom: "1px solid var(--border-primary)",
    background: "var(--bg-secondary)",
  };

  const tdStyle: CSSProperties = {
    padding: "var(--space-2) var(--space-3)",
    fontSize: 13,
    borderBottom: "1px solid var(--border-secondary)",
  };

  return (
    <div style={pageStyle}>
      <h2
        style={{
          margin: 0,
          fontSize: "var(--text-xl)",
          fontWeight: 600,
        }}
      >
        Worker 监控
      </h2>

      <div style={cardsRowStyle}>
        <StatCard label="在线" value={overview.online} color="var(--success)" />
        <StatCard label="降级" value={overview.degraded} color="var(--warning)" />
        <StatCard label="离线" value={overview.offline} color="var(--error)" />
        <StatCard label="未知" value={overview.unknown} color="var(--text-tertiary)" />
      </div>

      <div style={tableWrapperStyle}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>hostname</th>
              <th style={thStyle}>用户</th>
              <th style={thStyle}>host</th>
              <th style={thStyle}>版本</th>
              <th style={thStyle}>最近心跳</th>
              <th style={thStyle}>状态</th>
            </tr>
          </thead>
          <tbody>
            {overview.workers.length === 0 ? (
              <tr>
                <td style={tdStyle} colSpan={6}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    暂无 approved workers
                  </span>
                </td>
              </tr>
            ) : (
              overview.workers.map((w) => (
                <tr key={w.id}>
                  <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
                    {w.hostname}
                  </td>
                  <td style={tdStyle}>{w.user_name ?? "-"}</td>
                  <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
                    {w.ssh_target_host ?? "-"}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
                    {w.da_version ?? "-"}
                  </td>
                  <td style={tdStyle}>
                    {w.last_heartbeat_at
                      ? new Date(w.last_heartbeat_at).toLocaleString("zh-CN")
                      : "从未"}
                  </td>
                  <td style={tdStyle}>
                    <HealthBadge status={w.health_status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        background: "var(--bg-card)",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-lg)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        {label}
      </span>
      <span style={{ fontSize: 28, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

function HealthBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    online: "var(--success)",
    degraded: "var(--warning)",
    offline: "var(--error)",
    unknown: "var(--text-tertiary)",
  };
  const labels: Record<string, string> = {
    online: "在线",
    degraded: "降级",
    offline: "离线",
    unknown: "未知",
  };
  const color = colors[status] ?? "var(--text-tertiary)";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "var(--radius-sm)",
        background: color,
        color: "white",
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {labels[status] ?? status}
    </span>
  );
}
