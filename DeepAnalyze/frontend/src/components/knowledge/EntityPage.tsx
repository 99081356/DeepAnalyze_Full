// =============================================================================
// DeepAnalyze - EntityPage Component
// Entity/concept detail page with related entities and documents
// =============================================================================

import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import { useMarkdown } from "../../hooks/useMarkdown";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../../hooks/useToast";
import {
  ArrowLeft,
  Tag,
  FileText,
  Link2,
  Hash,
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

interface EntityPageProps {
  kbId: string;
  entityName: string;
  onBack: () => void;
  onNavigateEntity: (name: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export function EntityPage({
  kbId,
  entityName,
  onBack,
  onNavigateEntity,
}: EntityPageProps) {
  // --- State ---
  const [results, setResults] = useState<WikiResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relatedEntities, setRelatedEntities] = useState<string[]>([]);
  const { error: toastError } = useToast();

  // --- Markdown rendering for top result content ---
  const topContent = results.length > 0 ? results[0].content : "";
  const markdownHtml = useMarkdown(topContent);

  // --- Fetch entity data on mount ---
  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const resp = await api.searchWiki(kbId, entityName);
        if (cancelled) return;
        setResults(resp.results);

        // Extract related entity names from metadata
        const entitySet = new Set<string>();
        resp.results.forEach((r) => {
          const related = r.metadata?.relatedEntities;
          if (Array.isArray(related)) {
            related.forEach((e) => {
              if (typeof e === "string" && e !== entityName) {
                entitySet.add(e);
              }
            });
          }
          const entities = r.metadata?.entities;
          if (Array.isArray(entities)) {
            entities.forEach((e) => {
              if (typeof e === "string" && e !== entityName) {
                entitySet.add(e);
              }
            });
          }
        });
        setRelatedEntities(Array.from(entitySet));
      } catch (err) {
        if (!cancelled) {
          setResults([]);
          setError(err instanceof Error ? err.message : "加载实体数据失败");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [kbId, entityName]);

  // --- Handlers ---
  const handleEntityClick = useCallback(
    (name: string) => {
      onNavigateEntity(name);
    },
    [onNavigateEntity],
  );

  // --- Extract metadata from first result ---
  const topResult = results[0];
  const entityType =
    (topResult?.metadata?.entityType as string) ??
    (topResult?.metadata?.type as string) ??
    "实体";
  const occurrenceCount =
    (topResult?.metadata?.occurrenceCount as number) ?? results.length;
  const relatedDocs = results.slice(0, 10);

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
        <button
          onClick={onBack}
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
          <ArrowLeft size={16} />
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-lg)",
              fontWeight: "var(--font-semibold)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entityName}
          </h2>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginTop: "var(--space-1)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
              }}
            >
              <Tag size={10} />
              {entityType}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
              }}
            >
              <Hash size={10} />
              {occurrenceCount} 次出现
            </span>
          </div>
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
            <Tag
              size={40}
              style={{
                margin: "0 auto var(--space-3)",
                display: "block",
              }}
            />
            <p style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-2)" }}>
              加载失败
            </p>
            <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: "0 0 var(--space-3)" }}>
              {error}
            </p>
            <button
              onClick={() => {
                setError(null);
                setIsLoading(true);
                api.searchWiki(kbId, entityName)
                  .then((resp) => { setResults(resp.results); })
                  .catch((err) => { setError(err instanceof Error ? err.message : "加载失败"); })
                  .finally(() => setIsLoading(false));
              }}
              style={{
                padding: "var(--space-2) var(--space-4)",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-primary)",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
                color: "var(--text-secondary)",
              }}
            >
              重试
            </button>
          </div>
        ) : results.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-12) 0",
              color: "var(--text-tertiary)",
            }}
          >
            <Tag
              size={40}
              style={{
                margin: "0 auto var(--space-3)",
                opacity: 0.4,
                display: "block",
              }}
            />
            <p style={{ fontSize: "var(--text-sm)", margin: 0 }}>
              未找到实体 "{entityName}" 的相关信息
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-5)",
              animation: "fadeIn var(--transition-base) ease-out",
            }}
          >
            {/* ============================================================ */}
            {/* Entity content                                                */}
            {/* ============================================================ */}
            <div>
              <h3
                style={{
                  margin: 0,
                  marginBottom: "var(--space-2)",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--font-semibold)",
                  color: "var(--text-primary)",
                }}
              >
                概述
              </h3>
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                  lineHeight: "var(--leading-relaxed)",
                  padding: "var(--space-3) var(--space-4)",
                  backgroundColor: "var(--bg-tertiary)",
                  borderRadius: "var(--radius-lg)",
                  border: "1px solid var(--border-primary)",
                }}
                dangerouslySetInnerHTML={{ __html: markdownHtml }}
              />
            </div>

            {/* ============================================================ */}
            {/* Related documents                                             */}
            {/* ============================================================ */}
            <div>
              <h3
                style={{
                  margin: 0,
                  marginBottom: "var(--space-2)",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--font-semibold)",
                  color: "var(--text-primary)",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                }}
              >
                <FileText size={14} />
                相关文档 ({relatedDocs.length})
              </h3>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                {relatedDocs.map((doc, i) => (
                  <div
                    key={`${doc.docId}-${i}`}
                    style={{
                      padding: "var(--space-2) var(--space-3)",
                      backgroundColor: "var(--bg-tertiary)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-md)",
                    }}
                  >
                    <p
                      style={{
                        fontSize: "var(--text-sm)",
                        fontWeight: "var(--font-medium)",
                        color: "var(--text-primary)",
                        margin: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {(doc.metadata?.title as string) ?? doc.docId}
                    </p>
                    <p
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-tertiary)",
                        margin: 0,
                        marginTop: "var(--space-1)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {doc.content}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* ============================================================ */}
            {/* Related entities                                              */}
            {/* ============================================================ */}
            {relatedEntities.length > 0 && (
              <div>
                <h3
                  style={{
                    margin: 0,
                    marginBottom: "var(--space-2)",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--font-semibold)",
                    color: "var(--text-primary)",
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                  }}
                >
                  <Link2 size={14} />
                  相关实体 ({relatedEntities.length})
                </h3>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--space-2)",
                  }}
                >
                  {relatedEntities.map((name) => (
                    <button
                      key={name}
                      onClick={() => handleEntityClick(name)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        padding: "var(--space-1) var(--space-3)",
                        fontSize: "var(--text-xs)",
                        fontWeight: "var(--font-medium)",
                        backgroundColor: "var(--interactive-light)",
                        border: "1px solid transparent",
                        borderRadius: "var(--radius-full)",
                        color: "var(--interactive)",
                        cursor: "pointer",
                        transition:
                          "background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor =
                          "var(--interactive)";
                        e.currentTarget.style.color = "#fff";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor =
                          "var(--interactive-light)";
                        e.currentTarget.style.color = "var(--interactive)";
                      }}
                    >
                      <Tag size={10} />
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

export default EntityPage;
