// =============================================================================
// DeepAnalyze - WikiBrowser Component
// Wiki browser with L0/L1/L2 progressive expansion
// =============================================================================

import React, { useState, useCallback } from "react";
import { api } from "../../api/client";
import { useMarkdown } from "../../hooks/useMarkdown";
import { useToast } from "../../hooks/useToast";
import { Spinner } from "../ui/Spinner";
import { VirtualizedContent } from "../common/VirtualizedContent";
import { LevelSwitcher } from "../search/LevelSwitcher";
import {
  Search,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
} from "lucide-react";

// =============================================================================
// Types
// =============================================================================

interface WikiResult {
  docId: string;
  level: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

interface WikiPage {
  id: string;
  kbId: string;
  docId?: string;
  pageType: string;
  title: string;
  content: string;
  tokenCount?: number;
  links?: Array<{
    sourcePageId: string;
    targetPageId: string;
    linkType: string;
    entityName?: string;
  }>;
  metadata?: Record<string, unknown>;
}

interface ExpandedContent {
  content: string;
  level: string;
  expandable: boolean;
}

interface WikiBrowserProps {
  kbId: string;
  onNavigateEntity?: (name: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export function WikiBrowser({ kbId, onNavigateEntity }: WikiBrowserProps) {
  const { error: toastError } = useToast();
  // --- State ---
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WikiResult[]>([]);
  const [selectedPage, setSelectedPage] = useState<WikiPage | null>(null);
  const [expandedLevel, setExpandedLevel] = useState<"L0" | "L1" | "L2">("L0");
  const [expandedContent, setExpandedContent] = useState<ExpandedContent | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [showLinks, setShowLinks] = useState(true);

  // --- Markdown rendering ---
  const markdownL0 = useMarkdown(selectedPage?.content ?? "");
  const markdownExpanded = useMarkdown(expandedContent?.content ?? "");

  // --- Handlers ---
  const handleSearch = useCallback(async () => {
    if (!kbId || !query.trim()) return;
    setIsSearching(true);
    try {
      const resp = await api.searchWiki(kbId, query);
      setResults(resp.results);
      setSelectedPage(null);
      setExpandedLevel("L0");
      setExpandedContent(null);
    } catch {
      toastError("搜索失败，请重试");
    } finally {
      setIsSearching(false);
    }
  }, [kbId, query]);

  const handleSelectResult = useCallback(
    async (result: WikiResult) => {
      setIsLoadingPage(true);
      try {
        const page = await api.browseWiki(kbId, result.docId);
        setSelectedPage(page);
        setExpandedLevel("L0");
        setExpandedContent(null);
      } catch {
        toastError("页面加载失败");
        // Fallback: show raw content from search result
        setSelectedPage({
          id: result.docId,
          kbId,
          docId: result.docId,
          pageType: "abstract",
          title: (result.metadata?.title as string) ?? result.docId,
          content: result.content,
          metadata: result.metadata,
        });
      } finally {
        setIsLoadingPage(false);
      }
    },
    [kbId],
  );

  const handleExpand = useCallback(
    async (level: "L1" | "L2") => {
      if (!selectedPage?.docId) return;
      setIsExpanding(true);
      try {
        const resp = await api.expandWiki(kbId, selectedPage.docId, level);
        setExpandedContent(resp);
        setExpandedLevel(level);
      } catch {
        toastError("内容展开失败");
        // Expand failed
      } finally {
        setIsExpanding(false);
      }
    },
    [kbId, selectedPage],
  );

  const handleEntityClick = useCallback(
    (name: string) => {
      onNavigateEntity?.(name);
    },
    [onNavigateEntity],
  );

  // =====================================================================
  // Render helpers
  // =====================================================================

  /** Render content for the currently active level */
  const renderContent = () => {
    if (expandedLevel === "L0") {
      return (
        <VirtualizedContent
          content={selectedPage?.content ?? ""}
          maxHeight={600}
          markdown
          markdownHtml={markdownL0}
          style={{
            animation: "fadeIn var(--transition-base) ease-out",
          }}
        />
      );
    }
    if (expandedContent) {
      return (
        <VirtualizedContent
          content={expandedContent.content}
          maxHeight={600}
          markdown
          markdownHtml={markdownExpanded}
          style={{
            animation: "fadeIn var(--transition-base) ease-out",
          }}
        />
      );
    }
    return null;
  };

  /** Render forward/backward links in a collapsible association panel */
  const renderLinks = () => {
    if (!selectedPage?.links || selectedPage.links.length === 0) return null;

    const forwardLinks = selectedPage.links.filter(
      (l) => l.linkType === "forward",
    );
    const backwardLinks = selectedPage.links.filter(
      (l) => l.linkType === "backward",
    );
    const entityRefs = selectedPage.links.filter(
      (l) => l.linkType === "entity_ref" || l.linkType === "concept_ref",
    );

    return (
      <div
        style={{
          marginTop: "var(--space-4)",
          borderTop: "1px solid var(--border-primary)",
          paddingTop: "var(--space-3)",
        }}
      >
        <button
          onClick={() => setShowLinks(!showLinks)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-semibold)",
            color: "var(--text-primary)",
            padding: 0,
            width: "100%",
          }}
        >
          {showLinks ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          关联面板 ({selectedPage.links.length}条链接)
        </button>

        {showLinks && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
              marginTop: "var(--space-2)",
            }}
          >
            {/* Forward links */}
            {forwardLinks.length > 0 && (
              <div>
                <p
                  style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-1)",
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  前向链接
                </p>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--space-1)",
                    marginTop: "var(--space-1)",
                  }}
                >
                  {forwardLinks.map((link) => (
                    <button
                      key={`fwd-${link.targetPageId}`}
                      onClick={() => {
                        setQuery(link.targetPageId);
                        handleSearch();
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        padding: "2px var(--space-2)",
                        fontSize: "var(--text-xs)",
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "var(--radius-md)",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        transition:
                          "background-color var(--transition-fast), border-color var(--transition-fast)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--interactive)";
                        e.currentTarget.style.color = "var(--interactive)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border-primary)";
                        e.currentTarget.style.color = "var(--text-secondary)";
                      }}
                    >
                      <ExternalLink size={10} />
                      {link.targetPageId}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Backward links */}
            {backwardLinks.length > 0 && (
              <div>
                <p
                  style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-1)",
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  后向链接
                </p>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--space-1)",
                    marginTop: "var(--space-1)",
                  }}
                >
                  {backwardLinks.map((link) => (
                    <button
                      key={`bwd-${link.sourcePageId}`}
                      onClick={() => {
                        setQuery(link.sourcePageId);
                        handleSearch();
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        padding: "2px var(--space-2)",
                        fontSize: "var(--text-xs)",
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "var(--radius-md)",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        transition:
                          "background-color var(--transition-fast), border-color var(--transition-fast)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--interactive)";
                        e.currentTarget.style.color = "var(--interactive)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border-primary)";
                        e.currentTarget.style.color = "var(--text-secondary)";
                      }}
                    >
                      <ExternalLink size={10} />
                      {link.sourcePageId}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Entity references */}
            {entityRefs.length > 0 && (
              <div>
                <p
                  style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-semibold)",
                    color: "var(--text-tertiary)",
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  相关实体
                </p>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--space-1)",
                    marginTop: "var(--space-1)",
                  }}
                >
                  {entityRefs.map((link) => (
                    <button
                      key={`ent-${link.entityName || link.targetPageId}`}
                      onClick={() =>
                        link.entityName && handleEntityClick(link.entityName)
                      }
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        padding: "2px var(--space-2)",
                        fontSize: "var(--text-xs)",
                        backgroundColor: "var(--interactive-light)",
                        border: "1px solid transparent",
                        borderRadius: "var(--radius-md)",
                        color: "var(--interactive)",
                        cursor: link.entityName ? "pointer" : "default",
                        transition:
                          "background-color var(--transition-fast), border-color var(--transition-fast)",
                      }}
                      onMouseEnter={(e) => {
                        if (link.entityName) {
                          e.currentTarget.style.backgroundColor =
                            "var(--interactive)";
                          e.currentTarget.style.color = "#fff";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (link.entityName) {
                          e.currentTarget.style.backgroundColor =
                            "var(--interactive-light)";
                          e.currentTarget.style.color = "var(--interactive)";
                        }
                      }}
                    >
                      {link.entityName ?? link.targetPageId}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // =====================================================================
  // Main render
  // =====================================================================

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--bg-primary)",
      }}
    >
      {/* ================================================================ */}
      {/* Search bar                                                       */}
      {/* ================================================================ */}
      <div
        style={{
          flexShrink: 0,
          padding: "var(--space-3) var(--space-4)",
          borderBottom: "1px solid var(--border-primary)",
          backgroundColor: "var(--bg-secondary)",
        }}
      >
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <div
            style={{
              flex: 1,
              position: "relative",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Search
              size={16}
              style={{
                position: "absolute",
                left: "var(--space-3)",
                color: "var(--text-tertiary)",
                pointerEvents: "none",
              }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="搜索 Wiki 页面..."
              style={{
                width: "100%",
                padding: "var(--space-2) var(--space-4) var(--space-2) var(--space-10)",
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-lg)",
                fontSize: "var(--text-sm)",
                color: "var(--text-primary)",
                outline: "none",
                transition: "border-color var(--transition-fast)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--interactive)";
                e.currentTarget.style.boxShadow =
                  "0 0 0 2px var(--interactive-light)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-primary)";
                e.currentTarget.style.boxShadow = "none";
              }}
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={isSearching}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              padding: "var(--space-2) var(--space-4)",
              backgroundColor: "var(--interactive)",
              color: "#fff",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-medium)",
              borderRadius: "var(--radius-lg)",
              border: "none",
              cursor: isSearching ? "not-allowed" : "pointer",
              opacity: isSearching ? 0.5 : 1,
              transition:
                "background-color var(--transition-fast), opacity var(--transition-fast)",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              if (!isSearching)
                e.currentTarget.style.backgroundColor =
                  "var(--interactive-hover)";
            }}
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--interactive)")
            }
          >
            {isSearching ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
            {isSearching ? "搜索中..." : "搜索"}
          </button>
        </div>
      </div>

      {/* ================================================================ */}
      {/* Content area                                                     */}
      {/* ================================================================ */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-4)",
        }}
      >
        {/* ---- Loading state for page fetch ---- */}
        {isLoadingPage && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              padding: "var(--space-12) 0",
            }}
          >
            <Spinner size="lg" />
          </div>
        )}

        {/* ---- Detail view ---- */}
        {!isLoadingPage && selectedPage ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
              animation: "fadeIn var(--transition-base) ease-out",
            }}
          >
            {/* Page title */}
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: "var(--text-xl)",
                  fontWeight: "var(--font-semibold)",
                  color: "var(--text-primary)",
                }}
              >
                {selectedPage.title}
              </h2>
              {selectedPage.tokenCount != null && (
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-tertiary)",
                    marginTop: "var(--space-1)",
                    display: "inline-block",
                  }}
                >
                  {selectedPage.tokenCount} tokens
                </span>
              )}
            </div>

            {/* Level switcher - integrated from Task 8 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                flexWrap: "wrap",
              }}
            >
              <LevelSwitcher
                pageId={selectedPage.id}
                kbId={kbId}
                currentLevel={expandedLevel}
                availableLevels={["L0", "L1", "L2"]}
                onLevelChange={(level, content) => {
                  if (level === "L0") {
                    // L0 is the default page content — reset to original page content
                    setExpandedLevel("L0");
                    setExpandedContent(null);
                  } else {
                    setExpandedLevel(level);
                    setExpandedContent({
                      content,
                      level,
                      expandable: level !== "L2",
                    });
                  }
                }}
              />
            </div>

            {/* Expanding spinner */}
            {isExpanding && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: "var(--space-4) 0",
                }}
              >
                <Spinner size="md" />
              </div>
            )}

            {/* Content */}
            {!isExpanding && (
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                  lineHeight: "var(--leading-relaxed)",
                }}
              >
                {renderContent()}
              </div>
            )}

            {/* Links */}
            {renderLinks()}
          </div>
        ) : !isLoadingPage && results.length > 0 ? (
          /* Search results */
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            <p
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
                margin: 0,
              }}
            >
              找到 {results.length} 条结果
            </p>
            {results.map((result, i) => (
              <button
                key={`${result.docId}-${i}`}
                onClick={() => handleSelectResult(result)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                  padding: "var(--space-3) var(--space-4)",
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-lg)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition:
                    "border-color var(--transition-fast), box-shadow var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--interactive)";
                  e.currentTarget.style.boxShadow =
                    "0 0 0 1px var(--interactive-light)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-primary)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                {/* Title */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--space-2)",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-medium)",
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {(result.metadata?.title as string) ?? result.docId}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      fontWeight: "var(--font-semibold)",
                      padding: "1px var(--space-2)",
                      borderRadius: "var(--radius-sm)",
                      backgroundColor: "var(--interactive-light)",
                      color: "var(--interactive)",
                      flexShrink: 0,
                    }}
                  >
                    {result.score.toFixed(3)}
                  </span>
                </div>

                {/* L0 Preview */}
                <p
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                    margin: 0,
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {result.content}
                </p>

                {/* Level badge */}
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  Level: {result.level} | Doc: {result.docId}
                </span>
              </button>
            ))}
          </div>
        ) : !isLoadingPage ? (
          /* Empty state */
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-12) 0",
              color: "var(--text-tertiary)",
            }}
          >
            <Search
              size={40}
              style={{
                margin: "0 auto var(--space-3)",
                opacity: 0.4,
                display: "block",
              }}
            />
            <p style={{ fontSize: "var(--text-sm)", margin: 0 }}>
              搜索Wiki页面开始浏览
            </p>
          </div>
        ) : null}
      </div>

    </div>
  );
}

export default WikiBrowser;
