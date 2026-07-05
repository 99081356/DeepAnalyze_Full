// =============================================================================
// DeepAnalyze - Background Document Processing Queue
// Processes uploaded documents through 4 sequential steps:
//   parsing -> compiling -> indexing -> linking
// =============================================================================

import { randomUUID } from "node:crypto";
import { getRepos } from "../store/repos/index.js";
import { ProcessorFactory } from "./document-processors/processor-factory.js";
import { ModelRouter } from "../models/router.js";
import { WikiCompiler } from "../wiki/compiler.js";
import type { ParsedContent } from "./document-processors/types.js";
import { errorMessage } from "../utils/errors.ts";
import { logError } from "../utils/logger.ts";
import { DEEPANALYZE_CONFIG } from "../core/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessingJob {
  kbId: string;
  docId: string;
  filename: string;
  filePath: string;
  fileType: string;
  /** Retry tracking */
  retryCount?: number;
  maxRetries?: number;
  lastError?: string;
  /** Processor override: "auto" | "docling" | "native" | "asr" */
  processor?: string;
  /** Force rebuild: clean up old wiki pages before reprocessing */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Per-file-type timeout configuration (ms)
// ---------------------------------------------------------------------------

const FILE_TYPE_TIMEOUTS: Record<string, number> = {
  // PDF/DOCX/XLSX/CSV/audio: 10 minutes
  pdf: 600_000,
  docx: 600_000,
  doc: 600_000,
  xlsx: 600_000,
  xls: 600_000,
  csv: 600_000,
  mp3: 600_000,
  wav: 600_000,
  flac: 600_000,
  m4a: 600_000,
  aac: 600_000,
  ogg: 600_000,
  // PPTX/MP4: 15 minutes (complex layouts / video extraction)
  pptx: 900_000,
  ppt: 900_000,
  mp4: 900_000,
  avi: 900_000,
  mov: 900_000,
  mkv: 900_000,
  webm: 900_000,
};

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/** Maximum retry attempts */
const MAX_RETRIES = 3;
/** Exponential backoff delays in ms (5s, 10s, 20s) */
const RETRY_DELAYS = [5_000, 10_000, 20_000];

function getTimeoutForFileType(fileType: string): number {
  // Allow env var override
  const envOverride = process.env.JOB_TIMEOUT_MS;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return FILE_TYPE_TIMEOUTS[fileType] ?? DEFAULT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// ProcessingQueue
// ---------------------------------------------------------------------------

/** Active job entry with unique runId to prevent stale .finally() from deleting new entries */
interface ActiveJobEntry {
  abortController: AbortController;
  runId: string;
}

export class ProcessingQueue {
  private queue: ProcessingJob[] = [];
  private active: Map<string, ActiveJobEntry> = new Map();
  private concurrency: number;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(concurrency: number = 5) {
    this.concurrency = concurrency;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Add a job to the queue. Deduplicates by docId — if the same document
   * is already queued or actively processing, the duplicate is silently ignored.
   * Force jobs bypass deduplication and cancel any active job for the same docId.
   */
  enqueue(job: ProcessingJob): void {
    // Force jobs: cancel any existing active/queued job for the same docId
    if (job.force) {
      const queueIndex = this.queue.findIndex((j) => j.docId === job.docId);
      if (queueIndex !== -1) {
        this.queue.splice(queueIndex, 1);
      }
      const entry = this.active.get(job.docId);
      if (entry) {
        entry.abortController.abort();
        this.active.delete(job.docId);
      }
    } else {
      // Deduplicate: skip if already queued
      const alreadyQueued = this.queue.some((j) => j.docId === job.docId);
      if (alreadyQueued) {
        return;
      }

      // Deduplicate: skip if already actively processing
      if (this.active.has(job.docId)) {
        return;
      }
    }

    this.queue.push(job);
    console.log(
      `[ProcessingQueue] Enqueued ${job.filename} (${job.docId}), queue depth=${this.queue.length}`,
    );
    this.scheduleNext();
  }

  /**
   * Cancel a job. Removes it from the queue if pending, or aborts
   * the active job if it is currently being processed.
   */
  async cancel(docId: string): Promise<void> {
    // Remove from queue
    const queueIndex = this.queue.findIndex((j) => j.docId === docId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      console.log(`[ProcessingQueue] Cancelled queued job for ${docId}`);
      return;
    }

    // Abort active job
    const entry = this.active.get(docId);
    if (entry) {
      entry.abortController.abort();
      this.active.delete(docId);
      console.log(`[ProcessingQueue] Aborted active job for ${docId}`);

      // Update DB status
      await this.updateDbStatus(docId, "error", null, 0, "Cancelled by user");

      // Broadcast cancellation
      this.broadcast(docId, "kb", {
        type: "doc_error",
        docId,
        error: "Cancelled by user",
      });
    }
  }

  /**
   * Update the concurrency limit. If increasing, triggers scheduleNext
   * to potentially start more jobs.
   */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, n);
    console.log(`[ProcessingQueue] Concurrency set to ${this.concurrency}`);
    this.scheduleNext();
  }

  // -----------------------------------------------------------------------
  // Queue processing
  // -----------------------------------------------------------------------

  /**
   * Schedule jobs from the queue up to the concurrency limit.
   * Uses a while-loop to fill all available slots in one call.
   */
  private scheduleNext(): void {
    while (this.queue.length > 0 && this.active.size < this.concurrency) {
      const job = this.queue.shift()!;
      if (this.active.has(job.docId)) continue;
      const abortController = new AbortController();
      const runId = randomUUID();
      this.active.set(job.docId, { abortController, runId });
      this.processJob(job, abortController)
        .catch((err: unknown) => {
          console.error(`[ProcessingQueue] Job ${job.docId} failed:`, err);
          logError(err);
        })
        .finally(() => {
          // Only delete if the active entry still belongs to this run
          const current = this.active.get(job.docId);
          if (current && current.runId === runId) {
            this.active.delete(job.docId);
          }
          this.scheduleNext();
        });
    }
  }

  // -----------------------------------------------------------------------
  // Job execution — 4 sequential steps
  // -----------------------------------------------------------------------

  private async processJob(
    job: ProcessingJob,
    abortController: AbortController,
  ): Promise<void> {
    const { kbId, docId, filename, filePath, fileType } = job;
    const timeoutMs = getTimeoutForFileType(fileType);

    console.log(`[ProcessingQueue] Starting processing: ${filename} (${docId}), timeout=${timeoutMs / 1000}s${job.force ? " (force rebuild)" : ""}`);

    // If force rebuild, clean up old wiki pages, anchors, and embeddings first
    if (job.force) {
      try {
        const repos = await getRepos();
        await repos.vectorSearch.deleteByDocId(docId);
        await repos.wikiPage.deleteByDocId(docId);
        await repos.anchor.deleteByDocId(docId);
        console.log(`[ProcessingQueue] Cleaned up old data for force rebuild: ${filename} (${docId})`);
      } catch (err) {
        console.warn(
          `[ProcessingQueue] Cleanup failed for ${docId}:`,
          errorMessage(err),
        );
      }
    }

    // Set up per-job timeout to prevent large files from blocking the queue
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    try {
      // === Step 1: Parsing ===
      this.throwIfAborted(abortController, docId);
      await this.stepParsing(job, abortController);

      // === Step 2: Compiling ===
      this.throwIfAborted(abortController, docId);
      await this.stepCompiling(job, abortController);

      // === Step 3: Indexing ===
      this.throwIfAborted(abortController, docId);
      await this.stepIndexing(job, abortController);

      // === Step 4: Quality Audit ===
      this.throwIfAborted(abortController, docId);
      await this.stepQualityAudit(job, abortController);

      // === Step 5: Linking — SKIPPED (paused due to performance concerns) ===
      // L0Linker is too slow for large document sets. Code is retained in
      // stepLinking() for future re-activation when performance improves.
      // this.throwIfAborted(abortController, docId);
      // await this.stepLinking(job, abortController);

      // === Complete ===
      this.throwIfAborted(abortController, docId);
      await this.updateDbStatus(docId, "ready", null, 1.0);
      this.broadcast(kbId, "kb", {
        type: "doc_ready",
        kbId,
        docId,
        filename,
      });

      console.log(
        `[ProcessingQueue] Completed processing: ${filename} (${docId})`,
      );

      // Update KB filesystem manifest (non-blocking)
      try {
        const { updateManifest } = await import("../wiki/manifest.js");
        await updateManifest(kbId);
      } catch (err) {
        console.warn(
          `[ProcessingQueue] Manifest update failed for KB ${kbId}:`,
          errorMessage(err),
        );
      }

      // Clear timeout on success
      clearTimeout(timeoutId);
    } catch (err) {
      // Clear timeout on error path
      clearTimeout(timeoutId);

      // Check if this was an abort (cancellation or timeout)
      if (abortController.signal.aborted) {
        const msg = timedOut
          ? `处理超时（超过 ${timeoutMs / 1000} 秒）。文件可能过大或格式复杂。`
          : "Cancelled by user";
        console.log(`[ProcessingQueue] Job ${timedOut ? "timed out" : "cancelled"}: ${filename} (${docId})`);
        await this.handleJobError(job, msg);
        return;
      }

      const message =
        errorMessage(err);
      console.error(
        `[ProcessingQueue] Error processing ${filename} (${docId}): ${message}`,
      );
      logError(err);

      await this.handleJobError(job, message);
    }
  }

  /**
   * Handle a job error: retry if attempts remain, otherwise mark as failed.
   */
  private async handleJobError(job: ProcessingJob, errorMsg: string): Promise<void> {
    const { kbId, docId, filename } = job;
    const retryCount = job.retryCount ?? 0;
    const maxRetries = job.maxRetries ?? MAX_RETRIES;

    if (retryCount < maxRetries) {
      // Schedule retry with exponential backoff
      const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
      const nextRetry = retryCount + 1;
      console.log(
        `[ProcessingQueue] Retrying ${filename} (${docId}) in ${delay / 1000}s (attempt ${nextRetry}/${maxRetries})`,
      );

      // Update DB status to show retrying
      await this.updateDbStatus(docId, "parsing", "retrying", 0);
      this.broadcast(kbId, "kb", {
        type: "doc_processing_step",
        kbId,
        docId,
        filename,
        status: "retrying",
        step: "retrying",
        progress: 0,
        retryAttempt: nextRetry,
        maxRetries,
      });

      // Schedule retry after delay
      setTimeout(() => {
        const retryJob: ProcessingJob = {
          ...job,
          retryCount: nextRetry,
          lastError: errorMsg,
        };
        this.enqueue(retryJob);
      }, delay);
    } else {
      // Max retries exceeded — mark as error
      const finalMsg = retryCount > 0
        ? `处理失败（已重试 ${maxRetries} 次）: ${errorMsg}`
        : errorMsg;
      await this.updateDbStatus(docId, "error", null, 0, finalMsg);
      this.broadcast(kbId, "kb", {
        type: "doc_error",
        kbId,
        docId,
        filename,
        error: finalMsg,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Step 1: Parsing
  // -----------------------------------------------------------------------

  private async stepParsing(
    job: ProcessingJob,
    abortController: AbortController,
  ): Promise<void> {
    const { kbId, docId, filename, filePath, fileType } = job;

    // Update DB status (await to ensure status is persisted)
    await this.updateDbStatus(docId, "parsing", "parsing", 0.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "parsing",
      step: "parsing",
      progress: this.overallProgress("parsing", 0.0),
    });

    // Parse the document using the same logic as knowledge.ts route
    const parsedContent = await this.parseDocument(job, abortController);

    // Store parsed content for subsequent steps
    (job as ProcessingJob & { _parsedContent: ParsedContent })._parsedContent = parsedContent;

    // Update progress
    await this.updateDbStatus(docId, "parsing", "parsing", 1.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "parsing",
      step: "parsing",
      progress: this.overallProgress("parsing", 1.0),
    });
  }

  /**
   * Parse a document using the ProcessorFactory.
   * Routes to the correct processor based on file type.
   * Supports fallback when primary processor fails.
   * Returns full ParsedContent including raw/doctags when available.
   */
  private async parseDocument(
    job: ProcessingJob,
    abortController: AbortController,
  ): Promise<ParsedContent> {
    const { filePath, fileType, filename, processor, kbId, docId } = job;
    const wikiDir = `${DEEPANALYZE_CONFIG.dataDir}/wiki`;
    const parseOptions = { kbId, docId, wikiDir };

    const factory = ProcessorFactory.getInstance();

    // If processor override is specified, use it directly
    if (processor && processor !== "auto") {
      const result = await factory.parseWithChannel(filePath, fileType, processor, parseOptions);
      if (!result.success) {
        throw new Error(result.error ?? `Parse failed for ${filename} (via ${processor})`);
      }
      console.log(
        `[ProcessingQueue] Parsed ${filename}: ${result.text.length} chars (via ${processor})` +
          (result.raw ? `, raw JSON available` : "") +
          (result.doctags ? `, doctags available` : ""),
      );
      return result;
    }

    // Auto mode: try primary processor, then fallback
    const result = await factory.parseWithFallback(filePath, fileType, parseOptions);

    if (!result.success) {
      throw new Error(result.error ?? `Parse failed for ${filename}`);
    }

    // Show the actual pipeline used (from PipelineResult metadata) or fall back to
    // the default processor label. PipelineOrchestrator sets usedPipeline on result.
    const resultAny = result as unknown as Record<string, unknown>;
    const pipelineLabel =
      resultAny.usedPipeline
        ? String(resultAny.usedPipeline)
        : factory.getProcessor(fileType).getStepLabel();
    console.log(
      `[ProcessingQueue] Parsed ${filename}: ${result.text.length} chars (via ${pipelineLabel})` +
        (result.raw ? `, raw JSON available` : "") +
        (result.doctags ? `, doctags available` : ""),
    );

    return result;
  }

  // -----------------------------------------------------------------------
  // Step 2: Compiling — create wiki pages (L2 fulltext, L1 overview, L0 abstract)
  // -----------------------------------------------------------------------

  private async stepCompiling(
    job: ProcessingJob,
    abortController: AbortController,
  ): Promise<void> {
    const { kbId, docId, filename, fileType } = job;
    const parsedContent = (job as ProcessingJob & { _parsedContent: ParsedContent })
      ._parsedContent;

    // Update DB status
    await this.updateDbStatus(docId, "compiling", "compiling", 0.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "compiling",
      step: "compiling",
      progress: this.overallProgress("compiling", 0.0),
    });

    // Use WikiCompiler for three-layer compilation (Raw→Structure→Abstract)
    const router = new ModelRouter();
    await router.initialize();
    const dataDir = process.env.DATA_DIR ?? "data";
    const compiler = new WikiCompiler(router, dataDir);
    await compiler.compile(kbId, docId, parsedContent,
      { fileName: filename, fileType: fileType },
      {
        skipStatusUpdates: true,
        onSubStep: (subStep, message) => {
          // Forward compile sub-steps to the UI so users can see what's
          // happening inside the long-running "compiling" phase. The optional
          // message carries richer context (e.g. "生成摘要中（尝试 1/3）").
          this.broadcast(kbId, "kb", {
            type: "doc_processing_step",
            kbId,
            docId,
            filename,
            status: "compiling",
            step: "compiling",
            subStep,
            ...(message ? { message } : {}),
            progress: this.overallProgress("compiling", 0.5),
          });
        },
      });

    // WikiCompiler.compile() calls updateDocumentStatus("ready") internally,
    // but we still need to set our processing_step tracking for the queue.
    // We update the step info without changing the overall status.
    await this.updateDbStatus(docId, "compiling", "compiling", 1.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "compiling",
      step: "compiling",
      progress: this.overallProgress("compiling", 1.0),
    });
  }

  // -----------------------------------------------------------------------
  // Step 3: Indexing (Phase A: no-op placeholder)
  // -----------------------------------------------------------------------

  private async stepIndexing(
    job: ProcessingJob,
    abortController: AbortController,
  ): Promise<void> {
    const { kbId, docId, filename } = job;

    // Update DB status
    await this.updateDbStatus(docId, "indexing", "indexing", 0.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "indexing",
      step: "indexing",
      progress: this.overallProgress("indexing", 0.0),
    });

    // Index the document's wiki pages into FTS5 and embeddings
    try {
      const { Indexer } = await import("../wiki/indexer.js");
      const { EmbeddingManager, setEmbeddingManager } = await import("../models/embedding.js");
      const router = new ModelRouter();
      await router.initialize();
      const embeddingManager = new EmbeddingManager(router);
      await embeddingManager.initialize();
      const indexer = new Indexer(embeddingManager);
      await indexer.indexDocument(kbId, docId);
      console.log(
        `[ProcessingQueue] Indexed ${filename} (${docId})`,
      );
    } catch (err) {
      // Indexing failure should not block the pipeline
      console.warn(
        `[ProcessingQueue] Indexing failed for ${filename} (${docId}):`,
        errorMessage(err),
      );
    }

    // Update progress
    await this.updateDbStatus(docId, "indexing", "indexing", 1.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "indexing",
      step: "indexing",
      progress: this.overallProgress("indexing", 1.0),
    });
  }

  // -----------------------------------------------------------------------
  // Step 4: Quality Audit
  // -----------------------------------------------------------------------

  private async stepQualityAudit(
    job: ProcessingJob,
    abortController: AbortController,
  ): Promise<void> {
    const { kbId, docId, filename } = job;

    // Update DB status
    await this.updateDbStatus(docId, "quality_audit", "quality_audit", 0.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "quality_audit",
      step: "quality_audit",
      progress: this.overallProgress("quality_audit", 0.0),
    });

    try {
      const repos = await getRepos();
      const doc = await repos.document.getById(docId);
      const modality = (doc?.metadata as Record<string, unknown>)?.modality as string | undefined
        ?? this.inferModality(job.fileType);

      const { QualityAuditor } = await import("./document-processors/quality-auditor.js");
      const auditor = new QualityAuditor();
      const result = await auditor.audit({
        kbId,
        docId,
        fileType: job.fileType,
        filePath: job.filePath,
        modality,
      });

      console.log(
        `[ProcessingQueue] Quality audit for ${filename} (${docId}): score=${result.score}, reExtracted=${result.reExtracted}` +
        (result.issues.length > 0 ? `, issues=[${result.issues.join(", ")}]` : ""),
      );
    } catch (err) {
      // Quality audit failure should NOT block the pipeline
      console.warn(
        `[ProcessingQueue] Quality audit failed for ${filename} (${docId}):`,
        errorMessage(err),
      );
    }

    // Update progress
    await this.updateDbStatus(docId, "quality_audit", "quality_audit", 1.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "quality_audit",
      step: "quality_audit",
      progress: this.overallProgress("quality_audit", 1.0),
    });
  }

  // -----------------------------------------------------------------------
  // Step 5: Linking (Phase A: no-op placeholder)
  // -----------------------------------------------------------------------

  private async stepLinking(
    job: ProcessingJob,
    abortController: AbortController,
  ): Promise<void> {
    const { kbId, docId, filename } = job;

    // Update DB status
    await this.updateDbStatus(docId, "linking", "linking", 0.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "linking",
      step: "linking",
      progress: this.overallProgress("linking", 0.0),
    });

    // Use L0Linker to build cross-document associations based on shared entities
    const { L0Linker } = await import("../wiki/l0-linker.js");
    const l0Linker = new L0Linker();
    await l0Linker.buildL0Associations(kbId);

    console.log(
      `[ProcessingQueue] L0 linking completed for ${filename} (${docId})`,
    );

    // Update progress
    await this.updateDbStatus(docId, "linking", "linking", 1.0);
    this.broadcast(kbId, "kb", {
      type: "doc_processing_step",
      kbId,
      docId,
      filename,
      status: "linking",
      step: "linking",
      progress: this.overallProgress("linking", 1.0),
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Map a processing step + its local progress (0-1) to an overall percentage (0-100).
   * Active steps: parsing=0-25, compiling=25-50, indexing=50-75, quality_audit=75-90.
   * Linking is currently skipped.
   */
  private overallProgress(step: string, stepProgress: number): number {
    const stepBase: Record<string, number> = {
      parsing: 0,
      compiling: 25,
      indexing: 50,
      quality_audit: 75,
      linking: 75, // skipped — shares quality_audit range
    };
    const stepWeight: Record<string, number> = {
      parsing: 25,
      compiling: 25,
      indexing: 25,
      quality_audit: 15,
      linking: 15,
    };
    const base = stepBase[step] ?? 0;
    const weight = stepWeight[step] ?? 25;
    return Math.min(100, Math.round(base + stepProgress * weight));
  }

  /**
   * Update document status in the database.
   * Sets status, processing_step, processing_progress, and optionally processing_error.
   */
  private async updateDbStatus(
    docId: string,
    status: string,
    step: string | null,
    progress: number,
    error?: string,
  ): Promise<void> {
    try {
      const repos = await getRepos();
      if (error !== undefined) {
        await repos.document.updateStatusWithProcessing(docId, status, step ?? "", progress, error);
      } else {
        await repos.document.updateStatusWithProcessing(docId, status, step ?? "", progress);
      }
    } catch (err) {
      console.error(
        `[ProcessingQueue] Failed to update DB status for ${docId}:`,
        errorMessage(err),
      );
      logError(err);
    }
  }

  /**
   * Broadcast a WebSocket event to a knowledge base channel.
   * Wrapped in try/catch so the queue works even when WS is not initialized.
   */
  private async broadcast(
    kbId: string,
    _channel: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Dynamic import — broadcastToKb may not exist yet.
      const wsModule = await import("../server/ws.js") as {
        broadcastToKb?: (kbId: string, payload: Record<string, unknown>) => void;
      };

      if (typeof wsModule.broadcastToKb === "function") {
        wsModule.broadcastToKb(kbId, payload);
      }
    } catch {
      // WS module not available or not initialized — this is fine.
    }
  }

  /**
   * Throw an error if the job has been aborted (cancelled).
   */
  private throwIfAborted(
    abortController: AbortController,
    docId: string,
  ): void {
    if (abortController.signal.aborted) {
      throw new Error(`Job ${docId} was aborted`);
    }
  }

  /**
   * Infer document modality from file type.
   */
  private inferModality(fileType: string): string {
    const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp", "svg"]);
    const AUDIO_TYPES = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg"]);
    const VIDEO_TYPES = new Set(["mp4", "avi", "mov", "mkv", "webm"]);

    if (IMAGE_TYPES.has(fileType)) return "image";
    if (AUDIO_TYPES.has(fileType)) return "audio";
    if (VIDEO_TYPES.has(fileType)) return "video";
    return "document";
  }

  // -----------------------------------------------------------------------
  // Stale job recovery + watchdog
  // -----------------------------------------------------------------------

  /** Intermediate statuses that indicate a job is stuck if the process restarts */
  private static readonly INTERMEDIATE_STATUSES = ["parsing", "compiling", "indexing", "linking", "quality_audit"];

  /**
   * Recover documents that were left in an intermediate processing state
   * after a process restart/crash. Scans the DB and re-enqueues them.
   * Should be called once at startup.
   */
  async recoverStaleJobs(): Promise<number> {
    try {
      const repos = await getRepos();
      const staleDocs = await repos.document.findByStatus(
        ProcessingQueue.INTERMEDIATE_STATUSES,
      );

      if (staleDocs.length === 0) {
        console.log("[ProcessingQueue] No stale jobs to recover");
        return 0;
      }

      let recovered = 0;
      for (const doc of staleDocs) {
        const docId = doc.id as string;
        const filename = doc.filename as string;

        // Don't enqueue if already queued or active (safety check)
        if (this.active.has(docId) || this.queue.some((j) => j.docId === docId)) {
          console.log(`[ProcessingQueue] Skipping stale job ${filename} (${docId}) — already queued/active`);
          continue;
        }

        // Reset status to uploaded
        await repos.document.updateStatusWithProcessing(docId, "uploaded", "", 0);

        // Re-enqueue for processing
        this.enqueue({
          kbId: doc.kb_id as string,
          docId,
          filename,
          filePath: doc.file_path as string,
          fileType: doc.file_type as string,
        });
        recovered++;
        console.log(`[ProcessingQueue] Recovered stale job: ${filename} (${docId})`);
      }

      console.log(`[ProcessingQueue] Recovered ${recovered} stale jobs`);
      return recovered;
    } catch (err) {
      console.error(
        "[ProcessingQueue] Failed to recover stale jobs:",
        errorMessage(err),
      );
      logError(err);
      return 0;
    }
  }

  /**
   * Start a periodic watchdog that detects and recovers jobs stuck in
   * intermediate states for too long (e.g., due to hangs, memory issues).
   */
  startWatchdog(intervalMs = 60_000, staleThresholdMs = 900_000): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }

    console.log(
      `[ProcessingQueue] Watchdog started: interval=${intervalMs / 1000}s, stale threshold=${staleThresholdMs / 1000}s`,
    );

    this.watchdogTimer = setInterval(() => {
      this.watchdogCheck(staleThresholdMs).catch((err: unknown) => {
        console.error(
          "[ProcessingQueue] Watchdog check failed:",
          errorMessage(err),
        );
        logError(err);
      });
    }, intervalMs);
  }

  /**
   * Stop the watchdog timer (for graceful shutdown).
   */
  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      console.log("[ProcessingQueue] Watchdog stopped");
    }
  }

  private async watchdogCheck(staleThresholdMs: number): Promise<void> {
    try {
      const repos = await getRepos();
      const staleDocs = await repos.document.findByStatus(
        ProcessingQueue.INTERMEDIATE_STATUSES,
        staleThresholdMs,
      );

      if (staleDocs.length === 0) return;

      console.warn(
        `[ProcessingQueue] Watchdog found ${staleDocs.length} stale job(s), recovering...`,
      );

      for (const doc of staleDocs) {
        const docId = doc.id as string;
        const filename = doc.filename as string;

        // Skip if already queued or active
        if (this.active.has(docId) || this.queue.some((j) => j.docId === docId)) {
          continue;
        }

        // Reset status
        await repos.document.updateStatusWithProcessing(docId, "uploaded", "", 0);

        // Re-enqueue
        this.enqueue({
          kbId: doc.kb_id as string,
          docId,
          filename,
          filePath: doc.file_path as string,
          fileType: doc.file_type as string,
        });

        console.warn(
          `[ProcessingQueue] Watchdog recovered stale job: ${filename} (${docId})`,
        );
      }
    } catch (err) {
      console.error(
        "[ProcessingQueue] Watchdog check error:",
        errorMessage(err),
      );
      logError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _instance: ProcessingQueue | null = null;

/**
 * Get the global ProcessingQueue singleton.
 * Created lazily on first access.
 */
export function getProcessingQueue(): ProcessingQueue {
  if (!_instance) {
    _instance = new ProcessingQueue();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetProcessingQueue(): void {
  _instance = null;
}
