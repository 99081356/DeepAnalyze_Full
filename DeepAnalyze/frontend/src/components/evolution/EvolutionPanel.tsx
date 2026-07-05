// =============================================================================
// DeepAnalyze - EvolutionPanel Component
// Self-evolution configuration panel with toggles, memory list, and stats
// =============================================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { Spinner } from "../ui/Spinner";
import {
  Brain,
  Trash2,
  RefreshCw,
  BarChart3,
  Database,
  Cpu,
  Search,
  Wrench,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvolutionConfig {
  enabled: boolean;
  modules: {
    persistentMemory: boolean;
    memoryAccumulation: boolean;
    skillEvolution: boolean;
    skillMaintenance: boolean;
    historyRecall: boolean;
    autoDream: boolean;
  };
  params: {
    nudgeInterval: number;
    curatorIntervalDays: number;
    archiveAfterDays: number;
    staleAfterDays: number;
  };
}

interface MemoryEntry {
  id: string;
  category: string;
  content: string;
  source: string;
  relevance: number;
  use_count: number;
  created_at: string;
}

interface EvolutionStats {
  memoryCount: number;
  skillStats: {
    active: number;
    stale: number;
    archived: number;
    agentCreated: number;
  };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const sectionStyle: React.CSSProperties = {
  padding: "var(--space-4)",
  borderBottom: "1px solid var(--border-primary)",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text-primary)",
  marginBottom: "var(--space-3)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "var(--space-2) 0",
};

const labelStyle: React.CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--text-secondary)",
};

const descStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--text-tertiary)",
  marginTop: 2,
};

const statGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "var(--space-3)",
};

const statCardStyle: React.CSSProperties = {
  padding: "var(--space-3)",
  borderRadius: "var(--radius-lg)",
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-primary)",
};

const statValueStyle: React.CSSProperties = {
  fontSize: "var(--text-xl)",
  fontWeight: 700,
  color: "var(--text-primary)",
};

const statLabelStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--text-tertiary)",
  marginTop: 2,
};

const memoryItemStyle: React.CSSProperties = {
  padding: "var(--space-3)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-primary)",
  marginBottom: "var(--space-2)",
};

const btnStyle: React.CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-primary)",
  background: "var(--bg-tertiary)",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: "var(--text-xs)",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const dangerBtnStyle: React.CSSProperties = {
  ...btnStyle,
  borderColor: "var(--error)",
  color: "var(--error)",
};

// ---------------------------------------------------------------------------
// EvolutionPanel
// ---------------------------------------------------------------------------

export function EvolutionPanel() {
  const toastFns = useToast();
  const toastRef = useRef(toastFns);
  toastRef.current = toastFns;

  // Config state
  const [config, setConfig] = useState<EvolutionConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);

  // Memory state
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [memoriesExpanded, setMemoriesExpanded] = useState(false);

  // Stats state
  const [stats, setStats] = useState<EvolutionStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Load config
  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const cfg = await api.getEvolutionConfig();
      setConfig(cfg);
    } catch {
      toastRef.current.error("加载自进化配置失败");
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // Load memories
  const loadMemories = useCallback(async () => {
    setMemoriesLoading(true);
    try {
      const res = await api.getEvolutionMemories();
      setMemories(res.memories || []);
    } catch {
      // silent - memories may not exist yet
    } finally {
      setMemoriesLoading(false);
    }
  }, []);

  // Load stats
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const s = await api.getEvolutionStats();
      setStats(s);
    } catch {
      // silent
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadStats();
  }, [loadConfig, loadStats]);

  // Save config
  const saveConfig = useCallback(
    async (updates: Partial<EvolutionConfig>) => {
      if (!config) return;
      setConfigSaving(true);
      try {
        await api.saveEvolutionConfig(updates);
        setConfig((prev) => (prev ? { ...prev, ...updates, modules: { ...prev.modules, ...(updates.modules || {}) }, params: { ...prev.params, ...(updates.params || {}) } } : prev));
        toastRef.current.success("配置已保存");
      } catch {
        toastRef.current.error("保存配置失败");
      } finally {
        setConfigSaving(false);
      }
    },
    [config],
  );

  // Delete single memory
  const handleDeleteMemory = useCallback(
    async (id: string) => {
      try {
        await api.deleteEvolutionMemory(id);
        setMemories((prev) => prev.filter((m) => m.id !== id));
        toastRef.current.success("记忆已删除");
        loadStats();
      } catch {
        toastRef.current.error("删除记忆失败");
      }
    },
    [loadStats],
  );

  // Clear all memories
  const handleClearMemories = useCallback(async () => {
    try {
      await api.clearEvolutionMemories();
      setMemories([]);
      toastRef.current.success("所有记忆已清除");
      loadStats();
    } catch {
      toastRef.current.error("清除记忆失败");
    }
  }, [loadStats]);

  if (configLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200 }}>
        <Spinner size="md" />
      </div>
    );
  }

  if (!config) {
    return (
      <div style={{ padding: "var(--space-4)", textAlign: "center", color: "var(--text-tertiary)" }}>
        无法加载自进化配置
      </div>
    );
  }

  // Category label mapping
  const categoryLabel: Record<string, string> = {
    tool_technique: "工具技巧",
    workflow: "工作流程",
    convention: "约定规范",
    lesson_learned: "经验教训",
  };

  return (
    <div style={{ fontSize: "var(--text-sm)" }}>
      {/* Master Toggle */}
      <div style={sectionStyle}>
        <div style={rowStyle}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-base)", fontWeight: 600, color: "var(--text-primary)" }}>
              <Brain size={18} style={{ color: "var(--interactive)" }} />
              自进化系统
            </div>
            <div style={descStyle}>
              启用后，Agent 将根据使用经验自动学习和改进
            </div>
          </div>
          <ToggleSwitch
            checked={config.enabled}
            onChange={(checked) => saveConfig({ enabled: checked })}
            aria-label="启用自进化"
          />
        </div>
        {configSaving && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 4 }}>
            保存中...
          </div>
        )}
      </div>

      {/* Module Toggles */}
      <div style={{ ...sectionStyle, opacity: config.enabled ? 1 : 0.5, pointerEvents: config.enabled ? "auto" : "none" }}>
        <div style={sectionTitleStyle}>
          <Cpu size={14} />
          功能模块
        </div>

        {/* --- Memory & Knowledge Group --- */}
        <div style={{ ...labelStyle, fontWeight: 600, marginBottom: 4, marginTop: "var(--space-1)" }}>
          记忆与知识
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>持久记忆</div>
            <div style={descStyle}>将积累的经验笔记注入 Agent 系统提示中</div>
          </div>
          <ToggleSwitch
            size="sm"
            checked={config.modules.persistentMemory}
            onChange={(checked) => saveConfig({ modules: { ...config.modules, persistentMemory: checked } })}
            aria-label="持久记忆"
          />
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>跨会话整合</div>
            <div style={descStyle}>定期整合多个会话的知识到知识库</div>
          </div>
          <ToggleSwitch
            size="sm"
            checked={config.modules.autoDream}
            onChange={(checked) => saveConfig({ modules: { ...config.modules, autoDream: checked } })}
            aria-label="跨会话整合"
          />
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>历史回顾</div>
            <div style={descStyle}>搜索历史对话辅助当前任务</div>
          </div>
          <ToggleSwitch
            size="sm"
            checked={config.modules.historyRecall}
            onChange={(checked) => saveConfig({ modules: { ...config.modules, historyRecall: checked } })}
            aria-label="历史回顾"
          />
        </div>

        {/* --- Skill & Learning Group --- */}
        <div style={{ ...labelStyle, fontWeight: 600, marginBottom: 4, marginTop: "var(--space-3)" }}>
          技能与学习
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>经验积累</div>
            <div style={descStyle}>后台审查对话，提取工具技巧和工作流经验</div>
          </div>
          <ToggleSwitch
            size="sm"
            checked={config.modules.memoryAccumulation}
            onChange={(checked) => saveConfig({ modules: { ...config.modules, memoryAccumulation: checked } })}
            aria-label="经验积累"
          />
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>技能进化</div>
            <div style={descStyle}>后台审查对话，自动创建、更新和优化技能</div>
          </div>
          <ToggleSwitch
            size="sm"
            checked={config.modules.skillEvolution}
            onChange={(checked) => saveConfig({ modules: { ...config.modules, skillEvolution: checked } })}
            aria-label="技能进化"
          />
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>技能维护</div>
            <div style={descStyle}>定期归档过期技能、合并相似技能</div>
          </div>
          <ToggleSwitch
            size="sm"
            checked={config.modules.skillMaintenance}
            onChange={(checked) => saveConfig({ modules: { ...config.modules, skillMaintenance: checked } })}
            aria-label="技能维护"
          />
        </div>
      </div>

      {/* Parameters */}
      <div style={{ ...sectionStyle, opacity: config.enabled ? 1 : 0.5, pointerEvents: config.enabled ? "auto" : "none" }}>
        <div style={sectionTitleStyle}>
          <Wrench size={14} />
          参数设置
        </div>

        {[
          { key: "nudgeInterval" as const, label: "回顾间隔（轮次）", min: 3, max: 50, desc: "每隔多少轮对话触发一次后台回顾" },
          { key: "staleAfterDays" as const, label: "过期阈值（天）", min: 7, max: 365, desc: "超过此天数未使用的技能将被标记为过期" },
          { key: "archiveAfterDays" as const, label: "归档阈值（天）", min: 30, max: 730, desc: "超过此天数的过期技能将被自动归档" },
          { key: "curatorIntervalDays" as const, label: "管家间隔（天）", min: 1, max: 30, desc: "每隔多少天运行一次技能管家" },
        ].map((param) => (
          <div key={param.key} style={rowStyle}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>{param.label}</div>
              <div style={descStyle}>{param.desc}</div>
            </div>
            <input
              type="number"
              min={param.min}
              max={param.max}
              value={config.params[param.key]}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= param.min && val <= param.max) {
                  setConfig((prev) =>
                    prev ? { ...prev, params: { ...prev.params, [param.key]: val } } : prev,
                  );
                }
              }}
              onBlur={() => saveConfig({ params: config.params })}
              style={{
                width: 80,
                padding: "4px 8px",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
                background: "var(--bg-primary)",
                color: "var(--text-primary)",
                textAlign: "right",
              }}
            />
          </div>
        ))}
      </div>

      {/* Stats */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <BarChart3 size={14} />
          统计概览
          <button
            onClick={loadStats}
            style={{ ...btnStyle, marginLeft: "auto" }}
            title="刷新"
          >
            <RefreshCw size={12} />
          </button>
        </div>
        {statsLoading ? (
          <div style={{ textAlign: "center", padding: "var(--space-3)" }}>
            <Spinner size="sm" />
          </div>
        ) : stats ? (
          <div style={statGridStyle}>
            <div style={statCardStyle}>
              <div style={statValueStyle}>{stats.memoryCount}</div>
              <div style={statLabelStyle}>记忆条目</div>
            </div>
            <div style={statCardStyle}>
              <div style={statValueStyle}>{stats.skillStats?.active ?? 0}</div>
              <div style={statLabelStyle}>活跃技能</div>
            </div>
            <div style={statCardStyle}>
              <div style={statValueStyle}>{stats.skillStats?.agentCreated ?? 0}</div>
              <div style={statLabelStyle}>Agent 创建技能</div>
            </div>
            <div style={statCardStyle}>
              <div style={statValueStyle}>{stats.skillStats?.stale ?? 0}</div>
              <div style={{ ...statLabelStyle, display: "flex", alignItems: "center", gap: 4 }}>
                {(stats.skillStats?.stale ?? 0) > 0 && <AlertTriangle size={10} style={{ color: "var(--warning)" }} />}
                过期技能
              </div>
            </div>
            <div style={statCardStyle}>
              <div style={statValueStyle}>{stats.skillStats?.archived ?? 0}</div>
              <div style={statLabelStyle}>已归档技能</div>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
            暂无统计数据
          </div>
        )}
      </div>

      {/* Memory List */}
      <div style={sectionStyle}>
        <div style={{ ...sectionTitleStyle, cursor: "pointer" }} onClick={() => {
          if (!memoriesExpanded) {
            loadMemories();
          }
          setMemoriesExpanded(!memoriesExpanded);
        }}>
          <Database size={14} />
          记忆列表 ({memories.length})
          {memoriesExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {memoriesExpanded && memories.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); handleClearMemories(); }}
              style={{ ...dangerBtnStyle, marginLeft: "auto" }}
            >
              <Trash2 size={10} />
              清空全部
            </button>
          )}
        </div>
        {memoriesExpanded && (
          <>
            {memoriesLoading ? (
              <div style={{ textAlign: "center", padding: "var(--space-3)" }}>
                <Spinner size="sm" />
              </div>
            ) : memories.length === 0 ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)", padding: "var(--space-2)" }}>
                暂无记忆条目。启用持久记忆后，Agent 在工作中积累的经验会自动记录。
              </div>
            ) : (
              memories.map((m) => (
                <div key={m.id} style={memoryItemStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{
                      fontSize: "var(--text-xs)",
                      padding: "1px 6px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-tertiary)",
                      color: "var(--text-tertiary)",
                    }}>
                      {categoryLabel[m.category] || m.category}
                    </span>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                        使用 {m.use_count} 次
                      </span>
                      <button
                        onClick={() => handleDeleteMemory(m.id)}
                        style={{ ...btnStyle, padding: "2px 4px", border: "none", background: "transparent", color: "var(--text-tertiary)" }}
                        title="删除"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", lineHeight: 1.5, wordBreak: "break-word" }}>
                    {(m.content?.length ?? 0) > 200 ? m.content.slice(0, 200) + "..." : (m.content ?? "")}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>
                    {new Date(m.created_at).toLocaleString("zh-CN")}
                    {m.source === "review" && " · 后台回顾"}
                    {m.source === "foreground" && " · 前台记录"}
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>

      {/* Footer Note */}
      <div style={{ padding: "var(--space-4)", textAlign: "center" }}>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
          关闭自进化后，所有功能将停止工作，Agent 恢复标准模式
        </div>
      </div>
    </div>
  );
}
