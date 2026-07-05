// =============================================================================
// DeepAnalyze - MarketplacePanel Component
// Browse and install skills from the Hub marketplace
// =============================================================================

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useHubStore } from "../../store/hub";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { Spinner } from "../ui/Spinner";
import {
  Store,
  Search,
  Download,
  Star,
  RefreshCw,
  Package,
  AlertCircle,
  Tag,
  CheckCircle2,
  WifiOff,
} from "lucide-react";

// =============================================================================
// MarketplacePanel
// =============================================================================

export function MarketplacePanel() {
  const { success, error: toastError } = useToast();

  const marketplaceItems = useHubStore((s) => s.marketplaceItems);
  const marketplaceTotal = useHubStore((s) => s.marketplaceTotal);
  const marketplacePage = useHubStore((s) => s.marketplacePage);
  const loading = useHubStore((s) => s.loading);
  const syncState = useHubStore((s) => s.syncState);
  const fetchMarketplaceSkills = useHubStore((s) => s.fetchMarketplaceSkills);

  const loadingMore = useHubStore((s) => s.loadingMore);
  const hasMore = useHubStore((s) => s.hasMore);

  const [searchInput, setSearchInput] = useState("");
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isServerReachable = syncState?.serverReachable ?? false;

  const loadMore = useCallback(async () => {
    setLoadMoreError(null);
    try {
      await fetchMarketplaceSkills(
        marketplacePage + 1,
        useHubStore.getState().marketplaceSearch,
        "append",
      );
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : "加载更多失败");
    }
  }, [fetchMarketplaceSkills, marketplacePage]);

  const loadSkills = useCallback(async () => {
    setLoadError(null);
    setLoadMoreError(null);
    try {
      await fetchMarketplaceSkills(1, searchInput);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载失败");
    }
  }, [fetchMarketplaceSkills, searchInput]);

  useEffect(() => {
    loadSkills();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // IntersectionObserver: 滚动到底部自动加载下一页
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (!hasMore) return;
    if (loading || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, marketplacePage, loadMore]);

  // 即时客户端过滤（仅过滤已加载项，提供 0ms 反馈）
  const displayedItems = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return marketplaceItems;
    return marketplaceItems.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [marketplaceItems, searchInput]);

  const isSearching = searchInput.trim().length > 0;

  const handleSearchChange = (value: string) => {
    setSearchInput(value);

    // 清掉前一个 debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      setLoadError(null);
      fetchMarketplaceSkills(1, value.trim(), "replace").catch((err) => {
        setLoadError(err instanceof Error ? err.message : "搜索失败");
      });
    }, 300);
  };

  // 卸载时清理 timer，避免泄漏 / stale callback
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const handleInstall = async (slug: string, name: string) => {
    setInstallingSlug(slug);
    try {
      const result = await api.installMarketplaceSkill(slug);
      if (result.installed) {
        success(`技能"${name}"安装成功`);
        setInstalledSlugs((prev) => new Set(prev).add(slug));
      } else {
        toastError(result.error ?? "安装失败");
      }
    } catch (err) {
      toastError("安装失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setInstallingSlug(null);
    }
  };

  // ===========================================================================
  // Render
  // ===========================================================================
  return (
    <div style={styles.wrapper}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerTitle}>
          <Store size={18} style={{ color: "var(--interactive)" }} />
          <span style={{ fontWeight: 600, fontSize: "var(--text-base)", color: "var(--text-primary)" }}>
            资源市场
          </span>
        </div>
        <button
          onClick={loadSkills}
          disabled={loading}
          style={styles.refreshBtn}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
          title="刷新"
        >
          <RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {/* Server unreachable warning */}
      {!isServerReachable && syncState && (
        <div style={styles.offlineBanner}>
          <WifiOff size={16} style={{ flexShrink: 0 }} />
          <div>
            <strong>服务器不可达</strong>
            <p style={{ margin: 0, fontSize: "var(--text-xs)", opacity: 0.85 }}>
              无法连接到 Hub 服务器，请检查网络连接。
            </p>
          </div>
        </div>
      )}

      {/* Search bar */}
      <div style={styles.searchBar}>
        <Search size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="搜索技能..."
          style={styles.searchInput}
        />
        {loading && isSearching && (
          <Spinner size="sm" color="var(--text-tertiary)" />
        )}
      </div>

      {/* Error banner */}
      {loadError && (
        <div style={styles.errorBanner}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <strong>加载失败</strong>
            <p style={{ margin: 0, fontSize: "var(--text-xs)", opacity: 0.85, wordBreak: "break-word" as const }}>
              {loadError}
            </p>
          </div>
          <button
            onClick={loadSkills}
            style={{ marginLeft: "auto", flexShrink: 0, padding: "4px 12px", background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "none", borderRadius: "var(--radius-md)", cursor: "pointer", fontSize: "var(--text-xs)" }}
          >
            重试
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && marketplaceItems.length === 0 ? (
        <div style={styles.centerContainer}>
          <Spinner size="lg" />
        </div>
      ) : null}

      {/* Empty state */}
      {!loading && !loadError && displayedItems.length === 0 ? (
        <div style={styles.emptyState}>
          <Package size={32} style={{ color: "var(--text-tertiary)", marginBottom: "var(--space-2)" }} />
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
            {isSearching
              ? `未找到匹配 "${searchInput.trim()}" 的技能`
              : "暂无可用技能"}
          </p>
          {isSearching && (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: "4px 0 0" }}>
              尝试调整关键词或清空搜索
            </p>
          )}
        </div>
      ) : null}

      {/* Skills list */}
      {displayedItems.length > 0 && (
        <div style={styles.skillsList}>
          {displayedItems.map((skill) => {
            const isInstalled = installedSlugs.has(skill.slug);
            const isInstalling = installingSlug === skill.slug;

            return (
              <div key={skill.slug} data-testid="marketplace-skill-card" style={styles.skillCard}>
                {/* Card header */}
                <div style={styles.skillCardHeader}>
                  <h4 style={styles.skillName}>
                    <Package size={14} style={{ color: "var(--interactive)", flexShrink: 0 }} />
                    {skill.name}
                  </h4>
                  <span style={styles.skillVersion}>v{skill.version}</span>
                </div>

                {/* Description */}
                <p style={styles.skillDescription}>{skill.description}</p>

                {/* Tags */}
                {(skill.tags?.length ?? 0) > 0 && (
                  <div style={styles.tagsRow}>
                    {skill.tags.slice(0, 5).map((tag) => (
                      <span key={tag} style={styles.tag}>
                        <Tag size={9} />
                        {tag}
                      </span>
                    ))}
                    {skill.tags.length > 5 && (
                      <span style={styles.tagMore}>+{skill.tags.length - 5}</span>
                    )}
                  </div>
                )}

                {/* Stats row */}
                <div style={styles.statsRow}>
                  <span style={styles.stat}>
                    <Download size={12} />
                    {skill.downloadCount}
                  </span>
                  <span style={styles.stat}>
                    <Star size={12} style={{ color: "var(--warning)" }} />
                    {Number(skill.ratingAvg).toFixed(1)}
                    <span style={{ color: "var(--text-tertiary)", marginLeft: 2 }}>
                      ({skill.reviewCount})
                    </span>
                  </span>
                  <span style={styles.statDate}>
                    {new Date(skill.publishedAt).toLocaleDateString()}
                  </span>
                </div>

                {/* Install button */}
                <div style={styles.skillActions}>
                  <button
                    onClick={() => handleInstall(skill.slug, skill.name)}
                    disabled={isInstalling || isInstalled}
                    style={{
                      ...styles.installBtn,
                      ...(isInstalled ? styles.installedBtn : {}),
                      opacity: isInstalling ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!isInstalled && !isInstalling) {
                        e.currentTarget.style.background = "var(--interactive)";
                        e.currentTarget.style.color = "#fff";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isInstalled && !isInstalling) {
                        e.currentTarget.style.background = "var(--bg-tertiary)";
                        e.currentTarget.style.color = "var(--interactive)";
                      }
                    }}
                  >
                    {isInstalling ? (
                      <>
                        <Spinner size="sm" color="currentColor" />
                        安装中...
                      </>
                    ) : isInstalled ? (
                      <>
                        <CheckCircle2 size={14} />
                        已安装
                      </>
                    ) : (
                      <>
                        <Download size={14} />
                        安装
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 无限滚动哨兵 + 加载更多错误 */}
      {loadMoreError && (
        <div style={styles.loadMoreError}>
          <span>加载更多失败：{loadMoreError}</span>
          <button onClick={loadMore} style={styles.retryBtn}>重试</button>
        </div>
      )}
      {hasMore && (
        <div ref={sentinelRef} data-testid="marketplace-sentinel" style={styles.sentinel}>
          {loadingMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-3)" }}>
              <Spinner size="sm" />
            </div>
          )}
        </div>
      )}

      {/* 已显示全部提示 */}
      {!hasMore && marketplaceItems.length > 0 && (
        <div style={styles.allLoaded}>
          {isSearching
            ? `已显示全部 ${marketplaceItems.length} / ${marketplaceTotal} 个匹配`
            : `已显示全部 ${marketplaceItems.length} 个技能`}
        </div>
      )}

      {/* 搜索中状态指示（首次加载或切换搜索词时） */}
      {isSearching && loading && (
        <div style={styles.searchSummary}>搜索中...</div>
      )}

      {/* Inline keyframes for spinner animation */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// =============================================================================
// Styles
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
    padding: "var(--space-4)",
  },
  centerContainer: {
    height: 200,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // Header
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  refreshBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    borderRadius: "var(--radius-md)",
    border: "none",
    background: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    transition: "background-color var(--transition-fast)",
  },

  // Offline banner
  offlineBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-3)",
    padding: "var(--space-3) var(--space-4)",
    background: "var(--warning-light)",
    border: "1px solid var(--warning)",
    borderRadius: "var(--radius-lg)",
    color: "var(--warning-dark)",
    fontSize: "var(--text-sm)",
  },

  // Search bar
  searchBar: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-lg)",
  },
  searchInput: {
    flex: 1,
    border: "none",
    background: "transparent",
    color: "var(--text-primary)",
    fontSize: "var(--text-sm)",
    outline: "none",
  },

  // Error banner
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-3) var(--space-4)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
    fontSize: "var(--text-sm)",
  },

  // Empty state
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--space-8) var(--space-4)",
    color: "var(--text-tertiary)",
  },

  // Skills list
  skillsList: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },

  // Skill card
  skillCard: {
    padding: "var(--space-4)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-lg)",
    display: "flex",
    flexDirection: "column",
  },
  skillCardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "var(--space-2)",
  },
  skillName: {
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    margin: 0,
  },
  skillVersion: {
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
    flexShrink: 0,
  },
  skillDescription: {
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    margin: "0 0 var(--space-3) 0",
    lineHeight: "var(--leading-relaxed)" as unknown as number,
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },

  // Tags
  tagsRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "var(--space-1)",
    marginBottom: "var(--space-3)",
  },
  tag: {
    fontSize: "10px",
    padding: "2px 6px",
    background: "var(--interactive-light)",
    color: "var(--interactive)",
    borderRadius: "var(--radius-sm)",
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
  },
  tagMore: {
    fontSize: "10px",
    color: "var(--text-tertiary)",
  },

  // Stats row
  statsRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    marginBottom: "var(--space-3)",
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
  },
  stat: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  statDate: {
    marginLeft: "auto",
    color: "var(--text-tertiary)",
    fontSize: "var(--text-xs)",
  },

  // Skill actions
  skillActions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  installBtn: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: "var(--space-1) var(--space-3)",
    background: "var(--bg-tertiary)",
    color: "var(--interactive)",
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    border: "1px solid var(--interactive)",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  },
  installedBtn: {
    background: "var(--success-light)",
    color: "var(--success)",
    borderColor: "var(--success)",
    cursor: "default",
  },

  // Infinite scroll sentinel
  sentinel: {
    minHeight: 1,  // 确保可被 IntersectionObserver 触发
  },
  loadMoreError: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-3)",
    fontSize: "var(--text-xs)",
    color: "var(--error)",
  },
  retryBtn: {
    padding: "2px 10px",
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text-secondary)",
    fontSize: "var(--text-xs)",
    cursor: "pointer",
  },

  // Footer hints
  allLoaded: {
    textAlign: "center",
    padding: "var(--space-3)",
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  },
  searchSummary: {
    textAlign: "center",
    padding: "var(--space-2)",
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  },
};
