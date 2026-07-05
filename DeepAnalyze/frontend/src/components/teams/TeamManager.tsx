// =============================================================================
// DeepAnalyze - TeamManager Component
// Lists agent teams as cards with CRUD + execute operations
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import { agentTeamsApi, type TeamInfo } from "../../api/agentTeams";
import { TeamEditor } from "./TeamEditor";
import { SubAgentPanel } from "./SubAgentPanel";
import { useWorkflowStore } from "../../store/workflow";
import {
  Plus,
  Users,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  Play,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Mode badge colors
// ---------------------------------------------------------------------------

const MODE_STYLES: Record<string, { bg: string; color: string }> = {
  pipeline: { bg: "color-mix(in srgb, var(--interactive) 15%, transparent)", color: "var(--interactive)" },
  graph: { bg: "color-mix(in srgb, var(--success) 15%, transparent)", color: "var(--success)" },
  council: { bg: "color-mix(in srgb, var(--warning) 15%, transparent)", color: "var(--warning)" },
  parallel: { bg: "color-mix(in srgb, #a78bfa 15%, transparent)", color: "#a78bfa" },
};

const MODE_LABELS: Record<string, string> = {
  pipeline: "流水线",
  parallel: "并行",
  council: "会议",
  graph: "图",
};

// ---------------------------------------------------------------------------
// Execute dialog state
// ---------------------------------------------------------------------------

interface ExecuteDialogState {
  team: TeamInfo;
  goal: string;
  loading: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamManager() {
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTeam, setEditingTeam] = useState<TeamInfo | null | "create">(null);

  // Execute dialog state
  const [execDialog, setExecDialog] = useState<ExecuteDialogState | null>(null);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);

  // Workflow store for monitoring
  const { activeWorkflows } = useWorkflowStore();

  // ---- Load teams ----
  const loadTeams = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await agentTeamsApi.list();
      setTeams(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载团队失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  // ---- Delete handler ----
  const handleDelete = async (id: string) => {
    try {
      await agentTeamsApi.delete(id);
      setTeams((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除团队失败");
    }
  };

  // ---- Save callback from TeamEditor ----
  const handleSaved = useCallback(() => {
    setEditingTeam(null);
    loadTeams();
  }, [loadTeams]);

  // ---- Execute workflow ----
  const handleExecute = async () => {
    if (!execDialog || !execDialog.goal.trim()) return;

    setExecDialog((prev) => prev ? { ...prev, loading: true, error: null } : null);

    try {
      const result = await agentTeamsApi.execute(
        execDialog.team.id,
        execDialog.goal.trim(),
      );
      setActiveWorkflowId(result.workflowId);
      setExecDialog(null);
    } catch (err) {
      setExecDialog((prev) => prev ? {
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "执行失败",
      } : null);
    }
  };

  // ---- Render ----

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-2)",
          padding: "var(--space-8)",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-sm)",
        }}
      >
        <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
        加载团队中...
      </div>
    );
  }

  // If we have an active workflow, show its monitoring panel
  const hasActiveWorkflow = activeWorkflowId && activeWorkflows.has(activeWorkflowId);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ---- Toolbar ---- */}
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
        <Users size={16} style={{ color: "var(--interactive)" }} />
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-semibold)",
            color: "var(--text-primary)",
            flex: 1,
          }}
        >
          Agent 团队
        </span>

        <button
          onClick={() => setEditingTeam("create")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: "var(--text-xs)",
            fontWeight: "var(--font-medium)",
            color: "var(--interactive)",
            background: "transparent",
            border: "1px solid var(--interactive)",
            borderRadius: "var(--radius-md)",
            padding: "4px 10px",
            cursor: "pointer",
            transition: "all var(--transition-fast)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--interactive)";
            e.currentTarget.style.color = "white";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--interactive)";
          }}
        >
          <Plus size={12} />
          新建团队
        </button>
      </div>

      {/* ---- Error banner ---- */}
      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-4)",
            background: "color-mix(in srgb, var(--error) 10%, transparent)",
            color: "var(--error)",
            fontSize: "var(--text-xs)",
          }}
        >
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* ---- Active workflow monitor ---- */}
      {hasActiveWorkflow && activeWorkflowId && (
        <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border-primary)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-2) var(--space-4)",
              background: "color-mix(in srgb, var(--interactive) 5%, transparent)",
            }}
          >
            <span
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--font-medium)",
                color: "var(--interactive)",
                flex: 1,
              }}
            >
              执行中...
            </span>
            <button
              onClick={() => setActiveWorkflowId(null)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 20,
                height: 20,
                borderRadius: "var(--radius-sm)",
                border: "none",
                background: "transparent",
                color: "var(--text-tertiary)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <X size={12} />
            </button>
          </div>
          <SubAgentPanel workflowId={activeWorkflowId} panelMode="expanded" />
        </div>
      )}

      {/* ---- Team list ---- */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-3) var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        {teams.length === 0 && !error && (
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-8)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-sm)",
            }}
          >
            暂无团队。点击"+ 新建团队"创建。
          </div>
        )}

        {teams.map((team) => {
          const modeStyle = MODE_STYLES[team.mode] ?? MODE_STYLES.pipeline;

          return (
            <div
              key={team.id}
              style={{
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-lg)",
                padding: "var(--space-3)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                background: "var(--bg-secondary)",
                transition: "box-shadow var(--transition-fast)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow =
                  "0 1px 4px color-mix(in srgb, var(--bg-primary) 80%, transparent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              {/* Team info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    marginBottom: 2,
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--font-semibold)",
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {team.name}
                  </span>

                  {/* Mode badge */}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: "var(--font-medium)",
                      padding: "1px 6px",
                      borderRadius: "var(--radius-sm)",
                      background: modeStyle.bg,
                      color: modeStyle.color,
                      textTransform: "capitalize",
                      flexShrink: 0,
                    }}
                  >
                    {MODE_LABELS[team.mode] ?? team.mode}
                  </span>

                  {/* Member count */}
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-tertiary)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      flexShrink: 0,
                    }}
                  >
                    <Users size={10} />
                    {team.members?.length ?? 0}
                  </span>
                </div>

                {team.description && (
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--text-secondary)",
                      lineHeight: 1.4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {team.description}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: "var(--space-1)", flexShrink: 0 }}>
                {/* Execute button */}
                <button
                  onClick={() =>
                    setExecDialog({ team, goal: "", loading: false, error: null })
                  }
                  title="执行"
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
                    transition: "all var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "color-mix(in srgb, var(--success) 10%, transparent)";
                    e.currentTarget.style.color = "var(--success)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--text-tertiary)";
                  }}
                >
                  <Play size={14} />
                </button>

                <button
                  onClick={() => setEditingTeam(team)}
                  title="编辑"
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
                    transition: "all var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--interactive)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--text-tertiary)";
                  }}
                >
                  <Pencil size={14} />
                </button>

                <button
                  onClick={() => handleDelete(team.id)}
                  title="删除"
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
                    transition: "all var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "color-mix(in srgb, var(--error) 10%, transparent)";
                    e.currentTarget.style.color = "var(--error)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--text-tertiary)";
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ---- Execute dialog modal ---- */}
      {execDialog && (
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
            if (e.target === e.currentTarget && !execDialog.loading) {
              setExecDialog(null);
            }
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 480,
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
            {/* Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-3) var(--space-4)",
                borderBottom: "1px solid var(--border-primary)",
              }}
            >
              <Play size={14} style={{ color: "var(--success)" }} />
              <span
                style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--font-semibold)",
                  color: "var(--text-primary)",
                  flex: 1,
                }}
              >
                执行团队: {execDialog.team.name}
              </span>
              <button
                onClick={() => !execDialog.loading && setExecDialog(null)}
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
                  cursor: execDialog.loading ? "wait" : "pointer",
                }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div
              style={{
                padding: "var(--space-4)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
              }}
            >
              {/* Team info summary */}
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  fontSize: "var(--text-xs)",
                  color: "var(--text-tertiary)",
                }}
              >
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: "var(--radius-sm)",
                    background: MODE_STYLES[execDialog.team.mode]?.bg,
                    color: MODE_STYLES[execDialog.team.mode]?.color,
                    fontWeight: "var(--font-medium)",
                  }}
                >
                  {MODE_LABELS[execDialog.team.mode] ?? execDialog.team.mode}
                </span>
                <span>{execDialog.team.members?.length ?? 0} 个成员</span>
                {execDialog.team.crossReview && (
                  <span style={{ color: "var(--warning)" }}>交叉审查</span>
                )}
              </div>

              {/* Members list */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--space-1)",
                }}
              >
                {execDialog.team.members?.map((m) => (
                  <span
                    key={m.id}
                    style={{
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-tertiary)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {m.role}
                  </span>
                ))}
              </div>

              {/* Goal input */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--font-medium)",
                    color: "var(--text-secondary)",
                  }}
                >
                  任务目标 *
                </span>
                <textarea
                  value={execDialog.goal}
                  onChange={(e) =>
                    setExecDialog((prev) =>
                      prev ? { ...prev, goal: e.target.value } : null,
                    )
                  }
                  placeholder="描述你希望团队完成的任务目标..."
                  rows={3}
                  autoFocus
                  disabled={execDialog.loading}
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      handleExecute();
                    }
                  }}
                />
              </label>

              {/* Error */}
              {execDialog.error && (
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
                  {execDialog.error}
                </div>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: "var(--space-2)",
                padding: "var(--space-3) var(--space-4)",
                borderTop: "1px solid var(--border-primary)",
              }}
            >
              <button
                onClick={() => setExecDialog(null)}
                disabled={execDialog.loading}
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
                onClick={handleExecute}
                disabled={execDialog.loading || !execDialog.goal.trim()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  padding: "6px 14px",
                  borderRadius: "var(--radius-md)",
                  border: "none",
                  background: "var(--success)",
                  color: "white",
                  cursor: execDialog.loading ? "wait" : "pointer",
                  opacity: execDialog.loading || !execDialog.goal.trim() ? 0.7 : 1,
                }}
              >
                {execDialog.loading ? (
                  <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                ) : (
                  <Play size={12} />
                )}
                执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- TeamEditor modal ---- */}
      {editingTeam !== null && (
        <TeamEditor
          team={editingTeam === "create" ? null : editingTeam}
          onClose={() => setEditingTeam(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
