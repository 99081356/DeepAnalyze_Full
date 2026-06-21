import { useEffect, useState, useCallback, useMemo, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Package } from "lucide-react";
import { api, type MeResponse, type SkillPackageV2 } from "../api/client.js";
import { SearchBar } from "../components/ui/SearchBar.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { SkillCard, type SkillCardData } from "../components/hub/SkillCard.js";

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

export function Skills({ user: _user }: { user: MeResponse }) {
  const navigate = useNavigate();

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
                <SkillCard
                  key={pkg.id}
                  skill={toCardData(pkg)}
                  onDetail={() => handleDetail(pkg.id)}
                  onSubscribe={() => handleSubscribe(pkg.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
