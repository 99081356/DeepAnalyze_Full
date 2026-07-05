// =============================================================================
// DeepAnalyze - DocumentViewer Component
// Document viewer with L0/L1/L2 progressive detail levels
// =============================================================================

import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import { useMarkdown } from "../../hooks/useMarkdown";
import { Spinner } from "../ui/Spinner";
import { VirtualizedContent } from "../common/VirtualizedContent";
import {
  X,
  FileText,
  ChevronRight,
  Loader2,
} from "lucide-react";

// =============================================================================
// Types
// =============================================================================

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

interface DocumentViewerProps {
  kbId: string;
  docId: string;
  onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

export function DocumentViewer({ kbId, docId, onClose }: DocumentViewerProps) {
  // --- State ---
  const [page, setPage] = useState<WikiPage | null>(null);
  const [expandedLevel, setExpandedLevel] = useState<"L0" | "L1" | "L2">("L0");
  const [expandedContent, setExpandedContent] = useState<ExpandedContent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanding, setIsExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Markdown rendering ---
  const markdownPage = useMarkdown(page?.content ?? "");
  const markdownExpanded = useMarkdown(expandedContent?.content ?? "");

  // --- Fetch page on mount ---
  useEffect(() => {
    let cancelled = false;

    const fetchPage = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const wikiPage = await api.browseWiki(kbId, docId);
        if (!cancelled) {
          setPage(wikiPage);
        }
      } catch {
        if (!cancelled) {
          setError("无法加载文档");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchPage();
    return () => {
      cancelled = true;
    };
  }, [kbId, docId]);

  // --- Handlers ---
  const handleExpand = useCallback(
    async (level: "L1" | "L2") => {
      setIsExpanding(true);
      try {
        const resp = await api.expandWiki(kbId, docId, level);
        setExpandedContent(resp);
        setExpandedLevel(level);
      } catch {
        // Expand failed
      } finally {
        setIsExpanding(false);
      }
    },
    [kbId, docId],
  );

  // --- Render active content ---
  const renderContent = () => {
    if (expandedLevel === "L0" && page) {
      return (
        <VirtualizedContent
          content={page.content}
          maxHeight={600}
          markdown
          markdownHtml={markdownPage}
          style={{ animation: "fadeIn var(--transition-base) ease-out" }}
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
          style={{ animation: "fadeIn var(--transition-base) ease-out" }}
        />
      );
    }
    return null;
  };

  // =====================================================================
  // Render
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
      {/* Header                                                           */}
      {/* ================================================================ */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-3) var(--space-4)",
          borderBottom: "1px solid var(--border-primary)",
          backgroundColor: "var(--bg-secondary)",
        }}
      >
        <FileText
          size={16}
          style={{
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-base)",
              fontWeight: "var(--font-semibold)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {page?.title ?? docId}
          </h2>
          {page?.tokenCount != null && (
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
              }}
            >
              {page.tokenCount} tokens
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: "var(--radius-md)",
            border: "none",
            backgroundColor: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            transition:
              "background-color var(--transition-fast), color var(--transition-fast)",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          <X size={16} />
        </button>
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
        {isLoading ? (
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
        ) : error ? (
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-12) 0",
              color: "var(--error)",
            }}
          >
            <FileText
              size={40}
              style={{
                margin: "0 auto var(--space-3)",
                opacity: 0.4,
                display: "block",
              }}
            />
            <p style={{ fontSize: "var(--text-sm)", margin: 0 }}>{error}</p>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
              animation: "fadeIn var(--transition-base) ease-out",
            }}
          >
            {/* ============================================================ */}
            {/* Level controls                                                */}
            {/* ============================================================ */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                flexWrap: "wrap",
              }}
            >
              {/* L0 badge */}
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "2px var(--space-2)",
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-semibold)",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor:
                    expandedLevel === "L0"
                      ? "var(--interactive)"
                      : "var(--bg-tertiary)",
                  color:
                    expandedLevel === "L0" ? "#fff" : "var(--text-tertiary)",
                  border: "1px solid var(--border-primary)",
                }}
              >
                L0 摘要
              </span>

              {/* Expand to L1 */}
              {expandedLevel === "L0" && (
                <button
                  onClick={() => handleExpand("L1")}
                  disabled={isExpanding}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "2px var(--space-2)",
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-medium)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-primary)",
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    cursor: isExpanding ? "not-allowed" : "pointer",
                    opacity: isExpanding ? 0.6 : 1,
                    transition:
                      "background-color var(--transition-fast), color var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => {
                    if (!isExpanding) {
                      e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text-primary)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                >
                  {isExpanding ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                  查看 L1 概览
                </button>
              )}

              {/* L1 active + expand to L2 */}
              {expandedLevel === "L1" && (
                <>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "2px var(--space-2)",
                      fontSize: "var(--text-xs)",
                      fontWeight: "var(--font-semibold)",
                      borderRadius: "var(--radius-sm)",
                      backgroundColor: "var(--interactive)",
                      color: "#fff",
                      border: "1px solid var(--border-primary)",
                    }}
                  >
                    L1 概览
                  </span>
                  <button
                    onClick={() => handleExpand("L2")}
                    disabled={isExpanding}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "2px var(--space-2)",
                      fontSize: "var(--text-xs)",
                      fontWeight: "var(--font-medium)",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-primary)",
                      backgroundColor: "var(--bg-tertiary)",
                      color: "var(--text-secondary)",
                      cursor: isExpanding ? "not-allowed" : "pointer",
                      opacity: isExpanding ? 0.6 : 1,
                      transition:
                        "background-color var(--transition-fast), color var(--transition-fast)",
                    }}
                    onMouseEnter={(e) => {
                      if (!isExpanding) {
                        e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                        e.currentTarget.style.color = "var(--text-primary)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
                      e.currentTarget.style.color = "var(--text-secondary)";
                    }}
                  >
                    {isExpanding ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                    查看 L2 全文
                  </button>
                </>
              )}

              {/* L2 active */}
              {expandedLevel === "L2" && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "2px var(--space-2)",
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-semibold)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: "var(--interactive)",
                    color: "#fff",
                    border: "1px solid var(--border-primary)",
                  }}
                >
                  L2 全文
                </span>
              )}

              {/* Regenerate-abstract button now lives in DocumentCard next to
                  the L0 preview (better placement, failure-aware styling). */}
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

            {/* Document content */}
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
          </div>
        )}
      </div>

    </div>
  );
}

export default DocumentViewer;
