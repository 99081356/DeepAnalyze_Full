import { useEffect, useState, type CSSProperties } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Share2, Bell, Ban } from "lucide-react";
import { api, type MeResponse, type SkillPackageV2, type UsageStats } from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Tabs } from "../components/ui/Tabs.js";
import { AuditTimeline, type AuditEntry } from "../components/hub/AuditTimeline.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SCOPE_LABEL: Record<string, string> = {
  system: "系统级",
  org: "组织级",
  user: "用户级",
};

const SCOPE_VARIANT: Record<string, "error" | "info" | "success"> = {
  system: "error",
  org: "info",
  user: "success",
};

interface VersionItem {
  version: string;
  content: string;
  change_summary?: string;
  created_at?: string;
  status?: string;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function SkillDetail({ user: _user }: { user: MeResponse }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const showConfirm = useUIStore((s) => s.showConfirm);

  const [pkg, setPkg] = useState<SkillPackageV2 | null>(null);
  const [version, setVersion] = useState<VersionItem | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("content");

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    Promise.all([
      api.getRaw<SkillPackageV2>("GET", `/skills/${id}`),
      api
        .getRaw<{ items: VersionItem[] }>("GET", `/skills/${id}/versions`)
        .then((v) => {
          const items = v.items ?? [];
          setVersions(items);
          return items[0] ?? null;
        }),
      api
        .getRaw<{ items: AuditEntry[] }>("GET", `/skills/${id}/audit`)
        .catch(() => ({ items: [] as AuditEntry[] })),
      api
        .getRaw<{ stats: UsageStats }>("GET", `/skills/${id}/usage/stats`)
        .then((r) => r.stats)
        .catch(() => null),
    ])
      .then(([p, v, a, u]) => {
        setPkg(p);
        setVersion(v);
        setAudit(a.items ?? []);
        setUsage(u);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => setLoading(false));
  }, [id]);

  /* -- handlers -- */

  const handleSubscribe = async () => {
    if (!pkg) return;
    try {
      await api.subscribeSkill(pkg.id);
    } catch (err) {
      console.error("Subscribe failed:", err);
    }
  };

  const handleShare = () => {
    if (pkg) navigate(`/sharings?package_id=${pkg.id}`);
  };

  const handleKillSwitch = async () => {
    if (!pkg) return;
    const confirmed = await showConfirm({
      title: "确认 Kill Switch",
      message: `确定要禁用「${pkg.display_name || pkg.name}」吗？所有已订阅的 Worker 将停止使用此 Skill。`,
      confirmLabel: "确认禁用",
      variant: "danger",
    });
    if (confirmed) {
      try {
        await api.killSwitchSkill(pkg.id, "手动禁用");
        location.reload();
      } catch (err) {
        console.error("Kill switch failed:", err);
      }
    }
  };

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
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

  const heroStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-6)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  };

  const heroTopRow: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "var(--space-4)",
  };

  const heroLeftStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-4)",
    alignItems: "flex-start",
    flex: 1,
    minWidth: 0,
  };

  const iconWrapStyle: CSSProperties = {
    width: 56,
    height: 56,
    minWidth: 56,
    borderRadius: "var(--radius-lg)",
    background: "var(--brand-light)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 28,
    flexShrink: 0,
  };

  const heroTitleStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
    margin: 0,
    lineHeight: 1.3,
  };

  const heroDescStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginTop: "var(--space-2)",
    lineHeight: 1.5,
  };

  const heroMetaStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-3)",
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: "var(--space-2)",
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  };

  const actionRowStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-2)",
    flexShrink: 0,
  };

  const contentCardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-6)",
  };

  const codeBlockStyle: CSSProperties = {
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-4)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    color: "var(--text-primary)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.6,
    margin: 0,
    maxHeight: 600,
    overflowY: "auto",
  };

  const versionItemStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
    padding: "var(--space-3) 0",
    borderBottom: "1px solid var(--border-primary)",
  };

  const statGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: "var(--space-3)",
  };

  const statCardStyle: CSSProperties = {
    padding: "var(--space-4)",
    background: "var(--bg-tertiary)",
    borderRadius: "var(--radius-md)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  };

  const statLabelStyle: CSSProperties = {
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  };

  const statValueStyle: CSSProperties = {
    fontSize: "var(--text-xl)",
    fontWeight: "var(--font-semibold)" as unknown as number,
    color: "var(--text-primary)",
  };

  const backBtnStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    padding: "var(--space-1) var(--space-2)",
    borderRadius: "var(--radius-md)",
    transition: "color var(--transition-fast)",
  };

  /* -- render -- */

  if (loading) {
    return <div style={loadingStyle}>加载中...</div>;
  }

  if (error) {
    return <div style={errorStyle}>{error}</div>;
  }

  if (!pkg) {
    return <div style={loadingStyle}>未找到该 Skill</div>;
  }

  return (
    <div style={pageStyle}>
      {/* Back link */}
      <button
        style={backBtnStyle}
        onClick={() => navigate("/skills")}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--text-secondary)";
        }}
      >
        <ArrowLeft size={16} />
        返回 Skills 市场
      </button>

      {/* Hero */}
      <div style={heroStyle}>
        <div style={heroTopRow}>
          <div style={heroLeftStyle}>
            <div style={iconWrapStyle}>{pkg.icon || "📦"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={heroTitleStyle}>{pkg.display_name || pkg.name}</h1>
              {pkg.description && (
                <p style={heroDescStyle}>{pkg.description}</p>
              )}
              <div style={heroMetaStyle}>
                <Badge variant={SCOPE_VARIANT[pkg.scope] || "default"}>
                  {SCOPE_LABEL[pkg.scope] || pkg.scope}
                </Badge>
                {pkg.category && <span>分类: {pkg.category}</span>}
                {pkg.author_name && <span>维护者: {pkg.author_name}</span>}
                {pkg.active_version && (
                  <span>当前版本: {pkg.active_version}</span>
                )}
                {pkg.trust_level && (
                  <span>信任级别: {pkg.trust_level}</span>
                )}
                {pkg.is_kill_switched && (
                  <Badge variant="error">已禁用</Badge>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div style={actionRowStyle}>
            <Button
              variant="secondary"
              size="sm"
              icon={<Bell size={14} />}
              onClick={handleSubscribe}
            >
              订阅
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Share2 size={14} />}
              onClick={handleShare}
            >
              分享
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Ban size={14} />}
              onClick={handleKillSwitch}
              disabled={pkg.is_kill_switched}
            >
              Kill Switch
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        items={[
          { key: "content", label: "内容预览" },
          { key: "versions", label: "版本历史" },
          { key: "audit", label: "审计日志" },
          { key: "stats", label: "使用统计" },
        ]}
        activeKey={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab content */}
      <div style={contentCardStyle}>
        {activeTab === "content" && (
          <pre style={codeBlockStyle}>
            {version?.content || "暂无内容"}
          </pre>
        )}

        {activeTab === "versions" && (
          <div>
            {versions.length === 0 ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
                暂无版本记录
              </div>
            ) : (
              versions.map((v, i) => (
                <div
                  key={v.version || i}
                  style={{
                    ...versionItemStyle,
                    borderBottom:
                      i === versions.length - 1
                        ? "none"
                        : "1px solid var(--border-primary)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                    }}
                  >
                    <span
                      style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-semibold)" as unknown as number,
                      color: "var(--text-primary)",
                    }}
                  >
                    v{v.version}
                  </span>
                  {v.status && (
                    <Badge variant="default">{v.status}</Badge>
                  )}
                  {v.created_at && (
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-tertiary)",
                      }}
                    >
                      {new Date(v.created_at).toLocaleString("zh-CN")}
                    </span>
                  )}
                  </div>
                  {v.change_summary && (
                    <p
                      style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--text-secondary)",
                        margin: 0,
                      }}
                    >
                      {v.change_summary}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "audit" && <AuditTimeline entries={audit} />}

        {activeTab === "stats" && (
          <div>
            {usage ? (
              <div style={statGridStyle}>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>总调用</span>
                  <span style={statValueStyle}>{usage.total}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>成功率</span>
                  <span style={statValueStyle}>
                    {(usage.success_rate * 100).toFixed(1)}%
                  </span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>成功</span>
                  <span style={statValueStyle}>{usage.success}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>失败</span>
                  <span style={statValueStyle}>{usage.failure}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>超时</span>
                  <span style={statValueStyle}>{usage.timeout}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>已拦截</span>
                  <span style={statValueStyle}>{usage.blocked}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>平均耗时</span>
                  <span style={statValueStyle}>
                    {usage.avg_duration_ms != null
                      ? `${usage.avg_duration_ms.toFixed(0)}ms`
                      : "-"}
                  </span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>Worker 数</span>
                  <span style={statValueStyle}>{usage.unique_workers}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>用户数</span>
                  <span style={statValueStyle}>{usage.unique_users}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>近 24h</span>
                  <span style={statValueStyle}>{usage.last_24h}</span>
                </div>
                <div style={statCardStyle}>
                  <span style={statLabelStyle}>近 7d</span>
                  <span style={statValueStyle}>{usage.last_7d}</span>
                </div>
              </div>
            ) : (
              <div style={{ color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
                暂无使用统计数据
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
