// =============================================================================
// DeepAnalyze - Agent API Routes
// =============================================================================
// Hono routes for agent task management. Provides endpoints for running
// single agent tasks, coordinated multi-agent workflows, querying task status,
// and cancelling running tasks.
//
// Context management (session memory, auto-compaction) is now handled
// internally by AgentRunner — no external context loading needed here.
// =============================================================================

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "events";
import type { Orchestrator } from "../../services/agent/orchestrator.js";
import type { AgentEvent, AgentResult, AgentTask } from "../../services/agent/types.js";
import { DEFAULT_AGENT_SETTINGS } from "../../services/agent/types.js";
import { ContextManager } from "../../services/agent/context-manager.js";
import { getPluginManager, getToolRegistry } from "../../services/agent/agent-system.js";
import { getRepos } from "../../store/repos/index.js";
import { MediaStore } from "../../services/session/media-store.js";
import { agentAsyncContext, setActiveContext, deleteActiveContext, getActiveContext } from "../../services/agent/tool-registry.js";
import { taskEventBuffer } from "../../services/agent/task-event-buffer.js";
import { getWorkflowManager } from "../../services/agent/workflow-manager.js";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";
import { getProcessingQueue } from "../../services/processing-queue.js";
import { errorMessage } from "../../utils/errors.ts";

// Ensure global workflow event bus exists (shared with ws.ts)
declare global {
  var __workflowEvents: EventEmitter | undefined;
}
if (!globalThis.__workflowEvents) {
  globalThis.__workflowEvents = new EventEmitter();
}

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_AGENT_RUNS = 8;
const MAX_CONCURRENT_PER_SESSION = 3; // Prevents one session from monopolizing all global slots
let activeAgentRuns = 0;
const activePerSession = new Map<string, number>(); // sessionId -> running task count

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface RunRequest {
  sessionId: string;
  input: string;
  mediaIds?: string[];  // 上传的媒体 ID 列表
  agentType?: string;
  maxTurns?: number;
  scope?: Record<string, unknown>;
  /** Override the default tool list for this run (e.g. exclude "kb_search"). */
  toolsOverride?: string[];
}

interface RunCoordinatedRequest {
  sessionId: string;
  input: string;
}

interface RunSkillRequest {
  sessionId: string;
  skillId: string;
  /** Required for legacy skills (used to resolve template variables). Ignored when useAgentSkills=true. */
  variables?: Record<string, string>;
  /** Optional user input to append to the resolved prompt. */
  input?: string;
  /** Optional knowledge base ID to scope the skill execution. */
  kbId?: string;
  /** If true, look up skillId in agent_skills table instead of the old skills table. */
  useAgentSkills?: boolean;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create agent API routes, receiving an Orchestrator instance.
 *
 * Routes:
 *   POST /run              - Run a single agent task
 *   POST /run-stream       - Run agent with SSE streaming
 *   POST /run-coordinated  - Run a coordinated multi-agent workflow
 *   POST /run-skill        - Run a skill as an agent task
 *   GET  /tasks/:sessionId - List agent tasks for a session
 *   GET  /task/:taskId     - Get a single task status
 *   POST /cancel/:taskId   - Cancel a running task
 */
// ---------------------------------------------------------------------------
// Context loading helper
// ---------------------------------------------------------------------------

/**
 * Load conversation context for a session using token-aware, boundary-aware loading.
 * - Finds the latest compact boundary (if any) and only loads messages after it
 * - Uses token-based budget instead of fixed message count
 * - Excludes compact boundary messages from the context
 */
async function loadContextMessages(
  orchestrator: Orchestrator,
  sessionId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const repos = await getRepos();

  // ── Try JSONL-first context loading ──
  try {
    const { SessionReader } = await import("../../services/session/session-reader.js");
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const { getSessionDir } = await import("../../services/session/session-paths.js");
    const sessionDir = getSessionDir(DEEPANALYZE_CONFIG.dataDir, sessionId);
    if (existsSync(sessionDir)) {
      const sessionReader = new SessionReader();
      const reconstructed = await sessionReader.readSession(DEEPANALYZE_CONFIG.dataDir, sessionId);

      // Build context from JSONL turns (excluding the last user input which is already in `input`)
      const contextFromJsonl: Array<{ role: "user" | "assistant"; content: string }> = [];

      // Group turns by taskId — multiple turn numbers for the same taskId are
      // continuations of the same response (streaming retries / multi-chunk output).
      const taskGroups = new Map<string, typeof reconstructed.turns>();
      for (const turn of reconstructed.turns) {
        if (!turn.assistantContent && !turn.toolCalls.length) continue;
        let group = taskGroups.get(turn.taskId);
        if (!group) {
          group = [];
          taskGroups.set(turn.taskId, group);
        }
        group.push(turn);
      }

      // Sort task groups by their earliest timestamp
      const sortedGroups = Array.from(taskGroups.entries()).sort(
        (a, b) => new Date(a[1][0].firstTimestamp).getTime() - new Date(b[1][0].firstTimestamp).getTime(),
      );

      for (const [taskId, turns] of sortedGroups) {
        // Include user message for this turn
        const userContent = turns[0].userContent;
        if (userContent) {
          contextFromJsonl.push({ role: "user", content: userContent });
        }

        // Merge all turn contents for this task into a single assistant message
        let mergedAssistant = "";
        const allToolCalls: typeof turns[0]["toolCalls"] = [];
        for (const turn of turns) {
          if (turn.assistantContent) {
            mergedAssistant += turn.assistantContent;
          }
          allToolCalls.push(...turn.toolCalls);
        }

        // Build a compact assistant message that includes tool usage summary
        // Exclude control-flow tools (finish, agent_todo) — they are internal
        // operations that don't provide user-visible information and including
        // "Used tools: [finish(...)]" in context causes the model to reproduce
        // this pattern as text output (feedback loop bug).
        let assistantMessage = mergedAssistant.trim();
        // Sanitize: strip "Used tools: [finish(...)]" patterns from assistant
        // content that the model may have previously generated as text (a known
        // feedback loop artifact). This prevents the pattern from being fed back
        // into the model's context and triggering further reproduction.
        assistantMessage = assistantMessage.replace(
          /Used tools: \[finish\([^[\]]*\]\s*/g,
          "",
        ).trim();
        const contextToolCalls = allToolCalls.filter(
          (tc) => tc.toolName !== "finish" && tc.toolName !== "agent_todo",
        );
        if (contextToolCalls.length > 0) {
          const toolParts = contextToolCalls.map((tc) => {
            const inputStr = JSON.stringify(tc.input).slice(0, 80);
            const outputStr = tc.output ? tc.output.slice(0, 200) : "";
            return `[${tc.toolName}(${inputStr}) → ${outputStr}]`;
          });
          const toolSummary = `Used tools: ${toolParts.join("; ")}`;
          assistantMessage = assistantMessage
            ? `${assistantMessage}\n\n${toolSummary}`
            : toolSummary;
        }

        if (assistantMessage) {
          contextFromJsonl.push({ role: "assistant", content: assistantMessage });
        }
      }

      if (contextFromJsonl.length > 0) {
        // Enrich user messages with media attachment info from DB.
        // JSONL transcripts only record text, not media metadata.
        // Cross-reference with DB messages to annotate media attachments
        // so the agent knows about previously uploaded files.
        try {
          const dbMessages = await repos.message.list(sessionId);
          const userMediaMap = new Map<string, string>();
          for (const dbMsg of dbMessages) {
            if (dbMsg.role === "user" && dbMsg.content?.startsWith("{")) {
              try {
                const parsed = JSON.parse(dbMsg.content);
                if (parsed.media && Array.isArray(parsed.media) && parsed.media.length > 0) {
                  const text = parsed.text || "";
                  const mediaDesc = parsed.media.map((md: any) => {
                    const sizeStr = md.size > 1024 * 1024
                      ? `${(md.size / 1024 / 1024).toFixed(1)}MB`
                      : md.size > 1024
                        ? `${(md.size / 1024).toFixed(0)}KB`
                        : `${md.size}B`;
                    return `${md.fileName || "file"} (${md.mimeType || "unknown"}, ${sizeStr})`;
                  }).join(", ");
                  const annotated = text ? `${text}\n[用户上传了附件: ${mediaDesc}]` : `[用户上传了附件: ${mediaDesc}]`;
                  // Index by both text and full content for matching
                  if (text) userMediaMap.set(text, annotated);
                }
              } catch { /* not JSON */ }
            }
          }
          // Apply annotations to JSONL-loaded context
          for (const ctx of contextFromJsonl) {
            if (ctx.role === "user") {
              const annotated = userMediaMap.get(ctx.content);
              if (annotated) ctx.content = annotated;
            }
          }
        } catch { /* non-critical enrichment, proceed without it */ }

        // Apply token budget
        const modelRouter = orchestrator.getModelRouter();
        const contextManager = new ContextManager(modelRouter, "", []);
        const settings = { ...DEFAULT_AGENT_SETTINGS };
        const maxTokens = Math.floor(settings.contextWindow * settings.contextLoadRatio);
        const { messages } = contextManager.loadContextMessages(contextFromJsonl, maxTokens);
        return messages;
      }
    }
  } catch (err) {
    // JSONL loading failed, fall through to DB loading
    console.warn("[loadContextMessages] JSONL loading failed:", errorMessage(err));
  }

  // ── Fallback: DB-based context loading ──
  // Check for compact boundary — only load messages after it
  const boundary = await repos.message.getLatestCompactBoundary(sessionId);
  const allMessages = await repos.message.list(sessionId);

  // Determine starting point: after the boundary, or skip just the current user message
  let startIndex: number;
  if (boundary) {
    const boundaryIndex = allMessages.findIndex((m) => m.id === boundary.id);
    startIndex = boundaryIndex >= 0 ? boundaryIndex + 1 : 0;
  } else {
    startIndex = 0;
  }

  // Filter to user/assistant, exclude compact boundary markers, exclude current (last) user message.
  // Also exclude draft messages (metadata.draft === true) — these are in-progress assistant
  // outputs from parallel tasks. Including them would pollute the current task's context with
  // incomplete content from sibling tasks.
  const contextCandidates = allMessages
    .slice(startIndex, -1) // Exclude last message (just-saved user input, already in `input`)
    .filter((m) => {
      if (m.role !== "user" && m.role !== "assistant") return false;
      if (m.content.startsWith("[COMPACT_BOUNDARY:")) return false;
      // Exclude draft messages from parallel tasks
      if (m.metadata) {
        try {
          const meta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
          if (meta && meta.draft === true) return false;
        } catch { /* malformed metadata — treat as non-draft, include */ }
      }
      return true;
    });

  if (contextCandidates.length === 0) return [];

  // Token-aware loading: use a ContextManager to estimate tokens
  const modelRouter = orchestrator.getModelRouter();
  const contextManager = new ContextManager(modelRouter, "", []);
  const settings = { ...DEFAULT_AGENT_SETTINGS };

  // Budget: 50% of context window for loaded history
  // (remaining 50% for system prompt, tools, output, session memory)
  const maxTokens = Math.floor(settings.contextWindow * settings.contextLoadRatio);

  const { messages } = contextManager.loadContextMessages(
    contextCandidates.map((m) => {
      let content = m.content || "";
      // Sanitize: strip repeated "Used tools: [finish(...)]" patterns from
      // persisted content. These are artifacts of a feedback loop where the
      // model reproduced this text from context. Keeping them would perpetuate
      // the loop and waste context tokens.
      content = content.replace(/Used tools: \[finish\([^[\]]*\]\s*/g, "");
      // For user messages with media attachments (stored as JSON),
      // extract the text and annotate with media info so the agent knows
      // about uploaded files in the conversation history.
      if (m.role === "user" && content.startsWith("{")) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.media && Array.isArray(parsed.media) && parsed.media.length > 0) {
            const text = parsed.text || "";
            const mediaDesc = parsed.media.map((md: any) => {
              const sizeStr = md.size > 1024 * 1024
                ? `${(md.size / 1024 / 1024).toFixed(1)}MB`
                : md.size > 1024
                  ? `${(md.size / 1024).toFixed(0)}KB`
                  : `${md.size}B`;
              return `${md.fileName || "file"} (${md.mimeType || "unknown"}, ${sizeStr})`;
            }).join(", ");
            content = text ? `${text}\n[用户上传了附件: ${mediaDesc}]` : `[用户上传了附件: ${mediaDesc}]`;
          } else if (parsed.text) {
            content = parsed.text;
          }
        } catch { /* not JSON — plain text message */ }
      }
      return { role: m.role, content };
    }),
    maxTokens,
  );

  return messages;
}

// ---------------------------------------------------------------------------
// Helper: detect file type from extension (mirrors knowledge.ts logic)
// ---------------------------------------------------------------------------
function detectFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const typeMap: Record<string, string> = {
    pdf: "pdf", docx: "docx", doc: "doc", xlsx: "xlsx", xls: "xls",
    pptx: "pptx", ppt: "ppt", txt: "txt", md: "markdown", csv: "csv",
    json: "json", html: "html", xml: "xml", rtf: "rtf", odt: "odt",
    epub: "epub", png: "png", jpg: "jpg", jpeg: "jpeg", gif: "gif",
    bmp: "bmp", tiff: "tiff", tif: "tif", webp: "webp", svg: "svg",
    mp3: "mp3", wav: "wav", mp4: "mp4", yaml: "yaml", yml: "yml",
  };
  return typeMap[ext] ?? ext;
}

// ---------------------------------------------------------------------------
// Auto-create session KB for document attachments (Track 2: background)
// ---------------------------------------------------------------------------
async function ensureSessionKbForDocuments(
  sessionId: string,
  mediaIds: string[],
  dataDir: string,
): Promise<void> {
  const repos = await getRepos();

  // Filter to non-media files only
  const docMediaIds: Array<{ mediaId: string; meta: Awaited<ReturnType<typeof MediaStore.getMeta>> & {} }> = [];
  for (const mediaId of mediaIds) {
    const meta = await MediaStore.getMeta(dataDir, sessionId, mediaId);
    if (!meta) continue;
    const isMedia = meta.mimeType.startsWith("image/")
                 || meta.mimeType.startsWith("video/")
                 || meta.mimeType.startsWith("audio/");
    if (!isMedia) docMediaIds.push({ mediaId, meta });
  }
  if (docMediaIds.length === 0) return;

  // Find or create session-scoped knowledge base
  const { getPool } = await import("../../store/pg.js");
  const pool = await getPool();
  const kbName = `session-${sessionId}`;
  let kbRows = await pool.query(
    `SELECT id FROM knowledge_bases WHERE name = $1`,
    [kbName],
  );
  let kbId: string;
  if (kbRows.rows.length > 0) {
    kbId = kbRows.rows[0].id;
  } else {
    const kb = await repos.knowledgeBase.create(kbName, "default-user");
    kbId = kb.id;
    mkdirSync(join(dataDir, "original", kbId), { recursive: true });
    mkdirSync(join(dataDir, "wiki", kbId), { recursive: true });
  }

  // Copy files to KB and create document records
  const queue = getProcessingQueue();
  for (const { mediaId, meta } of docMediaIds) {
    const originalPath = MediaStore.getOriginalPath(dataDir, sessionId, mediaId);
    if (!originalPath) continue;

    const destDir = join(dataDir, "original", kbId);
    mkdirSync(destDir, { recursive: true });
    const destPath = join(destDir, meta.fileName);

    // Skip if file already exists (avoid duplicate copy)
    if (!existsSync(destPath)) {
      copyFileSync(originalPath, destPath);
    }

    // Skip if document with same hash already exists in this KB
    const fileHash = createHash("md5").update(readFileSync(destPath)).digest("hex");
    const existing = await pool.query(
      `SELECT id FROM documents WHERE kb_id = $1 AND file_hash = $2`,
      [kbId, fileHash],
    );
    if (existing.rows.length > 0) continue;

    // Create document record and enqueue for processing
    const fileType = detectFileType(meta.fileName);
    const docId = randomUUID();
    await repos.document.create({
      kb_id: kbId,
      filename: meta.fileName,
      file_path: destPath,
      folder_path: "",
      file_hash: fileHash,
      file_size: meta.size,
      file_type: fileType,
      status: "uploaded",
      metadata: { source: "chat-attachment", mediaId },
      processing_step: null,
      processing_progress: 0,
      processing_error: null,
    });

    queue.enqueue({
      kbId,
      docId,
      filename: meta.fileName,
      filePath: destPath,
      fileType,
    });
  }

  // Update session kbScope to include this KB
  const session = await repos.session.get(sessionId);
  let scope: Record<string, unknown> = {};
  if (session?.kbScope) {
    try {
      scope = typeof session.kbScope === "string"
        ? JSON.parse(session.kbScope)
        : session.kbScope;
    } catch {
      scope = {};
    }
  }
  const knowledgeBases = (scope as Record<string, unknown>).knowledgeBases as Array<Record<string, unknown>> ?? [];
  const alreadyIncluded = knowledgeBases.some((kb) => kb.kbId === kbId);
  if (!alreadyIncluded) {
    knowledgeBases.push({ kbId, mode: "all" });
    await repos.session.updateKbScope(sessionId, {
      knowledgeBases,
      webSearch: (scope as Record<string, unknown>).webSearch ?? false,
    });
  }
}

/**
 * Auto-name a session from its first user message when the session has no title yet.
 *
 * Every endpoint that persists a user message calls this, so conversations started
 * via any entry path — single agent, streaming, coordinated multi-agent workflow, or
 * skill — get a recognizable sidebar title instead of lingering as an untitled
 * "新对话" entry indistinguishable from every other conversation.
 *
 * Best-effort and non-blocking: a naming failure must never break or delay the run.
 * The title is derived from the raw user input (media-only payloads fall back to
 * the literal input string), truncated to 30 chars with an ellipsis when longer.
 */
async function autoNameSession(
  repos: Awaited<ReturnType<typeof getRepos>>,
  sessionId: string,
  rawInput: string,
): Promise<void> {
  try {
    const existing = await repos.session.get(sessionId);
    if (!existing || existing.title) return; // already titled — never overwrite
    let firstMsg = rawInput;
    try {
      const parsed = JSON.parse(firstMsg);
      if (typeof parsed.text === "string") firstMsg = parsed.text;
    } catch { /* not JSON — plain text message */ }
    const autoTitle =
      firstMsg.replace(/\n/g, " ").trim().slice(0, 30) +
      (firstMsg.length > 30 ? "..." : "");
    if (autoTitle) {
      await repos.session.updateTitle(sessionId, autoTitle);
    }
  } catch {
    // Best-effort — never block the run on naming.
  }
}

/**
 * Resolve scope from request body, falling back to the session's kbScope.
 * Supports both { knowledgeBases: [...] } and { kbIds: [...] } formats.
 */
function resolveScope(body: RunRequest, session: { kbScope?: string | null }): Record<string, unknown> | undefined {
  if (body.scope) return body.scope;
  const raw = session.kbScope;
  if (!raw) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    // New format: { knowledgeBases: [...], webSearch: bool }
    if (parsed.knowledgeBases && Array.isArray(parsed.knowledgeBases) && parsed.knowledgeBases.length > 0) {
      return parsed;
    }
    // Legacy format: { kbIds: [...] } or plain array
    if (Array.isArray(parsed.kbIds) && parsed.kbIds.length > 0) {
      return parsed;
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

export function createAgentRoutes(orchestrator: Orchestrator): Hono {
  const router = new Hono();

  // -----------------------------------------------------------------------
  // POST /run - Run a single agent task
  // -----------------------------------------------------------------------
  router.post("/run", async (c) => {
    const body = await c.req.json<RunRequest>();

    if (!body.sessionId || !body.input) {
      return c.json(
        { error: "sessionId and input are required" },
        400,
      );
    }

    const repos = await getRepos();
    const session = await repos.session.get(body.sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Build message content — include media references if present
    let runMessageContent: string = body.input;
    if (body.mediaIds && body.mediaIds.length > 0) {
      const mediaRefs: Array<{ mediaId: string; mimeType: string; fileName: string; size: number }> = [];
      for (const mediaId of body.mediaIds) {
        const meta = await MediaStore.getMeta(DEEPANALYZE_CONFIG.dataDir, body.sessionId, mediaId);
        if (!meta) {
          return c.json({ error: `Media file not found: ${mediaId}` }, 400);
        }
        mediaRefs.push({
          mediaId: meta.mediaId,
          mimeType: meta.mimeType,
          fileName: meta.fileName,
          size: meta.size,
        });
      }
      runMessageContent = JSON.stringify({ text: body.input, media: mediaRefs });
    }

    // Save user message to the chat session
    await repos.message.create(body.sessionId, "user", runMessageContent);

    // Auto-name the session from this first user message (fire-and-forget)
    void autoNameSession(repos, body.sessionId, body.input);

    // Load previous conversation history with token-aware, boundary-aware loading
    const contextMessages = await loadContextMessages(orchestrator, body.sessionId);

    try {
      const result = await orchestrator.runSingle({
        input: body.input,
        mediaIds: body.mediaIds,
        agentType: body.agentType || "general",
        sessionId: body.sessionId,
        maxTurns: body.maxTurns,
        contextMessages,
        scope: resolveScope(body, session),
        toolsOverride: body.toolsOverride,
      });

      // Save assistant response to the chat session with metadata
      if (result.output) {
        const meta: Record<string, unknown> = { draft: false };
        if (result.toolCallsCount && result.toolCallsCount > 0) {
          meta.toolCallsCount = result.toolCallsCount;
        }
        await repos.message.create(
          body.sessionId,
          "assistant",
          result.output,
          meta,
        );
      }

      return c.json({
        taskId: result.taskId,
        status: "completed",
        output: result.output,
        turnsUsed: result.turnsUsed,
        usage: result.usage,
        compactionEvents: result.compactionEvents,
        estimatedCostUsd: result.estimatedCostUsd,
      });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json(
        {
          taskId: null,
          status: "failed",
          error: errorMsg,
        },
        500,
      );
    }
  });

  // -----------------------------------------------------------------------
  // POST /run-stream - Run agent with SSE streaming (persistent)
  // -----------------------------------------------------------------------
  // The agent runs in the background (fire-and-forget). SSE is an optional
  // event viewer — client disconnect does NOT cancel the task. Events are
  // buffered in TaskEventBuffer so clients can reconnect later.
  // -----------------------------------------------------------------------
  router.post("/run-stream", async (c) => {
    const body = await c.req.json<RunRequest>();

    if (!body.sessionId || (!body.input && (!body.mediaIds || body.mediaIds.length === 0))) {
      return c.json({ error: "sessionId and input (or mediaIds) are required" }, 400);
    }

    const repos = await getRepos();
    const session = await repos.session.get(body.sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Build message content — include media references if present
    let messageContent: string = body.input;
    if (body.mediaIds && body.mediaIds.length > 0) {
      // Validate all mediaIds exist
      const mediaRefs: Array<{ mediaId: string; mimeType: string; fileName: string; size: number }> = [];
      for (const mediaId of body.mediaIds) {
        const meta = await MediaStore.getMeta(DEEPANALYZE_CONFIG.dataDir, body.sessionId, mediaId);
        if (!meta) {
          return c.json({ error: `Media file not found: ${mediaId}` }, 400);
        }
        mediaRefs.push({
          mediaId: meta.mediaId,
          mimeType: meta.mimeType,
          fileName: meta.fileName,
          size: meta.size,
        });
      }
      messageContent = JSON.stringify({ text: body.input, media: mediaRefs });
    }
    await repos.message.create(body.sessionId, "user", messageContent);

    // Auto-name the session from this first user message (fire-and-forget)
    void autoNameSession(repos, body.sessionId, body.input);

    // Track 2: Fire-and-forget — upload non-media files to session KB for background processing
    if (body.mediaIds && body.mediaIds.length > 0) {
      ensureSessionKbForDocuments(body.sessionId, body.mediaIds, DEEPANALYZE_CONFIG.dataDir)
        .catch(err => console.warn("[Agent] Session KB setup failed:", err));
    }

    // Load previous conversation history with token-aware, boundary-aware loading
    const contextMessages = await loadContextMessages(orchestrator, body.sessionId);

    // Pre-generate taskId so we can buffer events before the stream starts
    const taskId = randomUUID();

    // Create a draft assistant message for incremental updates
    const draftMsg = await repos.message.create(body.sessionId, "assistant", "", { draft: true, taskId });

    // Set up SSE response
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    // Set up execution context for ask_user tool before streaming starts
    const toolRegistry = await getToolRegistry();

    // Resolve scope: prefer request body, fallback to session's persisted kbScope
    const resolvedScope = resolveScope(body, session);
    let scopeKbIds: string[] = [];
    if (resolvedScope) {
      const kbIds = (resolvedScope as Record<string, unknown>).kbIds as string[] | undefined;
      const knowledgeBases = (resolvedScope as Record<string, unknown>).knowledgeBases as Array<Record<string, unknown>> | undefined;
      if (kbIds) scopeKbIds = kbIds.filter((id): id is string => typeof id === "string" && id !== "");
      else if (knowledgeBases) {
        // Accept both canonical {kbId, mode} and legacy {id, type} formats
        scopeKbIds = knowledgeBases
          .map(kb => (typeof kb.kbId === "string" ? kb.kbId : (typeof kb.id === "string" ? kb.id : "")))
          .filter(id => id !== "");
      }
    }

    // Persist scope to session (fire-and-forget) so it's available as fallback
    if (body.scope && (body.scope as Record<string, unknown>).knowledgeBases) {
      repos.session.updateKbScope(body.sessionId, body.scope as Record<string, unknown>).catch(() => {});
    }

    // Load session memory for sub-agent inheritance
    let sessionMemoryText: string | undefined;
    try {
      const memData = await repos.sessionMemory.load(body.sessionId);
      if (memData) sessionMemoryText = memData.content;
    } catch { /* non-critical */ }

    // Create per-task context object (NOT written to singleton)
    const taskContext: Record<string, unknown> = {
      sessionId: body.sessionId,
      taskId,
      parentMessages: contextMessages,
      scopeKbIds,
      sessionMemory: sessionMemoryText,
      askUserCallback: async (question: string, options?: string[]) => {
        const eventData = { question, options: options ?? [], taskId };
        taskEventBuffer.push(taskId, "ask_user", eventData);
        return orchestrator.waitForUserAnswer(taskId);
      },
    };

    // Register for cross-request access (inject route)
    setActiveContext(taskId, taskContext);

    // Collect tool calls for the final message
    const toolCalls: Array<{
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      output?: string;
      status: "running" | "completed" | "error";
    }> = [];

    let fullContent = "";
    let thinkingContent = "";  // Accumulates thinking_delta events for persistence
    const pushedContents: Array<{ type: string; title: string; data?: string; format?: string; timestamp?: string; fileName?: string; fileSize?: number; mimeType?: string; downloadUrl?: string; dataLength?: number; filePath?: string }> = [];

    // Dedup helper: prevent the same push_content card from being added twice
    // (both workflow event handler and direct onEvent can fire for the same push,
    //  or agent may push inline then again via write_file+push_content)
    // Returns true if the item was added, false if it was a duplicate.
    function addPushedContent(item: typeof pushedContents[number]): boolean {
      const isDuplicate = pushedContents.some(existing => {
        // Exact match on title+type+data
        if (existing.title === item.title && existing.type === item.type && existing.data === item.data) return true;
        // Normalize titles for fuzzy matching: remove emoji, special chars, collapse whitespace
        const normalizeTitle = (t: string) => t.replace(/[\s—\-–_·]/g, "").replace(/[\u{1F300}-\u{1F9FF}]/gu, "").trim();
        const normExisting = normalizeTitle(existing.title);
        const normItem = normalizeTitle(item.title);
        // Same normalized title and overlapping content
        if (normExisting === normItem && normExisting.length > 5 && existing.data && item.data) {
          const shorterLen = Math.min(existing.data.length, item.data.length);
          if (shorterLen > 50) {
            const shorter = existing.data.length <= item.data.length ? existing.data : item.data;
            const longer = existing.data.length > item.data.length ? existing.data : item.data;
            if (longer.includes(shorter.slice(0, Math.min(200, shorter.length)))) return true;
          }
        }
        // Same title (exact) and overlapping content
        if (existing.title === item.title && existing.data && item.data) {
          const shorterLen = Math.min(existing.data.length, item.data.length);
          if (shorterLen > 50) {
            const shorter = existing.data.length <= item.data.length ? existing.data : item.data;
            const longer = existing.data.length > item.data.length ? existing.data : item.data;
            if (longer.includes(shorter.slice(0, Math.min(200, shorter.length)))) return true;
          }
        }
        return false;
      });
      if (isDuplicate) {
        console.log(`[Agent] Dedup: skipping duplicate push_content "${item.title}"`);
        return false;
      }
      // Warn about empty data
      if (!item.data || item.data.length === 0) {
        console.warn(`[Agent] push_content "${item.title}" has empty data`);
      }
      pushedContents.push(item);
      return true;
    }
    const sessionWorkflowIds = new Set<string>();

    // Debounce timer for incremental draft updates
    let draftUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    let flushInProgress: Promise<void> | null = null;
    const DEBOUNCE_MS = 5000;

    const finishArtifactRe = /Used tools: \[finish\([^[\]]*\]\s*/g;
    const flushDraftUpdate = () => {
      draftUpdateTimer = null;
      // Persist whenever ANY content exists — not just text.
      // Tool-only runs also need draft persistence (tool calls, pushed contents).
      const hasContent = fullContent || thinkingContent || toolCalls.length > 0 || pushedContents.length > 0;
      if (!hasContent) return;

      const clean = fullContent.replace(finishArtifactRe, "").trimEnd();
      // Include pushedContents in incremental updates so data survives disconnects.
      const meta: Record<string, unknown> = { draft: true, taskId };
      if (pushedContents.length > 0) meta.pushedContents = pushedContents;
      if (thinkingContent) meta.thinkingContent = thinkingContent;
      // Persist tool calls incrementally so they survive server crashes
      if (toolCalls.length > 0) {
        meta.toolCalls = toolCalls.map((tc) => ({
          id: tc.id,
          toolName: tc.toolName,
          status: tc.status,
          inputSummary: JSON.stringify(tc.input).slice(0, 200),
          outputSummary: (tc.output || "").slice(0, 200),
        }));
      }
      flushInProgress = repos.message.updateContent(draftMsg.id, clean || fullContent || "", meta)
        .catch((flushErr) => {
          console.warn(`[Agent] flushDraftUpdate failed for task ${taskId}:`, flushErr instanceof Error ? flushErr.message : String(flushErr));
        })
        .then(() => { flushInProgress = null; }) as unknown as Promise<void>;
    };

    const scheduleDraftUpdate = () => {
      if (draftUpdateTimer) clearTimeout(draftUpdateTimer);
      draftUpdateTimer = setTimeout(flushDraftUpdate, DEBOUNCE_MS);
    };

    // Subscribe to workflow sub-agent events and forward relevant ones to buffer.
    //
    // Filter strategy (revised 2026-06-26, see plan floating-swimming-hopper.md RR2):
    //   Primary filter: event.sessionId === handlerSessionId
    //     - sessionId is written by WorkflowEngine from this.input.sessionId (stable,
    //       not dependent on ALS propagation), making it more reliable than parentTaskId.
    //     - Cross-session isolation is the actual safety requirement.
    //   Secondary filter: sessionWorkflowIds whitelist
    //     - Used when event.sessionId is missing (legacy events or malformed).
    //     - Allows tolerance for workflow_start race conditions (registered late via
    //       the tool_result dispatched fallback at line ~1036).
    //
    // Why not filter by parentTaskId anymore:
    //   - parentTaskId comes from ALS and can be undefined when ALS context is lost
    //     (e.g., delegate_task called inside a sub-agent whose runner.run() doesn't
    //     re-enter ALS). Hard-filtering on parentTaskId caused valid workflow_start
    //     events to be silently dropped, never reaching taskEventBuffer for replay.
    //   - Same-session multi-task scenarios: seeing all session workflows on each SSE
    //     is acceptable — the frontend dedupes workflow cards by workflowId.
    const handlerSessionId = body.sessionId as string;
    const workflowEventHandler = (event: Record<string, unknown>) => {
      const etype = event.type as string;

      const eventWfId = event.workflowId as string | undefined;
      const eventSessionId = event.sessionId as string | undefined;

      // Primary filter: cross-session isolation (hard filter)
      // If event has sessionId and it doesn't match handler's session, drop.
      // Missing sessionId → fall through to secondary filter.
      if (eventSessionId && eventSessionId !== handlerSessionId) {
        return;
      }

      if (etype === "workflow_start" && eventWfId) {
        // Register workflowId (no parentTaskId check anymore).
        // Logs the parentTaskId (if present) for diagnostics.
        sessionWorkflowIds.add(eventWfId);
        console.log(
          `[SSE ${taskId}] registered workflow ${eventWfId} (parent=${(event.parentTaskId as string) ?? "(none)"})`,
        );
      } else if (eventWfId && sessionWorkflowIds.size > 0 && !sessionWorkflowIds.has(eventWfId)) {
        // Secondary filter: known workflows exist, but this wfId isn't registered AND
        // event has no sessionId (otherwise primary filter above already handled it).
        // This protects against eventSessionId-missing cross-session leakage.
        return;
      }
      // Note: empty sessionWorkflowIds with missing eventSessionId is allowed through
      // to tolerate the race where workflow_start arrives before tool_result dispatched
      // registers the workflowId.

      if (etype === "workflow_agent_tool_result") {
        const toolName = String(event.toolName || event.tool || "");
        const result = event.result;

        if (toolName === "push_content" && typeof result === "object" && result !== null) {
          const r = result as Record<string, unknown>;
          if (r.pushed && !r.error) {
            const dataStr = String(r.data || "");
            if (!dataStr) {
              console.warn(`[Agent] push_content card "${r.title}" has empty data, filePath=${r.filePath || "(none)"}`);
            }
            const pcItem = {
              type: String(r.type || ""),
              title: String(r.title || ""),
              data: dataStr,
              dataLength: typeof r.dataLength === "number" ? r.dataLength : dataStr.length,
              format: r.format ? String(r.format) : undefined,
              timestamp: r.timestamp ? String(r.timestamp) : undefined,
              filePath: r.filePath ? String(r.filePath) : undefined,
            };
            // Dedup BEFORE pushing to SSE — prevents the frontend from
            // showing duplicate cards that get removed on persistence.
            if (addPushedContent(pcItem)) {
              taskEventBuffer.push(taskId, "push_content", pcItem);
              scheduleDraftUpdate();
            }
          }
        }
      }

      taskEventBuffer.push(taskId, "workflow_event", event);
      console.log(
        `[SSE ${taskId}] push workflow_event type=${etype} wfId=${eventWfId ?? "(none)"} parent=${(event.parentTaskId as string) ?? "(none)"}`,
      );
    };
    globalThis.__workflowEvents?.on("workflow", workflowEventHandler);
    console.log(`[SSE ${taskId}] workflow listener attached; session=${body.sessionId}`);

    // Agent onEvent callback — pushes events to buffer AND forwards to SSE if connected
    const onEvent = (event: AgentEvent) => {
      switch (event.type) {
        case "start":
          taskEventBuffer.push(taskId, "start", { taskId: event.taskId, agentType: event.agentType });
          break;

        case "text_delta":
          taskEventBuffer.push(taskId, "content_delta", { delta: event.delta, taskId: event.taskId, turn: event.turn });
          fullContent += event.delta;
          scheduleDraftUpdate();
          break;

        case "thinking_delta":
          // Store in eventBuffer for debugging/future use, but do NOT push to content_delta
          // or accumulate into fullContent — thinking must not leak into user-visible output.
          // Persist thinking content separately so it survives page reloads.
          taskEventBuffer.push(taskId, "thinking_delta", { delta: event.delta, taskId: event.taskId, turn: event.turn });
          thinkingContent += event.delta;
          break;

        case "content_reset":
          // Recovery retry (max_tokens or tool_call_truncation) is about to re-stream
          // the current turn. Discard the accumulated fullContent from the failed first
          // attempt so savedContent is not polluted with duplicated/concatenated text.
          // Forward to frontend so the UI also clears the partial render.
          fullContent = "";
          taskEventBuffer.push(taskId, "content_reset", { taskId: event.taskId, turn: event.turn, reason: event.reason });
          break;

        case "turn":
          taskEventBuffer.push(taskId, "turn", { turn: event.turn, taskId: event.taskId });
          if (event.content) {
            taskEventBuffer.push(taskId, "content", { content: event.content, accumulated: fullContent });
          }
          break;

        case "turn_usage":
          taskEventBuffer.push(taskId, "turn_usage", { taskId: event.taskId, turn: event.turn, usage: event.usage });
          break;

        case "tool_call": {
          // Use a unique id per tool call to handle multiple calls of the same
          // tool within a single turn (e.g., multiple push_content calls).
          const tcIdx = toolCalls.filter((tc) => tc.toolName === event.toolName).length;
          const tcId = `${event.taskId}-tc-${event.turn}-${tcIdx}-${event.toolName}`;
          const tc = {
            id: tcId,
            toolName: event.toolName,
            input: event.input,
            status: "running" as const,
          };
          toolCalls.push(tc);
          taskEventBuffer.push(taskId, "tool_call", tc);
          break;
        }

        case "tool_result": {
          // Find the earliest "running" entry for this toolName to match the
          // corresponding tool_call.  This pairs each result with the correct
          // call even when the same tool is invoked multiple times per turn.
          const existingTc = toolCalls.find(
            (tc) => tc.toolName === event.toolName && tc.status === "running",
          );
          const tcId = existingTc?.id ?? `${event.taskId}-tc-${event.turn}-${event.toolName}`;
          const outputStr = typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result);
          if (existingTc) {
            existingTc.status = "completed";
            // Strip PG-incompatible chars from tool output to prevent
            // "invalid input syntax for type json" when metadata is persisted to jsonb.
            // JSON.stringify converts \x00 to \u0000 escape sequences; we remove those here
            // because PG's jsonb parser rejects \u0000.
            // Only replace LONE surrogates, not valid surrogate pairs (emoji etc.).
            existingTc.output = outputStr.replace(/\\u0000/g, '')
              .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
          }
          taskEventBuffer.push(taskId, "tool_result", { id: tcId, toolName: event.toolName, output: outputStr });

          if (event.toolName === "push_content" && typeof event.result === "object" && event.result !== null) {
            const r = event.result as Record<string, unknown>;
            if (r.pushed && !r.error) {
              const dataStr = String(r.data || "");
              if (!dataStr) {
                console.warn(`[Agent] push_content card "${r.title}" has empty data, filePath=${r.filePath || "(none)"}`);
              }
              const pcItem = {
                type: String(r.type || ""),
                title: String(r.title || ""),
                data: dataStr,
                dataLength: typeof r.dataLength === "number" ? r.dataLength : dataStr.length,
                format: r.format ? String(r.format) : undefined,
                timestamp: r.timestamp ? String(r.timestamp) : undefined,
                filePath: r.filePath ? String(r.filePath) : undefined,
              };
              // Dedup BEFORE pushing to SSE — prevents duplicate cards in the live stream.
              if (addPushedContent(pcItem)) {
                taskEventBuffer.push(taskId, "push_content", pcItem);
              }
            }
          }

          if (event.toolName === "push_file" && typeof event.result === "object" && event.result !== null) {
            const r = event.result as Record<string, unknown>;
            if (r.pushed && !r.error) {
              const pfItem = {
                type: "file",
                title: String(r.title || ""),
                fileName: String(r.fileName || ""),
                fileSize: typeof r.fileSize === "number" ? r.fileSize : 0,
                mimeType: String(r.mimeType || "application/octet-stream"),
                downloadUrl: String(r.downloadUrl || ""),
                timestamp: r.timestamp ? String(r.timestamp) : undefined,
              };
              taskEventBuffer.push(taskId, "push_content", pfItem);
              addPushedContent(pfItem);
            }
          }

          if (event.toolName === "agent_todo" && typeof event.result === "object" && event.result !== null) {
            taskEventBuffer.push(taskId, "todo_update", event.result);
          }

          if (event.toolName === "ask_user" && typeof event.result === "object" && event.result !== null) {
            const r = event.result as Record<string, unknown>;
            taskEventBuffer.push(taskId, "ask_user_answered", { taskId: event.taskId, answer: r.answer });
          }

          if (event.toolName === "workflow_run" && typeof event.result === "object" && event.result !== null) {
            const r = event.result as Record<string, unknown>;
            if (r.status === "completed" && r.results) {
              taskEventBuffer.push(taskId, "workflow_complete", {
                status: r.status,
                goal: r.goal,
                totalAgents: (r.results as unknown[]).length,
                results: r.results,
              });
            }
            // Background mode: register the workflowId so subsequent workflow_*
            // events from this background workflow are accepted by the SSE filter.
            if (r.status === "dispatched" && typeof r.workflowId === "string") {
              sessionWorkflowIds.add(r.workflowId);
              console.log(`[SSE ${taskId}] registered background workflow ${r.workflowId}`);
            }
          }
          // Sync finish summary into fullContent when the agent put its real answer
          // in the finish summary instead of the conversation text. This ensures
          // the answer is immediately visible in the SSE stream and not just in the
          // final persisted record.
          // NOTE: We append rather than replace to avoid losing previously streamed content
          // (which causes "content disappearing" when the agent loop runs multiple rounds).
          if (event.toolName === "finish" && typeof event.result === "object" && event.result !== null) {
            const r = event.result as Record<string, unknown>;
            const summary = typeof r.summary === "string" ? r.summary : "";
            const cleanStream = fullContent.replace(finishArtifactRe, "").trimEnd();
            if (summary.trim().length > cleanStream.length * 2 && summary.trim().length > 100) {
              // Append summary instead of replacing — preserves all streamed content
              fullContent = fullContent + "\n\n" + summary;
              taskEventBuffer.push(taskId, "content_delta", {
                delta: summary,
                taskId,
                turn: event.turn,
                synthetic: true,  // Flag: this is a backfill, not live streaming
              });
              taskEventBuffer.push(taskId, "content", { content: summary, accumulated: fullContent.replace(finishArtifactRe, "").trimEnd() });
              console.log(`[Agent] Appended finish summary to content (${summary.length} chars, total stream now ${fullContent.length} chars)`);
            }
          }

          // Trigger draft persistence so tool call results survive server crashes
          scheduleDraftUpdate();
          break;
        }

        case "progress":
          taskEventBuffer.push(taskId, "progress", event.progress);
          break;

        case "compaction":
          taskEventBuffer.push(taskId, "compaction", {
            taskId: event.taskId,
            turn: event.turn,
            method: event.method,
            tokensSaved: event.tokensSaved,
          });
          break;

        case "advisory_limit_reached":
          taskEventBuffer.push(taskId, "advisory_limit_reached", {
            taskId: event.taskId,
            turn: event.turn,
          });
          break;

        case "complete":
          taskEventBuffer.push(taskId, "complete", { taskId: event.taskId, output: event.output, toolCalls });
          break;

        case "error":
          taskEventBuffer.push(taskId, "error", { taskId: event.taskId, error: event.error });
          break;

        case "cancelled":
          taskEventBuffer.push(taskId, "cancelled", { taskId: event.taskId });
          break;
      }
    };

    // Fire-and-forget the agent run in the background (with concurrency limit)
    const useGenerator = process.env.DA_GENERATOR_RUN === "true";
    const runPromise = (async () => {
      // Wait if at global or per-session concurrency limit
      while (
        activeAgentRuns >= MAX_CONCURRENT_AGENT_RUNS ||
        (activePerSession.get(body.sessionId) ?? 0) >= MAX_CONCURRENT_PER_SESSION
      ) {
        await new Promise((r) => setTimeout(r, 200));
      }
      activeAgentRuns++;
      activePerSession.set(body.sessionId, (activePerSession.get(body.sessionId) ?? 0) + 1);
      try {
        // Wrap execution in AsyncLocalStorage for per-task context isolation.
        const result = await agentAsyncContext.run(taskContext, async () => {
        const runOptions = {
          input: body.input,
          mediaIds: body.mediaIds,
          agentType: body.agentType || "general",
          taskId,
          sessionId: body.sessionId,
          maxTurns: body.maxTurns,
          contextMessages,
          scope: resolveScope(body, session),
        };

        if (useGenerator) {
          // Generator path: consume events via for-await-of
          const gen = orchestrator.runSingleGenerator({ ...runOptions });
          let genResult: AgentResult | undefined;
          while (true) {
            const next = await gen.next();
            if (next.done) {
              genResult = next.value;
              break;
            }
            // Forward events to the same callback handler
            onEvent(next.value as AgentEvent);
          }
          return genResult!;
        } else {
          // Default path: callback-based run
          return await orchestrator.runSingle({
            ...runOptions,
            onEvent,
          });
        }
        }); // end agentAsyncContext.run()

        // ── Final save (inside IIFE, guaranteed to execute) ──
        if (draftUpdateTimer) { clearTimeout(draftUpdateTimer); draftUpdateTimer = null; }

        // Wait for any in-flight flushDraftUpdate to complete before the final save
        // to prevent concurrent writes to the same message row.
        if (flushInProgress) { await flushInProgress; }

        const agentFailed = result.output?.startsWith("Agent failed:") ?? false;

        // result.output is the agent's final answer (selected by bestOutput priority:
        // pushedContent > accumulatedContent > lastAssistantContent > finishSummary).
        // fullContent is the running total of ALL streamed text across ALL turns.
        // result.output is authoritative — it is assembled by AgentRunner from
        // accumulatedContent/lastAssistantContent, which already handles multi-turn
        // continuation correctly. Only fall back to fullContent when result.output is
        // empty (e.g. agent crashed before producing any final answer).
        // NOTE: fullContent can be polluted by recovery retries (max_tokens / tool_call
        // truncation) that re-stream the same turn. content_reset events mitigate this,
        // but preferring result.output avoids any residual risk of duplicated content.
        let savedContent = result.output || fullContent || "";

        // Strip "Used tools: [finish(...)]" from persisted output.
        savedContent = savedContent.replace(/Used tools: \[finish\([^[\]]*\]\s*/g, "").trimEnd();

        if (!savedContent && pushedContents.length > 0) {
          savedContent = `[${pushedContents.length}个内容卡片已推送]`;
        }

        // Fallback: ensure the message always has visible content so the
        // response doesn't appear to "disappear" after an abnormal run.
        if (!savedContent) {
          savedContent = "[本次执行未产生文本输出]";
        }

        // Preserve taskId in metadata so the frontend can match the streaming
        // message (temp ID) to this persisted message (UUID) during reload.
        const metadata: Record<string, unknown> = { draft: false, taskId };
        if (pushedContents.length > 0) {
          metadata.pushedContents = pushedContents;
        }

        // Process trace: combine model thinking + all streaming text into the gray section.
        // - thinkingContent: <think/> blocks + API reasoning (always included)
        // - fullContent: all visible streaming text (included only if different from savedContent
        //   to avoid duplicating the final answer in simple Q&A scenarios)
        const processTrace: string[] = [];
        if (thinkingContent) processTrace.push(thinkingContent);
        if (fullContent) {
          const cleanedStream = fullContent.replace(finishArtifactRe, "").trimEnd();
          if (cleanedStream && cleanedStream !== savedContent) {
            processTrace.push(cleanedStream);
          }
        }
        if (processTrace.length > 0) {
          metadata.thinkingContent = processTrace.join("\n\n---\n\n");
        }

        if (toolCalls.length > 0) {
          metadata.toolCalls = toolCalls.map((tc) => ({
            id: tc.id,
            toolName: tc.toolName,
            status: tc.status,
            inputSummary: JSON.stringify(tc.input).slice(0, 200),
            outputSummary: (tc.output || "").slice(0, 200),
          }));
        }

        // Update draft message with final content
        await repos.message.updateContent(draftMsg.id, savedContent || "", metadata);

        // Mark the buffer as completed and push the done event
        taskEventBuffer.markCompleted(taskId);
        taskEventBuffer.push(taskId, "done", {
          taskId: result.taskId,
          status: agentFailed ? "failed" : "completed",
          output: result.output || savedContent || undefined,
          turnsUsed: result.turnsUsed,
          usage: result.usage,
          compactionEvents: result.compactionEvents,
          estimatedCostUsd: result.estimatedCostUsd,
        });

        return result;
      } catch (err) {
        if (draftUpdateTimer) { clearTimeout(draftUpdateTimer); draftUpdateTimer = null; }
        const errorMsg = errorMessage(err);
        console.error(`[Agent] Task ${taskId} failed in session ${body.sessionId}: ${errorMsg}`, err instanceof Error ? err.stack : '');
        taskEventBuffer.markCompleted(taskId);
        taskEventBuffer.push(taskId, "error", { taskId, error: errorMsg });
        taskEventBuffer.push(taskId, "done", { taskId, status: "failed", error: errorMsg });
        // Update draft with error
        await repos.message.updateContent(draftMsg.id, `Agent failed: ${errorMsg}`, { draft: false }).catch(() => {});
        throw err;
      } finally {
        activeAgentRuns--;
        const newSessionCount = (activePerSession.get(body.sessionId) ?? 1) - 1;
        if (newSessionCount > 0) activePerSession.set(body.sessionId, newSessionCount);
        else activePerSession.delete(body.sessionId);
        deleteActiveContext(taskId);

        // Deferred workflow listener removal: if the session still has active
        // background workflows, keep the listener attached so their events
        // (workflow_complete etc.) continue to be forwarded to the task buffer.
        // The listener is detached once all workflows finish or a 5-minute
        // hard timeout elapses (prevents indefinite listener leaks).
        const detachListener = () => {
          globalThis.__workflowEvents?.off("workflow", workflowEventHandler);
        };
        const wfManager = getWorkflowManager();
        const hasActive = wfManager.hasActive(body.sessionId);
        console.log(`[SSE ${taskId}] listener detach decision: hasActive=${hasActive}`);
        if (hasActive) {
          console.log(`[SSE ${taskId}] session has active workflows; deferring listener removal`);
          const hardTimeout = setTimeout(() => {
            console.warn(`[SSE ${taskId}] force-detaching workflow listener after 5min hard timeout`);
            detachListener();
          }, 5 * 60 * 1000);
          const poll = setInterval(() => {
            if (!wfManager.hasActive(body.sessionId)) {
              clearTimeout(hardTimeout);
              clearInterval(poll);
              detachListener();
              console.log(`[SSE ${taskId}] all session workflows done; listener detached`);
            }
          }, 2000);
          if (poll.unref) poll.unref();
          if (hardTimeout.unref) hardTimeout.unref();
        } else {
          detachListener();
        }
      }
    })();

    // SSE stream: subscribe to buffer events and forward to client
    return stream(c, async (s) => {
      const sendEvent = (event: string, data: unknown) => {
        try {
          s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (writeErr) {
          console.warn(`[SSE] write failed for event ${event}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
        }
      };

      let aborted = false;

      // Keepalive heartbeat
      let keepaliveTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        if (!aborted) {
          s.write(": keepalive\n\n");
        }
      }, 15_000);

      // On client disconnect: do NOT cancel the task, just stop forwarding
      s.onAbort(() => {
        aborted = true;
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      });

      // Subscribe to live events from the buffer
      const unsubscribe = taskEventBuffer.subscribe(taskId, (event, data) => {
        if (!aborted) {
          sendEvent(event, data);
        }
      });

      try {
        // Wait until the buffer is marked completed (done event pushed)
        await new Promise<void>((resolve) => {
          const check = () => {
            if (aborted || taskEventBuffer.isCompleted(taskId)) {
              resolve();
            } else {
              setTimeout(check, 500);
            }
          };
          check();
        });
      } finally {
        unsubscribe();
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // GET /stream/:taskId - Reconnect to a running (or completed) agent task
  // -----------------------------------------------------------------------
  // Replays all buffered events, then subscribes to live events if the task
  // is still running. If completed, replays and sends done immediately.
  // Returns 404 if the taskId is not found in the buffer (server restarted).
  // -----------------------------------------------------------------------
  router.get("/stream/:taskId", async (c) => {
    const taskId = c.req.param("taskId");

    if (!taskEventBuffer.has(taskId)) {
      return c.json({ error: "Task not found or buffer expired" }, 404);
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    return stream(c, async (s) => {
      const sendEvent = (event: string, data: unknown) => {
        s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let aborted = false;

      s.onAbort(() => { aborted = true; });

      // Keepalive heartbeat
      const keepaliveTimer = setInterval(() => {
        if (!aborted) s.write(": keepalive\n\n");
      }, 15_000);

      // Replay all buffered events
      const history = taskEventBuffer.getEvents(taskId);
      for (const evt of history) {
        if (aborted) break;
        sendEvent(evt.event, evt.data);
      }

      if (taskEventBuffer.isCompleted(taskId)) {
        // Task already done — replay included the done event, just close
        if (!aborted) s.write("event: reconnect_done\ndata: {}\n\n");
      } else {
        // Task still running — subscribe to live events
        const unsubscribe = taskEventBuffer.subscribe(taskId, (event, data) => {
          if (!aborted) sendEvent(event, data);
        });

        // Wait until the task completes or the client disconnects
        await new Promise<void>((resolve) => {
          const check = () => {
            if (aborted || taskEventBuffer.isCompleted(taskId)) {
              resolve();
            } else {
              setTimeout(check, 500);
            }
          };
          check();
        });

        unsubscribe();
      }

      clearInterval(keepaliveTimer);
    });
  });

  // -----------------------------------------------------------------------
  // POST /run-coordinated - Run a coordinated multi-agent workflow
  // -----------------------------------------------------------------------
  router.post("/run-coordinated", async (c) => {
    const body = await c.req.json<RunCoordinatedRequest>();

    if (!body.sessionId || !body.input) {
      return c.json(
        { error: "sessionId and input are required" },
        400,
      );
    }

    const repos = await getRepos();
    const session = await repos.session.get(body.sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Save user message to the chat session
    await repos.message.create(body.sessionId, "user", body.input);

    // Auto-name the session from this first user message (fire-and-forget)
    void autoNameSession(repos, body.sessionId, body.input);

    // Run the coordinated workflow in the background. We return the parent
    // task ID immediately and let the client poll for results.
    const parentTaskId = await startCoordinatedRun(
      orchestrator,
      body.input,
      body.sessionId,
    );

    return c.json({
      taskId: parentTaskId,
      status: "running",
    });
  });

  // -----------------------------------------------------------------------
  // POST /run-skill - Run a skill as an agent task
  // -----------------------------------------------------------------------
  router.post("/run-skill", async (c) => {
    const body = await c.req.json<RunSkillRequest>();

    if (!body.sessionId || !body.skillId) {
      return c.json(
        { error: "sessionId and skillId are required" },
        400,
      );
    }

    if (!body.useAgentSkills && (!body.variables || typeof body.variables !== "object")) {
      return c.json(
        { error: "variables must be a non-null object" },
        400,
      );
    }

    const repos = await getRepos();
    const session = await repos.session.get(body.sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    try {
      let systemPrompt: string;
      let toolsOverride: string[] | undefined;
      let skillName: string;

      if (body.useAgentSkills) {
        // Look up skill from agent_skills table
        const agentSkill = await repos.agentSkill.get(body.skillId);
        if (!agentSkill) {
          return c.json({ error: `Agent skill "${body.skillId}" not found.` }, 404);
        }
        systemPrompt = agentSkill.prompt;
        toolsOverride = agentSkill.tools;
        skillName = agentSkill.name;
      } else {
        // Legacy: look up skill from skills table via plugin manager
        const pluginManager = await getPluginManager();

        const skill = await pluginManager.getSkill(body.skillId);
        if (!skill) {
          return c.json({ error: `Skill "${body.skillId}" not found.` }, 404);
        }

        // Resolve the system prompt with provided variables
        systemPrompt = await pluginManager.resolveSkillPrompt(
          body.skillId,
          body.variables,
        );
        toolsOverride = skill.tools;
        skillName = skill.name;
      }

      // Build the full user input
      const userInput = body.input ?? "Execute the skill task.";

      // Save user message to the chat session
      await repos.message.create(
        body.sessionId,
        "user",
        `[Skill: ${skillName}] ${userInput}`,
      );

      // Auto-name the session from the skill input (fire-and-forget)
      void autoNameSession(repos, body.sessionId, userInput);

      // Run the agent with the skill's system prompt and tools as overrides
      // No maxTurns override — let estimateTaskComplexity() dynamically compute it
      const result = await orchestrator.runSingle({
        input: userInput,
        agentType: "general",
        sessionId: body.sessionId,
        systemPromptOverride: systemPrompt,
        toolsOverride: toolsOverride,
        kbId: body.kbId,
        scope: body.kbId ? { kbIds: [body.kbId] } : undefined,
        isSkillInvocation: true,
      });

      // Save assistant response to the chat session
      if (result.output) {
        await repos.message.create(
          body.sessionId,
          "assistant",
          result.output,
        );
      }

      return c.json({
        taskId: result.taskId,
        status: "completed",
        output: result.output,
        turnsUsed: result.turnsUsed,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
        skillName: skillName,
      });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json(
        {
          taskId: null,
          status: "failed",
          error: errorMsg,
        },
        500,
      );
    }
  });

  // -----------------------------------------------------------------------
  // GET /tasks/:sessionId - List agent tasks for a session
  // -----------------------------------------------------------------------
  router.get("/tasks/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");

    const tasks = await orchestrator.listSessionTasks(sessionId);

    return c.json(tasks.map(taskToResponse));
  });

  // -----------------------------------------------------------------------
  // GET /task/:taskId - Get a single task status
  // -----------------------------------------------------------------------
  router.get("/task/:taskId", async (c) => {
    const taskId = c.req.param("taskId");

    const task = await orchestrator.getTaskStatus(taskId);
    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    return c.json(taskToResponse(task));
  });

  // -----------------------------------------------------------------------
  // POST /cancel/:taskId - Cancel a running task
  // -----------------------------------------------------------------------
  router.post("/cancel/:taskId", (c) => {
    const taskId = c.req.param("taskId");

    const cancelled = orchestrator.cancel(taskId);
    if (!cancelled) {
      return c.json(
        { error: "Task not found or not running" },
        404,
      );
    }

    return c.json({ taskId, status: "cancelled" });
  });

  // -----------------------------------------------------------------------
  // POST /message/:taskId - Send user reply to a pending ask_user question
  // -----------------------------------------------------------------------
  router.post("/message/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json<{ answer?: string }>().catch(() => ({} as { answer?: string }));

    if (!body.answer) {
      return c.json({ error: "answer is required" }, 400);
    }

    const resolved = orchestrator.resolveUserAnswer(taskId, body.answer);
    if (!resolved) {
      return c.json({ error: "No pending question for this task" }, 404);
    }

    return c.json({ taskId, status: "answered" });
  });

  // -----------------------------------------------------------------------
  // POST /inject/:taskId - Inject a follow-up user message into a running task
  // This enables the coordinator to receive new instructions mid-execution.
  // The message is queued in the execution context and injected between turns.
  // -----------------------------------------------------------------------
  router.post("/inject/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json<{ message?: string }>().catch(() => ({} as { message?: string }));

    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }

    const ctx = getActiveContext(taskId);
    if (!ctx) {
      return c.json({ error: "Task not found or already completed" }, 404);
    }

    // Initialize or append to the pending messages queue
    if (!ctx.pendingUserMessages) {
      ctx.pendingUserMessages = [];
    }
    const queue = ctx.pendingUserMessages as Array<{ role: "user"; content: string }>;

    // Build the injected message with context boundary marker
    const lang = /[\u4e00-\u9fa5]/.test(body.message) ? "zh" : "en";
    const framedMessage = lang === "zh"
      ? `以下是用户在任务执行期间追加的新消息。请评估此消息对当前任务的影响：如果是对当前任务的追问或调整，在完成当前工作后处理；如果是紧急指令（如停止、改变方向），优先响应。\n\n${body.message}`
      : `The following is a new message from the user sent during task execution. Evaluate its impact on the current task: if it's a follow-up or adjustment, handle after current work completes; if it's an urgent instruction (e.g., stop, change direction), prioritize it.\n\n${body.message}`;

    queue.push({ role: "user", content: framedMessage });

    // Also persist the message to the session for conversation history continuity
    try {
      const sessionId = ctx.sessionId as string | undefined;
      if (sessionId) {
        const repos = await getRepos();
        await repos.message.create(sessionId, "user", body.message);
      }
    } catch { /* non-critical: message injection is more important than persistence */ }

    return c.json({ taskId, status: "injected", queueLength: queue.length });
  });

  // -----------------------------------------------------------------------
  // POST /transcribe - Transcribe audio via ASR
  // -----------------------------------------------------------------------
  // POST /transcribe - Transcribe audio via ASR
  // Accepts both multipart/form-data (with "file" field) and raw audio body.
  // -----------------------------------------------------------------------
  router.post("/transcribe", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    if (!contentType.includes("multipart/form-data") && !contentType.startsWith("audio/") && !contentType.includes("octet-stream")) {
      return c.json({ error: "Expected multipart/form-data or audio/* content type" }, 400);
    }

    try {
      let audioBuf: ArrayBuffer;
      let audioFilename: string;

      if (contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!file || !(file instanceof Blob)) {
          return c.json({ error: "No 'file' field in multipart body" }, 400);
        }
        audioFilename = file instanceof File ? file.name : "recording.webm";
        audioBuf = await file.arrayBuffer();
      } else {
        audioBuf = await c.req.arrayBuffer();
        const ext = contentType.split("/").pop() ?? "webm";
        audioFilename = `recording.${ext}`;
      }

      if (audioBuf.byteLength === 0) {
        return c.json({ error: "Empty audio body" }, 400);
      }

      // CapabilityDispatcher.transcribeAudio() always tries local Whisper first
      const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
      const dispatcher = new CapabilityDispatcher();
      const result = await dispatcher.transcribeAudio(audioBuf, audioFilename);

      return c.json({
        text: result.text,
        language: result.language,
        duration: result.duration,
      });
    } catch (err) {
      const errorMsg = errorMessage(err);
      return c.json({ error: `Transcription failed: ${errorMsg}` }, 500);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an AgentTask to a JSON-friendly response object.
 * Maps snake_case DB fields to camelCase for the API.
 */
function taskToResponse(task: AgentTask) {
  return {
    id: task.id,
    agentType: task.agentType,
    status: task.status,
    input: task.input,
    output: task.output,
    error: task.error,
    parentId: task.parentId,
    sessionId: task.sessionId,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
}

/**
 * Start a coordinated run in the background. Returns the parent task ID
 * immediately while the workflow continues executing.
 */
async function startCoordinatedRun(
  orchestrator: Orchestrator,
  input: string,
  sessionId: string,
): Promise<string> {
  // Fire off the coordinated run without awaiting it.
  const runPromise = orchestrator.runCoordinated(input, {
    sessionId,
  });

  // When it completes, save the synthesis as an assistant message.
  runPromise.then(async (result) => {
    if (result.synthesis) {
      try {
        const repos = await getRepos();
        await repos.message.create(sessionId, "assistant", result.synthesis);
      } catch { /* session may have been deleted */ }
    }
  }).catch(async (err) => {
    const errorMsg = errorMessage(err);
    try {
      const repos = await getRepos();
      await repos.message.create(
        sessionId,
        "assistant",
        `Coordinated workflow failed: ${errorMsg}`,
      );
    } catch { /* session may have been deleted */ }
  });

  // Give the orchestrator a tick to create the parent task in the DB.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Look up the latest coordinator task for this session.
  const tasks = await orchestrator.listSessionTasks(sessionId);
  const coordinatorTask = tasks.find(
    (t) => t.agentType === "coordinator" && t.status === "running",
  );

  if (coordinatorTask) {
    return coordinatorTask.id;
  }

  // Fallback: return a placeholder. The client will see it via polling.
  return "pending";
}
