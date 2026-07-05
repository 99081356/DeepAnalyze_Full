// =============================================================================
// DeepAnalyze - KnowledgePanel Component
// Unified single-page knowledge base browser with integrated search,
// document management, and collapsible settings.
// =============================================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, uploadDocumentWithRetry, fetchDocumentStatus } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useConfirm } from "../../hooks/useConfirm";
import { selectFolder, openFileDialog } from "../../hooks/useFileUpload";
import { useDocProcessing } from "../../hooks/useDocProcessing";
import { useUIStore } from "../../store/ui";
import type { KnowledgeBase, DocumentInfo } from "../../types/index";
import { DocumentCard } from "./DocumentCard";
import type { ProcessingInfo } from "./DocumentCard";
import { DocumentTree } from "./DocumentTree";
import { KnowledgeSearchBar } from "./KnowledgeSearchBar";
import type { SearchMode } from "./KnowledgeSearchBar";
import { EntityPage } from "./EntityPage";
import { DropZone } from "../ui/DropZone";
import {
  Database,
  Plus,
  Upload,
  Trash2,
  FolderOpen,
  Settings,
  Eye,
  Loader2,
  Play,
  ChevronDown,
  X,
  CheckCircle,
  AlertCircle,
  BookOpen,
  Pencil,
  Save,
  Clock,
  StopCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthCheckResult {
  name: string;
  status: "ok" | "error" | "warning";
  message: string;
}

interface UploadState {
  docId: string;
  filename: string;
  stage: string;
  progress: number;
  error?: string;
  retrying?: boolean;
  file?: File;  // kept for retry on upload failure
  kbId?: string; // track which KB this upload belongs to
}

interface SearchResult {
  docId: string;
  level: string;
  content: string;
  score: number;
  title?: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KnowledgePanel() {
  // Get kbId from URL params, fall back to Zustand store
  const params = useParams<{ kbId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const storeKbId = useUIStore((s) => s.currentKbId);
  const setCurrentKbId = useUIStore((s) => s.setCurrentKbId);

  // Read ?docId= from URL for navigation from evidence links
  const initialDocId = searchParams.get("docId");
  const [highlightDocId, setHighlightDocId] = useState<string | null>(initialDocId);
  // Reactively sync: when URL docId changes (e.g. navigateToDoc while already on KB page), update state
  useEffect(() => {
    if (initialDocId) {
      setHighlightDocId(initialDocId);
    }
  }, [initialDocId]);
  // Clear docId from URL after reading it (avoid re-expand on refresh)
  useEffect(() => {
    if (initialDocId) {
      searchParams.delete("docId");
      setSearchParams(searchParams, { replace: true });
    }
  }, [initialDocId, searchParams, setSearchParams]);
  // "_new" is a placeholder from sidebar navigation when no KB is selected yet
  const effectiveParamKbId = params.kbId === "_new" ? undefined : params.kbId;
  const kbId = effectiveParamKbId ?? storeKbId ?? "";
  const onKbIdChange = useCallback((id: string) => {
    setCurrentKbId(id);
    if (id) {
      window.location.hash = `#/knowledge/${id}`;
    }
  }, [setCurrentKbId]);

  const { success, error: toastError } = useToast();
  const confirm = useConfirm();

  // --- Data state ---
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);

  // --- UI state ---
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [navigatingEntity, setNavigatingEntity] = useState<string | null>(null);
  const [healthResults, setHealthResults] = useState<HealthCheckResult[]>([]);
  const [isHealthChecking, setIsHealthChecking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingKbs, setIsLoadingKbs] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [editingKb, setEditingKb] = useState(false);
  const [editKbName, setEditKbName] = useState("");
  const [isPreprocessing, setIsPreprocessing] = useState(false);
  const [preprocessMsg, setPreprocessMsg] = useState<string | null>(null);
  const [preprocessRunning, setPreprocessRunning] = useState(false);
  const [preprocessStartedAt, setPreprocessStartedAt] = useState<string | null>(null);
  const [preprocessLastDone, setPreprocessLastDone] = useState<string | null>(null);
  const [preprocessElapsed, setPreprocessElapsed] = useState<string>("");
  const [isCancellingPreprocess, setIsCancellingPreprocess] = useState(false);
  const preprocessPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [editKbDescription, setEditKbDescription] = useState("");

  // --- Upload tracking state ---
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());

  // Clear uploads when switching knowledge bases to prevent cross-KB display
  const prevKbIdRef = useRef(kbId);
  if (prevKbIdRef.current !== kbId) {
    prevKbIdRef.current = kbId;
    setUploads([]);
  }

  // --- Preprocessing status polling ---
  const fetchPreprocessStatus = useCallback(async () => {
    if (!kbId) return;
    try {
      const status = await api.getPreprocessStatus(kbId);
      setPreprocessRunning(status.running);
      setPreprocessStartedAt(status.startedAt ?? null);
      setPreprocessLastDone(status.lastPreprocessedAt ?? null);
      if (status.running && status.startedAt) {
        const start = new Date(status.startedAt).getTime();
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        setPreprocessElapsed(m > 0 ? `${m}分${s}秒` : `${s}秒`);
      } else {
        setPreprocessElapsed("");
      }
    } catch {
      // best-effort
    }
  }, [kbId]);

  // Fetch status on mount and when kbId changes; poll every 30s when running
  useEffect(() => {
    setPreprocessRunning(false);
    setPreprocessStartedAt(null);
    setPreprocessElapsed("");
    if (preprocessPollRef.current) {
      clearInterval(preprocessPollRef.current);
      preprocessPollRef.current = null;
    }
    if (!kbId) return;
    fetchPreprocessStatus();
  }, [kbId, fetchPreprocessStatus]);

  useEffect(() => {
    if (preprocessRunning) {
      if (preprocessPollRef.current) clearInterval(preprocessPollRef.current);
      preprocessPollRef.current = setInterval(fetchPreprocessStatus, 30_000);
      // Also update elapsed every 10 seconds
      const elapsedInterval = setInterval(() => {
        if (preprocessStartedAt) {
          const start = new Date(preprocessStartedAt).getTime();
          const elapsed = Math.floor((Date.now() - start) / 1000);
          const m = Math.floor(elapsed / 60);
          const s = elapsed % 60;
          setPreprocessElapsed(m > 0 ? `${m}分${s}秒` : `${s}秒`);
        }
      }, 10_000);
      return () => {
        if (preprocessPollRef.current) {
          clearInterval(preprocessPollRef.current);
          preprocessPollRef.current = null;
        }
        clearInterval(elapsedInterval);
      };
    } else {
      if (preprocessPollRef.current) {
        clearInterval(preprocessPollRef.current);
        preprocessPollRef.current = null;
      }
    }
  }, [preprocessRunning, preprocessStartedAt, fetchPreprocessStatus]);

  // --- Search state ---
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedResult, setExpandedResult] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<string | null>(null);
  const [expandedLoading, setExpandedLoading] = useState(false);

  // --- Load knowledge bases ---
  const loadKnowledgeBases = useCallback(async () => {
    setIsLoadingKbs(true);
    setLoadError(null);
    try {
      const kbs = await api.listKnowledgeBases();
      setKnowledgeBases(Array.isArray(kbs) ? kbs : []);
      if (Array.isArray(kbs) && kbs.length > 0 && !kbId) {
        onKbIdChange(kbs[0].id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
      console.error("[KnowledgePanel] Failed to load knowledge bases:", msg);
    } finally {
      setIsLoadingKbs(false);
    }
  }, [kbId, onKbIdChange]);

  useEffect(() => {
    loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  // --- Load documents when kb changes ---
  useEffect(() => {
    if (!kbId) {
      setDocuments([]);
      return;
    }
    api
      .listDocuments(kbId)
      .then(setDocuments)
      .catch(() => setDocuments([]));
  }, [kbId]);

  // --- Handlers ---

  const refreshDocuments = useCallback(async () => {
    if (!kbId) return;
    try {
      const docs = await api.listDocuments(kbId);
      setDocuments(docs);
    } catch {
      // silently refresh
    }
  }, [kbId]);

  // Subscribe to real-time processing updates; refetch document list on completion/error
  const clearUpload = useCallback((docId: string) => {
    // Delay removal so the user sees "Ready" briefly before it disappears
    setTimeout(() => {
      setUploads((prev) => prev.filter((u) => u.docId !== docId));
    }, 2000);
  }, []);
  const { processingDocs, levelReadiness, wsConnected } = useDocProcessing(kbId || null, refreshDocuments, clearUpload);

  const handleRetryProcess = useCallback(async (docId: string, processor?: string) => {
    if (!kbId) return;
    try {
      await fetch(`/api/knowledge/kbs/${kbId}/process/${docId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(processor ? { processor } : {}),
      });
      success("已重新提交处理");
      refreshDocuments();
    } catch {
      toastError("重试失败");
    }
  }, [kbId, success, toastError, refreshDocuments]);

  const handleDeleteDocument = async (docId: string) => {
    if (!kbId) return;
    const confirmed = await confirm({
      title: "删除文档",
      message: "确定要删除该文档吗？此操作不可撤销。",
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await api.deleteDocument(kbId, docId);
      success("文档已删除");
      refreshDocuments();
    } catch {
      toastError("删除失败");
    }
  };

  // --- Non-blocking upload with concurrency control ---
  const UPLOAD_CONCURRENCY = 10;

  const handleFiles = async (files: FileList | File[]) => {
    if (!kbId) return;
    const fileArray = Array.from(files);

    // Register all files in upload state
    const newEntries: UploadState[] = fileArray.map((file) => ({
      docId: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`,
      filename: file.name,
      stage: "Upload",
      progress: 0,
      file,  // keep File reference for potential retry
      kbId: kbId || undefined,
    }));
    setUploads((prev) => [...prev, ...newEntries]);

    // Concurrent upload with limited parallelism
    let nextIdx = 0;
    const uploadOne = async (): Promise<void> => {
      while (nextIdx < newEntries.length) {
        const idx = nextIdx++;
        const entry = newEntries[idx];
        try {
          const result = await uploadDocumentWithRetry(kbId, entry.file!, {
            onProgress: (pct) =>
              setUploads((prev) =>
                prev.map((u) => (u.docId === entry.docId ? { ...u, progress: pct } : u))
              ),
          });
          setUploads((prev) =>
            prev.map((u) =>
              u.docId === entry.docId
                ? { ...u, docId: result.docId, stage: "Parsing", progress: 45, file: undefined }
                : u
            )
          );
          refreshDocuments();
        } catch (err) {
          setUploads((prev) =>
            prev.map((u) =>
              u.docId === entry.docId
                ? { ...u, stage: "Error", progress: 0, error: err instanceof Error ? err.message : String(err) }
                : u
            )
          );
        }
      }
    };

    // Launch N workers
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, fileArray.length) }, () => uploadOne()));
  };

  // --- WebSocket disconnect polling fallback ---
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  useEffect(() => {
    if (!wsConnected && uploadsRef.current.length > 0) {
      const interval = setInterval(async () => {
        for (const upload of uploadsRef.current) {
          if (
            upload.stage !== "Ready" &&
            upload.stage !== "Error" &&
            !upload.docId.startsWith("temp-")
          ) {
            try {
              const status = await fetchDocumentStatus(kbId, upload.docId);
              setUploads((prev) =>
                prev.map((u) =>
                  u.docId === upload.docId
                    ? { ...u, stage: status.stage, progress: status.progress, error: status.error }
                    : u
                )
              );
            } catch {
              /* ignore polling errors */
            }
          }
        }
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [wsConnected, kbId]);

  // --- Batch operations ---
  const toggleSelect = (docId: string) =>
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      next.has(docId) ? next.delete(docId) : next.add(docId);
      return next;
    });

  const selectAll = () => setSelectedDocs(new Set(documents.map((d) => d.id)));

  const deselectAll = () => setSelectedDocs(new Set());

  const batchDelete = async () => {
    if (!kbId || selectedDocs.size === 0) return;
    const confirmed = await confirm({
      title: "批量删除",
      message: `确定要删除选中的 ${selectedDocs.size} 个文档吗？此操作不可撤销。`,
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      for (const docId of selectedDocs) {
        await api.deleteDocument(kbId, docId);
      }
      success(`已删除 ${selectedDocs.size} 个文档`);
      setSelectedDocs(new Set());
      refreshDocuments();
    } catch {
      toastError("批量删除失败");
    }
  };

  const retryFailed = async (docId: string) => {
    if (!kbId) return;
    const upload = uploads.find((u) => u.docId === docId);
    if (!upload) return;

    // If file reference exists (upload-stage failure), re-upload
    if (upload.file) {
      setUploads((prev) =>
        prev.map((u) =>
          u.docId === docId ? { ...u, stage: "Upload", progress: 0, error: undefined, retrying: true } : u
        )
      );
      try {
        const result = await uploadDocumentWithRetry(kbId, upload.file, {
          onProgress: (pct) =>
            setUploads((prev) =>
              prev.map((u) => (u.docId === docId ? { ...u, progress: pct } : u))
            ),
        });
        setUploads((prev) =>
          prev.map((u) =>
            u.docId === docId
              ? { ...u, docId: result.docId, stage: "Parsing", progress: 45, file: undefined, retrying: false }
              : u
          )
        );
        refreshDocuments();
      } catch (err) {
        setUploads((prev) =>
          prev.map((u) =>
            u.docId === docId
              ? { ...u, stage: "Error", progress: 0, error: err instanceof Error ? err.message : String(err), retrying: false }
              : u
          )
        );
      }
      return;
    }

    // If no file reference (processing-stage failure), re-trigger processing
    try {
      await fetch(`/api/knowledge/kbs/${kbId}/process/${docId}`, { method: "POST" });
      success("已重新提交处理");
      refreshDocuments();
    } catch {
      toastError("重试失败");
    }
  };

  const handleCreateKb = async () => {
    const name = newKbName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      const kb = await api.createKnowledgeBase(name);
      success("知识库已创建");
      setShowCreateModal(false);
      setNewKbName("");
      loadKnowledgeBases();
      onKbIdChange(kb.id);
    } catch {
      toastError("创建失败");
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteKb = async () => {
    if (!kbId) return;
    const confirmed = await confirm({
      title: "删除知识库",
      message: "确定要删除该知识库吗？此操作不可撤销，所有文档和数据将被永久删除。",
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      const deletedId = kbId;
      await api.deleteKnowledgeBase(deletedId);
      success("知识库已删除");
      // Navigate away BEFORE clearing state to avoid stale URL param race
      window.location.hash = "#/knowledge";
      setCurrentKbId("");
      // Optimistically remove from local state to prevent flash
      setKnowledgeBases((prev) => prev.filter((kb) => kb.id !== deletedId));
      setDocuments([]);
      // Reload to get fresh list and auto-select first KB
      loadKnowledgeBases();
    } catch {
      toastError("删除知识库失败");
    }
  };

  const handleHealthCheck = async () => {
    if (!kbId) return;
    setIsHealthChecking(true);
    setHealthResults([]);
    try {
      const results: HealthCheckResult[] = [];
      // Check backend health
      try {
        const health = await api.health();
        results.push({
          name: "后端服务",
          status: "ok",
          message: `服务正常运行 (${health.version || "unknown version"})`,
        });
      } catch {
        results.push({
          name: "后端服务",
          status: "error",
          message: "后端服务不可达",
        });
      }
      // Check KB documents accessibility
      try {
        const docs = await api.listDocuments(kbId);
        results.push({
          name: "知识库索引",
          status: "ok",
          message: `索引正常，${docs.length} 个文档`,
        });
      } catch {
        results.push({
          name: "知识库索引",
          status: "error",
          message: "无法读取知识库文档列表",
        });
      }
      setHealthResults(results);
    } catch {
      setHealthResults([
        { name: "健康检查", status: "error", message: "无法完成健康检查" },
      ]);
    } finally {
      setIsHealthChecking(false);
    }
  };

  const handlePreprocess = async () => {
    if (!kbId) return;
    if (preprocessRunning) {
      toastError("预处理正在运行中，请等待完成或停止后再试");
      return;
    }
    const confirmed = await confirm({
      title: "确认预处理",
      message: "确定要对该知识库执行深度预处理吗？预处理将生成全局概览文档、还原多页表格、校验图片质量、检测手写批注。此操作耗时较长。",
      confirmLabel: "开始预处理",
      variant: "warning",
    });
    if (!confirmed) return;
    setIsPreprocessing(true);
    setPreprocessMsg(null);
    try {
      await api.startPreprocessing(kbId);
      setPreprocessRunning(true);
      setPreprocessStartedAt(new Date().toISOString());
      setPreprocessElapsed("0秒");
      success("预处理任务已启动");
      setPreprocessMsg(null);
    } catch (err: any) {
      const msg = err?.message || "启动预处理失败";
      setPreprocessMsg(msg);
      toastError(msg);
    } finally {
      setIsPreprocessing(false);
    }
  };

  const handleCancelPreprocess = async () => {
    if (!kbId || !preprocessRunning) return;
    const confirmed = await confirm({
      title: "停止预处理",
      message: "确定要停止正在运行的深度预处理任务吗？已完成的处理结果会保留。",
      confirmLabel: "停止",
      variant: "danger",
    });
    if (!confirmed) return;
    setIsCancellingPreprocess(true);
    try {
      await api.cancelPreprocessing(kbId);
      setPreprocessRunning(false);
      setPreprocessStartedAt(null);
      setPreprocessElapsed("");
      success("预处理任务已停止");
    } catch (err: any) {
      toastError(err?.message || "停止预处理失败");
    } finally {
      setIsCancellingPreprocess(false);
    }
  };

  // --- Search handler ---
  const handleSearch = useCallback(async (query: string, mode: SearchMode, topK: number, _levels: string[]) => {
    setSearchQuery(query);
    setExpandedResult(null);
    setExpandedContent(null);
    if (!query || !kbId) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const result = await api.searchWiki(kbId, query, mode, topK);
      setSearchResults(result.results ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [kbId]);

  // --- Search result click handler ---
  const handleResultClick = useCallback(async (result: SearchResult) => {
    if (!kbId) return;
    const key = `${result.docId}-${result.level}`;
    if (expandedResult === key) {
      setExpandedResult(null);
      setExpandedContent(null);
      return;
    }
    setExpandedResult(key);
    setExpandedContent(null);
    setExpandedLoading(true);
    try {
      const pageId = result.metadata?.pageId as string | undefined;
      if (pageId) {
        const data = await api.expandWiki(kbId, result.docId, result.level === "L0" ? "abstract" : result.level === "L2" ? "fulltext" : "structure_md");
        setExpandedContent(data.content || "");
      } else {
        const data = await api.expandWiki(kbId, result.docId, result.level === "L0" ? "abstract" : result.level === "L2" ? "fulltext" : "structure_md");
        setExpandedContent(data.content || "");
      }
    } catch {
      setExpandedContent(result.content || "(加载失败)");
    } finally {
      setExpandedLoading(false);
    }
  }, [kbId, expandedResult]);

  // ======================================================================
  // Render
  // ======================================================================
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--bg-primary)",
      }}
    >
      {/* ================================================================== */}
      {/* Header row: KB selector + New KB + Settings toggle                 */}
      {/* ================================================================== */}
      <div
        style={{
          flexShrink: 0,
          borderBottom: "1px solid var(--border-primary)",
          padding: "var(--space-3) var(--space-4)",
          backgroundColor: "var(--bg-secondary)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {/* KB Selector */}
          <div
            style={{
              flex: 1,
              position: "relative",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Database
              size={16}
              style={{
                position: "absolute",
                left: "var(--space-3)",
                color: "var(--text-tertiary)",
                pointerEvents: "none",
              }}
            />
            <ChevronDown
              size={14}
              style={{
                position: "absolute",
                right: "var(--space-3)",
                color: "var(--text-tertiary)",
                pointerEvents: "none",
              }}
            />
            <select
              value={kbId}
              onChange={(e) => onKbIdChange(e.target.value)}
              style={{
                width: "100%",
                padding: "var(--space-2) var(--space-8) var(--space-2) var(--space-8)",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
                backgroundColor: "var(--bg-tertiary)",
                color: "var(--text-primary)",
                outline: "none",
                cursor: "pointer",
                appearance: "none",
              }}
            >
              <option value="">-- 选择知识库 --</option>
              {knowledgeBases.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name}{kb.documentCount != null ? ` (${kb.documentCount} 文档)` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* New KB button */}
          <button
            onClick={() => setShowCreateModal(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              padding: "var(--space-2) var(--space-3)",
              backgroundColor: "var(--interactive)",
              color: "#fff",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-medium)",
              borderRadius: "var(--radius-md)",
              border: "none",
              cursor: "pointer",
              transition: "background-color var(--transition-fast)",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor =
                "var(--interactive-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--interactive)")
            }
          >
            <Plus size={14} />
            新建
          </button>

          {/* Settings toggle */}
          {kbId && (
            <button
              onClick={() => setShowSettings((v) => !v)}
              title="知识库设置"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "var(--space-2)",
                backgroundColor: showSettings ? "var(--bg-hover)" : "transparent",
                color: showSettings ? "var(--interactive)" : "var(--text-tertiary)",
                fontSize: "var(--text-sm)",
                borderRadius: "var(--radius-md)",
                border: "1px solid",
                borderColor: showSettings ? "var(--interactive)" : "var(--border-primary)",
                cursor: "pointer",
                transition: "all var(--transition-fast)",
              }}
              onMouseEnter={(e) => {
                if (!showSettings) {
                  e.currentTarget.style.color = "var(--text-secondary)";
                  e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                }
              }}
              onMouseLeave={(e) => {
                if (!showSettings) {
                  e.currentTarget.style.color = "var(--text-tertiary)";
                  e.currentTarget.style.backgroundColor = "transparent";
                }
              }}
            >
              <Settings size={14} />
            </button>
          )}
        </div>
      </div>

      {/* ================================================================== */}
      {/* Search row: KnowledgeSearchBar                                      */}
      {/* ================================================================== */}
      {kbId && (
        <div
          style={{
            flexShrink: 0,
            padding: "var(--space-2) var(--space-4)",
            borderBottom: "1px solid var(--border-primary)",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <KnowledgeSearchBar onSearch={handleSearch} loading={isSearching} />
        </div>
      )}

      {/* ================================================================== */}
      {/* Scrollable content area                                             */}
      {/* ================================================================== */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-4)",
        }}
      >
        {!kbId ? (
          /* ---- No KB selected ---- */
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-12) 0",
              color: "var(--text-tertiary)",
            }}
          >
            {isLoadingKbs ? (
              <>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    border: "3px solid var(--border-primary)",
                    borderTopColor: "var(--interactive)",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                    margin: "0 auto var(--space-3)",
                  }}
                />
                <p style={{ fontSize: "var(--text-sm)" }}>加载知识库列表...</p>
              </>
            ) : loadError ? (
              <>
                <AlertCircle
                  size={40}
                  style={{
                    margin: "0 auto var(--space-3)",
                    display: "block",
                    color: "var(--error)",
                  }}
                />
                <p style={{ fontSize: "var(--text-sm)", color: "var(--error)" }}>
                  加载知识库失败
                </p>
                <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)", maxWidth: 400, margin: "var(--space-1) auto 0" }}>
                  {loadError}
                </p>
                <button
                  onClick={loadKnowledgeBases}
                  style={{
                    marginTop: "var(--space-3)",
                    padding: "var(--space-2) var(--space-4)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--surface-primary)",
                    fontSize: "var(--text-sm)",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                  }}
                >
                  重试
                </button>
              </>
            ) : knowledgeBases.length === 0 ? (
              <>
                <FolderOpen
                  size={40}
                  style={{
                    margin: "0 auto var(--space-3)",
                    opacity: 0.4,
                    display: "block",
                  }}
                />
                <p style={{ fontSize: "var(--text-sm)" }}>暂无知识库</p>
                <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                  点击上方"新建"按钮创建一个知识库
                </p>
              </>
            ) : (
              <>
                <FolderOpen
                  size={40}
                  style={{
                    margin: "0 auto var(--space-3)",
                    opacity: 0.4,
                    display: "block",
                  }}
                />
                <p style={{ fontSize: "var(--text-sm)" }}>请选择或创建一个知识库</p>
              </>
            )}
          </div>
        ) : navigatingEntity ? (
          /* Entity Navigation Page — DISABLED per design decision, show document list instead */
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>

            {/* Action row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <p style={{ fontSize: "var(--text-sm)", color: "var(--text-tertiary)", margin: 0 }}>
                  实体导航功能暂未开放
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* ---- Main content ---- */
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>

            {/* ============================================================ */}
            {/* Action row: Upload buttons, batch ops                        */}
            {/* ============================================================ */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                {documents.length > 0 && !searchQuery && (
                  <input
                    type="checkbox"
                    checked={selectedDocs.size === documents.length && documents.length > 0}
                    onChange={() => selectedDocs.size === documents.length ? deselectAll() : selectAll()}
                    title={selectedDocs.size === documents.length ? "取消全选" : "全选"}
                    style={{ cursor: "pointer", accentColor: "var(--interactive)" }}
                  />
                )}
                <span style={{ fontSize: "var(--text-sm)", color: "var(--text-tertiary)" }}>
                  {searchQuery
                    ? `${searchResults.length} 条搜索结果`
                    : documents.length > 0
                      ? `${documents.length} 个文档${selectedDocs.size > 0 ? ` (已选 ${selectedDocs.size})` : ""}`
                      : ""}
                </span>
                {/* WS connection indicator */}
                <span
                  title={wsConnected ? "实时连接正常" : "实时连接已断开"}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: wsConnected ? "var(--success)" : "var(--text-tertiary)",
                    opacity: wsConnected ? 1 : 0.5,
                    transition: "background-color var(--transition-fast), opacity var(--transition-fast)",
                  }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                {/* Batch delete button */}
                {selectedDocs.size > 0 && !searchQuery && (
                  <button
                    onClick={batchDelete}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "var(--space-2) var(--space-3)",
                      backgroundColor: "transparent",
                      color: "var(--error)",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-medium)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--error)",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Trash2 size={14} />
                    删除 ({selectedDocs.size})
                  </button>
                )}
                {/* Upload folder button */}
                <button
                  onClick={async () => {
                    if (!kbId) { toastError("请先选择知识库"); return; }
                    const files = await selectFolder();
                    if (files && files.length > 0) {
                      handleFiles(files);
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "var(--space-2) var(--space-3)",
                    backgroundColor: "transparent",
                    color: "var(--text-secondary)",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--font-medium)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-primary)",
                    cursor: "pointer",
                    transition: "all var(--transition-fast)",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "var(--interactive)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.borderColor = "var(--border-primary)";
                  }}
                >
                  <FolderOpen size={14} />
                  上传文件夹
                </button>
                {/* Upload files button */}
                <button
                  onClick={async () => {
                    if (!kbId) { toastError("请先选择知识库"); return; }
                    const files = await openFileDialog(".pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.xls,.xlsm,.pptx,.ppt,.rtf,.odt,.html,.htm,.png,.jpg,.jpeg,.gif,.bmp,.tiff,.tif,.webp,.svg,.mp3,.wav,.flac,.m4a,.aac,.ogg,.mp4,.avi,.mov,.mkv,.webm,.json,.xml,.yaml,.yml,.toml,.ini", true);
                    if (files && files.length > 0) {
                      handleFiles(files);
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "var(--space-2) var(--space-3)",
                    backgroundColor: "var(--interactive)",
                    color: "#fff",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--font-medium)",
                    borderRadius: "var(--radius-md)",
                    border: "none",
                    cursor: "pointer",
                    transition: "background-color var(--transition-fast)",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--interactive-hover)";
                  }}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.backgroundColor = "var(--interactive)")
                  }
                >
                  <Upload size={14} />
                  上传文档
                </button>
                {/* Manual processing trigger */}
                {documents.some((d) => d.status === "uploaded" || d.status === "error") && (
                  <button
                    onClick={async () => {
                      if (!kbId) return;
                      try {
                        const result = await api.triggerProcessing(kbId);
                        success(`已将 ${result.enqueued ?? 0} 个文档加入处理队列`);
                      } catch {
                        toastError("触发处理失败");
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "var(--space-2) var(--space-3)",
                      backgroundColor: "var(--warning, #f59e0b)",
                      color: "#fff",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-medium)",
                      borderRadius: "var(--radius-md)",
                      border: "none",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Play size={14} />
                    开始处理
                  </button>
                )}
              </div>
            </div>

            {/* ============================================================ */}
            {/* Upload progress — minimal indicator while uploading           */}
            {/* After upload completes, documents appear in the list below     */}
            {/* with per-DocumentCard status tracking via WebSocket            */}
            {/* ============================================================ */}
            {uploads.filter((u) => u.stage !== "Ready").length > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  padding: "var(--space-2) var(--space-3)",
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--text-xs)",
                  color: "var(--text-secondary)",
                }}
              >
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite", color: "var(--interactive)" }} />
                <span>
                  正在上传 {uploads.filter((u) => u.stage === "Upload").length} 个文件...
                </span>
              </div>
            )}
            {/* Show error items that need retry */}
            {uploads.filter((u) => u.stage === "Error").length > 3 && (
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 var(--space-3)" }}>
                <button
                  onClick={() => {
                    const failed = uploads.filter((u) => u.stage === "Error");
                    failed.forEach((u) => retryFailed(u.docId));
                  }}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: "1px solid var(--interactive)",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    color: "var(--interactive)",
                    backgroundColor: "transparent",
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-medium)",
                  }}
                >
                  全部重试 ({uploads.filter((u) => u.stage === "Error").length})
                </button>
              </div>
            )}
            {uploads.filter((u) => u.stage === "Error").map((upload) => (
              <div
                key={upload.docId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  padding: "var(--space-2) var(--space-3)",
                  backgroundColor: "var(--error-light, rgba(239, 68, 68, 0.06))",
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--text-xs)",
                  color: "var(--error)",
                }}
              >
                <AlertCircle size={14} />
                <span style={{ flex: 1 }}>{upload.filename}: {upload.error ?? "上传失败"}</span>
                <button
                  onClick={() => retryFailed(upload.docId)}
                  disabled={upload.retrying}
                  style={{
                    padding: "var(--space-1) var(--space-2)",
                    border: "1px solid var(--interactive)",
                    borderRadius: "var(--radius-sm)",
                    cursor: upload.retrying ? "wait" : "pointer",
                    color: "var(--interactive)",
                    backgroundColor: "transparent",
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-medium)",
                    whiteSpace: "nowrap",
                    opacity: upload.retrying ? 0.6 : 1,
                  }}
                >
                  {upload.retrying ? "重试中..." : "重试"}
                </button>
              </div>
            ))}

            {/* ============================================================ */}
            {/* Collapsible settings section (above document list)           */}
            {/* ============================================================ */}
            {showSettings && kbId && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-4)",
                  marginBottom: "var(--space-4)",
                  paddingTop: "var(--space-4)",
                  borderTop: "2px solid var(--border-primary)",
                }}
              >
                {/* Deep Preprocessing */}
                <div
                  style={{
                    padding: "var(--space-4)",
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-lg)",
                  }}
                >
                  <h4
                    style={{
                      margin: "0 0 var(--space-2)",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-semibold)",
                      color: "var(--text-primary)",
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                    }}
                  >
                    <Play size={14} />
                    深度预处理
                  </h4>
                  <p
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--text-tertiary)",
                      margin: "0 0 var(--space-3)",
                    }}
                  >
                    对当前知识库执行全量深度预处理：生成全局概览文档、还原多页表格、校验图片VLM质量、检测手写批注。运行时间较长。
                  </p>

                  {/* Last preprocess timestamp */}
                  {preprocessLastDone && !preprocessRunning && (
                    <p style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--text-tertiary)",
                      margin: "0 0 var(--space-2)",
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                    }}>
                      <Clock size={12} />
                      上次预处理：{new Date(preprocessLastDone).toLocaleString("zh-CN")}
                    </p>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                    {/* Start button */}
                    {!preprocessRunning && (
                      <button
                        onClick={handlePreprocess}
                        disabled={isPreprocessing}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "var(--space-1)",
                          padding: "var(--space-2) var(--space-3)",
                          backgroundColor: "#8b5cf6",
                          color: "#fff",
                          fontSize: "var(--text-sm)",
                          fontWeight: "var(--font-medium)",
                          borderRadius: "var(--radius-md)",
                          border: "none",
                          cursor: isPreprocessing ? "not-allowed" : "pointer",
                          opacity: isPreprocessing ? 0.7 : 1,
                          transition: "background-color var(--transition-fast), opacity var(--transition-fast)",
                        }}
                        onMouseEnter={(e) => {
                          if (!isPreprocessing)
                            e.currentTarget.style.backgroundColor = "#7c3aed";
                        }}
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.backgroundColor = "#8b5cf6")
                        }
                      >
                        {isPreprocessing ? "启动中..." : "开始预处理"}
                      </button>
                    )}

                    {/* Running status */}
                    {preprocessRunning && (
                      <>
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "var(--space-2)",
                            fontSize: "var(--text-sm)",
                            color: "#8b5cf6",
                          }}
                        >
                          <div
                            style={{
                              width: 14,
                              height: 14,
                              border: "2px solid #8b5cf620",
                              borderTopColor: "#8b5cf6",
                              borderRadius: "var(--radius-full)",
                              animation: "spin 0.6s linear infinite",
                            }}
                          />
                          预处理进行中
                          {preprocessElapsed && (
                            <span style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
                              (已用时 {preprocessElapsed})
                            </span>
                          )}
                        </div>
                        <button
                          onClick={handleCancelPreprocess}
                          disabled={isCancellingPreprocess}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "var(--space-1)",
                            padding: "var(--space-1) var(--space-2)",
                            backgroundColor: "transparent",
                            color: "var(--error)",
                            fontSize: "var(--text-xs)",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid var(--error)",
                            cursor: isCancellingPreprocess ? "not-allowed" : "pointer",
                            opacity: isCancellingPreprocess ? 0.5 : 1,
                          }}
                        >
                          <StopCircle size={12} />
                          {isCancellingPreprocess ? "停止中..." : "停止"}
                        </button>
                      </>
                    )}
                  </div>

                  {preprocessMsg && (
                    <p
                      style={{
                        fontSize: "var(--text-xs)",
                        color: preprocessMsg.includes("失败") || preprocessMsg.includes("错误")
                          ? "var(--error)"
                          : "var(--success)",
                        margin: "var(--space-2) 0 0",
                      }}
                    >
                      {preprocessMsg}
                    </p>
                  )}
                </div>

                {/* KB Info */}
                <div
                  style={{
                    padding: "var(--space-4)",
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-lg)",
                  }}
                >
                  <h4
                    style={{
                      margin: "0 0 var(--space-3)",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-semibold)",
                      color: "var(--text-primary)",
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                    }}
                  >
                    <Settings size={14} />
                    知识库信息
                  </h4>
                  {(() => {
                    const currentKb = knowledgeBases.find((kb) => kb.id === kbId);
                    return currentKb ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                        {editingKb ? (
                          <>
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>名称</span>
                              <input
                                value={editKbName}
                                onChange={(e) => setEditKbName(e.target.value)}
                                style={{
                                  width: "100%", padding: "4px 8px", fontSize: "var(--text-sm)",
                                  border: "1px solid var(--border-primary)", borderRadius: "var(--radius-sm)",
                                  background: "var(--bg-primary)", color: "var(--text-primary)",
                                  marginTop: 2,
                                }}
                              />
                            </div>
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>描述</span>
                              <textarea
                                value={editKbDescription}
                                onChange={(e) => setEditKbDescription(e.target.value)}
                                rows={2}
                                style={{
                                  width: "100%", padding: "4px 8px", fontSize: "var(--text-sm)",
                                  border: "1px solid var(--border-primary)", borderRadius: "var(--radius-sm)",
                                  background: "var(--bg-primary)", color: "var(--text-primary)",
                                  marginTop: 2, resize: "vertical",
                                }}
                              />
                            </div>
                            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 4 }}>
                              <button
                                onClick={async () => {
                                  try {
                                    await api.updateKnowledgeBase(kbId, {
                                      name: editKbName.trim() || undefined,
                                      description: editKbDescription.trim() || undefined,
                                    });
                                    setEditingKb(false);
                                    loadKnowledgeBases();
                                    success("知识库信息已更新");
                                  } catch {
                                    toastError("更新失败");
                                  }
                                }}
                                style={{
                                  padding: "4px 12px", fontSize: "var(--text-xs)",
                                  border: "1px solid var(--border-primary)", borderRadius: "var(--radius-sm)",
                                  background: "var(--interactive)", color: "#fff",
                                  cursor: "pointer",
                                }}
                              >
                                <Save size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
                                保存
                              </button>
                              <button
                                onClick={() => setEditingKb(false)}
                                style={{
                                  padding: "4px 12px", fontSize: "var(--text-xs)",
                                  border: "1px solid var(--border-primary)", borderRadius: "var(--radius-sm)",
                                  background: "var(--surface-primary)", color: "var(--text-secondary)",
                                  cursor: "pointer",
                                }}
                              >
                                取消
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>名称</span>
                              <button
                                onClick={() => {
                                  setEditKbName(currentKb.name);
                                  setEditKbDescription(currentKb.description || "");
                                  setEditingKb(true);
                                }}
                                style={{
                                  border: "none", background: "transparent",
                                  color: "var(--text-tertiary)", cursor: "pointer",
                                  padding: 2, display: "flex",
                                }}
                                title="编辑"
                              >
                                <Pencil size={12} />
                              </button>
                            </div>
                            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", margin: 0 }}>
                              {currentKb.name}
                            </p>
                            <div>
                              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>描述</span>
                              <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
                                {currentKb.description || "暂无描述"}
                              </p>
                            </div>
                          </>
                        )}
                        <div>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>文档数量</span>
                          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
                            {currentKb.documentCount ?? documents.length} 个文档
                          </p>
                        </div>
                        <div>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>创建时间</span>
                          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
                            {new Date(currentKb.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p style={{ fontSize: "var(--text-sm)", color: "var(--text-tertiary)", margin: 0 }}>
                        无法加载知识库信息
                      </p>
                    );
                  })()}
                </div>

                {/* Health Check */}
                <div
                  style={{
                    padding: "var(--space-4)",
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-lg)",
                  }}
                >
                  <h4
                    style={{
                      margin: "0 0 var(--space-3)",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-semibold)",
                      color: "var(--text-primary)",
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                    }}
                  >
                    <Eye size={14} />
                    健康检查
                  </h4>
                  <button
                    onClick={handleHealthCheck}
                    disabled={isHealthChecking}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "var(--space-2) var(--space-3)",
                      backgroundColor: "var(--interactive)",
                      color: "#fff",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-medium)",
                      borderRadius: "var(--radius-md)",
                      border: "none",
                      cursor: isHealthChecking ? "not-allowed" : "pointer",
                      opacity: isHealthChecking ? 0.7 : 1,
                      transition: "background-color var(--transition-fast), opacity var(--transition-fast)",
                      marginBottom: "var(--space-3)",
                    }}
                    onMouseEnter={(e) => {
                      if (!isHealthChecking)
                        e.currentTarget.style.backgroundColor = "var(--interactive-hover)";
                    }}
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.backgroundColor = "var(--interactive)")
                    }
                  >
                    {isHealthChecking ? "检查中..." : "运行健康检查"}
                  </button>

                  {isHealthChecking && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-2)",
                        fontSize: "var(--text-sm)",
                        color: "var(--text-tertiary)",
                      }}
                    >
                      <div
                        style={{
                          width: 16,
                          height: 16,
                          border: "2px solid var(--border-primary)",
                          borderTopColor: "var(--interactive)",
                          borderRadius: "var(--radius-full)",
                          animation: "spin 0.6s linear infinite",
                        }}
                      />
                      正在检查...
                    </div>
                  )}

                  {healthResults.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                      {healthResults.map((item) => (
                        <div
                          key={item.name}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "var(--space-2)",
                            padding: "var(--space-2) var(--space-3)",
                            backgroundColor: "var(--bg-secondary)",
                            borderRadius: "var(--radius-md)",
                            fontSize: "var(--text-sm)",
                          }}
                        >
                          {item.status === "ok" ? (
                            <CheckCircle size={14} style={{ color: "var(--success)", flexShrink: 0 }} />
                          ) : item.status === "warning" ? (
                            <AlertCircle size={14} style={{ color: "var(--warning)", flexShrink: 0 }} />
                          ) : (
                            <AlertCircle size={14} style={{ color: "var(--error)", flexShrink: 0 }} />
                          )}
                          <span style={{ fontWeight: "var(--font-medium)", color: "var(--text-primary)", flexShrink: 0 }}>
                            {item.name}
                          </span>
                          <span style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
                            {item.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Danger Zone */}
                <div
                  style={{
                    padding: "var(--space-4)",
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--error)",
                    borderRadius: "var(--radius-lg)",
                  }}
                >
                  <h4
                    style={{
                      margin: "0 0 var(--space-2)",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-semibold)",
                      color: "var(--error)",
                    }}
                  >
                    危险操作
                  </h4>
                  <p
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--text-tertiary)",
                      margin: "0 0 var(--space-3)",
                    }}
                  >
                    删除知识库将永久移除所有文档和数据，此操作不可撤销。
                  </p>
                  <button
                    onClick={handleDeleteKb}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "var(--space-2) var(--space-3)",
                      backgroundColor: "transparent",
                      color: "var(--error)",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-medium)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--error)",
                      cursor: "pointer",
                      transition: "background-color var(--transition-fast), color var(--transition-fast)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = "var(--error)";
                      e.currentTarget.style.color = "#fff";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "var(--error)";
                    }}
                  >
                    <Trash2 size={14} />
                    删除知识库
                  </button>
                </div>
              </div>
            )}

            {/* ============================================================ */}
            {/* Content: search results OR document list OR empty state      */}
            {/* ============================================================ */}
            {searchQuery ? (
              /* ---- Search Results ---- */
              searchResults.length === 0 && !isSearching ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "var(--space-12) 0",
                    color: "var(--text-tertiary)",
                  }}
                >
                  <BookOpen
                    size={40}
                    style={{
                      margin: "0 auto var(--space-3)",
                      opacity: 0.4,
                      display: "block",
                    }}
                  />
                  <p style={{ fontSize: "var(--text-sm)", margin: 0 }}>
                    未找到相关结果
                  </p>
                  <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                    尝试使用不同的关键词或搜索模式
                  </p>
                </div>
              ) : (
                searchResults.map((result, idx) => {
                  const isExpanded = expandedResult === `${result.docId}-${result.level}`;
                  return (
                    <div
                      key={`${result.docId}-${result.level}-${idx}`}
                      onClick={() => handleResultClick(result)}
                      style={{
                        padding: "var(--space-3) var(--space-4)",
                        backgroundColor: isExpanded ? "var(--bg-secondary)" : "var(--bg-tertiary)",
                        border: "1px solid",
                        borderColor: isExpanded ? "var(--interactive)" : "var(--border-primary)",
                        borderRadius: "var(--radius-lg)",
                        cursor: "pointer",
                        transition: "border-color var(--transition-fast)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isExpanded) e.currentTarget.style.borderColor = "var(--interactive-light)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isExpanded) e.currentTarget.style.borderColor = "var(--border-primary)";
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--space-2)",
                          marginBottom: "var(--space-2)",
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "var(--space-1) var(--space-2)",
                            backgroundColor: "var(--interactive-light)",
                            color: "var(--interactive)",
                            fontSize: "var(--text-xs)",
                            fontWeight: "var(--font-semibold)",
                            borderRadius: "var(--radius-sm)",
                          }}
                        >
                          {result.level}
                        </span>
                        {result.title && (
                          <span
                            style={{
                              fontSize: "var(--text-sm)",
                              color: "var(--text-primary)",
                              fontWeight: 500,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {result.title}
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: "var(--text-xs)",
                            color: "var(--text-tertiary)",
                          }}
                        >
                          {(result.score * 100).toFixed(1)}%
                        </span>
                        <span
                          style={{
                            fontSize: "var(--text-xs)",
                            color: "var(--text-tertiary)",
                            marginLeft: "auto",
                          }}
                        >
                          {result.docId}
                        </span>
                      </div>
                      <p
                        style={{
                          fontSize: "var(--text-sm)",
                          color: "var(--text-secondary)",
                          margin: 0,
                          lineHeight: 1.6,
                          display: isExpanded ? "block" : "-webkit-box",
                          WebkitLineClamp: isExpanded ? undefined : 3,
                          WebkitBoxOrient: "vertical",
                          overflow: isExpanded ? "auto" : "hidden",
                          maxHeight: isExpanded ? 400 : undefined,
                          whiteSpace: isExpanded ? "pre-wrap" : undefined,
                        }}
                      >
                        {isExpanded && expandedLoading ? "加载中..." : isExpanded && expandedContent ? expandedContent : result.content}
                      </p>
                    </div>
                  );
                })
              )
            ) : documents.length === 0 && uploads.length === 0 ? (
              /* ---- Empty state with DropZone ---- */
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", alignItems: "center" }}>
                <DropZone
                  onFiles={(files) => {
                    if (!kbId) { toastError("请先选择知识库"); return; }
                    handleFiles(files);
                  }}
                  accept=".pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.xls,.xlsm,.pptx,.ppt,.rtf,.odt,.html,.htm,.png,.jpg,.jpeg,.gif,.bmp,.tiff,.tif,.webp,.svg,.mp3,.wav,.flac,.m4a,.aac,.ogg,.mp4,.avi,.mov,.mkv,.webm,.json,.xml,.yaml,.yml,.toml,.ini"
                  label="拖拽文件到此处上传"
                  hint="或点击选择文件"
                  style={{ width: "100%" }}
                />
                <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                  支持 PDF、Word、TXT、Markdown、CSV、图片、音频等格式
                </p>
              </div>
            ) : (
              /* ---- Document list using DocumentTree (tree view with folder hierarchy) ---- */
              <DocumentTree
                documents={documents}
                kbId={kbId}
                selectedDocs={selectedDocs}
                processingDocs={processingDocs}
                levelReadiness={levelReadiness}
                onToggleSelect={toggleSelect}
                onDelete={handleDeleteDocument}
                onRetry={handleRetryProcess}
                highlightDocId={highlightDocId ?? undefined}
              />
            )}
          </div>
        )}
      </div>

      {/* ================================================================== */}
      {/* Create KB Modal                                                     */}
      {/* ================================================================== */}
      {showCreateModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Overlay */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
            }}
            onClick={() => {
              if (!isCreating) {
                setShowCreateModal(false);
                setNewKbName("");
              }
            }}
          />

          {/* Modal */}
          <div
            style={{
              position: "relative",
              width: 400,
              maxWidth: "90vw",
              backgroundColor: "var(--bg-secondary)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-xl)",
              boxShadow: "var(--shadow-md)",
              padding: "var(--space-6)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "var(--space-4)",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: "var(--text-base)",
                  fontWeight: "var(--font-semibold)",
                  color: "var(--text-primary)",
                }}
              >
                新建知识库
              </h3>
              <button
                onClick={() => {
                  if (!isCreating) {
                    setShowCreateModal(false);
                    setNewKbName("");
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "var(--space-1)",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  color: "var(--text-tertiary)",
                  backgroundColor: "transparent",
                  transition: "color var(--transition-fast), background-color var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--text-primary)";
                  e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-tertiary)";
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <X size={18} />
              </button>
            </div>

            <input
              type="text"
              value={newKbName}
              onChange={(e) => setNewKbName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isCreating) handleCreateKb();
              }}
              placeholder="输入知识库名称..."
              autoFocus
              style={{
                width: "100%",
                padding: "var(--space-2) var(--space-3)",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
                color: "var(--text-primary)",
                backgroundColor: "var(--bg-tertiary)",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: "var(--space-4)",
                transition: "border-color var(--transition-fast)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--interactive)";
                e.currentTarget.style.boxShadow = "0 0 0 2px var(--interactive-light)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-primary)";
                e.currentTarget.style.boxShadow = "none";
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "var(--space-2)",
              }}
            >
              <button
                onClick={() => {
                  if (!isCreating) {
                    setShowCreateModal(false);
                    setNewKbName("");
                  }
                }}
                style={{
                  padding: "var(--space-2) var(--space-4)",
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  transition: "background-color var(--transition-fast), color var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
                  e.currentTarget.style.color = "var(--text-secondary)";
                }}
              >
                取消
              </button>
              <button
                onClick={handleCreateKb}
                disabled={!newKbName.trim() || isCreating}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "var(--space-2) var(--space-4)",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--font-medium)",
                  color: "#fff",
                  backgroundColor:
                    !newKbName.trim() || isCreating
                      ? "var(--text-tertiary)"
                      : "var(--interactive)",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  cursor:
                    !newKbName.trim() || isCreating
                      ? "not-allowed"
                      : "pointer",
                  opacity: isCreating ? 0.7 : 1,
                  transition: "background-color var(--transition-fast), opacity var(--transition-fast)",
                }}
                onMouseEnter={(e) => {
                  if (newKbName.trim() && !isCreating)
                    e.currentTarget.style.backgroundColor = "var(--interactive-hover)";
                }}
                onMouseLeave={(e) => {
                  if (newKbName.trim() && !isCreating)
                    e.currentTarget.style.backgroundColor = "var(--interactive)";
                }}
              >
                <Plus size={14} />
                {isCreating ? "创建中..." : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
