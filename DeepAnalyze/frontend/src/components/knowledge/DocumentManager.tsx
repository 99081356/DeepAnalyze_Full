// =============================================================================
// DeepAnalyze - Enhanced Document Manager
// File list with multimodal info, processing progress, and per-doc actions.
// =============================================================================

import React, { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import {
  FileText,
  Table,
  Image,
  Mic,
  Video,
  Download,
  RefreshCw,
  Trash2,
  Eye,
  Loader2,
  CheckCircle,
  AlertCircle,
  Clock,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocumentInfo {
  id: string;
  kbId: string;
  filename: string;
  fileType: string;
  status: string;
  fileSize: number;
  metadata?: Record<string, unknown>;
  processingStep?: string;
  processingProgress?: number;
  processingError?: string;
  createdAt: string;
}

interface DocumentManagerProps {
  kbId: string;
  onSelectDoc?: (docId: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_TYPE_ICONS: Record<string, React.ReactNode> = {
  pdf: <FileText size={16} className="text-red-500" />,
  docx: <FileText size={16} className="text-blue-500" />,
  doc: <FileText size={16} className="text-blue-500" />,
  pptx: <FileText size={16} className="text-orange-500" />,
  xlsx: <Table size={16} className="text-green-500" />,
  xls: <Table size={16} className="text-green-500" />,
  csv: <Table size={16} className="text-green-500" />,
  png: <Image size={16} className="text-purple-500" />,
  jpg: <Image size={16} className="text-purple-500" />,
  jpeg: <Image size={16} className="text-purple-500" />,
  mp3: <Mic size={16} className="text-pink-500" />,
  wav: <Mic size={16} className="text-pink-500" />,
  mp4: <Video size={16} className="text-indigo-500" />,
  avi: <Video size={16} className="text-indigo-500" />,
  mov: <Video size={16} className="text-indigo-500" />,
};

const MODALITY_META: Record<string, (doc: DocumentInfo) => React.ReactNode> = {
  document: (doc) => {
    const pages = doc.metadata?.pageCount as number | undefined;
    return pages ? <span>{pages} pages</span> : null;
  },
  excel: (doc) => {
    const sheets = doc.metadata?.sheetCount as number | undefined;
    const tables = doc.metadata?.tableCount as number | undefined;
    return (
      <span>
        {sheets ? `${sheets} Sheets` : ""}
        {sheets && tables ? " · " : ""}
        {tables ? `${tables} tables` : ""}
      </span>
    );
  },
  audio: (doc) => {
    const dur = doc.metadata?.duration as number | undefined;
    const speakers = doc.metadata?.speakerCount as number | undefined;
    return (
      <span>
        {dur ? formatDuration(dur) : ""}
        {dur && speakers ? " · " : ""}
        {speakers ? `${speakers} speakers` : ""}
      </span>
    );
  },
  video: (doc) => {
    const dur = doc.metadata?.duration as number | undefined;
    const res = doc.metadata?.resolution as string | undefined;
    return (
      <span>
        {dur ? formatDuration(dur) : ""}
        {dur && res ? " · " : ""}
        {res ?? ""}
      </span>
    );
  },
  image: (doc) => {
    const w = doc.metadata?.width as number | undefined;
    const h = doc.metadata?.height as number | undefined;
    return w && h ? <span>{w}x{h}</span> : null;
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentManager({ kbId, onSelectDoc }: DocumentManagerProps) {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get<{ documents: DocumentInfo[] }>(
        `/api/knowledge/kbs/${kbId}/documents`,
      );
      setDocuments(res.documents ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  const handleReprocess = async (docId: string) => {
    setActionLoading(docId);
    try {
      await api.post(`/api/knowledge/kbs/${kbId}/process/${docId}?force=true`, {});
      await fetchDocs();
    } catch (err) {
      console.error("Reprocess failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (docId: string) => {
    if (!confirm("Are you sure you want to delete this document?")) return;
    setActionLoading(docId);
    try {
      await api.delete(`/api/knowledge/kbs/${kbId}/documents/${docId}`);
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="animate-spin text-gray-400" size={24} />
        <span className="ml-2 text-gray-500 dark:text-gray-400">Loading documents...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center text-red-500">
        <AlertCircle className="mx-auto mb-2" size={24} />
        <p>{error}</p>
        <button
          onClick={fetchDocs}
          className="mt-2 text-sm text-blue-500 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="p-8 text-center text-gray-400 dark:text-gray-500">
        <FileText className="mx-auto mb-2" size={32} />
        <p>No documents yet. Upload files to get started.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-100 dark:divide-gray-700">
      {documents.map((doc) => (
        <div
          key={doc.id}
          className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
        >
          {/* File icon */}
          <div className="flex-shrink-0">
            {FILE_TYPE_ICONS[doc.fileType] ?? <FileText size={16} className="text-gray-400" />}
          </div>

          {/* File info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                {doc.filename}
              </span>
              <StatusBadge status={doc.status} />
            </div>

            {/* Modality metadata */}
            <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              <span>{formatFileSize(doc.fileSize)}</span>
              <span>·</span>
              <span>{doc.fileType.toUpperCase()}</span>
              {(() => {
                const modality = doc.metadata?.modality as string | undefined;
                if (!modality) return null;
                const fn = MODALITY_META[modality];
                return fn ? fn(doc) : null;
              })()}
            </div>

            {/* Processing progress */}
            {doc.status !== "ready" && doc.status !== "uploaded" && doc.status !== "error" && (
              <ProcessingProgress status={doc.status} progress={doc.processingProgress} />
            )}

            {/* Error message */}
            {doc.processingError && (
              <p className="text-xs text-red-500 mt-1 truncate">
                {doc.processingError}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {doc.status === "ready" && onSelectDoc && (
              <button
                onClick={() => onSelectDoc(doc.id)}
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 hover:text-blue-500 transition-colors"
                title="Preview"
              >
                <Eye size={14} />
              </button>
            )}
            {doc.status === "ready" && (
              <a
                href={`/api/knowledge/kbs/${kbId}/documents/${doc.id}/download`}
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 hover:text-green-500 transition-colors"
                title="Download"
              >
                <Download size={14} />
              </a>
            )}
            {(doc.status === "uploaded" || doc.status === "error" || ["parsing", "compiling", "indexing", "linking"].includes(doc.status)) && (
              <button
                onClick={() => handleReprocess(doc.id)}
                disabled={actionLoading === doc.id}
                className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 hover:text-blue-500 transition-colors disabled:opacity-50"
                title="Reprocess"
              >
                <RefreshCw size={14} className={actionLoading === doc.id ? "animate-spin" : ""} />
              </button>
            )}
            <button
              onClick={() => handleDelete(doc.id)}
              disabled={actionLoading === doc.id}
              className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 hover:text-red-500 transition-colors disabled:opacity-50"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ready":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-green-600 dark:text-green-400">
          <CheckCircle size={10} /> Ready
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-red-500">
          <AlertCircle size={10} /> Error
        </span>
      );
    case "uploaded":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-gray-400">
          <Clock size={10} /> Queued
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-blue-500">
          <Loader2 size={10} className="animate-spin" /> {status}
        </span>
      );
  }
}

function ProcessingProgress({ status, progress }: { status: string; progress?: number }) {
  const pct = progress ?? 0;
  const label = status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-gray-400 whitespace-nowrap">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
