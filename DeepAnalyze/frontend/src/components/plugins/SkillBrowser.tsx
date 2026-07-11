// =============================================================================
// DeepAnalyze - SkillBrowser Component
// Browse, create, execute and delete skills (agent_skills table)
// =============================================================================

import { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "../../api/client";
import { useChatStore } from "../../store/chat";
import { useHubStore } from "../../store/hub";
import { useToast } from "../../hooks/useToast";
import { useConfirm } from "../../hooks/useConfirm";
import { Spinner } from "../ui/Spinner";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { Input } from "../ui/Input";
import { TextArea } from "../ui/TextArea";
import type { AgentSkillInfo } from "../../types/index";
import { ImportSkillModal } from "./ImportSkillModal";
import {
  Zap,
  Plus,
  Trash2,
  RefreshCw,
  Play,
  CheckCircle,
  Wrench,
  Package,
  AlertCircle,
  Shield,
  Power,
  Search,
  Upload,
  Share2,
  Store,
} from "lucide-react";

// =============================================================================
// Main SkillBrowser component
// =============================================================================

export function SkillBrowser() {
  const { success, error: toastError } = useToast();
  const confirm = useConfirm();
  const [skills, setSkills] = useState<AgentSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Execution state
  const [executeModalOpen, setExecuteModalOpen] = useState(false);
  const [executeSkillId, setExecuteSkillId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executingResult, setExecutingResult] = useState<{
    skillName: string;
    output: string;
  } | null>(null);

  // Create skill state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // Import skill state
  const [importModalOpen, setImportModalOpen] = useState(false);

  // Publish-to-hub state
  const [publishingId, setPublishingId] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");

  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const isWorkerMode = useHubStore((s) => s.isWorkerMode);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.listAgentSkills();
      setSkills(data);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load skills"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  // ---- Filtered skills by search query ----
  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [skills, searchQuery]);

  // ---- Delete handler ----
  const handleDelete = async (skill: AgentSkillInfo) => {
    const ok = await confirm({
      title: "删除技能",
      message: `确定要删除技能"${skill.name}"吗？此操作不可撤销。`,
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(skill.id);
    try {
      await api.deleteAgentSkill(skill.id);
      success(`技能"${skill.name}"已删除`);
      await loadSkills();
    } catch {
      toastError("删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // ---- Execute handlers ----
  const openExecuteModal = (skillId: string) => {
    setExecuteSkillId(skillId);
    setExecuteModalOpen(true);
  };

  const closeExecuteModal = () => {
    setExecuteModalOpen(false);
    setExecuteSkillId(null);
  };

  const handleExecute = async (input?: string) => {
    if (!executeSkillId) return;
    const skill = skills.find((s) => s.id === executeSkillId);
    setExecutingId(executeSkillId);
    try {
      const result = await api.runAgentSkill(
        currentSessionId ?? "",
        executeSkillId,
        input,
      );
      setExecutingResult({ skillName: skill?.name ?? "", output: result.output });
      success(`技能"${skill?.name}"执行成功`);
    } catch (err) {
      toastError("执行失败: " + String(err));
    }
    setExecutingId(null);
    closeExecuteModal();
  };

  // ---- Toggle active handler ----
  const handleToggleActive = async (skill: AgentSkillInfo) => {
    try {
      await api.updateAgentSkill(skill.id, { isActive: !skill.isActive });
      success(`技能"${skill.name}"已${skill.isActive ? "禁用" : "启用"}`);
      await loadSkills();
    } catch {
      toastError("操作失败");
    }
  };

  // ---- Create handler ----
  const handleCreate = async (data: {
    name: string;
    description: string;
    prompt: string;
    tools: string[];
  }) => {
    setCreating(true);
    try {
      await api.createAgentSkill({
        name: data.name,
        description: data.description,
        prompt: data.prompt,
        tools: data.tools,
      });
      success(`技能"${data.name}"创建成功`);
      setCreateModalOpen(false);
      await loadSkills();
    } catch (err) {
      toastError("创建失败: " + String(err));
    } finally {
      setCreating(false);
    }
  };

  // ---- Publish to Hub handler ----
  const handlePublishToHub = async (skill: AgentSkillInfo) => {
    const ok = await confirm({
      title: "发布到 Hub 市场",
      message: `确定要将技能"${skill.name}"发布到 Hub 市场吗？提交后需等待管理员审核。`,
      variant: "default",
    });
    if (!ok) return;
    setPublishingId(skill.id);
    try {
      await api.publishSkillToMarket(skill.id);
      success(`技能"${skill.name}"已提交，等待 Hub 审核`);
    } catch (err) {
      toastError("发布失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setPublishingId(null);
    }
  };

  // ===========================================================================
  // Loading state
  // ===========================================================================
  if (loading) {
    return (
      <div style={styles.centerContainer}>
        <Spinner size="lg" />
      </div>
    );
  }

  // ===========================================================================
  // Main render
  // ===========================================================================
  return (
    <>
      <div style={styles.wrapper}>
        {/* Execution result banner */}
        {executingResult && (
          <div style={styles.resultBanner}>
            <p style={styles.resultTitle}>
              <CheckCircle size={16} />
              {executingResult.skillName} 执行成功
            </p>
            <pre style={styles.resultOutput}>{executingResult.output}</pre>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExecutingResult(null)}
            >
              关闭
            </Button>
          </div>
        )}

        {/* Toolbar */}
        <div style={styles.toolbar}>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setCreateModalOpen(true)}
          >
            创建技能
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Upload size={14} />}
            onClick={() => setImportModalOpen(true)}
          >
            导入技能
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={loadSkills}
          >
            刷新
          </Button>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative", minWidth: 200 }}>
            <Search
              size={14}
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-tertiary)",
                pointerEvents: "none",
              }}
            />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索技能..."
              style={{
                width: "100%",
                paddingLeft: 32,
                paddingRight: 10,
                paddingTop: 6,
                paddingBottom: 6,
                fontSize: "var(--text-sm)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                outline: "none",
              }}
            />
          </div>
        </div>

        {/* Error display */}
        {loadError && (
          <div style={styles.errorBanner}>
            <AlertCircle size={18} style={{ flexShrink: 0 }} />
            <div style={styles.errorText}>
              <strong>加载失败</strong>
              <p style={styles.errorMessage}>{loadError}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={loadSkills}
              style={{ marginLeft: "auto", flexShrink: 0 }}
            >
              重试
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!loadError && skills.length === 0 ? (
          <EmptyState
            icon={<Package size={24} />}
            title="暂无可用技能"
            description="创建一个新技能来开始使用"
            actionLabel="创建技能"
            onAction={() => setCreateModalOpen(true)}
          />
        ) : filteredSkills.length === 0 ? (
          <EmptyState
            icon={<Search size={24} />}
            title="未找到匹配的技能"
            description={`没有名称或描述包含"${searchQuery}"的技能`}
          />
        ) : (
          <div style={styles.grid}>
            {filteredSkills.map((skill) => (
              <div key={skill.id} style={styles.card}>
                {/* Header row */}
                <div style={styles.cardHeader}>
                  <h4 style={styles.cardName}>
                    <Zap size={14} style={{ color: "var(--interactive)", flexShrink: 0 }} />
                    {skill.name}
                  </h4>
                  <div style={styles.cardBadges}>
                    {skill.source === "hub" && (
                      <span title={skill.hubSlug ? `市场 slug: ${skill.hubSlug}` : "来自市场安装"}>
                        <Badge variant="info" size="sm">
                          <Store size={10} style={{ marginRight: 2 }} />
                          市场
                        </Badge>
                      </span>
                    )}
                    {skill.antiHallucinationLevel && (
                      <Badge variant="info" size="sm">
                        <Shield size={10} style={{ marginRight: 2 }} />
                        {skill.antiHallucinationLevel}
                      </Badge>
                    )}
                    {!skill.isActive && (
                      <Badge variant="default" size="sm">
                        已禁用
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Description */}
                <p style={styles.cardDescription}>{skill.description || "无描述"}</p>

                {/* Tool tags */}
                {(skill.tools?.length ?? 0) > 0 && (
                  <div style={styles.toolsRow}>
                    {skill.tools.slice(0, 4).map((t) => (
                      <span key={t} style={styles.toolTag}>
                        <Wrench size={9} />
                        {t}
                      </span>
                    ))}
                    {skill.tools.length > 4 && (
                      <span style={styles.toolMore}>
                        {"+" + (skill.tools.length - 4)}
                      </span>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div style={styles.cardActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={executingId === skill.id ? <Spinner size="sm" color="currentColor" /> : <Play size={14} />}
                    onClick={() => openExecuteModal(skill.id)}
                    disabled={!currentSessionId || !skill.isActive || executingId !== null}
                  >
                    执行
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Power size={14} />}
                    onClick={() => handleToggleActive(skill)}
                    title={skill.isActive ? "禁用" : "启用"}
                    style={{
                      color: skill.isActive ? "var(--text-tertiary)" : "var(--success)",
                    }}
                  >
                    {skill.isActive ? "禁用" : "启用"}
                  </Button>
                  {isWorkerMode && skill.source !== "builtin" && skill.source !== "hub" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={
                        publishingId === skill.id ? (
                          <Spinner size="sm" color="currentColor" />
                        ) : (
                          <Share2 size={14} />
                        )
                      }
                      onClick={() => handlePublishToHub(skill)}
                      disabled={publishingId === skill.id}
                      title="发布到 Hub 市场"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      发布
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={
                      deletingId === skill.id ? (
                        <Spinner size="sm" color="currentColor" />
                      ) : (
                        <Trash2 size={14} />
                      )
                    }
                      onClick={() => handleDelete(skill)}
                      disabled={deletingId === skill.id}
                      style={
                        deletingId === skill.id
                          ? undefined
                          : { color: "var(--text-tertiary)" }
                      }
                    >
                      删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Skill Execution Modal */}
      {executeModalOpen && executeSkillId && (
        <SkillExecuteModal
          skillId={executeSkillId}
          skills={skills}
          sessionId={currentSessionId}
          executing={executingId !== null}
          onExecute={handleExecute}
          onClose={closeExecuteModal}
        />
      )}

      {/* Create Skill Modal */}
      {createModalOpen && (
        <CreateSkillModal
          creating={creating}
          onCreate={handleCreate}
          onClose={() => setCreateModalOpen(false)}
        />
      )}

      {/* Import Skill Modal */}
      {importModalOpen && (
        <ImportSkillModal
          onImported={loadSkills}
          onClose={() => setImportModalOpen(false)}
        />
      )}
    </>
  );
}

// =============================================================================
// SkillExecuteModal - modal for input before execution
// =============================================================================

function SkillExecuteModal({
  skillId,
  skills,
  sessionId,
  executing,
  onExecute,
  onClose,
}: {
  skillId: string;
  skills: AgentSkillInfo[];
  sessionId: string | null;
  executing: boolean;
  onExecute: (input?: string) => Promise<void>;
  onClose: () => void;
}) {
  const skill = skills.find((s) => s.id === skillId);
  const [input, setInput] = useState("");

  if (!skill) return null;

  const handleExecute = async () => {
    await onExecute(input.trim() || undefined);
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={"执行技能: " + skill.name}
      size="md"
    >
      {/* Skill description */}
      <p style={styles.modalDescription}>{skill.description || "无描述"}</p>

      {/* Optional input */}
      <TextArea
        label="输入（可选）"
        value={input}
        onChange={setInput}
        placeholder="可选的任务描述或问题..."
        rows={3}
      />

      {/* Session warning */}
      {!sessionId && (
        <div style={styles.sessionWarning}>
          <AlertCircle size={14} />
          <span>请先创建一个会话以执行技能</span>
        </div>
      )}

      {/* Action buttons */}
      <div style={styles.modalFooter}>
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          onClick={handleExecute}
          loading={executing}
          disabled={!sessionId}
          icon={<Play size={14} />}
        >
          执行
        </Button>
      </div>
    </Modal>
  );
}

// =============================================================================
// CreateSkillModal - modal for creating a new skill
// =============================================================================

function CreateSkillModal({
  creating,
  onCreate,
  onClose,
}: {
  creating: boolean;
  onCreate: (data: {
    name: string;
    description: string;
    prompt: string;
    tools: string[];
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [toolsInput, setToolsInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async () => {
    // Validate
    if (!name.trim()) {
      setFormError("请输入技能名称");
      return;
    }
    if (!prompt.trim()) {
      setFormError("请输入提示词");
      return;
    }

    const tools = toolsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    setFormError(null);
    await onCreate({
      name: name.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      tools,
    });
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="创建新技能"
      size="lg"
    >
      <div style={styles.formContainer}>
        {/* Form error */}
        {formError && (
          <div style={styles.formError}>
            <AlertCircle size={14} />
            {formError}
          </div>
        )}

        {/* Name field */}
        <Input
          label={"技能名称 *"}
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          placeholder="e.g. summarize_document"
          hint="技能的唯一标识符"
        />

        {/* Description field */}
        <Input
          label="描述"
          value={description}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
          placeholder="简要描述该技能的用途"
        />

        {/* Prompt field */}
        <TextArea
          label={"提示词 *"}
          value={prompt}
          onChange={setPrompt}
          placeholder="定义技能的行为和指令..."
          rows={5}
        />

        {/* Tools field */}
        <Input
          label="工具列表"
          value={toolsInput}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToolsInput(e.target.value)}
          placeholder="tool_a, tool_b, tool_c"
          hint="逗号分隔的工具名称列表"
        />

        {/* Action buttons */}
        <div style={styles.modalFooter}>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={creating}
            icon={<Plus size={14} />}
          >
            创建
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================
// Styles
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  centerContainer: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // Toolbar
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },

  // Error banner (matches PluginManager pattern)
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-3) var(--space-4)",
    background: "var(--error-light)",
    border: "1px solid var(--error)",
    borderRadius: "var(--radius-lg)",
    color: "var(--error-dark)",
  },
  errorText: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  errorMessage: {
    fontSize: "var(--text-xs)",
    margin: 0,
    opacity: 0.85,
    wordBreak: "break-word" as const,
  },

  // Execution result banner
  resultBanner: {
    padding: "var(--space-3) var(--space-4)",
    background: "var(--success-light)",
    border: "1px solid var(--success)",
    borderRadius: "var(--radius-lg)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  resultTitle: {
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-medium)" as unknown as number,
    color: "var(--success)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    margin: 0,
  },
  resultOutput: {
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap" as const,
    maxHeight: 160,
    overflowY: "auto" as const,
    margin: 0,
    background: "var(--bg-primary)",
    padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-md)",
  },

  // Grid of skill cards
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "var(--space-4)",
  },

  // Individual card
  card: {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-sm)",
    display: "flex",
    flexDirection: "column",
  },
  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: "var(--space-2)",
  },
  cardName: {
    fontSize: "var(--text-sm)",
    fontWeight: "var(--font-medium)" as unknown as number,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    margin: 0,
  },
  cardBadges: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    flexShrink: 0,
  },
  cardDescription: {
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    marginBottom: "var(--space-3)",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    margin: "0 0 var(--space-3) 0",
    lineHeight: "var(--leading-relaxed)" as unknown as number,
  },

  // Tool tags
  toolsRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "var(--space-1)",
    marginBottom: "var(--space-3)",
  },
  toolTag: {
    fontSize: "10px",
    padding: "2px 6px",
    background: "var(--bg-tertiary)",
    color: "var(--text-tertiary)",
    borderRadius: "var(--radius-sm)",
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
  },
  toolMore: {
    fontSize: "10px",
    color: "var(--text-tertiary)",
  },

  // Card actions
  cardActions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    marginTop: "auto",
  },

  // Modal styles
  modalDescription: {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    margin: "0 0 var(--space-4) 0",
    lineHeight: "var(--leading-relaxed)" as unknown as number,
  },
  sessionWarning: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--warning-light)",
    color: "var(--warning-dark)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    marginBottom: "var(--space-4)",
  },
  modalFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "var(--space-2)",
    marginTop: "var(--space-4)",
  },

  // Create form
  formContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  formError: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--error-light)",
    color: "var(--error-dark)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
  },
};
