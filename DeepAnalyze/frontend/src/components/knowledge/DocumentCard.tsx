// =============================================================================
// DeepAnalyze - DocumentCard
// Unified card component that renders differently based on file type with
// L0/L1/L2 buttons, media preview, and expand/collapse content areas.
// =============================================================================

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
  FileText,
  Image as ImageIcon,
  Music,
  Video,
  Trash2,
  CheckCircle,
  AlertCircle,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { api } from "../../api/client";
import { formatFileSize } from "../../utils/format";
import { useMarkdown } from "../../hooks/useMarkdown";
import { useKnowledgeMarkdown } from "../../hooks/useKnowledgeMarkdown";
import { VirtualizedContent } from "../common/VirtualizedContent";
import type { DocumentInfo } from "../../types/index";
import { MediaPlayer } from "./MediaPlayer";
import type { MediaType } from "./MediaPlayer";

// ---------------------------------------------------------------------------
// File type classification
// ---------------------------------------------------------------------------

type FileCategory = "document" | "image" | "audio" | "video" | "unknown";

const DOCUMENT_EXTS = new Set([
  "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "txt", "md", "csv", "json", "html",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "svg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"]);
const VIDEO_EXTS = new Set(["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv"]);

function classifyFile(filename: string): FileCategory {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "unknown";
}

function categoryToMediaType(cat: FileCategory): MediaType | null {
  switch (cat) {
    case "image": return "image";
    case "audio": return "audio";
    case "video": return "video";
    default: return null;
  }
}

function categoryIcon(cat: FileCategory): React.ReactNode {
  switch (cat) {
    case "document": return <FileText size={16} />;
    case "image": return <ImageIcon size={16} />;
    case "audio": return <Music size={16} />;
    case "video": return <Video size={16} />;
    default: return <FileText size={16} />;
  }
}

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

interface StatusDisplay {
  label: string;
  color: string;
  icon: React.ReactNode;
}

function getStatusDisplay(status: DocumentInfo["status"], processing?: ProcessingInfo | null): StatusDisplay {
  switch (status) {
    case "ready":
      return { label: "就绪", color: "var(--success)", icon: <CheckCircle size={14} /> };
    case "error":
      return { label: "错误", color: "var(--error)", icon: <AlertCircle size={14} /> };
    case "uploaded":
      return { label: "已上传", color: "var(--text-tertiary)", icon: <Clock size={14} /> };
    case "parsing":
    case "compiling":
    case "indexing":
    case "linking":
    case "quality_audit":
      return {
        label: STEP_LABELS[status] ?? status,
        color: "var(--warning)",
        icon: <Loader2 size={14} className="animate-spin" />,
      };
    default:
      if (processing) {
        const baseLabel = STEP_LABELS[processing.step] ?? processing.step;
        // Prefer the explicit message (e.g. "生成摘要中（尝试 1/3）") over the
        // subStep label — message carries richer, dynamic context.
        const subLabel = processing.message
          ?? (processing.subStep ? SUBSTEP_LABELS[processing.subStep] ?? processing.subStep : "");
        return {
          label: subLabel ? `${baseLabel} · ${subLabel}` : baseLabel,
          color: "var(--warning)",
          icon: <Loader2 size={14} className="animate-spin" />,
        };
      }
      return { label: status, color: "var(--text-tertiary)", icon: <Clock size={14} /> };
  }
}

const STEP_LABELS: Record<string, string> = {
  parsing: "解析中",
  compiling: "编译中",
  indexing: "索引中",
  linking: "关联中",
  quality_audit: "质检中",
  uploading: "上传中",
  retrying: "重试中",
};

const SUBSTEP_LABELS: Record<string, string> = {
  raw_save: "保存原始数据",
  structure: "生成结构",
  abstract: "生成摘要",
  overview: "生成概览",
  fulltext: "保存全文",
};

// ---------------------------------------------------------------------------
// LevelReadiness
// ---------------------------------------------------------------------------

export interface LevelReadiness {
  L0: boolean;
  L1: boolean;
  L2: boolean;
}

// ---------------------------------------------------------------------------
// Processing info
// ---------------------------------------------------------------------------

export interface ProcessingInfo {
  step: string;
  progress: number;
  error?: string;
  /** Optional finer-grained sub-step inside the current step. */
  subStep?: string;
  /** Optional display message that overrides the subStep label (e.g.
   *  retry counters like "生成摘要中（尝试 1/3）"). */
  message?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DocumentCardProps {
  document: DocumentInfo;
  levels: LevelReadiness;
  processing?: ProcessingInfo | null;
  selected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
  onRetry?: (processor?: string) => void;
  kbId: string;
  /** When set, auto-expand to this level on mount (used for URL-driven navigation). */
  autoExpandLevel?: "L0" | "L1" | "L2" | null;
}

// ---------------------------------------------------------------------------
// Cached level content state
// ---------------------------------------------------------------------------

type LevelContentCache = Record<string, { content: string; expandable: boolean; source?: string }>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentCard({
  document: doc,
  levels,
  processing,
  selected,
  onToggleSelect,
  onDelete,
  onRetry,
  kbId,
  autoExpandLevel,
}: DocumentCardProps) {
  const category = classifyFile(doc.filename);
  const mediaType = categoryToMediaType(category);
  const isMedia = mediaType !== null;

  // Expanded state: split into level content and media preview (independent)
  const [expandedLevel, setExpandedLevel] = useState<"L0" | "L1" | "L2" | null>(
    autoExpandLevel ?? null,
  );
  const [mediaExpanded, setMediaExpanded] = useState(false);
  // Slide-out preview panel state
  const [previewOpen, setPreviewOpen] = useState(false);
  // Cache for level content
  const [levelCache, setLevelCache] = useState<LevelContentCache>({});
  // Loading state for level fetch
  const [levelLoading, setLevelLoading] = useState(false);
  const [levelError, setLevelError] = useState<string | null>(null);
  // Regenerating the L0 abstract (retry after failure/placeholder).
  const [regeneratingAbstract, setRegeneratingAbstract] = useState(false);
  // L1 format toggle: "md" (Markdown) or "dt" (DocTags)
  const [l1Format, setL1Format] = useState<"md" | "dt">("md");
  // Shared L0/L1/L2 Markdown-render preference (persisted, synced across the KB).
  const { markdownEnabled } = useKnowledgeMarkdown();
  // Pre-render the currently-expanded level's content to sanitized HTML.
  // `useMarkdown` is a hook, so it must run at the component top level; the
  // currently displayed content depends on expandedLevel + l1Format, mirrored
  // from renderLevelContent's cache lookup key.
  const lookupKey = expandedLevel === "L1" ? `L1:${l1Format}` : expandedLevel;
  const activeContent = expandedLevel ? levelCache[lookupKey]?.content ?? "" : "";
  const activeMarkdownHtml = useMarkdown(markdownEnabled ? activeContent : "");
  // Processor selector: "auto" | "docling" | "native" | "asr"
  const [processor, setProcessor] = useState<string>("auto");
  const [rebuilding, setRebuilding] = useState(false);

  // Clear rebuilding once the server starts processing (status changes from "ready")
  useEffect(() => {
    if (rebuilding && doc.status !== "ready") {
      setRebuilding(false);
    }
  }, [doc.status, rebuilding]);
  // Media metadata (fetched on demand)
  const [mediaMeta, setMediaMeta] = useState<{
    type: "image" | "audio" | "video" | null;
    image?: { width: number; height: number; description?: string };
    audio?: { duration: number; speakers: string[]; turns: Array<{ speaker: string; text: string; start?: number; end?: number }> };
    video?: { duration: number; scenes: Array<{ start: number; end: number; description?: string }>; transcript: { speakers: string[]; turns: Array<{ speaker: string; text: string; start?: number; end?: number }> }; frameCount: number };
  } | null>(null);

  // Use ref to avoid stale closures in fetch
  const abortRef = useRef<AbortController | null>(null);

  // Sync from external autoExpandLevel prop (e.g. navigateToDoc from evidence link)
  // Also triggers content fetch since auto-expand isn't driven by handleToggleExpand
  useEffect(() => {
    if (!autoExpandLevel) return;
    setExpandedLevel(autoExpandLevel);
    setLevelError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLevelLoading(true);
    const format = autoExpandLevel === "L1" ? l1Format : undefined;
    api
      .expandWiki(kbId, doc.id, autoExpandLevel, format)
      .then((result) => {
        if (!controller.signal.aborted) {
          const cacheKey = autoExpandLevel === "L1" ? `L1:${l1Format}` : autoExpandLevel;
          setLevelCache((prev) => ({
            ...prev,
            [cacheKey]: { content: result.content, expandable: result.expandable, source: result.source },
          }));
          setLevelLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          setLevelError(msg);
          setLevelLoading(false);
        }
      });

    return () => controller.abort();
  }, [autoExpandLevel, kbId, doc.id, l1Format]);

  // Fetch media metadata when media section is expanded
  useEffect(() => {
    if (!mediaExpanded || !isMedia) return;
    let cancelled = false;
    api.getMediaMetadata(kbId, doc.id).then((data) => {
      if (!cancelled) setMediaMeta(data);
    }).catch(() => {
      // Metadata not available — use defaults
    });
    return () => { cancelled = true; };
  }, [mediaExpanded, kbId, doc.id, isMedia]);

  // -------------------------------------------------------------------------
  // Toggle expand section
  // -------------------------------------------------------------------------

  const handleToggleExpand = useCallback(
    (key: string) => {
      // Handle media toggle independently
      if (key === "media") {
        setMediaExpanded((prev) => !prev);
        return;
      }

      // Handle level toggle
      if (expandedLevel === key) {
        setExpandedLevel(null);
        abortRef.current?.abort();
        return;
      }

      // Expand new level
      setExpandedLevel(key as "L0" | "L1" | "L2");
      setLevelError(null);

      // If not cached, fetch it
      const cacheKey = key === "L1" ? `L1:${l1Format}` : key;
      if ((key === "L0" || key === "L1" || key === "L2") && !levelCache[cacheKey]) {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        setLevelLoading(true);
        const format = key === "L1" ? l1Format : undefined;
        api
          .expandWiki(kbId, doc.id, key, format)
          .then((result) => {
            if (!controller.signal.aborted) {
              setLevelCache((prev) => ({
                ...prev,
                [cacheKey]: { content: result.content, expandable: result.expandable, source: result.source },
              }));
              setLevelLoading(false);
            }
          })
          .catch((err: unknown) => {
            if (!controller.signal.aborted) {
              const msg = err instanceof Error ? err.message : String(err);
              setLevelError(msg);
              setLevelLoading(false);
            }
          });
      }
    },
    [expandedLevel, levelCache, kbId, doc.id, l1Format],
  );

  // -------------------------------------------------------------------------
  // Determine readiness / status display
  // -------------------------------------------------------------------------

  // Regenerate the L0 abstract — retry after a failed/placeholder summary.
  // Invalidates the L0 cache and re-fetches if L0 is currently expanded so
  // the new summary shows immediately without a manual refresh.
  const handleRegenerateAbstract = useCallback(async () => {
    if (regeneratingAbstract) return;
    setRegeneratingAbstract(true);
    setLevelError(null);
    try {
      await api.regenerateAbstract(kbId, doc.id);
      // Invalidate L0 cache so the next expand refetches.
      setLevelCache((prev) => {
        const next = { ...prev };
        delete next["L0"];
        return next;
      });
      // Re-fetch L0 if it's currently expanded.
      if (expandedLevel === "L0") {
        setLevelLoading(true);
        try {
          const res = await api.expandWiki(kbId, doc.id, "L0");
          setLevelCache((prev) => ({ ...prev, L0: res }));
          setLevelError(null);
        } catch (err) {
          setLevelError(err instanceof Error ? err.message : String(err));
        } finally {
          setLevelLoading(false);
        }
      }
    } catch (err) {
      setLevelError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegeneratingAbstract(false);
    }
  }, [kbId, doc.id, expandedLevel, regeneratingAbstract]);

  const isReady = doc.status === "ready";
  // Once the server reports "ready", clear stale processing state (can happen
  // if the doc_ready WebSocket event was missed during a reconnect).
  const hasProcessing = processing != null && !isReady;
  const hasError = doc.status === "error" || (processing?.error != null);
  const statusInfo = getStatusDisplay(doc.status, processing);
  const progressPct = processing ? Math.min(100, Math.max(0, processing.progress)) : 0;

  // -------------------------------------------------------------------------
  // Render: level button style helper
  // -------------------------------------------------------------------------

  const renderLevelButton = (level: "L0" | "L1" | "L2") => {
    const ready = levels[level];
    const isExpanded = expandedLevel === level;

    // Button state colors
    let borderColor: string;
    let dotColor: string;
    let textColor: string;
    let bgColor: string;

    if (isExpanded) {
      // Active / expanded state - blue
      borderColor = "var(--interactive)";
      dotColor = "var(--interactive)";
      textColor = "var(--interactive)";
      bgColor = "var(--interactive-light, rgba(59, 130, 246, 0.08))";
    } else if (ready) {
      // Ready but not expanded - green
      borderColor = "var(--success)";
      dotColor = "var(--success)";
      textColor = "var(--success)";
      bgColor = "transparent";
    } else {
      // Not ready - gray
      borderColor = "var(--border-primary)";
      dotColor = "var(--text-tertiary)";
      textColor = "var(--text-tertiary)";
      bgColor = "transparent";
    }

    return (
      <button
        key={level}
        onClick={() => handleToggleExpand(level)}
        disabled={!ready && !isExpanded}
        title={ready ? `${level} 内容` : `${level} 未就绪`}
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
          cursor: ready || isExpanded ? "pointer" : "not-allowed",
          opacity: !ready && !isExpanded ? 0.5 : 1,
          transition: "all var(--transition-fast)",
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => {
          if (ready || isExpanded) {
            e.currentTarget.style.opacity = "0.85";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = !ready && !isExpanded ? "0.5" : "1";
        }}
      >
        {/* Readiness dot */}
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: dotColor,
            flexShrink: 0,
          }}
        />
        {level}
        {isExpanded && <ChevronDown size={10} style={{ marginLeft: -2 }} />}
      </button>
    );
  };

  // -------------------------------------------------------------------------
  // Render: expanded content area
  // -------------------------------------------------------------------------

  const renderMediaContent = () => {
    if (!mediaExpanded) return null;
      const originalUrl = api.getOriginalFileUrl(kbId, doc.id);
      const thumbnailUrl = api.getThumbnailUrl(kbId, doc.id);

      if (mediaType === "image") {
        return (
          <MediaPlayer
            mediaType="image"
            imageProps={{
              thumbnailUrl,
              originalUrl,
            }}
          />
        );
      }

      if (mediaType === "audio") {
        const audioMeta = mediaMeta?.audio;
        return (
          <MediaPlayer
            mediaType="audio"
            audioProps={{
              src: originalUrl,
              duration: audioMeta?.duration ?? 0,
              speakers: (audioMeta?.speakers ?? []).map((s, i) => ({ id: `s${i}`, label: s })),
              turns: (audioMeta?.turns ?? []).map((t) => ({
                speaker: t.speaker,
                startTime: t.start ?? 0,
                endTime: t.end ?? 0,
                text: t.text,
              })),
            }}
          />
        );
      }

      if (mediaType === "video") {
        const videoMeta = mediaMeta?.video;
        const transcript = videoMeta?.transcript;
        return (
          <MediaPlayer
            mediaType="video"
            videoProps={{
              src: originalUrl,
              duration: videoMeta?.duration ?? 0,
              scenes: (videoMeta?.scenes ?? []).map((s) => ({
                startTime: s.start,
                endTime: s.end,
                description: s.description ?? "",
              })),
              transcript: {
                speakers: (transcript?.speakers ?? []).map((s, i) => ({ id: `s${i}`, label: s })),
                turns: (transcript?.turns ?? []).map((t) => ({
                  speaker: t.speaker,
                  startTime: t.start ?? 0,
                  endTime: t.end ?? 0,
                  text: t.text,
                })),
              },
              frameUrls: Array.from(
                { length: videoMeta?.frameCount ?? 0 },
                (_, i) => api.getFrameUrl(kbId, doc.id, i),
              ),
            }}
          />
        );
      }

      return null;
  };

  const renderLevelContent = () => {
    if (!expandedLevel) return null;

    // Show loading
    if (levelLoading) {
      return (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-2)",
          padding: "var(--space-4)",
          color: "var(--text-tertiary)",
        }}>
          <Loader2 size={16} className="animate-spin" />
          <span style={{ fontSize: "var(--text-sm)" }}>加载中...</span>
        </div>
      );
    }

    // Show error
    if (levelError) {
      return (
        <div style={{
          padding: "var(--space-3)",
          backgroundColor: "rgba(239, 68, 68, 0.06)",
          border: "1px solid rgba(239, 68, 68, 0.2)",
          borderRadius: "var(--radius-md)",
        }}>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--error)", margin: 0 }}>
            加载失败: {levelError}
          </p>
        </div>
      );
    }

    // Show cached content — use format-specific key for L1
    const lookupKey = expandedLevel === "L1" ? `L1:${l1Format}` : expandedLevel;
    const cached = levelCache[lookupKey];
    if (cached) {
      // L0 failure-marker detection — if the cached content carries the
      // "L0 摘要自动生成失败" warning (written by wiki/compiler.ts fallback),
      // highlight the regenerate button in red so the user knows it's broken.
      const isL0 = expandedLevel === "L0";
      const isFailureNote = isL0 && (cached.content || "").includes("L0 摘要自动生成失败");
      return (
        <div style={{
          padding: "var(--space-3)",
          backgroundColor: "var(--bg-tertiary)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-md)",
        }}>
          <VirtualizedContent
            content={cached.content}
            markdown={markdownEnabled}
            markdownHtml={activeMarkdownHtml}
            maxHeight={400}
            fontSize={13}
            style={{ color: "var(--text-primary)" }}
          />
          {isL0 && (
            <div style={{ marginTop: "var(--space-2)", display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={handleRegenerateAbstract}
                disabled={regeneratingAbstract}
                title={isFailureNote ? "摘要生成失败，点击重新生成" : "使用 LLM 重新生成 L0 摘要"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: "var(--text-xs)",
                  padding: "4px 10px",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-sm)",
                  background: isFailureNote ? "rgba(239,68,68,0.08)" : "transparent",
                  color: isFailureNote ? "var(--error)" : "var(--text-secondary)",
                  cursor: regeneratingAbstract ? "not-allowed" : "pointer",
                  opacity: regeneratingAbstract ? 0.6 : 1,
                  transition: "background-color var(--transition-fast), color var(--transition-fast)",
                }}
              >
                <RefreshCw
                  size={12}
                  style={regeneratingAbstract ? { animation: "spin 1s linear infinite" } : undefined}
                />
                {regeneratingAbstract ? "生成中…" : "重新生成摘要"}
              </button>
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      data-doc-id={doc.id}
      style={{
        border: `1px solid ${selected ? "var(--interactive)" : "var(--border-primary)"}`,
        borderRadius: "var(--radius-lg)",
        backgroundColor: selected ? "var(--interactive-light, rgba(59, 130, 246, 0.04))" : "var(--bg-primary)",
        overflow: "hidden",
        transition: "border-color var(--transition-fast), background-color var(--transition-fast)",
      }}
    >
      {/* ====== Card header ====== */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "var(--space-2)",
          padding: "var(--space-3)",
        }}
      >
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          style={{
            marginTop: 2,
            accentColor: "var(--interactive)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        />

        {/* File type icon */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: "var(--radius-sm)",
            backgroundColor: "var(--bg-tertiary)",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          {categoryIcon(category)}
        </div>

        {/* Filename, size, status */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-medium)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              margin: 0,
            }}
          >
            {doc.filename}
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginTop: "var(--space-1)",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              {formatFileSize(doc.fileSize)}
            </span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              {category !== "unknown" ? category.charAt(0).toUpperCase() + category.slice(1) : doc.fileType.toUpperCase()}
            </span>
            {/* Status indicator */}
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
                fontSize: "var(--text-xs)",
                color: statusInfo.color,
                fontWeight: "var(--font-medium)",
              }}
            >
              {statusInfo.icon}
              {statusInfo.label}
            </span>
          </div>
        </div>

        {/* Delete button */}
        <button
          onClick={onDelete}
          title="删除文档"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            border: "none",
            borderRadius: "var(--radius-sm)",
            backgroundColor: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            flexShrink: 0,
            transition: "color var(--transition-fast), background-color var(--transition-fast)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--error)";
            e.currentTarget.style.backgroundColor = "rgba(239, 68, 68, 0.08)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-tertiary)";
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* ====== L1 Preview snippet (only when ready) ====== */}
      {isReady && doc.l1Preview && (
        <div
          style={{
            padding: "0 var(--space-3)",
            marginBottom: "var(--space-1)",
          }}
        >
          <p
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              margin: 0,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              textOverflow: "ellipsis",
              lineHeight: 1.5,
              fontFamily: "var(--font-mono, monospace)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {doc.l1Preview}
          </p>
        </div>
      )}

      {/* ====== Processing progress bar ====== */}
      {hasProcessing && !hasError && (
        <div
          style={{
            padding: "0 var(--space-3) var(--space-2)",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          <div
            style={{
              flex: 1,
              height: 4,
              backgroundColor: "var(--border-primary)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: "100%",
                backgroundColor: "var(--interactive)",
                borderRadius: 2,
                transition: "width 0.3s",
              }}
            />
          </div>
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              flexShrink: 0,
              minWidth: 32,
              textAlign: "right",
            }}
          >
            {progressPct}%
          </span>
        </div>
      )}

      {/* ====== Error message with retry ====== */}
      {hasError && (
        <div
          style={{
            margin: "0 var(--space-3) var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            backgroundColor: "rgba(239, 68, 68, 0.06)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-2)",
          }}
        >
          <p
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--error)",
              margin: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            {processing?.error ?? "处理失败"}
          </p>
          {onRetry && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", flexShrink: 0 }}>
              <select
                defaultValue="auto"
                title="选择处理器"
                style={{
                  padding: "var(--space-1) var(--space-2)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: "var(--bg-primary)",
                  color: "var(--text-secondary)",
                  fontSize: "var(--text-xs)",
                  cursor: "pointer",
                  outline: "none",
                  maxWidth: 120,
                }}
                onChange={(e) => {
                  const sel = e.target;
                  sel.dataset.selected = e.target.value;
                }}
                id={`error-processor-${doc.id}`}
              >
                <option value="auto">Auto</option>
                {category === "image" || category === "video" ? (
                  <>
                    <option value="vlm">VLM / 多模态</option>
                    <option value="docling">Docling</option>
                  </>
                ) : category === "audio" ? (
                  <option value="asr">ASR</option>
                ) : (
                  <>
                    <option value="docling">Docling</option>
                    <option value="docling-vlm">Docling VLM</option>
                    <option value="mineru-hybrid">MinerU Hybrid</option>
                  </>
                )}
              </select>
              <button
                onClick={() => {
                  const sel = document.getElementById(`error-processor-${doc.id}`) as HTMLSelectElement;
                  const proc = sel?.dataset.selected || sel?.value || "auto";
                  onRetry(proc === "auto" ? undefined : proc);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "var(--space-1) var(--space-2)",
                  border: "1px solid var(--interactive)",
                  borderRadius: "var(--radius-sm)",
                  backgroundColor: "transparent",
                  color: "var(--interactive)",
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  cursor: "pointer",
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  transition: "color var(--transition-fast), background-color var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#fff";
                  e.currentTarget.style.backgroundColor = "var(--interactive)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--interactive)";
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
                title="重试"
              >
                <RefreshCw size={10} />
                重试
              </button>
            </div>
          )}
        </div>
      )}

      {/* ====== Level buttons row (only when ready) ====== */}
      {isReady && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "0 var(--space-3) var(--space-2)",
            flexWrap: "wrap",
          }}
        >
          {renderLevelButton("L0")}
          {renderLevelButton("L1")}

          {/* L2 button with source label */}
          {(() => {
            const l2CacheKey = "L2";
            const l2Cached = levelCache[l2CacheKey];
            const l2Label = l2Cached?.source === "fulltext" ? "L2 (Fulltext)" : "L2";
            const ready = levels.L2;
            const isExpanded = expandedLevel === "L2";

            let borderColor: string;
            let dotColor: string;
            let textColor: string;
            let bgColor: string;

            if (isExpanded) {
              borderColor = "var(--interactive)";
              dotColor = "var(--interactive)";
              textColor = "var(--interactive)";
              bgColor = "var(--interactive-light, rgba(59, 130, 246, 0.08))";
            } else if (ready) {
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
                onClick={() => handleToggleExpand("L2")}
                disabled={!ready && !isExpanded}
                title={ready ? `${l2Label} 内容` : `${l2Label} 未就绪`}
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
                  cursor: ready || isExpanded ? "pointer" : "not-allowed",
                  opacity: !ready && !isExpanded ? 0.5 : 1,
                  transition: "all var(--transition-fast)",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => {
                  if (ready || isExpanded) {
                    e.currentTarget.style.opacity = "0.85";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = !ready && !isExpanded ? "0.5" : "1";
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: dotColor,
                    flexShrink: 0,
                  }}
                />
                {l2Label}
                {isExpanded && <ChevronDown size={10} style={{ marginLeft: -2 }} />}
              </button>
            );
          })()}

          {/* L1 Format toggle (MD/DT) */}
          {expandedLevel === "L1" && (
            <div
              style={{
                display: "inline-flex",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
              }}
            >
              {(["md", "dt"] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => {
                    if (l1Format === fmt) return;
                    setL1Format(fmt);
                    // Use independent cache key so switching doesn't clear the other format
                    const cacheKey = `L1:${fmt}`;
                    if (levelCache[cacheKey]) {
                      // Already cached, just switch
                      return;
                    }
                    setLevelLoading(true);
                    setLevelError(null);
                    const controller = new AbortController();
                    abortRef.current?.abort();
                    abortRef.current = controller;
                    api
                      .expandWiki(kbId, doc.id, "L1", fmt)
                      .then((res) => {
                        if (!controller.signal.aborted) {
                          setLevelCache((prev) => ({
                            ...prev,
                            [cacheKey]: { content: res.content, expandable: res.expandable, source: res.source },
                          }));
                          setLevelLoading(false);
                        }
                      })
                      .catch((err: unknown) => {
                        if (!controller.signal.aborted) {
                          const msg = err instanceof Error ? err.message : String(err);
                          // If DT format fails, show a helpful message and don't lose MD cache
                          if (fmt === "dt" && msg.includes("No page found")) {
                            setLevelCache((prev) => ({
                              ...prev,
                              [cacheKey]: { content: "该文档无 DocTags 格式数据。请使用 Markdown 格式查看。", expandable: false },
                            }));
                            setLevelLoading(false);
                          } else {
                            // On other errors, fall back to MD
                            if (fmt === "dt" && levelCache["L1:md"]) {
                              setL1Format("md");
                            }
                            setLevelError(msg);
                            setLevelLoading(false);
                          }
                        }
                      });
                  }}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: "none",
                    backgroundColor: l1Format === fmt ? "var(--interactive-light, rgba(59, 130, 246, 0.12))" : "transparent",
                    color: l1Format === fmt ? "var(--interactive)" : "var(--text-tertiary)",
                    fontSize: "var(--text-xs)",
                    fontWeight: l1Format === fmt ? "var(--font-medium)" : "var(--font-normal)",
                    cursor: "pointer",
                    transition: "all var(--transition-fast)",
                  }}
                  title={fmt === "md" ? "Markdown 格式" : "DocTags 格式"}
                >
                  {fmt.toUpperCase()}
                </button>
              ))}
            </div>
          )}


          {/* Media toggle button — opens slide-out preview panel */}
          {isMedia && (
            <button
              onClick={() => setPreviewOpen(true)}
              title="预览媒体"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "var(--space-1) var(--space-2)",
                border: `1px solid ${previewOpen ? "var(--interactive)" : "var(--border-primary)"}`,
                borderRadius: "var(--radius-sm)",
                backgroundColor: previewOpen
                  ? "var(--interactive-light, rgba(59, 130, 246, 0.08))"
                  : "transparent",
                color: previewOpen ? "var(--interactive)" : "var(--text-secondary)",
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
                cursor: "pointer",
                transition: "all var(--transition-fast)",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "0.85";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
            >
              <Play size={10} />
              预览
            </button>
          )}

          {/* Processor selector + rebuild button — available for ALL file types */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
            <select
              value={processor}
              onChange={(e) => {
                setProcessor(e.target.value);
              }}
              title="选择处理器"
              style={{
                padding: "var(--space-1) var(--space-2)",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--bg-primary)",
                color: "var(--text-secondary)",
                fontSize: "var(--text-xs)",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <option value="auto">{category === "image" || category === "video" ? "Auto (VLM+OCR)" : "Auto"}</option>
              {category === "image" || category === "video" ? (
                <>
                  <option value="vlm">VLM / 多模态模型</option>
                  <option value="docling">Docling (OCR)</option>
                </>
              ) : category === "audio" ? (
                <option value="asr">ASR</option>
              ) : (
                <>
                  <option value="docling">Docling</option>
                  <option value="docling-vlm">Docling VLM</option>
                  <option value="mineru-hybrid">MinerU Hybrid</option>
                  <option value="mineru-pipeline">MinerU Pipeline</option>
                  {category === "document" ? <option value="native">Native</option> : null}
                </>
              )}
            </select>
            <button
              onClick={() => {
                if (rebuilding) return;
                // Clear cached level content and close expanded sections
                setLevelCache({});
                setExpandedLevel(null);
                setRebuilding(true);
                // Trigger reprocessing with selected processor
                const proc = processor !== "auto" ? processor : undefined;
                api.reprocessDocument(kbId, doc.id, proc).catch((err) => {
                  console.error("Reprocess failed:", err);
                  setRebuilding(false);
                });
              }}
              disabled={rebuilding}
              title={rebuilding ? "排队中..." : `重建文档${processor !== "auto" ? ` (${processor.toUpperCase()})` : ""}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "var(--space-1) var(--space-2)",
                border: `1px solid ${rebuilding ? "var(--warning)" : "var(--interactive)"}`,
                borderRadius: "var(--radius-sm)",
                backgroundColor: rebuilding ? "var(--warning-light, rgba(245,158,11,0.08))" : "var(--interactive-light)",
                color: rebuilding ? "var(--warning)" : "var(--interactive)",
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
                cursor: rebuilding ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
                opacity: rebuilding ? 0.8 : 1,
                transition: "all 0.2s ease",
              }}
            >
              <RefreshCw size={10} style={rebuilding ? { animation: "spin 1s linear infinite" } : undefined} />
              {rebuilding ? "排队中..." : "重建"}
            </button>
          </div>
        </div>
      )}

      {/* ====== Expanded content area (side-by-side when both active) ====== */}
      {(expandedLevel || mediaExpanded) && (
        <div
          data-expanded-content=""
          style={{
            padding: "0 var(--space-3) var(--space-3)",
            borderTop: "1px solid var(--border-primary)",
            marginTop: "var(--space-1)",
            paddingTop: "var(--space-2)",
          }}
        >
          {expandedLevel && mediaExpanded ? (
            // Side-by-side layout: level content + media preview (legacy, kept for non-image media)
            <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 0", minWidth: 0 }}>
                {renderLevelContent()}
              </div>
              <div style={{ flex: "0 0 300px", maxWidth: "100%" }}>
                {renderMediaContent()}
              </div>
            </div>
          ) : expandedLevel ? (
            // Only level content (full width)
            renderLevelContent()
          ) : mediaExpanded ? (
            // Only media preview (full width, for audio/video still using inline)
            renderMediaContent()
          ) : null}
        </div>
      )}

      {/* Slide-out preview panel for images */}
      {previewOpen && isMedia && createPortal(
        <>
          {/* Overlay — clicking closes the panel */}
          <div
            onClick={() => setPreviewOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              backgroundColor: "rgba(0, 0, 0, 0.2)",
              zIndex: 1200,
              animation: "previewOverlayFadeIn 0.15s ease-out",
            }}
          />
          {/* Slide-out panel */}
          <div
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(600px, 50vw)",
              backgroundColor: "var(--bg-primary, #fff)",
              boxShadow: "-4px 0 24px rgba(0, 0, 0, 0.12)",
              zIndex: 1300,
              display: "flex",
              flexDirection: "column",
              animation: "previewPanelSlideIn 0.2s ease-out",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Panel header */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--space-3) var(--space-4)",
              borderBottom: "1px solid var(--border-primary, #e5e7eb)",
              flexShrink: 0,
            }}>
              <div style={{
                fontSize: "var(--text-sm, 14px)",
                fontWeight: "var(--font-semibold, 600)",
                color: "var(--text-primary, #111827)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {doc.filename}
              </div>
              <button
                onClick={() => setPreviewOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "var(--space-1)",
                  color: "var(--text-secondary, #6b7280)",
                  fontSize: "18px",
                  lineHeight: 1,
                }}
                title="关闭预览"
              >
                ✕
              </button>
            </div>
            {/* Panel content — image fills available space */}
            <div style={{
              flex: 1,
              overflow: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "var(--space-4)",
              backgroundColor: "var(--bg-secondary, #f9fafb)",
            }}>
              {mediaType === "image" ? (
                <img
                  src={api.getOriginalFileUrl(kbId, doc.id)}
                  alt={doc.filename}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "100%",
                    objectFit: "contain",
                    borderRadius: "var(--radius-md, 6px)",
                  }}
                />
              ) : mediaType === "video" ? (
                <video
                  src={api.getOriginalFileUrl(kbId, doc.id)}
                  controls
                  style={{
                    maxWidth: "100%",
                    maxHeight: "100%",
                    borderRadius: "var(--radius-md, 6px)",
                  }}
                />
              ) : mediaType === "audio" ? (
                <audio
                  src={api.getOriginalFileUrl(kbId, doc.id)}
                  controls
                  style={{ width: "100%" }}
                />
              ) : null}
            </div>
          </div>

          {/* Inline keyframes for animations */}
          <style>{`
            @keyframes previewOverlayFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes previewPanelSlideIn {
              from { transform: translateX(100%); }
              to { transform: translateX(0); }
            }
          `}</style>
        </>,
        document.body
      )}
    </div>
  );
}
