/**
 * Models admin page — Phase 5 G3 model repository management.
 *
 * Features:
 *   - List all model artifacts (name, version, category, sha256 prefix, size, uploaded_at, uploaded_by)
 *   - Upload modal: name + version + category + DragDrop file(s)
 *   - Delete a version with confirmation dialog
 *   - Loading skeleton / empty / error states
 */

import {
  useEffect,
  useState,
  useCallback,
  type CSSProperties,
  type FormEvent,
} from "react";
import { Database, Plus, RefreshCw, Trash2, Copy, Check } from "lucide-react";
import { api, type ModelArtifact } from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Input } from "../components/ui/Input.js";
import { Modal } from "../components/ui/Modal.js";
import { Select } from "../components/ui/Select.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { DropZone } from "../components/ui/DropZone.js";
import { useUIStore } from "../store/ui.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const CATEGORY_OPTIONS = [
  { value: "embedding", label: "embedding" },
  { value: "llm", label: "llm" },
  { value: "vision", label: "vision" },
  { value: "audio", label: "audio" },
  { value: "other", label: "other" },
];

const CATEGORY_VARIANT: Record<
  string,
  "default" | "success" | "warning" | "error" | "info"
> = {
  embedding: "info",
  llm: "success",
  vision: "warning",
  audio: "error",
  other: "default",
};

/* -------------------------------------------------------------------------- */
/*  Styles                                                                    */
/* -------------------------------------------------------------------------- */

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-4)",
};

const titleStyle: CSSProperties = {
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--font-semibold)" as unknown as number,
  color: "var(--text-primary)",
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const countStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--text-tertiary)",
};

const errorBoxStyle: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  background: "var(--error-light)",
  border: "1px solid var(--error)",
  borderRadius: "var(--radius-lg)",
  color: "var(--error-dark)",
  fontSize: "var(--text-sm)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const tableWrapStyle: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--radius-lg)",
  overflow: "hidden",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-sm)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "var(--space-3) var(--space-4)",
  fontWeight: "var(--font-semibold)" as unknown as number,
  color: "var(--text-secondary)",
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  borderBottom: "1px solid var(--border-primary)",
  background: "var(--bg-tertiary)",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--border-primary)",
  color: "var(--text-primary)",
  verticalAlign: "middle",
};

const skeletonRowStyle: CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--border-primary)",
};

const formRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginBottom: "var(--space-4)",
};

const fileListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  marginTop: "var(--space-2)",
};

const fileChipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--bg-tertiary)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-xs)",
  color: "var(--text-secondary)",
};

const modalFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  marginTop: "var(--space-5)",
};

const shaCellStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--text-xs)",
  color: "var(--text-tertiary)",
};

const copyBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: "var(--radius-sm)",
  border: "none",
  background: "transparent",
  color: "var(--text-tertiary)",
  cursor: "pointer",
  padding: 0,
  transition: "color var(--transition-fast)",
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatSize(bytes: number | string | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const n = typeof bytes === "string" ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN");
  } catch {
    return String(iso);
  }
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function Models() {
  const addToast = useUIStore((s) => s.addToast);
  const showConfirm = useUIStore((s) => s.showConfirm);

  const [models, setModels] = useState<ModelArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);

  /* -- load -- */

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.models.list();
      setModels(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* -- delete with confirm -- */

  const handleDelete = useCallback(
    async (m: ModelArtifact) => {
      const ok = await showConfirm({
        title: "删除模型版本",
        message: `确定删除模型 ${m.name} 版本 ${m.version}？此操作不可逆。`,
        confirmLabel: "删除",
        cancelLabel: "取消",
        variant: "danger",
      });
      if (!ok) return;
      setBusyId(m.id);
      try {
        await api.models.delete(m.name, m.version);
        addToast("success", `已删除 ${m.name} @ ${m.version}`);
        await load();
      } catch (err) {
        addToast(
          "error",
          err instanceof Error ? err.message : "删除失败",
        );
      } finally {
        setBusyId(null);
      }
    },
    [load, addToast, showConfirm],
  );

  /* -- copy sha -- */

  const handleCopySha = useCallback(async (sha: string) => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopiedSha(sha);
      setTimeout(() => setCopiedSha(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  }, []);

  /* -- upload success -- */

  const handleUploaded = useCallback(async () => {
    setUploadOpen(false);
    addToast("success", "模型上传成功");
    await load();
  }, [load, addToast]);

  /* -- render -- */

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={headerRowStyle}>
        <h1 style={titleStyle}>
          <Database size={24} />
          模型仓库
          {!loading && (
            <span style={countStyle}>（{models.length}）</span>
          )}
        </h1>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={load}
            disabled={loading}
          >
            刷新
          </Button>
          <Button
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setUploadOpen(true)}
          >
            上传模型
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={errorBoxStyle}>
          <span style={{ flex: 1 }}>{error}</span>
          <Button variant="secondary" size="sm" onClick={load}>
            重试
          </Button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div style={tableWrapStyle}>
          <Skeleton variant="rect" height={40} width="100%" />
          {[...Array(5)].map((_, i) => (
            <div key={i} style={skeletonRowStyle}>
              <Skeleton variant="text" height={20} width="100%" />
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {!loading && !error && models.length > 0 && (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>版本</th>
                <th style={thStyle}>类别</th>
                <th style={thStyle}>SHA256</th>
                <th style={thStyle}>大小</th>
                <th style={thStyle}>上传时间</th>
                <th style={thStyle}>上传者</th>
                <th style={{ ...thStyle, textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr
                  key={m.id}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <td
                    style={{
                      ...tdStyle,
                      fontWeight: "var(--font-medium)" as unknown as number,
                    }}
                  >
                    {m.name}
                  </td>
                  <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>
                    v{m.version}
                  </td>
                  <td style={tdStyle}>
                    <Badge variant={CATEGORY_VARIANT[m.category] ?? "default"} size="sm">
                      {m.category}
                    </Badge>
                  </td>
                  <td style={tdStyle}>
                    <span style={shaCellStyle}>
                      {(m.sha256 || "").slice(0, 8)}
                      <button
                        type="button"
                        style={copyBtnStyle}
                        aria-label="复制完整 SHA256"
                        title="复制完整 SHA256"
                        onClick={() => handleCopySha(m.sha256)}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.color =
                            "var(--text-primary)";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.color =
                            "var(--text-tertiary)";
                        }}
                      >
                        {copiedSha === m.sha256 ? (
                          <Check size={12} />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                    </span>
                  </td>
                  <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>
                    {formatSize(m.size_bytes)}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color: "var(--text-secondary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatTime(m.created_at)}
                  </td>
                  <td style={{ ...tdStyle, color: "var(--text-tertiary)" }}>
                    {m.uploaded_by ? (
                      <code
                        style={{
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        {m.uploaded_by}
                      </code>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={13} />}
                      loading={busyId === m.id}
                      onClick={() => handleDelete(m)}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && models.length === 0 && (
        <EmptyState
          icon={<Database size={24} />}
          title="暂无模型"
          description="暂无模型，点击上传第一个模型。"
        />
      )}

      {/* Upload modal */}
      <UploadModelModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={handleUploaded}
      />
    </div>
  );
}

export default Models;

/* -------------------------------------------------------------------------- */
/*  Upload Modal                                                              */
/* -------------------------------------------------------------------------- */

interface UploadModelModalProps {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

function UploadModelModal({ open, onClose, onUploaded }: UploadModelModalProps) {
  const addToast = useUIStore((s) => s.addToast);

  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [category, setCategory] = useState("embedding");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Reset state when modal reopens
  useEffect(() => {
    if (open) {
      setName("");
      setVersion("");
      setCategory("embedding");
      setFiles([]);
      setFormError(null);
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setFormError(null);

      if (!name.trim()) {
        setFormError("请输入模型名称");
        return;
      }
      if (!version.trim()) {
        setFormError("请输入版本号");
        return;
      }
      if (files.length === 0) {
        setFormError("请选择至少一个文件");
        return;
      }

      setSubmitting(true);
      try {
        const fd = new FormData();
        fd.append("name", name.trim());
        fd.append("version", version.trim());
        fd.append("category", category);
        for (const f of files) {
          fd.append("file", f, f.name);
        }
        await api.models.upload(fd);
        onUploaded();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "上传失败");
        addToast("error", err instanceof Error ? err.message : "上传失败");
      } finally {
        setSubmitting(false);
      }
    },
    [name, version, category, files, onUploaded, addToast],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="上传模型"
      size="md"
    >
      <form onSubmit={handleSubmit}>
        <div style={formRowStyle}>
          <Input
            label="名称"
            placeholder="例如：bge-m3"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div style={formRowStyle}>
          <Input
            label="版本"
            placeholder="例如：1.0.0"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required
          />
        </div>

        <div style={formRowStyle}>
          <label
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-medium)" as unknown as number,
              color: "var(--text-primary)",
            }}
          >
            类别
          </label>
          <Select
            value={category}
            onChange={setCategory}
            options={CATEGORY_OPTIONS}
            aria-label="模型类别"
          />
        </div>

        <div style={formRowStyle}>
          <label
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-medium)" as unknown as number,
              color: "var(--text-primary)",
            }}
          >
            文件
          </label>
          <DropZone
            onFiles={(incoming) => setFiles((prev) => [...prev, ...incoming])}
            label="拖拽文件到此处"
            hint="或点击选择文件（可多选）"
          />
          {files.length > 0 && (
            <div style={fileListStyle}>
              {files.map((f, idx) => (
                <div key={`${f.name}-${idx}`} style={fileChipStyle}>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.name}
                  </span>
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {formatSize(f.size)}
                  </span>
                  <button
                    type="button"
                    style={{
                      ...copyBtnStyle,
                      width: 18,
                      height: 18,
                      color: "var(--text-tertiary)",
                    }}
                    aria-label={`移除 ${f.name}`}
                    onClick={() =>
                      setFiles((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    <Check size={11} style={{ display: "none" }} />
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {formError && (
          <div
            style={{
              padding: "var(--space-2) var(--space-3)",
              background: "var(--error-light)",
              border: "1px solid var(--error)",
              borderRadius: "var(--radius-md)",
              color: "var(--error-dark)",
              fontSize: "var(--text-xs)",
              marginBottom: "var(--space-3)",
            }}
          >
            {formError}
          </div>
        )}

        <div style={modalFooterStyle}>
          <Button
            variant="secondary"
            size="md"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={submitting}
          >
            上传
          </Button>
        </div>
      </form>
    </Modal>
  );
}
