// =============================================================================
// DeepAnalyze - TeamEditor Component
// Modal form for creating / editing an agent team
// =============================================================================

import { useState, useCallback } from "react";
import { agentTeamsApi, type TeamInfo, type TeamMember } from "../../api/agentTeams";
import { X, Plus, Trash2, Loader2, AlertCircle } from "lucide-react";

// ---------------------------------------------------------------------------
// Extended member type with UI-only fields
// ---------------------------------------------------------------------------

interface MemberFormData extends TeamMember {
  /** UI-only: whether the systemPrompt textarea is expanded */
  showSystemPrompt?: boolean;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TeamEditorProps {
  /** null = create mode, otherwise edit existing team */
  team: TeamInfo | null;
  /** Close the modal */
  onClose: () => void;
  /** Called after a successful save */
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// Mode options
// ---------------------------------------------------------------------------

const MODE_OPTIONS: Array<{ value: TeamInfo["mode"]; label: string }> = [
  { value: "pipeline", label: "流水线（顺序执行）" },
  { value: "parallel", label: "并行" },
  { value: "council", label: "会议（辩论）" },
  { value: "graph", label: "图（DAG）" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let memberSeq = 0;
function nextMemberId(): string {
  return `member-${Date.now()}-${++memberSeq}`;
}

function emptyMember(): MemberFormData {
  return {
    id: nextMemberId(),
    role: "",
    task: "",
    tools: [],
    dependsOn: [],
    showSystemPrompt: false,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamEditor({ team, onClose, onSaved }: TeamEditorProps) {
  const isCreate = team === null;

  // Form state
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [mode, setMode] = useState<TeamInfo["mode"]>(team?.mode ?? "pipeline");
  const [members, setMembers] = useState<MemberFormData[]>(
    team?.members?.length ? team.members.map((m) => ({ ...m, showSystemPrompt: false })) : [emptyMember()],
  );

  const [saving, setSaving] = useState(false);
  const [crossReview, setCrossReview] = useState(team?.crossReview ?? false);
  const [error, setError] = useState<string | null>(null);

  // ---- Member mutation helpers ----

  const updateMember = useCallback(
    (index: number, patch: Partial<MemberFormData>) => {
      setMembers((prev) =>
        prev.map((m, i) => (i === index ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  const addMember = useCallback(() => {
    setMembers((prev) => [...prev, emptyMember()]);
  }, []);

  const removeMember = useCallback((index: number) => {
    setMembers((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const ALL_TOOLS = ["kb_search", "wiki_browse", "expand", "web_search", "bash", "read_file", "grep"] as const;

  const toggleTool = useCallback(
    (memberIndex: number, tool: string) => {
      setMembers((prev) => {
        const member = prev[memberIndex];
        const currentTools =
          member.tools?.[0] === "*"
            ? [...ALL_TOOLS]
            : (member.tools ?? []);
        const newTools = currentTools.includes(tool)
          ? currentTools.filter((t) => t !== tool)
          : [...currentTools, tool];
        const updated = newTools.length === ALL_TOOLS.length ? ["*"] : newTools;
        return prev.map((m, i) =>
          i === memberIndex ? { ...m, tools: updated } : m,
        );
      });
    },
    [],
  );

  // ---- Save ----

  const handleSave = async () => {
    // Basic validation
    if (!name.trim()) {
      setError("请输入团队名称");
      return;
    }

    const validMembers = members.filter((m) => m.role.trim() || m.task.trim());
    if (validMembers.length === 0) {
      setError("至少需要一个带角色的成员");
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const payload: Partial<TeamInfo> = {
        name: name.trim(),
        description: description.trim(),
        mode,
        members: validMembers.map(({ showSystemPrompt: _sp, ...rest }) => rest),
        isActive: true,
        crossReview: mode === "council" ? crossReview : false,
      };

      if (isCreate) {
        await agentTeamsApi.create(payload);
      } else {
        await agentTeamsApi.update(team.id, payload);
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // ---- Render ----

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, black 50%, transparent)",
      }}
      onClick={(e) => {
        // Close on backdrop click
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-primary)",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--border-primary)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---- Header ---- */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-4)",
            borderBottom: "1px solid var(--border-primary)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-semibold)",
              color: "var(--text-primary)",
              flex: 1,
            }}
          >
            {isCreate ? "新建团队" : "编辑团队"}
          </span>
          <button
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: "var(--radius-md)",
              border: "none",
              background: "transparent",
              color: "var(--text-tertiary)",
              cursor: "pointer",
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* ---- Body (scrollable) ---- */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "var(--space-4)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {/* Error */}
          {error && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-2) var(--space-3)",
                background: "color-mix(in srgb, var(--error) 10%, transparent)",
                color: "var(--error)",
                fontSize: "var(--text-xs)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          {/* Name field */}
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
                color: "var(--text-secondary)",
              }}
            >
              团队名称 *
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：研究团队"
              style={{
                fontSize: "var(--text-sm)",
                padding: "6px 10px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-primary)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                outline: "none",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--interactive)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-primary)";
              }}
            />
          </label>

          {/* Description field */}
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
                color: "var(--text-secondary)",
              }}
            >
              描述
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述团队的目标"
              rows={2}
              style={{
                fontSize: "var(--text-sm)",
                padding: "6px 10px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-primary)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                outline: "none",
                resize: "vertical",
                fontFamily: "inherit",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--interactive)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-primary)";
              }}
            />
          </label>

          {/* Mode select */}
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
                color: "var(--text-secondary)",
              }}
            >
              模式
            </span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as TeamInfo["mode"])}
              style={{
                fontSize: "var(--text-sm)",
                padding: "6px 10px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-primary)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                outline: "none",
                cursor: "pointer",
              }}
            >
              {MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          {/* crossReview toggle - only in council mode */}
          {mode === "council" && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={crossReview}
                onChange={(e) => setCrossReview(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--text-secondary)",
                }}
              >
                启用交叉审查 (Round 2)
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "var(--text-tertiary)",
                  marginLeft: 4,
                }}
                title="第一轮各成员独立分析后，第二轮互相审查对方的输出并精炼自己的结论"
              >
                (?)
              </span>
            </label>
          )}

          {/* ---- Members section ---- */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  color: "var(--text-secondary)",
                  flex: 1,
                }}
              >
                成员 ({members.length})
              </span>
              <button
                onClick={addMember}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  fontSize: 10,
                  color: "var(--interactive)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 4px",
                }}
              >
                <Plus size={10} />
                添加
              </button>
            </div>

            {members.map((member, index) => (
              <div
                key={member.id}
                style={{
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-md)",
                  padding: "var(--space-2) var(--space-3)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                  background: "var(--bg-secondary)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: "var(--font-medium)",
                      color: "var(--text-tertiary)",
                      width: 20,
                      textAlign: "center",
                    }}
                  >
                    #{index + 1}
                  </span>

                  {/* Role */}
                  <input
                    type="text"
                    value={member.role}
                    onChange={(e) =>
                      updateMember(index, { role: e.target.value })
                    }
                    placeholder="角色（如：研究员）"
                    style={{
                      flex: 1,
                      fontSize: "var(--text-xs)",
                      padding: "4px 8px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-primary)",
                      background: "var(--bg-primary)",
                      color: "var(--text-primary)",
                      outline: "none",
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = "var(--interactive)";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = "var(--border-primary)";
                    }}
                  />

                  {/* Remove button */}
                  {members.length > 1 && (
                    <button
                      onClick={() => removeMember(index)}
                      style={{
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
                        flexShrink: 0,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--error)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-tertiary)";
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                {/* Task */}
                <input
                  type="text"
                  value={member.task}
                  onChange={(e) =>
                    updateMember(index, { task: e.target.value })
                  }
                  placeholder="任务描述"
                  style={{
                    fontSize: "var(--text-xs)",
                    padding: "4px 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-primary)",
                    background: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    outline: "none",
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = "var(--interactive)";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-primary)";
                  }}
                />

                {/* Tools - always shown */}
                <div style={{ marginTop: "var(--space-2)" }}>
                  <label style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>工具</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
                    {ALL_TOOLS.map((tool) => {
                      const selected = (member.tools ?? ["*"])[0] === "*" || (member.tools ?? []).includes(tool);
                      return (
                        <button key={tool} onClick={() => toggleTool(index, tool)} style={{
                          padding: "1px var(--space-2)",
                          fontSize: "var(--text-xs)",
                          border: `1px solid ${selected ? "var(--interactive)" : "var(--border-primary)"}`,
                          borderRadius: "var(--radius-sm)",
                          backgroundColor: selected ? "var(--interactive-light)" : "transparent",
                          color: selected ? "var(--interactive)" : "var(--text-secondary)",
                          cursor: "pointer",
                        }}>
                          {tool}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* dependsOn - only in graph mode */}
                {mode === "graph" && (
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <label style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>依赖</label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
                      {members.filter((_, j) => j !== index && members[j].role).map((other) => (
                        <button key={other.id} onClick={() => {
                          const deps = member.dependsOn ?? [];
                          const newDeps = deps.includes(other.role)
                            ? deps.filter((d) => d !== other.role)
                            : [...deps, other.role];
                          updateMember(index, { dependsOn: newDeps });
                        }} style={{
                          padding: "1px var(--space-2)",
                          fontSize: "var(--text-xs)",
                          border: `1px solid ${(member.dependsOn ?? []).includes(other.role) ? "var(--success)" : "var(--border-primary)"}`,
                          borderRadius: "var(--radius-sm)",
                          backgroundColor: (member.dependsOn ?? []).includes(other.role) ? "var(--success-light, #dcfce7)" : "transparent",
                          color: (member.dependsOn ?? []).includes(other.role) ? "var(--success)" : "var(--text-secondary)",
                          cursor: "pointer",
                        }}>
                          {other.role}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* perspective - only in council mode */}
                {mode === "council" && (
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <label style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>分析视角</label>
                    <input
                      type="text"
                      value={member.perspective ?? ""}
                      onChange={(e) => updateMember(index, { perspective: e.target.value })}
                      placeholder="从...角度分析"
                      style={{
                        width: "100%",
                        padding: "var(--space-2) var(--space-3)",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "var(--radius-md)",
                        fontSize: "var(--text-sm)",
                        backgroundColor: "var(--bg-tertiary)",
                        color: "var(--text-primary)",
                        outline: "none",
                      }}
                    />
                  </div>
                )}

                {/* System Prompt - collapsible */}
                {member.showSystemPrompt && (
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <label style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>系统提示词（可选）</label>
                    <textarea
                      value={member.systemPrompt ?? ""}
                      onChange={(e) => updateMember(index, { systemPrompt: e.target.value })}
                      placeholder="自定义系统提示词..."
                      rows={2}
                      style={{
                        width: "100%",
                        padding: "var(--space-2) var(--space-3)",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "var(--radius-md)",
                        fontSize: "var(--text-sm)",
                        backgroundColor: "var(--bg-tertiary)",
                        color: "var(--text-primary)",
                        outline: "none",
                        resize: "vertical",
                        fontFamily: "inherit",
                      }}
                    />
                  </div>
                )}
                <button
                  onClick={() => updateMember(index, { showSystemPrompt: !member.showSystemPrompt })}
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--interactive)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: "2px 0",
                    textAlign: "left" as const,
                  }}
                >
                  {member.showSystemPrompt ? "收起" : "系统提示词"}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Footer ---- */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-4)",
            borderTop: "1px solid var(--border-primary)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              fontSize: "var(--text-xs)",
              padding: "6px 14px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-primary)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            取消
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: "var(--text-xs)",
              fontWeight: "var(--font-medium)",
              padding: "6px 14px",
              borderRadius: "var(--radius-md)",
              border: "none",
              background: "var(--interactive)",
              color: "white",
              cursor: saving ? "wait" : "pointer",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving && <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />}
            {isCreate ? "创建" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
