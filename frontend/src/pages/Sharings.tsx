/**
 * Sharings admin page — Phase 4 cross-org bilateral approval.
 *
 * Features:
 *   - List all skill sharings with status tab-chip filter
 *   - Approve / reject pending requests (as target org)
 *   - Revoke approved sharings (either side)
 *   - View restrictions and synthesized audit timeline
 */

import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, RefreshCw, Check, X, Ban } from "lucide-react";
import { api, type SkillSharing } from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { AuditTimeline, type AuditEntry } from "../components/hub/AuditTimeline.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Status filter config                                                      */
/* -------------------------------------------------------------------------- */

const STATUS_TABS: { label: string; value: string }[] = [
  { label: "全部", value: "" },
  { label: "pending", value: "pending" },
  { label: "approved", value: "approved" },
  { label: "rejected", value: "rejected" },
  { label: "revoked", value: "revoked" },
];

const STATUS_VARIANT: Record<SkillSharing["status"], "warning" | "success" | "error" | "default"> = {
  pending: "warning",
  approved: "success",
  rejected: "error",
  revoked: "default",
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function buildAuditEntries(s: SkillSharing): AuditEntry[] {
  const entries: AuditEntry[] = [{
    id: `${s.id}:initiate`,
    actor_name: s.initiated_by,
    action: "sharing_initiated",
    from_status: null,
    to_status: "pending",
    created_at: s.created_at,
  }];
  if (s.approved_at) {
    entries.push({
      id: `${s.id}:approve`,
      actor_name: s.approved_by ?? "?",
      action: "sharing_approved",
      from_status: "pending",
      to_status: s.status === "rejected" ? "rejected" : "approved",
      created_at: s.approved_at,
    });
  }
  if (s.revoked_at) {
    entries.push({
      id: `${s.id}:revoke`,
      actor_name: "?",
      action: "sharing_revoked",
      from_status: "approved",
      to_status: "revoked",
      details: { reason: s.revoke_reason ?? undefined },
      created_at: s.revoked_at,
    });
  }
  return entries;
}

function formatRestrictions(r: Record<string, unknown>): string {
  const keys = Object.keys(r ?? {});
  if (keys.length === 0) return "—";
  return keys.map((k) => `${k}: ${String(r[k])}`).join(" · ");
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function Sharings() {
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  const [sharings, setSharings] = useState<SkillSharing[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listSharings(statusFilter ? { status: statusFilter } : undefined);
      setSharings(data.sharings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function handleAction(id: string, kind: "approve" | "reject" | "revoke") {
    if (kind === "reject" || kind === "revoke") {
      const confirmed = await showConfirm({
        title: kind === "reject" ? "拒绝共享" : "撤销共享",
        message: kind === "reject"
          ? "确定要拒绝此共享请求吗？"
          : "确定要撤销此共享吗？已使用此共享的 Worker 将被停止。",
        confirmLabel: kind === "reject" ? "确认拒绝" : "确认撤销",
        variant: "danger",
      });
      if (!confirmed) return;
    }

    setBusy(`${id}:${kind}`);
    setError(null);
    try {
      if (kind === "approve") {
        await api.approveSharing(id);
        addToast("success", "共享已批准");
      } else if (kind === "reject") {
        await api.rejectSharing(id, "Rejected via admin UI");
        addToast("success", "共享已拒绝");
      } else {
        await api.revokeSharing(id, "Revoked via admin UI");
        addToast("success", "共享已撤销");
      }
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addToast("error", msg);
    } finally {
      setBusy(null);
    }
  }

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

  const subtitleStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-1)",
  };

  const tabBarStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-2)",
    flexWrap: "wrap",
    alignItems: "center",
  };

  const chipBase: CSSProperties = {
    padding: "var(--space-1) var(--space-3)",
    borderRadius: "var(--radius-full)",
    fontSize: "var(--text-sm)",
    cursor: "pointer",
    border: "1px solid var(--border-primary)",
    background: "var(--bg-card)",
    color: "var(--text-secondary)",
    transition: "all var(--transition-fast)",
    userSelect: "none" as const,
  };

  const chipActive: CSSProperties = {
    background: "var(--brand-primary)",
    color: "var(--brand-foreground)",
    borderColor: "var(--brand-primary)",
  };

  const errorStyle: CSSProperties = {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  };

  const cardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-5)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  };

  const cardHeaderRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    flexWrap: "wrap",
  };

  const orgRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontSize: "var(--text-sm)",
    fontFamily: "var(--font-mono)",
    color: "var(--text-primary)",
  };

  const metaStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-3)",
    flexWrap: "wrap",
    alignItems: "center",
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  };

  const actionRowStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-2)",
  };

  const loadingStyle: CSSProperties = {
    padding: "var(--space-10)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div>
        <h2 style={titleStyle}>Skill Sharings</h2>
        <p style={subtitleStyle}>
          Cross-org bilateral approval workflow for skill packages.
        </p>
      </div>

      {/* Status tab chips + refresh */}
      <div style={tabBarStyle}>
        {STATUS_TABS.map((tab) => (
          <span
            key={tab.value}
            style={{ ...chipBase, ...(statusFilter === tab.value ? chipActive : {}) }}
            onClick={() => setStatusFilter(tab.value)}
          >
            {tab.label}
          </span>
        ))}
        <div style={{ marginLeft: "auto" }}>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && <div style={errorStyle}>{error}</div>}

      {/* Card list */}
      {loading ? (
        <div style={loadingStyle}>加载中...</div>
      ) : sharings.length === 0 ? (
        <div style={loadingStyle}>No sharings found.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {sharings.map((s) => (
            <div key={s.id} style={cardStyle}>
              {/* Header: org flow + status */}
              <div style={cardHeaderRow}>
                <div style={orgRowStyle}>
                  <span>{s.source_org_id.slice(0, 8)}</span>
                  <ArrowRight size={16} style={{ color: "var(--text-tertiary)" }} />
                  <span>{s.target_org_id.slice(0, 8)}</span>
                </div>
                <Badge variant={STATUS_VARIANT[s.status]} size="md">
                  {s.status}
                </Badge>
              </div>

              {/* Meta info */}
              <div style={metaStyle}>
                <span>package: {s.package_id.slice(0, 12)}...</span>
                <span>initiated_by: {s.initiated_by}</span>
                <span>created: {new Date(s.created_at).toLocaleString()}</span>
              </div>

              {/* Restrictions */}
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                {Object.keys(s.restrictions ?? {}).length === 0 ? (
                  <Badge variant="default">restrictions: none</Badge>
                ) : (
                  Object.entries(s.restrictions).map(([k, v]) => (
                    <Badge key={k} variant="info">{k}: {String(v)}</Badge>
                  ))
                )}
              </div>

              {/* Audit timeline (synthesized) */}
              <AuditTimeline entries={buildAuditEntries(s)} />

              {/* Actions */}
              {s.status === "pending" && (
                <div style={actionRowStyle}>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Check size={14} />}
                    disabled={busy === `${s.id}:approve`}
                    onClick={() => void handleAction(s.id, "approve")}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<X size={14} />}
                    disabled={busy === `${s.id}:reject`}
                    onClick={() => void handleAction(s.id, "reject")}
                  >
                    Reject
                  </Button>
                </div>
              )}
              {s.status === "approved" && (
                <div style={actionRowStyle}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Ban size={14} />}
                    disabled={busy === `${s.id}:revoke`}
                    onClick={() => void handleAction(s.id, "revoke")}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
