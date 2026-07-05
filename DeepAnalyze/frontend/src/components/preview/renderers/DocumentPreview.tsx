import { useEffect, useRef } from "react";
import { useMarkdown } from "../../../hooks/useMarkdown";

interface DocumentPreviewProps {
  sectionContent?: string;
  sectionTitle?: string;
  highlightText?: string;
  /** Line number in the Markdown source to scroll to (0-based). */
  lineStart?: number | null;
}

export function DocumentPreview({ sectionContent, sectionTitle, highlightText, lineStart }: DocumentPreviewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const html = useMarkdown(sectionContent || "");

  useEffect(() => {
    if (!contentRef.current || !sectionContent) return;

    // Strategy 1: If we have lineStart, approximate scroll by calculating
    // the proportional position in the content.
    if (lineStart != null && lineStart >= 0) {
      const lines = sectionContent.split("\n");
      // Estimate scroll position proportionally
      const proportion = lines.length > 0 ? lineStart / lines.length : 0;
      const el = contentRef.current;
      const targetScroll = proportion * el.scrollHeight;
      // Only scroll if the target is not already near the top
      if (targetScroll > 50) {
        el.scrollTop = targetScroll - el.clientHeight * 0.3;
      }
    }

    // Strategy 2: Highlight matching text (existing logic)
    if (highlightText) {
      const walker = document.createTreeWalker(
        contentRef.current,
        NodeFilter.SHOW_TEXT,
      );
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.indexOf(highlightText);
        if (idx !== undefined && idx !== -1 && node.parentElement) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + highlightText.length);
          const mark = document.createElement("mark");
          mark.style.backgroundColor = "rgba(59, 130, 246, 0.3)";
          mark.style.borderRadius = "2px";
          mark.style.padding = "0 1px";
          range.surroundContents(mark);
          // Scroll into view (overrides proportional scroll with precise position)
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
          break;
        }
      }
    }
  }, [html, highlightText, lineStart, sectionContent]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {sectionTitle && (
        <h4 style={{
          fontSize: "var(--text-sm)",
          fontWeight: "var(--font-semibold)",
          color: "var(--text-primary)",
          margin: 0,
          padding: "var(--space-2) var(--space-3)",
          borderBottom: "1px solid var(--border-primary)",
        }}>
          {sectionTitle}
        </h4>
      )}
      <div
        ref={contentRef}
        className="markdown-content"
        style={{
          fontSize: "var(--text-sm)",
          lineHeight: "var(--leading-relaxed)",
          padding: "var(--space-3)",
          maxHeight: 500,
          overflow: "auto",
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
