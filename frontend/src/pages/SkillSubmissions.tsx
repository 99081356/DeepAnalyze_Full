import {
  useEffect,
  useState,
  useCallback,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList, RefreshCw } from "lucide-react";
import { api, type AdminSkill } from "../api/client.js";
import { Tabs } from "../components/ui/Tabs.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Button } from "../components/ui/Button.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { StatusBadge } from "../components/hub/StatusBadge.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Types & Constants                                                         */
/* -------------------------------------------------------------------------- */

type FilterStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "all";

interface StatusTab {
  key: FilterStatus;
  label: string;
}

const STATUS_TABS: StatusTab[] = [
  { key: "pending", label: "待审核" },
  { key: "approved", label: "已批准" },
  { key: "rejected", label: "已拒绝" },
  { key: "withdrawn", label: "已撤回" },
  { key: "all", label: "全部" },
];

/* -------------------------------------------------------------------------- */
/*  Styles                                                                    */
/* -------------------------------------------------------------------------- */

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-4)",
};

const titleStyle: CSSProperties = {
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--font-semibold)" as unknown as number,
  color: "var(--text-primary)",
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const errorBoxStyle: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  background: "var(--error-light)",
  border: "1px solid var(--error)",
  borderRadius: "var(--radius-lg)",
  color: "var(--error-dark)",
  fontSize: "var(--text-sm)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const tableWrapStyle: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--radius-lg)",
  overflow: "hidden",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-sm)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "var(--space-3) var(--space-4)",
  fontWeight: "var(--font-semibold)" as unknown as number,
  color: "var(--text-secondary)",
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  borderBottom: "1px solid var(--border-primary)",
  background: "var(--bg-tertiary)",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--border-primary)",
  color: "var(--text-primary)",
  verticalAlign: "middle",
};

const rowHoverStyle: CSSProperties = {
  cursor: "pointer",
};

const countStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--text-tertiary)",
};

const skeletonRowStyle: CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--border-primary)",
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function SkillSubmissions() {
  const navigate = useNavigate();
  const addToast = useUIStore((s) => s.addToast);

  const [tab, setTab] = useState<FilterStatus>("pending");
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* -- load -- */

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMarketplaceAdminSkills({
        status: tab === "all" ? undefined : tab,
        limit: 200,
      });
      setSkills(res.skills);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  /* -- row click → navigate to skill detail -- */

  const handleRowClick = useCallback(
    (skill: AdminSkill) => {
      // The SkillDetail route uses /skills/:id for Phase 2 packages.
      // For marketplace submissions, we link using the submission id so
      // the admin can see the full detail on the existing page.
      navigate(`/skills/${skill.id}`);
    },
    [navigate],
  );

  /* -- withdraw action (only for pending skills by author/admin) -- */

  const handleWithdraw = useCallback(
    async (e: MouseEvent, skill: AdminSkill) => {
      e.stopPropagation();
      const ok = window.confirm(
        `确认撤回 "${skill.name}"？撤回后 Worker 将无法下载此 skill。`,
      );
      if (!ok) return;
      try {
        await api.withdrawSkill(skill.slug);
        addToast("success", `已撤回 ${skill.name}`);
        await load();
      } catch (err) {
        addToast(
          "error",
          err instanceof Error ? err.message : "撤回失败",
        );
      }
    },
    [load, addToast],
  );

  /* -- render -- */

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={headerRowStyle}>
        <h1 style={titleStyle}>
          <ClipboardList size={24} />
          Skill 提交审核
          {!loading && (
            <span style={countStyle}>（{total}）</span>
          )}
        </h1>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={14} />}
          onClick={load}
          disabled={loading}
        >
          刷新
        </Button>
      </div>

      {/* Status tabs */}
      <Tabs
        items={STATUS_TABS.map((t) => ({
          key: t.key,
          label: `${t.label}${t.key === tab && total > 0 ? ` (${total})` : ""}`,
        }))}
        activeKey={tab}
        onChange={(k) => setTab(k as FilterStatus)}
      />

      {/* Error */}
      {error && (
        <div style={errorBoxStyle}>
          <span style={{ flex: 1 }}>{error}</span>
          <Button variant="secondary" size="sm" onClick={load}>
            重试
          </Button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={tableWrapStyle}>
          <Skeleton variant="rect" height={40} width="100%" />
          {[...Array(6)].map((_, i) => (
            <div key={i} style={skeletonRowStyle}>
              <Skeleton variant="text" height={20} width="100%" />
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {!loading && !error && skills.length > 0 && (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>ID</th>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>版本</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>提交时间</th>
                <th style={thStyle}>审核人</th>
                <th style={{ ...thStyle, textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr
                  key={skill.id}
                  onClick={() => handleRowClick(skill)}
                  style={rowHoverStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <td style={tdStyle}>
                    <code
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "var(--text-xs)",
                        color: "var(--text-tertiary)",
                      }}
                    >
                      {skill.id.slice(0, 8)}
                    </code>
                  </td>
                  <td style={{ ...tdStyle, fontWeight: "var(--font-medium)" as unknown as number }}>
                    {skill.name}
                  </td>
                  <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>
                    v{skill.version}
                  </td>
                  <td style={tdStyle}>
                    <StatusBadge status={skill.review_status} />
                  </td>
                  <td style={{ ...tdStyle, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {new Date(skill.created_at).toLocaleString("zh-CN")}
                  </td>
                  <td style={{ ...tdStyle, color: "var(--text-tertiary)" }}>
                    {skill.reviewer_id ? (
                      <code
                        style={{
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        {skill.reviewer_id.slice(0, 8)}
                      </code>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    {skill.review_status === "pending" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => handleWithdraw(e, skill)}
                      >
                        撤回
                      </Button>
                    )}
                    {skill.review_status !== "pending" && (
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && skills.length === 0 && (
        <EmptyState
          icon={<ClipboardList size={24} />}
          title={`暂无${STATUS_TABS.find((t) => t.key === tab)?.label ?? ""}提交`}
          description={
            tab === "pending"
              ? "目前没有待审核的 skill 提交。新的提交将出现在这里。"
              : `当前筛选（${STATUS_TABS.find((t) => t.key === tab)?.label}）下没有记录。`
          }
        />
      )}
    </div>
  );
}

export default SkillSubmissions;
