// =============================================================================
// DeepAnalyze - Session Management API Routes
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";
import { getPool } from "../../store/pg.js";
import { SessionReader } from "../../services/session/session-reader.js";
import { existsSync, statSync, createReadStream, rmSync } from "fs";
import { join, resolve, extname, basename } from "path";

/** Build a Content-Disposition header value that handles non-ASCII filenames (RFC 5987). */
function contentDispositionValue(disposition: string, fileName: string): string {
  // If the filename is pure ASCII, use the simple form
  if (/^[\x00-\x7F]*$/.test(fileName)) {
    return `${disposition}; filename="${fileName}"`;
  }
  // RFC 5987: provide both an ASCII fallback and a UTF-8 encoded filename*
  const encoded = encodeURIComponent(fileName);
  const asciiFallback = fileName.replace(/[^\x00-\x7F]/g, "_");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
import { MediaStore } from "../../services/session/media-store.js";
import { getSessionDir, getSessionOutputDir, getTranscriptPath } from "../../services/session/session-paths.js";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";
import { getWorkflowManager } from "../../services/agent/workflow-manager.js";

export const sessionRoutes = new Hono();

/**
 * Normalize kbScope to canonical {knowledgeBases: [{kbId, mode, documentIds?}], webSearch} format.
 * Accepts both canonical {kbId, mode} and legacy {id, type} entry formats.
 * Drops entries missing a valid kbId (prevents "undefined" from poisoning scope resolution).
 */
function normalizeKbScope(scope: Record<string, unknown>): Record<string, unknown> {
  const rawKbs = (scope as Record<string, unknown>).knowledgeBases;
  const kbIds = (scope as Record<string, unknown>).kbIds as string[] | undefined;
  const webSearch = (scope as Record<string, unknown>).webSearch ?? false;

  if (Array.isArray(rawKbs)) {
    const normalized = rawKbs
      .map((kb) => {
        if (!kb || typeof kb !== "object") return null;
        const r = kb as Record<string, unknown>;
        const kbId = (typeof r.kbId === "string" && r.kbId) || (typeof r.id === "string" && r.id) || "";
        if (!kbId) return null;
        const mode = (typeof r.mode === "string" && (r.mode === "all" || r.mode === "selected"))
          ? r.mode
          : (typeof r.type === "string" && r.type === "selected" ? "selected" : "all");
        const documentIds = Array.isArray(r.documentIds) ? r.documentIds.filter((d): d is string => typeof d === "string") : undefined;
        return { kbId, mode, ...(documentIds && documentIds.length > 0 ? { documentIds } : {}) };
      })
      .filter((kb): kb is { kbId: string; mode: "all" | "selected"; documentIds?: string[] } => kb !== null);
    return { knowledgeBases: normalized, webSearch };
  }

  if (Array.isArray(kbIds) && kbIds.length > 0) {
    const normalized = kbIds
      .filter((id): id is string => typeof id === "string" && id !== "")
      .map(kbId => ({ kbId, mode: "all" as const }));
    return { knowledgeBases: normalized, webSearch };
  }

  return { knowledgeBases: [], webSearch };
}

// ---------------------------------------------------------------------------
// Enriched messages cache — avoids repeated DB + JSONL processing
// ---------------------------------------------------------------------------

const enrichedMessagesCache = new Map<string, {
  updatedAt: string;
  messages: any[];
}>();
const CACHE_MAX_SIZE = 50;

function cacheGet(sessionId: string, updatedAt: string): any[] | null {
  const entry = enrichedMessagesCache.get(sessionId);
  if (entry && entry.updatedAt === updatedAt) {
    // Move to end (LRU refresh)
    enrichedMessagesCache.delete(sessionId);
    enrichedMessagesCache.set(sessionId, entry);
    return entry.messages;
  }
  if (entry) enrichedMessagesCache.delete(sessionId);
  return null;
}

function cacheSet(sessionId: string, updatedAt: string, messages: any[]): void {
  // Evict oldest if at capacity
  if (enrichedMessagesCache.size >= CACHE_MAX_SIZE) {
    const oldest = enrichedMessagesCache.keys().next().value;
    if (oldest) enrichedMessagesCache.delete(oldest);
  }
  enrichedMessagesCache.set(sessionId, { updatedAt, messages });
}

const sessionReader = new SessionReader();

// GET / - List all sessions (excludes internal/preprocessing sessions)
sessionRoutes.get("/", async (c) => {
  const repos = await getRepos();
  const sessions = await repos.session.list();
  // Filter out internal system sessions (preprocessing, etc.) to avoid
  // polluting the user-facing session list
  const filtered = sessions.filter(
    (s) => {
      const title = s.title || "";
      return !title.startsWith("[预处理]");
    },
  );
  return c.json(filtered);
});

// POST / - Create a new session
sessionRoutes.post("/", async (c) => {
  const body = await c.req.json<{ title?: string; kbScope?: Record<string, unknown> }>();
  const repos = await getRepos();
  const normalizedScope = body.kbScope ? normalizeKbScope(body.kbScope) : undefined;
  const session = await repos.session.create(body.title, normalizedScope);
  return c.json(session, 201);
});

// POST /:id/media - Upload media file for a session
sessionRoutes.post("/:id/media", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const meta = await MediaStore.save(DEEPANALYZE_CONFIG.dataDir, id, {
    name: file.name,
    type: file.type,
    data: buffer,
  });

  return c.json({
    mediaId: meta.mediaId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    size: meta.size,
  }, 201);
});

// GET /:id/media/:mediaId - Serve media file
sessionRoutes.get("/:id/media/:mediaId", async (c) => {
  const sessionId = c.req.param("id");
  const mediaId = c.req.param("mediaId");
  const type = c.req.query("type") || "original";

  if (type === "thumbnail") {
    const thumbnail = await MediaStore.readThumbnail(DEEPANALYZE_CONFIG.dataDir, sessionId, mediaId);
    if (!thumbnail) {
      return c.json({ error: "Thumbnail not found" }, 404);
    }
    return new Response(thumbnail as unknown as BodyInit, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const result = await MediaStore.readOriginal(DEEPANALYZE_CONFIG.dataDir, sessionId, mediaId);
  if (!result) {
    return c.json({ error: "Media not found" }, 404);
  }

  return new Response(result.data as unknown as BodyInit, {
    headers: {
      "Content-Type": result.mimeType,
      "Cache-Control": "public, max-age=86400",
      "Content-Disposition": contentDispositionValue("inline", result.fileName),
    },
  });
});

// GET /:id/output/:fileName - Serve session output file for download
sessionRoutes.get("/:id/output/:fileName", async (c) => {
  const sessionId = c.req.param("id");
  const fileName = c.req.param("fileName");

  // Security: prevent path traversal
  const safeName = basename(fileName);
  if (safeName !== fileName || safeName.includes("..")) {
    return c.json({ error: "Invalid file name" }, 400);
  }

  const outputDir = getSessionOutputDir(DEEPANALYZE_CONFIG.dataDir, sessionId);
  const filePath = join(outputDir, safeName);

  // Ensure resolved path is under output dir
  if (!resolve(filePath).startsWith(resolve(outputDir))) {
    return c.json({ error: "Access denied" }, 403);
  }

  if (!existsSync(filePath)) {
    return c.json({ error: "File not found" }, 404);
  }

  try {
    const fileStat = statSync(filePath);
    if (!fileStat.isFile()) {
      return c.json({ error: "Not a file" }, 400);
    }

    // Infer Content-Type from extension
    const ext = extname(safeName).toLowerCase().slice(1);
    const mimeMap: Record<string, string> = {
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ppt: "application/vnd.ms-powerpoint",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      pdf: "application/pdf",
      zip: "application/zip",
      "7z": "application/x-7z-compressed",
      rar: "application/vnd.rar",
      tar: "application/x-tar",
      gz: "application/gzip",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      flac: "audio/flac",
      mp4: "video/mp4",
      webm: "video/webm",
      avi: "video/x-msvideo",
      mov: "video/quicktime",
      mkv: "video/x-matroska",
      txt: "text/plain",
      csv: "text/csv",
      json: "application/json",
      xml: "application/xml",
      html: "text/html",
      md: "text/markdown",
    };
    const mimeType = mimeMap[ext] || "application/octet-stream";

    // Use inline for multimedia, attachment for everything else
    const isInline = mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/") || mimeType === "application/pdf";
    const disposition = isInline ? "inline" : "attachment";

    // Handle Range requests for video/audio
    const range = c.req.header("range");
    if (range && (mimeType.startsWith("video/") || mimeType.startsWith("audio/"))) {
      const fileSize = fileStat.size;
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(filePath, { start, end });
      return new Response(stream as unknown as BodyInit, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": mimeType,
          "Content-Disposition": contentDispositionValue(disposition, safeName),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    const stream = createReadStream(filePath);
    return new Response(stream as unknown as BodyInit, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileStat.size),
        "Content-Disposition": contentDispositionValue(disposition, safeName),
        "Cache-Control": "private, max-age=3600",
        "Accept-Ranges": "bytes",
      },
    });
  } catch (err) {
    return c.json({ error: "Failed to read file" }, 500);
  }
});

// GET /:id - Get session by id
sessionRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  return c.json(session);
});

// GET /:id/messages - Get messages for a session
sessionRoutes.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Check cache first — lightweight freshness check via updated_at
  const updatedAt = session.updatedAt;
  const cached = cacheGet(id, updatedAt);
  if (cached) {
    return c.json(cached);
  }

  const messages = await repos.message.list(id);

  // Filter out internal system markers (compact boundaries) that should never be user-visible
  const filtered = messages.filter(m => !m.content?.startsWith('[COMPACT_BOUNDARY:'));

  // Batch collect report IDs from all assistant messages (avoids N+1 queries)
  // Enrich assistant messages with tool calls and pushed contents from metadata
  const enriched = filtered.map((msg) => {
    if (msg.role !== "assistant" || !msg.metadata) {
      // For user messages, try to parse media from content
      if (msg.role === "user" && msg.content && typeof msg.content === "string") {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.media && Array.isArray(parsed.media)) {
            return {
              ...msg,
              content: parsed.text || msg.content,
              media: parsed.media,
            };
          }
        } catch { /* not JSON — plain text message */ }
      }
      return msg;
    }
    try {
      const meta = typeof msg.metadata === "string" ? JSON.parse(msg.metadata) : msg.metadata;
      const result: Record<string, unknown> = {};

      // Tool call enrichment
      if (meta?.toolCalls && Array.isArray(meta.toolCalls)) {
        result.toolCalls = meta.toolCalls;
      }

      // Pushed contents enrichment
      if (meta?.pushedContents && Array.isArray(meta.pushedContents)) {
        result.pushedContents = meta.pushedContents;
      }

      // Thinking content enrichment (persisted from thinking_delta events)
      if (meta?.thinkingContent && typeof meta.thinkingContent === "string") {
        result.thinkingContent = meta.thinkingContent;
      }

      return Object.keys(result).length > 0 ? { ...msg, ...result } : msg;
    } catch {
      return msg;
    }
  });

  // If JSONL transcripts exist, enrich with full data from JSONL
  const transcriptDir = join(getSessionDir(DEEPANALYZE_CONFIG.dataDir, id), "transcripts");
  if (existsSync(transcriptDir)) {
    try {
      const reconstructed = await sessionReader.readSession(DEEPANALYZE_CONFIG.dataDir, id);
      // Add thinking content and full tool call data to enriched messages
      for (const msg of enriched) {
        if (msg.role !== "assistant") continue;

        // Enrich toolCalls (the mapped array from first pass) with full JSONL data
        const msgToolCalls = (msg as Record<string, unknown>).toolCalls;
        if (Array.isArray(msgToolCalls) && msgToolCalls.length > 0) {
          for (const tc of msgToolCalls) {
            const matchingTurn = reconstructed.turns.find(t =>
              t.toolCalls.some(jtc => jtc.toolName === (tc as Record<string, unknown>).toolName)
            );
            if (matchingTurn) {
              const fullTc = matchingTurn.toolCalls.find(
                jtc => jtc.toolName === (tc as Record<string, unknown>).toolName
              );
              if (fullTc) {
                (tc as Record<string, unknown>).fullInput = fullTc.input;
                (tc as Record<string, unknown>).fullOutput = fullTc.output;
                (tc as Record<string, unknown>).hasFullOutput = true;
              }
            }
          }
        }

        // Add thinking content if available
        if (msg.metadata && msg.content && typeof msg.content === "string") {
          const msgTurn = reconstructed.turns.find(t =>
            t.assistantContent &&
            msg.content!.includes(t.assistantContent.substring(0, 50))
          );
          if (msgTurn && msgTurn.thinkingContent) {
            (msg as Record<string, unknown>).thinkingContent = msgTurn.thinkingContent;
          }
        }
      }
    } catch { /* JSONL enrichment is best-effort */ }
  }

  // Store in cache
  cacheSet(id, updatedAt, enriched);

  return c.json(enriched);
});

// GET /:id/transcript - Get full session transcript from JSONL
sessionRoutes.get("/:id/transcript", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const transcriptDir = join(getSessionDir(DEEPANALYZE_CONFIG.dataDir, id), "transcripts");
  if (!existsSync(transcriptDir)) {
    return c.json({ error: "No JSONL transcript available" }, 404);
  }

  try {
    const reconstructed = await sessionReader.readSession(DEEPANALYZE_CONFIG.dataDir, id);
    return c.json(reconstructed);
  } catch (err) {
    return c.json({ error: "Failed to read transcript", details: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /:id/transcript/:taskId - Get a specific task's transcript
sessionRoutes.get("/:id/transcript/:taskId", async (c) => {
  const id = c.req.param("id");
  const taskId = c.req.param("taskId");

  const transcriptPath = getTranscriptPath(DEEPANALYZE_CONFIG.dataDir, id, taskId);
  if (!existsSync(transcriptPath)) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  try {
    const entries = await sessionReader.readTaskTranscript(DEEPANALYZE_CONFIG.dataDir, id, taskId);
    return c.json(entries);
  } catch (err) {
    return c.json({ error: "Failed to read transcript", details: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// PATCH /:id/scope - Update session's KB scope persistence
sessionRoutes.patch("/:id/scope", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ kbScope?: Record<string, unknown> }>();
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  if (body.kbScope) {
    await repos.session.updateKbScope(id, normalizeKbScope(body.kbScope));
  }
  return c.json({ success: true });
});

// PATCH /:id/title - Rename a session
sessionRoutes.patch("/:id/title", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string }>();
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  const title = (body.title ?? "").trim();
  if (!title) {
    return c.json({ error: "Title cannot be empty" }, 400);
  }
  await repos.session.updateTitle(id, title.slice(0, 200));
  return c.json({ success: true });
});

// DELETE /:id - Delete a session
sessionRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();

  // 1. Clean up workflow_logs associated with this session's agent_tasks
  try {
    const pool = await getPool();
    await pool.query(
      `DELETE FROM workflow_logs WHERE workflow_id IN (SELECT id FROM agent_tasks WHERE session_id = $1)`,
      [id]
    );
  } catch { /* best-effort */ }

  // 2. Clean up any session-scoped knowledge bases (named "session-{sessionId}")
  try {
    const pool = await getPool();
    const sessionKbs = await pool.query(
      `SELECT id FROM knowledge_bases WHERE name = $1`,
      [`session-${id}`]
    );
    for (const kb of sessionKbs.rows) {
      for (const sub of ["original", "wiki", "generated"]) {
        try { rmSync(join(DEEPANALYZE_CONFIG.dataDir, sub, kb.id), { recursive: true, force: true }); } catch {}
      }
      await repos.knowledgeBase.delete(kb.id);
    }
  } catch { /* best-effort */ }

  // 3. DB deletion — CASCADE cleans: messages, session_memory, agent_tasks, reports
  const deleted = await repos.session.delete(id);
  if (!deleted) {
    return c.json({ error: "Session not found" }, 404);
  }

  // 4. Clean up in-memory cache
  enrichedMessagesCache.delete(id);

  // 5. Clean up persisted tool results
  try {
    const { cleanupSessionToolResults } = await import("../../services/agent/tool-result-storage.js");
    await cleanupSessionToolResults(DEEPANALYZE_CONFIG.dataDir, id);
  } catch { /* best-effort */ }

  // 6. Clean up session directory (transcripts, media, output, tool-results)
  try {
    const sessionDir = getSessionDir(DEEPANALYZE_CONFIG.dataDir, id);
    if (existsSync(sessionDir)) {
      const { rm } = await import("fs/promises");
      await rm(sessionDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[Session] Failed to remove session directory ${id}:`, err);
  }

  return c.json({ success: true }, 200);
});

// GET /:id/workflows - List workflows for a session (memory + DB)
// Memory: currently running workflows (newest state).
// DB: completed/failed/cancelled historical workflows (survives restarts).
sessionRoutes.get("/:id/workflows", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  const wfManager = getWorkflowManager();
  // listAll merges in-memory (running) + DB (historical), with all fields populated
  const workflows = await wfManager.listAll(id);
  return c.json({ sessionId: id, workflows }, 200);
});
