/**
 * JSONL Writer for lossless session persistence.
 *
 * Design mirrors Claude Code's Project singleton:
 *   - Per-file write queues with 100ms batched flush
 *   - appendFile with auto-mkdir
 *   - uuid/parentUuid chain for topology recovery
 *   - Compact boundaries break the chain (parentUuid = null)
 *
 * File path: data/sessions/{sessionId}/transcripts/{taskId}.jsonl
 */

import { appendFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { TranscriptEntry, EntryBase } from "./entry-types.js";
import { getTranscriptPath } from "./session-paths.js";

// ── Configuration ───────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 100;
const MAX_BUFFER_SIZE = 50;
const MAX_CHUNK_BYTES = 100 * 1024 * 1024; // 100 MB

// ── Helper: read last uuid from existing JSONL (crash recovery) ─────

async function readLastUuid(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.uuid) return entry.uuid;
      } catch {
        // Skip malformed lines
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── JsonlWriter ─────────────────────────────────────────────────────

export class JsonlWriter {
  private filePath: string;
  private buffer: Array<{ entry: TranscriptEntry; resolve: () => void }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDrain: Promise<void> | null = null;
  private lastUuid: string | null = null;
  private closed = false;

  private constructor(
    private dataDir: string,
    private sessionId: string,
    private taskId: string,
  ) {
    this.filePath = getTranscriptPath(dataDir, sessionId, taskId);
  }

  /** Create and initialize a writer. Recovers lastUuid from existing file. */
  static async create(dataDir: string, sessionId: string, taskId: string): Promise<JsonlWriter> {
    const writer = new JsonlWriter(dataDir, sessionId, taskId);
    const dir = dirname(writer.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    writer.lastUuid = await readLastUuid(writer.filePath);
    return writer;
  }

  /** Append an entry. Auto-assigns uuid/parentUuid/timestamp. */
  append(entry: Record<string, unknown> & { type: string }): Promise<void> {
    if (this.closed) return Promise.resolve();
    const fullEntry = this.buildEntry(entry) as TranscriptEntry;
    this.lastUuid = fullEntry.uuid;
    return this.enqueue(fullEntry);
  }

  /** Append a compact boundary. parentUuid is forced to null, immediate flush. */
  appendCompactBoundary(
    entry: Record<string, unknown> & { type: "compact_boundary" },
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    const fullEntry = this.buildEntry(entry, true) as Extract<
      TranscriptEntry,
      { type: "compact_boundary" }
    >;
    // For compact boundary, the NEXT entry should chain from null
    // (but we store the current uuid so we can resume from here)
    this.lastUuid = fullEntry.uuid;
    return this.enqueue(fullEntry);
  }

  /** Flush all buffered entries and mark writer as closed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.drainBuffer();
  }

  /** Get the last uuid written (for crash recovery). */
  getLastUuid(): string | null {
    return this.lastUuid;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private buildEntry(
    partial: Record<string, unknown> & { type: string },
    breakChain = false,
  ): TranscriptEntry {
    const uuid = randomUUID();
    return {
      ...partial,
      uuid,
      parentUuid: breakChain ? null : this.lastUuid,
      timestamp: new Date().toISOString(),
    } as TranscriptEntry;
  }

  private enqueue(entry: TranscriptEntry): Promise<void> {
    return new Promise<void>((resolve) => {
      this.buffer.push({ entry, resolve });
      if (this.buffer.length >= MAX_BUFFER_SIZE) {
        // Over limit — flush immediately
        void this.drainBuffer();
      } else {
        this.scheduleDrain();
      }
    });
  }

  private scheduleDrain(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      this.activeDrain = this.drainBuffer();
      await this.activeDrain;
      this.activeDrain = null;
      if (this.buffer.length > 0) {
        this.scheduleDrain();
      }
    }, FLUSH_INTERVAL_MS);
  }

  private async drainBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Drain all pending items
    const batch = this.buffer.splice(0);

    let content = "";
    const resolvers: Array<() => void> = [];

    for (const { entry, resolve } of batch) {
      const line = JSON.stringify(entry) + "\n";

      if (content.length + line.length >= MAX_CHUNK_BYTES) {
        await this.appendToFile(content);
        for (const r of resolvers) r();
        resolvers.length = 0;
        content = "";
      }

      content += line;
      resolvers.push(resolve);
    }

    if (content.length > 0) {
      await this.appendToFile(content);
      for (const r of resolvers) r();
    }
  }

  private async appendToFile(data: string): Promise<void> {
    try {
      await appendFile(this.filePath, data, { mode: 0o600 });
    } catch {
      // Directory may not exist yet
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, data, { mode: 0o600 });
    }
  }
}

// ── WriterRegistry ──────────────────────────────────────────────────
// Manages all active writers. One writer per (sessionId, taskId) pair.

class WriterRegistry {
  private writers = new Map<string, JsonlWriter>();

  private key(sessionId: string, taskId: string): string {
    return `${sessionId}:${taskId}`;
  }

  /** Get or create a writer for the given session+task. */
  async getOrCreate(dataDir: string, sessionId: string, taskId: string): Promise<JsonlWriter> {
    const k = this.key(sessionId, taskId);
    let writer = this.writers.get(k);
    if (!writer) {
      writer = await JsonlWriter.create(dataDir, sessionId, taskId);
      this.writers.set(k, writer);
    }
    return writer;
  }

  /** Get an existing writer without creating one. */
  get(sessionId: string, taskId: string): JsonlWriter | undefined {
    return this.writers.get(this.key(sessionId, taskId));
  }

  /** Close and remove a writer. */
  async close(sessionId: string, taskId: string): Promise<void> {
    const k = this.key(sessionId, taskId);
    const writer = this.writers.get(k);
    if (writer) {
      await writer.close();
      this.writers.delete(k);
    }
  }

  /** Close all writers (e.g., on shutdown). */
  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const writer of this.writers.values()) {
      promises.push(writer.close());
    }
    await Promise.all(promises);
    this.writers.clear();
  }
}

/** Global singleton registry */
export const writerRegistry = new WriterRegistry();

// ── Cleanup on process exit ─────────────────────────────────────────

process.on("SIGTERM", () => {
  void writerRegistry.closeAll();
});
process.on("SIGINT", () => {
  void writerRegistry.closeAll();
});
