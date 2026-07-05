// =============================================================================
// DeepAnalyze - Search Test Panel
// A diagnostic interface for comparing different search methods side-by-side:
// Vector (semantic), BM25 (full-text), and Grep (exact match).
// Supports RRF (Reciprocal Rank Fusion) when multiple methods are selected.
// =============================================================================

import React, { useState, useCallback, useRef, useMemo } from "react";
import { Search, Download, Check, Loader2 } from "lucide-react";
import { api } from "../../api/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SearchMethod = "vector" | "bm25" | "grep";
type SearchLayer = "abstract" | "structure";

interface TestResultItem {
  originalName: string;
  title: string;
  score: number;
  snippet?: string;
  docId?: string;
  kbId?: string;
  pageId?: string;
}

interface MethodResult {
  method: SearchMethod;
  results: TestResultItem[];
  durationMs: number;
}

interface RrfResult {
  results: TestResultItem[];
  durationMs: number;
}

interface TestResponse {
  query: string;
  methods: MethodResult[];
  rrf?: RrfResult;
}

interface SearchTestPanelProps {
  kbIds?: string[];
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METHOD_CONFIG: Record<
  SearchMethod,
  { label: string; description: string; badgeColor: string }
> = {
  vector: {
    label: "Vector",
    description: "Semantic search via embeddings",
    badgeColor:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  },
  bm25: {
    label: "BM25",
    description: "Full-text search via BM25",
    badgeColor:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  grep: {
    label: "Grep",
    description: "Exact match via regex/grep",
    badgeColor:
      "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  },
};

const LAYER_OPTIONS: { value: SearchLayer; label: string }[] = [
  { value: "abstract", label: "Abstract" },
  { value: "structure", label: "Structure" },
];

const ALL_METHODS: SearchMethod[] = ["vector", "bm25", "grep"];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const MethodBadge: React.FC<{ method: SearchMethod }> = ({ method }) => {
  const config = METHOD_CONFIG[method];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${config.badgeColor}`}
    >
      {config.label}
    </span>
  );
};

const ResultCard: React.FC<{
  item: TestResultItem;
  method: SearchMethod;
  onPreview?: () => void;
}> = ({ item, method, onPreview }) => {
  return (
    <div className="p-3 border rounded-lg bg-white dark:bg-gray-800 dark:border-gray-700 hover:shadow-sm transition-shadow">
      <div className="flex items-center gap-2 mb-1">
        <MethodBadge method={method} />
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
          {item.title || item.originalName}
        </h4>
      </div>
      {item.originalName && item.title && item.originalName !== item.title && (
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1 truncate">
          {item.originalName}
        </div>
      )}
      <div className="flex items-center justify-between mt-1">
        <span className="text-xs text-gray-400">
          Score: {typeof item.score === "number" ? item.score.toFixed(4) : item.score}
        </span>
        {onPreview && (
          <button
            onClick={onPreview}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
          >
            <Search className="w-3 h-3" />
            Preview
          </button>
        )}
      </div>
      {item.snippet && (
        <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 line-clamp-3">
          {item.snippet}
        </div>
      )}
    </div>
  );
};

const MethodColumn: React.FC<{
  methodResult: MethodResult;
  onPreview?: (item: TestResultItem) => void;
}> = ({ methodResult, onPreview }) => {
  const config = METHOD_CONFIG[methodResult.method];
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <MethodBadge method={methodResult.method} />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {config.description}
        </span>
        <span className="text-xs text-gray-400 ml-auto">
          {methodResult.results.length} result
          {methodResult.results.length !== 1 ? "s" : ""} &middot;{" "}
          {methodResult.durationMs}ms
        </span>
      </div>
      <div className="space-y-2">
        {methodResult.results.length === 0 && (
          <div className="text-xs text-gray-400 dark:text-gray-500 text-center py-6">
            No results found
          </div>
        )}
        {methodResult.results.map((item, idx) => (
          <ResultCard
            key={`${item.docId ?? item.originalName}-${idx}`}
            item={item}
            method={methodResult.method}
            onPreview={onPreview ? () => onPreview(item) : undefined}
          />
        ))}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const SearchTestPanel: React.FC<SearchTestPanelProps> = ({
  kbIds: propKbIds,
  className = "",
}) => {
  // --- State ---
  const [query, setQuery] = useState("");
  const [selectedMethods, setSelectedMethods] = useState<SearchMethod[]>([
    "vector",
  ]);
  const [layer, setLayer] = useState<SearchLayer>("abstract");
  const [topK, setTopK] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<TestResponse | null>(null);
  const [previewingItem, setPreviewingItem] = useState<TestResultItem | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);

  // Use prop kbIds or empty array
  const kbIds = useMemo(() => propKbIds ?? [], [propKbIds]);

  // --- Handlers ---

  const toggleMethod = useCallback((method: SearchMethod) => {
    setSelectedMethods((prev) => {
      if (prev.includes(method)) {
        return prev.filter((m) => m !== method);
      }
      return [...prev, method];
    });
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    if (selectedMethods.length === 0) {
      setError("Select at least one search method");
      return;
    }

    // Abort previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setResponse(null);
    setPreviewingItem(null);

    try {
      const data = await api.post<TestResponse>("/api/search-test/test", {
        query: query.trim(),
        kbIds,
        methods: selectedMethods,
        layer,
        topK,
      });
      setResponse(data);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Search test failed");
    } finally {
      setLoading(false);
    }
  }, [query, selectedMethods, kbIds, layer, topK]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleSearch();
      }
    },
    [handleSearch],
  );

  const handleExport = useCallback(() => {
    if (!response) return;
    const blob = new Blob([JSON.stringify(response, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `search-test-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [response]);

  // --- Render ---

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* ===== Search Input Area ===== */}
      <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-gray-700 space-y-3">
        {/* Query Row */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter search query..."
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={loading || !query.trim() || selectedMethods.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Search
          </button>
        </div>

        {/* Options Row */}
        <div className="flex flex-wrap items-center gap-4">
          {/* Method Checkboxes */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Methods
            </span>
            {ALL_METHODS.map((method) => {
              const config = METHOD_CONFIG[method];
              const checked = selectedMethods.includes(method);
              return (
                <label
                  key={method}
                  className={`
                    inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer border transition-colors
                    ${
                      checked
                        ? "border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-600"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                    }
                  `}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleMethod(method)}
                    className="sr-only"
                  />
                  <span
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                      checked
                        ? "bg-blue-600 border-blue-600"
                        : "border-gray-300 dark:border-gray-500"
                    }`}
                  >
                    {checked && <Check className="w-2.5 h-2.5 text-white" />}
                  </span>
                  {config.label}
                </label>
              );
            })}
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-gray-200 dark:bg-gray-600" />

          {/* Layer Selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Layer
            </span>
            <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-600 overflow-hidden">
              {LAYER_OPTIONS.map((opt) => {
                const isActive = layer === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setLayer(opt.value)}
                    className={`
                      px-3 py-1.5 text-xs font-medium transition-colors
                      ${
                        isActive
                          ? "bg-blue-600 text-white"
                          : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                      }
                    `}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-gray-200 dark:bg-gray-600" />

          {/* Top-K */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Top-K
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={topK}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val > 0) setTopK(val);
              }}
              className="w-16 px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* KB IDs indicator */}
        {kbIds.length > 0 && (
          <div className="text-xs text-gray-400 dark:text-gray-500">
            Knowledge Bases: {kbIds.join(", ")}
          </div>
        )}
      </div>

      {/* ===== Results Area ===== */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Error */}
        {error && (
          <div className="p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg">
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !response && !error && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="w-10 h-10 text-gray-300 dark:text-gray-600 mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Enter a query and select search methods to compare results
            </p>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-16">
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Running search tests...
            </p>
          </div>
        )}

        {/* Method Comparison Columns */}
        {response && response.methods.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Method Comparison
              </h3>
              <span className="text-xs text-gray-400">
                Query: &ldquo;{response.query}&rdquo;
              </span>
            </div>
            <div className="flex gap-4 overflow-x-auto">
              {response.methods.map((mr) => (
                <MethodColumn
                  key={mr.method}
                  methodResult={mr}
                  onPreview={(item) => setPreviewingItem(item)}
                />
              ))}
            </div>
          </div>
        )}

        {/* RRF Fusion Results */}
        {response?.rrf && response.rrf.results.length > 0 && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                RRF Fusion
              </span>
              <span className="text-xs text-gray-400">
                Reciprocal Rank Fusion &middot; {response.rrf.results.length}{" "}
                results &middot; {response.rrf.durationMs}ms
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {response.rrf.results.map((item, idx) => (
                <ResultCard
                  key={`rrf-${item.docId ?? item.originalName}-${idx}`}
                  item={item}
                  method={selectedMethods[0]}
                  onPreview={() => setPreviewingItem(item)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Export button */}
        {response && (
          <div className="flex justify-end">
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
          </div>
        )}
      </div>

      {/* ===== Preview Overlay ===== */}
      {previewingItem && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
          onClick={() => setPreviewingItem(null)}
        >
          <div
            className="w-full max-w-lg max-h-[80vh] bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Preview Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                {previewingItem.title || previewingItem.originalName}
              </h3>
              <button
                onClick={() => setPreviewingItem(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
              >
                Close
              </button>
            </div>

            {/* Preview Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">
                    Title
                  </span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {previewingItem.title}
                  </span>
                </div>
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">
                    Original Name
                  </span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {previewingItem.originalName}
                  </span>
                </div>
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">
                    Score
                  </span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {typeof previewingItem.score === "number"
                      ? previewingItem.score.toFixed(4)
                      : previewingItem.score}
                  </span>
                </div>
                {previewingItem.docId && (
                  <div>
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">
                      Document ID
                    </span>
                    <span className="text-gray-900 dark:text-gray-100 break-all text-xs">
                      {previewingItem.docId}
                    </span>
                  </div>
                )}
              </div>
              {previewingItem.snippet && (
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">
                    Snippet
                  </span>
                  <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-md text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap max-h-60 overflow-y-auto">
                    {previewingItem.snippet}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchTestPanel;
