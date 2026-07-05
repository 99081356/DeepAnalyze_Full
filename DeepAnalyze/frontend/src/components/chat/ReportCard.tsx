import { useState, useMemo, useCallback, useRef } from "react";
import { Copy, ChevronDown, ChevronUp, FileText, ExternalLink } from "lucide-react";
import { useMarkdown } from "../../hooks/useMarkdown";
import { ReferenceMarker } from "./ReferenceMarker";
import { EntityLink } from "./EntityLink";
import { useToast } from "../../hooks/useToast";
import { useUIStore } from "../../store/ui";
import type { ChatReportData, ChatReference, ChatEntity } from "../../types/index";

interface ReportCardProps {
  report: ChatReportData;
  agentSummary?: string;
}

const COLLAPSE_THRESHOLD = 500;

/**
 * Process report content to extract and replace [n] reference markers
 * and {{entity:Name}} entity links with React-rendered components.
 * Returns an array of { text, reference?, entity? } segments.
 */
function parseContentSegments(
  content: string,
  references: ChatReference[],
  entities: ChatEntity[],
  onOpenSource?: (docId: string) => void,
  onViewAllEntity?: (name: string) => void,
): React.ReactNode[] {
  // Build lookup maps
  const refMap = new Map(references.map((r) => [r.index, r]));
  const entityMap = new Map(entities.map((e) => [e.name.toLowerCase(), e]));

  // Combined regex: match [n] reference markers or {{entity:Name}} entity links
  const combinedPattern = /\[(\d+)\]|\{\{entity:([^}]+)\}\}/g;

  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = combinedPattern.exec(content)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      segments.push(
        <span key={`text-${keyIdx++}`}>{content.slice(lastIndex, match.index)}</span>,
      );
    }

    if (match[1] !== undefined) {
      // Reference marker [n]
      const refIndex = parseInt(match[1], 10);
      const ref = refMap.get(refIndex);
      if (ref) {
        segments.push(
          <ReferenceMarker
            key={`ref-${refIndex}-${keyIdx++}`}
            reference={ref}
            onOpenSource={onOpenSource}
          />,
        );
      } else {
        segments.push(
          <span key={`ref-unknown-${keyIdx++}`} style={{ color: "var(--interactive)", fontSize: 10 }}>
            [{refIndex}]
          </span>,
        );
      }
    } else if (match[2] !== undefined) {
      // Entity link {{entity:Name}}
      const entityName = match[2];
      const entity = entityMap.get(entityName.toLowerCase());
      if (entity) {
        segments.push(
          <EntityLink
            key={`entity-${entityName}-${keyIdx++}`}
            entity={entity}
            onViewAll={onViewAllEntity}
          />,
        );
      } else {
        // Fallback: render as styled text with dashed underline
        segments.push(
          <span
            key={`entity-unknown-${keyIdx++}`}
            style={{
              color: "var(--interactive)",
              borderBottom: "1px dashed var(--interactive)",
              cursor: "pointer",
            }}
          >
            {entityName}
          </span>,
        );
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match
  if (lastIndex < content.length) {
    segments.push(
      <span key={`text-final-${keyIdx++}`}>{content.slice(lastIndex)}</span>,
    );
  }

  return segments;
}

export function ReportCard({ report, agentSummary }: ReportCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [headerHovered, setHeaderHovered] = useState(false);
  const { success } = useToast();
  const navigateToDoc = useUIStore((s) => s.navigateToDoc);
  const currentKbId = useUIStore((s) => s.currentKbId);
  const cardRef = useRef<HTMLDivElement>(null);

  const isLong = report.content.length > COLLAPSE_THRESHOLD;
  const displayContent = expanded || !isLong ? report.content : report.content.slice(0, COLLAPSE_THRESHOLD);

  // Parse references and entities from the report
  const references = report.references ?? [];
  const entities = report.entities ?? [];

  // Render the content as markdown via useMarkdown, but we also need
  // to handle inline [n] references and {{entity:Name}} links.
  // We use a hybrid approach: render the plain text segments through markdown,
  // and inject React components for references and entities.
  const rawHtml = useMarkdown(displayContent);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(report.content).then(() => {
      setCopied(true);
      success("报告内容已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    });
  }, [report.content, success]);

  const handleOpenSource = useCallback((docId: string) => {
    if (currentKbId) {
      navigateToDoc(currentKbId, docId);
    }
  }, [currentKbId, navigateToDoc]);

  const handleViewAllEntity = useCallback((_entityName: string) => {
    // Navigate to knowledge panel with entity search
    // For now, just navigate to the knowledge base
    if (currentKbId) {
      window.location.hash = `#/knowledge/${currentKbId}`;
    }
  }, [currentKbId]);

  // Parse content segments for references and entities
  const contentSegments = useMemo(
    () => parseContentSegments(displayContent, references, entities, handleOpenSource, handleViewAllEntity),
    [displayContent, references, entities, handleOpenSource, handleViewAllEntity],
  );

  const formattedDate = new Date(report.createdAt).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      ref={cardRef}
      style={{
        width: "100%",
        maxWidth: 560,
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border-primary)",
        overflow: "hidden",
        boxShadow: "var(--shadow-sm)",
        animation: "fadeIn 0.3s ease-out",
      }}
    >
      {/* Gradient blue header */}
      <div
        style={{
          background: headerHovered
            ? "linear-gradient(135deg, #2563eb, #0891b2)"
            : "linear-gradient(135deg, #3b82f6, #06b6d4)",
          padding: "var(--space-3) var(--space-4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          transition: "background var(--transition-fast)",
          cursor: "default",
        }}
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0, flex: 1 }}>
          <FileText size={16} color="#fff" style={{ flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: "var(--text-sm)",
                fontWeight: 700,
                color: "#fff",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {report.title}
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 2 }}>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }}>
                {formattedDate}
              </span>
              {references.length > 0 && (
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }}>
                  {references.length} 条引用
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          title={copied ? "已复制" : "复制报告"}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            border: "none",
            borderRadius: "var(--radius-md)",
            background: "rgba(255,255,255,0.15)",
            color: "#fff",
            cursor: "pointer",
            transition: "background var(--transition-fast)",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.25)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.15)";
          }}
        >
          <Copy size={13} />
        </button>
      </div>

      {/* Body with reference markers and entity links */}
      <div
        style={{
          padding: "var(--space-3) var(--space-4)",
          background: "var(--surface-primary)",
          fontSize: "var(--text-sm)",
          lineHeight: "var(--leading-relaxed)",
          color: "var(--text-primary)",
        }}
      >
        {/* Render content with inline reference markers and entity links */}
        <div className="markdown-content">
          {contentSegments.length > 0 ? (
            // If we have reference/entity segments, render as plain text with components
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {contentSegments}
            </div>
          ) : (
            // Fallback to standard markdown rendering
            <div dangerouslySetInnerHTML={{ __html: rawHtml }} />
          )}
        </div>

        {/* Collapsed indicator */}
        {isLong && !expanded && (
          <div
            style={{
              marginTop: "var(--space-2)",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
            }}
          >
            ...
          </div>
        )}
      </div>

      {/* Optional agent summary */}
      {agentSummary && (
        <div
          style={{
            padding: "var(--space-2) var(--space-4)",
            background: "color-mix(in srgb, var(--interactive) 4%, var(--surface-secondary))",
            borderTop: "1px solid var(--border-primary)",
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
            lineHeight: "var(--leading-relaxed)",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--interactive)", marginRight: "var(--space-1)" }}>
            Agent 摘要:
          </span>
          {agentSummary}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          padding: "var(--space-2) var(--space-4)",
          background: "var(--surface-secondary)",
          borderTop: "1px solid var(--border-primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {/* Reference count */}
          {references.length > 0 && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              {references.length} 条引用
            </span>
          )}
          {/* Entity count */}
          {entities.length > 0 && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              {entities.length} 个实体
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {/* Expand/collapse button */}
          {isLong && (
            <button
              onClick={() => setExpanded((prev) => !prev)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                border: "none",
                background: "transparent",
                color: "var(--interactive)",
                fontSize: "var(--text-xs)",
                fontWeight: 500,
                cursor: "pointer",
                padding: 0,
                transition: "opacity var(--transition-fast)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "0.8";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
            >
              {expanded ? (
                <>
                  <ChevronUp size={12} />
                  收起报告
                </>
              ) : (
                <>
                  <ChevronDown size={12} />
                  展开完整报告
                </>
              )}
            </button>
          )}

          {/* View full report link */}
          <button
            onClick={() => {
              if (currentKbId) {
                window.location.hash = `#/reports`;
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              border: "none",
              background: "transparent",
              color: "var(--interactive)",
              fontSize: "var(--text-xs)",
              fontWeight: 500,
              cursor: "pointer",
              padding: 0,
              transition: "opacity var(--transition-fast)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "0.8";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
          >
            <ExternalLink size={10} />
            查看完整报告
          </button>
        </div>
      </div>
    </div>
  );
}
