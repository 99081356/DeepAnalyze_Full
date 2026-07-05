// frontend/src/components/settings/ConfigSyncPanel.tsx — T16 "配置同步" tab.
//
// UI pattern follows HubConnectionPanel.tsx:
//   - Inline CSSProperties + CSS variables (NOT Tailwind utility classes)
//   - useToast() hook for success/error feedback (NOT alert)
//   - api.get<T> / api.post<T> from the shared api client (NOT raw fetch)

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";

interface SyncStatus {
  mode: string;
  last_hub_sync_at: string | null;
}

interface SyncResult {
  appliedFields: string[];
  skippedFields: string[];
}

export function ConfigSyncPanel() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const { success, error: showError } = useToast();

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const data = await api.get<SyncStatus>("/api/hub/config/sync-status");
      setStatus(data);
    } catch (e) {
      showError(`加载同步状态失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingStatus(false);
    }
  }, [showError]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const data = await api.post<SyncResult>("/api/hub/config/sync-from-hub", {});
      setResult(data);
      success(`同步完成: 应用 ${data.appliedFields.length} 项, 跳过 ${data.skippedFields.length} 项`);
      await refreshStatus();
    } catch (e) {
      showError(`同步失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  // Styles follow HubConnectionPanel.tsx inline + CSS-variable pattern.
  const wrapperStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  };

  const cardStyle: React.CSSProperties = {
    padding: "var(--space-4)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-2) 0",
    borderBottom: "1px solid var(--border-secondary)",
  };

  const labelStyle: React.CSSProperties = {
    color: "var(--text-secondary)",
    fontSize: "var(--text-sm)",
  };

  const valueStyle: React.CSSProperties = {
    color: "var(--text-primary)",
    fontWeight: 500,
    fontSize: "var(--text-sm)",
  };

  const isHubMode = status?.mode === "hub";

  const buttonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-4)",
    background: "var(--interactive)",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius-lg)",
    cursor: isHubMode && !syncing ? "pointer" : "not-allowed",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-medium)",
    opacity: isHubMode && !syncing ? 1 : 0.5,
  };

  const listStyle: React.CSSProperties = {
    margin: 0,
    paddingLeft: "var(--space-4)",
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    lineHeight: 1.6,
  };

  return (
    <div style={wrapperStyle}>
      <div style={cardStyle}>
        <h3 style={{
          fontSize: "var(--text-sm)",
          fontWeight: "var(--font-semibold)",
          color: "var(--text-primary)",
          margin: 0,
          marginBottom: "var(--space-3)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
        }}>
          <RefreshCw size={14} />
          从 Hub 同步配置
        </h3>
        <p style={{
          margin: 0,
          fontSize: "var(--text-sm)",
          color: "var(--text-secondary)",
          lineHeight: 1.6,
        }}>
          拉取 Hub 管理员维护的全局/组织模板，按锁定规则合并到本地。
        </p>
      </div>

      {loadingStatus ? (
        <div style={{ ...cardStyle, color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
          加载中...
        </div>
      ) : (
        <>
          <div style={cardStyle}>
            <div style={rowStyle}>
              <span style={labelStyle}>当前认证模式</span>
              <span style={valueStyle}>{status?.mode ?? "unknown"}</span>
            </div>
            <div style={{ ...rowStyle, borderBottom: "none" }}>
              <span style={labelStyle}>上次同步时间</span>
              <span style={valueStyle}>
                {status?.last_hub_sync_at
                  ? new Date(status.last_hub_sync_at).toLocaleString("zh-CN")
                  : "从未同步"}
              </span>
            </div>
          </div>

          {!isHubMode && (
            <div style={{
              padding: "var(--space-3)",
              background: "var(--warning-light)",
              borderLeft: "3px solid var(--warning)",
              borderRadius: "var(--radius-lg)",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
            }}>
              仅 hub 模式（<code style={{ fontFamily: "var(--font-mono)" }}>DA_AUTH_MODE=hub</code>）可用。
            </div>
          )}

          <div style={cardStyle}>
            <button
              onClick={handleSync}
              disabled={!isHubMode || syncing}
              style={buttonStyle}
            >
              <RefreshCw
                size={14}
                style={syncing ? { animation: "spin 1s linear infinite" } : undefined}
              />
              {syncing ? "同步中..." : "立即从 Hub 同步"}
            </button>
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>

          {result && (
            <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              {result.appliedFields.length > 0 && (
                <div>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    color: "var(--success)",
                    fontSize: "var(--text-sm)",
                    fontWeight: 500,
                    marginBottom: "var(--space-1)",
                  }}>
                    <CheckCircle2 size={14} />
                    应用字段（{result.appliedFields.length}）
                  </div>
                  <ul style={listStyle}>
                    {result.appliedFields.map((f) => (
                      <li key={f}><code style={{ fontFamily: "var(--font-mono)" }}>{f}</code></li>
                    ))}
                  </ul>
                </div>
              )}
              {result.skippedFields.length > 0 && (
                <div>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    color: "var(--text-secondary)",
                    fontSize: "var(--text-sm)",
                    fontWeight: 500,
                    marginBottom: "var(--space-1)",
                  }}>
                    <XCircle size={14} />
                    跳过字段（{result.skippedFields.length}，本地已有自定义值）
                  </div>
                  <ul style={listStyle}>
                    {result.skippedFields.map((f) => (
                      <li key={f}><code style={{ fontFamily: "var(--font-mono)" }}>{f}</code></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
