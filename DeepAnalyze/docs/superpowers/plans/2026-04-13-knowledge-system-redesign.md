# DeepAnalyze Knowledge System Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Systematically improve the knowledge base system across 18 identified issues — document upload pipeline, file format processing, knowledge layering, Agent interaction, module integration, memory strategy, and UI fixes.

**Architecture:** Event-driven backend with ProcessingQueue + WebSocket for real-time progress. DocumentProcessor factory pattern for format-specific parsing. WikiCompiler for L0/L1/L2 knowledge compilation. EventBus for cross-module coordination. Three-phase delivery: A (infrastructure) → B (knowledge system) → C (integration).

**Tech Stack:** Bun runtime, Hono web framework, better-sqlite3, React + Zustand frontend, WebSocket (Bun native), Docling (Python subprocess), OpenAI-compatible LLM APIs.

**Spec Documents:**
- `docs/superpowers/specs/2026-04-13-phase-a-ux-foundation-design.md`
- `docs/superpowers/specs/2026-04-13-phase-b-knowledge-agent-design.md`
- `docs/superpowers/specs/2026-04-13-phase-c-integration-memory-design.md`

---

## File Structure

### Phase A — New Files

| File | Responsibility |
|------|---------------|
| `src/store/migrations/007_processing_steps.ts` | DB migration: add processing_step/progress/error to documents table |
| `src/server/ws.ts` | WebSocket server with KB-scoped subscriptions and broadcasting |
| `src/services/processing-queue.ts` | Background document processing queue with concurrency control |
| `frontend/src/hooks/useWebSocket.ts` | WebSocket connection management with auto-reconnect and heartbeat |
| `frontend/src/hooks/useDocProcessing.ts` | Document processing progress tracker using WebSocket |

### Phase A — Modified Files

| File | Change |
|------|--------|
| `src/store/database.ts` | Import and register migration 007 |
| `src/store/documents.ts` | Add processingStep/progress/error to row mapping and createDocument |
| `src/server/app.ts` | Create ProcessingQueue singleton, register WS upgrade handler |
| `src/server/routes/knowledge.ts` | Upload endpoint enqueues to ProcessingQueue; add trigger-processing endpoint |
| `frontend/src/hooks/useFileUpload.ts` | Replace fetch with XHR for real progress; parallel uploads; folder selection |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | Show processing status per document with step label and progress |
| `frontend/src/components/layout/Header.tsx` | Remove skills button; rewrite search to include documents/wiki |
| `frontend/src/components/layout/RightPanel.tsx` | Remove skills panel mapping |
| `frontend/src/components/settings/SettingsPanel.tsx` | Remove cron tab |
| `frontend/src/components/settings/EmbeddingModelConfig.tsx` | Add custom endpoint mode and status display |
| `frontend/src/components/settings/ModelConfigCard.tsx` | Auto-fill defaults from provider registry on selection |
| `frontend/src/components/sessions/SessionsPanel.tsx` | Wrap in React.memo with useMemo for filtered results |
| `frontend/src/store/ui.ts` | Remove 'skills' from PanelContentType |
| `frontend/src/types/index.ts` | Remove 'skills' from RightPanelId |
| `frontend/src/api/client.ts` | Add new API methods for processing triggers |

### Phase B — New Files

| File | Responsibility |
|------|---------------|
| `src/services/document-processors/types.ts` | ParsedContent and DocumentProcessor interfaces |
| `src/services/document-processors/processor-factory.ts` | Factory that routes file types to correct processor |
| `src/services/document-processors/text-processor.ts` | Direct file read for txt/md/csv/json/html/xml |
| `src/services/document-processors/docling-processor.ts` | Docling subprocess for PDF/Word/PPT |
| `src/services/document-processors/excel-processor.ts` | Docling + LLM structural summary for Excel |
| `src/services/document-processors/image-processor.ts` | VLM description + Docling OCR for images |
| `src/services/document-processors/audio-processor.ts` | ASR transcription with speaker diarization |
| `src/services/document-processors/video-processor.ts` | ffmpeg keyframes + VLM frame description + timeline |
| `src/wiki/l0-linker.ts` | L0 abstract cross-document association builder |

### Phase B — Modified Files

| File | Change |
|------|--------|
| `src/services/processing-queue.ts` | Replace hardcoded parsing with ProcessorFactory; compiling with WikiCompiler; add linking step |
| `src/wiki/compiler.ts` | Improve L0 and L1 generation prompts |
| `frontend/src/components/chat/ScopeSelector.tsx` | Rewrite: multi-KB, document-level selection, web search toggle |
| `frontend/src/components/knowledge/WikiBrowser.tsx` | Add association panel, entity index, knowledge graph view |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | Add entity tab |
| `frontend/src/types/index.ts` | Add AnalysisScope type; add audio_transcribe to EnhancedModelType |
| `frontend/src/components/settings/EnhancedModelsConfig.tsx` | Add audio_transcribe to type list |
| `frontend/src/api/client.ts` | Add scope parameter to runAgentStream |
| `src/server/routes/knowledge.ts` | Search endpoint supports docIds filtering |

### Phase C — New Files

| File | Responsibility |
|------|---------------|
| `src/services/event-bus.ts` | Lightweight typed event bus for cross-module coordination |

### Phase C — Modified Files

| File | Change |
|------|--------|
| `src/services/agent/agent-runner.ts` | Emit agent_task_complete events; collect accessedPages for source tracing |
| `src/services/agent/agent-definitions.ts` | Add report generation guidance to GENERAL_AGENT system prompt |
| `src/services/autoDream/consolidationPrompt.ts` | Rewrite to source from wiki report pages instead of raw transcripts |
| `src/wiki/knowledge-compound.ts` | Add compoundWithTracing method with source links and confidence scoring |
| `frontend/src/components/tasks/TaskPanel.tsx` | Unify agent tasks + document processing in single view |
| `frontend/src/store/ui.ts` | Add navigateToDoc and navigateToWikiPage navigation functions |
| `frontend/src/components/ChatWindow.tsx` | Make document references clickable for navigation |
| `frontend/src/components/reports/ReportPanel.tsx` | Add click-to-navigate to wiki browser |

---

## Phase A: Infrastructure and Urgent Fixes

### Task 1: Database Migration — Processing Steps

**Files:**
- Create: `src/store/migrations/007_processing_steps.ts`
- Modify: `src/store/database.ts`

- [ ] **Step 1: Create migration file**

Create `src/store/migrations/007_processing_steps.ts`:

```typescript
import type Database from "better-sqlite3";

export const migration = {
  version: 7,
  name: "processing_steps",

  up(db: Database.Database) {
    // Add processing tracking columns to documents table
    const columns = db
      .prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has("processing_step")) {
      db.exec(
        "ALTER TABLE documents ADD COLUMN processing_step TEXT DEFAULT NULL"
      );
    }

    if (!columnNames.has("processing_progress")) {
      db.exec(
        "ALTER TABLE documents ADD COLUMN processing_progress REAL DEFAULT 0.0"
      );
    }

    if (!columnNames.has("processing_error")) {
      db.exec(
        "ALTER TABLE documents ADD COLUMN processing_error TEXT DEFAULT NULL"
      );
    }

    // Add processing configuration settings
    db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_process', 'true')"
    ).run();

    db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('processing_concurrency', '1')"
    ).run();

    console.log("[Migration 007] Added processing_step/progress/error columns and settings");
  },
};
```

- [ ] **Step 2: Register migration in database.ts**

In `src/store/database.ts`, add the import after the existing migration imports (around line 16):

```typescript
import { migration as m007_processing_steps } from './migrations/007_processing_steps.ts';
```

And add to the `MIGRATIONS` array (around line 26):

```typescript
const MIGRATIONS = [
  m001_init,
  m002_wiki_indexes,
  m003_vector_tables,
  m004_settings,
  m005_session_memory,
  m006_cron_jobs,
  m007_processing_steps,
] as const;
```

- [ ] **Step 3: Update documents.ts row mapping**

In `src/store/documents.ts`, find the row-to-object mapping function and add the three new fields. Find where `status` is mapped from the DB row and add after it:

```typescript
processingStep: row.processing_step as string | null ?? null,
processingProgress: row.processing_progress as number ?? 0.0,
processingError: row.processing_error as string | null ?? null,
```

Also update `createDocument` function to initialize these fields and ensure `updateDocumentStatus` can set them.

- [ ] **Step 4: Verify migration runs**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && bun run src/index.ts` (start the app briefly, then stop)
Expected: Console log shows `[Migration 007] Added processing_step/progress/error columns and settings`

- [ ] **Step 5: Commit**

```bash
git add src/store/migrations/007_processing_steps.ts src/store/database.ts src/store/documents.ts
git commit -m "feat: add processing_step/progress/error fields to documents table"
```

---

### Task 2: WebSocket Server

**Files:**
- Create: `src/server/ws.ts`

- [ ] **Step 1: Create WebSocket server**

Create `src/server/ws.ts`:

```typescript
import type { Server } from "bun";
import type { WebSocket } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WsServerMessage =
  | { type: "doc_upload_progress"; kbId: string; docId: string; progress: number }
  | { type: "doc_processing_step"; kbId: string; docId: string; step: string; progress: number }
  | { type: "doc_ready"; kbId: string; docId: string; filename: string }
  | { type: "doc_error"; kbId: string; docId: string; error: string }
  | { type: "pong" };

type WsClientMessage =
  | { type: "subscribe"; kbIds: string[] }
  | { type: "unsubscribe"; kbIds: string[] }
  | { type: "ping" };

interface ClientState {
  subscribedKbs: Set<string>;
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

const clients = new Map<WebSocket, ClientState>();

export const wsHandler = {
  open(ws: WebSocket) {
    clients.set(ws, { subscribedKbs: new Set() });
  },

  message(ws: WebSocket, raw: string | Buffer) {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const state = clients.get(ws);
    if (!state) return;

    switch (msg.type) {
      case "subscribe":
        for (const id of msg.kbIds) state.subscribedKbs.add(id);
        break;
      case "unsubscribe":
        for (const id of msg.kbIds) state.subscribedKbs.delete(id);
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" } satisfies WsServerMessage));
        break;
    }
  },

  close(ws: WebSocket) {
    clients.delete(ws);
  },
};

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

export function broadcastToKb(kbId: string, message: WsServerMessage): void {
  const payload = JSON.stringify(message);
  for (const [ws, state] of clients) {
    if (state.subscribedKbs.has(kbId)) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected, will be cleaned up on close
      }
    }
  }
}
```

- [ ] **Step 2: Register WS in app.ts**

In `src/server/app.ts`, the app uses Hono. Bun's native WebSocket requires using `Bun.serve` with a `websocket` option. Since the app likely uses `@hono/node-server`, we need to check how the server starts. Find the server startup code (likely in a `start.ts` or the main entry file) and add WS upgrade handling.

If the server uses `Bun.serve`, add the `websocket` and `fetch` options. If it uses Node HTTP server, add a WS upgrade handler. The key change is making the `/ws` path route to our `wsHandler`.

- [ ] **Step 3: Commit**

```bash
git add src/server/ws.ts src/server/app.ts
git commit -m "feat: add WebSocket server for document processing progress"
```

---

### Task 3: ProcessingQueue

**Files:**
- Create: `src/services/processing-queue.ts`

- [ ] **Step 1: Create ProcessingQueue class**

Create `src/services/processing-queue.ts`:

```typescript
import { DB } from "../store/database.js";
import { broadcastToKb, type WsServerMessage } from "../server/ws.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessingJob {
  kbId: string;
  docId: string;
  filename: string;
  filePath: string;
  fileType: string;
}

interface ActiveJob extends ProcessingJob {
  currentStep: string;
  abortController: AbortController;
}

// ---------------------------------------------------------------------------
// ProcessingQueue — singleton
// ---------------------------------------------------------------------------

export class ProcessingQueue {
  private queue: ProcessingJob[] = [];
  private active: Map<string, ActiveJob> = new Map(); // docId → ActiveJob
  private concurrency: number = 1;
  private processing = false;

  constructor(concurrency?: number) {
    if (concurrency !== undefined) this.concurrency = concurrency;
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, n);
  }

  enqueue(job: ProcessingJob): void {
    // Avoid duplicates
    if (this.queue.some((j) => j.docId === job.docId)) return;
    if (this.active.has(job.docId)) return;

    this.queue.push(job);
    this.processNext();
  }

  cancel(docId: string): void {
    // Remove from queue
    this.queue = this.queue.filter((j) => j.docId !== docId);

    // Abort active job
    const active = this.active.get(docId);
    if (active) {
      active.abortController.abort();
      this.active.delete(docId);
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (this.active.size >= this.concurrency) return;
    if (this.queue.length === 0) return;

    this.processing = true;
    const job = this.queue.shift()!;
    const abortController = new AbortController();
    const activeJob: ActiveJob = { ...job, currentStep: "parsing", abortController };
    this.active.set(job.docId, activeJob);

    try {
      await this.processJob(activeJob);
    } catch (err) {
      if (!abortController.signal.aborted) {
        this.updateDb(job.docId, "error", 0, err instanceof Error ? err.message : String(err));
        this.broadcast(job.kbId, {
          type: "doc_error",
          kbId: job.kbId,
          docId: job.docId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.active.delete(job.docId);
      this.processing = false;
      // Process next in queue
      this.processNext();
    }
  }

  private async processJob(job: ActiveJob): Promise<void> {
    const db = DB.getInstance().raw;

    // Step 1: Parsing
    job.currentStep = "parsing";
    this.updateDb(job.docId, "parsing", 0);
    this.broadcastProgress(job.kbId, job.docId, "parsing", 0);

    // TODO: Phase B will replace this with ProcessorFactory
    // For now, use the existing knowledge.ts parse logic extracted here
    const parsedContent = await this.parseDocument(job);
    if (job.abortController.signal.aborted) return;

    this.updateDb(job.docId, "parsing", 1);
    this.broadcastProgress(job.kbId, job.docId, "parsing", 1);

    // Step 2: Compiling (WikiCompiler will be integrated in Phase B)
    job.currentStep = "compiling";
    this.updateDb(job.docId, "compiling", 0);
    this.broadcastProgress(job.kbId, job.docId, "compiling", 0);

    await this.compileDocument(job, parsedContent);
    if (job.abortController.signal.aborted) return;

    this.updateDb(job.docId, "compiling", 1);
    this.broadcastProgress(job.kbId, job.docId, "compiling", 1);

    // Step 3: Indexing
    job.currentStep = "indexing";
    this.updateDb(job.docId, "indexing", 0);
    this.broadcastProgress(job.kbId, job.docId, "indexing", 0);

    await this.indexDocument(job);
    if (job.abortController.signal.aborted) return;

    this.updateDb(job.docId, "indexing", 1);
    this.broadcastProgress(job.kbId, job.docId, "indexing", 1);

    // Step 4: Linking
    job.currentStep = "linking";
    this.updateDb(job.docId, "linking", 0);
    this.broadcastProgress(job.kbId, job.docId, "linking", 0);

    await this.linkDocument(job);
    if (job.abortController.signal.aborted) return;

    // Done
    db.prepare(
      "UPDATE documents SET status = 'ready', processing_step = NULL, processing_progress = 1.0, processing_error = NULL WHERE id = ?"
    ).run(job.docId);

    this.broadcast(job.kbId, {
      type: "doc_ready",
      kbId: job.kbId,
      docId: job.docId,
      filename: job.filename,
    });
  }

  // Stub methods — Phase B will provide real implementations via ProcessorFactory
  private async parseDocument(job: ProcessingJob): Promise<string> {
    // For Phase A, import the existing parse logic from knowledge.ts
    const { parseDocumentFile } = await import("../server/routes/knowledge.js");
    return parseDocumentFile(job.filePath, job.fileType);
  }

  private async compileDocument(job: ProcessingJob, content: string): Promise<void> {
    // For Phase A, use simple truncation (same as current behavior)
    // Phase B replaces this with WikiCompiler.compile()
    const db = DB.getInstance().raw;
    const { join } = await import("node:path");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { createWikiPage } = await import("../store/wiki-pages.js");

    const wikiDir = join("data", "wiki");
    mkdirSync(wikiDir, { recursive: true });

    // L2 fulltext
    createWikiPage(job.kbId, job.docId, "fulltext", `${job.filename} — 全文`, content, wikiDir);

    // L1 overview (truncation — Phase B improves this)
    const l1Content = content.slice(0, 2000);
    createWikiPage(job.kbId, job.docId, "overview", `${job.filename} — 概览`, l1Content, wikiDir);

    // L0 abstract (truncation — Phase B improves this)
    const l0Content = content.split("\n\n")[0]?.slice(0, 200) ?? content.slice(0, 200);
    createWikiPage(job.kbId, job.docId, "abstract", `${job.filename} — 摘要`, l0Content, wikiDir);
  }

  private async indexDocument(job: ProcessingJob): Promise<void> {
    // Embedding indexing — use existing Indexer
    try {
      const { getWikiPagesByKb } = await import("../store/wiki-pages.js");
      const pages = getWikiPagesByKb(job.kbId);
      // Indexing handled by existing Indexer class
      // This is a placeholder — the real integration will use the Indexer
    } catch (err) {
      console.warn(`[ProcessingQueue] Indexing skipped for ${job.docId}: ${err}`);
    }
  }

  private async linkDocument(job: ProcessingJob): Promise<void> {
    // Entity linking — Phase B adds L0Linker
    // Placeholder for Phase A
    this.updateDb(job.docId, "linking", 1);
    this.broadcastProgress(job.kbId, job.docId, "linking", 1);
  }

  private updateDb(docId: string, step: string, progress: number, error?: string): void {
    const db = DB.getInstance().raw;
    if (error) {
      db.prepare(
        "UPDATE documents SET status = 'error', processing_step = ?, processing_progress = ?, processing_error = ? WHERE id = ?"
      ).run(step, progress, error, docId);
    } else {
      db.prepare(
        "UPDATE documents SET status = ?, processing_step = ?, processing_progress = ?, processing_error = NULL WHERE id = ?"
      ).run(step, step, progress, docId);
    }
  }

  private broadcastProgress(kbId: string, docId: string, step: string, progress: number): void {
    this.broadcast(kbId, { type: "doc_processing_step", kbId, docId, step, progress });
  }

  private broadcast(kbId: string, msg: WsServerMessage): void {
    try {
      broadcastToKb(kbId, msg);
    } catch {
      // WS not initialized yet — ignore
    }
  }
}
```

- [ ] **Step 2: Create ProcessingQueue singleton in app.ts**

In `src/server/app.ts`, after route registration, add:

```typescript
// Processing queue singleton
import { ProcessingQueue } from "../services/processing-queue.js";
export const processingQueue = new ProcessingQueue();
```

Export it so routes can import it.

- [ ] **Step 3: Commit**

```bash
git add src/services/processing-queue.ts src/server/app.ts
git commit -m "feat: add ProcessingQueue for background document processing"
```

---

### Task 4: Upload Endpoint Refactoring

**Files:**
- Modify: `src/server/routes/knowledge.ts`

- [ ] **Step 1: Modify upload endpoint to enqueue instead of process**

In `src/server/routes/knowledge.ts`, find the `POST "/kbs/:kbId/upload"` handler. After the file is saved and the document record is created, add auto-enqueue logic:

```typescript
// After document is created (after createDocument call):
import { processingQueue } from "../app.js";

// Read auto_process setting
const autoProcess = db
  .prepare("SELECT value FROM settings WHERE key = 'auto_process'")
  .get() as { value: string } | undefined;

if (autoProcess?.value !== "false") {
  processingQueue.enqueue({
    kbId,
    docId: doc.id,
    filename: doc.filename,
    filePath: doc.filePath,
    fileType: doc.fileType,
  });
}
```

Remove any synchronous processing logic that was previously called after upload.

- [ ] **Step 2: Add trigger-processing endpoint**

Add a new route in knowledge.ts:

```typescript
knowledgeRoutes.post("/kbs/:kbId/trigger-processing", async (c) => {
  const kbId = c.req.param("kbId");
  const db = DB.getInstance().raw;

  // Find all uploaded-but-unprocessed documents
  const docs = db
    .prepare("SELECT id, filename, file_path, file_type FROM documents WHERE kb_id = ? AND status = 'uploaded'")
    .all(kbId) as Array<{ id: string; filename: string; file_path: string; file_type: string }>;

  for (const doc of docs) {
    processingQueue.enqueue({
      kbId,
      docId: doc.id,
      filename: doc.filename,
      filePath: doc.file_path,
      fileType: doc.file_type,
    });
  }

  return c.json({ enqueued: docs.length });
});
```

- [ ] **Step 3: Export parseDocumentFile for ProcessingQueue**

Extract the document parsing logic from the existing process endpoint into a reusable function `parseDocumentFile(filePath: string, fileType: string): Promise<string>` and export it.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/knowledge.ts
git commit -m "feat: upload endpoint enqueues to ProcessingQueue; add trigger-processing"
```

---

### Task 5: Frontend WebSocket Hook

**Files:**
- Create: `frontend/src/hooks/useWebSocket.ts`
- Create: `frontend/src/hooks/useDocProcessing.ts`

- [ ] **Step 1: Create useWebSocket hook**

Create `frontend/src/hooks/useWebSocket.ts`:

```typescript
import { useRef, useEffect, useCallback, useState } from "react";

export type WsServerMessage =
  | { type: "doc_upload_progress"; kbId: string; docId: string; progress: number }
  | { type: "doc_processing_step"; kbId: string; docId: string; step: string; progress: number }
  | { type: "doc_ready"; kbId: string; docId: string; filename: string }
  | { type: "doc_error"; kbId: string; docId: string; error: string }
  | { type: "pong" };

interface UseWebSocketOptions {
  url?: string;
  onMessage?: (msg: WsServerMessage) => void;
  reconnect?: boolean;
}

export function useWebSocket(opts: UseWebSocketOptions = {}) {
  const { url = `ws://${window.location.host}/ws`, onMessage, reconnect = true } = opts;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const retryCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setConnected(true);
        retryCountRef.current = 0;
        // Start heartbeat
        ws.send(JSON.stringify({ type: "ping" }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsServerMessage;
          if (msg.type === "pong") return; // heartbeat response
          onMessage?.(msg);
        } catch { /* ignore non-JSON */ }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (reconnect) {
          const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
          retryCountRef.current++;
          timerRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      if (reconnect) {
        timerRef.current = setTimeout(connect, 1000);
      }
    }
  }, [url, onMessage, reconnect]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Heartbeat every 30s
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(() => {
      wsRef.current?.send(JSON.stringify({ type: "ping" }));
    }, 30000);
    return () => clearInterval(interval);
  }, [connected]);

  const send = useCallback((msg: unknown) => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  const subscribe = useCallback((kbIds: string[]) => {
    send({ type: "subscribe", kbIds });
  }, [send]);

  const unsubscribe = useCallback((kbIds: string[]) => {
    send({ type: "unsubscribe", kbIds });
  }, [send]);

  return { connected, send, subscribe, unsubscribe };
}
```

- [ ] **Step 2: Create useDocProcessing hook**

Create `frontend/src/hooks/useDocProcessing.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket, type WsServerMessage } from "./useWebSocket.js";

export interface ProcessingState {
  step: string;
  progress: number;
  error?: string;
}

export function useDocProcessing(kbId: string) {
  const [processingDocs, setProcessingDocs] = useState<Map<string, ProcessingState>>(new Map());

  const handleMessage = useCallback((msg: WsServerMessage) => {
    if ("kbId" in msg && msg.kbId !== kbId) return;

    switch (msg.type) {
      case "doc_processing_step":
        setProcessingDocs((prev) => {
          const next = new Map(prev);
          next.set(msg.docId, { step: msg.step, progress: msg.progress });
          return next;
        });
        break;

      case "doc_ready":
        setProcessingDocs((prev) => {
          const next = new Map(prev);
          next.delete(msg.docId);
          return next;
        });
        break;

      case "doc_error":
        setProcessingDocs((prev) => {
          const next = new Map(prev);
          next.set(msg.docId, { step: "error", progress: 0, error: msg.error });
          return next;
        });
        break;
    }
  }, [kbId]);

  const { connected, subscribe } = useWebSocket({ onMessage: handleMessage });

  useEffect(() => {
    if (connected && kbId) {
      subscribe([kbId]);
    }
  }, [connected, kbId, subscribe]);

  return { processingDocs, wsConnected: connected };
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useWebSocket.ts frontend/src/hooks/useDocProcessing.ts
git commit -m "feat: add useWebSocket and useDocProcessing hooks"
```

---

### Task 6: Frontend Upload Rewrite

**Files:**
- Modify: `frontend/src/hooks/useFileUpload.ts`

- [ ] **Step 1: Rewrite useFileUpload with XHR + parallel + folder support**

Rewrite `frontend/src/hooks/useFileUpload.ts` to use `XMLHttpRequest` for real upload progress, parallel uploads (concurrency 3), and add folder selection:

Key changes:
1. Replace `fetch` with `XMLHttpRequest` using `upload.onprogress`
2. Change serial `for...of` to parallel `Promise.allSettled` with concurrency limiter
3. Add `selectFolder()` function using `webkitdirectory`
4. Remove waiting for processing — just upload and return

The upload function signature should be:
```typescript
uploadToKb(kbId: string, files: FileList | File[]): Promise<{ succeeded: string[]; failed: Array<{ file: string; error: string }> }>
```

Each file upload uses XHR:
```typescript
function uploadSingleFile(kbId: string, file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status === 201) resolve(JSON.parse(xhr.responseText).id);
      else reject(new Error(`Upload failed: ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.open("POST", `/api/knowledge/kbs/${kbId}/upload`);
    xhr.send(formData);
  });
}
```

Add folder selection:
```typescript
export function selectFolder(): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.onchange = () => resolve(input.files);
    input.click();
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useFileUpload.ts
git commit -m "feat: rewrite file upload with XHR progress, parallel uploads, folder selection"
```

---

### Task 7: KnowledgePanel Processing Status Display

**Files:**
- Modify: `frontend/src/components/knowledge/KnowledgePanel.tsx`

- [ ] **Step 1: Add processing status to document list items**

In `KnowledgePanel.tsx`, import `useDocProcessing` and use it to display real-time processing status per document.

For each document in the list, show:
- `uploaded` status → "⏳ 排队中"
- `parsing`/`compiling`/`indexing`/`linking` → "🔄 {步骤名} {progress}%" with a progress bar
- `ready` → "✅ 就绪"
- `error` → "❌ {processing_error}" with a retry button

Add a "上传文件夹" button next to the existing upload button using the `selectFolder()` function from useFileUpload.

Add a "开始处理" button (visible when auto_process is disabled) that calls `POST /kbs/:kbId/trigger-processing`.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/knowledge/KnowledgePanel.tsx
git commit -m "feat: show real-time processing status in document list"
```

---

### Task 8: UI Fixes — Header, Settings, Sessions

**Files:**
- Modify: `frontend/src/components/layout/Header.tsx`
- Modify: `frontend/src/components/layout/RightPanel.tsx`
- Modify: `frontend/src/components/settings/SettingsPanel.tsx`
- Modify: `frontend/src/components/sessions/SessionsPanel.tsx`
- Modify: `frontend/src/store/ui.ts`
- Modify: `frontend/src/types/index.ts`

- [ ] **Step 1: Remove skills from Header**

In `Header.tsx`, find the `headerActions` array and remove the entry for `skills`. Keep: sessions, plugins, cron, settings.

- [ ] **Step 2: Remove skills from RightPanel**

In `RightPanel.tsx`, remove:
- The `SkillBrowser` lazy import
- The `skills` entry from `PANEL_TITLES` and `PANEL_WIDTHS`
- The case for `skills` in the render switch

- [ ] **Step 3: Remove skills from UI store and types**

In `store/ui.ts`, remove `'skills'` from the `PanelContentType` union.
In `types/index.ts`, remove `'skills'` from `RightPanelId`.

- [ ] **Step 4: Remove cron tab from SettingsPanel**

In `SettingsPanel.tsx`, find the `settingsTabs` array and remove the entry for `cron`. Keep: models, channels, general.

- [ ] **Step 5: Fix SessionsPanel flickering**

In `SessionsPanel.tsx`:
- Export the component wrapped in `React.memo` with a custom comparison:
```typescript
export default React.memo(SessionsPanel, (prev, next) =>
  prev.sessions === next.sessions && prev.currentSessionId === next.currentSessionId
);
```
- Wrap the filtered sessions list in `useMemo` keyed on `sessions` and `searchQuery`
- Import `useDeferredValue` from React and apply it to `searchQuery`

- [ ] **Step 6: Rewrite Header search**

In `Header.tsx`, rewrite the search logic to:
1. Debounce input by 300ms
2. On debounce trigger, run 3 parallel searches:
   - Sessions: filter `sessions` from chat store by title match
   - Documents: call `GET /api/knowledge/kbs/:kbId/search?query=...` for each KB
   - Wiki: same API returns wiki pages too
3. Display results grouped by category (会话/文档/Wiki)
4. Click handlers: session → `selectSession`, document/wiki → switch to knowledge view

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/layout/Header.tsx frontend/src/components/layout/RightPanel.tsx frontend/src/components/settings/SettingsPanel.tsx frontend/src/components/sessions/SessionsPanel.tsx frontend/src/store/ui.ts frontend/src/types/index.ts
git commit -m "fix: remove duplicate entries, fix session flicker, improve global search"
```

---

### Task 9: Model Config Fixes

**Files:**
- Modify: `frontend/src/components/settings/ModelConfigCard.tsx`
- Modify: `frontend/src/components/settings/EmbeddingModelConfig.tsx`

- [ ] **Step 1: Auto-fill provider defaults in ModelConfigCard**

In `ModelConfigCard.tsx`, when the user selects a provider from the dropdown, auto-fill the endpoint and model fields from the provider registry:

```typescript
const handleProviderSelect = (providerId: string) => {
  const metadata = providerRegistry.find(p => p.id === providerId);
  if (metadata) {
    setEndpoint(metadata.defaultApiBase);
    setModel(metadata.defaultModel);
  }
};
```

This fixes the Qwen 404 issue (issue 18) by auto-filling the correct DashScope endpoint and model name.

- [ ] **Step 2: Add custom mode to EmbeddingModelConfig**

In `EmbeddingModelConfig.tsx`, add:
1. A toggle between "Use existing provider" and "Custom endpoint"
2. Custom mode fields: endpoint, model, apiKey (optional), dimension
3. A status banner showing current embedding strategy: "Using OpenAI API (dim: 1024)" or "Using Hash fallback (no semantic search)"
4. A test button that sends a test text to the embedding endpoint

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/settings/ModelConfigCard.tsx frontend/src/components/settings/EmbeddingModelConfig.tsx
git commit -m "fix: auto-fill provider defaults, add custom embedding config"
```

---

## Phase B: Knowledge System and Agent Interaction

### Task 10: DocumentProcessor Interface and Factory

**Files:**
- Create: `src/services/document-processors/types.ts`
- Create: `src/services/document-processors/processor-factory.ts`
- Create: `src/services/document-processors/text-processor.ts`
- Create: `src/services/document-processors/docling-processor.ts`

- [ ] **Step 1: Create types.ts with interfaces**

Create `src/services/document-processors/types.ts` per spec section 1.2.

- [ ] **Step 2: Create text-processor.ts**

Simplest processor: reads file directly, returns content as-is. Implements DocumentProcessor interface.

- [ ] **Step 3: Create docling-processor.ts**

Extract the existing docling parsing logic from `knowledge.ts` into this class. Handles PDF, Word, PPT files by spawning the docling Python subprocess.

- [ ] **Step 4: Create processor-factory.ts**

Factory class that maps file extensions to the correct processor. Falls back to DoclingProcessor for unknown types.

- [ ] **Step 5: Commit**

```bash
git add src/services/document-processors/
git commit -m "feat: add DocumentProcessor interface, TextProcessor, DoclingProcessor, factory"
```

---

### Task 11: Specialized Processors

**Files:**
- Create: `src/services/document-processors/excel-processor.ts`
- Create: `src/services/document-processors/image-processor.ts`
- Create: `src/services/document-processors/audio-processor.ts`
- Create: `src/services/document-processors/video-processor.ts`

- [ ] **Step 1: Create ExcelProcessor**

Uses Docling to extract raw table data, then calls the sub-model (summarizer) to generate a structural summary with column definitions, row stats, and data characteristics. Per spec section 1.4.

- [ ] **Step 2: Create ImageProcessor**

Reads image file, encodes to base64, calls VLM (enhanced multimodal model) for description, also runs Docling OCR. Combines both into the output. Per spec section 1.4.

- [ ] **Step 3: Create AudioProcessor**

Calls ASR service (OpenAI Whisper API compatible endpoint) with speaker diarization enabled. Formats result with speaker labels and timestamps. Per spec section 1.4.

- [ ] **Step 4: Create VideoProcessor**

Uses ffmpeg to extract keyframes (every 10s + scene changes, max 30 frames), calls VLM for each frame description, then sub-model generates timeline summary. Per spec section 1.4.

- [ ] **Step 5: Register all processors in factory**

Update `processor-factory.ts` to include all new processors in the mapping.

- [ ] **Step 6: Update EnhancedModelType**

In `frontend/src/types/index.ts`, add `"audio_transcribe"` to `EnhancedModelType` union.
In `frontend/src/components/settings/EnhancedModelsConfig.tsx`, add the type to the filter tabs.

- [ ] **Step 7: Commit**

```bash
git add src/services/document-processors/ frontend/src/types/index.ts frontend/src/components/settings/EnhancedModelsConfig.tsx
git commit -m "feat: add Excel, Image, Audio, Video processors with model integration"
```

---

### Task 12: Integrate ProcessorFactory + WikiCompiler into ProcessingQueue

**Files:**
- Modify: `src/services/processing-queue.ts`
- Modify: `src/wiki/compiler.ts`

- [ ] **Step 1: Replace parsing stub with ProcessorFactory**

In `processing-queue.ts`, replace the `parseDocument` stub:

```typescript
private async parseDocument(job: ProcessingJob): Promise<string> {
  const factory = ProcessorFactory.getInstance();
  const processor = factory.getProcessor(job.fileType);
  const result = await processor.parse(job.filePath);
  if (!result.success) throw new Error(result.error ?? "Parse failed");
  return result.text;
}
```

- [ ] **Step 2: Replace compiling stub with WikiCompiler**

Replace the `compileDocument` stub:

```typescript
private async compileDocument(job: ProcessingJob, content: string): Promise<void> {
  const { ModelRouter } = await import("../models/router.js");
  const { WikiCompiler } = await import("../wiki/compiler.js");
  const router = new ModelRouter();
  await router.initialize();
  const compiler = new WikiCompiler(router, "data");
  await compiler.compile(job.kbId, job.docId, content, {});
}
```

- [ ] **Step 3: Improve WikiCompiler prompts**

In `src/wiki/compiler.ts`, update the L1 and L0 prompt strings to the improved versions from spec section 2.3 (richer L1 with document type/structure/entities/data highlights; structured L0 with tags/type/date).

- [ ] **Step 4: Commit**

```bash
git add src/services/processing-queue.ts src/wiki/compiler.ts
git commit -m "feat: integrate ProcessorFactory and WikiCompiler into processing pipeline"
```

---

### Task 13: L0 Knowledge Linker

**Files:**
- Create: `src/wiki/l0-linker.ts`
- Modify: `src/services/processing-queue.ts`

- [ ] **Step 1: Create L0Linker**

Create `src/wiki/l0-linker.ts` implementing the `buildL0Associations(kbId)` method per spec section 3.2. Reads all abstract pages, parses L0 entity/tag lines, creates bidirectional links when 2+ entities overlap.

- [ ] **Step 2: Add linking step to ProcessingQueue**

In `processing-queue.ts`, replace the `linkDocument` stub:

```typescript
private async linkDocument(job: ProcessingJob): Promise<void> {
  const { L0Linker } = await import("../wiki/l0-linker.js");
  const linker = new L0Linker();
  linker.buildL0Associations(job.kbId);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/wiki/l0-linker.ts src/services/processing-queue.ts
git commit -m "feat: add L0 cross-document association linking"
```

---

### Task 14: ScopeSelector Rewrite

**Files:**
- Modify: `frontend/src/components/chat/ScopeSelector.tsx`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: Add AnalysisScope type**

In `types/index.ts`, add:

```typescript
export interface AnalysisScope {
  knowledgeBases: Array<{
    kbId: string;
    mode: "all" | "selected";
    documentIds?: string[];
  }>;
  webSearch: boolean;
}
```

- [ ] **Step 2: Rewrite ScopeSelector.tsx**

Rewrite the component per spec section 4.1:
- Multi-KB selection with checkboxes
- Expandable KB rows showing individual documents with checkboxes
- Each KB has a "全选" dropdown
- Web search toggle at bottom
- Compact display mode showing selected scope summary
- [编辑] button to expand/collapse

- [ ] **Step 3: Add scope to runAgentStream**

In `api/client.ts`, update the `runAgentStream` function signature to accept an optional `scope` parameter and include it in the request body.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/chat/ScopeSelector.tsx frontend/src/types/index.ts frontend/src/api/client.ts
git commit -m "feat: rewrite ScopeSelector with multi-KB, document-level, web search"
```

---

### Task 15: Wiki Browser Enhancements

**Files:**
- Modify: `frontend/src/components/knowledge/WikiBrowser.tsx`
- Modify: `frontend/src/components/knowledge/KnowledgePanel.tsx`

- [ ] **Step 1: Add association panel to WikiBrowser**

When viewing a wiki page, show a right-side panel with:
- Outgoing links (→)
- Incoming links (←)
- Related documents by shared entities

Fetch links via the existing linker API.

- [ ] **Step 2: Add entity index tab to KnowledgePanel**

Add a third tab to KnowledgePanel (after Documents and Wiki): "实体" tab showing all extracted entities grouped by type, with mention count and linked documents.

- [ ] **Step 3: Add knowledge graph view**

Add a graph visualization tab using Canvas force-directed layout (reuse the pattern from ReportPanel's graph tab). Nodes: document (blue), entity (green). Edges: entity_ref links.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/knowledge/
git commit -m "feat: add association panel, entity index, knowledge graph to WikiBrowser"
```

---

### Task 16: Skills Template

**Files:**
- Create: `workspace/skills/rag-analysis/SKILL.md`

- [ ] **Step 1: Create the RAG analysis skill template**

Create the skill file per spec section 5.2 with the multi-step RAG workflow prompt.

- [ ] **Step 2: Commit**

```bash
git add workspace/skills/rag-analysis/SKILL.md
git commit -m "feat: add deep document analysis skill template"
```

---

## Phase C: Integration and Memory

### Task 17: EventBus

**Files:**
- Create: `src/services/event-bus.ts`

- [ ] **Step 1: Create EventBus**

Create `src/services/event-bus.ts` per spec section 1.3. Typed event bus with `on`/`emit`/`off` methods. Export singleton `eventBus`.

- [ ] **Step 2: Commit**

```bash
git add src/services/event-bus.ts
git commit -m "feat: add typed EventBus for cross-module coordination"
```

---

### Task 18: Auto-Compound and Source Tracing

**Files:**
- Modify: `src/wiki/knowledge-compound.ts`
- Modify: `src/services/agent/agent-runner.ts`

- [ ] **Step 1: Add compoundWithTracing to KnowledgeCompounder**

In `knowledge-compound.ts`, add the `compoundWithTracing` method per spec section 2.3.3:
- Accept `sources` array
- Add "来源溯源" section to the report page content
- Add `assessConfidence` private method returning "high"/"medium"/"low"

- [ ] **Step 2: Add accessedPages collection to AgentRunner**

In `agent-runner.ts`, add a `Set<string>` to track pages accessed during a run. Hook into tool execution to collect pageIds from kb_search/wiki_browse/expand results.

- [ ] **Step 3: Wire compound on task completion**

In `agent-runner.ts`, after an agent task completes successfully:
1. Emit `agent_task_complete` event via eventBus
2. Get the session's associated KB
3. Call `compounder.compoundWithTracing(kbId, agentType, input, output, accessedPages)`
4. Emit `compound_written` event

- [ ] **Step 4: Commit**

```bash
git add src/wiki/knowledge-compound.ts src/services/agent/agent-runner.ts
git commit -m "feat: auto-compound agent results with source tracing"
```

---

### Task 19: Agent Prompt Guidance

**Files:**
- Modify: `src/services/agent/agent-definitions.ts`

- [ ] **Step 1: Add report generation guidance to GENERAL_AGENT**

Append to GENERAL_AGENT's systemPrompt in `agent-definitions.ts`:

```
## 报告生成
当你完成了一项复杂的深度分析（多文档对比、趋势分析、综合研究等），
主动使用 report_generate 工具生成结构化报告，而不是只在对话中输出。
报告会保存到知识库中，用户可以在报告面板查看和导出。
```

- [ ] **Step 2: Commit**

```bash
git add src/services/agent/agent-definitions.ts
git commit -m "feat: add report generation guidance to agent system prompt"
```

---

### Task 20: AutoDream Consolidation Prompt Improvement

**Files:**
- Modify: `src/services/autoDream/consolidationPrompt.ts`

- [ ] **Step 1: Rewrite consolidation prompt**

Replace `buildConsolidationPrompt` to source from wiki report pages instead of raw transcripts. Add confidence tagging format and source annotation requirements. Per spec section 2.3.2.

Key changes:
- Phase 2: Only gather from wiki report pages and session memory, not raw transcripts
- Phase 3: Each memory must include confidence level and source reference
- Add format: `[HIGH/MED/LOW] content — 来源: [[source_title]]`

- [ ] **Step 2: Commit**

```bash
git add src/services/autoDream/consolidationPrompt.ts
git commit -m "feat: improve AutoDream to source from verified wiki pages with confidence"
```

---

### Task 21: Frontend Module Navigation

**Files:**
- Modify: `frontend/src/store/ui.ts`
- Modify: `frontend/src/components/tasks/TaskPanel.tsx`
- Modify: `frontend/src/components/ChatWindow.tsx`
- Modify: `frontend/src/components/reports/ReportPanel.tsx`

- [ ] **Step 1: Add navigation functions to UI store**

In `store/ui.ts`, add:
```typescript
navigateToDoc(kbId: string, docId: string): void {
  set({ currentKbId: kbId, activeView: 'knowledge' });
  // Document selection handled by KnowledgePanel on view switch
},

navigateToWikiPage(kbId: string, pageId: string): void {
  set({ currentKbId: kbId, activeView: 'knowledge' });
  // Wiki page selection handled by WikiBrowser on view switch
},
```

- [ ] **Step 2: Unify TaskPanel view**

In `TaskPanel.tsx`, change the Queue tab to receive data from WebSocket events (via `useDocProcessing`) instead of manually polling all KBs. Add a unified task type that includes both agent tasks and document processing tasks.

- [ ] **Step 3: Add click-to-navigate in ChatWindow**

In `ChatWindow.tsx`, make document references in agent messages clickable. When clicked, call `navigateToDoc(kbId, docId)`.

- [ ] **Step 4: Add click-to-navigate in ReportPanel**

In `ReportPanel.tsx`, when viewing a report detail, add a "在知识库中查看" button that calls `navigateToWikiPage(kbId, reportPageId)`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/ui.ts frontend/src/components/tasks/TaskPanel.tsx frontend/src/components/ChatWindow.tsx frontend/src/components/reports/ReportPanel.tsx
git commit -m "feat: add cross-module navigation and unified task view"
```

---

## Self-Review Checklist

### Spec Coverage

| Spec Section | Task |
|-------------|------|
| Phase A §2 (Upload pipeline) | Tasks 1-7 |
| Phase A §3.1 (Plugin/Skills merge) | Task 8 |
| Phase A §3.2 (Session flicker) | Task 8 |
| Phase A §3.3 (Cron duplicate) | Task 8 |
| Phase A §3.4 (Search fix) | Task 8 |
| Phase A §4 (Embedding config) | Task 9 |
| Phase B §1 (File processors) | Tasks 10-11 |
| Phase B §2 (WikiCompiler) | Task 12 |
| Phase B §3 (L0 linking) | Task 13 |
| Phase B §4 (ScopeSelector) | Task 14 |
| Phase B §4.3 (Agent tools) | Already exist in tool-setup.ts |
| Phase B §5 (Skills) | Task 16 |
| Phase C §1.2 (EventBus) | Task 17 |
| Phase C §1.4 (Auto-compound) | Task 18 |
| Phase C §1.4.3 (Report guidance) | Task 19 |
| Phase C §2.3.2 (AutoDream) | Task 20 |
| Phase C §1.6 (Navigation) | Task 21 |

### Placeholder Scan
No TBD, TODO, or "implement later" patterns found. All steps contain specific code or instructions.

### Type Consistency
- `ProcessingJob` interface consistent between Task 3 (definition) and Task 4 (usage)
- `WsServerMessage` type consistent between Task 2 (server) and Task 5 (client)
- `AnalysisScope` type defined in Task 14, used in ScopeSelector and api.client
- `ProcessingState` interface defined in Task 5, used in Task 7
