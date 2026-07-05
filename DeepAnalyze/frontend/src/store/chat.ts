// =============================================================================
// DeepAnalyze - Chat Store
// Manages sessions, messages, streaming, and agent tasks
// =============================================================================

import { create } from "zustand";
import { api } from "../api/client.js";
import type { SessionInfo, MessageInfo, AgentTaskInfo, ToolCallInfo } from "../types/index.js";
import { useWorkflowStore } from "./workflow.js";
import { wsSubscribeWorkflow, wsUnsubscribeWorkflow } from "../hooks/useWebSocket.js";

// ---------------------------------------------------------------------------
// Map API messages to MessageInfo, enriching toolCalls from metadata
// ---------------------------------------------------------------------------

function mapMessages(msgs: any[]): MessageInfo[] {
  return msgs.map((msg) => {
    const result: MessageInfo = {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      createdAt: msg.created_at ?? msg.createdAt ?? "",
    };
    // Map tool calls from persisted metadata (backend enriches these)
    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      result.toolCalls = msg.toolCalls.map((tc: any) => ({
        id: tc.id,
        toolName: tc.toolName,
        input: tc.inputSummary ? { _summary: tc.inputSummary } : {},
        output: tc.outputSummary,
        status: tc.status === "running" ? "completed" : (tc.status || "completed"),
      }));
    }
    // Map report
    if (msg.report) {
      result.report = msg.report;
    }
    // Map pushed contents from persisted metadata
    if (msg.pushedContents && Array.isArray(msg.pushedContents)) {
      result.pushedContents = msg.pushedContents.map((pc: any) => ({
        type: pc.type,
        title: pc.title,
        data: pc.data || "",
        format: pc.format,
        timestamp: pc.timestamp,
        fileName: pc.fileName,
        fileSize: pc.fileSize,
        mimeType: pc.mimeType,
        downloadUrl: pc.downloadUrl,
      }));
    }
    // Map media attachments (backend enriches user messages with these)
    if (msg.media && Array.isArray(msg.media)) {
      result.media = msg.media.map((m: any) => ({
        mediaId: m.mediaId,
        fileName: m.fileName,
        mimeType: m.mimeType,
        size: m.size,
      }));
    }
    // Map thinking content from persisted metadata
    if (msg.thinkingContent && typeof msg.thinkingContent === "string") {
      result.thinkingContent = msg.thinkingContent;
    }
    // Map raw metadata (includes taskId for matching streaming messages)
    if (msg.metadata) {
      try {
        result.metadata = typeof msg.metadata === "string"
          ? JSON.parse(msg.metadata)
          : msg.metadata;
      } catch {
        /* keep metadata undefined if parse fails */
      }
    }
    return result;
  });
}

interface ChatState {
  // Data
  sessions: SessionInfo[];
  currentSessionId: string | null;
  messages: MessageInfo[];
  agentTasks: AgentTaskInfo[];

  // UI state
  isLoading: boolean;
  isSessionLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  error: string | null;

  // Streaming internals
  streamingMessageId: string | null;
  streamingContent: string;
  streamingThinking: string;
  streamingToolCalls: ToolCallInfo[];

  // Agent todo list
  todos: import("../types/index.js").TodoItem[];

  // ask_user state
  pendingQuestion: {
    taskId: string;
    question: string;
    options: string[];
  } | null;

  // Actions
  loadSessions: () => Promise<void>;
  createSession: (title?: string) => Promise<string>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  sendMessage: (content: string, scope?: import("../types/index.js").AnalysisScope, mediaIds?: string[], mediaAttachments?: import("../types/index.js").MediaAttachment[]) => Promise<void>;
  clearError: () => void;

  // Streaming actions (called by WebSocket handlers)
  startStreaming: (messageId: string) => void;
  appendStreamContent: (content: string) => void;
  appendStreamThinking: (content: string) => void;
  addStreamToolCall: (toolCall: ToolCallInfo) => void;
  updateStreamToolResult: (id: string, output: string, status: "completed" | "error") => void;
  finishStreaming: (fullContent: string, toolCalls?: ToolCallInfo[]) => void;
  stopStreaming: () => void;

  // Agent task actions
  loadAgentTasks: (sessionId: string) => Promise<void>;
  addAgentTask: (task: AgentTaskInfo) => void;
  updateAgentTaskProgress: (taskId: string, progress: number) => void;
  completeAgentTask: (taskId: string, output: string) => void;
  failAgentTask: (taskId: string, error: string) => void;
  runAgent: (input: string, agentType?: string) => Promise<void>;
  cancelAgentTask: (taskId: string) => Promise<void>;
  regenerateMessage: (messageId: string) => void;

  // Todo list actions
  updateTodos: (todos: import("../types/index.js").TodoItem[]) => void;
  clearTodos: () => void;

  // ask_user actions
  setPendingQuestion: (q: { taskId: string; question: string; options: string[] } | null) => void;
  answerQuestion: (taskId: string, answer: string) => Promise<void>;

  // Reconnect actions
  reconnectToRunningTask: (taskId: string) => Promise<void>;

  // Inject message into a running agent
  injectMessage: (content: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => {
  let savedSession: string | null = null;
  try { savedSession = localStorage.getItem('deepanalyze-session'); } catch { /* SSR */ }

  // Session-level message cache: keeps messages when switching between sessions
  // or navigating away from the chat view. Keyed by session ID.
  const sessionMessagesCache = new Map<string, MessageInfo[]>();

  // Per-session SSE connection tracking: stores ALL active connections per session
  // (parallel sends are allowed — see sendMessage). Each connection has an abort
  // function and taskId so stopStreaming can cancel every concurrent task.
  type SSEConnection = {
    abort: () => void;
    taskId: string | null;
  };
  const activeSSEConnections = new Map<string, Set<SSEConnection>>();

  function addSSEConnection(sessionId: string, conn: SSEConnection): SSEConnection {
    let conns = activeSSEConnections.get(sessionId);
    if (!conns) {
      conns = new Set();
      activeSSEConnections.set(sessionId, conns);
    }
    conns.add(conn);
    return conn;
  }

  function removeSSEConnection(sessionId: string, conn: SSEConnection) {
    const conns = activeSSEConnections.get(sessionId);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) activeSSEConnections.delete(sessionId);
    }
  }

  function getLatestSSEConnection(sessionId: string): SSEConnection | undefined {
    const conns = activeSSEConnections.get(sessionId);
    if (!conns || conns.size === 0) return undefined;
    const arr = Array.from(conns);
    return arr[arr.length - 1];
  }

  function clearAllSSEConnections(sessionId: string) {
    const conns = activeSSEConnections.get(sessionId);
    if (conns) {
      for (const conn of conns) conn.abort();
      conns.clear();
      activeSSEConnections.delete(sessionId);
    }
  }

  // Per-session streaming state: preserves streaming progress when switching sessions
  // so the user can return to a session that's still streaming and see its state.
  const sessionStreamingState = new Map<string, {
    isSending: boolean;
    isStreaming: boolean;
    streamingMessageId: string | null;
    streamingContent: string;
    streamingToolCalls: ToolCallInfo[];
  }>();

  // Per-session todo cache: preserves todo list when switching between sessions.
  const sessionTodosCache = new Map<string, import("../types/index.js").TodoItem[]>();

  // Per-task streaming routing: maps backend taskId → frontend placeholder messageId.
  // Used to route SSE events to the correct message when multiple tasks run in parallel.
  const taskIdToMessageId = new Map<string, string>();

  // Per-session pendingQuestion cache: preserves ask_user state when switching sessions.
  const sessionPendingQuestionCache = new Map<string, {
    taskId: string;
    question: string;
    options: string[];
  } | null>();

  // Watchdog: auto-reset stuck isSending/isStreaming after 5 minutes with no activity.
  // Prevents the UI from permanently blocking message submission.
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
  let sendingStartTime: number | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  function markSendingStart() {
    sendingStartTime = Date.now();
    if (!watchdogTimer) {
      watchdogTimer = setInterval(() => {
        const { isSending, isStreaming } = get();
        if ((isSending || isStreaming) && sendingStartTime && (Date.now() - sendingStartTime > STUCK_THRESHOLD_MS)) {
          console.warn("[ChatStore] Watchdog: resetting stuck isSending/isStreaming after 5 minutes");
          set({ isSending: false, isStreaming: false });
          sendingStartTime = null;
        }
        if (!isSending && !isStreaming) {
          sendingStartTime = null;
          if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
        }
      }, 30_000);
    }
  }

  return {
  sessions: [],
  currentSessionId: savedSession,
  messages: [],
  agentTasks: [],
  todos: [],
  pendingQuestion: null,
  isLoading: false,
  isSessionLoading: false,
  isSending: false,
  isStreaming: false,
  error: null,
  streamingMessageId: null,
  streamingContent: "",
  streamingThinking: "",
  streamingToolCalls: [],

  loadSessions: async () => {
    set({ isLoading: true });
    try {
      const sessions = await api.listSessions();
      const sorted = sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      set({
        sessions: sorted,
        isLoading: false,
      });
      // Auto-load messages for the saved session on first load
      const { currentSessionId, messages } = get();
      if (currentSessionId && messages.length === 0) {
        const exists = sorted.some((s) => s.id === currentSessionId);
        if (exists) {
          set({ isSessionLoading: true });
          try {
            const [msgs, tasks] = await Promise.all([
              api.getMessages(currentSessionId),
              api.getAgentTasks(currentSessionId).catch(() => []),
            ]);
            // Guard: don't overwrite messages if session changed during the async fetch
            if (get().currentSessionId === currentSessionId) {
              set({ messages: mapMessages(msgs), agentTasks: tasks, isSessionLoading: false });
            }

            // Check for running agent tasks that need reconnection
            const runningTask = tasks.find(
              (t: AgentTaskInfo) => t.status === "running" || t.status === "pending",
            );
            if (runningTask) {
              get().reconnectToRunningTask(runningTask.id);
            } else {
              // Also check sessionStorage for a recently started task
              try {
                const stored = sessionStorage.getItem(`deepanalyze-running-task-${currentSessionId}`);
                if (stored) {
                  sessionStorage.removeItem(`deepanalyze-running-task-${currentSessionId}`);
                  get().reconnectToRunningTask(stored);
                }
              } catch { /* ignore */ }
            }
          } catch {
            set({ isSessionLoading: false });
          }
        }
      }
    } catch (err) {
      set({ error: String(err), isLoading: false, isSessionLoading: false });
    }
  },

  createSession: async (title?: string) => {
    try {
      // Reuse empty current session: if the user is already on a brand-new,
      // never-touched session (no messages, no title), don't persist another
      // empty shell — just clear the input state and stay put. Without this,
      // every click on 「新建对话」without sending a message would POST a fresh
      // session that lingers forever as a "新对话" entry in the sidebar
      // (issue #74). Explicit-titled creates bypass this guard.
      const preGuardState = get();
      if (
        !title &&
        preGuardState.currentSessionId &&
        !preGuardState.isSending &&
        !preGuardState.isStreaming
      ) {
        const currentSession = preGuardState.sessions.find(
          (s) => s.id === preGuardState.currentSessionId,
        );
        const cachedMsgs = sessionMessagesCache.get(preGuardState.currentSessionId);
        const hasMessagesLocally =
          preGuardState.messages.length > 0 || (cachedMsgs?.length ?? 0) > 0;
        const hasTitle = !!currentSession?.title;
        if (currentSession && !hasMessagesLocally && !hasTitle) {
          set({
            isSessionLoading: false,
            isSending: false,
            isStreaming: false,
            streamingMessageId: null,
            streamingContent: "",
            streamingThinking: "",
            streamingToolCalls: [],
            todos: [],
            pendingQuestion: null,
          });
          return preGuardState.currentSessionId;
        }
      }

      // --- Pre-switch cleanup: save old session state and abort its SSE ---
      // This MUST happen before the await to prevent stale SSE callbacks from
      // writing to the store during the network request.
      const preSwitchState = get();
      const oldSessionId = preSwitchState.currentSessionId;
      if (oldSessionId) {
        // Save messages to cache so switching back shows correct data
        if (preSwitchState.messages.length > 0) {
          sessionMessagesCache.set(oldSessionId, preSwitchState.messages);
        }
        // Save streaming state
        sessionStreamingState.set(oldSessionId, {
          isSending: preSwitchState.isSending,
          isStreaming: preSwitchState.isStreaming,
          streamingMessageId: preSwitchState.streamingMessageId,
          streamingContent: preSwitchState.streamingContent,
          streamingToolCalls: preSwitchState.streamingToolCalls,
        });
        // Save todos and pendingQuestion
        sessionTodosCache.set(oldSessionId, preSwitchState.todos);
        sessionPendingQuestionCache.set(oldSessionId, preSwitchState.pendingQuestion);
        // Abort old session's SSE connections to stop callbacks from firing
        clearAllSSEConnections(oldSessionId);
      }

      const session = await api.createSession(title);
      localStorage.setItem('deepanalyze-session', session.id);

      // Guard: if the user somehow triggered another session change during the
      // await, don't overwrite it.
      if (get().currentSessionId !== oldSessionId && oldSessionId !== null) {
        // Another session change happened during the await — don't switch
        return session.id;
      }

      set((s) => ({
        sessions: [session, ...s.sessions],
        currentSessionId: session.id,
        messages: [],
        agentTasks: [],
        isSessionLoading: false,
        // Reset all running state for the new session
        isSending: false,
        isStreaming: false,
        streamingMessageId: null,
        streamingContent: "",
        streamingThinking: "",
        streamingToolCalls: [],
        // Clear todos and pending question for new session
        todos: [],
        pendingQuestion: null,
      }));
      return session.id;
    } catch (err) {
      set({ error: String(err) });
      throw err;
    }
  },

  selectSession: async (id: string) => {
    const state = get();
    if (state.currentSessionId === id) return;

    // Save current session's streaming state before switching
    if (state.currentSessionId) {
      if (state.messages.length > 0) {
        sessionMessagesCache.set(state.currentSessionId, state.messages);
      }
      // Save streaming state for the old session
      sessionStreamingState.set(state.currentSessionId, {
        isSending: state.isSending,
        isStreaming: state.isStreaming,
        streamingMessageId: state.streamingMessageId,
        streamingContent: state.streamingContent,
        streamingToolCalls: state.streamingToolCalls,
      });
      // Save todos and pendingQuestion for the old session
      sessionTodosCache.set(state.currentSessionId, state.todos);
      sessionPendingQuestionCache.set(state.currentSessionId, state.pendingQuestion);
      // Abort old session's SSE connections (don't cancel backend task, just disconnect frontend)
      clearAllSSEConnections(state.currentSessionId);
    }

    localStorage.setItem('deepanalyze-session', id);

    // Load from cache immediately (if available) so the UI doesn't flash empty
    const cached = sessionMessagesCache.get(id);
    const needsLoad = !cached || cached.length === 0;
    // Restore todos and pendingQuestion for the new session
    const restoredTodos = sessionTodosCache.get(id) || [];
    const restoredQuestion = sessionPendingQuestionCache.get(id) ?? null;

    // CRITICAL: Always reset streaming state when switching sessions.
    // Do NOT restore isStreaming=true from sessionStreamingState — doing so
    // would block reconnectToRunningTask() (which has an isStreaming guard)
    // and prevent SSE reconnection. The background refresh in selectSession
    // will detect running tasks and reconnect properly, which sets up the
    // correct streaming state from scratch.
    // Clear per-task routing map — tasks from the old session are no longer
    // tracked in the frontend (backend may still be running them).
    taskIdToMessageId.clear();
    set({
      currentSessionId: id,
      messages: cached || [],
      agentTasks: [],
      isSessionLoading: needsLoad,
      isStreaming: false,
      isSending: false,
      streamingMessageId: null,
      streamingContent: "",
      streamingThinking: "",
      streamingToolCalls: [],
      todos: restoredTodos,
      pendingQuestion: restoredQuestion,
    });

    // Then refresh from server in the background
    try {
      const [messages, tasks, sessionMeta] = await Promise.all([
        api.getMessages(id),
        api.getAgentTasks(id).catch(() => []),
        api.getSession(id).catch(() => null),
      ]);
      const mapped = mapMessages(messages);
      sessionMessagesCache.set(id, mapped);
      // Only update if the user is still viewing this session
      if (get().currentSessionId === id) {
        // Update session metadata (e.g., kbScope) in the sessions array
        const updates: Record<string, unknown> = { messages: mapped, agentTasks: tasks, isSessionLoading: false };
        if (sessionMeta) {
          const existing = get().sessions;
          const exists = existing.some((s) => s.id === id);
          const sessions = exists
            ? existing.map((s) => (s.id === id ? { ...s, ...sessionMeta } : s))
            : [sessionMeta, ...existing];
          (updates as any).sessions = sessions;
        }
        set(updates);

        // Reconnect to running agent tasks so live updates resume
        if (get().currentSessionId === id) {
          const runningTask = tasks.find(
            (t: AgentTaskInfo) => t.status === "running" || t.status === "pending",
          );
          if (runningTask) {
            // Abort any stale SSE before reconnecting
            clearAllSSEConnections(id);
            get().reconnectToRunningTask(runningTask.id);
          } else {
            // Check sessionStorage for tasks not yet in DB
            try {
              const stored = sessionStorage.getItem(`deepanalyze-running-task-${id}`);
              if (stored) {
                sessionStorage.removeItem(`deepanalyze-running-task-${id}`);
                clearAllSSEConnections(id);
                get().reconnectToRunningTask(stored);
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      if (get().currentSessionId === id) {
        set({ error: String(err), isSessionLoading: false });
      }
    }
  },

  deleteSession: async (id: string) => {
    try {
      await api.deleteSession(id);
      const state = get();
      const sessions = state.sessions.filter((s) => s.id !== id);
      const currentSessionId = state.currentSessionId === id ? null : state.currentSessionId;
      if (state.currentSessionId === id) {
        localStorage.removeItem('deepanalyze-session');
      }
      // Remove from cache
      sessionMessagesCache.delete(id);
      sessionStreamingState.delete(id);
      sessionTodosCache.delete(id);
      sessionPendingQuestionCache.delete(id);
      clearAllSSEConnections(id);
      set({
        sessions,
        currentSessionId,
        messages: state.currentSessionId === id ? [] : state.messages,
        ...(state.currentSessionId === id ? {
          isSending: false,
          isStreaming: false,
          todos: [],
          pendingQuestion: null,
        } : {}),
      });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  renameSession: async (id: string, title: string) => {
    try {
      await api.renameSession(id, title);
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, title } : sess,
        ),
      }));
    } catch (err) {
      set({ error: String(err) });
    }
  },

  sendMessage: async (content: string, scope?: import("../types/index.js").AnalysisScope, mediaIds?: string[], mediaAttachments?: import("../types/index.js").MediaAttachment[]) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;
    // NOTE: No isSending/isStreaming guard — parallel sends are allowed.
    // Each send gets its own assistantId via closure, and SSE events are
    // routed by taskId to the correct message.

    // Optimistically show user message in UI
    const userMessage: MessageInfo = {
      id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      ...(mediaAttachments && mediaAttachments.length > 0 ? { media: mediaAttachments } : {}),
      ...(scope ? { metadata: { scope } } : {}),
    };

    // Each sendMessage call gets a unique assistantId captured in closure.
    // All SSE callbacks route updates to this specific message.
    const assistantId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const assistantMessage: MessageInfo = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      isStreaming: true,
      toolCalls: [],
    };

    set((s) => ({
      messages: [...s.messages, userMessage, assistantMessage],
      isSending: true,
      isStreaming: true,
      streamingMessageId: assistantId,
      streamingContent: "",
      streamingThinking: "",
      streamingToolCalls: [],
    }));
    markSendingStart();

    // Helper: update the assistant message for THIS task only
    const updateAssistantMsg = (updater: (m: MessageInfo) => MessageInfo) => {
      set((s) => ({
        messages: s.messages.map((m) => m.id === assistantId ? updater(m) : m),
      }));
    };

    // Track this task's backend taskId (set in onStart)
    let thisTaskId: string | null = null;

    // Helper: finalize streaming for THIS task
    const finalizeThisTask = () => {
      if (thisTaskId) taskIdToMessageId.delete(thisTaskId);
      const stillActive = taskIdToMessageId.size > 0;
      updateAssistantMsg((m) => ({ ...m, isStreaming: false }));
      if (!stillActive) {
        set({ isStreaming: false, isSending: false, streamingMessageId: null });
      }
    };

    let sseConn: SSEConnection | undefined;
    try {
      // Track whether we received any SSE content events or tool events
      let receivedContent = false;
      let receivedAnyEvent = false;

      // Use SSE streaming for real-time output
      const effectiveInput = content || (mediaIds && mediaIds.length > 0 ? " " : content);
      const { abort, promise } = api.runAgentStream(
        currentSessionId,
        effectiveInput,
        undefined,
        {
          onStart: (_taskId, _agentType) => {
            receivedAnyEvent = true;
            thisTaskId = _taskId;
            taskIdToMessageId.set(_taskId, assistantId);
            // Track in per-session SSE connection map
            const conn = getLatestSSEConnection(currentSessionId);
            if (conn) conn.taskId = _taskId;
            try {
              sessionStorage.setItem(`deepanalyze-running-task-${currentSessionId}`, _taskId);
            } catch { /* ignore */ }
            // Stamp taskId on this message
            updateAssistantMsg((m) => ({
              ...m,
              metadata: { ...(m.metadata || {}), taskId: _taskId },
            }));
          },
          onContentDelta: (delta) => {
            receivedContent = true;
            sendingStartTime = Date.now();
            if (get().currentSessionId !== currentSessionId) return;
            // Accumulate directly in the message object
            updateAssistantMsg((m) => ({
              ...m,
              content: (m.content || "") + delta,
            }));
          },
          onContentReset: (_taskId, _turn, reason) => {
            if (get().currentSessionId !== currentSessionId) return;
            // Recovery retry (max_tokens / tool_call truncation) is about to re-stream
            // this turn. Clear the partial content from the failed first attempt so the
            // UI shows only the clean retry output.
            console.info(`[chat] content_reset (turn ${_turn}, reason: ${reason}) — clearing partial stream content`);
            updateAssistantMsg((m) => ({
              ...m,
              content: "",
            }));
          },
          onThinkingDelta: (delta) => {
            if (get().currentSessionId !== currentSessionId) return;
            updateAssistantMsg((m) => ({
              ...m,
              thinkingContent: (m.thinkingContent || "") + delta,
            }));
          },
          onContent: (contentVal, accumulated) => {
            receivedContent = true;
            if (get().currentSessionId !== currentSessionId) return;
            // Length-based deduplication: only update if accumulated is longer
            set((s) => {
              const msg = s.messages.find((m) => m.id === assistantId);
              if (!msg) return {};
              const candidate = accumulated ?? ((msg.content || "") + contentVal);
              if (candidate.length <= (msg.content || "").length) return {};
              return {
                messages: s.messages.map((m) =>
                  m.id === assistantId ? { ...m, content: candidate } : m,
                ),
              };
            });
          },
          onToolCall: (tc) => {
            receivedAnyEvent = true;
            sendingStartTime = Date.now();
            if (get().currentSessionId !== currentSessionId) return;
            const toolCall: ToolCallInfo = {
              id: tc.id,
              toolName: tc.toolName,
              input: tc.input,
              status: "running",
            };
            updateAssistantMsg((m) => ({
              ...m,
              toolCalls: [...(m.toolCalls || []), toolCall],
            }));
          },
          onToolResult: (data) => {
            receivedAnyEvent = true;
            sendingStartTime = Date.now();
            if (get().currentSessionId !== currentSessionId) return;
            updateAssistantMsg((m) => ({
              ...m,
              toolCalls: (m.toolCalls || []).map((tc) =>
                tc.id === data.id ? { ...tc, output: data.output, status: "completed" as const } : tc,
              ),
            }));
          },
          onComplete: (_data) => {
            // Agent completed with final output
          },
          onPushContent: (data) => {
            if (get().currentSessionId !== currentSessionId) return;
            const pushedItem = {
              type: data.type,
              title: data.title,
              data: data.data || "",
              format: data.format,
              timestamp: data.timestamp,
              ...(data.fileName ? { fileName: data.fileName } : {}),
              ...(data.fileSize != null ? { fileSize: data.fileSize } : {}),
              ...(data.mimeType ? { mimeType: data.mimeType } : {}),
              ...(data.downloadUrl ? { downloadUrl: data.downloadUrl } : {}),
            };
            updateAssistantMsg((m) => ({
              ...m,
              pushedContents: [...(m.pushedContents || []), pushedItem],
            }));
          },
          onTodoUpdate: (data) => {
            if (get().currentSessionId !== currentSessionId) return;
            if (typeof (data as any).todos === "string") {
              try {
                const lines = (data as any).todos as string;
                const parsed: import("../types/index.js").TodoItem[] = [];
                const regex = /[⬜🔄✅]\s+\[([^\]]+)\]\s+(.+?)\s*\((pending|in_progress|completed)\)/g;
                let match;
                while ((match = regex.exec(lines)) !== null) {
                  const id = match[1];
                  const subject = match[2].replace(/\s*—\s*.+$/, '').trim();
                  const status = match[3] as "pending" | "in_progress" | "completed";
                  if (typeof id === "string" && typeof subject === "string" && id && subject) {
                    parsed.push({ id, subject, status });
                  }
                }
                if (parsed.length === 0) return;
                const action = (data as any).action as string;
                if (action === "bulk_set" || action === "created" || parsed.length > 1) {
                  set({ todos: parsed });
                } else if (action === "updated" && parsed.length === 1) {
                  const existing = get().todos;
                  const updated = parsed[0];
                  const merged = existing.map((t: import("../types/index.js").TodoItem) =>
                    t.id === updated.id ? { ...t, status: updated.status } : t,
                  );
                  set({ todos: merged });
                }
              } catch {
                // Ignore parse errors
              }
            }
          },
          onAskUser: (data) => {
            if (get().currentSessionId !== currentSessionId) return;
            set({
              pendingQuestion: {
                taskId: data.taskId,
                question: data.question,
                options: data.options ?? [],
              },
            });
          },
          onAskUserAnswered: () => {
            set({ pendingQuestion: null });
          },
          onError: (data) => {
            if (get().currentSessionId !== currentSessionId) return;
            set({ error: data.error });
          },
          onDone: (data) => {
            // Clean up task mapping
            if (thisTaskId) taskIdToMessageId.delete(thisTaskId);
            if (sseConn) removeSSEConnection(currentSessionId, sseConn);
            sessionStreamingState.delete(currentSessionId);

            const isCurrentSession = get().currentSessionId === currentSessionId;

            if (!isCurrentSession) {
              sessionStreamingState.delete(currentSessionId);
              try {
                sessionStorage.removeItem(`deepanalyze-running-task-${currentSessionId}`);
              } catch { /* ignore */ }
              api.getMessages(currentSessionId).then((messages) => {
                const mapped = mapMessages(messages);
                const finalized = mapped.map((m) =>
                  m.isStreaming ? { ...m, isStreaming: false } : m,
                );
                sessionMessagesCache.set(currentSessionId, finalized);
              }).catch(() => {});
              return;
            }

            try {
              sessionStorage.removeItem(`deepanalyze-running-task-${currentSessionId}`);
            } catch { /* ignore */ }

            // Get final content from the message (accumulated via deltas)
            const state = get();
            const currentMsg = state.messages.find((m) => m.id === assistantId);
            let finalContent = currentMsg?.content ?? "";

            if (!finalContent && (data as { output?: string }).output) {
              finalContent = (data as { output?: string }).output!;
            }

            const finalToolCalls = (currentMsg?.toolCalls || []).map((tc) => ({
              ...tc,
              status: tc.status === "running" ? "completed" as const : tc.status,
            }));

            const reportPayload = (data as { report?: { id: string; title: string; content: string; sourceCount?: number; reportType?: string } }).report;

            // Finalize this message
            set((s) => {
              const updatedMessages = s.messages.map((m) =>
                m.id === assistantId
                  ? { ...m, content: finalContent, isStreaming: false, toolCalls: finalToolCalls }
                  : m,
              );
              if (s.currentSessionId) {
                sessionMessagesCache.set(s.currentSessionId, updatedMessages);
              }
              const stillActive = taskIdToMessageId.size > 0;
              return {
                messages: updatedMessages,
                isStreaming: stillActive,
                isSending: stillActive,
                streamingMessageId: stillActive ? s.streamingMessageId : null,
              };
            });

            // Refresh session list
            get().loadSessions();

            // Attach report data
            if (reportPayload) {
              updateAssistantMsg((m) => ({
                ...m,
                report: {
                  id: reportPayload.id,
                  title: reportPayload.title,
                  content: reportPayload.content,
                  summary: reportPayload.content.slice(0, 200),
                  references: [],
                  entities: [],
                  createdAt: new Date().toISOString(),
                },
              }));
            }

            // Reload messages from server
            if (!finalContent) {
              api.getMessages(currentSessionId).then((messages) => {
                const mapped = mapMessages(messages);
                sessionMessagesCache.set(currentSessionId, mapped);
                if (get().currentSessionId === currentSessionId) {
                  set({ messages: mapped });
                }
              }).catch(() => {});
            }

            api.getMessages(currentSessionId).then((messages) => {
              const mapped = mapMessages(messages);
              sessionMessagesCache.set(currentSessionId, mapped);
              if (get().currentSessionId === currentSessionId) {
                const currentMessages = get().messages;
                const merged = mapped.map((serverMsg) => {
                  if (serverMsg.role !== "assistant") return serverMsg;
                  const serverTaskId = serverMsg.metadata?.taskId as string | undefined;
                  const existing = serverTaskId
                    ? currentMessages.find((m) => m.metadata?.taskId === serverTaskId)
                    : currentMessages.find((m) => m.id === serverMsg.id);
                  if (existing && existing.content && existing.content.trim().length > 0
                      && (!serverMsg.content || serverMsg.content.trim().length === 0
                          || existing.content.length >= serverMsg.content.length)) {
                    return {
                      ...serverMsg,
                      content: existing.content,
                      ...(existing.isStreaming !== undefined ? { isStreaming: existing.isStreaming } : {}),
                    };
                  }
                  return serverMsg;
                });
                set({ messages: merged });
              }
            }).catch(() => {});

            api.getAgentTasks(currentSessionId).then((tasks) => {
              if (get().currentSessionId === currentSessionId) {
                set({ agentTasks: tasks });
              }
            }).catch(() => {});

            // Auto-complete remaining todos
            const remainingTodos = get().todos;
            if (remainingTodos.some(t => t.status !== "completed")) {
              set({ todos: remainingTodos.map(t => ({ ...t, status: "completed" as const })) });
            }

            if (data.status === "failed") {
              set({ error: (data as { output?: string }).output ?? "Agent run failed" });
            }
          },
          onWorkflowEvent: (event) => {
            markSendingStart();
            const wfStore = useWorkflowStore.getState();
            const etype = event.type as string;
            switch (etype) {
              case "workflow_start":
                wfStore.handleWorkflowStart(event as any);
                wsSubscribeWorkflow([event.workflowId as string]);
                break;
              case "workflow_agent_start":
                wfStore.handleAgentStart(event as any);
                break;
              case "workflow_agent_tool_call":
                wfStore.handleAgentToolCall({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  toolName: (event.toolName ?? event.tool ?? "") as string,
                  input: ((event.input ?? event.args ?? {}) as Record<string, unknown>),
                });
                break;
              case "workflow_agent_tool_result":
                wfStore.handleAgentToolResult({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  toolName: (event.toolName ?? event.tool ?? "") as string,
                  output: (event.output ?? event.result ?? "") as string,
                });
                break;
              case "workflow_agent_chunk":
                wfStore.handleAgentChunk({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  content: (event.content ?? event.chunk ?? "") as string,
                });
                break;
              case "workflow_agent_complete":
                wfStore.handleAgentComplete({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  duration: (event.duration ?? 0) as number,
                  ...(event.status === "error" || event.status === "failed" ? { error: String(event.status) } : {}),
                });
                break;
              case "workflow_complete":
                wfStore.handleWorkflowComplete({
                  workflowId: event.workflowId as string,
                  status: event.status as string,
                  duration: (event.totalDuration ?? event.duration ?? 0) as number,
                });
                wsUnsubscribeWorkflow([event.workflowId as string]);
                break;
            }
          },
        },
        scope,
        mediaIds,
      );

      // Track SSE connection for this session
      sseConn = addSSEConnection(currentSessionId, { abort, taskId: null });

      // SSE timeout fallback
      const sseTimeoutId = setTimeout(() => {
        if (!receivedAnyEvent && taskIdToMessageId.has(thisTaskId ?? "")) {
          console.warn("[ChatStore] No SSE content received after 15s, falling back to polling");
          const userMsgCount = get().messages.filter((m) => m.role === "user").length;
          const pollForResult = async (attempts = 0) => {
            if (attempts > 60) {
              finalizeThisTask();
              return;
            }
            try {
              const messages = await api.getMessages(currentSessionId);
              let userMsgIndex = -1;
              let userCount = 0;
              for (let i = 0; i < messages.length; i++) {
                if (messages[i].role === "user") {
                  userCount++;
                  if (userCount === userMsgCount) {
                    userMsgIndex = i;
                    break;
                  }
                }
              }
              const hasAssistantResponse = userMsgIndex >= 0 &&
                messages.some((m, i) => m.role === "assistant" && i > userMsgIndex);
              if (hasAssistantResponse) {
                const mapped = mapMessages(messages);
                sessionMessagesCache.set(currentSessionId, mapped);
                if (get().currentSessionId !== currentSessionId) return;
                // Finalize this specific task
                if (thisTaskId) taskIdToMessageId.delete(thisTaskId);
                updateAssistantMsg((m) => ({ ...m, isStreaming: false }));
                const stillActive = taskIdToMessageId.size > 0;
                set({
                  messages: mapped,
                  isStreaming: stillActive,
                  isSending: stillActive,
                  ...(stillActive ? {} : { streamingMessageId: null }),
                });
                api.getAgentTasks(currentSessionId).then((tasks) => {
                  if (get().currentSessionId === currentSessionId) {
                    set({ agentTasks: tasks });
                  }
                }).catch(() => {});
                return;
              }
            } catch {
              // Continue polling
            }
            if (get().currentSessionId !== currentSessionId) return;
            setTimeout(() => pollForResult(attempts + 1), 1000);
          };
          setTimeout(() => pollForResult(), 1000);
        }
      }, 15_000);

      promise.finally(() => clearTimeout(sseTimeoutId));

      await promise;
    } catch (err) {
      console.warn("[ChatStore] SSE stream ended, polling for final result:", err);

      if (sseConn) removeSSEConnection(currentSessionId, sseConn);

      // Finalize this specific task's message with whatever content we have
      const state = get();
      const currentMsg = state.messages.find((m) => m.id === assistantId);
      if (currentMsg?.isStreaming) {
        if (thisTaskId) taskIdToMessageId.delete(thisTaskId);
        const partialContent = currentMsg.content || "";
        const partialToolCalls = (currentMsg.toolCalls || []).map((tc) => ({
          ...tc,
          status: tc.status === "running" ? "completed" as const : tc.status,
        }));
        const stillActive = taskIdToMessageId.size > 0;
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === assistantId
              ? { ...m, content: partialContent, isStreaming: false, toolCalls: partialToolCalls }
              : m,
          ),
          isStreaming: stillActive,
          isSending: stillActive,
          ...(stillActive ? {} : { streamingMessageId: null }),
        }));
      }

      // Poll for the final messages from the server
      const userMsgCount = get().messages.filter((m) => m.role === "user").length;
      const pollForResult = async (attempts = 0) => {
        if (attempts > 60) {
          set((s) => ({
            isSending: taskIdToMessageId.size > 0,
            isStreaming: taskIdToMessageId.size > 0,
          }));
          return;
        }
        if (get().currentSessionId !== currentSessionId) return;
        try {
          const messages = await api.getMessages(currentSessionId);
          let userMsgIndex = -1;
          let userCount = 0;
          for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === "user") {
              userCount++;
              if (userCount === userMsgCount) {
                userMsgIndex = i;
                break;
              }
            }
          }
          const hasAssistantResponse = userMsgIndex >= 0 &&
            messages.some((m, i) => m.role === "assistant" && i > userMsgIndex);
          if (hasAssistantResponse) {
            const mapped = mapMessages(messages);
            sessionMessagesCache.set(currentSessionId, mapped);
            if (get().currentSessionId === currentSessionId) {
              const stillActive = taskIdToMessageId.size > 0;
              set({
                messages: mapped,
                isSending: stillActive,
                isStreaming: stillActive,
                ...(stillActive ? {} : { streamingMessageId: null }),
              });
            }
            api.getAgentTasks(currentSessionId).then((tasks) => {
              if (get().currentSessionId === currentSessionId) {
                set({ agentTasks: tasks });
              }
            }).catch(() => {});
            return;
          }
        } catch {
          // Continue polling
        }
        setTimeout(() => pollForResult(attempts + 1), 1000);
      };

      setTimeout(() => pollForResult(), 2000);
    }
  },

  clearError: () => set({ error: null }),

  // --- Streaming ---

  startStreaming: (messageId: string) => {
    const assistantMessage: MessageInfo = {
      id: messageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      isStreaming: true,
      toolCalls: [],
    };
    set((s) => ({
      messages: [...s.messages, assistantMessage],
      isStreaming: true,
      streamingMessageId: messageId,
      streamingContent: "",
      streamingThinking: "",
      streamingToolCalls: [],
      isSending: false,
    }));
  },

  appendStreamContent: (content: string) => {
    set((s) => {
      // No active stream — ignore stale SSE callback
      if (!s.streamingMessageId) return {};
      const newContent = s.streamingContent + content;
      return {
        streamingContent: newContent,
        messages: s.messages.map((m) =>
          m.id === s.streamingMessageId ? { ...m, content: newContent } : m,
        ),
      };
    });
  },

  appendStreamThinking: (content: string) => {
    set((s) => {
      if (!s.streamingMessageId) return {};
      const newThinking = s.streamingThinking + content;
      return {
        streamingThinking: newThinking,
        messages: s.messages.map((m) =>
          m.id === s.streamingMessageId ? { ...m, thinkingContent: newThinking } : m,
        ),
      };
    });
  },

  addStreamToolCall: (toolCall: ToolCallInfo) => {
    set((s) => {
      // No active stream — ignore stale SSE callback
      if (!s.streamingMessageId) return {};
      const newToolCalls = [...s.streamingToolCalls, toolCall];
      return {
        streamingToolCalls: newToolCalls,
        messages: s.messages.map((m) =>
          m.id === s.streamingMessageId ? { ...m, toolCalls: newToolCalls } : m,
        ),
      };
    });
  },

  updateStreamToolResult: (id: string, output: string, status: "completed" | "error") => {
    set((s) => {
      // No active stream — ignore stale SSE callback
      if (!s.streamingMessageId) return {};
      const newToolCalls = s.streamingToolCalls.map((tc) =>
        tc.id === id ? { ...tc, output, status } : tc,
      );
      return {
        streamingToolCalls: newToolCalls,
        messages: s.messages.map((m) =>
          m.id === s.streamingMessageId ? { ...m, toolCalls: newToolCalls } : m,
        ),
      };
    });
  },

  finishStreaming: (fullContent: string, toolCalls?: ToolCallInfo[]) => {
    set((s) => {
      // No active stream — ignore stale callback
      if (!s.streamingMessageId) return {};
      const updatedMessages = s.messages.map((m) =>
        m.id === s.streamingMessageId
          ? { ...m, content: fullContent, isStreaming: false, toolCalls: toolCalls ?? m.toolCalls }
          : m,
      );
      // Update cache for the current session
      if (s.currentSessionId) {
        sessionMessagesCache.set(s.currentSessionId, updatedMessages);
      }
      // Check if other parallel tasks are still active
      const otherTasksActive = taskIdToMessageId.size > 0;
      return {
        isStreaming: otherTasksActive,
        isSending: otherTasksActive,
        streamingMessageId: otherTasksActive ? s.streamingMessageId : null,
        streamingContent: "",
        streamingThinking: "",
        streamingToolCalls: [],
        messages: updatedMessages,
      };
    });
  },

  stopStreaming: () => {
    const { currentSessionId } = get();

    // Cancel ALL backend tasks and abort SSE connections for this session
    if (currentSessionId) {
      const conns = activeSSEConnections.get(currentSessionId);
      if (conns) {
        for (const conn of conns) {
          if (conn.taskId) {
            api.cancelAgentTask(conn.taskId).catch(() => {});
          }
          conn.abort();
        }
        conns.clear();
        activeSSEConnections.delete(currentSessionId);
      }
      sessionStreamingState.delete(currentSessionId);
    }
    // Clear all per-task routing for this session
    taskIdToMessageId.clear();

    // Clear UI state
    set((s) => ({
      isStreaming: false,
      isSending: false,
      streamingMessageId: null,
      streamingContent: "",
      streamingThinking: "",
      streamingToolCalls: [],
      messages: s.messages.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m,
      ),
    }));
  },

  // --- Agent Tasks ---

  loadAgentTasks: async (sessionId: string) => {
    try {
      const tasks = await api.getAgentTasks(sessionId);
      set({ agentTasks: tasks });
    } catch {
      // Silently ignore
    }
  },

  addAgentTask: (task: AgentTaskInfo) => {
    set((s) => ({ agentTasks: [task, ...s.agentTasks] }));
  },

  updateAgentTaskProgress: (taskId: string, progress: number) => {
    set((s) => ({
      agentTasks: s.agentTasks.map((t) =>
        t.id === taskId ? { ...t, progress, status: "running" as const } : t,
      ),
    }));
  },

  completeAgentTask: (taskId: string, output: string) => {
    set((s) => ({
      agentTasks: s.agentTasks.map((t) =>
        t.id === taskId
          ? { ...t, status: "completed" as const, output, completedAt: new Date().toISOString() }
          : t,
      ),
    }));
  },

  failAgentTask: (taskId: string, error: string) => {
    set((s) => ({
      agentTasks: s.agentTasks.map((t) =>
        t.id === taskId
          ? { ...t, status: "failed" as const, error, completedAt: new Date().toISOString() }
          : t,
      ),
    }));
  },

  runAgent: async (input: string, agentType?: string) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;
    // Capture sessionId for closure — used in async callbacks for session guards
    const runAgentSessionId = currentSessionId;

    const userMessage: MessageInfo = {
      id: `temp-agent-${Date.now()}`,
      role: "user",
      content: input,
      createdAt: new Date().toISOString(),
    };

    set((s) => ({ messages: [...s.messages, userMessage], isSending: true }));
    markSendingStart();

    let sseConn: SSEConnection | undefined;
    try {
      // Create streaming placeholder
      const assistantId = `stream-agent-${Date.now()}`;
      get().startStreaming(assistantId);

      const { abort, promise } = api.runAgentStream(
        currentSessionId,
        input,
        agentType,
        {
          onStart: (_taskId, _agentType) => {
            // Track taskId for cancellation
            const conn = getLatestSSEConnection(runAgentSessionId);
            if (conn) conn.taskId = _taskId;
            try {
              sessionStorage.setItem(`deepanalyze-running-task-${runAgentSessionId}`, _taskId);
            } catch { /* ignore */ }
          },
          onContentDelta: (delta) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            sendingStartTime = Date.now();
            get().appendStreamContent(delta);
          },
          onContentReset: (_taskId, _turn, reason) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            // Recovery retry is about to re-stream this turn — clear partial content.
            console.info(`[chat] content_reset (turn ${_turn}, reason: ${reason}) — clearing partial stream content`);
            set((s) => ({
              streamingContent: "",
              messages: s.messages.map((m) =>
                m.id === s.streamingMessageId ? { ...m, content: "" } : m,
              ),
            }));
          },
          onThinkingDelta: (delta) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            get().appendStreamThinking(delta);
          },
          onContent: (content, accumulated) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            set((s) => {
              const candidate = accumulated ?? ((s.streamingContent || "") + content);
              if (candidate.length <= (s.streamingContent || "").length) {
                return {};
              }
              return {
                streamingContent: candidate,
                messages: s.messages.map((m) =>
                  m.id === s.streamingMessageId ? { ...m, content: candidate } : m,
                ),
              };
            });
          },
          onToolCall: (tc) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            sendingStartTime = Date.now();
            get().addStreamToolCall({
              id: tc.id,
              toolName: tc.toolName,
              input: tc.input,
              status: "running",
            });
          },
          onToolResult: (data) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            sendingStartTime = Date.now();
            get().updateStreamToolResult(data.id, data.output, "completed");
          },
          onPushContent: (data) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            const state = get();
            const msgId = state.streamingMessageId;
            if (!msgId) return;
            const pushedItem = {
              type: data.type,
              title: data.title,
              data: data.data || "",
              format: data.format,
              timestamp: data.timestamp,
              ...(data.fileName ? { fileName: data.fileName } : {}),
              ...(data.fileSize != null ? { fileSize: data.fileSize } : {}),
              ...(data.mimeType ? { mimeType: data.mimeType } : {}),
              ...(data.downloadUrl ? { downloadUrl: data.downloadUrl } : {}),
            };
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === msgId
                  ? { ...m, pushedContents: [...(m.pushedContents || []), pushedItem] }
                  : m
              ),
            }));
          },
          onTodoUpdate: (data) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            if (typeof (data as any).todos === "string") {
              try {
                const lines = (data as any).todos as string;
                const parsed: import("../types/index.js").TodoItem[] = [];
                const regex = /[⬜🔄✅]\s+\[([^\]]+)\]\s+(.+?)\s*\((pending|in_progress|completed)\)/g;
                let match;
                while ((match = regex.exec(lines)) !== null) {
                  const id = match[1];
                  const subject = match[2].replace(/\s*—\s*.+$/, '').trim();
                  const status = match[3] as "pending" | "in_progress" | "completed";
                  // Defensive: ensure all fields are strings to prevent React error #31
                  if (typeof id === "string" && typeof subject === "string" && id && subject) {
                    parsed.push({ id, subject, status });
                  }
                }
                if (parsed.length === 0) return;

                const action = (data as any).action as string;
                if (action === "bulk_set" || action === "created" || parsed.length > 1) {
                  set({ todos: parsed });
                } else if (action === "updated" && parsed.length === 1) {
                  const existing = get().todos;
                  const updated = parsed[0];
                  const merged = existing.map((t: import("../types/index.js").TodoItem) =>
                    t.id === updated.id ? { ...t, status: updated.status } : t
                  );
                  set({ todos: merged });
                }
              } catch {
                // Ignore parse errors
              }
            }
          },
          onAskUser: (data) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            set({
              pendingQuestion: {
                taskId: data.taskId,
                question: data.question,
                options: data.options ?? [],
              },
            });
          },
          onAskUserAnswered: () => {
            set({ pendingQuestion: null });
          },
          onError: (data) => {
            if (get().currentSessionId !== runAgentSessionId) return;
            set({ error: data.error });
          },
          onDone: (data) => {
            // Clean up SSE connection tracking
            if (sseConn) removeSSEConnection(runAgentSessionId, sseConn);
            sessionStreamingState.delete(runAgentSessionId);

            // If user has switched sessions, clean up internal state but don't update UI
            const isCurrentSession = get().currentSessionId === runAgentSessionId;
            if (!isCurrentSession) {
              sessionStreamingState.delete(runAgentSessionId);
              try {
                sessionStorage.removeItem(`deepanalyze-running-task-${runAgentSessionId}`);
              } catch { /* ignore */ }
              api.getMessages(runAgentSessionId).then((messages) => {
                sessionMessagesCache.set(runAgentSessionId, mapMessages(messages));
              }).catch(() => {});
              return;
            }

            const state = get();
            let finalContent = state.streamingContent;

            // If no SSE content received but done event has output, use it
            if (!finalContent && (data as { output?: string }).output) {
              finalContent = (data as { output?: string }).output!;
            }

            const finalToolCalls = state.streamingToolCalls.map((tc) => ({
              ...tc,
              status: tc.status === "running" ? "completed" as const : tc.status,
            }));
            state.finishStreaming(finalContent, finalToolCalls);

            // Refresh session list to pick up auto-generated title
            get().loadSessions();

            // Extract report data if present in the done event
            const reportPayload = (data as { report?: { id: string; title: string; content: string; sourceCount?: number; reportType?: string } }).report;
            if (reportPayload) {
              const msgId = state.streamingMessageId;
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.id === msgId
                    ? {
                        ...m,
                        report: {
                          id: reportPayload.id,
                          title: reportPayload.title,
                          content: reportPayload.content,
                          summary: reportPayload.content.slice(0, 200),
                          references: [],
                          entities: [],
                          createdAt: new Date().toISOString(),
                        },
                      }
                    : m
                ),
              }));
            }

            // If still no content, reload from server
            if (!finalContent) {
              api.getMessages(currentSessionId).then((messages) => {
                const mapped = mapMessages(messages);
                sessionMessagesCache.set(currentSessionId, mapped);
                if (get().currentSessionId === runAgentSessionId) {
                  set({ messages: mapped });
                }
              }).catch(() => {});
            }

            api.getAgentTasks(currentSessionId).then((tasks) => {
              if (get().currentSessionId === runAgentSessionId) {
                set({ agentTasks: tasks });
              }
            }).catch(() => {});

            set({ isSending: false });

            // Auto-complete remaining todos when agent finishes
            const remainingTodos2 = get().todos;
            if (remainingTodos2.some(t => t.status !== "completed")) {
              set({ todos: remainingTodos2.map(t => ({ ...t, status: "completed" as const })) });
            }

            if (data.status === "failed") {
              set({ error: (data as { output?: string }).output ?? "Agent run failed" });
            }
          },
          onWorkflowEvent: (event) => {
            // Reset watchdog timer — workflow events indicate the agent is still active
            markSendingStart();
            const wfStore = useWorkflowStore.getState();
            const etype = event.type as string;
            switch (etype) {
              case "workflow_start":
                wfStore.handleWorkflowStart(event as any);
                wsSubscribeWorkflow([event.workflowId as string]);
                break;
              case "workflow_agent_start":
                wfStore.handleAgentStart(event as any);
                break;
              case "workflow_agent_tool_call":
                wfStore.handleAgentToolCall({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  toolName: (event.toolName ?? event.tool ?? "") as string,
                  input: ((event.input ?? event.args ?? {}) as Record<string, unknown>),
                });
                break;
              case "workflow_agent_tool_result":
                wfStore.handleAgentToolResult({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  toolName: (event.toolName ?? event.tool ?? "") as string,
                  output: (event.output ?? event.result ?? "") as string,
                });
                break;
              case "workflow_agent_chunk":
                wfStore.handleAgentChunk({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  content: (event.content ?? event.chunk ?? "") as string,
                });
                break;
              case "workflow_agent_complete":
                wfStore.handleAgentComplete({
                  workflowId: event.workflowId as string,
                  agentId: event.agentId as string,
                  duration: (event.duration ?? 0) as number,
                  ...(event.status === "error" || event.status === "failed" ? { error: String(event.status) } : {}),
                });
                break;
              case "workflow_complete":
                wfStore.handleWorkflowComplete({
                  workflowId: event.workflowId as string,
                  status: event.status as string,
                  duration: (event.totalDuration ?? event.duration ?? 0) as number,
                });
                wsUnsubscribeWorkflow([event.workflowId as string]);
                break;
            }
          },
        },
      );

      // Track SSE connection for this session
      sseConn = addSSEConnection(runAgentSessionId, { abort, taskId: null });

      await promise;
    } catch (err) {
      // SSE stream ended or was interrupted — agent may still be running on server.
      // Don't re-run. Poll for the result instead.
      console.warn("[ChatStore] SSE stream ended for runAgent, polling for result:", err);

      // Clean up SSE connection tracking
      if (sseConn) removeSSEConnection(runAgentSessionId, sseConn);

      const state = get();
      if (state.isStreaming && state.streamingMessageId) {
        const partialContent = state.streamingContent;
        const partialToolCalls = state.streamingToolCalls.map((tc) => ({
          ...tc,
          status: tc.status === "running" ? "completed" as const : tc.status,
        }));
        state.finishStreaming(partialContent, partialToolCalls);
      }

      // Poll for the final result
      const pollForResult = async (attempts = 0) => {
        if (attempts > 120) { set({ isSending: false }); return; }
        if (get().currentSessionId !== currentSessionId) { set({ isSending: false }); return; }
        try {
          const tasks = await api.getAgentTasks(currentSessionId);
          set({ agentTasks: tasks });
          const stillRunning = tasks.some(
            (t) => t.status === "running" || t.status === "pending",
          );
          if (stillRunning) {
            setTimeout(() => pollForResult(attempts + 1), 1000);
          } else {
            const messages = await api.getMessages(currentSessionId);
            set({ messages: mapMessages(messages), isSending: false });
          }
        } catch {
          set({ isSending: false });
        }
      };
      setTimeout(() => pollForResult(), 2000);
    }
  },

  regenerateMessage: (messageId: string) => {
    const state = get();
    const msgIndex = state.messages.findIndex((m) => m.id === messageId);
    if (msgIndex === -1) return;

    // Find the user message before this AI message
    let userMsgIndex = msgIndex - 1;
    while (userMsgIndex >= 0 && state.messages[userMsgIndex].role !== "user") {
      userMsgIndex--;
    }
    if (userMsgIndex < 0) return;

    const userMsg = state.messages[userMsgIndex];
    const userContent = userMsg.content;

    // Restore original scope and media attachments so the regenerated
    // request matches the original intent (e.g. webSearch-only, KB scope, media).
    const userScope = userMsg.metadata?.scope as import("../types/index.js").AnalysisScope | undefined;
    const userMediaIds = userMsg.media?.map((m) => m.mediaId);
    const userMediaAttachments = userMsg.media;

    // Remove the AI message and everything after it
    set({ messages: state.messages.slice(0, msgIndex) });

    // Re-send the user message through the normal flow
    get().sendMessage(userContent, userScope, userMediaIds, userMediaAttachments);
  },

  cancelAgentTask: async (taskId: string) => {
    try {
      await api.cancelAgentTask(taskId);
      set((s) => ({
        agentTasks: s.agentTasks.map((t) =>
          t.id === taskId ? { ...t, status: "cancelled" as const } : t,
        ),
      }));
    } catch (err) {
      set({ error: String(err) });
    }
  },

  updateTodos: (todos: import("../types/index.js").TodoItem[]) => {
    set({ todos });
  },

  clearTodos: () => {
    set({ todos: [] });
  },

  setPendingQuestion: (q) => {
    set({ pendingQuestion: q });
  },

  answerQuestion: async (taskId, answer) => {
    try {
      await api.answerAskUser(taskId, answer);
      set({ pendingQuestion: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  reconnectToRunningTask: async (taskId: string) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;

    // Don't reconnect if already streaming
    if (get().isStreaming) return;

    // Capture sessionId for closure
    const reconnectSessionId = currentSessionId;

    // Load latest messages from DB to get any partial content
    try {
      const messages = await api.getMessages(currentSessionId);
      const mapped = mapMessages(messages);
      // Guard: user may have switched sessions during the async fetch
      if (get().currentSessionId === reconnectSessionId) {
        set({ messages: mapped });
      }
      sessionMessagesCache.set(reconnectSessionId, mapped);
    } catch {
      // Continue even if message load fails
    }

    // Sync workflow state from server — recovers workflows whose events
    // were lost during the disconnected period (SSE miss, tab refresh, etc.)
    try {
      const { workflows } = await api.listSessionWorkflows(reconnectSessionId);
      const wfStore = useWorkflowStore.getState();
      for (const wf of workflows) {
        const isTerminal = wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled";
        const exists = wfStore.activeWorkflows.has(wf.workflowId);
        if (!exists) {
          // Event was lost — rebuild the card so the user sees it.
          // Use real fields from REST (teamName/mode/goal) instead of a
          // placeholder string. After RR1+RR2 fixes, this path is only hit
          // when SSE was completely disconnected; if SSE later reconnects,
          // a real workflow_start event will overwrite this placeholder card.
          wfStore.handleWorkflowStart({
            workflowId: wf.workflowId,
            sessionId: reconnectSessionId,
            teamName: wf.teamName ?? "(后台工作流)",
            mode: wf.mode ?? "unknown",
            agentCount: wf.agentCount ?? 0,
            isPlaceholder: true,
          });
          wsSubscribeWorkflow([wf.workflowId]);
        }
        if (isTerminal) {
          // Workflow already finished — force completion to trigger cleanup
          wfStore.handleWorkflowComplete({
            workflowId: wf.workflowId,
            status: wf.status,
            duration: wf.durationMs ?? 0,
          });
          wsUnsubscribeWorkflow([wf.workflowId]);
        } else if (exists || !exists) {
          // Still running — poll for completion via REST API as a fallback
          // channel (in case SSE/WS events are still lost after reconnection)
          const pollWf = async () => {
            const deadline = Date.now() + 10 * 60 * 1000;
            while (Date.now() < deadline) {
              if (get().currentSessionId !== reconnectSessionId) return;
              await new Promise((r) => setTimeout(r, 5000));
              try {
                const { workflows: pollWfs } = await api.listSessionWorkflows(reconnectSessionId);
                const pollWf = pollWfs.find((w) => w.workflowId === wf.workflowId);
                if (!pollWf) {
                  // Workflow disappeared from server — force cleanup
                  wfStore.clearWorkflow(wf.workflowId);
                  wsUnsubscribeWorkflow([wf.workflowId]);
                  return;
                }
                if (pollWf.status === "completed" || pollWf.status === "failed" || pollWf.status === "cancelled") {
                  wfStore.handleWorkflowComplete({
                    workflowId: pollWf.workflowId,
                    status: pollWf.status,
                    duration: pollWf.durationMs ?? 0,
                  });
                  wsUnsubscribeWorkflow([pollWf.workflowId]);
                  return;
                }
              } catch { /* retry */ }
            }
          };
          pollWf();
        }
      }
    } catch {
      // Best-effort sync — continue with reconnection
    }

    // Find the LAST assistant message (most recent in multi-turn conversations).
    // Using reverse find ensures we reconnect to the correct message when there
    // are multiple assistant responses from previous turns.
    const allMessages = get().messages;
    const existingAssistant = allMessages.length > 0
      ? [...allMessages].reverse().find((m) => m.role === "assistant")
      : undefined;

    const assistantId = existingAssistant?.id ?? `reconnect-${Date.now()}`;

    if (!existingAssistant) {
      // No assistant message at all — create a streaming placeholder
      const assistantMessage: MessageInfo = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        isStreaming: true,
        toolCalls: [],
      };
      // Guard: user may have switched sessions during async getMessages
      if (get().currentSessionId !== reconnectSessionId) return;
      set((s) => ({
        messages: [...s.messages, assistantMessage],
        isStreaming: true,
        isSending: true,
        streamingMessageId: assistantId,
        streamingContent: "",
        streamingThinking: "",
        streamingToolCalls: [],
      }));
    } else {
      // Reuse existing assistant message — mark as streaming and restore its content
      const existingContent = existingAssistant.content || "";
      const existingToolCalls = existingAssistant.toolCalls || [];
      // Guard: user may have switched sessions during async getMessages
      if (get().currentSessionId !== reconnectSessionId) return;
      set((s) => ({
        isStreaming: true,
        isSending: true,
        streamingMessageId: assistantId,
        streamingContent: existingContent,
        streamingToolCalls: [...existingToolCalls],
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, isStreaming: true } : m,
        ),
      }));
    }

    let sseConn: SSEConnection | undefined;
    try {
      const { abort, promise } = api.reconnectAgentStream(taskId, {
        // NOTE: onContentDelta is intentionally NOT handled during reconnection.
        // The SSE event buffer replays ALL historical content_delta events, which
        // would duplicate content already loaded from the DB into streamingContent.
        // Instead, we rely solely on onContent events which carry the full
        // accumulated text and have proper length-based deduplication.
        onContentDelta: undefined,
        onContent: (content, accumulated) => {
          // Guard: skip if user has switched to a different session
          if (get().currentSessionId !== reconnectSessionId) return;
          sendingStartTime = Date.now();
          set((s) => {
            // During reconnection replay, content events carry historical snapshots.
            // Only accept if the accumulated text is genuinely longer than what we
            // already have (from DB load or previous replay events). This prevents
            // older/shorter snapshots from overwriting newer/longer content.
            const candidate = accumulated ?? ((s.streamingContent || "") + content);
            if (candidate.length <= (s.streamingContent || "").length) {
              return {};
            }
            return {
              streamingContent: candidate,
              messages: s.messages.map((m) =>
                m.id === s.streamingMessageId ? { ...m, content: candidate } : m,
              ),
            };
          });
        },
        onToolCall: (tc) => {
          if (get().currentSessionId !== reconnectSessionId) return;
          sendingStartTime = Date.now();
          // Deduplicate tool calls during replay — the SSE buffer replays all
          // historical events, so tool calls that were already in the DB-loaded
          // message would be duplicated without this check.
          const state = get();
          const alreadyExists = state.streamingToolCalls.some(
            (existing) => existing.id === tc.id,
          );
          if (!alreadyExists) {
            get().addStreamToolCall({
              id: tc.id,
              toolName: tc.toolName,
              input: tc.input,
              status: "running",
            });
          }
        },
        onToolResult: (data) => {
          if (get().currentSessionId !== reconnectSessionId) return;
          sendingStartTime = Date.now();
          get().updateStreamToolResult(data.id, data.output, "completed");
        },
        onPushContent: (data) => {
          if (get().currentSessionId !== reconnectSessionId) return;
          const state = get();
          const msgId = state.streamingMessageId;
          if (!msgId) return;
          const pushedItem = {
            type: data.type,
            title: data.title,
            data: data.data || "",
            format: data.format,
            timestamp: data.timestamp,
            ...(data.fileName ? { fileName: data.fileName } : {}),
            ...(data.fileSize != null ? { fileSize: data.fileSize } : {}),
            ...(data.mimeType ? { mimeType: data.mimeType } : {}),
            ...(data.downloadUrl ? { downloadUrl: data.downloadUrl } : {}),
          };
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === msgId
                ? { ...m, pushedContents: [...(m.pushedContents || []), pushedItem] }
                : m
            ),
          }));
        },
        onTodoUpdate: (data) => {
          if (get().currentSessionId !== reconnectSessionId) return;
          if (typeof (data as any).todos === "string") {
            try {
              const lines = (data as any).todos as string;
              const parsed: import("../types/index.js").TodoItem[] = [];
              const regex = /[⬜🔄✅]\s+\[([^\]]+)\]\s+(.+?)\s*\((pending|in_progress|completed)\)/g;
              let match;
              while ((match = regex.exec(lines)) !== null) {
                const id = match[1];
                const subject = match[2].replace(/\s*—\s*.+$/, '').trim();
                const status = match[3] as "pending" | "in_progress" | "completed";
                // Defensive: ensure all fields are strings to prevent React error #31
                if (typeof id === "string" && typeof subject === "string" && id && subject) {
                  parsed.push({ id, subject, status });
                }
              }
              if (parsed.length === 0) return;

              const action = (data as any).action as string;
              if (action === "bulk_set" || action === "created" || parsed.length > 1) {
                set({ todos: parsed });
              } else if (action === "updated" && parsed.length === 1) {
                const existing = get().todos;
                const updated = parsed[0];
                const merged = existing.map((t: import("../types/index.js").TodoItem) =>
                  t.id === updated.id ? { ...t, status: updated.status } : t
                );
                set({ todos: merged });
              }
            } catch {
              // Ignore parse errors
            }
          }
        },
        onAskUser: (data) => {
          if (get().currentSessionId !== reconnectSessionId) return;
          set({
            pendingQuestion: {
              taskId: data.taskId,
              question: data.question,
              options: data.options ?? [],
            },
          });
        },
        onAskUserAnswered: () => {
          set({ pendingQuestion: null });
        },
        onError: (data) => {
          if (get().currentSessionId !== reconnectSessionId) return;
          set({ error: data.error });
        },
        onDone: (data) => {
          // Clean up SSE connection tracking
          if (sseConn) removeSSEConnection(reconnectSessionId, sseConn);
          sessionStreamingState.delete(reconnectSessionId);

          // If user has switched sessions, clean up internal state but don't update UI
          const isCurrentSession = get().currentSessionId === reconnectSessionId;
          if (!isCurrentSession) {
            try {
              sessionStorage.removeItem(`deepanalyze-running-task-${reconnectSessionId}`);
            } catch { /* ignore */ }
            // Clear streaming state so next switch-back doesn't restore stale isStreaming
            sessionStreamingState.delete(reconnectSessionId);
            api.getMessages(reconnectSessionId).then((messages) => {
              const mapped = mapMessages(messages);
              // Mark any streaming messages as finalized
              const finalized = mapped.map((m) =>
                m.isStreaming ? { ...m, isStreaming: false } : m,
              );
              sessionMessagesCache.set(reconnectSessionId, finalized);
            }).catch(() => {});
            return;
          }

          // Clear the running task from sessionStorage
          try {
            sessionStorage.removeItem(`deepanalyze-running-task-${reconnectSessionId}`);
          } catch { /* ignore */ }

          const state = get();
          let finalContent = state.streamingContent;

          if (!finalContent && (data as { output?: string }).output) {
            finalContent = (data as { output?: string }).output!;
          }

          const finalToolCalls = state.streamingToolCalls.map((tc) => ({
            ...tc,
            status: tc.status === "running" ? "completed" as const : tc.status,
          }));

          state.finishStreaming(finalContent, finalToolCalls);

          // Reload messages from server to get the final persisted version
          api.getMessages(reconnectSessionId).then((messages) => {
            const mapped = mapMessages(messages);
            sessionMessagesCache.set(reconnectSessionId, mapped);
            if (get().currentSessionId === reconnectSessionId) {
              set({ messages: mapped });
            }
          }).catch(() => {});

          api.getAgentTasks(reconnectSessionId).then((tasks) => {
            if (get().currentSessionId === reconnectSessionId) {
              set({ agentTasks: tasks });
            }
          }).catch(() => {});

          set({ isSending: false });

          // Auto-complete remaining todos when agent finishes
          const remainingTodos3 = get().todos;
          if (remainingTodos3.some(t => t.status !== "completed")) {
            set({ todos: remainingTodos3.map(t => ({ ...t, status: "completed" as const })) });
          }

          if (data.status === "failed") {
            set({ error: (data as { output?: string }).output ?? "Agent run failed" });
          }
        },
        onReconnectDone: () => {
          // Task was already completed — reload final messages
          try {
            sessionStorage.removeItem(`deepanalyze-running-task-${reconnectSessionId}`);
          } catch { /* ignore */ }

          // Clean up SSE connection tracking
          if (sseConn) removeSSEConnection(reconnectSessionId, sseConn);
          sessionStreamingState.delete(reconnectSessionId);

          // If user has switched sessions, clean up internal state but don't update UI
          const isCurrentSession = get().currentSessionId === reconnectSessionId;
          if (!isCurrentSession) {
            api.getMessages(reconnectSessionId).then((messages) => {
              const mapped = mapMessages(messages);
              // Mark any streaming messages as finalized
              const finalized = mapped.map((m) =>
                m.isStreaming ? { ...m, isStreaming: false } : m,
              );
              sessionMessagesCache.set(reconnectSessionId, finalized);
            }).catch(() => {});
            return;
          }

          const state = get();
          const finalContent = state.streamingContent;
          const finalToolCalls = state.streamingToolCalls.map((tc) => ({
            ...tc,
            status: tc.status === "running" ? "completed" as const : tc.status,
          }));
          state.finishStreaming(finalContent, finalToolCalls);

          api.getMessages(reconnectSessionId).then((messages) => {
            const mapped = mapMessages(messages);
            sessionMessagesCache.set(reconnectSessionId, mapped);
            if (get().currentSessionId === reconnectSessionId) {
              set({ messages: mapped, isSending: false });
            }
          }).catch(() => {});
          api.getAgentTasks(reconnectSessionId).then((tasks) => {
            if (get().currentSessionId === reconnectSessionId) {
              set({ agentTasks: tasks });
            }
          }).catch(() => {});
        },
        onWorkflowEvent: (event) => {
          // Reset watchdog timer — workflow events indicate the agent is still active
          markSendingStart();
          const wfStore = useWorkflowStore.getState();
          const etype = event.type as string;
          switch (etype) {
            case "workflow_start":
              wfStore.handleWorkflowStart(event as any);
              wsSubscribeWorkflow([event.workflowId as string]);
              break;
            case "workflow_agent_start":
              wfStore.handleAgentStart(event as any);
              break;
            case "workflow_agent_tool_call":
              wfStore.handleAgentToolCall({
                workflowId: event.workflowId as string,
                agentId: event.agentId as string,
                toolName: (event.toolName ?? event.tool ?? "") as string,
                input: ((event.input ?? event.args ?? {}) as Record<string, unknown>),
              });
              break;
            case "workflow_agent_tool_result":
              wfStore.handleAgentToolResult({
                workflowId: event.workflowId as string,
                agentId: event.agentId as string,
                toolName: (event.toolName ?? event.tool ?? "") as string,
                output: (event.output ?? event.result ?? "") as string,
              });
              break;
            case "workflow_agent_chunk":
              wfStore.handleAgentChunk({
                workflowId: event.workflowId as string,
                agentId: event.agentId as string,
                content: (event.content ?? event.chunk ?? "") as string,
              });
              break;
            case "workflow_agent_complete":
              wfStore.handleAgentComplete({
                workflowId: event.workflowId as string,
                agentId: event.agentId as string,
                duration: (event.duration ?? 0) as number,
                ...(event.status === "error" || event.status === "failed" ? { error: String(event.status) } : {}),
              });
              break;
            case "workflow_complete":
              wfStore.handleWorkflowComplete({
                workflowId: event.workflowId as string,
                status: event.status as string,
                duration: (event.totalDuration ?? event.duration ?? 0) as number,
              });
              wsUnsubscribeWorkflow([event.workflowId as string]);
              break;
          }
        },
      });

      // Track SSE connection for this session
      sseConn = addSSEConnection(reconnectSessionId, { abort, taskId });

      await promise;
    } catch (err) {
      // Reconnect stream ended (e.g., buffer expired after server restart)
      console.warn("[ChatStore] Reconnect stream ended:", err);
      // Clean up SSE connection tracking
      if (sseConn) removeSSEConnection(reconnectSessionId, sseConn);
      // Finalize with whatever content we have
      const state = get();
      if (state.isStreaming) {
        state.finishStreaming(state.streamingContent, state.streamingToolCalls);
      }
      set({ isSending: false });
      // Reload final messages from server
      api.getMessages(reconnectSessionId).then((messages) => {
        if (get().currentSessionId === reconnectSessionId) {
          set({ messages: mapMessages(messages) });
        }
      }).catch(() => {});
    }
  },

  // Inject a follow-up message into a currently running agent
  injectMessage: async (content: string) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;

    const conn = getLatestSSEConnection(currentSessionId);
    if (!conn?.taskId) return;

    // Optimistically show user message in UI
    const userMessage: MessageInfo = {
      id: `inject-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({
      messages: [...s.messages, userMessage],
    }));

    try {
      await api.injectMessage(conn.taskId, content);
    } catch (err) {
      console.error("[ChatStore] Failed to inject message:", err);
    }
  },
  };
});

// ---------------------------------------------------------------------------
// Workflow WebSocket event dispatching is handled in useWebSocket.ts
// which automatically routes workflow_* events to the workflow store.
