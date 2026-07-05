// =============================================================================
// DeepAnalyze - Anchor Hover Card
// Shows a preview card when hovering over an anchor reference in a report.
// Fetches anchor details from the preview API on first hover.
// =============================================================================

import React, { useState, useRef, useCallback, useEffect } from "react";
import { FileText, Table, Image, Mic, Video, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import { cn } from "../../utils/cn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnchorPreviewData {
  /** Original file name (e.g. "report.pdf") */
  fileName: string;
  /** Modality of the source file */
  modality: "document" | "excel" | "image" | "audio" | "video";
  /** Section title within the source document */
  sectionTitle: string | null;
  /** Page number within the source document */
  pageNumber: number | null;
  /** Structure snippet text for quick preview */
  snippet: string;
}

interface AnchorHoverCardProps {
  /** The anchor ID to fetch preview data for */
  anchorId: string;
  /** The wrapped content (usually inline text) that triggers the hover */
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Modality icon mapping
// ---------------------------------------------------------------------------

const MODALITY_CONFIG: Record<
  string,
  { Icon: React.FC<React.SVGProps<SVGSVGElement> & { size?: number | string }>; label: string }
> = {
  document: { Icon: FileText, label: "Document" },
  excel: { Icon: Table, label: "Spreadsheet" },
  image: { Icon: Image, label: "Image" },
  audio: { Icon: Mic, label: "Audio" },
  video: { Icon: Video, label: "Video" },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AnchorHoverCard: React.FC<AnchorHoverCardProps> = ({
  anchorId,
  children,
}) => {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnchorPreviewData | null>(null);

  const fetchedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -------------------------------------------------------------------------
  // Fetch anchor preview data (only once)
  // -------------------------------------------------------------------------

  const fetchPreview = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(`/api/preview/anchors/${anchorId}`, {
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Preview failed: ${resp.status} ${text}`);
      }

      const json: AnchorPreviewData = await resp.json();
      setData(json);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load preview");
    } finally {
      setLoading(false);
    }
  }, [anchorId]);

  // -------------------------------------------------------------------------
  // Mouse handlers with show/hide delay
  // -------------------------------------------------------------------------

  const handleMouseEnter = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setVisible(true);

    if (!fetchedRef.current) {
      fetchPreview();
    }
  }, [fetchPreview]);

  const handleMouseLeave = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => {
      setVisible(false);
    }, 150);
  }, []);

  // Abort in-flight request on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const modalityKey = data?.modality ?? "document";
  const { Icon: ModalityIcon } = MODALITY_CONFIG[modalityKey] ?? MODALITY_CONFIG.document;

  const locationParts: string[] = [];
  if (data?.sectionTitle) locationParts.push(data.sectionTitle);
  if (data?.pageNumber != null) locationParts.push(`p. ${data.pageNumber}`);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <span
      className="relative inline"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {visible && (
        <div
          className={cn(
            "absolute z-50 bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2",
            "w-72 max-h-80 overflow-y-auto",
            "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700",
            "rounded-lg shadow-xl",
            "animate-in fade-in-0 zoom-in-95 duration-150",
          )}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {/* Arrow pointing down */}
          <div
            className={cn(
              "absolute -bottom-[5px] left-1/2 -ml-[5px]",
              "w-[10px] h-[10px]",
              "bg-white dark:bg-gray-800",
              "border-r border-b border-gray-200 dark:border-gray-700",
              "rotate-45",
            )}
          />

          {/* ---- Header ---- */}
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2",
              "border-b border-gray-100 dark:border-gray-700",
            )}
          >
            <ModalityIcon
              size={14}
              className="text-gray-500 dark:text-gray-400 shrink-0"
            />
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate flex-1">
              {data?.fileName ?? anchorId}
            </span>
            {locationParts.length > 0 && (
              <span className="text-[10px] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                {locationParts.join(" \u00B7 ")}
              </span>
            )}
          </div>

          {/* ---- Body ---- */}
          <div className="px-3 py-2">
            {/* Loading state */}
            {loading && (
              <div className="flex items-center justify-center py-6">
                <Loader2
                  size={16}
                  className="animate-spin text-blue-500 dark:text-blue-400"
                />
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  Loading preview...
                </span>
              </div>
            )}

            {/* Error state */}
            {error && (
              <div
                className={cn(
                  "flex items-start gap-2 py-2 px-2 rounded",
                  "bg-red-50 dark:bg-red-900/20",
                  "text-xs text-red-600 dark:text-red-400",
                )}
              >
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Snippet content */}
            {data && !loading && (
              <div className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap line-clamp-8 bg-gray-50 dark:bg-gray-900/40 rounded p-2">
                {data.snippet || (
                  <span className="italic text-gray-400 dark:text-gray-500">
                    No preview available
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ---- Footer ---- */}
          <div
            className={cn(
              "px-3 py-2 border-t border-gray-100 dark:border-gray-700",
            )}
          >
            <a
              href={`/api/preview/anchors/${anchorId}/context`}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "inline-flex items-center gap-1",
                "text-xs font-medium",
                "text-blue-600 dark:text-blue-400 hover:underline",
                "transition-colors",
              )}
            >
              <ExternalLink size={10} />
              View full context
            </a>
          </div>
        </div>
      )}
    </span>
  );
};

export default AnchorHoverCard;
