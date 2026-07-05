// =============================================================================
// DeepAnalyze - CronScheduler
// Simple polling-based cron scheduler with direct agent execution
// =============================================================================

import { CronService } from "./service.js";

export class CronScheduler {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeJobs = new Set<string>();
  private service = new CronService();
  private maxConcurrent = 3;

  /** Start the scheduler — checks every 60 seconds */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log("[CronScheduler] Starting (60s interval)");

    // Check immediately
    this.tick();

    // Then every 60 seconds
    this.timer = setInterval(() => this.tick(), 60_000);
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log("[CronScheduler] Stopped");
  }

  /** Check for and execute due jobs */
  private async tick(): Promise<void> {
    try {
      const dueJobs = await this.service.getDueJobs();
      if (dueJobs.length === 0) return;

      console.log(`[CronScheduler] ${dueJobs.length} job(s) due`);

      for (const job of dueJobs) {
        if (this.activeJobs.size >= this.maxConcurrent) {
          console.log("[CronScheduler] Max concurrent reached, skipping remaining");
          break;
        }
        if (this.activeJobs.has(job.id)) continue;

        // Fire-and-forget: each job runs independently
        this.executeJob(job.id, job.message);
      }
    } catch (err) {
      console.error("[CronScheduler] Tick error:", err);
    }
  }

  /** Execute a single job */
  async executeJob(jobId: string, message?: string): Promise<void> {
    if (this.activeJobs.has(jobId)) return;

    this.activeJobs.add(jobId);
    console.log(`[CronScheduler] Executing job ${jobId}`);

    try {
      const job = await this.service.getJob(jobId);
      if (!job) {
        console.warn(`[CronScheduler] Job ${jobId} not found`);
        return;
      }

      // If this is a system action, execute it directly
      if (job.action) {
        await this.executeAction(jobId, job.action);
        return;
      }

      const prompt = message ?? job.message;

      // Direct execution via Orchestrator (no internal HTTP overhead)
      const { getOrchestrator } = await import("../agent/agent-system.js");
      const { getRepos } = await import("../../store/repos/index.js");

      const repos = await getRepos();
      const session = await repos.session.create(`[定时任务] ${job.name}`);

      const orchestrator = await getOrchestrator();

      const result = await orchestrator.runSingle({
        input: prompt,
        sessionId: session.id,
        agentType: "general",
        kbId: (job as any).kbId ?? undefined,
      });

      if (result.output) {
        console.log(`[CronScheduler] Job ${jobId} completed (${result.turnsUsed} turns, ${result.toolCallsCount} tool calls)`);
      } else {
        console.log(`[CronScheduler] Job ${jobId} completed (no output)`);
      }

      this.service.markCompleted(jobId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CronScheduler] Job ${jobId} failed:`, errorMsg);
      this.service.markFailed(jobId, errorMsg);
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /** Check if a job is currently running */
  isJobActive(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  /** Execute a system-level action */
  private async executeAction(jobId: string, action: string): Promise<void> {
    console.log(`[CronScheduler] Executing system action: ${action}`);

    try {
      switch (action) {
        case "reindex": {
          // Trigger reindex for all knowledge bases with stale embeddings
          const { getRepos } = await import("../../store/repos/index.js");
          const repos = await getRepos();
          const { getProcessingQueue } = await import("../processing-queue.js");
          const queue = getProcessingQueue();

          const kbs = await repos.knowledgeBase.list();
          let reindexed = 0;
          for (const kb of kbs) {
            const docs = await repos.document.getByKbId(kb.id);
            for (const doc of docs) {
              if (doc.status === "error" || doc.status === "needs_reindex") {
                queue.enqueue({
                  kbId: kb.id,
                  docId: doc.id,
                  filename: doc.filename,
                  filePath: doc.file_path,
                  fileType: doc.file_type,
                });
                reindexed++;
              }
            }
          }
          console.log(`[CronScheduler] Reindex queued ${reindexed} documents`);
          this.service.markCompleted(jobId);
          break;
        }

        case "cleanup": {
          // Clean up old sessions, temp files, etc.
          const { getRepos } = await import("../../store/repos/index.js");
          const repos = await getRepos();
          const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
          // Clean up old error documents
          const kbs = await repos.knowledgeBase.list();
          let cleaned = 0;
          for (const kb of kbs) {
            const docs = await repos.document.getByKbId(kb.id);
            for (const doc of docs) {
              if (doc.status === "error" && new Date(doc.created_at) < cutoff) {
                await repos.document.deleteById(doc.id);
                cleaned++;
              }
            }
          }
          console.log(`[CronScheduler] Cleanup removed ${cleaned} old error documents`);
          this.service.markCompleted(jobId);
          break;
        }

        case "health_check": {
          // Direct health check without HTTP
          const { getRepos } = await import("../../store/repos/index.js");
          const repos = await getRepos();
          // Simple DB connectivity check
          await repos.session.list();
          console.log(`[CronScheduler] Health check: ok`);
          this.service.markCompleted(jobId);
          break;
        }

        default:
          throw new Error(`Unknown system action: ${action}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CronScheduler] Action ${action} failed:`, errorMsg);
      this.service.markFailed(jobId, errorMsg);
    }
  }
}
