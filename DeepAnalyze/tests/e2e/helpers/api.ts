/**
 * Typed API wrapper for all DeepAnalyze endpoints.
 * Uses the Playwright `request` context (baseURL from config).
 */
import { APIRequestContext } from "@playwright/test";

const API = "/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  title: string | null;
  kbScope: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  metadata?: Record<string, unknown>;
  toolCalls?: unknown[];
  pushedContents?: unknown[];
  thinkingContent?: string;
  media?: unknown[];
}

export interface KB {
  id: string;
  name: string;
  createdAt: string;
  documentCount?: number;
}

export interface Document {
  id: string;
  fileName: string;
  fileType: string;
  status: string;
  progress: number;
  metadata?: Record<string, unknown>;
  l1Preview?: string;
  // API response also returns these fields (snake_case):
  filename?: string;
  filePath?: string;
  fileSize?: number;
}

export interface SearchResult {
  results: Array<{
    content: string;
    score: number;
    anchorId?: string;
    documentId?: string;
    pageTitle?: string;
    kbId?: string;
    kbName?: string;
  }>;
  total: number;
  totalFound: number;
}

export interface AgentSettings {
  maxTurns: number;
  contextWindow: number;
  outputTokenBudget: number;
  subAgentMaxTurns: number;
  consecutiveErrorThreshold: number;
  stuckDetectionThreshold: number;
  [key: string]: unknown;
}

export interface FeatureFlags {
  [key: string]: boolean | number;
}

export interface Skill {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  isActive?: boolean;
}

export interface Team {
  id: string;
  name: string;
  mode: string;
  members?: unknown[];
}

export interface CronJob {
  id: string;
  name: string;
  expression: string;
  enabled: boolean;
}

export interface MCPServer {
  id: string;
  name: string;
  type: string;
  command?: string;
  url?: string;
}

export interface Plugin {
  id: string;
  name: string;
  enabled: boolean;
}

export interface Report {
  id: string;
  title?: string;
  sessionId?: string;
  createdAt: string;
}

export interface MediaMeta {
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface Capabilities {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function json<T = unknown>(resp: { ok: boolean; status: number; json(): Promise<any> }): Promise<T> {
  if (!resp.ok) {
    const text = await (resp as any).text?.().catch(() => "") || "";
    throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// API object
// ---------------------------------------------------------------------------

export function createApi(request: APIRequestContext) {
  return {
    // -- Health --
    health: () =>
      request.get(`${API}/health`).then((r) => json<{ status: string; pg: boolean }>(r)),

    // -- Sessions --
    listSessions: () =>
      request.get(`${API}/sessions`).then((r) => json<Session[]>(r)),

    createSession: (title?: string, kbScope?: Record<string, unknown>) =>
      request.post(`${API}/sessions`, { data: { title, kbScope } }).then((r) => json<Session>(r)),

    getSession: (id: string) =>
      request.get(`${API}/sessions/${id}`).then((r) => json<Session>(r)),

    deleteSession: async (id: string) => {
      const r = await request.delete(`${API}/sessions/${id}`);
      return r;
    },

    getMessages: (sessionId: string) =>
      request.get(`${API}/sessions/${sessionId}/messages`).then((r) => json<Message[]>(r)),

    listSessionWorkflows: (sessionId: string) =>
      request.get(`${API}/sessions/${sessionId}/workflows`).then((r) => json<{ sessionId: string; workflows: unknown[] }>(r)),

    patchScope: (sessionId: string, kbScope: Record<string, unknown>) =>
      request.patch(`${API}/sessions/${sessionId}/scope`, { data: { kbScope } }).then((r) => json<{ success: boolean }>(r)),

    renameSession: (id: string, title: string) =>
      request.patch(`${API}/sessions/${id}/title`, { data: { title } }).then((r) => json<{ success: boolean }>(r)),

    uploadMedia: (sessionId: string, file: Buffer, name: string, mimeType: string) => {
      const formData = new FormData();
      const blob = new Blob([file]);
      formData.append("file", blob, name);
      return request.post(`${API}/sessions/${sessionId}/media`, {
        multipart: { file: { name, mimeType, buffer: file } },
      }).then((r) => json<MediaMeta>(r));
    },

    getMedia: (sessionId: string, mediaId: string, type = "original") =>
      request.get(`${API}/sessions/${sessionId}/media/${mediaId}?type=${type}`),

    getOutputFile: (sessionId: string, fileName: string) =>
      request.get(`${API}/sessions/${sessionId}/output/${fileName}`),

    // -- Knowledge (mounted at /api/knowledge) --
    listKBs: () =>
      request.get(`${API}/knowledge/kbs`).then(async (r) => {
        const data = await json<{ knowledgeBases: any[] }>(r);
        return data.knowledgeBases ?? data;
      }),

    createKB: (name: string) =>
      request.post(`${API}/knowledge/kbs`, { data: { name } }).then((r) => json<KB>(r)),

    getKB: (id: string) =>
      request.get(`${API}/knowledge/kbs/${id}`).then((r) => json<KB>(r)),

    deleteKB: (id: string) =>
      request.delete(`${API}/knowledge/kbs/${id}`).then((r) => { /* best effort */ }),

    uploadDocument: (kbId: string, file: Buffer, name: string, mimeType: string) =>
      request.post(`${API}/knowledge/kbs/${kbId}/upload`, {
        multipart: { file: { name, mimeType, buffer: file } },
      }).then(async (r) => {
        const data = await json<any>(r);
        // Normalize snake_case API fields to camelCase
        return {
          id: data.id || data.documentId || data.docId,
          fileName: data.fileName || data.filename || name,
          fileType: data.fileType || (data.filename ?? name).split(".").pop(),
          status: data.status || "uploaded",
          progress: data.progress || 0,
          metadata: data.metadata,
        } as Document;
      }),

    listDocuments: (kbId: string) =>
      request.get(`${API}/knowledge/kbs/${kbId}/documents`).then(async (r) => {
        const data = await json<any>(r);
        const docs: any[] = data.documents ?? (Array.isArray(data) ? data : []);
        // Normalize snake_case fields to camelCase
        return docs.map((d: any) => ({
          id: d.id,
          fileName: d.fileName || d.filename,
          fileType: d.fileType || d.file_type,
          status: d.status,
          progress: d.progress ?? d.processing_progress ?? 0,
          metadata: d.metadata,
          l1Preview: d.l1Preview,
        })) as Document[];
      }),

    getDocument: (kbId: string, docId: string) =>
      request.get(`${API}/knowledge/kbs/${kbId}/documents/${docId}/status`).then(async (r) => {
        const data = await json<any>(r);
        return {
          id: data.docId || data.id || docId,
          fileName: data.fileName || data.filename,
          fileType: data.fileType,
          status: data.status,
          progress: data.progress ?? 0,
          metadata: data.metadata,
        } as Document;
      }),

    deleteDocument: (kbId: string, docId: string) =>
      request.delete(`${API}/knowledge/kbs/${kbId}/documents/${docId}`),

    reprocessDocument: (kbId: string, docId: string, channel: string) =>
      request.post(`${API}/knowledge/kbs/${kbId}/documents/${docId}/reprocess`, { data: { channel } }),

    getOriginalFile: (kbId: string, docId: string) =>
      request.get(`${API}/files/${kbId}/documents/${docId}/original`),

    expandDocument: (kbId: string, docId: string, level: string) =>
      request.post(`${API}/knowledge/${kbId}/expand`, { data: { docId, level } }).then((r) => json(r)),

    wikiBrowse: (kbId: string, options?: Record<string, unknown>) =>
      request.get(`${API}/knowledge/${kbId}/wiki${options?.path ? '/' + (options.path as string) : ''}`).then((r) => json(r)),

    qualityReport: (kbId: string) =>
      request.get(`${API}/knowledge/kbs/${kbId}/quality-report`).then((r) => json(r)),

    // -- Search --
    search: (kbId: string, query: string, options?: { mode?: string; level?: string; topK?: number }) => {
      const params = new URLSearchParams({ query });
      if (options?.mode) params.set("mode", options.mode);
      if (options?.level) params.set("level", options.level);
      if (options?.topK) params.set("topK", String(options.topK));
      return request.get(`${API}/knowledge/${kbId}/search?${params}`).then(async (r) => {
        const data = await json<any>(r);
        return {
          results: data.results ?? [],
          total: data.totalFound ?? data.total ?? data.results?.length ?? 0,
          totalFound: data.totalFound ?? data.total ?? data.results?.length ?? 0,
        } as SearchResult;
      });
    },

    crossKBSearch: (query: string) =>
      request.get(`${API}/knowledge/search?query=${encodeURIComponent(query)}`).then(async (r) => {
        const data = await json<any>(r);
        return {
          results: data.results ?? [],
          total: data.totalFound ?? data.total ?? data.results?.length ?? 0,
          totalFound: data.totalFound ?? data.total ?? data.results?.length ?? 0,
        } as SearchResult;
      }),

    searchTest: (query: string) =>
      request.post(`${API}/search-test/test`, { data: { query } }).then((r) => json(r)),

    // -- Agent --
    runStream: (input: string, sessionId: string, options?: Record<string, unknown>) =>
      request.post(`${API}/agents/run`, {
        data: { input, sessionId, ...options },
      }),

    cancelTask: (taskId: string) =>
      request.post(`${API}/agents/cancel/${taskId}`),

    getTaskStatus: (sessionId: string) =>
      request.get(`${API}/agents/tasks/${sessionId}`).then((r) => json(r)),

    injectMessage: (taskId: string, message: string) =>
      request.post(`${API}/agents/inject`, { data: { taskId, message } }),

    getCapabilities: () =>
      request.get(`${API}/capabilities`).then((r) => json<Capabilities>(r)),

    // -- Settings --
    getProviders: () =>
      request.get(`${API}/settings/providers`).then((r) => json<{ providers: any[] }>(r)),

    getDefaults: () =>
      request.get(`${API}/settings/defaults`).then((r) => json<Record<string, unknown>>(r)),

    setDefault: (role: string, providerId: string) =>
      request.post(`${API}/settings/defaults`, { data: { role, providerId } }),

    getAgentSettings: () =>
      request.get(`${API}/settings/agent`).then((r) => json<AgentSettings>(r)),

    setAgentSettings: (settings: Partial<AgentSettings>) =>
      request.post(`${API}/settings/agent`, { data: settings }),

    getFeatureFlags: () =>
      request.get(`${API}/settings/feature-flags`).then((r) => json<FeatureFlags>(r)),

    // -- Skills --
    listSkills: () =>
      request.get(`${API}/agent-skills`).then((r) => json<Skill[]>(r)),

    createSkill: (skill: Partial<Skill>) =>
      request.post(`${API}/agent-skills`, { data: skill }).then((r) => json<Skill>(r)),

    deleteSkill: (id: string) =>
      request.delete(`${API}/agent-skills/${id}`),

    // -- Plugins --
    listPlugins: () =>
      request.get(`${API}/plugins`).then((r) => json<{ plugins: Plugin[] }>(r)),

    // -- Teams --
    listTeams: () =>
      request.get(`${API}/agent-teams`).then((r) => json<Team[]>(r)),

    listTeamTemplates: () =>
      request.get(`${API}/agent-teams/templates`).then((r) => json<any[]>(r)),

    createTeam: (team: Partial<Team>) =>
      request.post(`${API}/agent-teams`, { data: team }).then((r) => json<Team>(r)),

    deleteTeam: (id: string) =>
      request.delete(`${API}/agent-teams/${id}`),

    // -- Cron --
    listCronJobs: () =>
      request.get(`${API}/cron/jobs`).then((r) => json<CronJob[]>(r)),

    createCronJob: (job: Partial<CronJob>) =>
      request.post(`${API}/cron/jobs`, { data: job }).then((r) => json<CronJob>(r)),

    validateCron: (expression: string) =>
      request.post(`${API}/cron/validate`, { data: { expression } }),

    deleteCronJob: (id: string) =>
      request.delete(`${API}/cron/jobs/${id}`),

    // -- MCP --
    listMCPServers: () =>
      request.get(`${API}/mcp`).then((r) => json<MCPServer[]>(r)),

    addMCPServer: (server: Partial<MCPServer>) =>
      request.post(`${API}/mcp`, { data: server }).then((r) => json<MCPServer>(r)),

    deleteMCPServer: (id: string) =>
      request.delete(`${API}/mcp/${id}`),

    // -- Reports --
    listReports: (sessionId?: string) => {
      const url = sessionId
        ? `${API}/reports/sessions/${sessionId}/reports`
        : `${API}/reports`;
      return request.get(url).then((r) => json<Report[]>(r));
    },

    deleteReport: (id: string) =>
      request.delete(`${API}/reports/${id}`),

    // -- Channels --
    listChannels: () =>
      request.get(`${API}/channels/list`).then((r) => json(r)),
  };
}

export type Api = ReturnType<typeof createApi>;
