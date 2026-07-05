// =============================================================================
// DeepAnalyze - DocumentTree
// Tree view component for displaying documents in their folder hierarchy.
// Groups documents by folderPath into expandable/collapsible tree nodes.
// =============================================================================

import { useState, useMemo, useEffect } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { DocumentInfo } from "../../types/index";
import { DocumentCard } from "./DocumentCard";
import type { ProcessingInfo, LevelReadiness } from "./DocumentCard";

// ---------------------------------------------------------------------------
// Tree node data structure
// ---------------------------------------------------------------------------

interface TreeNode {
  type: "folder" | "file";
  name: string;
  path: string;
  children?: TreeNode[];
  doc?: DocumentInfo;
  stats?: {
    total: number;
    ready: number;
    processing: number;
    error: number;
  };
}

// ---------------------------------------------------------------------------
// buildTree — convert flat document list to tree structure
// ---------------------------------------------------------------------------

function buildTree(documents: DocumentInfo[]): TreeNode[] {
  const root: TreeNode = { type: "folder", name: "", path: "", children: [] };

  for (const doc of documents) {
    const parts = doc.folderPath ? doc.folderPath.split("/") : [];
    let current = root;

    // Walk/create folder nodes
    for (let i = 0; i < parts.length; i++) {
      const folderName = parts[i];
      const folderPath = parts.slice(0, i + 1).join("/");

      let child = current.children?.find(
        (c) => c.type === "folder" && c.name === folderName
      );
      if (!child) {
        child = { type: "folder", name: folderName, path: folderPath, children: [] };
        if (!current.children) current.children = [];
        current.children.push(child);
      }
      current = child;
    }

    // Add file node
    if (!current.children) current.children = [];
    current.children.push({
      type: "file",
      name: doc.filename,
      path: doc.folderPath ? `${doc.folderPath}/${doc.filename}` : doc.filename,
      doc,
    });
  }

  // Sort: folders first (alphabetically), then files (alphabetically)
  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    }).map((node) => {
      if (node.children) {
        return { ...node, children: sortNodes(node.children) };
      }
      return node;
    });
  };

  // Compute stats for each folder
  const computeStats = (node: TreeNode): { total: number; ready: number; processing: number; error: number } => {
    if (node.type === "file" && node.doc) {
      const d = node.doc;
      return {
        total: 1,
        ready: d.status === "ready" ? 1 : 0,
        processing: ["parsing", "compiling", "indexing", "linking"].includes(d.status) ? 1 : 0,
        error: d.status === "error" ? 1 : 0,
      };
    }
    let total = 0, ready = 0, processing = 0, error = 0;
    for (const child of node.children || []) {
      const s = computeStats(child);
      total += s.total;
      ready += s.ready;
      processing += s.processing;
      error += s.error;
    }
    node.stats = { total, ready, processing, error };
    return { total, ready, processing, error };
  };

  // Remove empty folders (no file descendants)
  const pruneEmpty = (node: TreeNode): boolean => {
    if (node.type === "file") return true;
    if (!node.children) return false;
    node.children = node.children.filter(pruneEmpty);
    return node.children.length > 0;
  };

  sortNodes(root.children || []);
  pruneEmpty(root);
  if (root.children) {
    for (const child of root.children) {
      computeStats(child);
    }
  }

  return root.children || [];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DocumentTreeProps {
  documents: DocumentInfo[];
  kbId: string;
  selectedDocs: Set<string>;
  processingDocs: Map<string, ProcessingInfo>;
  levelReadiness: Map<string, LevelReadiness>;
  onToggleSelect: (docId: string) => void;
  onDelete: (docId: string) => void;
  onRetry: (docId: string, processor?: string) => void;
  /** When set, the matching DocumentCard auto-expands to L1. */
  highlightDocId?: string;
}

// ---------------------------------------------------------------------------
// FolderNode component
// ---------------------------------------------------------------------------

function FolderNode({
  node,
  expandedPaths,
  setExpandedPaths,
  ...cardProps
}: {
  node: TreeNode;
  expandedPaths: Set<string>;
  setExpandedPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
} & Omit<DocumentTreeProps, "documents">) {
  const isExpanded = expandedPaths.has(node.path);
  const stats = node.stats;

  const toggleExpand = () => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        next.delete(node.path);
      } else {
        next.add(node.path);
      }
      return next;
    });
  };

  // Status badge text
  const badgeText = stats
    ? stats.ready === stats.total
      ? `${stats.total} 就绪`
      : `${stats.ready}/${stats.total} 就绪`
    : "";

  const hasErrors = stats && stats.error > 0;

  return (
    <div>
      {/* Folder row */}
      <div
        onClick={toggleExpand}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          cursor: "pointer",
          borderRadius: "var(--radius-md)",
          backgroundColor: isExpanded ? "var(--bg-tertiary)" : "transparent",
          transition: "background-color 0.15s",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-tertiary)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
          }
        }}
      >
        {/* Chevron */}
        <ChevronRight
          size={14}
          style={{
            transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
        />
        {/* Folder icon */}
        {isExpanded ? (
          <FolderOpen size={16} style={{ color: "var(--accent-primary)", flexShrink: 0 }} />
        ) : (
          <Folder size={16} style={{ color: "var(--accent-primary)", flexShrink: 0 }} />
        )}
        {/* Folder name */}
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-semibold)",
            color: "var(--text-primary)",
          }}
        >
          {node.name}
        </span>
        {/* Status badge */}
        {badgeText && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: hasErrors ? "var(--text-error)" : "var(--text-tertiary)",
              marginLeft: "var(--space-2)",
            }}
          >
            {badgeText}
          </span>
        )}
      </div>

      {/* Children — only render when expanded */}
      {isExpanded && (
        <div style={{ marginLeft: "var(--space-5)" }}>
          {node.children?.map((child) =>
            child.type === "folder" ? (
              <FolderNode
                key={child.path}
                node={child}
                expandedPaths={expandedPaths}
                setExpandedPaths={setExpandedPaths}
                {...cardProps}
              />
            ) : child.doc ? (
              <FileNode
                key={child.doc.id}
                doc={child.doc}
                {...cardProps}
              />
            ) : null
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileNode component — wraps DocumentCard
// ---------------------------------------------------------------------------

function FileNode({
  doc,
  kbId,
  selectedDocs,
  processingDocs,
  levelReadiness,
  onToggleSelect,
  onDelete,
  onRetry,
  highlightDocId,
}: {
  doc: DocumentInfo;
} & Omit<DocumentTreeProps, "documents">) {
  const processing = processingDocs.get(doc.id);
  const processingInfo: ProcessingInfo | null = processing
    ? {
        step: processing.step,
        progress: processing.progress,
        error: processing.error,
        subStep: processing.subStep,
        message: processing.message,
      }
    : null;

  const wsLevels = levelReadiness.get(doc.id);
  const defaultReady = doc.status === "ready";
  const levels = wsLevels ?? (defaultReady ? { L0: true, L1: true, L2: true } : { L0: false, L1: false, L2: false });

  const isHighlighted = highlightDocId === doc.id;

  return (
    <DocumentCard
      document={doc}
      levels={levels}
      processing={processingInfo}
      selected={selectedDocs.has(doc.id)}
      onToggleSelect={() => onToggleSelect(doc.id)}
      onDelete={() => onDelete(doc.id)}
      onRetry={doc.status === "error" ? (processor?: string) => onRetry(doc.id, processor) : undefined}
      kbId={kbId}
      autoExpandLevel={isHighlighted ? "L1" : undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// DocumentTree — top-level component
// ---------------------------------------------------------------------------

export function DocumentTree({
  documents,
  kbId,
  selectedDocs,
  processingDocs,
  levelReadiness,
  onToggleSelect,
  onDelete,
  onRetry,
  highlightDocId,
}: DocumentTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(documents), [documents]);

  // Auto-expand folders containing the highlighted document
  useEffect(() => {
    if (!highlightDocId) return;
    const doc = documents.find((d) => d.id === highlightDocId);
    if (!doc || !doc.folderPath) return;
    // Expand all ancestor folders
    const parts = doc.folderPath.split("/");
    const pathsToExpand: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      pathsToExpand.push(parts.slice(0, i).join("/"));
    }
    if (pathsToExpand.length > 0) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const p of pathsToExpand) {
          if (!next.has(p)) {
            next.add(p);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [highlightDocId, documents]);

  // If all docs are in root (no folders), render flat list
  const allRoot = tree.every((node) => node.type === "file");

  if (allRoot) {
    return (
      <>
        {tree.map((node) =>
          node.doc ? (
            <FileNode
              key={node.doc.id}
              doc={node.doc}
              kbId={kbId}
              selectedDocs={selectedDocs}
              processingDocs={processingDocs}
              levelReadiness={levelReadiness}
              onToggleSelect={onToggleSelect}
              onDelete={onDelete}
              onRetry={onRetry}
              highlightDocId={highlightDocId}
            />
          ) : null
        )}
      </>
    );
  }

  // Mixed: folders and root-level files
  const cardProps = {
    kbId,
    selectedDocs,
    processingDocs,
    levelReadiness,
    onToggleSelect,
    onDelete,
    onRetry,
    highlightDocId,
  };

  return (
    <>
      {tree.map((node) =>
        node.type === "folder" ? (
          <FolderNode
            key={node.path}
            node={node}
            expandedPaths={expandedPaths}
            setExpandedPaths={setExpandedPaths}
            {...cardProps}
          />
        ) : node.doc ? (
          <FileNode
            key={node.doc.id}
            doc={node.doc}
            {...cardProps}
          />
        ) : null
      )}
    </>
  );
}
