/**
 * Sharings admin page — Phase 4 cross-org bilateral approval.
 *
 * Features:
 *   - List all skill sharings with status filter
 *   - Approve / reject pending requests (as target org)
 *   - Revoke approved sharings (either side)
 *   - View restrictions and audit metadata
 */

import { useEffect, useState } from "react";
import { api, type SkillSharing } from "../api/client";

const STATUS_COLORS: Record<SkillSharing["status"], string> = {
  pending: "#f59e0b",
  approved: "#10b981",
  rejected: "#ef4444",
  revoked: "#6b7280",
};

export function Sharings() {
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
  }, [statusFilter]);

  async function action(id: string, kind: "approve" | "reject" | "revoke") {
    setBusy(`${id}:${kind}`);
    setError(null);
    try {
      if (kind === "approve") {
        await api.approveSharing(id);
      } else if (kind === "reject") {
        await api.rejectSharing(id, "Rejected via admin UI");
      } else {
        await api.revokeSharing(id, "Revoked via admin UI");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: "24px" }}>
      <h1>Skill Sharings</h1>
      <p style={{ color: "#6b7280", marginTop: "-8px" }}>
        Cross-org bilateral approval workflow for skill packages.
      </p>

      <div style={{ marginBottom: "16px", display: "flex", gap: "12px", alignItems: "center" }}>
        <label>
          Status:{" "}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: "4px 8px" }}
          >
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="revoked">Revoked</option>
          </select>
        </label>
        <button onClick={() => void load()} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", background: "#fee", color: "#900", marginBottom: "12px", borderRadius: "4px" }}>
          {error}
        </div>
      )}

      {sharings.length === 0 && !loading ? (
        <p style={{ color: "#6b7280" }}>No sharings found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
              <th style={{ padding: "8px" }}>ID</th>
              <th style={{ padding: "8px" }}>Package</th>
              <th style={{ padding: "8px" }}>Source → Target</th>
              <th style={{ padding: "8px" }}>Status</th>
              <th style={{ padding: "8px" }}>Restrictions</th>
              <th style={{ padding: "8px" }}>Created</th>
              <th style={{ padding: "8px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sharings.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "8px", fontFamily: "monospace", fontSize: "12px" }}>
                  {s.id.slice(0, 12)}…
                </td>
                <td style={{ padding: "8px", fontFamily: "monospace", fontSize: "12px" }}>
                  {s.package_id.slice(0, 12)}…
                </td>
                <td style={{ padding: "8px", fontFamily: "monospace", fontSize: "12px" }}>
                  {s.source_org_id.slice(0, 8)} → {s.target_org_id.slice(0, 8)}
                </td>
                <td style={{ padding: "8px" }}>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "10px",
                      color: "white",
                      background: STATUS_COLORS[s.status],
                      fontSize: "12px",
                    }}
                  >
                    {s.status}
                  </span>
                </td>
                <td style={{ padding: "8px", fontSize: "12px", color: "#6b7280" }}>
                  {Object.keys(s.restrictions ?? {}).length === 0
                    ? "—"
                    : JSON.stringify(s.restrictions)}
                </td>
                <td style={{ padding: "8px", fontSize: "12px", color: "#6b7280" }}>
                  {new Date(s.created_at).toLocaleString()}
                </td>
                <td style={{ padding: "8px" }}>
                  {s.status === "pending" && (
                    <>
                      <button
                        onClick={() => void action(s.id, "approve")}
                        disabled={busy === `${s.id}:approve`}
                        style={{ padding: "4px 8px", marginRight: "4px", background: "#10b981", color: "white", border: "none", borderRadius: "3px", cursor: "pointer" }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void action(s.id, "reject")}
                        disabled={busy === `${s.id}:reject`}
                        style={{ padding: "4px 8px", background: "#ef4444", color: "white", border: "none", borderRadius: "3px", cursor: "pointer" }}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {s.status === "approved" && (
                    <button
                      onClick={() => void action(s.id, "revoke")}
                      disabled={busy === `${s.id}:revoke`}
                      style={{ padding: "4px 8px", background: "#6b7280", color: "white", border: "none", borderRadius: "3px", cursor: "pointer" }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
