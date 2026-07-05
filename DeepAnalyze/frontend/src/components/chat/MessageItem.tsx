import { useMarkdown } from "../../hooks/useMarkdown";
import { ToolCallCard } from "./ToolCallCard";
import { PushContentCard } from "./PushContentCard";
import { TraceabilityLink } from "./TraceabilityLink";
import { FilePreview } from "../ui/FilePreview";
import { useToast } from "../../hooks/useToast";
import { useUIStore } from "../../store/ui";
import { useEvidencePreviewStore } from "../../store/evidencePreview";
import { Copy, RefreshCw, FileDown, FileText, ExternalLink, Brain, ChevronDown } from "lucide-react";
import { useState, useMemo } from "react";
import type { MessageInfo } from "../../types/index";
import { useChatStore } from "../../store/chat";
import { MediaPreview } from "./MediaPreview.js";
import DOMPurify from "dompurify";

/** Escape a string for safe embedding in an HTML attribute value. */
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replace [[doc:docId|文档名]] or [[文档名]] patterns in rendered HTML
 * with clickable spans that have data-doc-id attributes.
 */
function processDocRefs(html: string): string {
  // Match [[doc:xxx|yyy]] — explicit doc reference with ID
  let result = html.replace(
    /\[\[doc:([^\|]+)\|([^\]]+)\]\]/g,
    (_match, docId: string, label: string) =>
      `<span data-doc-id="${escapeHtmlAttr(docId)}" style="color:var(--interactive);cursor:pointer;text-decoration:underline;border-bottom:1px dashed var(--interactive)">${escapeHtmlAttr(label)}</span>`,
  );
  // Match [[文档名]] — simple reference without doc ID
  result = result.replace(
    /\[\[([^\]:\|]+)\]\]/g,
    (_match, label: string) =>
      `<span data-doc-ref="${escapeHtmlAttr(label)}" style="color:var(--interactive);cursor:pointer;border-bottom:1px dashed var(--interactive)">${escapeHtmlAttr(label)}</span>`,
  );
  return result;
}

/**
 * Replace evidence link patterns with clickable links that have data-evidence-* attributes.
 * Handles three formats:
 * 1. da-evidence:// protocol (skill-specified format)
 * 2. Plain UUID docId links [text](uuid) (model-generated fallback)
 * 3. HTML <a> tags (after marked() conversion)
 */
function processEvidenceLinks(html: string): string {
  // Pattern 1: Raw markdown [text](da-evidence://kbId/docId?anchor=anchorId)
  let result = html.replace(
    /\[([^\]]+)\]\(da-evidence:\/\/([^/]+)\/([^?)]+)\?anchor=([^)]+)\)/g,
    (_match, text: string, kbId: string, docId: string, anchorId: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}" data-evidence-anchor="${escapeHtmlAttr(anchorId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 2: HTML <a href="da-evidence://kbId/docId?anchor=anchorId">text</a>
  result = result.replace(
    /<a\s+href="da-evidence:\/\/([^/]+)\/([^?"]+)\?anchor=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (_match, kbId: string, docId: string, anchorId: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}" data-evidence-anchor="${escapeHtmlAttr(anchorId)}">${text}</a>`,
  );
  // Pattern 3: Raw markdown [text](da-evidence://kbId/docId) without anchor
  result = result.replace(
    /\[([^\]]+)\]\(da-evidence:\/\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
    (_match, text: string, kbId: string, docId: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 4: HTML <a href="da-evidence://kbId/docId">text</a> without anchor
  result = result.replace(
    /<a\s+href="da-evidence:\/\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, kbId: string, docId: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}">${text}</a>`,
  );
  // Pattern 5: Raw markdown [text](da-evidence://docId) — single UUID (no kbId prefix)
  result = result.replace(
    /\[([^\]]+)\]\(da-evidence:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
    (_match, text: string, docId: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 6: HTML <a href="da-evidence://docId">text</a> — single UUID (no kbId prefix)
  result = result.replace(
    /<a\s+href="da-evidence:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, docId: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${text}</a>`,
  );
  // Pattern 7: Raw markdown [text](UUID) where UUID is a plain docId
  result = result.replace(
    /\[([^\]]+)\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
    (_match, text: string, docId: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 8: HTML <a href="UUID">text</a> where UUID is a plain docId
  result = result.replace(
    /<a\s+href="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, docId: string, attrs: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}"${attrs}>${text}</a>`,
  );
  // Pattern 9: Bare bracket [da-evidence://kbId/docId] or [da-evidence://kbId/docId?anchor=anchorId]
  // (report generates this format instead of proper markdown [text](url) links)
  result = result.replace(
    /\[da-evidence:\/\/([^/\]]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?anchor=([^\]]+))?\]/gi,
    (_match, kbId: string, docId: string, anchorId?: string) => {
      const anchorAttr = anchorId ? ` data-evidence-anchor="${escapeHtmlAttr(anchorId)}"` : "";
      return `<sup><a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}"${anchorAttr}>📎</a></sup>`;
    },
  );
  // Pattern 9: kb:// protocol [text](kb://docId) — LLM sometimes generates this instead of da-evidence://
  result = result.replace(
    /\[([^\]]+)\]\(kb:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
    (_match, text: string, docId: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${escapeHtmlAttr(text)}</a>`,
  );
  // Pattern 9b: HTML <a href="kb://docId">text</a>
  result = result.replace(
    /<a\s+href="kb:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, docId: string, text: string) =>
      `<a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}">${text}</a>`,
  );
  // Pattern 10: Backtick-wrapped file references [`filename.ext`]
  // These are NOT evidence links (no docId), but styled as inline file tags for readability.
  result = result.replace(
    /\[\x60([^\x60]+)\x60\]/g,
    (_match, filename: string) =>
      `<span class="file-ref">${escapeHtmlAttr(filename)}</span>`,
  );
  // Pattern 11: Bare-text da-evidence:// URLs — LLM sometimes writes these as plain text
  // instead of proper [text](url) markdown links. Convert to clickable 📎 evidence links.
  // Handles: da-evidence://{docId}#{anchor} and da-evidence://{docId} (no anchor).
  // When no anchor is specified, defaults to {docId}:paragraph:0 for better precision.
  // The EvidencePreviewPanel gracefully falls back to document preview if the anchor 404s.
  result = result.replace(
    /da-evidence:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z]+:\d+))?/gi,
    (_match, docId: string, anchorId?: string) => {
      const effectiveAnchor = anchorId || `${docId}:paragraph:0`;
      return `<sup><a href="#" class="evidence-link" data-evidence-doc="${escapeHtmlAttr(docId)}" data-evidence-anchor="${escapeHtmlAttr(effectiveAnchor)}">📎</a></sup>`;
    },
  );
  return result;
}

interface MessageItemProps {
  message: MessageInfo;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === "user";
  // Use the message's own isStreaming flag — supports multiple concurrent streams
  const isStreamingMsg = message.isStreaming === true;
  const [showThinking, setShowThinking] = useState(false);

  // Thinking panel: collapsed by default, user toggles manually.
  // No auto-expand during streaming — let the user decide.
  const [hoveredRef, setHoveredRef] = useState<{ id: string; name: string; rect: DOMRect } | null>(null);
  const rawHtml = useMarkdown(message.content);
  const htmlContent = useMemo(() => {
    const processed = processEvidenceLinks(processDocRefs(rawHtml));
    return DOMPurify.sanitize(processed, {
      ALLOWED_TAGS: [
        "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "br", "hr",
        "ul", "ol", "li",
        "blockquote", "pre", "code",
        "strong", "em", "del", "s",
        "a", "img",
        "table", "thead", "tbody", "tr", "th", "td",
        "span", "div",
        "input",
      ],
      ALLOWED_ATTR: [
        "href", "target", "rel",
        "class", "id",
        "checked", "disabled", "type",
        "alt", "src", "title",
        "style",
        "data-doc-id", "data-doc-ref", "data-doc-name",
        "data-evidence-kb", "data-evidence-doc", "data-evidence-anchor",
      ],
      ADD_TAGS: ["code"],
    });
  }, [rawHtml]);
  // Action bar always visible to prevent layout shift on hover
  const showActions = true;
  const { success, error: toastError } = useToast();
  const currentKbId = useUIStore((s) => s.currentKbId);
  const navigateToDoc = useUIStore((s) => s.navigateToDoc);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  /** Resolve kbId: prefer link's explicit kbId, then currentKbId, then session kbScope. */
  const resolveKbId = (linkKbId: string | undefined): string | undefined => {
    if (linkKbId) return linkKbId;
    if (currentKbId) return currentKbId;
    const { sessions } = useChatStore.getState();
    if (currentSessionId) {
      const session = sessions.find(s => s.id === currentSessionId);
      if (session?.kbScope) {
        try {
          const scope = typeof session.kbScope === 'string' ? JSON.parse(session.kbScope) : session.kbScope;
          const kbs = scope?.knowledgeBases;
          if (Array.isArray(kbs) && kbs.length > 0) return kbs[0].kbId;
        } catch { /* ignore */ }
      }
    }
    return undefined;
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
  };

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--space-3)",
        animation: "fadeIn 0.2s ease-out",
        flexDirection: isUser ? "row-reverse" : "row",
        padding: "var(--space-3) var(--space-5)",
      }}
    >
      {/* Avatar */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "var(--radius-lg)",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--text-xs)",
          fontWeight: 700,
          background: isUser
            ? "var(--interactive)"
            : "linear-gradient(135deg, #06b6d4, #3b82f6)",
          color: "#fff",
        }}
      >
        {isUser ? "U" : "AI"}
      </div>

      {/* Content */}
      <div
        style={{
          maxWidth: isUser ? "75%" : undefined,
          minWidth: 0,
          flex: isUser ? undefined : "1 1 0%",
          display: "flex",
          flexDirection: "column",
          alignItems: isUser ? "flex-end" : "flex-start",
        }}
      >
        {isUser ? (
          <div
            style={{
              display: "inline-block",
              padding: "10px 16px",
              background: "var(--interactive)",
              color: "#fff",
              borderRadius: "18px 4px 18px 18px",
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-relaxed)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {/* Extract display text from possible JSON content */}
            {(() => {
              let displayText = message.content;
              if (message.media) {
                try {
                  const parsed = JSON.parse(message.content);
                  if (parsed.text) displayText = parsed.text;
                } catch { /* not JSON */ }
              }
              return displayText ? <p>{displayText}</p> : null;
            })()}

            {/* Media attachments */}
            {message.media && message.media.length > 0 && currentSessionId && (
              <MediaPreview media={message.media} sessionId={currentSessionId} />
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0, width: "100%" }}>
            {/* Thinking process (collapsible, from JSONL) */}
            {message.thinkingContent && (
              <div>
                <button
                  onClick={() => setShowThinking(!showThinking)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "4px 8px",
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer",
                    fontSize: "var(--text-xs)",
                    color: "var(--text-secondary)",
                    fontWeight: 500,
                    transition: "background var(--transition-fast)",
                  }}
                >
                  <Brain size={12} />
                  过程记录
                  <ChevronDown
                    size={10}
                    style={{
                      transition: "transform var(--transition-fast)",
                      transform: showThinking ? "rotate(180deg)" : "rotate(0)",
                    }}
                  />
                </button>
                {showThinking && (
                  <pre
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "#94a3b8",
                      background: "var(--bg-primary)",
                      borderRadius: "var(--radius-md)",
                      padding: "var(--space-2)",
                      marginTop: "var(--space-1)",
                      overflowX: "auto",
                      overflowWrap: "break-word",
                      whiteSpace: "pre-wrap",
                      maxHeight: 500,
                      margin: 0,
                      border: "1px solid var(--border-primary)",
                    }}
                  >
                    {message.thinkingContent}
                  </pre>
                )}
              </div>
            )}

            {/* Tool calls (top) */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                {message.toolCalls.map((tc) => (
                  <ToolCallCard key={tc.id} toolCall={tc} />
                ))}
              </div>
            )}

            {/* Pushed content / thinking process (middle) */}
            {/* Always show pushed content cards when available — they provide structured UI (collapse, copy, etc.) */}
            {message.pushedContents && message.pushedContents.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {message.pushedContents.map((pc, idx) => (
                  <PushContentCard key={idx} item={pc} />
                ))}
              </div>
            )}

            {/* Message content — report or normal markdown (bottom) */}
            {message.report ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                {/* Report badge */}
                <div style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "2px 8px",
                  background: "linear-gradient(135deg, #3b82f6, #06b6d4)",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--text-xs)",
                  color: "#fff",
                  fontWeight: 600,
                  width: "fit-content",
                }}>
                  <FileText size={12} />
                  {message.report.title}
                </div>
                {/* Full report content rendered as markdown */}
                <div
                  style={{
                    background: "var(--surface-primary)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "4px 18px 18px 18px",
                    padding: "var(--space-3) var(--space-4)",
                  }}
                >
                  <div
                    className="markdown-content"
                    style={{ fontSize: "var(--text-sm)", lineHeight: "var(--leading-relaxed)" }}
                    dangerouslySetInnerHTML={{ __html: htmlContent }}
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      // Handle evidence preview links (with anchor)
                      const evidenceEl = target.closest<HTMLElement>('[data-evidence-anchor]');
                      if (evidenceEl) {
                        e.preventDefault();
                        const { evidenceKb, evidenceDoc, evidenceAnchor } = evidenceEl.dataset;
                        useEvidencePreviewStore.getState().openPreview(evidenceAnchor!, evidenceKb!, evidenceDoc!);
                        return;
                      }
                      // Handle docId-only evidence links (no anchor/kbId)
                      const docEl = target.closest<HTMLElement>('[data-evidence-doc]:not([data-evidence-anchor])');
                      if (docEl) {
                        e.preventDefault();
                        const docId = docEl.dataset.evidenceDoc!;
                        const kbId = resolveKbId(docEl.dataset.evidenceKb);
                        if (kbId) {
                          useEvidencePreviewStore.getState().openDocumentPreview(kbId, docId);
                        }
                        return;
                      }
                      const docRef = target.closest<HTMLElement>('[data-doc-id]');
                      if (docRef && currentKbId) {
                        useEvidencePreviewStore.getState().openDocumentPreview(currentKbId, docRef.dataset.docId!);
                        return;
                      }
                      const namedRef = target.closest<HTMLElement>('[data-doc-ref]');
                      if (namedRef && currentKbId) {
                        navigateToDoc(currentKbId, "");
                      }
                    }}
                  />
                </div>
                {/* Report actions: download + view in report page */}
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <button
                    onClick={async () => {
                      try {
                        const blob = new Blob([message.content], { type: 'text/markdown' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${message.report?.title || 'report'}.md`;
                        a.click();
                        URL.revokeObjectURL(url);
                        success("报告已下载");
                      } catch {
                        toastError("下载失败");
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "4px 12px",
                      background: "var(--bg-hover)",
                      color: "var(--text-secondary)",
                      fontSize: "var(--text-xs)",
                      fontWeight: 500,
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border-primary)",
                      cursor: "pointer",
                      transition: "background var(--transition-fast)",
                    }}
                  >
                    <FileDown size={12} />
                    下载报告
                  </button>
                  {message.report?.id && (
                    <button
                      onClick={() => { window.location.hash = "#/reports"; }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        padding: "4px 12px",
                        background: "var(--bg-hover)",
                        color: "var(--text-secondary)",
                        fontSize: "var(--text-xs)",
                        fontWeight: 500,
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--border-primary)",
                        cursor: "pointer",
                        transition: "background var(--transition-fast)",
                      }}
                    >
                      <ExternalLink size={12} />
                      查看报告页
                    </button>
                  )}
                </div>
              </div>
            ) : message.content ? (
              <div
                style={{
                  background: "var(--surface-primary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "4px 18px 18px 18px",
                  padding: "var(--space-3) var(--space-4)",
                }}
              >
                <div
                  className="markdown-content"
                  style={{ fontSize: "var(--text-sm)", lineHeight: "var(--leading-relaxed)", position: "relative" }}
                  dangerouslySetInnerHTML={{ __html: htmlContent }}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    // Handle evidence preview links (with anchor)
                    const evidenceEl = target.closest<HTMLElement>('[data-evidence-anchor]');
                    if (evidenceEl) {
                      e.preventDefault();
                      const { evidenceKb, evidenceDoc, evidenceAnchor } = evidenceEl.dataset;
                      useEvidencePreviewStore.getState().openPreview(evidenceAnchor!, evidenceKb!, evidenceDoc!);
                      return;
                    }
                    // Handle docId-only evidence links (no anchor/kbId)
                    const docEl = target.closest<HTMLElement>('[data-evidence-doc]:not([data-evidence-anchor])');
                    if (docEl) {
                      e.preventDefault();
                      const docId = docEl.dataset.evidenceDoc!;
                      const kbId = resolveKbId(docEl.dataset.evidenceKb);
                      if (kbId) {
                        useEvidencePreviewStore.getState().openDocumentPreview(kbId, docId);
                      }
                      return;
                    }
                    // Handle clicks on document reference links
                    const docRef = target.closest<HTMLElement>('[data-doc-id]');
                    if (docRef && currentKbId) {
                      useEvidencePreviewStore.getState().openDocumentPreview(currentKbId, docRef.dataset.docId!);
                      return;
                    }
                    // Handle simple doc name references (no docId, just navigate to KB)
                    const namedRef = target.closest<HTMLElement>('[data-doc-ref]');
                    if (namedRef && currentKbId) {
                      navigateToDoc(currentKbId, "");
                    }
                  }}
                  onMouseOver={(e) => {
                    const target = e.target as HTMLElement;
                    const docRef = target.closest<HTMLElement>('[data-doc-id]');
                    if (docRef) {
                      const rect = docRef.getBoundingClientRect();
                      setHoveredRef({
                        id: docRef.dataset.docId || "",
                        name: docRef.textContent || "",
                        rect,
                      });
                    } else {
                      const namedRef = target.closest<HTMLElement>('[data-doc-ref]');
                      if (namedRef) {
                        const rect = namedRef.getBoundingClientRect();
                        setHoveredRef({
                          id: "",
                          name: namedRef.textContent || "",
                          rect,
                        });
                      }
                    }
                  }}
                  onMouseOut={(e) => {
                    const target = e.target as HTMLElement;
                    const docRef = target.closest<HTMLElement>('[data-doc-id],[data-doc-ref]');
                    if (!docRef) {
                      setHoveredRef(null);
                    }
                  }}
                />
                {/* Hover preview popover for document references */}
                {hoveredRef && (
                  <div
                    style={{
                      position: "fixed",
                      left: hoveredRef.rect.left,
                      top: hoveredRef.rect.bottom + 4,
                      minWidth: 200,
                      maxWidth: 320,
                      padding: "8px 12px",
                      background: "var(--surface-primary)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-md)",
                      boxShadow: "var(--shadow-lg)",
                      zIndex: 9999,
                      fontSize: "var(--text-xs)",
                      color: "var(--text-primary)",
                      pointerEvents: "none",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {hoveredRef.name || hoveredRef.id}
                    </div>
                    <div style={{ color: "var(--text-tertiary)" }}>
                      {hoveredRef.id ? `文档 ID: ${hoveredRef.id.substring(0, 8)}...` : "文档引用"}
                    </div>
                  </div>
                )}
                {/* Traceability links extracted from content */}
                {message.content && (
                  <TraceabilityExtractor content={message.content} />
                )}
              </div>
            ) : null}

            {/* Streaming placeholder */}
            {!message.content && message.isStreaming && (
              <div
                style={{
                  background: "var(--surface-primary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "4px 18px 18px 18px",
                  padding: "var(--space-3) var(--space-4)",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    alignItems: "center",
                  }}
                >
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--text-tertiary)",
                        animation: "typing 1.2s ease-in-out infinite",
                        animationDelay: `${i * 0.2}s`,
                      }}
                    />
                  ))}
                </div>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--text-tertiary)" }}>
                  思考中...
                </span>
              </div>
            )}

            {/* AI message action bar */}
            {message.content && !message.isStreaming && (
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-1)",
                }}
              >
                <ActionIcon icon={<Copy size={13} />} title="复制" onClick={handleCopy} />
                <ActionIcon icon={<RefreshCw size={13} />} title="重新生成" onClick={() => useChatStore.getState().regenerateMessage(message.id)} />
                <ActionIcon icon={<FileDown size={13} />} title="导出报告" onClick={async () => {
                  try {
                    const reportId = message.report?.id;
                    if (reportId) {
                      window.open(`/api/reports/reports/${reportId}/export`, '_blank');
                    } else {
                      const blob = new Blob([message.content], { type: 'text/markdown' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `report-${Date.now()}.md`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }
                    success("报告已导出");
                  } catch {
                    toastError("导出失败");
                  }
                }} />
              </div>
            )}
          </div>
        )}

        {/* Timestamp */}
        <div
          style={{
            fontSize: 10,
            color: "var(--text-tertiary)",
            marginTop: 4,
          }}
        >
          {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}

function ActionIcon({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: "var(--radius-md)",
        background: "transparent",
        color: "var(--text-tertiary)",
        cursor: "pointer",
        transition: "all var(--transition-fast)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-tertiary)";
        e.currentTarget.style.color = "var(--text-secondary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      {icon}
    </button>
  );
}

function TraceabilityExtractor({ content }: { content: string }) {
  const navigateToDoc = useUIStore((s) => s.navigateToDoc);
  const currentKbId = useUIStore((s) => s.currentKbId);

  // Match patterns like [📄 第3.2条→] or [📄 来源→]
  const pattern = /\[📄\s*(.+?)→\]/g;
  const matches: { full: string; label: string }[] = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    matches.push({ full: match[0], label: match[1] });
  }
  if (matches.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)", marginTop: "var(--space-1)" }}>
      {matches.map((m) => (
        <span key={m.label} onClick={() => { if (currentKbId) navigateToDoc(currentKbId, ""); }} style={{ cursor: "pointer" }}>
          <TraceabilityLink label={m.label} confidence="confirmed" />
        </span>
      ))}
    </div>
  );
}
