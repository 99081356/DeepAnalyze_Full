// =============================================================================
// DeepAnalyze - TaskPanel Component
// Shows all agent tasks and document processing tasks across sessions
// =============================================================================

import { useState, useEffect, useMemo } from "react";
import { api } from "../../api/client";
import type { AgentTaskInfo, DocumentInfo } from "../../types/index";
import { useChatStore } from "../../store/chat";
import { useUIStore } from "../../store/ui";
import { useDocProcessing } from "../../hooks/useDocProcessing";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  ChevronDown,
  FileText,
} from "lucide-react";

export function TaskPanel() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessionTasks = useChatStore((s) => s.agentTasks);
  const cancelAgentTask = useChatStore((s) => s.cancelAgentTask);
  const currentKbId = useUIStore((s) => s.currentKbId);
  const navigateToDoc = useUIStore((s) => s.navigateToDoc);
  const [allTasks, setAllTasks] = useState<AgentTaskInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"all" | "running" | "queue" | "history">("all");

  // Use WebSocket for real-time doc processing updates
  const { processingDocs } = useDocProcessing(currentKbId || null);

  useEffect(() => {
    if (!currentSessionId) return;
    setLoading(true);
    api.getAgentTasks(currentSessionId)
      .then((tasks) => setAllTasks(tasks))
      .catch(() => setAllTasks([]))
      .finally(() => setLoading(false));
  }, [currentSessionId, sessionTasks]);

  const running = allTasks.filter((t) => t.status === "running" || t.status === "pending");
  const done = allTasks.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled");

  // --- Queue tab: use WebSocket processing docs + fallback polling for all KBs ---
  const [pollingDocs, setPollingDocs] = useState<(DocumentInfo & { kbName: string })[]>([]);

  // Load doc names for processing docs (for display)
  const [docNames, setDocNames] = useState<Map<string, { filename: string; kbName: string }>>(new Map());

  useEffect(() => {
    if (activeTab !== "queue" && activeTab !== "all") return;
    api.listKnowledgeBases().then(async (kbs) => {
      const all: (DocumentInfo & { kbName: string })[] = [];
      const nameMap = new Map<string, { filename: string; kbName: string }>();
      for (const kb of kbs) {
        try {
          const docs = await api.listDocuments(kb.id);
          for (const doc of docs) {
            nameMap.set(doc.id, { filename: doc.filename, kbName: kb.name });
            if (doc.status === "parsing" || doc.status === "compiling" || doc.status === "indexing" || doc.status === "linking") {
              all.push({ ...doc, kbName: kb.name });
            }
          }
        } catch {}
      }
      setPollingDocs(all);
      setDocNames(nameMap);
    });
  }, [activeTab]);

  // Merge: WebSocket processingDocs take precedence for active processing
  const queueItems = useMemo(() => {
    const items: Array<{ docId: string; filename: string; kbName: string; step: string; progress: number; error?: string }> = [];

    // Add docs from WebSocket (real-time)
    for (const [docId, state] of processingDocs) {
      const info = docNames.get(docId);
      items.push({
        docId,
        filename: info?.filename ?? docId,
        kbName: info?.kbName ?? currentKbId,
        step: state.step,
        progress: Math.round(state.progress * 100),
        error: state.error,
      });
    }

    // Add docs from polling that aren't already tracked by WebSocket
    const wsIds = new Set(processingDocs.keys());
    for (const doc of pollingDocs) {
      if (!wsIds.has(doc.id)) {
        items.push({
          docId: doc.id,
          filename: doc.filename,
          kbName: doc.kbName,
          step: doc.status,
          progress: 50,
        });
      }
    }

    return items;
  }, [processingDocs, pollingDocs, docNames, currentKbId]);

  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "var(--bg-primary)",
    }}>
      {/* Header */}
      <div style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border-primary)",
        padding: "var(--space-3) var(--space-4)",
        background: "var(--bg-secondary)",
      }}>
        <h3 style={{
          fontSize: "var(--text-sm)",
          fontWeight: "var(--font-medium)",
          color: "var(--text-primary)",
        }}>
          Agent 任务面板
        </h3>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginTop: "var(--space-1)",
          fontSize: "var(--text-xs)",
          color: "var(--text-tertiary)",
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: "var(--radius-full)",
              background: "var(--interactive)",
            }} />
            {running.length} 运行中
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: "var(--radius-full)",
              background: "var(--success)",
            }} />
            {done.filter((t) => t.status === "completed").length} 完成
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: "var(--radius-full)",
              background: "var(--error)",
            }} />
            {done.filter((t) => t.status === "failed").length} 失败
          </span>
        </div>

        {/* Sub-tab bar */}
        <div style={{ display: "flex", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
          {[
            { id: "all", label: "全部", icon: <Clock size={12} /> },
            { id: "running", label: "执行中", icon: <Loader2 size={12} /> },
            { id: "queue", label: "编译队列", icon: <FileText size={12} /> },
            { id: "history", label: "历史", icon: <Clock size={12} /> },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              style={{
                display: "flex", alignItems: "center", gap: "var(--space-1)",
                padding: "4px 10px", border: "none",
                borderRadius: "var(--radius-md)",
                background: activeTab === tab.id ? "var(--interactive-light)" : "transparent",
                color: activeTab === tab.id ? "var(--interactive)" : "var(--text-secondary)",
                fontSize: "var(--text-xs)", fontWeight: activeTab === tab.id ? 500 : 400,
                cursor: "pointer", transition: "all var(--transition-fast)",
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
      }}>
        {/* All Tab — unified view */}
        {activeTab === "all" && (
          <>
            {/* Active doc processing */}
            {queueItems.length > 0 && (
              <div style={{ marginBottom: "var(--space-3)" }}>
                <h4 style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-2)",
                }}>
                  文档处理 ({queueItems.length})
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {queueItems.map((item) => {
                    const stepLabel: Record<string, string> = {
                      parsing: "解析中", compiling: "编译中", indexing: "索引中",
                      linking: "关联中", uploading: "上传中",
                    };
                    return (
                      <div key={item.docId} style={{
                        display: "flex", alignItems: "center", gap: "var(--space-2)",
                        padding: "var(--space-2) var(--space-3)",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "var(--radius-md)",
                        fontSize: "var(--text-sm)",
                      }}>
                        <FileText size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.filename}
                        </span>
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                          {stepLabel[item.step] ?? item.step} {item.progress}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Running agent tasks */}
            {running.length > 0 && (
              <div style={{ marginBottom: "var(--space-3)" }}>
                <h4 style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-2)",
                }}>
                  Agent 任务 ({running.length})
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {running.map((task) => (
                    <div key={task.id} style={{
                      display: "flex", alignItems: "center", gap: "var(--space-2)",
                      padding: "var(--space-2) var(--space-3)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-md)",
                      fontSize: "var(--text-sm)",
                    }}>
                      {task.status === "running"
                        ? <Loader2 size={14} style={{ color: "var(--interactive)", animation: "spin 1s linear infinite" }} />
                        : <Clock size={14} style={{ color: "var(--text-tertiary)" }} />
                      }
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {task.agentType || task.id}
                      </span>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                        {task.status === "running" ? "执行中" : "排队中"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Recent completed tasks */}
            {done.length > 0 && (
              <div>
                <h4 style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-2)",
                }}>
                  最近完成 ({Math.min(done.length, 5)})
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {done.slice(0, 5).map((task) => (
                    <div key={task.id} style={{
                      display: "flex", alignItems: "center", gap: "var(--space-2)",
                      padding: "var(--space-2) var(--space-3)",
                      border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-md)",
                      fontSize: "var(--text-sm)",
                    }}>
                      {task.status === "completed"
                        ? <CheckCircle2 size={14} style={{ color: "var(--success)" }} />
                        : <XCircle size={14} style={{ color: "var(--error)" }} />
                      }
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {task.agentType || task.id}
                      </span>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                        {task.status === "completed" ? "完成" : "失败"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {queueItems.length === 0 && running.length === 0 && done.length === 0 && (
              <div style={{
                textAlign: "center",
                padding: "48px 0",
                color: "var(--text-tertiary)",
              }}>
                <p>暂无任务</p>
              </div>
            )}
          </>
        )}

        {/* Running Tab */}
        {activeTab === "running" && (
          <>
            {loading ? (
              <div style={{
                textAlign: "center",
                padding: "var(--space-8) 0",
                color: "var(--text-tertiary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--space-2)",
              }}>
                <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                加载中...
              </div>
            ) : running.length === 0 ? (
              <div style={{
                textAlign: "center",
                padding: "48px 0",
                color: "var(--text-tertiary)",
              }}>
                <p>暂无运行中的任务</p>
                <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                  在对话中向 Agent 提交分析任务
                </p>
              </div>
            ) : (
              <div>
                <h4 style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-2)",
                }}>
                  运行中
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {running.map((task) => (
                    <TaskCard key={task.id} task={task} onCancel={cancelAgentTask} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Queue Tab */}
        {activeTab === "queue" && (
          <>
            {queueItems.length === 0 ? (
              <div style={{
                textAlign: "center",
                padding: "48px 0",
                color: "var(--text-tertiary)",
              }}>
                <p>暂无编译中的文档</p>
                <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                  上传文档到知识库后将在此显示编译进度
                </p>
              </div>
            ) : (
              <div>
                <h4 style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-2)",
                }}>
                  处理队列 ({queueItems.length})
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {queueItems.map((item) => {
                    const stepLabel: Record<string, string> = {
                      parsing: "解析中",
                      compiling: "编译中",
                      indexing: "索引中",
                      linking: "关联中",
                      uploading: "上传中",
                    };
                    const stepColor: Record<string, string> = {
                      parsing: "var(--warning, #d97706)",
                      uploading: "var(--warning, #d97706)",
                    };
                    const label = stepLabel[item.step] ?? item.step;
                    const color = stepColor[item.step] ?? "var(--interactive)";
                    const bgColor = stepColor[item.step] ? "var(--warning-light, #fef3c7)" : "var(--interactive-light)";
                    return (
                      <div
                        key={item.docId}
                        onClick={() => navigateToDoc(currentKbId, item.docId)}
                        style={{
                          border: "1px solid var(--border-primary)",
                          borderRadius: "var(--radius-lg)",
                          padding: "var(--space-3) var(--space-4)",
                          background: "var(--bg-secondary)",
                          cursor: "pointer",
                          transition: "border-color var(--transition-fast)",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--interactive-light)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
                      >
                        <div style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "var(--space-2)",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flex: 1, minWidth: 0 }}>
                            <FileText size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                            <span style={{
                              fontSize: "var(--text-sm)",
                              fontWeight: "var(--font-medium)",
                              color: "var(--text-primary)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}>
                              {item.filename}
                            </span>
                          </div>
                          <span style={{
                            fontSize: "var(--text-xs)",
                            padding: "2px 8px",
                            borderRadius: "var(--radius-sm)",
                            background: bgColor,
                            color: color,
                            fontWeight: 500,
                            flexShrink: 0,
                            marginLeft: "var(--space-2)",
                          }}>
                            {label}
                          </span>
                        </div>
                        <div style={{
                          fontSize: "var(--text-xs)",
                          color: "var(--text-tertiary)",
                          marginBottom: "var(--space-2)",
                        }}>
                          知识库: {item.kbName}
                        </div>
                        {/* Progress bar */}
                        <div style={{
                          width: "100%",
                          height: 4,
                          background: "var(--bg-tertiary)",
                          borderRadius: "var(--radius-full)",
                          overflow: "hidden",
                        }}>
                          <div style={{
                            width: `${item.progress}%`,
                            height: "100%",
                            background: color,
                            borderRadius: "var(--radius-full)",
                            transition: "width var(--transition-fast)",
                          }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* History Tab */}
        {activeTab === "history" && (
          <>
            {done.length === 0 ? (
              <div style={{
                textAlign: "center",
                padding: "48px 0",
                color: "var(--text-tertiary)",
              }}>
                <p>暂无历史任务</p>
                <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                  完成的任务将在此显示
                </p>
              </div>
            ) : (
              <div>
                <h4 style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--font-medium)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-2)",
                }}>
                  已完成 ({done.length})
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {done.map((task) => (
                    <TaskCard key={task.id} task={task} onCancel={cancelAgentTask} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task, onCancel }: { task: AgentTaskInfo; onCancel: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  const statusConfig: Record<string, { color: string; label: string; Icon: typeof Loader2 }> = {
    pending: { color: "var(--text-tertiary)", label: "等待", Icon: Clock },
    running: { color: "var(--warning)", label: "运行中", Icon: Loader2 },
    completed: { color: "var(--success)", label: "完成", Icon: CheckCircle2 },
    failed: { color: "var(--error)", label: "失败", Icon: XCircle },
    cancelled: { color: "var(--text-tertiary)", label: "已取消", Icon: Ban },
  };

  const config = statusConfig[task.status] ?? statusConfig.pending;
  const { Icon } = config;

  return (
    <div style={{
      border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-3) var(--space-4)",
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          transition: "background var(--transition-fast)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <Icon
          size={14}
          style={{
            color: config.color,
            flexShrink: 0,
            ...(task.status === "running" ? { animation: "spin 1s linear infinite" } : {}),
          }}
        />
        <span style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--font-medium)",
          color: config.color,
          whiteSpace: "nowrap",
        }}>
          {config.label}
        </span>
        <span style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--font-medium)",
          padding: "2px 6px",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-tertiary)",
          color: "var(--text-secondary)",
        }}>
          {task.agentType}
        </span>
        <span style={{
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {task.input.slice(0, 60)}
        </span>
        {task.status === "running" && (
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(task.id); }}
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              transition: "color var(--transition-fast)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            取消
          </button>
        )}
        <ChevronDown
          size={12}
          style={{
            color: "var(--text-tertiary)",
            transition: `transform var(--transition-fast)`,
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            flexShrink: 0,
          }}
        />
      </button>
      {expanded && (
        <div style={{
          borderTop: "1px solid var(--border-primary)",
          padding: "var(--space-3) var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          background: "color-mix(in srgb, var(--bg-primary) 50%, transparent)",
          fontSize: "var(--text-sm)",
        }}>
          {task.input && (
            <div>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>输入:</span>
              <pre style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                marginTop: "var(--space-1)",
                whiteSpace: "pre-wrap",
                margin: 0,
              }}>{task.input}</pre>
            </div>
          )}
          {task.output && (
            <div>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>输出:</span>
              <pre style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                marginTop: "var(--space-1)",
                whiteSpace: "pre-wrap",
                maxHeight: 160,
                overflowY: "auto",
                margin: 0,
              }}>{task.output}</pre>
            </div>
          )}
          {task.error && (
            <div>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--error)" }}>错误:</span>
              <pre style={{
                fontSize: "var(--text-xs)",
                color: "var(--error)",
                marginTop: "var(--space-1)",
                margin: 0,
              }}>{task.error}</pre>
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
            创建: {new Date(task.createdAt).toLocaleString("zh-CN")}
            {task.completedAt && ` | 完成: ${new Date(task.completedAt).toLocaleString("zh-CN")}`}
          </div>
        </div>
      )}
    </div>
  );
}
