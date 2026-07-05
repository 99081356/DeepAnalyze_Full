// =============================================================================
// DeepAnalyze - Unified Search Component
// Multi-level (L0/L1/L2) search with keyword highlighting and entity discovery.
// =============================================================================

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { SearchResultCard } from "./SearchResultCard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeveledResult {
  pageId: string;
  title: string;
  snippet: string;
  highlights: Array<{ text: string; position: number }>;
  level: "L0" | "L1" | "L2";
  score: number;
  kbId: string;
  docId?: string;
}

interface EntityResult {
  name: string;
  type: string;
  count: number;
  relatedPages: string[];
}

interface SearchResponse {
  query: string;
  kbId: string;
  results: {
    L0?: LeveledResult[];
    L1?: LeveledResult[];
    L2?: LeveledResult[];
    entities?: EntityResult[];
  };
  totalFound: number;
}

type TabKey = "L0" | "L1" | "L2" | "entities";

interface TabConfig {
  key: TabKey;
  label: string;
  color: string;
  activeColor: string;
}

interface UnifiedSearchProps {
  kbId: string;
  onResultClick?: (result: LeveledResult) => void;
  onEntityClick?: (entity: EntityResult) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: TabConfig[] = [
  { key: "L0", label: "L0 摘要", color: "text-green-700 dark:text-green-400", activeColor: "border-green-500 text-green-700 dark:text-green-400" },
  { key: "L1", label: "L1 概述", color: "text-blue-700 dark:text-blue-400", activeColor: "border-blue-500 text-blue-700 dark:text-blue-400" },
  { key: "L2", label: "L2 原文", color: "text-yellow-700 dark:text-yellow-400", activeColor: "border-yellow-500 text-yellow-700 dark:text-yellow-400" },
  { key: "entities", label: "Entities", color: "text-purple-700 dark:text-purple-400", activeColor: "border-purple-500 text-purple-700 dark:text-purple-400" },
];

const DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const UnifiedSearch: React.FC<UnifiedSearchProps> = ({
  kbId,
  onResultClick,
  onEntityClick,
  className = "",
}) => {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResponse["results"]>({});
  const [totalFound, setTotalFound] = useState(0);
  const [activeTab, setActiveTab] = useState<TabKey>("L0");
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-select the first tab that has results
  useEffect(() => {
    const tabOrder: TabKey[] = ["L0", "L1", "L2", "entities"];
    const currentResults = tabOrder.filter((key) => {
      const data = results[key];
      return Array.isArray(data) && data.length > 0;
    });

    if (currentResults.length > 0 && !currentResults.includes(activeTab)) {
      setActiveTab(currentResults[0]);
    }
  }, [results]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const doSearch = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim()) {
        setResults({});
        setTotalFound(0);
        setError(null);
        return;
      }

      // Abort previous request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          query: searchQuery,
          levels: "L0,L1,L2",
          includeEntities: "true",
          topK: "10",
        });

        const resp = await fetch(
          `/api/search/knowledge/${kbId}/search?${params}`,
          { signal: controller.signal },
        );

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Search failed: ${resp.status} ${text}`);
        }

        const data: SearchResponse = await resp.json();
        setResults(data.results ?? {});
        setTotalFound(data.totalFound ?? 0);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Search failed");
        setResults({});
        setTotalFound(0);
      } finally {
        setLoading(false);
      }
    },
    [kbId],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);

      // Debounce the search
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        doSearch(value);
      }, DEBOUNCE_MS);
    },
    [doSearch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        doSearch(query);
      }
    },
    [doSearch, query],
  );

  // Count results per tab
  const tabCounts = useMemo(() => {
    const counts: Record<TabKey, number> = { L0: 0, L1: 0, L2: 0, entities: 0 };
    for (const key of Object.keys(results) as TabKey[]) {
      const data = results[key];
      counts[key] = Array.isArray(data) ? data.length : 0;
    }
    return counts;
  }, [results]);

  // Current tab results
  const currentResults = useMemo(() => {
    return (results[activeTab] ?? []) as LeveledResult[] | EntityResult[];
  }, [results, activeTab]);

  const activeTabConfig = TABS.find((t) => t.key === activeTab)!;

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Search Input */}
      <div className="flex-shrink-0 p-3">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Search knowledge base..."
            className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {loading && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      </div>

      {/* Level Tabs */}
      {totalFound > 0 && (
        <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 px-3">
          <div className="flex gap-1">
            {TABS.map((tab) => {
              const count = tabCounts[tab.key];
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`
                    px-3 py-2 text-xs font-medium border-b-2 transition-colors
                    ${isActive
                      ? `${tab.activeColor} border-b-2`
                      : `${tab.color} border-transparent opacity-60 hover:opacity-100`
                    }
                  `}
                >
                  {tab.label}
                  {count > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-[10px]">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <div className="p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg">
            {error}
          </div>
        )}

        {!loading && query.trim() && totalFound === 0 && !error && (
          <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
            No results found for &ldquo;{query}&rdquo;
          </div>
        )}

        {!query.trim() && (
          <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
            Enter a search query to search across all levels
          </div>
        )}

        {/* Leveled results (L0, L1, L2) */}
        {(activeTab === "L0" || activeTab === "L1" || activeTab === "L2") &&
          (currentResults as LeveledResult[]).map((result) => (
            <SearchResultCard
              key={result.pageId}
              pageId={result.pageId}
              title={result.title}
              snippet={result.snippet}
              level={result.level}
              score={result.score}
              kbId={result.kbId}
              docId={result.docId}
              onClick={() => onResultClick?.(result)}
            />
          ))}

        {/* Entity results */}
        {activeTab === "entities" &&
          (currentResults as EntityResult[]).map((entity) => (
            <div
              key={entity.name}
              onClick={() => onEntityClick?.(entity)}
              className="p-3 border rounded-lg hover:shadow-md transition-shadow cursor-pointer bg-white dark:bg-gray-800 dark:border-gray-700"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                  {entity.type}
                </span>
                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
                  {entity.name}
                </h4>
                <span className="text-xs text-gray-400">
                  {entity.count} mention{entity.count !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400">
                Related pages: {entity.relatedPages.length}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
};
