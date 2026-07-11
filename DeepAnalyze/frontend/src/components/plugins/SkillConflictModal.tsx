// =============================================================================
// DeepAnalyze - SkillConflictModal
// =============================================================================
//
// Shown when importing a skill collides with an existing skill by name.
// The user picks one of three resolution strategies; the choice is reported
// back via onResolve. "Skip" closes the modal without resolving.
//
// Used by ImportSkillModal (Worker-side import) and is structured so the Hub
// admin import can reuse the same component shape.
// =============================================================================

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { AlertTriangle, Replace, Pencil, SkipForward } from "lucide-react";
import type { SkillImportConflict } from "../../types/index";

type ResolveMode = "overwrite" | "rename" | "skip";

export interface ConflictResolution {
  mode: "overwrite" | "rename";
  newName?: string;
}

export function SkillConflictModal({
  conflict,
  onResolve,
  onSkip,
  onCancel,
}: {
  conflict: SkillImportConflict;
  /** Called for overwrite/rename resolution. */
  onResolve: (resolution: ConflictResolution) => Promise<void>;
  /** Called when the user picks "skip this one" — advances to the next conflict. */
  onSkip: () => void;
  /** Called when the user aborts the entire import. */
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<ResolveMode>("overwrite");
  const [newName, setNewName] = useState<string>(
    `${conflict.existing.name}-imported`,
  );
  const [resolving, setResolving] = useState(false);

  const handleResolve = async () => {
    if (mode === "skip") {
      onSkip();
      return;
    }
    setResolving(true);
    try {
      await onResolve(
        mode === "rename"
          ? { mode: "rename", newName: newName.trim() || conflict.existing.name }
          : { mode: "overwrite" },
      );
    } finally {
      setResolving(false);
    }
  };

  const optionStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-3)",
    padding: "var(--space-3)",
    border: `1px solid ${active ? "var(--interactive)" : "var(--border-primary)"}`,
    borderRadius: "var(--radius-md)",
    background: active ? "var(--interactive-light, var(--bg-tertiary))" : "var(--bg-secondary)",
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  });

  return (
    <Modal
      open={true}
      onClose={onCancel}
      title="技能名称冲突"
      size="md"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {/* Warning banner */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--warning-light)",
            color: "var(--warning-dark)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--text-sm)",
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span>
            已存在名为 <strong>{conflict.existing.name}</strong> 的技能，请选择处理方式：
          </span>
        </div>

        {/* Comparison */}
        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <div style={{ flex: 1, padding: "var(--space-3)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-md)", background: "var(--bg-primary)" }}>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginBottom: "var(--space-1)" }}>
              现有技能
            </div>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
              {conflict.existing.name}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>
              {conflict.existing.description || "无描述"}
            </div>
            {conflict.existing.source && (
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>
                来源: {conflict.existing.source}
              </div>
            )}
          </div>
          <div style={{ flex: 1, padding: "var(--space-3)", border: "1px solid var(--interactive)", borderRadius: "var(--radius-md)", background: "var(--interactive-light, var(--bg-tertiary))" }}>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginBottom: "var(--space-1)" }}>
              导入技能
            </div>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
              {conflict.parsed.name}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>
              {conflict.parsed.description || "无描述"}
            </div>
          </div>
        </div>

        {/* Options */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <label
            style={optionStyle(mode === "overwrite")}
            onClick={() => setMode("overwrite")}
          >
            <input type="radio" checked={mode === "overwrite"} onChange={() => setMode("overwrite")} style={{ marginTop: 3 }} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
                <Replace size={13} /> 覆盖现有技能
              </div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>
                用导入内容替换现有技能的提示词、工具、元数据。原技能数据将丢失。
              </div>
            </div>
          </label>

          <label
            style={optionStyle(mode === "rename")}
            onClick={() => setMode("rename")}
          >
            <input type="radio" checked={mode === "rename"} onChange={() => setMode("rename")} style={{ marginTop: 3 }} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
                <Pencil size={13} /> 重命名导入
              </div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2, marginBottom: "var(--space-2)" }}>
                用新名称创建技能，保留现有技能不变。
              </div>
              {mode === "rename" && (
                <Input
                  label="新名称"
                  value={newName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
                  placeholder="输入新的技能名称"
                />
              )}
            </div>
          </label>

          <label
            style={optionStyle(mode === "skip")}
            onClick={() => setMode("skip")}
          >
            <input type="radio" checked={mode === "skip"} onChange={() => setMode("skip")} style={{ marginTop: 3 }} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
                <SkipForward size={13} /> 跳过此项
              </div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 2 }}>
                不导入此技能，保持现状。
              </div>
            </div>
          </label>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          <Button variant="secondary" onClick={onCancel} disabled={resolving}>
            取消导入
          </Button>
          <Button
            variant={mode === "overwrite" ? "danger" : "primary"}
            onClick={handleResolve}
            loading={resolving}
            disabled={mode === "rename" && !newName.trim()}
          >
            {mode === "overwrite" ? "覆盖" : mode === "rename" ? "创建" : "跳过"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
