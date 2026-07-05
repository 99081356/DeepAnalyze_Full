// =============================================================================
// DeepAnalyze - LayerPreview Component
// Three-tab preview (Abstract / Structure / Raw) for viewing document content
// at different processing layers. Fetches data from the preview API.
// =============================================================================

import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import { Spinner } from "../ui/Spinner";
import {
  FileText,
  Table,
  Image,
  ChevronRight,
  ChevronDown,
  Layers,
  ListTree,
  Code2,
  Tag,
  BookOpen,
  Loader2,
  AlertCircle,
} from "lucide-react";

// =============================================================================
// Types
// =============================================================================

interface StructureChunk {
  id: string;
  title: string;
  sectionPath?: string;
  pageRange?: string;
  modality?: string;
  anchors?: Array<{
    id: string;
    type: string;
    preview: string;
  }>;
}

interface StructureMap {
  structureMap: StructureChunk[];
}

interface AbstractData {
  content: string;
  metadata: {
    documentType?: string;
    tags?: string[];
    keyDates?: Array<{ date: string; label: string }>;
    toc?: Array<{ title: string; level: number; anchor?: string }>;
  };
}

interface ChunkDetail {
  chunk: {
    id: string;
    title: string;
    content: string;
  };
  anchors?: Array<{
    id: string;
    element_type: string;
    content_preview: string;
  }>;
}

interface RawData {
  content: unknown;
  summary: {
    elementCount: number;
  };
}

interface DisplayInfo {
  originalName?: string;
  kbName?: string;
}

type TabId = "abstract" | "structure" | "raw";

interface LayerPreviewProps {
  kbId: string;
  docId: string;
}

// =============================================================================
// Tab config
// =============================================================================

const TABS: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
  { id: "abstract", label: "Abstract", icon: BookOpen },
  { id: "structure", label: "Structure", icon: ListTree },
  { id: "raw", label: "Raw", icon: Code2 },
];

// =============================================================================
// JSON Tree Viewer (collapsible)
// =============================================================================

interface JsonTreeNodeProps {
  name?: string;
  value: unknown;
  depth: number;
  defaultExpanded?: boolean;
}

function JsonTreeNode({ name, value, depth, defaultExpanded = false }: JsonTreeNodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const isArray = Array.isArray(value);

  if (isObject || isArray) {
    const entries = isArray
      ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>);

    const count = entries.length;

    return (
      <div className="ml-0">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 font-mono w-full text-left py-0.5 group"
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-gray-400" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-gray-400" />
          )}
          {name !== undefined && (
            <span className="text-purple-600 dark:text-purple-400">{name}</span>
          )}
          {name !== undefined && <span className="text-gray-400">: </span>}
          <span className="text-gray-400 text-xs">
            {isArray ? `Array(${count})` : `{${count}}`}
          </span>
        </button>

        {expanded && (
          <div className="ml-4 border-l border-gray-200 dark:border-gray-700 pl-2">
            {entries.map(([key, val]) => (
              <JsonTreeNode key={key} name={isArray ? undefined : key} value={val} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Primitive value
  let valueColor = "text-green-600 dark:text-green-400";
  let displayValue: string;

  if (typeof value === "string") {
    displayValue = `"${value.length > 200 ? value.slice(0, 200) + "..." : value}"`;
    valueColor = "text-green-600 dark:text-green-400";
  } else if (typeof value === "number") {
    displayValue = String(value);
    valueColor = "text-blue-600 dark:text-blue-400";
  } else if (typeof value === "boolean") {
    displayValue = String(value);
    valueColor = "text-amber-600 dark:text-amber-400";
  } else if (value === null) {
    displayValue = "null";
    valueColor = "text-gray-400";
  } else {
    displayValue = String(value);
  }

  return (
    <div className="flex items-start gap-1 text-sm font-mono py-0.5 ml-0">
      {expanded ? (
        <ChevronDown size={14} className="shrink-0 text-gray-400 mt-0.5 invisible" />
      ) : (
        <ChevronRight size={14} className="shrink-0 text-gray-400 mt-0.5 invisible" />
      )}
      {name !== undefined && (
        <span className="text-purple-600 dark:text-purple-400">{name}</span>
      )}
      {name !== undefined && <span className="text-gray-400">: </span>}
      <span className={valueColor}>{displayValue}</span>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function LayerPreview({ kbId, docId }: LayerPreviewProps) {
  // --- State ---
  const [activeTab, setActiveTab] = useState<TabId>("abstract");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Structure map (fetched on mount, used by Structure tab)
  const [structureMap, setStructureMap] = useState<StructureChunk[]>([]);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [chunkDetail, setChunkDetail] = useState<ChunkDetail | null>(null);
  const [isLoadingChunk, setIsLoadingChunk] = useState(false);

  // Abstract data (lazy)
  const [abstractData, setAbstractData] = useState<AbstractData | null>(null);
  const [isLoadingAbstract, setIsLoadingAbstract] = useState(false);

  // Raw data (lazy)
  const [rawData, setRawData] = useState<RawData | null>(null);
  const [isLoadingRaw, setIsLoadingRaw] = useState(false);

  // Display info
  const [displayInfo, setDisplayInfo] = useState<DisplayInfo>({});

  // --- Fetch structure map on mount ---
  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const map = await api.get<StructureMap>(
          `/api/preview/kbs/${kbId}/documents/${docId}/structure-map`,
        );
        if (!cancelled) {
          setStructureMap(map.structureMap ?? []);
        }

        // Attempt to get display info via the documents list
        try {
          const docs = await api.listDocuments(kbId);
          const doc = docs.find((d) => d.id === docId);
          if (doc) {
            setDisplayInfo({
              originalName: ("originalName" in doc ? (doc as unknown as Record<string, unknown>).originalName as string : undefined) ?? doc.filename,
              kbName: undefined,
            });
          }
        } catch {
          // Display info is optional
        }

        // Also try to get kb name
        try {
          const kbs = await api.listKnowledgeBases();
          const kb = kbs.find((k) => k.id === kbId);
          if (kb) {
            setDisplayInfo((prev) => ({ ...prev, kbName: kb.name }));
          }
        } catch {
          // KB name is optional
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load preview data");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [kbId, docId]);

  // --- Lazy fetch abstract data ---
  const fetchAbstract = useCallback(async () => {
    if (abstractData) return;
    setIsLoadingAbstract(true);
    try {
      const data = await api.get<AbstractData>(
        `/api/preview/kbs/${kbId}/documents/${docId}/preview/abstract`,
      );
      setAbstractData(data);
    } catch (err) {
      // Abstract may not exist for all documents
      setAbstractData({
        content: "No abstract available for this document.",
        metadata: {},
      });
    } finally {
      setIsLoadingAbstract(false);
    }
  }, [kbId, docId, abstractData]);

  // --- Lazy fetch raw data ---
  const fetchRaw = useCallback(async () => {
    if (rawData) return;
    setIsLoadingRaw(true);
    try {
      const data = await api.get<RawData>(
        `/api/preview/kbs/${kbId}/documents/${docId}/preview/raw`,
      );
      setRawData(data);
    } catch (err) {
      setRawData({ content: { error: "Raw data not available" }, summary: { elementCount: 0 } });
    } finally {
      setIsLoadingRaw(false);
    }
  }, [kbId, docId, rawData]);

  // --- Fetch chunk detail ---
  const fetchChunkDetail = useCallback(
    async (chunkId: string) => {
      setIsLoadingChunk(true);
      setSelectedChunkId(chunkId);
      try {
        const data = await api.get<ChunkDetail>(
          `/api/preview/kbs/${kbId}/documents/${docId}/preview/structure?chunkId=${chunkId}`,
        );
        setChunkDetail(data);
      } catch {
        setChunkDetail(null);
      } finally {
        setIsLoadingChunk(false);
      }
    },
    [kbId, docId],
  );

  // --- Trigger lazy loads when switching tabs ---
  useEffect(() => {
    if (activeTab === "abstract") fetchAbstract();
    if (activeTab === "raw") fetchRaw();
  }, [activeTab, fetchAbstract, fetchRaw]);

  // Auto-select first chunk in structure tab
  useEffect(() => {
    if (activeTab === "structure" && !selectedChunkId && structureMap.length > 0) {
      fetchChunkDetail(structureMap[0].id);
    }
  }, [activeTab, selectedChunkId, structureMap, fetchChunkDetail]);

  // =====================================================================
  // Render: Loading / Error shell
  // =====================================================================

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-gray-900">
        <div className="flex items-center justify-center flex-1">
          <Spinner size="lg" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-gray-900">
        <div className="flex flex-col items-center justify-center flex-1 text-center p-8">
          <AlertCircle size={40} className="text-red-400 mb-3" />
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  // =====================================================================
  // Render: Abstract Tab
  // =====================================================================

  const renderAbstractTab = () => {
    if (isLoadingAbstract) {
      return (
        <div className="flex items-center justify-center py-12">
          <Spinner size="md" />
        </div>
      );
    }

    if (!abstractData) return null;

    const { content, metadata } = abstractData;

    return (
      <div className="p-4 space-y-5">
        {/* Document type badge */}
        {metadata.documentType && (
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-gray-400" />
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              {metadata.documentType}
            </span>
          </div>
        )}

        {/* Summary content */}
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
            {content}
          </div>
        </div>

        {/* Tags */}
        {metadata.tags && metadata.tags.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              <Tag size={12} />
              Tags
            </div>
            <div className="flex flex-wrap gap-1.5">
              {metadata.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border border-gray-200 dark:border-gray-700"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Key dates */}
        {metadata.keyDates && metadata.keyDates.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Key Dates
            </div>
            <div className="space-y-1">
              {metadata.keyDates.map((kd, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                >
                  <span className="font-mono text-xs text-gray-500 dark:text-gray-400 min-w-[100px]">
                    {kd.date}
                  </span>
                  <span>{kd.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Table of Contents */}
        {metadata.toc && metadata.toc.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              <ListTree size={12} />
              Table of Contents
            </div>
            <nav className="space-y-0.5">
              {metadata.toc.map((entry, i) => {
                const handleClick = () => {
                  // If a structure chunk matches this TOC title, switch to structure tab and select it
                  const matching = structureMap.find(
                    (c) =>
                      c.title === entry.title ||
                      c.sectionPath?.endsWith(entry.title),
                  );
                  if (matching) {
                    setActiveTab("structure");
                    fetchChunkDetail(matching.id);
                  }
                };

                return (
                  <button
                    key={i}
                    type="button"
                    onClick={handleClick}
                    className="w-full text-left flex items-center gap-2 px-2 py-1 rounded text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors group"
                    style={{ paddingLeft: `${entry.level * 12 + 8}px` }}
                  >
                    <ChevronRight
                      size={12}
                      className="shrink-0 text-gray-300 dark:text-gray-600 group-hover:text-blue-400"
                    />
                    <span className="truncate">{entry.title}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        )}
      </div>
    );
  };

  // =====================================================================
  // Render: Structure Tab
  // =====================================================================

  const renderStructureTab = () => {
    return (
      <div className="flex h-full min-h-0">
        {/* Sidebar: chunk list */}
        <div className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 overflow-y-auto">
          <div className="p-2">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide px-2 py-1.5 mb-1">
              Chunks ({structureMap.length})
            </div>
            {structureMap.map((chunk) => {
              const isSelected = chunk.id === selectedChunkId;
              const hasTable = chunk.modality === "table" || (chunk.anchors?.some((a) => a.type === "table") ?? false);
              const hasImage = chunk.modality === "image" || (chunk.anchors?.some((a) => a.type === "image") ?? false);

              return (
                <button
                  key={chunk.id}
                  type="button"
                  onClick={() => fetchChunkDetail(chunk.id)}
                  className={`
                    w-full text-left px-2.5 py-2 rounded-md text-sm mb-0.5 transition-colors
                    ${
                      isSelected
                        ? "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-200 border border-blue-200 dark:border-blue-800"
                        : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 border border-transparent"
                    }
                  `}
                >
                  <div className="font-medium truncate text-xs leading-tight">
                    {chunk.title}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {chunk.sectionPath && (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate max-w-[120px]">
                        {chunk.sectionPath}
                      </span>
                    )}
                    {chunk.pageRange && (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
                        p.{chunk.pageRange}
                      </span>
                    )}
                    {hasTable && (
                      <Table size={10} className="shrink-0 text-amber-500" />
                    )}
                    {hasImage && (
                      <Image size={10} className="shrink-0 text-emerald-500" />
                    )}
                  </div>
                  {chunk.anchors && chunk.anchors.length > 0 && (
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[10px] text-gray-400 dark:text-gray-500">
                        {chunk.anchors.length} anchor{chunk.anchors.length > 1 ? "s" : ""}
                      </span>
                    </div>
                  )}
                </button>
              );
            })}

            {structureMap.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-gray-400 dark:text-gray-500">
                No structure chunks found
              </div>
            )}
          </div>
        </div>

        {/* Main: selected chunk content */}
        <div className="flex-1 overflow-y-auto min-w-0">
          {isLoadingChunk ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="md" />
            </div>
          ) : chunkDetail ? (
            <div className="p-4 space-y-4">
              {/* Chunk header */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {chunkDetail.chunk.title}
                </h3>
              </div>

              {/* Chunk content */}
              <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                {chunkDetail.chunk.content}
              </div>

              {/* Anchors */}
              {chunkDetail.anchors && chunkDetail.anchors.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Anchors
                  </div>
                  <div className="space-y-1.5">
                    {chunkDetail.anchors.map((anchor) => (
                      <div
                        key={anchor.id}
                        className="flex items-start gap-2 px-3 py-2 rounded-md bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700"
                      >
                        <div className="shrink-0 mt-0.5">
                          {anchor.element_type === "table" ? (
                            <Table size={14} className="text-amber-500" />
                          ) : anchor.element_type === "image" ? (
                            <Image size={14} className="text-emerald-500" />
                          ) : (
                            <FileText size={14} className="text-blue-500" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                            {anchor.element_type}
                          </span>
                          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 line-clamp-3">
                            {anchor.content_preview}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : selectedChunkId ? (
            <div className="flex items-center justify-center py-12 text-sm text-gray-400 dark:text-gray-500">
              Chunk not found
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-sm text-gray-400 dark:text-gray-500">
              <ListTree size={32} className="mb-2 opacity-40" />
              Select a chunk from the sidebar
            </div>
          )}
        </div>
      </div>
    );
  };

  // =====================================================================
  // Render: Raw Tab
  // =====================================================================

  const renderRawTab = () => {
    if (isLoadingRaw) {
      return (
        <div className="flex items-center justify-center py-12">
          <Spinner size="md" />
        </div>
      );
    }

    if (!rawData) return null;

    return (
      <div className="p-4 space-y-3">
        {/* Summary bar */}
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span className="flex items-center gap-1">
            <Code2 size={12} />
            {rawData.summary.elementCount} elements
          </span>
        </div>

        {/* JSON tree */}
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 p-3 overflow-x-auto max-h-[calc(100vh-250px)] overflow-y-auto">
          <JsonTreeNode name="root" value={rawData.content} depth={0} defaultExpanded />
        </div>
      </div>
    );
  };

  // =====================================================================
  // Main Render
  // =====================================================================

  const tabContentMap: Record<TabId, () => React.ReactNode> = {
    abstract: renderAbstractTab,
    structure: renderStructureTab,
    raw: renderRawTab,
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* ================================================================ */}
      {/* Header: display info + tab bar                                   */}
      {/* ================================================================ */}
      <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        {/* Display info */}
        <div className="flex items-center gap-2 px-4 pt-3 pb-1">
          <FileText size={14} className="text-gray-400 dark:text-gray-500 shrink-0" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {displayInfo.originalName ?? docId}
          </span>
          {displayInfo.kbName && (
            <>
              <span className="text-gray-300 dark:text-gray-600">/</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {displayInfo.kbName}
              </span>
            </>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-0 px-4 pt-1">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`
                  flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors
                  ${
                    isActive
                      ? "border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400"
                      : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600"
                  }
                `}
              >
                <Icon size={14} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ================================================================ */}
      {/* Tab content                                                      */}
      {/* ================================================================ */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tabContentMap[activeTab]()}
      </div>
    </div>
  );
}

export default LayerPreview;
