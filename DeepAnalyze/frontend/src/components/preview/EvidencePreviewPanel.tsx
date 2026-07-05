import { useEffect, useCallback, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { X, FileText, ExternalLink, Loader2 } from "lucide-react";
import { useEvidencePreviewStore } from "../../store/evidencePreview";
import { useUIStore } from "../../store/ui";
import { api } from "../../api/client";
import { useMarkdown } from "../../hooks/useMarkdown";
import { ImagePreview, DocumentPreview, TablePreview, MediaPreview } from "./renderers";

// ---------------------------------------------------------------------------
// Anchor preview data (unchanged)
// ---------------------------------------------------------------------------

interface PreviewData {
  anchor: { id: string; element_type: string; content_preview?: string };
  previewType: "image" | "document" | "table" | "audio" | "video";
  imageUrl?: string;
  imageCaption?: string;
  sectionContent?: string;
  sectionTitle?: string;
  highlightText?: string;
  lineStart?: number | null;
  tableData?: {
    headers: string[];
    rows: string[][];
    highlightRowIndex?: number;
    caption?: string;
  };
  mediaUrl?: string;
  display: { originalName: string; kbName: string };
  kbId: string;
  docId: string;
}

// ---------------------------------------------------------------------------
// Document mode level content renderer
// ---------------------------------------------------------------------------

function LevelContent({ content, level }: { content: string; level: string }) {
  // L2 is raw JSON — render as preformatted text
  if (level === "L2") {
    return (
      <pre
        style={{
          fontSize: "var(--text-xs)",
          lineHeight: 1.5,
          padding: "var(--space-3)",
          backgroundColor: "var(--bg-tertiary)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-md)",
          maxHeight: "calc(100vh - 260px)",
          overflow: "auto",
          margin: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--text-primary)",
        }}
      >
        {content}
      </pre>
    );
  }

  // L0/L1 — render as markdown
  return <MarkdownContent content={content} />;
}

function MarkdownContent({ content }: { content: string }) {
  const html = useMarkdown(content);
  return (
    <div
      className="markdown-content"
      style={{
        fontSize: "var(--text-sm)",
        lineHeight: "var(--leading-relaxed)",
        padding: "var(--space-3)",
        backgroundColor: "var(--bg-tertiary)",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-md)",
        maxHeight: "calc(100vh - 260px)",
        overflow: "auto",
        color: "var(--text-primary)",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main panel component
// ---------------------------------------------------------------------------

type DocLevel = "L0" | "L1" | "L2";

interface DocMeta {
  filename: string;
  kbName: string;
  status: string;
}

export function EvidencePreviewPanel() {
  const { isOpen, mode, anchorId, kbId, docId, closePreview } = useEvidencePreviewStore();
  const navigateToDoc = useUIStore((s) => s.navigateToDoc);

  // --- Anchor mode state ---
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Document mode state ---
  const [docMeta, setDocMeta] = useState<DocMeta | null>(null);
  const [activeLevel, setActiveLevel] = useState<DocLevel>("L1");
  const [levelContent, setLevelContent] = useState<Record<string, { content: string; expandable: boolean }>>({});
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const docAbortRef = useRef<AbortController | null>(null);

  // =========================================================================
  // Anchor mode: fetch preview data
  // =========================================================================
  useEffect(() => {
    if (!isOpen || mode !== "anchor" || !anchorId) {
      setData(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetch(`/api/preview/evidence/${encodeURIComponent(anchorId)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) {
          // Fallback: switch to document mode instead of showing error.
          // Prefer backend-provided fallbackDocId (extracted from anchor ID
          // when it has real docId prefix). Otherwise use the docId from the
          // evidence link attributes — covers the case where Agent fabricated
          // a random UUID anchor that doesn't exist in the database but the
          // kbId/docId in the link are still valid.
          const fallbackDoc = json.fallbackDocId || docId;
          const resolvedKbId = kbId || useUIStore.getState().currentKbId;
          if (fallbackDoc && resolvedKbId) {
            useEvidencePreviewStore.getState().openDocumentPreview(resolvedKbId, fallbackDoc);
            return null;
          }
          throw new Error(json.error || "Evidence not found");
        }
        return json;
      })
      .then((json) => {
        if (json) setData(json);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Unknown error");
        setLoading(false);
      });
  }, [isOpen, mode, anchorId]);

  // =========================================================================
  // Document mode: fetch metadata + default L1 content
  // =========================================================================
  useEffect(() => {
    if (!isOpen || mode !== "document" || !kbId || !docId) {
      setDocMeta(null);
      setLevelContent({});
      setActiveLevel("L1");
      setDocError(null);
      return;
    }

    const controller = new AbortController();
    docAbortRef.current = controller;

    async function fetchDocMode() {
      setDocLoading(true);
      setDocError(null);
      setLevelContent({});

      try {
        // Fetch KB name and doc status in parallel
        const [kbRes, statusRes] = await Promise.all([
          fetch(`/api/knowledge/kbs/${encodeURIComponent(kbId!)}`, { signal: controller.signal }),
          fetch(`/api/knowledge/kbs/${encodeURIComponent(kbId!)}/documents/${encodeURIComponent(docId!)}/status`, { signal: controller.signal }),
        ]);

        if (!kbRes.ok || !statusRes.ok) throw new Error("Document not found");

        const kbData = await kbRes.json();
        const statusData = await statusRes.json();

        if (controller.signal.aborted) return;

        setDocMeta({
          filename: statusData.filename || "Unknown",
          kbName: kbData.name || "",
          status: statusData.status || "unknown",
        });

        // Fetch L1 content (default level)
        const result = await api.expandWiki(kbId!, docId!, "L1", "md");
        if (controller.signal.aborted) return;

        setLevelContent({ L1: { content: result.content, expandable: result.expandable } });
        setActiveLevel("L1");
        setDocLoading(false);
      } catch (err: any) {
        if (controller.signal.aborted) return;
        setDocError(err instanceof Error ? err.message : "Failed to load document");
        setDocLoading(false);
      }
    }

    fetchDocMode();
    return () => controller.abort();
  }, [isOpen, mode, kbId, docId]);

  // =========================================================================
  // Document mode: level switching
  // =========================================================================
  const handleLevelSwitch = useCallback(async (level: DocLevel) => {
    if (!kbId || !docId) return;
    setActiveLevel(level);

    // Use cached content if available
    if (levelContent[level]) return;

    setDocLoading(true);
    try {
      const result = await api.expandWiki(kbId, docId, level, level === "L1" ? "md" : undefined);
      setLevelContent((prev) => ({
        ...prev,
        [level]: { content: result.content, expandable: result.expandable },
      }));
    } catch (err) {
      setDocError(err instanceof Error ? err.message : `Failed to load ${level}`);
    } finally {
      setDocLoading(false);
    }
  }, [kbId, docId, levelContent]);

  // =========================================================================
  // Keyboard: Escape to close
  // =========================================================================
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    },
    [closePreview],
  );

  useEffect(() => {
    if (isOpen) window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // =========================================================================
  // Skeleton loader
  // =========================================================================
  const renderSkeleton = () => (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-3)",
      padding: "var(--space-4)",
    }}>
      <div style={{ height: 20, background: "var(--bg-tertiary)", borderRadius: "var(--radius-sm)", width: "60%" }} />
      <div style={{ height: 200, background: "var(--bg-tertiary)", borderRadius: "var(--radius-md)" }} />
      <div style={{ height: 14, background: "var(--bg-tertiary)", borderRadius: "var(--radius-sm)", width: "80%" }} />
    </div>
  );

  // =========================================================================
  // Anchor mode content (unchanged logic)
  // =========================================================================
  const renderAnchorContent = () => {
    if (loading) return renderSkeleton();

    if (error) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-8)",
          gap: "var(--space-2)",
        }}>
          <p style={{ color: "var(--error)", fontSize: "var(--text-sm)", margin: 0 }}>{error}</p>
          <p style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)", margin: 0 }}>
            Anchor ID: {anchorId}
          </p>
        </div>
      );
    }

    if (!data) return null;

    switch (data.previewType) {
      case "image":
        return <ImagePreview imageUrl={data.imageUrl!} imageCaption={data.imageCaption} />;
      case "document":
        return (
          <DocumentPreview
            sectionContent={data.sectionContent}
            sectionTitle={data.sectionTitle}
            highlightText={data.highlightText}
            lineStart={data.lineStart}
          />
        );
      case "table":
        return <TablePreview tableData={data.tableData!} />;
      case "audio":
      case "video":
        return <MediaPreview mediaUrl={data.mediaUrl!} previewType={data.previewType} />;
      default:
        return (
          <p style={{ color: "var(--text-tertiary)", fontSize: "var(--text-sm)", padding: "var(--space-3)" }}>
            Unsupported preview type: {data.previewType}
          </p>
        );
    }
  };

  // =========================================================================
  // Document mode content (new)
  // =========================================================================
  const renderDocumentContent = () => {
    // Initial loading (no metadata yet)
    if (docLoading && !docMeta) return renderSkeleton();

    if (docError && !docMeta) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-8)",
          gap: "var(--space-2)",
        }}>
          <p style={{ color: "var(--error)", fontSize: "var(--text-sm)", margin: 0 }}>{docError}</p>
        </div>
      );
    }

    const levels: DocLevel[] = ["L0", "L1", "L2"];
    const levelLabels: Record<DocLevel, string> = { L0: "摘要", L1: "结构", L2: "原始" };
    const currentContent = levelContent[activeLevel];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", padding: "var(--space-2)" }}>
        {/* Level tabs */}
        <div style={{ display: "flex", gap: "var(--space-2)", padding: "0 var(--space-1)" }}>
          {levels.map((level) => {
            const isActive = activeLevel === level;
            const isCached = !!levelContent[level];
            let borderColor: string;
            let dotColor: string;
            let textColor: string;
            let bgColor: string;

            if (isActive) {
              borderColor = "var(--interactive)";
              dotColor = "var(--interactive)";
              textColor = "var(--interactive)";
              bgColor = "var(--interactive-light, rgba(59, 130, 246, 0.08))";
            } else if (isCached) {
              borderColor = "var(--success)";
              dotColor = "var(--success)";
              textColor = "var(--success)";
              bgColor = "transparent";
            } else {
              borderColor = "var(--border-primary)";
              dotColor = "var(--text-tertiary)";
              textColor = "var(--text-tertiary)";
              bgColor = "transparent";
            }

            return (
              <button
                key={level}
                onClick={() => handleLevelSwitch(level)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "var(--space-1) var(--space-2)",
                  border: `1px solid ${borderColor}`,
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: bgColor,
                  color: textColor,
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  cursor: "pointer",
                  transition: "all var(--transition-fast)",
                }}
              >
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: dotColor,
                  flexShrink: 0,
                }} />
                {level} {levelLabels[level]}
              </button>
            );
          })}
        </div>

        {/* Loading indicator for level switch */}
        {docLoading && docMeta && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-xs)",
          }}>
            <Loader2 size={14} className="animate-spin" />
            Loading {activeLevel}...
          </div>
        )}

        {/* Error for level fetch */}
        {docError && docMeta && (
          <div style={{
            padding: "var(--space-2) var(--space-3)",
            backgroundColor: "rgba(239, 68, 68, 0.06)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
            borderRadius: "var(--radius-sm)",
            fontSize: "var(--text-xs)",
            color: "var(--error)",
          }}>
            {docError}
          </div>
        )}

        {/* Level content */}
        {currentContent && !docLoading && (
          <LevelContent content={currentContent.content} level={activeLevel} />
        )}
      </div>
    );
  };

  // =========================================================================
  // Header title
  // =========================================================================
  const headerTitle = mode === "document"
    ? (docMeta?.filename || "Document Preview")
    : (data?.display?.originalName || "Evidence Preview");

  const headerKbName = mode === "document"
    ? docMeta?.kbName
    : data?.display?.kbName;

  // Show footer when we have kbId + docId (for both modes)
  const showFooter = kbId && docId && (mode === "document" || !!data);

  // =========================================================================
  // Panel JSX
  // =========================================================================
  const panel = (
    <>
      {/* Overlay */}
      <div
        onClick={closePreview}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.4)",
          zIndex: 1400,
          animation: "rightPanelFadeIn var(--transition-base) ease-out",
        }}
      />

      {/* Panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 560,
          backgroundColor: "var(--bg-primary)",
          borderLeft: "1px solid var(--border-primary)",
          boxShadow: "var(--shadow-2xl)",
          zIndex: 1500,
          display: "flex",
          flexDirection: "column",
          animation: "rightPanelSlideIn var(--transition-slow) ease-out",
        }}
      >
        {/* Header */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-4)",
            borderBottom: "1px solid var(--border-primary)",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <FileText size={14} style={{ color: "var(--interactive)", flexShrink: 0 }} />
          <span
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-semibold)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {headerTitle}
          </span>
          {headerKbName && (
            <span style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              flexShrink: 0,
            }}>
              {headerKbName}
            </span>
          )}
          <button
            onClick={closePreview}
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
              transition: "background-color var(--transition-fast), color var(--transition-fast)",
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

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {mode === "document" ? renderDocumentContent() : renderAnchorContent()}
        </div>

        {/* Footer */}
        {showFooter && (
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "var(--space-2) var(--space-4)",
              borderTop: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-secondary)",
            }}
          >
            <button
              onClick={() => {
                navigateToDoc(kbId!, docId!);
                closePreview();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "4px 12px",
                background: "transparent",
                color: "var(--interactive)",
                fontSize: "var(--text-xs)",
                fontWeight: 500,
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--interactive)",
                cursor: "pointer",
                transition: "background var(--transition-fast)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(59, 130, 246, 0.1)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <ExternalLink size={12} />
              在知识库中查看
            </button>
          </div>
        )}
      </div>
    </>
  );

  return createPortal(panel, document.body);
}
