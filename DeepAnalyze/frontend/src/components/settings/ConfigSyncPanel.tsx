// frontend/src/components/settings/ConfigSyncPanel.tsx — T16 "配置同步" tab.
//
// UI pattern follows HubConnectionPanel.tsx:
//   - Inline CSSProperties + CSS variables (NOT Tailwind utility classes)
//   - useToast() hook for success/error feedback (NOT alert)
//   - api.get<T> / api.post<T> from the shared api client (NOT raw fetch)
//
// Sync flow (two-step with confirm):
//   1. Click "立即从 Hub 同步" → POST dry-run pre-check → get applied/skipped
//   2. If there are skipped fields, show a Modal listing them with checkboxes
//      so the user can pick which ones to force-override (default: none).
//   3. Confirm → POST real sync with forceFields → show result.

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";

interface SyncStatus {
  mode: string;
  last_hub_sync_at: string | null;
}

interface SyncResult {
  appliedFields: string[];
  skippedFields: string[];
}

/** Friendly display names for sync field paths. */
const FIELD_LABELS: Record<string, string> = {
  providers: "模型配置",
  agentSettings: "Agent 参数",
  doclingConfig: "文档解析",
  enhancedModels: "生成模型",
  hooks: "钩子",
  mineruConfig: "MinerU 解析",
};

function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  if (field.startsWith("moduleStates.")) {
    const mod = field.slice("moduleStates.".length);
    const modLabels: Record<string, string> = {
      embedding: "嵌入模块",
      asr: "ASR 模块",
      docling: "Docling 模块",
      mineru: "MinerU 模块",
    };
    return modLabels[mod] ?? field;
  }
  return field;
}

export function ConfigSyncPanel() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const { success, error: showError } = useToast();

  // Confirm-dialog state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preCheck, setPreCheck] = useState<SyncResult | null>(null);
  const [forceSelection, setForceSelection] = useState<Set<string>>(new Set());

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // showError comes from useToast(), which returns a fresh object every
    // render — including it here made refreshStatus change identity each
    // render, which re-triggered the useEffect below in an infinite loop
    // (~660 req/s to /api/hub/config/sync-status, causing the "加载中..."
    // card to flicker forever). The addToast it ultimately calls is a stable
    // zustand action, so the closure is safe to capture once.
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    try {
      // Step 1: dry-run pre-check
      const pre = await api.post<SyncResult>(
        "/api/hub/config/sync-from-hub",
        { dryRun: true },
      );
      setPreCheck(pre);
      // Step 2: if nothing would be skipped, no override decision needed —
      // go straight to real sync (all fills, no overwrites).
      if (pre.skippedFields.length === 0) {
        await doSync([]);
      } else {
        // Show confirm modal with skip-list checkboxes
        setForceSelection(new Set());
        setConfirmOpen(true);
        setSyncing(false);
      }
    } catch (e) {
      showError(`同步失败: ${e instanceof Error ? e.message : String(e)}`);
      setSyncing(false);
    }
  };

  /** Execute the real sync with the user's force-selection. */
  const doSync = async (forceFields: string[]) => {
    setSyncing(true);
    try {
      const data = await api.post<SyncResult>(
        "/api/hub/config/sync-from-hub",
        { forceFields },
      );
      setResult(data);
      const forced = forceFields.length;
      const msg = forced > 0
        ? `同步完成: 应用 ${data.appliedFields.length} 项（含 ${forced} 项强制覆盖）, 跳过 ${data.skippedFields.length} 项`
        : `同步完成: 应用 ${data.appliedFields.length} 项, 跳过 ${data.skippedFields.length} 项`;
      success(msg);
      await refreshStatus();
    } catch (e) {
      showError(`同步失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      setConfirmOpen(false);
      setPreCheck(null);
    }
  };

  const toggleForce = (field: string) => {
    setForceSelection((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
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
          拉取 Hub 管理员维护的全局/组织模板，按锁定规则合并到本地。同步时会先预检，让你确认是否覆盖本地已有配置。
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

      {/* ─── Confirm-override modal ─── */}
      <Modal
        open={confirmOpen}
        onClose={() => { if (!syncing) { setConfirmOpen(false); setPreCheck(null); } }}
        title="确认从 Hub 同步"
        size="md"
        closeOnOverlay={!syncing}
        hideClose={syncing}
      >
        {preCheck && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {/* Fields that will be applied (local empty, no override risk) */}
            {preCheck.appliedFields.length > 0 && (
              <div>
                <div style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: 500,
                  color: "var(--success)",
                  marginBottom: "var(--space-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                }}>
                  <CheckCircle2 size={14} />
                  将应用 {preCheck.appliedFields.length} 项（本地为空，自动填充）
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
                  {preCheck.appliedFields.map((f) => (
                    <code
                      key={f}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        padding: "2px 6px",
                        background: "var(--success-light)",
                        color: "var(--success-dark, var(--success))",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      {fieldLabel(f)}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {/* Skipped fields — user can select which to force-override */}
            <div>
              <div style={{
                fontSize: "var(--text-sm)",
                fontWeight: 500,
                color: "var(--text-primary)",
                marginBottom: "var(--space-1)",
              }}>
                以下本地已有配置，勾选要<strong>强制覆盖</strong>的（不勾则保留本地值）：
              </div>
              <div style={{
                marginTop: "var(--space-2)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}>
                {preCheck.skippedFields.map((f) => (
                  <label
                    key={f}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      padding: "var(--space-2)",
                      background: "var(--bg-tertiary)",
                      borderRadius: "var(--radius-md)",
                      cursor: "pointer",
                      fontSize: "var(--text-sm)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={forceSelection.has(f)}
                      onChange={() => toggleForce(f)}
                      style={{ cursor: "pointer" }}
                    />
                    <span style={{ color: "var(--text-primary)" }}>{fieldLabel(f)}</span>
                    <code style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                    }}>
                      {f}
                    </code>
                  </label>
                ))}
              </div>
            </div>

            <div style={{
              padding: "var(--space-2) var(--space-3)",
              background: "var(--warning-light)",
              borderLeft: "3px solid var(--warning)",
              borderRadius: "var(--radius-sm)",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              lineHeight: 1.5,
            }}>
              勾选的字段会用 Hub 模板的值覆盖本地配置。<strong>不可撤销</strong>，请确认。
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
              <Button
                variant="ghost"
                size="md"
                onClick={() => { setConfirmOpen(false); setPreCheck(null); }}
              >
                取消
              </Button>
              <Button
                variant="primary"
                size="md"
                loading={syncing}
                onClick={() => void doSync(Array.from(forceSelection))}
              >
                {forceSelection.size > 0
                  ? `确认同步（覆盖 ${forceSelection.size} 项）`
                  : "确认同步（仅填充）"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
