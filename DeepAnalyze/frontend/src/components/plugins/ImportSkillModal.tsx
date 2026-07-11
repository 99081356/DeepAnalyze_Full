// =============================================================================
// DeepAnalyze - ImportSkillModal
// =============================================================================
//
// Lets the user import skills from an uploaded file (.md / .json / .zip).
// On a name collision the server returns the conflict set; this modal then
// renders one SkillConflictModal at a time until all conflicts are resolved
// (overwrite / rename / skip) or the user cancels.
// =============================================================================

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { DropZone } from "../ui/DropZone";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import { AlertCircle, FolderOpen } from "lucide-react";
import type { SkillImportConflict } from "../../types/index";
import { SkillConflictModal, type ConflictResolution } from "./SkillConflictModal";

const ACCEPT = ".md,.json,.zip";

export function ImportSkillModal({
  onImported,
  onClose,
}: {
  /** Called after each successful import/create/update so the parent can refresh. */
  onImported: () => void;
  onClose: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The file(s) being imported (kept so we can re-POST with overwrite/rename).
  // Single-file upload: one entry; folder upload: many entries.
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  // Active conflicts queue (from the server's 409 response).
  const [conflicts, setConflicts] = useState<SkillImportConflict[]>([]);

  const currentConflict = conflicts[0] ?? null;

  // -------------------------------------------------------------------------
  // Initial import (mode=auto)
  // -------------------------------------------------------------------------
  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setPendingFiles(files);
    setError(null);
    setImporting(true);
    try {
      const result = await api.importAgentSkill(files, { mode: "auto" });
      if (result.conflict && result.conflicts?.length) {
        setConflicts(result.conflicts);
      } else {
        const count = result.results?.length ?? result.created?.length ?? 0;
        success(`成功导入 ${count} 个技能`);
        onImported();
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setImporting(false);
    }
  };

  // -------------------------------------------------------------------------
  // Conflict resolution — re-POST the same file(s) with the chosen mode.
  // IMPORTANT: a non-auto re-POST processes EVERY skill in the upload, not
  // just the current one. So on success (conflict===false) the entire queue is
  // resolved — clear it rather than advancing with slice(1).
  // -------------------------------------------------------------------------
  const handleResolve = async (resolution: ConflictResolution) => {
    if (!pendingFiles || !currentConflict) return;
    setImporting(true);
    setError(null);
    try {
      const result = await api.importAgentSkill(pendingFiles, {
        mode: resolution.mode,
        newName: resolution.newName,
      });

      if (result.conflict && result.conflicts?.length) {
        // Server still has conflicts (e.g. rename target also collided) —
        // show the freshly-returned set.
        setConflicts(result.conflicts);
        return;
      }

      // Success — the re-POST resolved the whole file. Report and finish.
      const count = result.results?.length ?? result.created?.length ?? 0;
      if (resolution.mode === "rename") {
        // For single-skill renames the user's name is used; for multi-skill
        // ZIPs the server auto-suffixes. Either way, report the actual count.
        success(count > 0 ? `成功创建/覆盖 ${count} 个技能` : "技能已处理");
      } else {
        success(count > 0 ? `成功覆盖 ${count} 个技能` : "技能已覆盖");
      }
      onImported();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setImporting(false);
    }
  };

  /** Skip the current conflict (no re-POST) and advance to the next. */
  const handleSkip = () => {
    const remaining = conflicts.slice(1);
    if (remaining.length > 0) {
      setConflicts(remaining);
    } else {
      onClose();
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (currentConflict) {
    return (
      <SkillConflictModal
        conflict={currentConflict}
        onResolve={handleResolve}
        onSkip={handleSkip}
        onCancel={onClose}
      />
    );
  }

  return (
    <Modal open={true} onClose={onClose} title="导入技能" size="lg">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {/* Error */}
        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-2) var(--space-3)",
              background: "var(--error-light)",
              color: "var(--error-dark)",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-xs)",
            }}
          >
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {/* Drop zone */}
        <DropZone
          onFiles={handleFiles}
          accept={ACCEPT}
          multiple={false}
          label="拖拽技能文件或文件夹到此处"
          hint="或点击选择文件 / 下方选择文件夹"
        />

        {/* Folder upload */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Button
            variant="secondary"
            size="sm"
            icon={<FolderOpen size={14} />}
            onClick={() => {
              // Create input, attach to DOM (required by some browsers for
              // webkitdirectory to trigger the folder picker), then click.
              const input = document.createElement("input");
              input.type = "file";
              input.multiple = true;
              input.style.display = "none";
              (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
              input.onchange = () => {
                if (input.files && input.files.length > 0) {
                  handleFiles(Array.from(input.files));
                }
                input.remove();
              };
              document.body.appendChild(input);
              input.click();
            }}
            disabled={importing}
          >
            选择文件夹
          </Button>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            上传整个技能文件夹（含 SKILL.md + 资源文件）
          </span>
        </div>

        {/* Format guide */}
        <div
          style={{
            padding: "var(--space-3)",
            background: "var(--bg-tertiary)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "var(--text-primary)" }}>支持的格式：</strong>
          <ul style={{ margin: "var(--space-1) 0 0", paddingLeft: "var(--space-4)" }}>
            <li><code>.md</code> — SKILL.md 文件（YAML frontmatter + Markdown，兼容 Claude Code/OpenClaw 格式）</li>
            <li><code>.json</code> — 技能对象（含 name / prompt / tools 等字段）</li>
            <li><code>.zip</code> — 技能包（含一个或多个 SKILL.md + 资源文件，<code>&lt;!-- @include --&gt;</code> 会被解析）</li>
            <li><strong>文件夹</strong> — 整个技能文件夹（含 SKILL.md + 资源文件，点「选择文件夹」上传）</li>
          </ul>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="secondary" onClick={onClose} disabled={importing}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
