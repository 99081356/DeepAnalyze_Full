// =============================================================================
// DeepAnalyze - Level Switcher Component
// Reusable tab buttons for switching between L0/L1/L2 wiki page levels.
// Persists the user's preferred level in localStorage.
// =============================================================================

import React, { useState, useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LevelSwitcherProps {
  pageId: string;
  kbId: string;
  currentLevel: "L0" | "L1" | "L2";
  availableLevels: Array<"L0" | "L1" | "L2">;
  onLevelChange: (level: "L0" | "L1" | "L2", content: string) => void;
  keywords?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "deepanalyze-default-level";

const LEVEL_CONFIG: Record<
  "L0" | "L1" | "L2",
  { label: string; color: string; activeColor: string }
> = {
  L0: {
    label: "L0 摘要",
    color: "text-green-700 dark:text-green-400",
    activeColor:
      "border-green-500 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400",
  },
  L1: {
    label: "L1 结构",
    color: "text-blue-700 dark:text-blue-400",
    activeColor:
      "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
  },
  L2: {
    label: "L2 原文",
    color: "text-yellow-700 dark:text-yellow-400",
    activeColor:
      "border-yellow-500 bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400",
  },
};

const LEVEL_TO_PAGE_TYPE: Record<"L0" | "L1" | "L2", string> = {
  L0: "abstract",
  L1: "structure_md",  // Server falls back to structure_dt/structure automatically
  L2: "fulltext",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LevelSwitcher: React.FC<LevelSwitcherProps> = ({
  pageId,
  kbId,
  currentLevel,
  availableLevels,
  onLevelChange,
  keywords = [],
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Save default level preference to localStorage
  const savePreference = useCallback((level: "L0" | "L1" | "L2") => {
    try {
      localStorage.setItem(STORAGE_KEY, level);
    } catch {
      // localStorage may not be available (SSR, private browsing, etc.)
    }
  }, []);

  // Load default level preference from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as "L0" | "L1" | "L2" | null;
      if (
        saved &&
        availableLevels.includes(saved) &&
        saved !== currentLevel
      ) {
        // Auto-switch to the saved preferred level
        fetchLevelContent(saved);
      }
    } catch {
      // Ignore
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the content for a given level
  const fetchLevelContent = useCallback(
    async (level: "L0" | "L1" | "L2") => {
      // Abort previous request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      const pageType = LEVEL_TO_PAGE_TYPE[level];

      try {
        const params = new URLSearchParams({ level, pageType });
        if (keywords.length > 0) {
          params.set("q", keywords.join(" "));
        }

        const resp = await fetch(
          `/api/knowledge/kbs/${kbId}/pages/${pageId}?${params}`,
          { signal: controller.signal },
        );

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Failed to load level: ${resp.status} ${text}`);
        }

        const json = await resp.json();
        const content: string = json.content ?? "";

        savePreference(level);
        onLevelChange(level, content);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load level");
      } finally {
        setLoading(false);
      }
    },
    [kbId, pageId, keywords, onLevelChange, savePreference],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleTabClick = useCallback(
    (level: "L0" | "L1" | "L2") => {
      if (level === currentLevel) return;
      fetchLevelContent(level);
    },
    [currentLevel, fetchLevelContent],
  );

  return (
    <div className="inline-flex items-center gap-1">
      {(["L0", "L1", "L2"] as const)
        .filter((lvl) => availableLevels.includes(lvl))
        .map((level) => {
          const config = LEVEL_CONFIG[level];
          const isActive = currentLevel === level;

          return (
            <button
              key={level}
              onClick={() => handleTabClick(level)}
              disabled={loading}
              className={`
                px-3 py-1.5 text-xs font-medium rounded-md border transition-colors
                ${
                  isActive
                    ? `${config.activeColor} border-b-2`
                    : `${config.color} border-transparent hover:bg-gray-100 dark:hover:bg-gray-700`
                }
                ${loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
              `}
            >
              {config.label}
              {loading && isActive && (
                <span className="ml-1 inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin align-middle" />
              )}
            </button>
          );
        })}

      {error && (
        <span className="ml-2 text-[10px] text-red-500 dark:text-red-400">
          {error}
        </span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Utility: read the saved default level preference
// ---------------------------------------------------------------------------

export function getDefaultLevel(): "L0" | "L1" | "L2" | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "L0" || saved === "L1" || saved === "L2") return saved;
  } catch {
    // Ignore
  }
  return null;
}
