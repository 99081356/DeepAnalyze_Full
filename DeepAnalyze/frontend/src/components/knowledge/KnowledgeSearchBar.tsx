// =============================================================================
// DeepAnalyze - KnowledgeSearchBar
// Unified search bar with mode, topK, and level controls for knowledge search
// =============================================================================

import { useState, useRef, useCallback } from "react";
import { Search, ChevronDown } from "lucide-react";

export type SearchMode = "semantic" | "vector" | "hybrid";

export interface KnowledgeSearchBarProps {
  /** Fired when search query changes (debounced). Empty string = clear. */
  onSearch: (query: string, mode: SearchMode, topK: number, levels: string[]) => void;
  /** Whether a search is in flight. */
  loading?: boolean;
  /** Additional CSS class name. */
  className?: string;
}

export function KnowledgeSearchBar({ onSearch, loading, className }: KnowledgeSearchBarProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("semantic");
  const [topK, setTopK] = useState(10);
  const [levels, setLevels] = useState<string[]>(["L1"]);
  const [showControls, setShowControls] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleChange = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(debounceRef.current);
    if (!value.trim()) {
      onSearch("", mode, topK, levels);
      return;
    }
    debounceRef.current = setTimeout(() => {
      onSearch(value.trim(), mode, topK, levels);
    }, 300);
  }, [mode, topK, levels, onSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && query.trim()) {
      clearTimeout(debounceRef.current);
      onSearch(query.trim(), mode, topK, levels);
    }
  }, [query, mode, topK, levels, onSearch]);

  const toggleLevel = useCallback((level: string) => {
    setLevels((prev) => {
      const next = prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level];
      if (next.length === 0) next.push("L1");
      return next;
    });
  }, []);

  return (
    <div className={className} style={{ position: "relative" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-md)",
        backgroundColor: "var(--bg-tertiary)",
      }}>
        <Search size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索知识库..."
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            backgroundColor: "transparent",
            fontSize: "var(--text-sm)",
            color: "var(--text-primary)",
          }}
        />
        {loading && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            搜索中...
          </span>
        )}
        <button
          onClick={() => setShowControls((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            padding: "var(--space-1) var(--space-2)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-sm)",
            backgroundColor: "transparent",
            color: "var(--text-secondary)",
            fontSize: "var(--text-xs)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {mode === "semantic" ? "语义" : mode === "vector" ? "向量" : "混合"}
          <ChevronDown size={12} />
        </button>
      </div>

      {showControls && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          zIndex: 10,
          marginTop: "var(--space-1)",
          padding: "var(--space-3)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--bg-secondary)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}>
          {/* Search mode */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", width: 48 }}>
              模式
            </span>
            <div style={{ display: "flex", gap: "var(--space-1)" }}>
              {(["semantic", "vector", "hybrid"] as SearchMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: mode === m ? "1px solid var(--interactive)" : "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: mode === m ? "var(--interactive-light)" : "transparent",
                    color: mode === m ? "var(--interactive)" : "var(--text-secondary)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                  }}
                >
                  {m === "semantic" ? "语义检索" : m === "vector" ? "向量检索" : "混合检索"}
                </button>
              ))}
            </div>
          </div>

          {/* TopK */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", width: 48 }}>
              召回数
            </span>
            <div style={{ display: "flex", gap: "var(--space-1)" }}>
              {[5, 10, 20, 50].map((k) => (
                <button
                  key={k}
                  onClick={() => setTopK(k)}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: topK === k ? "1px solid var(--interactive)" : "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: topK === k ? "var(--interactive-light)" : "transparent",
                    color: topK === k ? "var(--interactive)" : "var(--text-secondary)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                  }}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          {/* Levels */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", width: 48 }}>
              层级
            </span>
            <div style={{ display: "flex", gap: "var(--space-1)" }}>
              {["L0", "L1", "L2"].map((level) => (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: levels.includes(level) ? "1px solid var(--interactive)" : "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: levels.includes(level) ? "var(--interactive-light)" : "transparent",
                    color: levels.includes(level) ? "var(--interactive)" : "var(--text-secondary)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                  }}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
