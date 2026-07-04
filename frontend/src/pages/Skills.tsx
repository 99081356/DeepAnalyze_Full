import { useEffect, useState, useCallback, useMemo, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Package } from "lucide-react";
import { api, type MeResponse, type SkillPackageV2 } from "../api/client.js";
import { SearchBar } from "../components/ui/SearchBar.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Button } from "../components/ui/Button.js";
import { SkillCard, type SkillCardData } from "../components/hub/SkillCard.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const CATEGORIES = [
  "全部",
  "engineering",
  "writing",
  "operations",
  "business",
  "security",
  "productivity",
] as const;

type Category = (typeof CATEGORIES)[number];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Transform API SkillPackageV2 to SkillCardData */
function toCardData(pkg: SkillPackageV2): SkillCardData {
  return {
    id: pkg.id,
    name: pkg.name,
    display_name: pkg.display_name || pkg.name,
    description: pkg.description || "",
    scope: pkg.scope,
    category: pkg.category || "engineering",
    tags: pkg.tags ?? [],
    icon: pkg.icon || "",
    version: pkg.active_version || "",
    trust_level: pkg.trust_level || "normal",
    author_name: pkg.author_name || "未知",
    subscriptions: pkg.stats?.subscriptions ?? 0,
    is_kill_switched: pkg.is_kill_switched,
  };
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function Skills({ user }: { user: MeResponse }) {
  const navigate = useNavigate();
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  const [packages, setPackages] = useState<SkillPackageV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category>("全部");

  /* -- load skills -- */

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.getRaw<{ items: SkillPackageV2[] }>(
        "GET",
        `/skills${search ? `?search=${encodeURIComponent(search)}` : ""}`,
      );
      setPackages(resp.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  /* -- filtered list -- */

  const filtered = useMemo(() => {
    let list = packages;
    if (category !== "全部") {
      list = list.filter((p) => (p.category || "engineering") === category);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.display_name || "").toLowerCase().includes(q) ||
          (p.description || "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [packages, category, search]);

  /* -- handlers -- */

  const handleDetail = useCallback(
    (pkgId: string) => {
      navigate(`/skills/${pkgId}`);
    },
    [navigate],
  );

  const handleSubscribe = useCallback(async (pkgId: string) => {
    try {
      await api.subscribeSkill(pkgId);
    } catch (err) {
      console.error("Subscribe failed:", err);
    }
  }, []);

  /* -- promote Phase 2 → Phase 1 (企业包推广到 Worker 市场) -- */

  const handlePromote = useCallback(
    async (pkg: SkillPackageV2) => {
      const ok = await showConfirm({
        title: "推广到 Worker 市场",
        message: `将 "${pkg.name}" 推广到 DA Worker 市场？\n\n所有连接的 DA Worker 将能下载安装。`,
        confirmLabel: "确认推广",
        variant: "default",
      });
      if (!ok) return;
      try {
        const result = await api.promotePackageToMarketplace(pkg.id);
        addToast(
          "success",
          `已推广到 Worker 市场（${result.skill.slug} v${result.skill.version}）`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "推广失败";
        addToast("error", msg);
      }
    },
    [showConfirm, addToast],
  );

  /* -- styles -- */

  const pageStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-5)",
  };

  const searchRowStyle: CSSProperties = {
    width: "100%",
  };

  const chipRowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--space-2)",
  };

  const chipBase: CSSProperties = {
    padding: "var(--space-1) var(--space-3)",
    borderRadius: "var(--radius-full)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-medium)" as unknown as number,
    cursor: "pointer",
    border: "1px solid var(--border-primary)",
    background: "var(--bg-tertiary)",
    color: "var(--text-secondary)",
    transition: "all var(--transition-fast)",
    userSelect: "none",
  };

  const chipActive: CSSProperties = {
    background: "var(--brand-primary)",
    color: "var(--brand-foreground)",
    borderColor: "var(--brand-primary)",
  };

  const countStyle: CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
  };

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
    gap: "var(--space-4)",
  };

  const errorStyle: CSSProperties = {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  };

  const loadingStyle: CSSProperties = {
    padding: "var(--space-10)",
    textAlign: "center",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-sm)",
  };

  return (
    <div style={pageStyle}>
      {/* Banner: explain this page's role */}
      <div
        style={{
          padding: "var(--space-4) var(--space-5)",
          marginBottom: "var(--space-4)",
          background: "var(--info-light, #e7f1ff)",
          borderLeft: "3px solid var(--info, #2196f3)",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--text-sm)",
        }}
      >
        本页管理 <strong>企业内部技能包</strong>（多租户订阅制，供企业内部用户使用）。
        如需管理 <strong>DA Worker</strong> 可下载安装的全局 skill，请前往{" "}
        <a
          href="/worker-skills"
          style={{ color: "var(--info, #2196f3)", textDecoration: "underline" }}
        >
          Worker 技能市场
        </a>
        。
      </div>

      {/* Search bar */}
      <div style={searchRowStyle}>
        <SearchBar
          value={search}
          onChange={(v) => setSearch(v)}
          placeholder="搜索 Skills..."
        />
      </div>

      {/* Category chips */}
      <div style={chipRowStyle}>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            style={{
              ...chipBase,
              ...(cat === category ? chipActive : {}),
            }}
            onMouseEnter={(e) => {
              if (cat !== category) {
                e.currentTarget.style.borderColor = "var(--border-secondary)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }
            }}
            onMouseLeave={(e) => {
              if (cat !== category) {
                e.currentTarget.style.borderColor = "var(--border-primary)";
                e.currentTarget.style.background = "var(--bg-tertiary)";
              }
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Result count */}
      <div style={countStyle}>
        共 {filtered.length} 个 Skills
      </div>

      {/* Error */}
      {error && <div style={errorStyle}>{error}</div>}

      {/* Loading */}
      {loading && <div style={loadingStyle}>加载中...</div>}

      {/* Grid or EmptyState */}
      {!loading && !error && (
        <>
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Package size={24} />}
              title="未找到 Skill"
              description="尝试调整搜索条件或切换分类筛选器。"
            />
          ) : (
            <div style={gridStyle}>
              {filtered.map((pkg) => (
                <div
                  key={pkg.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  <SkillCard
                    skill={toCardData(pkg)}
                    onDetail={() => handleDetail(pkg.id)}
                    onSubscribe={() => handleSubscribe(pkg.id)}
                  />
                  {user.is_super_admin && !pkg.is_kill_switched && pkg.active_version_id && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => handlePromote(pkg)}
                    >
                      推广到 Worker 市场
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
