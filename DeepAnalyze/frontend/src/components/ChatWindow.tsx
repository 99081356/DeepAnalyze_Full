import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useChatStore } from "../store/chat";
import { useUIStore } from "../store/ui";
import { useWorkflowStore } from "../store/workflow";
import { MessageList } from "./chat/MessageList";
import { MessageInput } from "./chat/MessageInput";
import { ScopeSelector } from "./chat/ScopeSelector";

import { SubAgentPanel } from "./teams/SubAgentPanel";
import {
  selectPanelMode,
  computeAutoCompact,
  type PanelMode,
} from "./teams/panel-mode";
import { useKeyboard } from "../hooks/useKeyboard";
import { api } from "../api/client";
import { Sparkles, Upload, BookOpen, MessageSquare, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import type { AnalysisScope } from "../types/index";
import { AskUserDialog } from "./chat/AskUserDialog";

interface KbEntry {
  id: string;
  name: string;
  documents: Array<{ id: string; filename: string; status: string }>;
}

export function ChatWindow() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const createSession = useChatStore((s) => s.createSession);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const currentKbId = useUIStore((s) => s.currentKbId);

  // Sync URL sessionId to store on mount or URL change
  useEffect(() => {
    if (urlSessionId && urlSessionId !== currentSessionId) {
      selectSession(urlSessionId);
    } else if (!urlSessionId && currentSessionId) {
      // URL is /chat but store has a session selected — fix the URL to match.
      // This prevents the URL and store state from being out of sync.
      window.location.hash = '#/sessions/' + currentSessionId;
    }
  }, [urlSessionId, currentSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Workflow state — show SubAgentPanel only for workflows belonging to the current session
  const activeWorkflows = useWorkflowStore((s) => s.activeWorkflows);
  const forceCompactAll = useWorkflowStore((s) => s.forceCompactAll);
  const setForceCompactAll = useWorkflowStore((s) => s.setForceCompactAll);
  const userOverride = useWorkflowStore((s) => s.userOverride);

  const sessionWorkflowIds = useMemo(() => {
    if (!activeWorkflows || !currentSessionId) return [];
    const ids: string[] = [];
    activeWorkflows.forEach((wf, wfId) => {
      // Include workflows with matching sessionId, or legacy workflows without sessionId
      if (!wf.sessionId || wf.sessionId === currentSessionId) {
        ids.push(wfId);
      }
    });
    return ids;
  }, [activeWorkflows, currentSessionId]);

  // ---- Compaction UI state (see docs/superpowers/specs/2026-06-27-subagent-panel-compaction-design.md) ----

  // Track viewport height so the auto-compact heuristic can recompute on resize.
  const [viewportHeight, setViewportHeight] = useState(
    typeof window !== "undefined" ? window.innerHeight : 800,
  );
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Build a compact workflow-info list for the selector functions.
  const sessionWorkflowInfos = useMemo(() => {
    return sessionWorkflowIds.map((id) => {
      const wf = activeWorkflows.get(id);
      return {
        workflowId: id,
        agents: wf
          ? Array.from(wf.agents.values()).map((a) => ({ status: a.status }))
          : [],
      };
    });
  }, [sessionWorkflowIds, activeWorkflows]);

  // Auto-compaction heuristic — true when stack height estimate exceeds 40vh.
  const autoCompact = useMemo(
    () => computeAutoCompact(sessionWorkflowInfos, viewportHeight),
    [sessionWorkflowInfos, viewportHeight],
  );

  const panelModeContext = useMemo<{
    forceCompactAll: boolean;
    userOverride: Map<string, PanelMode>;
    autoCompact: boolean;
  }>(
    () => ({ forceCompactAll, userOverride, autoCompact }),
    [forceCompactAll, userOverride, autoCompact],
  );

  // Per-workflow mode map (id → mode), computed once per render.
  const panelModesByKey = useMemo(() => {
    const map = new Map<string, PanelMode>();
    for (const info of sessionWorkflowInfos) {
      map.set(info.workflowId, selectPanelMode(info, panelModeContext));
    }
    return map;
  }, [sessionWorkflowInfos, panelModeContext]);

  // Header summary counters
  const headerSummary = useMemo(() => {
    let running = 0;
    let completed = 0;
    for (const info of sessionWorkflowInfos) {
      const anyRunning = info.agents.some(
        (a) => a.status === "running" || a.status === "waiting" || a.status === "queued",
      );
      if (anyRunning) running++;
      else completed++;
    }
    return { total: sessionWorkflowInfos.length, running, completed };
  }, [sessionWorkflowInfos]);

  const [scope, setScope] = useState<AnalysisScope>({ knowledgeBases: [], webSearch: true });
  const [kbList, setKbList] = useState<KbEntry[]>([]);
  const scopeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load knowledge bases with their documents
  useEffect(() => {
    let cancelled = false;
    const loadKbs = async () => {
      try {
        const kbs = await api.listKnowledgeBases();
        if (cancelled) return;
        // Load documents for each KB
        const entries: KbEntry[] = await Promise.all(
          kbs.map(async (kb) => {
            try {
              const docs = await api.listDocuments(kb.id);
              return {
                id: kb.id,
                name: kb.name,
                documents: docs.map((d) => ({ id: d.id, filename: d.filename, status: d.status })),
              };
            } catch {
              return { id: kb.id, name: kb.name, documents: [] };
            }
          }),
        );
        if (!cancelled) setKbList(entries);
      } catch {
        // Non-critical
      }
    };
    loadKbs();
    return () => { cancelled = true; };
  }, []);

  useKeyboard({ key: "n", ctrl: true }, () => {
    createSession();
  });

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  // Parse persisted scope from current session
  const parsedScope = useMemo<AnalysisScope | undefined>(() => {
    if (!currentSession?.kbScope) return undefined;
    try {
      return typeof currentSession.kbScope === "string"
        ? JSON.parse(currentSession.kbScope)
        : currentSession.kbScope;
    } catch { return undefined; }
  }, [currentSession?.kbScope]);

  const handleScopeChange = useCallback((newScope: AnalysisScope) => {
    setScope(newScope);
    // Debounce persist scope to backend
    if (scopeTimerRef.current) clearTimeout(scopeTimerRef.current);
    if (currentSessionId && newScope.knowledgeBases?.length > 0) {
      scopeTimerRef.current = setTimeout(() => {
        api.updateSessionScope(currentSessionId, newScope as unknown as Record<string, unknown>).catch(() => {});
      }, 500);
    }
  }, [currentSessionId]);

  // Welcome screen when no session active
  // Note: only check currentSessionId, not currentSession — during loading,
  // currentSessionId is set but currentSession may be undefined until fetch completes
  if (!currentSessionId) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-primary)",
          padding: "var(--space-8)",
        }}
      >
        <div
          style={{
            textAlign: "center",
            maxWidth: 520,
            animation: "fadeIn 0.4s ease-out",
          }}
        >
          {/* Logo */}
          <div
            style={{
              width: 64,
              height: 64,
              margin: "0 auto var(--space-6)",
              borderRadius: "var(--radius-xl)",
              background: "linear-gradient(135deg, #3b82f6, #06b6d4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 8px 24px rgba(59, 130, 246, 0.25)",
            }}
          >
            <Sparkles size={28} color="#fff" />
          </div>

          <h2
            style={{
              fontSize: "var(--text-3xl)",
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: "0 0 var(--space-2)",
            }}
          >
            DeepAnalyze
          </h2>
          <p
            style={{
              fontSize: "var(--text-base)",
              color: "var(--text-secondary)",
              margin: "0 0 var(--space-8)",
              lineHeight: "var(--leading-relaxed)",
            }}
          >
            深度分析系统 — Agent驱动的文档分析与报告生成平台
          </p>

          {/* Action buttons */}
          <div
            style={{
              display: "flex",
              gap: "var(--space-3)",
              justifyContent: "center",
              marginBottom: "var(--space-8)",
            }}
          >
            <WelcomeAction
              icon={<Upload size={18} />}
              label="上传文档"
              onClick={() => { window.location.hash = "#/knowledge/" + (currentKbId || ""); }}
            />
            <WelcomeAction
              icon={<BookOpen size={18} />}
              label="选择知识库"
              onClick={() => { window.location.hash = "#/knowledge/" + (currentKbId || ""); }}
            />
            <WelcomeAction
              icon={<MessageSquare size={18} />}
              label="开始对话"
              onClick={() => createSession()}
              primary
            />
          </div>

          {/* Quick hints */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-2)",
              justifyContent: "center",
              marginBottom: "var(--space-6)",
            }}
          >
            {["分析一份文档的关键条款", "提取文档中的时间线", "对比分析多份文档的差异"].map(
              (hint) => (
                <button
                  key={hint}
                  onClick={async () => {
                    const sessionId = await createSession();
                    if (sessionId) {
                      sendMessage(hint);
                    }
                  }}
                  style={{
                    padding: "var(--space-1) var(--space-3)",
                    background: "var(--surface-primary)",
                    border: "1px solid var(--border-primary)",
                    borderRadius: "var(--radius-full)",
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    transition: "all var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--interactive)";
                    e.currentTarget.style.color = "var(--interactive)";
                    e.currentTarget.style.background = "var(--interactive-light)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-primary)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                    e.currentTarget.style.background = "var(--surface-primary)";
                  }}
                >
                  {hint}
                </button>
              ),
            )}
          </div>

          {/* Scope selector on welcome screen */}
          {kbList.length > 0 && (
            <div style={{ maxWidth: 480, margin: "0 auto" }}>
              <p style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
                marginBottom: "var(--space-2)",
                textTransform: "uppercase" as const,
                letterSpacing: "0.05em",
              }}>
                分析范围
              </p>
              <ScopeSelector kbList={kbList} currentKbId={currentKbId} initialScope={parsedScope} onScopeChange={handleScopeChange} disabled={false} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Active chat session
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-primary)",
        position: "relative",
      }}
    >
      {/* Chat header bar */}
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 var(--space-4)",
          borderBottom: "1px solid var(--border-primary)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {currentSession?.title || "新对话"}
        </span>
        <ScopeSelector kbList={kbList} currentKbId={currentKbId} initialScope={parsedScope} onScopeChange={handleScopeChange} disabled={false} />
      </div>

      {/* Agent ask_user dialog */}
      <AskUserDialog />

      {/* Messages */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <MessageList />
      </div>

      {/* Active workflow sub-agent panels (filtered to current session only) */}
      {/* Wrapper caps stack at 50vh with internal scroll as a safety net; the */}
      {/* auto-compaction heuristic above prefers shrinking non-running panels  */}
      {/* before scroll ever kicks in. */}
      {sessionWorkflowIds.length > 0 && (
        <div
          data-testid="subagent-stack"
          style={{
            flexShrink: 0,
            maxHeight: "50vh",
            overflowY: "auto",
            borderBottom: "1px solid var(--border-primary)",
            background: "var(--bg-secondary)",
            transition: "max-height 0.2s ease",
          }}
        >
          {/* Stack header: summary + collapse-all toggle */}
          <div
            data-testid="subagent-stack-header"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--space-1) var(--space-3)",
              borderBottom: "1px solid var(--border-primary)",
              background: "var(--bg-tertiary)",
              position: "sticky",
              top: 0,
              zIndex: 1,
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {headerSummary.running > 0 && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "var(--radius-full)",
                      background: "var(--success)",
                      animation: "pulse 1.5s ease-in-out infinite",
                    }}
                  />
                )}
                {headerSummary.total} 个工作流
              </span>
              <span style={{ color: "var(--text-tertiary)" }}>·</span>
              <span>{headerSummary.running} 运行中</span>
              {headerSummary.completed > 0 && (
                <>
                  <span style={{ color: "var(--text-tertiary)" }}>·</span>
                  <span>{headerSummary.completed} 已完成</span>
                </>
              )}
            </span>

            <button
              type="button"
              data-testid="subagent-collapse-all"
              onClick={() => setForceCompactAll(!forceCompactAll)}
              title={forceCompactAll ? "展开全部" : "收起全部"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
                border: "1px solid var(--border-primary)",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              {forceCompactAll ? (
                <ChevronsUpDown size={12} />
              ) : (
                <ChevronsDownUp size={12} />
              )}
              {forceCompactAll ? "展开全部" : "收起全部"}
            </button>
          </div>

          {/* Panel list */}
          {sessionWorkflowIds.map((wfId) => (
            <SubAgentPanel
              key={wfId}
              workflowId={wfId}
              panelMode={panelModesByKey.get(wfId) ?? "expanded"}
            />
          ))}
        </div>
      )}

      {/* Input */}
      <MessageInput scope={scope} />
    </div>
  );
}

function WelcomeAction({
  icon,
  label,
  onClick,
  primary = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-4)",
        border: primary ? "none" : "1px solid var(--border-primary)",
        borderRadius: "var(--radius-xl)",
        background: primary ? "var(--brand-primary)" : "var(--surface-primary)",
        color: primary ? "var(--brand-foreground)" : "var(--text-secondary)",
        fontSize: "var(--text-sm)",
        fontWeight: 500,
        cursor: "pointer",
        transition: "all var(--transition-fast)",
        boxShadow: primary ? "var(--shadow-md)" : "none",
      }}
      onMouseEnter={(e) => {
        if (primary) {
          e.currentTarget.style.background = "var(--brand-hover)";
          e.currentTarget.style.boxShadow = "var(--shadow-lg)";
        } else {
          e.currentTarget.style.borderColor = "var(--interactive)";
          e.currentTarget.style.color = "var(--interactive)";
        }
      }}
      onMouseLeave={(e) => {
        if (primary) {
          e.currentTarget.style.background = "var(--brand-primary)";
          e.currentTarget.style.boxShadow = "var(--shadow-md)";
        } else {
          e.currentTarget.style.borderColor = "var(--border-primary)";
          e.currentTarget.style.color = "var(--text-secondary)";
        }
      }}
    >
      {icon}
      {label}
    </button>
  );
}
