// =============================================================================
// DeepAnalyze - API Client
// =============================================================================

import type {
  SessionInfo,
  MessageInfo,
  AgentTaskInfo,
  RunAgentResponse,
  RunCoordinatedResponse,
  ProviderConfig,
  ProviderDefaults,
  ProviderSettings,
  ProviderTestResult,
  ReportInfo,
  ReportDetail,
  TimelineEvent,
  GraphNode,
  GraphEdge,
  PluginInfo,
  AgentSkillInfo,
  KnowledgeBase,
  DocumentInfo,
  WikiPage,
  AgentSettings,
  CronJob,
  CreateCronJobRequest,
  UpdateCronJobRequest,
  CronValidateResult,
  ChannelInfo,
  ChannelId,
  ChannelTestResult,
  ChannelsConfig,
  ChannelStatus,
  AnalysisScope,
  DoclingConfig,
  DoclingModels,
  VlmContainerInfo,
  MCPServerConfig,
  MCPServerStatus,
  PushedContentGroup,
} from "../types/index.js";

const BASE_URL = "";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  };
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  // Inject auth token for local/hub mode
  const token = localStorage.getItem("da_access_token");
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  // credentials:"include" 让 hub 模式下的 da_session cookie 自动随请求带上
  //（local 模式不会因此受影响，因为没有 cookie 就不会带）。
  const r = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  if (r.status === 204) return undefined as T;
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`API error: ${r.status} ${text}`.trim());
  }
  return r.json();
}

// =============================================================================
// Module management types (Unified Module Deployment)
// =============================================================================

export interface ModuleState {
  moduleId: string;
  status: 'not_installed' | 'installing' | 'installed' | 'running' | 'error';
  mode: 'local' | 'remote' | 'disabled';
  weightsPath?: string | null;
  weightsSizeMb?: number | null;
  gpuRequired: boolean;
  processType: 'subprocess' | 'docker';
  remoteEndpoint?: string | null;
  remoteApiKey?: string | null;
  remoteProtocol?: string | null;
  vlmBackend?: string | null;
  lastError?: string | null;
  installedAt?: string | null;
  startedAt?: string | null;
  configVersion: number;
}

export interface GpuInfo {
  tier: 'none' | 'low' | 'high';
  hasNvidia: boolean;
  vramMB: number;
  deviceName?: string;
  cudaVersion?: string;
}

// =============================================================================
// API Methods
// =============================================================================

export const api = {
  // --- Sessions ---
  listSessions: () => request<SessionInfo[]>("/api/sessions"),
  createSession: (title?: string) =>
    request<SessionInfo>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  getSession: (id: string) => request<SessionInfo>(`/api/sessions/${id}`),
  deleteSession: (id: string) =>
    request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  updateSessionScope: (id: string, kbScope: Record<string, unknown>) =>
    request<void>(`/api/sessions/${id}/scope`, {
      method: "PATCH",
      body: JSON.stringify({ kbScope }),
    }),
  renameSession: (id: string, title: string) =>
    request<void>(`/api/sessions/${id}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  getSessionTranscript: (id: string) =>
    request<import("../types/index.js").SessionTranscript>(`/api/sessions/${id}/transcript`),
  getTaskTranscript: (sessionId: string, taskId: string) =>
    request<import("../types/index.js").TranscriptEntry[]>(`/api/sessions/${sessionId}/transcript/${taskId}`),

  // --- Chat ---
  sendMessage: (sessionId: string, content: string) =>
    request<{ messageId: string; status: string }>("/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ sessionId, content }),
    }),
  getMessages: (sessionId: string) =>
    request<MessageInfo[]>(`/api/sessions/${sessionId}/messages`),

  listSessionWorkflows: (sessionId: string) =>
    request<{ sessionId: string; workflows: Array<{ workflowId: string; sessionId?: string; parentTaskId?: string; goal: string; teamName?: string; mode?: string; agentCount?: number; status: string; startTime: number; endTime?: number; durationMs: number; error?: string }> }>(
      `/api/sessions/${sessionId}/workflows`,
    ),

  // --- Agent ---
  runAgent: (sessionId: string, input: string, agentType?: string) =>
    request<RunAgentResponse>("/api/agents/run", {
      method: "POST",
      body: JSON.stringify({ sessionId, input, agentType }),
    }),
  runAgentStream: (
    sessionId: string,
    input: string,
    agentType?: string,
    callbacks?: {
      onStart?: (taskId: string, agentType: string) => void;
      onContent?: (content: string, accumulated: string, taskId: string) => void;
      onContentDelta?: (delta: string, taskId: string, turn: number) => void;
      onContentReset?: (taskId: string, turn: number, reason: string) => void;
      onThinkingDelta?: (delta: string, taskId: string) => void;
      onToolCall?: (tc: { id: string; toolName: string; input: Record<string, unknown>; status: string }, taskId: string) => void;
      onToolResult?: (data: { id: string; toolName: string; output: string }, taskId: string) => void;
      onProgress?: (progress: { turn: number; type: string; content: string }, taskId: string) => void;
      onComplete?: (data: { taskId: string; output: string; toolCalls: unknown[] }) => void;
      onError?: (data: { taskId: string; error: string }) => void;
      onDone?: (data: { taskId: string; status: string; turnsUsed?: number }) => void;
      onAdvisoryLimit?: (data: { taskId: string; turn: number }) => void;
      onCompaction?: (data: { taskId: string; turn: number; method: string; tokensSaved: number }) => void;
      onPushContent?: (data: { type: string; title: string; data?: string; format?: string; timestamp?: string; fileName?: string; fileSize?: number; mimeType?: string; downloadUrl?: string }, taskId: string) => void;
      onTodoUpdate?: (data: Record<string, unknown>, taskId: string) => void;
      onWorkflowComplete?: (data: { status: string; goal: string; totalAgents: number; results: unknown }, taskId: string) => void;
      onWorkflowEvent?: (event: Record<string, unknown>, taskId: string) => void;
      onAskUser?: (data: { question: string; options: string[]; taskId: string }) => void;
      onAskUserAnswered?: (data: { taskId: string; answer: string }) => void;
      onTurnUsage?: (usage: { inputTokens: number; outputTokens: number; cachedTokens?: number }, taskId: string, turn: number) => void;
    },
    scope?: AnalysisScope,
    mediaIds?: string[],
  ) => {
    const controller = new AbortController();
    const fetchPromise = fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input, agentType, scope, mediaIds }),
      signal: controller.signal,
    }).then(async (resp) => {
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`API error: ${resp.status} ${text}`);
      }
      if (!resp.body) throw new Error("No response body for stream");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      let currentEvent = "";
      let currentData = "";
      // Track current taskId from 'start' event for callbacks that don't carry it
      let currentTaskId = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          // Strip \r to handle both \n and \r\n line endings
          const line = rawLine.replace(/\r$/, "");

          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" && currentEvent && currentData) {
            // Empty line = end of event
            try {
              const data = JSON.parse(currentData);
              switch (currentEvent) {
                case "start":
                  currentTaskId = data.taskId;
                  callbacks?.onStart?.(data.taskId, data.agentType);
                  break;
                case "content_delta":
                  callbacks?.onContentDelta?.(data.delta, data.taskId, data.turn);
                  break;
                case "content_reset":
                  callbacks?.onContentReset?.(data.taskId, data.turn, data.reason);
                  break;
                case "thinking_delta":
                  callbacks?.onThinkingDelta?.(data.delta, data.taskId);
                  break;
                case "content":
                  callbacks?.onContent?.(data.content, data.accumulated, currentTaskId);
                  break;
                case "tool_call":
                  callbacks?.onToolCall?.(data, currentTaskId);
                  break;
                case "tool_result":
                  callbacks?.onToolResult?.(data, currentTaskId);
                  break;
                case "progress":
                  callbacks?.onProgress?.(data, currentTaskId);
                  break;
                case "complete":
                  callbacks?.onComplete?.(data);
                  break;
                case "error":
                  callbacks?.onError?.(data);
                  break;
                case "done":
                  callbacks?.onDone?.(data);
                  break;
                case "advisory_limit_reached":
                  callbacks?.onAdvisoryLimit?.(data);
                  break;
                case "compaction":
                  callbacks?.onCompaction?.(data);
                  break;
                case "turn_usage":
                  callbacks?.onTurnUsage?.(data.usage, data.taskId, data.turn);
                  break;
                case "push_content":
                  callbacks?.onPushContent?.(data, currentTaskId);
                  break;
                case "todo_update":
                  callbacks?.onTodoUpdate?.(data, currentTaskId);
                  break;
                case "workflow_complete":
                  callbacks?.onWorkflowComplete?.(data, currentTaskId);
                  break;
                case "workflow_event":
                  callbacks?.onWorkflowEvent?.(data, currentTaskId);
                  break;
                case "ask_user":
                  callbacks?.onAskUser?.(data);
                  break;
                case "ask_user_answered":
                  callbacks?.onAskUserAnswered?.(data);
                  break;
              }
            } catch {
              // Ignore parse errors for individual events
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    });

    return { abort: () => controller.abort(), promise: fetchPromise };
  },
  runCoordinated: (sessionId: string, input: string) =>
    request<RunCoordinatedResponse>("/api/agents/run-coordinated", {
      method: "POST",
      body: JSON.stringify({ sessionId, input }),
    }),
  reconnectAgentStream: (
    taskId: string,
    callbacks?: {
      onStart?: (taskId: string, agentType: string) => void;
      onContent?: (content: string, accumulated: string, taskId: string) => void;
      onContentDelta?: (delta: string, taskId: string, turn: number) => void;
      onContentReset?: (taskId: string, turn: number, reason: string) => void;
      onThinkingDelta?: (delta: string, taskId: string) => void;
      onToolCall?: (tc: { id: string; toolName: string; input: Record<string, unknown>; status: string }, taskId: string) => void;
      onToolResult?: (data: { id: string; toolName: string; output: string }, taskId: string) => void;
      onProgress?: (progress: { turn: number; type: string; content: string }, taskId: string) => void;
      onComplete?: (data: { taskId: string; output: string; toolCalls: unknown[] }) => void;
      onError?: (data: { taskId: string; error: string }) => void;
      onDone?: (data: { taskId: string; status: string; turnsUsed?: number }) => void;
      onAdvisoryLimit?: (data: { taskId: string; turn: number }) => void;
      onCompaction?: (data: { taskId: string; turn: number; method: string; tokensSaved: number }) => void;
      onPushContent?: (data: { type: string; title: string; data?: string; format?: string; timestamp?: string; fileName?: string; fileSize?: number; mimeType?: string; downloadUrl?: string }, taskId: string) => void;
      onTodoUpdate?: (data: Record<string, unknown>, taskId: string) => void;
      onWorkflowComplete?: (data: { status: string; goal: string; totalAgents: number; results: unknown }, taskId: string) => void;
      onWorkflowEvent?: (event: Record<string, unknown>, taskId: string) => void;
      onAskUser?: (data: { question: string; options: string[]; taskId: string }) => void;
      onAskUserAnswered?: (data: { taskId: string; answer: string }) => void;
      onTurnUsage?: (usage: { inputTokens: number; outputTokens: number; cachedTokens?: number }, taskId: string, turn: number) => void;
      onReconnectDone?: () => void;
    },
  ) => {
    const controller = new AbortController();
    const fetchPromise = fetch(`${BASE_URL}/api/agents/stream/${taskId}`, {
      method: "GET",
      signal: controller.signal,
    }).then(async (resp) => {
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Reconnect failed: ${resp.status} ${text}`);
      }
      if (!resp.body) throw new Error("No response body for reconnect stream");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData = "";
      // For reconnect, taskId is already known from the parameter
      let currentTaskId = taskId;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, "");

          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData);
              switch (currentEvent) {
                case "start":
                  currentTaskId = data.taskId;
                  callbacks?.onStart?.(data.taskId, data.agentType);
                  break;
                case "content_delta":
                  callbacks?.onContentDelta?.(data.delta, data.taskId, data.turn);
                  break;
                case "content_reset":
                  callbacks?.onContentReset?.(data.taskId, data.turn, data.reason);
                  break;
                case "thinking_delta":
                  callbacks?.onThinkingDelta?.(data.delta, data.taskId);
                  break;
                case "content":
                  callbacks?.onContent?.(data.content, data.accumulated, currentTaskId);
                  break;
                case "tool_call":
                  callbacks?.onToolCall?.(data, currentTaskId);
                  break;
                case "tool_result":
                  callbacks?.onToolResult?.(data, currentTaskId);
                  break;
                case "progress":
                  callbacks?.onProgress?.(data, currentTaskId);
                  break;
                case "complete":
                  callbacks?.onComplete?.(data);
                  break;
                case "error":
                  callbacks?.onError?.(data);
                  break;
                case "done":
                  callbacks?.onDone?.(data);
                  break;
                case "advisory_limit_reached":
                  callbacks?.onAdvisoryLimit?.(data);
                  break;
                case "compaction":
                  callbacks?.onCompaction?.(data);
                  break;
                case "turn_usage":
                  callbacks?.onTurnUsage?.(data.usage, data.taskId, data.turn);
                  break;
                case "push_content":
                  callbacks?.onPushContent?.(data, currentTaskId);
                  break;
                case "todo_update":
                  callbacks?.onTodoUpdate?.(data, currentTaskId);
                  break;
                case "workflow_complete":
                  callbacks?.onWorkflowComplete?.(data, currentTaskId);
                  break;
                case "workflow_event":
                  callbacks?.onWorkflowEvent?.(data, currentTaskId);
                  break;
                case "ask_user":
                  callbacks?.onAskUser?.(data);
                  break;
                case "ask_user_answered":
                  callbacks?.onAskUserAnswered?.(data);
                  break;
                case "reconnect_done":
                  callbacks?.onReconnectDone?.();
                  break;
              }
            } catch {
              // Ignore parse errors
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    });

    return { abort: () => controller.abort(), promise: fetchPromise };
  },
  getAgentTasks: (sessionId: string) =>
    request<AgentTaskInfo[]>(`/api/agents/tasks/${sessionId}`),
  getAgentTask: (taskId: string) =>
    request<AgentTaskInfo>(`/api/agents/task/${taskId}`),
  cancelAgentTask: (taskId: string) =>
    request<{ taskId: string; status: string }>(`/api/agents/cancel/${taskId}`, {
      method: "POST",
    }),
  injectMessage: (taskId: string, message: string) =>
    request<{ taskId: string; status: string; queueLength: number }>(`/api/agents/inject/${taskId}`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  answerAskUser: (taskId: string, answer: string) =>
    request<{ taskId: string; status: string }>(`/api/agents/message/${taskId}`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    }),

  // --- Knowledge Base ---
  listKnowledgeBases: () =>
    request<{ knowledgeBases: KnowledgeBase[] }>("/api/knowledge/kbs").then(
      (res) => Array.isArray(res.knowledgeBases) ? res.knowledgeBases : [],
    ),
  createKnowledgeBase: (name: string, description?: string) =>
    request<KnowledgeBase>("/api/knowledge/kbs", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),
  deleteKnowledgeBase: (id: string) =>
    request<void>(`/api/knowledge/kbs/${id}`, { method: "DELETE" }),
  updateKnowledgeBase: (id: string, data: { name?: string; description?: string }) =>
    request<KnowledgeBase>(`/api/knowledge/kbs/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  triggerProcessing: (kbId: string) =>
    request<{ enqueued: number }>(`/api/knowledge/kbs/${kbId}/trigger-processing`, { method: "POST" }),

  startPreprocessing: (kbId: string) =>
    request<{ message: string; sessionId: string; kbId: string }>(
      `/api/knowledge/kbs/${kbId}/preprocess`,
      { method: "POST" },
    ),

  getPreprocessStatus: (kbId: string) =>
    request<{ running: boolean; sessionId?: string; startedAt?: string; lastPreprocessedAt?: string }>(
      `/api/knowledge/kbs/${kbId}/preprocess/status`,
    ),

  cancelPreprocessing: (kbId: string) =>
    request<{ cancelled: boolean; message: string }>(
      `/api/knowledge/kbs/${kbId}/preprocess/cancel`,
      { method: "POST" },
    ),

  // --- Documents ---
  listDocuments: (kbId: string) =>
    request<{ documents: any[] }>(`/api/knowledge/kbs/${kbId}/documents`).then(
      (res) => (Array.isArray(res.documents) ? res.documents : []).map((d: any): DocumentInfo => ({
        id: d.id,
        kbId: d.kb_id ?? d.kbId,
        filename: d.filename,
        folderPath: d.folder_path ?? d.folderPath ?? "",
        fileType: d.file_type ?? d.fileType,
        fileSize: d.file_size ?? d.fileSize,
        status: d.status,
        createdAt: d.created_at ?? d.createdAt,
        l1Preview: d.l1Preview ?? null,
      })),
    ),
  uploadDocument: (kbId: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return fetch(`${BASE_URL}/api/knowledge/kbs/${kbId}/upload`, {
      method: "POST",
      body: formData,
    }).then((r) => {
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
      return r.json() as Promise<{ documentId: string; status: string }>;
    });
  },
  deleteDocument: (kbId: string, docId: string) =>
    request<void>(`/api/knowledge/kbs/${kbId}/documents/${docId}`, {
      method: "DELETE",
    }),

  // --- Media file serving ---

  /** Get the URL for a document's original file (supports Range requests for audio/video). */
  getOriginalFileUrl(kbId: string, docId: string): string {
    return `/api/knowledge/kbs/${kbId}/documents/${docId}/original`;
  },

  /** Get the URL for a document's image thumbnail. */
  getThumbnailUrl(kbId: string, docId: string): string {
    return `/api/knowledge/kbs/${kbId}/documents/${docId}/thumbnail`;
  },

  /** Get the URL for a video document's frame thumbnail by index. */
  getFrameUrl(kbId: string, docId: string, index: number): string {
    return `/api/knowledge/kbs/${kbId}/documents/${docId}/frames/${index}`;
  },

  /** Reprocess a document with a specific processor channel */
  reprocessDocument: (kbId: string, docId: string, processor?: string) =>
    request<{ documentId: string; status: string; message: string }>(
      `/api/knowledge/kbs/${kbId}/process/${docId}?force=true`,
      {
        method: "POST",
        body: JSON.stringify({ processor }),
      },
    ),

  /** Get media metadata for a document (audio/video/image) */
  getMediaMetadata: (kbId: string, docId: string) =>
    request<{
      type: "image" | "audio" | "video" | null;
      image?: { width: number; height: number; description?: string; exif?: Record<string, string> };
      audio?: { duration: number; speakers: string[]; turns: Array<{ speaker: string; text: string; start?: number; end?: number }> };
      video?: { duration: number; scenes: Array<{ start: number; end: number; description?: string }>; transcript: { speakers: string[]; turns: Array<{ speaker: string; text: string; start?: number; end?: number }> }; frameCount: number };
    }>(`/api/knowledge/kbs/${kbId}/documents/${docId}/media-metadata`),

  // --- Wiki ---
  searchWiki: (kbId: string, query: string, mode?: string, topK?: number) => {
    const params = new URLSearchParams();
    params.set("query", query);
    if (mode) params.set("mode", mode);
    if (topK) params.set("topK", String(topK));
    return request<{
      results: Array<{
        docId: string;
        level: string;
        title?: string;
        content: string;
        score: number;
        metadata: Record<string, unknown>;
      }>;
      totalFound: number;
    }>(`/api/knowledge/${kbId}/search?${params}`);
  },
  browseWiki: (kbId: string, path: string) =>
    request<WikiPage>(`/api/knowledge/${kbId}/wiki/${encodeURIComponent(path)}`),
  regenerateAbstract: (kbId: string, docId: string) =>
    request<{ documentId: string; status: string; message?: string }>(
      `/api/knowledge/kbs/${kbId}/documents/${docId}/regenerate-abstract`,
      { method: "POST" },
    ),
  expandWiki: (kbId: string, docId: string, level: string, format?: string, section?: string) =>
    request<{ content: string; level: string; expandable: boolean; source?: string }>(
      `/api/knowledge/${kbId}/expand`,
      {
        method: "POST",
        body: JSON.stringify({ docId, level, format, section }),
      },
    ),

  // --- Entities ---
  getEntities: (kbId: string) =>
    request<Array<{ name: string; type: string; mentions: number; docCount: number }>>(
      `/api/knowledge/kbs/${kbId}/entities`,
    ),

  // --- Reports ---
  listAllReports: (limit?: number, offset?: number) =>
    request<{ reports: ReportInfo[]; pagination: { limit: number; offset: number; count: number } }>(
      `/api/reports/reports?limit=${limit ?? 50}&offset=${offset ?? 0}`,
    ),
  listReports: (kbId: string) =>
    request<{ kbId: string; reports: ReportInfo[] }>(
      `/api/reports/reports/kb/${kbId}`,
    ),
  getReport: (reportId: string) =>
    request<ReportDetail>(`/api/reports/report/${reportId}`),
  getPushedByKb: (kbId?: string) =>
    request<{ groups: PushedContentGroup[] }>(
      `/api/reports/pushed-by-kb${kbId ? `?kbId=${encodeURIComponent(kbId)}` : ""}`,
    ),
  getTimeline: (kbId: string, query?: string, maxEvents?: number) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (maxEvents) params.set("maxEvents", String(maxEvents));
    const qs = params.toString();
    return request<{ events: TimelineEvent[]; totalCount: number }>(
      `/api/reports/timeline/${kbId}${qs ? `?${qs}` : ""}`,
    );
  },
  getGraph: (kbId: string, query?: string, maxNodes?: number) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (maxNodes) params.set("maxNodes", String(maxNodes));
    const qs = params.toString();
    return request<{
      nodes: GraphNode[];
      edges: GraphEdge[];
      stats: { nodeCount: number; edgeCount: number };
    }>(`/api/reports/graph/${kbId}${qs ? `?${qs}` : ""}`);
  },

  // --- Plugins ---
  listPlugins: () =>
    request<{ plugins: PluginInfo[] }>("/api/plugins/plugins").then(
      (res) => Array.isArray(res.plugins) ? res.plugins : [],
    ),
  getPlugin: (id: string) =>
    request<PluginInfo>(`/api/plugins/plugins/${id}`),
  enablePlugin: (id: string) =>
    request<{ pluginId: string; enabled: boolean }>(
      `/api/plugins/plugins/${id}/enable`,
      { method: "POST" },
    ),
  disablePlugin: (id: string) =>
    request<{ pluginId: string; enabled: boolean }>(
      `/api/plugins/plugins/${id}/disable`,
      { method: "POST" },
    ),
  deletePlugin: (id: string) =>
    request<{ pluginId: string; deleted: boolean }>(
      `/api/plugins/plugins/${id}`,
      { method: "DELETE" },
    ),

  // --- Agent Skills (agent_skills table) ---
  listAgentSkills: () =>
    request<AgentSkillInfo[]>("/api/agent-skills").then((res) =>
      Array.isArray(res) ? res : [],
    ),
  getAgentSkill: (id: string) =>
    request<AgentSkillInfo>(`/api/agent-skills/${id}`),
  createAgentSkill: (skill: {
    name: string;
    description?: string;
    prompt: string;
    tools?: string[];
    modelRole?: string;
    isActive?: boolean;
  }) =>
    request<AgentSkillInfo>("/api/agent-skills", {
      method: "POST",
      body: JSON.stringify(skill),
    }),
  updateAgentSkill: (id: string, data: {
    name?: string;
    description?: string;
    prompt?: string;
    tools?: string[];
    modelRole?: string;
    isActive?: boolean;
  }) =>
    request<AgentSkillInfo>(`/api/agent-skills/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAgentSkill: (id: string) =>
    request<{ success: boolean }>(`/api/agent-skills/${id}`, {
      method: "DELETE",
    }),
  runAgentSkill: (
    sessionId: string,
    skillId: string,
    input?: string,
    kbId?: string,
  ) =>
    request<{ taskId: string; output: string; skillName: string }>(
      "/api/agents/run-skill",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          skillId,
          variables: {},
          input,
          kbId,
          useAgentSkills: true,
        }),
      },
    ),

  // --- Settings / Providers ---
  getProviderRegistry: () =>
    request<import("../types/index.js").ProviderMetadata[]>(
      "/api/settings/registry",
    ),
  getProviders: () =>
    request<ProviderSettings>("/api/settings/providers"),
  getProvider: (id: string) =>
    request<ProviderConfig>(`/api/settings/providers/${id}`),
  saveProvider: (provider: ProviderConfig) =>
    request<{ success: boolean; provider: ProviderConfig }>(
      `/api/settings/providers/${provider.id}`,
      {
        method: "PUT",
        body: JSON.stringify(provider),
      },
    ),
  deleteProvider: (id: string) =>
    request<{ success: boolean }>(`/api/settings/providers/${id}`, {
      method: "DELETE",
    }),
  testProvider: (id: string) =>
    request<ProviderTestResult>(`/api/settings/providers/${id}/test`, {
      method: "POST",
    }),
  getDefaults: () =>
    request<ProviderDefaults>("/api/settings/defaults"),
  saveDefaults: (defaults: Partial<ProviderDefaults>) =>
    request<{ success: boolean; defaults: ProviderDefaults }>(
      "/api/settings/defaults",
      {
        method: "PUT",
        body: JSON.stringify(defaults),
      },
    ),

  // --- Agent Settings ---
  getAgentSettings: () =>
    request<AgentSettings>("/api/settings/agent"),
  saveAgentSettings: (settings: Partial<AgentSettings>) =>
    request<{ success: boolean; settings: AgentSettings }>("/api/settings/agent", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

  // --- Key-Value Settings ---
  getSetting: (key: string) =>
    request<{ key: string; value: string }>(`/api/settings/key/${key}`),
  setSetting: (key: string, value: string) =>
    request<{ key: string; value: string }>(`/api/settings/key/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),

  // --- Enhanced Models ---
  getEnhancedModels: () =>
    request<import("../types/index.js").EnhancedModelEntry[]>("/api/settings/enhanced-models"),
  saveEnhancedModels: (models: import("../types/index.js").EnhancedModelEntry[]) =>
    request<{ success: boolean; count: number }>("/api/settings/enhanced-models", {
      method: "PUT",
      body: JSON.stringify(models),
    }),

  // --- Docling Config ---
  getDoclingConfig: () =>
    request<DoclingConfig>("/api/settings/docling-config"),
  saveDoclingConfig: (config: Partial<DoclingConfig>) =>
    request<{ success: boolean; config: DoclingConfig }>("/api/settings/docling-config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  getDoclingModels: () =>
    request<DoclingModels>("/api/settings/docling-models"),

  // --- VLM Container Management ---
  getVlmContainerStatus: () =>
    request<VlmContainerInfo>("/api/settings/vlm-container-status"),
  startVlmContainer: () =>
    request<VlmContainerInfo>("/api/settings/vlm-container-start", { method: "POST" }),
  stopVlmContainer: () =>
    request<VlmContainerInfo>("/api/settings/vlm-container-stop", { method: "POST" }),

  // --- MinerU Configuration ---
  getMinerUConfig: () =>
    request<Record<string, unknown>>("/api/settings/mineru-config"),
  saveMinerUConfig: (config: Record<string, unknown>) =>
    request<{ success: boolean }>("/api/settings/mineru-config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  checkMinerUStatus: () =>
    request<{ connected: boolean; enabled?: boolean; version?: string }>("/api/settings/mineru-status"),
  getPipelineStrategies: () =>
    request<Record<string, unknown>[]>("/api/settings/pipeline-strategies"),
  savePipelineStrategies: (strategies: Record<string, unknown>[]) =>
    request<{ success: boolean }>("/api/settings/pipeline-strategies", {
      method: "PUT",
      body: JSON.stringify(strategies),
    }),

  // --- Cron Jobs ---
  listCronJobs: () =>
    request<CronJob[]>("/api/cron/jobs"),
  getCronJob: (id: string) =>
    request<CronJob>(`/api/cron/jobs/${id}`),
  createCronJob: (data: CreateCronJobRequest) =>
    request<CronJob>("/api/cron/jobs", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateCronJob: (id: string, data: UpdateCronJobRequest) =>
    request<CronJob>(`/api/cron/jobs/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteCronJob: (id: string) =>
    request<{ success: boolean }>(`/api/cron/jobs/${id}`, { method: "DELETE" }),
  runCronJob: (id: string) =>
    request<{ success: boolean; message: string }>(`/api/cron/jobs/${id}/run`, {
      method: "POST",
    }),
  validateCron: (schedule: string) =>
    request<CronValidateResult>("/api/cron/validate", {
      method: "POST",
      body: JSON.stringify({ schedule }),
    }),

  // --- MCP Servers ---
  listMCPServers: () =>
    request<MCPServerConfig[]>("/api/mcp"),
  addMCPServer: (server: MCPServerConfig) =>
    request<MCPServerConfig>("/api/mcp", {
      method: "POST",
      body: JSON.stringify(server),
    }),
  deleteMCPServer: (id: string) =>
    request<{ success: boolean }>(`/api/mcp/${id}`, { method: "DELETE" }),
  connectMCPServer: (id: string) =>
    request<{ success: boolean; status?: MCPServerStatus }>(`/api/mcp/connect/${id}`, { method: "POST" }),
  getMCPStatus: () =>
    request<MCPServerStatus[]>("/api/mcp/status"),

  // --- Channels ---
  listChannels: () =>
    request<{ channels: ChannelInfo[] }>("/api/channels/list").then(
      (res) => Array.isArray(res.channels) ? res.channels : [],
    ),
  getChannelConfigs: () =>
    request<{ configs: ChannelsConfig }>("/api/channels/configs").then(
      (res) => res.configs,
    ),
  getChannelConfig: (id: ChannelId) =>
    request<{ config: Record<string, unknown> }>(`/api/channels/${id}/config`).then(
      (res) => res.config,
    ),
  updateChannel: (id: ChannelId, config: Record<string, unknown>) =>
    request<{ success: boolean; config: Record<string, unknown> }>("/api/channels/update", {
      method: "POST",
      body: JSON.stringify({ id, config }),
    }),
  testChannel: (id: ChannelId, config?: Record<string, unknown>) =>
    request<ChannelTestResult>("/api/channels/test", {
      method: "POST",
      body: JSON.stringify({ id, config }),
    }),
  startChannel: (id: ChannelId) =>
    request<{ success: boolean; message: string }>(`/api/channels/${id}/start`, {
      method: "POST",
    }),
  stopChannel: (id: ChannelId) =>
    request<{ success: boolean; message: string }>(`/api/channels/${id}/stop`, {
      method: "POST",
    }),
  getChannelsStatus: () =>
    request<{ status: Record<string, ChannelStatus> }>("/api/channels/status").then(
      (res) => res.status,
    ),

  // --- Health ---
  health: () => request<{
    status: string;
    version: string;
    embedding?: {
      status: string;
      provider?: string | null;
      dimension?: number | null;
      degraded?: boolean;
      cooldownRemainingMs?: number;
      /** Whether the active embedding provider has an API key (or is local/hash). */
      mainProviderHasKey?: boolean;
    };
    llm?: {
      status: string;
      providerCount?: number;
      providers?: string[];
      /** Per-provider API key presence (false = key missing and endpoint is not local). */
      providersWithKey?: Array<{ id: string; hasKey: boolean }>;
      mainModel?: string | null;
      /** Whether the main-model provider has an API key (or runs on a local endpoint). */
      mainModelHasKey?: boolean;
      error?: string;
    };
  }>("/api/health"),

  // --- Evolution ---
  getEvolutionConfig: () =>
    request<{
      enabled: boolean;
      modules: { persistentMemory: boolean; memoryAccumulation: boolean; skillEvolution: boolean; skillMaintenance: boolean; historyRecall: boolean; autoDream: boolean };
      params: { nudgeInterval: number; curatorIntervalDays: number; archiveAfterDays: number; staleAfterDays: number };
    }>("/api/settings/evolution"),
  saveEvolutionConfig: (config: {
    enabled?: boolean;
    modules?: { persistentMemory?: boolean; memoryAccumulation?: boolean; skillEvolution?: boolean; skillMaintenance?: boolean; historyRecall?: boolean; autoDream?: boolean };
    params?: { nudgeInterval?: number; curatorIntervalDays?: number; archiveAfterDays?: number; staleAfterDays?: number };
  }) =>
    request<{ success: boolean; config: Record<string, unknown> }>("/api/settings/evolution", {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  getEvolutionMemories: () =>
    request<{ memories: Array<{ id: string; category: string; content: string; source: string; relevance: number; use_count: number; created_at: string }>; count: number }>("/api/settings/evolution/memories"),
  deleteEvolutionMemory: (id: string) =>
    request<{ success: boolean }>(`/api/settings/evolution/memories/${id}`, { method: "DELETE" }),
  clearEvolutionMemories: () =>
    request<{ success: boolean; deleted: number }>("/api/settings/evolution/memories", { method: "DELETE" }),
  getEvolutionStats: () =>
    request<{
      memoryCount: number;
      skillStats: { active: number; stale: number; archived: number; agentCreated: number };
    }>("/api/settings/evolution/stats"),

  // --- Voice Transcription ---
  transcribeAudio: async (audioBlob: Blob): Promise<{ text: string; language?: string; duration?: number }> => {
    const formData = new FormData();
    formData.append("file", audioBlob, "recording.webm");
    const resp = await fetch(`${BASE_URL}/api/agents/transcribe`, {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Transcription failed: ${resp.status} ${text}`);
    }
    return resp.json();
  },

  uploadSessionMedia: async (sessionId: string, file: File): Promise<{
    mediaId: string;
    fileName: string;
    mimeType: string;
    size: number;
  }> => {
    const formData = new FormData();
    formData.append("file", file);
    const resp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media`, {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Media upload failed: ${err}`);
    }
    return resp.json();
  },

  // --- Hub (Worker mode) ---
  getHubSyncState: () =>
    request<import("../types/index.js").HubSyncState>("/api/hub/sync-state").catch(() => ({
      lastHeartbeat: null,
      lastConfigSync: null,
      configVersionCached: null,
      serverReachable: false,
      pendingNotifications: [],
      registeredWorkerId: null,
    })),
  syncConfig: () =>
    request<{ success: boolean; configVersion?: string; error?: string }>("/api/hub/sync-config", { method: "POST" }),
  getConfigVersion: () =>
    request<{ available: boolean; latestVersion?: string; updatedAt?: string }>("/api/hub/config-version"),
  listMarketplaceSkills: (page = 1, pageSize = 20, search = "") =>
    request<{ items: import("../types/index.js").MarketplaceSkillItem[]; total: number }>(
      `/api/hub/marketplace/skills?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}`
    ),
  getMarketplaceSkill: (slug: string) =>
    request<import("../types/index.js").MarketplaceSkillDetail>(`/api/hub/marketplace/skills/${slug}`),
  installMarketplaceSkill: (slug: string) =>
    request<{ installed: boolean; skillId: string; error?: string }>(`/api/hub/marketplace/install/${slug}`, { method: "POST" }),
  publishSkillToMarket: (skillId: string) =>
    request<{ submissionId: string; status: string; message: string }>(`/api/hub/marketplace/publish/${skillId}`, { method: "POST" }),
  listMarketplacePlugins: (page = 1, pageSize = 20) =>
    request<{ items: unknown[]; total: number }>(`/api/hub/marketplace/plugins?page=${page}&pageSize=${pageSize}`),
  installMarketplacePlugin: (slug: string) =>
    request<{ installed: boolean; error?: string }>(`/api/hub/marketplace/install-plugin/${slug}`, { method: "POST" }),

  // --- Auth ---
  auth: {
    login: async (username: string, password: string) => {
      const r = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `Login failed (${r.status})`);
      }
      const data = await r.json();
      localStorage.setItem("da_access_token", data.access_token);
      return data;
    },
    setup: async (username: string, password: string) => {
      const r = await fetch(`${BASE_URL}/api/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Setup failed");
      return r.json();
    },
    me: async () => {
      // hub 模式：cookie 自动携带，无需 Bearer token。
      // local 模式：必须带 Bearer token，无 token 直接返回 null（短路）。
      const token = localStorage.getItem("da_access_token");
      if (!token) {
        // 没有 token 时仍要尝试一次，因为 hub 模式靠 cookie 认证
        const rNoToken = await fetch(`${BASE_URL}/api/auth/me`, {
          credentials: "include",
        });
        if (rNoToken.ok) return rNoToken.json();
        return null;
      }
      const r = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      if (!r.ok) {
        localStorage.removeItem("da_access_token");
        return null;
      }
      return r.json();
    },
    logout: async () => {
      localStorage.removeItem("da_access_token");
      // hub 模式：清掉 da_session cookie（后端 POST /sso/logout 会 Set-Cookie 过期它）
      try {
        await fetch(`${BASE_URL}/api/auth/sso/logout`, {
          method: "POST",
          credentials: "include",
        });
      } catch {
        // 忽略 — 非hub模式下此接口可能不存在，cookie 清理不重要
      }
    },
    getAuthMode: async () => {
      const r = await fetch(`${BASE_URL}/api/auth/mode`);
      return r.json();
    },
  },

  // --- Setup wizard (pre-auth, public endpoints) ---
  setup: {
    getState: async (): Promise<{ complete: boolean }> => {
      const r = await fetch(`${BASE_URL}/api/setup/state`);
      return r.json();
    },
    getEnvironment: async (): Promise<unknown> => {
      const r = await fetch(`${BASE_URL}/api/setup/environment`);
      return r.json();
    },
    complete: async (input: unknown): Promise<{ ok: boolean; envVars: Record<string, string> }> => {
      const r = await fetch(`${BASE_URL}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `Setup failed (${r.status})`);
      }
      return r.json();
    },
    download: async (modelName: string, source: string): Promise<void> => {
      await fetch(`${BASE_URL}/api/setup/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelName, source }),
      });
    },
  },

  // --- Module management (Unified Module Deployment T11) ---
  listModules: () =>
    request<{ modules: ModuleState[]; running: Record<string, unknown>; auxiliary: unknown }>('/api/modules'),

  getModule: (moduleId: string) =>
    request<{ module: ModuleState }>(`/api/modules/${moduleId}`),

  installModule: (moduleId: string, opts: { gpuRequired?: boolean } = {}) =>
    request<{ module: ModuleState }>(`/api/modules/${moduleId}/install`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  uninstallModule: (moduleId: string) =>
    request<{ success: boolean }>(`/api/modules/${moduleId}/uninstall`, { method: 'POST' }),

  startModule: (moduleId: string) =>
    request<{ status: unknown }>(`/api/modules/${moduleId}/start`, { method: 'POST' }),

  stopModule: (moduleId: string) =>
    request<{ status: unknown }>(`/api/modules/${moduleId}/stop`, { method: 'POST' }),

  updateModuleConfig: (moduleId: string, patch: Partial<ModuleState>) =>
    request<{ module: ModuleState }>(`/api/modules/${moduleId}/config`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  detectGpu: () =>
    request<GpuInfo>('/api/modules/gpu'),

  getFirstRunStatus: () =>
    request<{ hasBundle: boolean; isFirstRun: boolean }>('/api/modules/first-run-status'),

  // --- Generic helpers (used by agent-teams API client) ---
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string) =>
    request<T>(path, { method: "DELETE" }),
};

// =============================================================================
// Upload with Retry & Timeout
// =============================================================================

export interface UploadResult {
  docId: string;
  kbId: string;
  filename: string;
  status: string;
}

export async function uploadDocumentWithRetry(
  kbId: string,
  file: File,
  opts: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<UploadResult> {
  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 300_000;  // 5 minutes per attempt (large files on slow networks)
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    if (opts.signal?.aborted) {
      throw new DOMException("Upload cancelled", "AbortError");
    }
    opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      return await new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/knowledge/kbs/${kbId}/upload`);
        xhr.responseType = "json";

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 40);
            opts.onProgress?.(pct);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response as UploadResult);
          } else {
            reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
          }
        };

        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.ontimeout = () => reject(new Error("Upload timed out"));

        const formData = new FormData();
        formData.append("file", file);
        xhr.send(formData);

        controller.signal.addEventListener("abort", () => {
          xhr.abort();
          reject(new DOMException("Upload cancelled", "AbortError"));
        }, { once: true });
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt >= MAX_ATTEMPTS) throw err;
      // Exponential backoff: 2s, 4s
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error("Unreachable");
}

/** Poll document status (fallback when WebSocket is disconnected) */
export async function fetchDocumentStatus(
  kbId: string,
  docId: string
): Promise<{ stage: string; progress: number; error?: string }> {
  const res = await fetch(`/api/knowledge/kbs/${kbId}/documents/${docId}/status`);
  if (!res.ok) throw new Error(`Failed to fetch status: ${res.status}`);
  return res.json();
}
