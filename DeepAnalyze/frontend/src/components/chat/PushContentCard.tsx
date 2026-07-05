// =============================================================================
// DeepAnalyze - PushContentCard
// Renders structured content pushed by the Agent via push_content tool
// =============================================================================

import { useState, useMemo, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, ChevronRight, Copy, Table, FileText, Code, File, FileDown, BarChart3, Image as ImageIcon, Music, Video, Download } from "lucide-react";
import DOMPurify from "dompurify";
import type { PushedContent } from "../../types/index";
import { ChartRenderer } from "../ui/ChartRenderer";
import { renderMarkdown, purifyConfig } from "../../hooks/useMarkdown";
import { useEvidencePreviewStore } from "../../store/evidencePreview";
import { useUIStore } from "../../store/ui";
import { useChatStore } from "../../store/chat";

const TYPE_ICONS: Record<string, typeof Table> = {
  table: Table,
  text: FileText,
  code: Code,
  file: File,
  markdown: FileText,
  chart: BarChart3,
  image: ImageIcon,
  audio: Music,
  video: Video,
};

const TYPE_COLORS: Record<string, string> = {
  table: "var(--interactive)",
  text: "var(--text-secondary)",
  code: "var(--success)",
  file: "var(--warning)",
  markdown: "var(--text-secondary)",
  chart: "var(--interactive)",
  image: "var(--interactive)",
  audio: "var(--interactive)",
  video: "var(--interactive)",
};

/** Escape a string for safe embedding in an HTML attribute value. */
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  // Pattern 7: Bare bracket [da-evidence://kbId/docId] or [da-evidence://kbId/docId?anchor=anchorId]
  // (report generates this format instead of proper markdown [text](url) links)
  result = result.replace(
    /\[da-evidence:\/\/([^/\]]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?anchor=([^\]]+))?\]/gi,
    (_match, kbId: string, docId: string, anchorId?: string) => {
      const anchorAttr = anchorId ? ` data-evidence-anchor="${escapeHtmlAttr(anchorId)}"` : "";
      return `<sup><a href="#" class="evidence-link" data-evidence-kb="${escapeHtmlAttr(kbId)}" data-evidence-doc="${escapeHtmlAttr(docId)}"${anchorAttr}>📎</a></sup>`;
    },
  );
  // Pattern 9: kb:// protocol [text](kb://docId) — LLM sometimes generates this instead of da-evidence://
  // Convert to evidence-link with data-evidence-doc only (kbId resolved at click time from session scope)
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

/** Resolve kbId from session's kbScope when link doesn't include one. */
function resolveKbId(linkKbId: string | undefined): string | undefined {
  if (linkKbId) return linkKbId;
  // Fallback 1: UI store's currentKbId
  const uiKbId = useUIStore.getState().currentKbId;
  if (uiKbId) return uiKbId;
  // Fallback 2: session kbScope
  const { currentSessionId, sessions } = useChatStore.getState();
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
}

// Extended purify config that allows evidence link data attributes
const evidencePurifyConfig = {
  ...purifyConfig,
  ALLOWED_ATTR: [
    ...(purifyConfig as { ALLOWED_ATTR: string[] }).ALLOWED_ATTR,
    "data-evidence-kb", "data-evidence-doc", "data-evidence-anchor",
  ],
};

export function PushContentCard({ item }: { item: PushedContent }) {
  // Guard: data may be undefined for file pushes (push_file tool sends no inline data)
  const itemData = item.data || "";
  // Detect markdown content: explicitly typed as markdown, or file/text type
  // that contains markdown formatting (headings, tables, bold, etc.)
  const looksLikeMarkdown = item.type === "markdown" ||
    ((item.type === "file" || item.type === "text") &&
     itemData.length > 50 &&
     /^#{1,6}\s|\*\*|^\|.*\|$/m.test(itemData.slice(0, 2000)));
  const isMarkdown = looksLikeMarkdown;
  const dataLen = itemData.length;
  const isLargeContent = dataLen >= 50_000; // 50K+ chars = large
  const isLongMarkdown = isMarkdown && dataLen >= 2000;
  // Markdown content >= 500 chars gets collapse controls (top chevron + bottom button).
  // Using a single threshold ensures both controls appear together — previously the
  // top chevron required 2000+ chars but the bottom button only required 500+,
  // causing cards to be collapsible but not re-expandable for 500-1999 char content.
  const isCollapsibleMarkdown = isMarkdown && dataLen >= 500;
  const [expanded, setExpanded] = useState(isLargeContent ? false : (isMarkdown ? !isLongMarkdown : dataLen < 2000));
  const [copied, setCopied] = useState(false);
  const [renderingLarge, setRenderingLarge] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Collapse with scroll position preservation — keeps the card's bottom edge
  // at the same screen position so content below doesn't jump.
  const handleCollapse = useCallback(() => {
    const card = cardRef.current;
    if (!card) {
      setExpanded(false);
      return;
    }
    // Record the card's bottom edge position before collapse
    const oldBottom = card.getBoundingClientRect().bottom;

    // Force synchronous DOM update so we can measure immediately
    flushSync(() => {
      setExpanded(false);
    });

    // Measure new bottom edge position after DOM update
    const newBottom = card.getBoundingClientRect().bottom;
    const delta = oldBottom - newBottom;

    if (delta > 0) {
      // The card's bottom edge moved up by `delta` pixels.
      // Scroll up by the same amount to keep the bottom edge at its original position.
      let parent = card.parentElement;
      while (parent) {
        if (parent.scrollHeight > parent.clientHeight) {
          parent.scrollTop -= delta;
          break;
        }
        parent = parent.parentElement;
      }
    }
  }, []);

  const Icon = TYPE_ICONS[item.type] || FileText;
  const color = TYPE_COLORS[item.type] || "var(--text-secondary)";

  // For large markdown content, only render when expanded (lazy rendering)
  // to avoid freezing the browser with marked() + DOMPurify on 2MB strings
  const markdownHtml = useMemo(() => {
    if (!isMarkdown) return "";
    if (isLargeContent && !expanded) return ""; // Don't render until expanded
    try {
      // For very large content, render in chunks to avoid blocking
      if (dataLen > 200_000) {
        // Show first 200K chars rendered, rest as raw text
        const headRaw = renderMarkdown(itemData.slice(0, 200_000));
        const head = DOMPurify.sanitize(processEvidenceLinks(headRaw), evidencePurifyConfig);
        const tail = DOMPurify.sanitize(itemData.slice(200_000), evidencePurifyConfig);
        return head + "\n<pre style='white-space:pre-wrap'>" + tail + "</pre>";
      }
      // Normal path: renderMarkdown first (preserves da-evidence:// href via ALLOWED_URI_REGEXP),
      // then processEvidenceLinks transforms <a href="da-evidence://"> to <a href="#" data-evidence-*>,
      // then final sanitize with evidencePurifyConfig preserves data-evidence-* attributes.
      const rendered = renderMarkdown(itemData);
      return DOMPurify.sanitize(processEvidenceLinks(rendered), evidencePurifyConfig);
    } catch {
      return DOMPurify.sanitize(processEvidenceLinks(itemData.slice(0, 100_000)), evidencePurifyConfig);
    }
  }, [isMarkdown, itemData, expanded, isLargeContent, dataLen]);

  const handleExpandLarge = () => {
    if (isLargeContent && !expanded) {
      setRenderingLarge(true);
      // Use requestAnimationFrame to show loading state before heavy rendering
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setExpanded(true);
          setRenderingLarge(false);
        });
      });
    } else {
      setExpanded(!expanded);
    }
  };

  const handleDownload = () => {
    // If we have a server-side download URL, use it directly
    if (item.downloadUrl) {
      const a = document.createElement("a");
      a.href = item.downloadUrl;
      a.download = item.fileName || `${item.title || "file"}`;
      a.click();
      return;
    }
    // Determine file extension and MIME type based on content type
    const extMap: Record<string, [string, string]> = {
      markdown: [".md", "text/markdown"],
      table: [".csv", "text/csv"],
      code: [".txt", "text/plain"],
      text: [".txt", "text/plain"],
      chart: [".json", "application/json"],
      image: [".png", "image/png"],
      audio: [".mp3", "audio/mpeg"],
      video: [".mp4", "video/mp4"],
    };
    const [ext, mime] = extMap[item.type] || [".txt", "text/plain"];
    const blob = new Blob([itemData], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.title || "content"}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(itemData);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderContent = () => {
    // File push with download URL — render as inline media or file card
    if (item.downloadUrl) {
      const mime = item.mimeType || "";
      const isImage = mime.startsWith("image/");
      const isAudio = mime.startsWith("audio/");
      const isVideo = mime.startsWith("video/");
      const isPdf = mime === "application/pdf";

      // Inline media preview
      if (isImage) {
        return (
          <div style={{ padding: "var(--space-2)", textAlign: "center" }}>
            <img
              src={item.downloadUrl}
              alt={item.title}
              loading="lazy"
              style={{
                maxWidth: "100%",
                maxHeight: 500,
                borderRadius: "var(--radius-md)",
                objectFit: "contain",
              }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
                const parent = (e.target as HTMLImageElement).parentElement;
                if (parent) {
                  parent.innerHTML = `<p style="color: var(--error); font-size: var(--text-sm);">图片加载失败</p>`;
                }
              }}
            />
          </div>
        );
      }

      if (isAudio) {
        return (
          <div style={{ padding: "var(--space-3)" }}>
            <audio controls src={item.downloadUrl} style={{ width: "100%" }}>
              您的浏览器不支持音频播放。
            </audio>
          </div>
        );
      }

      if (isVideo) {
        return (
          <div style={{ padding: "var(--space-2)", textAlign: "center" }}>
            <video controls src={item.downloadUrl} style={{ maxWidth: "100%", maxHeight: 400, borderRadius: "var(--radius-md)" }}>
              您的浏览器不支持视频播放。
            </video>
          </div>
        );
      }

      if (isPdf) {
        return (
          <div style={{ padding: "var(--space-2)" }}>
            <iframe
              src={item.downloadUrl}
              style={{ width: "100%", height: 500, border: "none", borderRadius: "var(--radius-md)" }}
              title={item.title}
            />
          </div>
        );
      }

      // Non-media file: render as downloadable file card
      const fileSizeStr = item.fileSize
        ? item.fileSize >= 1_000_000
          ? `${(item.fileSize / 1_000_000).toFixed(1)} MB`
          : `${(item.fileSize / 1_000).toFixed(1)} KB`
        : "";

      const ext = item.fileName?.includes(".") ? item.fileName.split(".").pop()!.toUpperCase() : "FILE";

      return (
        <a
          href={item.downloadUrl}
          download={item.fileName || item.title}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "var(--space-3) var(--space-4)",
            textDecoration: "none",
            color: "var(--text-primary)",
            cursor: "pointer",
            transition: "background-color 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-tertiary)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: "var(--radius-md)",
            backgroundColor: "var(--bg-tertiary)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <FileDown size={20} style={{ color: "var(--interactive)" }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {item.fileName || item.title}
            </div>
            <div style={{
              fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 2,
              display: "flex", gap: "var(--space-2)", alignItems: "center",
            }}>
              <span style={{
                padding: "1px 6px", backgroundColor: "var(--bg-tertiary)",
                borderRadius: "var(--radius-sm)", fontWeight: "var(--font-medium)",
              }}>
                {ext}
              </span>
              {fileSizeStr && <span>{fileSizeStr}</span>}
            </div>
          </div>
          <Download size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        </a>
      );
    }

    // Markdown: render as rich HTML with collapse support for long content
    if (isMarkdown) {
      if (!expanded) {
        // Collapsed: show preview based on content size
        const previewLen = isLargeContent ? 300 : 500;
        return (
          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-relaxed)",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
            onClick={handleExpandLarge}
          >
            {renderingLarge ? (
              <span style={{ color: "var(--interactive)" }}>正在渲染大量内容...</span>
            ) : (
              <>
                {itemData.slice(0, previewLen)}...
                <span style={{ color: "var(--interactive)", marginLeft: 4 }}>
                  {isLargeContent ? `展开查看完整内容 (${Math.round(dataLen / 1000)}K 字符)` : "展开查看完整内容"}
                </span>
              </>
            )}
          </div>
        );
      }
      return (
        <div
          className="markdown-content"
          style={{
            padding: "var(--space-3) var(--space-4)",
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-relaxed)",
          }}
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            const evidenceEl = target.closest<HTMLElement>('[data-evidence-anchor]');
            if (evidenceEl) {
              e.preventDefault();
              const { evidenceKb, evidenceDoc, evidenceAnchor } = evidenceEl.dataset;
              useEvidencePreviewStore.getState().openPreview(evidenceAnchor!, evidenceKb!, evidenceDoc!);
              return;
            }
            // Handle docId-only links (no anchor/kbId)
            const docEl = target.closest<HTMLElement>('[data-evidence-doc]:not([data-evidence-anchor])');
            if (docEl) {
              e.preventDefault();
              const docId = docEl.dataset.evidenceDoc!;
              const kbId = resolveKbId(docEl.dataset.evidenceKb);
              if (kbId) {
                useEvidencePreviewStore.getState().openDocumentPreview(kbId, docId);
              }
            }
          }}
        />
      );
    }

    if (item.type === "table") {
      try {
        const lines = itemData.split("\n").filter(Boolean);
        if (lines.length > 0) {
          const headers = lines[0].split(itemData.includes("\t") ? "\t" : ",");
          const rows = lines.slice(1, expanded ? undefined : 20).map((line) =>
            line.split(itemData.includes("\t") ? "\t" : ",")
          );

          return (
            <div style={{ overflowX: "auto" }}>
              <table style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--text-xs)",
              }}>
                <thead>
                  <tr>
                    {headers.map((h, i) => (
                      <th key={i} style={{
                        padding: "4px 8px",
                        borderBottom: "2px solid var(--border-primary)",
                        textAlign: "left",
                        fontWeight: "var(--font-semibold)",
                        color: "var(--text-primary)",
                        whiteSpace: "nowrap",
                      }}>
                        {h.trim()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri}>
                      {headers.map((_, ci) => (
                        <td key={ci} style={{
                          padding: "3px 8px",
                          borderBottom: "1px solid var(--border-secondary)",
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                          maxWidth: 300,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}>
                          {(row[ci] || "").trim()}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!expanded && lines.length > 20 && (
                <div style={{ padding: "var(--space-2)", textAlign: "center" }}>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                    显示前 20 行（共 {lines.length - 1} 行）
                  </span>
                </div>
              )}
            </div>
          );
        }
      } catch {
        // Fall through to code display
      }
    }

    if (item.type === "code") {
      return (
        <pre style={{
          margin: 0,
          padding: "var(--space-3)",
          backgroundColor: "var(--bg-tertiary)",
          borderRadius: "var(--radius-sm)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.5,
          overflowX: "auto",
          maxHeight: expanded ? undefined : 300,
          overflow: expanded ? undefined : "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          <code>
            {expanded ? itemData : itemData.slice(0, 5000)}
            {!expanded && itemData.length > 5000 && "\n... (点击展开查看全部)"}
          </code>
        </pre>
      );
    }

    // Chart: render ECharts
    if (item.type === "chart") {
      return (
        <div style={{ padding: "var(--space-2)" }}>
          <ChartRenderer option={itemData} height={350} />
        </div>
      );
    }

    // Image: render <img> tag
    if (item.type === "image") {
      return (
        <div style={{ padding: "var(--space-2)", textAlign: "center" }}>
          <img
            src={itemData}
            alt={item.title}
            loading="lazy"
            style={{
              maxWidth: "100%",
              maxHeight: 500,
              borderRadius: "var(--radius-md)",
              objectFit: "contain",
            }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
              const parent = (e.target as HTMLImageElement).parentElement;
              if (parent) {
                parent.innerHTML = `<p style="color: var(--error); font-size: var(--text-sm);">图片加载失败: ${itemData}</p>`;
              }
            }}
          />
        </div>
      );
    }

    // Audio: render <audio> tag
    if (item.type === "audio") {
      return (
        <div style={{ padding: "var(--space-3)" }}>
          <audio
            controls
            src={itemData}
            style={{ width: "100%" }}
          >
            您的浏览器不支持音频播放。
          </audio>
        </div>
      );
    }

    // Video: render <video> tag
    if (item.type === "video") {
      return (
        <div style={{ padding: "var(--space-2)", textAlign: "center" }}>
          <video
            controls
            src={itemData}
            style={{
              maxWidth: "100%",
              maxHeight: 400,
              borderRadius: "var(--radius-md)",
            }}
          >
            您的浏览器不支持视频播放。
          </video>
        </div>
      );
    }

    // text / file
    return (
      <div style={{
        padding: "var(--space-3)",
        fontSize: "var(--text-sm)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: expanded ? undefined : 300,
        overflow: expanded ? undefined : "auto",
        lineHeight: "var(--leading-relaxed)",
      }}>
        {expanded ? itemData : itemData.slice(0, 5000)}
        {!expanded && itemData.length > 5000 && "... (点击展开查看全部)"}
      </div>
    );
  };

  // Markdown type: render as a result card with collapse toggle for long content
  if (isMarkdown) {
    return (
      <div ref={cardRef} data-testid="push-content-card" style={{
        border: "1px solid #3b82f6",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        marginTop: 4,
        background: "var(--surface-primary)",
      }}>
        {/* Compact header with title and optional collapse toggle */}
        <div
          onClick={isCollapsibleMarkdown ? () => {
            if (!expanded && isLargeContent) {
              handleExpandLarge();
            } else {
              setExpanded(!expanded);
            }
          } : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-1) var(--space-3)",
            backgroundColor: "var(--bg-secondary)",
            borderBottom: "1px solid #3b82f6",
            cursor: isCollapsibleMarkdown ? "pointer" : undefined,
            userSelect: isCollapsibleMarkdown ? "none" : undefined,
          }}
        >
          {isCollapsibleMarkdown && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
          <Icon size={13} style={{ color, flexShrink: 0 }} />
          <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--font-medium)", color: "var(--text-secondary)", flex: 1 }}>
            {item.title}
          </span>
          {isLargeContent && (
            <span style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
            }}>
              {dataLen >= 1_000_000
                ? `${(dataLen / 1_000_000).toFixed(1)}M 字符`
                : `${Math.round(dataLen / 1000)}K 字符`}
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleDownload(); }}
            title="下载文件"
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: 2,
              color: "var(--text-tertiary)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <FileDown size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
            title="复制内容"
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: 2,
              color: copied ? "var(--success)" : "var(--text-tertiary)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Copy size={12} />
          </button>
        </div>
        {/* Markdown content (collapsed or expanded) */}
        {renderContent()}
        {/* Bottom collapse button for expanded content */}
        {expanded && isCollapsibleMarkdown && (
          <div
            onClick={handleCollapse}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "var(--space-1)",
              padding: "var(--space-1) var(--space-3)",
              backgroundColor: "var(--bg-secondary)",
              borderTop: "1px solid var(--border-primary)",
              cursor: "pointer",
              userSelect: "none",
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
            }}
          >
            <ChevronDown size={12} />
            收起内容
          </div>
        )}
      </div>
    );
  }

  // Non-markdown types: collapsible card
  return (
    <div ref={cardRef} data-testid="push-content-card" style={{
      border: "1px solid #3b82f6",
      borderRadius: "var(--radius-md)",
      overflow: "hidden",
      marginTop: 4,
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          backgroundColor: "var(--bg-secondary)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Icon size={14} style={{ color, flexShrink: 0 }} />
        <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-medium)", color: "var(--text-primary)", flex: 1 }}>
          {item.title}
        </span>
        {item.format && (
          <span style={{
            fontSize: "var(--text-xs)",
            color: "var(--text-tertiary)",
            padding: "1px 6px",
            backgroundColor: "var(--bg-tertiary)",
            borderRadius: "var(--radius-sm)",
          }}>
            {item.format}
          </span>
        )}
        {item.downloadUrl && item.fileSize != null && item.fileSize > 0 && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            {item.fileSize >= 1_000_000
              ? `${(item.fileSize / 1_000_000).toFixed(1)} MB`
              : `${(item.fileSize / 1_000).toFixed(1)} KB`}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); handleDownload(); }}
          title="下载文件"
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            padding: 2,
            color: "var(--text-tertiary)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <FileDown size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleCopy(); }}
          title="复制内容"
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            padding: 2,
            color: copied ? "var(--success)" : "var(--text-tertiary)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Copy size={12} />
        </button>
      </div>

      {/* Content */}
      {expanded && renderContent()}
    </div>
  );
}
