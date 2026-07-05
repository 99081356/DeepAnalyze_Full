// =============================================================================
// DeepAnalyze - Hover Preview Card
// Shows a preview of wiki page content when hovering over a search result.
// Fetches content from the preview API on first hover.
// =============================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import DOMPurify from "dompurify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PreviewData {
  title: string;
  level: string;
  tokenCount: number;
  snippet: string;
  availableLevels: Array<"L0" | "L1" | "L2">;
}

interface PreviewCardProps {
  kbId: string;
  pageId: string;
  title: string;
  level: "L0" | "L1" | "L2";
  query: string;
}

// ---------------------------------------------------------------------------
// Level badge config
// ---------------------------------------------------------------------------

const levelBadge: Record<string, { label: string; cls: string }> = {
  L0: {
    label: "L0 摘要",
    cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  L1: {
    label: "L1 概述",
    cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  },
  L2: {
    label: "L2 原文",
    cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  },
};

// ---------------------------------------------------------------------------
// Keyword highlighter
// ---------------------------------------------------------------------------

function highlightKeywords(html: string, keywords: string[]): string {
  if (!keywords.length) return html;

  // Escape special regex characters in keywords
  const escaped = keywords.map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  return html.replace(
    pattern,
    '<mark class="bg-yellow-200 dark:bg-yellow-700/60 rounded px-0.5">$1</mark>',
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PreviewCard: React.FC<PreviewCardProps> = ({
  kbId,
  pageId,
  title,
  level,
  query,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PreviewData | null>(null);
  const fetchedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Build keyword list from query string
  const keywords = query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);

  // Fetch preview data (only once per mount)
  const fetchPreview = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({
        level,
        q: query,
      });

      const resp = await fetch(
        `/api/knowledge/kbs/${kbId}/pages/${pageId}/preview?${params}`,
        { signal: controller.signal },
      );

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Preview failed: ${resp.status} ${text}`);
      }

      const json: PreviewData = await resp.json();
      setData(json);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load preview");
    } finally {
      setLoading(false);
    }
  }, [kbId, pageId, level, query]);

  // Fetch on mount (the parent triggers this on hover)
  useEffect(() => {
    fetchPreview();

    return () => {
      // Abort in-flight request on unmount
      abortRef.current?.abort();
    };
  }, [fetchPreview]);

  // Build full page URL for "open full page" link
  const fullPageUrl = `/api/knowledge/${kbId}/wiki/${encodeURIComponent(pageId)}`;

  const badge = levelBadge[level] ?? levelBadge.L1;

  return (
    <div className="absolute z-50 left-full top-0 ml-2 w-80 max-h-96 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${badge.cls}`}
        >
          {badge.label}
        </span>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1 truncate">
          {title}
        </h4>
        {data && (
          <span className="text-xs text-gray-400">
            {data.tokenCount} tokens
          </span>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
            Loading preview...
          </span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="py-4 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2">
          {error}
        </div>
      )}

      {/* Content */}
      {data && !loading && (
        <>
          {/* Available levels indicator */}
          {data.availableLevels.length > 0 && (
            <div className="flex gap-1 mb-2">
              {data.availableLevels.map((lvl) => (
                <span
                  key={lvl}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    lvl === level
                      ? levelBadge[lvl].cls
                      : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                  }`}
                >
                  {lvl}
                </span>
              ))}
            </div>
          )}

          {/* Snippet with keyword highlights */}
          <div
            className="text-xs text-gray-700 dark:text-gray-300 line-clamp-[12] whitespace-pre-wrap"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(highlightKeywords(data.snippet, keywords)),
            }}
          />
        </>
      )}

      {/* Footer link */}
      <div className="mt-3 pt-2 border-t border-gray-100 dark:border-gray-700">
        <a
          href={fullPageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          打开完整页面
        </a>
      </div>
    </div>
  );
};
