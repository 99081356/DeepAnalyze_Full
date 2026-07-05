// =============================================================================
// DeepAnalyze - VirtualizedContent
// Virtual scrolling component for rendering large text content efficiently.
// Only renders lines visible in the viewport plus a buffer zone.
// =============================================================================

import { useState, useRef, useCallback, useEffect, useMemo } from "react";

const LINE_HEIGHT = 20; // Approximate line height in pixels for pre-wrap text
const BUFFER_LINES = 30; // Extra lines to render above/below viewport
const VIRTUALIZE_THRESHOLD = 3000; // Only virtualize content exceeding this many lines

export interface VirtualizedContentProps {
  /** The text content to display. */
  content: string;
  /** Maximum height of the container in pixels. */
  maxHeight?: number;
  /** Whether to render as markdown (uses dangerouslySetInnerHTML). */
  markdown?: boolean;
  /** Markdown HTML string (pre-rendered). If provided, skips markdown rendering. */
  markdownHtml?: string;
  /** Font size for line height calculation. */
  fontSize?: number;
  /** Additional CSS styles for the container. */
  style?: React.CSSProperties;
}

export function VirtualizedContent({
  content,
  maxHeight = 400,
  markdown = false,
  markdownHtml,
  fontSize = 13,
  style,
}: VirtualizedContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(maxHeight);

  // Split content into lines
  const lines = useMemo(() => content.split("\n"), [content]);

  // Use the markdown HTML if provided, otherwise split into lines
  const shouldVirtualize = markdown
    ? (markdownHtml?.length ?? 0) > 50000
    : lines.length > VIRTUALIZE_THRESHOLD;

  const lineHeight = fontSize * 1.54; // Approximate: 13px * 1.54 ≈ 20px

  // Observe container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  // For markdown mode with very large HTML, use a simplified virtualization
  if (markdown && markdownHtml) {
    if (!shouldVirtualize) {
      return (
        <div
          style={{
            maxHeight,
            overflowY: "auto",
            fontSize,
            lineHeight: `${lineHeight}px`,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            ...style,
          }}
          className="markdown-content"
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      );
    }

    // For large markdown, render in chunks with a "load more" approach
    // Splitting HTML by tags is unreliable, so we use a progressive rendering
    const totalEstimatedLines = Math.ceil(markdownHtml.length / 80);
    const visibleLines = Math.ceil(containerHeight / lineHeight);
    const startLine = Math.max(0, Math.floor(scrollTop / lineHeight) - BUFFER_LINES);
    const endLine = Math.min(totalEstimatedLines, startLine + visibleLines + BUFFER_LINES * 2);

    // For markdown, we can't easily virtualize by line, so we use progressive loading
    // Show a truncated version with expand capability
    const CHARS_PER_VIEW = 100000; // ~100K chars at a time
    const charStart = Math.max(0, startLine * 80);
    const charEnd = Math.min(markdownHtml.length, charStart + CHARS_PER_VIEW);
    const visibleHtml = markdownHtml.slice(charStart, charEnd);

    return (
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          maxHeight,
          overflowY: "auto",
          position: "relative",
          ...style,
        }}
      >
        <div
          style={{ height: totalEstimatedLines * lineHeight }}
        >
          <div
            style={{
              position: "absolute",
              top: startLine * lineHeight,
              left: 0,
              right: 0,
            }}
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: visibleHtml }}
          />
        </div>
      </div>
    );
  }

  // Plain text mode
  if (!shouldVirtualize) {
    return (
      <div
        style={{
          maxHeight,
          overflowY: "auto",
          fontSize,
          lineHeight: `${lineHeight}px`,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          ...style,
        }}
      >
        {content}
      </div>
    );
  }

  // Virtual scrolling for large plain text
  const totalHeight = lines.length * lineHeight;
  const visibleCount = Math.ceil(containerHeight / lineHeight);
  const startIdx = Math.max(0, Math.floor(scrollTop / lineHeight) - BUFFER_LINES);
  const endIdx = Math.min(lines.length, startIdx + visibleCount + BUFFER_LINES * 2);
  const visibleLines = lines.slice(startIdx, endIdx);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        maxHeight,
        overflowY: "auto",
        position: "relative",
        fontSize,
        lineHeight: `${lineHeight}px`,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        ...style,
      }}
    >
      {/* Spacer for total height */}
      <div style={{ height: totalHeight, position: "relative" }}>
        {/* Offset to position visible lines correctly */}
        <div style={{ position: "absolute", top: startIdx * lineHeight, left: 0, right: 0 }}>
          {visibleLines.join("\n")}
        </div>
      </div>
    </div>
  );
}
