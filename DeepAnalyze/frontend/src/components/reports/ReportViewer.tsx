// =============================================================================
// DeepAnalyze - ReportViewer Component
// Enhanced single-report viewer with source tracing, anchor hover cards,
// grouped source panel, and collapsible agent process section.
// =============================================================================

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  FileText,
  Table,
  Image,
  Mic,
  Video,
  Download,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  Cpu,
  Clock,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { AnchorHoverCard } from "../preview/AnchorHoverCard";
import type { ReportDetail } from "../../types/index";
import { cn } from "../../utils/cn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReportViewerProps {
  /** ID of the report to display */
  reportId: string;
  /** Knowledge base ID the report belongs to */
  kbId: string;
}

interface SourceAnchor {
  /** Unique anchor identifier */
  anchorId: string;
  /** Section title within the source document */
  sectionTitle: string | null;
  /** Page number within the source document */
  pageNumber: number | null;
}

interface SourceDocument {
  /** Document ID */
  documentId: string;
  /** Original uploaded filename */
  fileName: string;
  /** Modality of the document */
  modality: "document" | "excel" | "image" | "audio" | "video";
  /** Knowledge base name */
  kbName: string;
  /** Anchors extracted from this document */
  anchors: SourceAnchor[];
}

interface SourceTrace {
  /** Overall confidence score from source tracing (0-1) */
  confidence: number;
  /** Agent type that generated the report */
  agentType: string;
}

// ---------------------------------------------------------------------------
// Modality icon mapping
// ---------------------------------------------------------------------------

const MODALITY_ICON_MAP: Record<
  string,
  React.FC<React.SVGProps<SVGSVGElement> & { size?: number | string }>
> = {
  document: FileText,
  excel: Table,
  image: Image,
  audio: Mic,
  video: Video,
};

// ---------------------------------------------------------------------------
// Confidence badge colour helper
// ---------------------------------------------------------------------------

function confidenceColor(score: number): string {
  if (score >= 0.8) return "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-900/30";
  if (score >= 0.5) return "text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-900/30";
  return "text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-900/30";
}

function confidenceLabel(score: number): string {
  if (score >= 0.8) return "High";
  if (score >= 0.5) return "Medium";
  return "Low";
}

// ---------------------------------------------------------------------------
// Agent type badge colour helper
// ---------------------------------------------------------------------------

function agentBadgeStyle(agentType: string): string {
  switch (agentType.toLowerCase()) {
    case "deep":
      return "bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300";
    case "quick":
      return "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300";
    case "research":
      return "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
    default:
      return "bg-gray-50 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  }
}

// ---------------------------------------------------------------------------
// Anchor pattern: [来源: ...](#anchor:ID)
// Captures group 1 = display text, group 2 = anchor ID
// ---------------------------------------------------------------------------

const ANCHOR_PATTERN = /\[来源:\s*([^\]]+)\]\(#anchor:([^)]+)\)/g;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ReportViewer: React.FC<ReportViewerProps> = ({ reportId, kbId }) => {
  // ---- State ----
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [sourceTrace, setSourceTrace] = useState<SourceTrace | null>(null);
  const [sources, setSources] = useState<SourceDocument[]>([]);
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [agentProcessOpen, setAgentProcessOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false); // kept for state compatibility

  const { success, error: showError } = useToast();

  // ---- Fetch report ----
  useEffect(() => {
    let cancelled = false;

    async function fetchReport() {
      setLoading(true);
      setError(null);
      try {
        const detail = await api.getReport(reportId);
        if (cancelled) return;
        setReport(detail);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchReport();
    return () => { cancelled = true; };
  }, [reportId]);

  // ---- Fetch sources + trace ----
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;

    async function fetchSources() {
      try {
        const resp = await fetch(`/api/reports/${reportId}/sources`);
        if (!resp.ok) throw new Error(`Failed: ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;

        // Expecting shape: { sources: SourceDocument[], trace?: SourceTrace }
        if (Array.isArray(data.sources)) {
          setSources(data.sources);
        }
        if (data.trace) {
          setSourceTrace(data.trace);
        } else {
          // Fallback trace from report metadata
          setSourceTrace({
            confidence: data.confidence ?? 0,
            agentType: data.agentType ?? "deep",
          });
        }
      } catch {
        // Sources are supplementary -- silently ignore
      }
    }

    fetchSources();
    return () => { cancelled = true; };
  }, [reportId]);

  // ---- Toggle doc expansion ----
  const toggleDoc = useCallback((docId: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  }, []);

  // ---- Parse report content into segments ----
  const contentSegments = useMemo(() => {
    if (!report?.content) return [];

    const segments: Array<{ type: "text" | "anchor"; value: string; anchorId?: string; anchorLabel?: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    // Reset lastIndex for the regex
    ANCHOR_PATTERN.lastIndex = 0;

    while ((match = ANCHOR_PATTERN.exec(report.content)) !== null) {
      // Text before this anchor
      if (match.index > lastIndex) {
        segments.push({ type: "text", value: report.content.slice(lastIndex, match.index) });
      }
      segments.push({
        type: "anchor",
        value: match[0],
        anchorLabel: match[1].trim(),
        anchorId: match[2].trim(),
      });
      lastIndex = match.index + match[0].length;
    }

    // Remaining text after last anchor
    if (lastIndex < report.content.length) {
      segments.push({ type: "text", value: report.content.slice(lastIndex) });
    }

    return segments;
  }, [report?.content]);

  // ---- Render markdown-ish text (simple approach) ----
  const renderTextSegment = useCallback((text: string, key: number) => {
    // Simple markdown: split into paragraphs at double newlines,
    // then apply basic formatting (bold, italic, headings, lists)
    const paragraphs = text.split(/\n{2,}/);

    return (
      <div key={key} className="space-y-3">
        {paragraphs.map((para, pi) => {
          const trimmed = para.trim();
          if (!trimmed) return null;

          // Headings
          if (trimmed.startsWith("### ")) {
            return (
              <h3 key={pi} className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-4">
                {trimmed.slice(4)}
              </h3>
            );
          }
          if (trimmed.startsWith("## ")) {
            return (
              <h2 key={pi} className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-5">
                {trimmed.slice(3)}
              </h2>
            );
          }
          if (trimmed.startsWith("# ")) {
            return (
              <h1 key={pi} className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-6">
                {trimmed.slice(2)}
              </h1>
            );
          }

          // Bullet list items
          const lines = trimmed.split("\n");
          const isList = lines.every((l) => l.trimStart().startsWith("- ") || l.trimStart().startsWith("* ") || l.trim() === "");

          if (isList) {
            return (
              <ul key={pi} className="list-disc list-inside space-y-1 text-gray-700 dark:text-gray-300">
                {lines.map((line, li) => {
                  const cleaned = line.trimStart().replace(/^[-*]\s+/, "");
                  if (!cleaned) return null;
                  return <li key={li}>{cleaned}</li>;
                })}
              </ul>
            );
          }

          // Regular paragraph -- apply inline bold/italic
          return (
            <p key={pi} className="text-gray-700 dark:text-gray-300 leading-relaxed">
              {renderInlineFormatting(trimmed)}
            </p>
          );
        })}
      </div>
    );
  }, []);

  // ---- Inline formatting helper ----
  function renderInlineFormatting(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    // Match **bold** and *italic*
    const inlinePattern = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let keyCounter = 0;

    while ((m = inlinePattern.exec(text)) !== null) {
      // Text before
      if (m.index > lastIdx) {
        parts.push(<React.Fragment key={`t${keyCounter++}`}>{text.slice(lastIdx, m.index)}</React.Fragment>);
      }
      if (m[2]) {
        // Bold
        parts.push(
          <strong key={`b${keyCounter++}`} className="font-semibold text-gray-900 dark:text-gray-100">
            {m[2]}
          </strong>,
        );
      } else if (m[3]) {
        // Italic
        parts.push(
          <em key={`i${keyCounter++}`} className="italic">
            {m[3]}
          </em>,
        );
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
      parts.push(<React.Fragment key={`tf${keyCounter++}`}>{text.slice(lastIdx)}</React.Fragment>);
    }
    return parts;
  }

  // ---- Action handlers ----
  const handleExport = useCallback(async () => {
    try {
      const resp = await fetch(`/api/reports/export/${reportId}?format=markdown`);
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${report?.title ?? "report"}.md`;
      a.click();
      URL.revokeObjectURL(url);
      success("Report exported successfully");
    } catch (err) {
      showError("Export failed: " + String(err));
    }
  }, [reportId, report?.title, success, showError]);

  const handleRegenerate = useCallback(async () => {
    // Report generation API has been removed.
    // Reports are now generated by Agent via write_file + push_content.
  }, []);

  const handleTestSearch = useCallback(() => {
    // Open search test panel for this knowledge base
    window.location.hash = `#/search-test/${kbId}`;
  }, [kbId]);

  // ---- Loading / error states ----
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[320px] text-gray-500 dark:text-gray-400">
        <Loader2 size={24} className="animate-spin mr-2" />
        <span>Loading report...</span>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[320px] text-gray-500 dark:text-gray-400 gap-2">
        <AlertCircle size={24} />
        <span>{error ?? "Report not found"}</span>
      </div>
    );
  }

  // ---- Derived values ----
  const agentType = sourceTrace?.agentType ?? "deep";
  const confidence = sourceTrace?.confidence ?? 0;
  const confidencePct = Math.round(confidence * 100);
  const formattedDate = new Date(report.createdAt).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // ---- Render ----
  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* ================================================================= */}
      {/* Report Header                                                     */}
      {/* ================================================================= */}
      <div className="sticky top-0 z-20 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        {/* Title row */}
        <div className="px-6 pt-5 pb-3">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 leading-tight">
            {report.title}
          </h1>
          <div className="flex items-center gap-3 mt-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="inline-flex items-center gap-1">
              <Clock size={14} />
              {formattedDate}
            </span>
            <span>{report.tokenCount.toLocaleString()} tokens</span>
          </div>
        </div>

        {/* Badges + Actions row */}
        <div className="flex items-center gap-2 px-6 pb-3 flex-wrap">
          {/* Agent type badge */}
          <span
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium",
              agentBadgeStyle(agentType),
            )}
          >
            <Sparkles size={12} />
            {agentType.charAt(0).toUpperCase() + agentType.slice(1)} Agent
          </span>

          {/* Confidence badge */}
          {confidence > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium",
                confidenceColor(confidence),
              )}
            >
              <ShieldCheck size={12} />
              {confidenceLabel(confidence)} Confidence ({confidencePct}%)
            </span>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Action buttons */}
          <button
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            <Download size={14} />
            Export
          </button>
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={regenerating ? "animate-spin" : ""} />
            {regenerating ? "Regenerating..." : "Regenerate"}
          </button>
          <button
            onClick={handleTestSearch}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            <Search size={14} />
            Test Search
          </button>
        </div>
      </div>

      {/* ================================================================= */}
      {/* Report Body (scrollable)                                          */}
      {/* ================================================================= */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {/* Render content segments */}
          {contentSegments.map((segment, idx) => {
            if (segment.type === "anchor" && segment.anchorId && segment.anchorLabel) {
              return (
                <AnchorHoverCard key={`anchor-${idx}`} anchorId={segment.anchorId}>
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-sm font-medium cursor-default border border-blue-200 dark:border-blue-700/40 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors">
                    {segment.anchorLabel}
                  </span>
                </AnchorHoverCard>
              );
            }
            return renderTextSegment(segment.value, idx);
          })}
        </div>

        {/* ================================================================= */}
        {/* Source Panel                                                      */}
        {/* ================================================================= */}
        {sources.length > 0 && (
          <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
            <div className="max-w-3xl mx-auto px-6 py-5">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
                <FileText size={16} className="text-gray-500 dark:text-gray-400" />
                Sources ({sources.length} document{sources.length !== 1 ? "s" : ""})
              </h2>

              <div className="space-y-2">
                {sources.map((doc) => {
                  const ModalityIcon = MODALITY_ICON_MAP[doc.modality] ?? FileText;
                  const isExpanded = expandedDocs.has(doc.documentId);

                  return (
                    <div
                      key={doc.documentId}
                      className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 overflow-hidden"
                    >
                      {/* Document header */}
                      <button
                        onClick={() => toggleDoc(doc.documentId)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                      >
                        <ModalityIcon
                          size={18}
                          className="text-gray-500 dark:text-gray-400 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                            {doc.fileName}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {doc.kbName}
                          </p>
                        </div>
                        {doc.anchors.length > 0 && (
                          <span className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">
                            {doc.anchors.length} anchor{doc.anchors.length !== 1 ? "s" : ""}
                          </span>
                        )}
                        {isExpanded ? (
                          <ChevronDown size={16} className="text-gray-400 shrink-0" />
                        ) : (
                          <ChevronRight size={16} className="text-gray-400 shrink-0" />
                        )}
                      </button>

                      {/* Expandable anchor list */}
                      {isExpanded && doc.anchors.length > 0 && (
                        <div className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-2">
                          <ul className="space-y-1">
                            {doc.anchors.map((anchor) => (
                              <li
                                key={anchor.anchorId}
                                className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 py-1"
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 dark:bg-blue-500 shrink-0" />
                                <span className="flex-1 truncate">
                                  {anchor.sectionTitle ?? anchor.anchorId}
                                </span>
                                {anchor.pageNumber != null && (
                                  <span className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">
                                    p. {anchor.pageNumber}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* Agent Process (collapsible placeholder)                           */}
        {/* ================================================================= */}
        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="max-w-3xl mx-auto px-6">
            <button
              onClick={() => setAgentProcessOpen((prev) => !prev)}
              className="w-full flex items-center gap-2 py-4 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              <Cpu size={16} />
              <span>View Agent Process</span>
              {agentProcessOpen ? (
                <ChevronDown size={16} className="ml-auto text-gray-400" />
              ) : (
                <ChevronRight size={16} className="ml-auto text-gray-400" />
              )}
            </button>

            {agentProcessOpen && (
              <div className="pb-6 px-4 py-3 mb-4 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                  Agent process data not available
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReportViewer;
