import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { ChevronDown, Globe, Database, FileText, Search, ChevronRight } from "lucide-react";
import type { AnalysisScope } from "../../types/index";

interface KbDocument {
  id: string;
  filename: string;
  status: string;
}

interface KbEntry {
  id: string;
  name: string;
  documents: KbDocument[];
}

interface ScopeSelectorProps {
  kbList: KbEntry[];
  currentKbId?: string;
  initialScope?: AnalysisScope;
  onScopeChange?: (scope: AnalysisScope) => void;
  /** When true (agent running), the selector is locked to prevent scope
   * changes that the running agent cannot pick up (its scopeKbIds are frozen
   * at task creation time). */
  disabled?: boolean;
}

export function ScopeSelector({ kbList, currentKbId, initialScope, onScopeChange, disabled }: ScopeSelectorProps) {
  const [expanded, setExpanded] = useState(false);
  // Track whether initialScope has been applied to prevent premature scope propagation
  const scopeReadyRef = useRef(false);
  const [selectedKbs, setSelectedKbs] = useState<Set<string>>(() => {
    // Prefer initialScope (from session's kbScope) over currentKbId (from localStorage).
    // This prevents the race where localStorage value overrides the API-set session scope.
    // Support both { knowledgeBases: [{kbId, mode}] } and legacy { kbIds: [...] } formats.
    if (initialScope?.knowledgeBases?.length) {
      return new Set(initialScope.knowledgeBases.map(kb => kb.kbId ?? kb.id).filter((id): id is string => typeof id === "string"));
    }
    if ((initialScope as any)?.kbIds?.length) {
      return new Set((initialScope as any).kbIds);
    }
    return new Set(currentKbId ? [currentKbId] : []);
  });
  const [selectedDocs, setSelectedDocs] = useState<Map<string, Set<string>>>(new Map());
  const [expandedKbs, setExpandedKbs] = useState<Set<string>>(new Set());
  const [webSearch, setWebSearch] = useState(true);
  const [kbModes, setKbModes] = useState<Map<string, "all" | "selected">>(new Map());
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside when expanded as a panel
  useEffect(() => {
    if (!expanded) return;
    const mouseHandler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setExpanded(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("mousedown", mouseHandler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", mouseHandler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [expanded]);

  // When currentKbId changes, add it to selection if empty AND scope not yet ready
  useEffect(() => {
    if (currentKbId && selectedKbs.size === 0 && !scopeReadyRef.current) {
      // Only use currentKbId as fallback if no initialScope was available
      if (!initialScope?.knowledgeBases?.length) {
        setSelectedKbs(new Set([currentKbId]));
      }
    }
  }, [currentKbId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore state from initialScope when it changes (e.g., session switch)
  // Also marks scope as ready so that onScopeChange can start firing.
  // Supports canonical { knowledgeBases: [{kbId, mode}] }, legacy { id, type }, and { kbIds: [...] } formats.
  useEffect(() => {
    const kbIds = initialScope?.knowledgeBases?.length
      ? initialScope.knowledgeBases.map(kb => kb.kbId ?? kb.id).filter((id): id is string => typeof id === "string")
      : (initialScope as any)?.kbIds?.length
        ? (initialScope as any).kbIds
        : null;

    if (!initialScope || !kbIds || kbIds.length === 0) {
      // No scope to restore — mark ready so user changes propagate
      if (!scopeReadyRef.current) scopeReadyRef.current = true;
      return;
    }
    setSelectedKbs(new Set(kbIds));
    const docs = new Map<string, Set<string>>();
    const modes = new Map<string, "all" | "selected">();
    if (initialScope.knowledgeBases?.length) {
      for (const kb of initialScope.knowledgeBases) {
        const id = kb.kbId ?? kb.id;
        if (typeof id !== "string") continue;
        const mode = kb.mode ?? (kb.type === "selected" ? "selected" : "all");
        modes.set(id, mode);
        if (kb.documentIds && kb.documentIds.length > 0) {
          docs.set(id, new Set(kb.documentIds));
        }
      }
    } else {
      // Legacy format: no mode/doc info, default to "all"
      for (const id of kbIds) {
        modes.set(id, "all");
      }
    }
    setSelectedDocs(docs);
    setKbModes(modes);
    setWebSearch(initialScope.webSearch ?? false);
    scopeReadyRef.current = true;
  }, [initialScope]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build scope and notify parent
  const scope = useMemo<AnalysisScope>(() => {
    const knowledgeBases = Array.from(selectedKbs).map((kbId) => ({
      kbId,
      mode: (kbModes.get(kbId) ?? "all") as "all" | "selected",
      documentIds: kbModes.get(kbId) === "selected"
        ? Array.from(selectedDocs.get(kbId) ?? [])
        : undefined,
    }));
    return { knowledgeBases, webSearch };
  }, [selectedKbs, kbModes, selectedDocs, webSearch]);

  // Notify parent of scope changes (skip until initial scope is resolved)
  useEffect(() => {
    if (!scopeReadyRef.current) return;
    onScopeChange?.(scope);
  }, [scope, onScopeChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Summary text for compact mode
  const summaryText = useMemo(() => {
    const parts: string[] = [];
    if (selectedKbs.size > 0) {
      const totalDocs = scope.knowledgeBases.reduce((sum, kb) => {
        const kbData = kbList.find((k) => k.id === kb.kbId);
        return sum + (kb.mode === "all" ? (kbData?.documents.length ?? 0) : (kb.documentIds?.length ?? 0));
      }, 0);
      parts.push(`${selectedKbs.size}个知识库`);
      if (totalDocs > 0) parts.push(`${totalDocs}个文档`);
    }
    if (webSearch) parts.push("网络搜索");
    return parts.length > 0 ? parts.join(", ") : "未选择范围";
  }, [selectedKbs, scope, kbList, webSearch]);

  // Determine icon for compact mode
  const compactIcon = useMemo(() => {
    if (webSearch && selectedKbs.size === 0) return <Globe size={12} />;
    if (selectedKbs.size === 1) return <Database size={12} />;
    if (selectedKbs.size > 1) return <Database size={12} />;
    return <Globe size={12} />;
  }, [selectedKbs, webSearch]);

  const toggleKb = useCallback((kbId: string) => {
    setSelectedKbs((prev) => {
      const next = new Set(prev);
      if (next.has(kbId)) next.delete(kbId);
      else next.add(kbId);
      return next;
    });
  }, []);

  const toggleDoc = useCallback((kbId: string, docId: string) => {
    setSelectedDocs((prev) => {
      const next = new Map(prev);
      const docs = new Set(next.get(kbId) ?? []);
      if (docs.has(docId)) docs.delete(docId);
      else docs.add(docId);
      next.set(kbId, docs);
      return next;
    });
  }, []);

  const setKbMode = useCallback((kbId: string, mode: "all" | "selected") => {
    setKbModes((prev) => {
      const next = new Map(prev);
      next.set(kbId, mode);
      return next;
    });
  }, []);

  const toggleExpandKb = useCallback((kbId: string) => {
    setExpandedKbs((prev) => {
      const next = new Set(prev);
      if (next.has(kbId)) next.delete(kbId);
      else next.add(kbId);
      return next;
    });
  }, []);

  const selectAllInKb = useCallback((kbId: string) => {
    const kb = kbList.find((k) => k.id === kbId);
    if (!kb) return;
    setSelectedDocs((prev) => {
      const next = new Map(prev);
      next.set(kbId, new Set(kb.documents.map((d) => d.id)));
      return next;
    });
    setKbModes((prev) => {
      const next = new Map(prev);
      next.set(kbId, "selected");
      return next;
    });
  }, [kbList]);

  const deselectAllInKb = useCallback((kbId: string) => {
    setSelectedDocs((prev) => {
      const next = new Map(prev);
      next.delete(kbId);
      return next;
    });
  }, []);

  // =====================================================================
  // Collapsed (compact) mode — a button similar to original ScopeSelector
  // =====================================================================
  if (!expanded) {
    return (
      <div ref={ref}>
        <button
          onClick={() => { if (!disabled) setExpanded(true); }}
          disabled={disabled}
          title={disabled ? "Agent 执行中，完成后方可修改分析范围" : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            padding: "4px 8px",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-md)",
            background: "var(--surface-primary)",
            color: "var(--text-secondary)",
            fontSize: "var(--text-xs)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
            transition: "all var(--transition-fast)",
          }}
          onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.borderColor = "var(--interactive)"; }}
          onMouseLeave={(e) => { if (!disabled) e.currentTarget.style.borderColor = "var(--border-primary)"; }}
        >
          {compactIcon}
          {summaryText}
          <ChevronDown
            size={10}
            style={{ transition: "transform var(--transition-fast)" }}
          />
        </button>
      </div>
    );
  }

  // =====================================================================
  // Expanded (panel) mode
  // =====================================================================
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        style={{
          position: "absolute",
          top: "100%",
          right: 0,
          marginTop: 4,
          minWidth: 280,
          maxWidth: 380,
          background: "var(--surface-primary)",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          zIndex: "var(--z-dropdown)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            borderBottom: "1px solid var(--border-primary)",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          <span>分析范围</span>
          <button
            onClick={() => setExpanded(false)}
            style={{
              background: "none",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-sm)",
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
              lineHeight: 1,
            }}
          >
            收起
          </button>
        </div>

        {/* Knowledge base list */}
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          {kbList.length === 0 && (
            <div style={{
              padding: "12px",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
              textAlign: "center" as const,
            }}>
              暂无知识库
            </div>
          )}
          {kbList.map((kb) => {
            const isSelected = selectedKbs.has(kb.id);
            const isExpandedKb = expandedKbs.has(kb.id);
            const mode = kbModes.get(kb.id) ?? "all";
            const selectedDocSet = selectedDocs.get(kb.id) ?? new Set<string>();

            return (
              <div key={kb.id}>
                {/* KB row */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "6px 12px",
                    borderTop: "1px solid var(--border-primary)",
                    background: isSelected ? "var(--bg-hover)" : "transparent",
                    cursor: "pointer",
                    transition: "background var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      e.stopPropagation();
                      toggleKb(kb.id);
                    }}
                    style={{ cursor: "pointer" }}
                  />
                  <span
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      color: "var(--text-primary)",
                      fontSize: "var(--text-xs)",
                      userSelect: "none" as const,
                    }}
                    onClick={() => toggleExpandKb(kb.id)}
                  >
                    <ChevronRight
                      size={10}
                      style={{
                        transition: "transform var(--transition-fast)",
                        transform: isExpandedKb ? "rotate(90deg)" : "rotate(0deg)",
                        flexShrink: 0,
                      }}
                    />
                    {kb.name}
                    <span style={{ color: "var(--text-tertiary)", marginLeft: "auto", fontSize: "var(--text-xs)" }}>
                      {kb.documents?.length ?? 0} 文档
                    </span>
                  </span>
                  {isSelected && (
                    <select
                      value={mode}
                      onChange={(e) => setKbMode(kb.id, e.target.value as "all" | "selected")}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        fontSize: "var(--text-xs)",
                        padding: "1px 4px",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--surface-primary)",
                        cursor: "pointer",
                      }}
                    >
                      <option value="all">全选</option>
                      <option value="selected">指定文档</option>
                    </select>
                  )}
                </div>

                {/* Document list (when expanded and mode is "selected") */}
                {isSelected && isExpandedKb && mode === "selected" && (
                  <div style={{
                    marginLeft: 32,
                    marginTop: 2,
                    marginBottom: 4,
                  }}>
                    <div
                      style={{
                        display: "flex",
                        gap: "var(--space-2)",
                        marginBottom: 4,
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      <button
                        onClick={() => selectAllInKb(kb.id)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--interactive)",
                          padding: 0,
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        全选
                      </button>
                      <button
                        onClick={() => deselectAllInKb(kb.id)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--text-tertiary)",
                          padding: 0,
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        取消全选
                      </button>
                    </div>
                    {(kb.documents?.length ?? 0) === 0 && (
                      <div style={{
                        color: "var(--text-tertiary)",
                        fontSize: "var(--text-xs)",
                        padding: "2px 0",
                      }}>
                        暂无文档
                      </div>
                    )}
                    {kb.documents.map((doc) => (
                      <div
                        key={doc.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--space-1)",
                          padding: "2px 0",
                          fontSize: "var(--text-xs)",
                          color: "var(--text-primary)",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedDocSet.has(doc.id)}
                          onChange={() => toggleDoc(kb.id, doc.id)}
                          style={{ cursor: "pointer" }}
                        />
                        <FileText size={10} style={{ flexShrink: 0, color: "var(--text-tertiary)" }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                          {doc.filename}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Document count summary when expanded but mode is "all" */}
                {isSelected && isExpandedKb && mode === "all" && (kb.documents?.length ?? 0) > 0 && (
                  <div style={{
                    marginLeft: 32,
                    marginTop: 2,
                    marginBottom: 4,
                    color: "var(--text-tertiary)",
                    fontSize: "var(--text-xs)",
                  }}>
                    已选择全部 {kb.documents?.length ?? 0} 个文档
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Web search toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "8px 12px",
            borderTop: "1px solid var(--border-primary)",
            fontSize: "var(--text-xs)",
            color: "var(--text-primary)",
          }}
        >
          <input
            type="checkbox"
            checked={webSearch}
            onChange={(e) => setWebSearch(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          <Search size={12} style={{ color: "var(--text-tertiary)" }} />
          <span>网络搜索</span>
        </div>
      </div>
    </div>
  );
}
