// =============================================================================
// DeepAnalyze - Cron API Routes
// REST API for managing scheduled cron jobs
// =============================================================================

import { Hono } from "hono";
import { CronService } from "../../services/cron/service.js";
import { CronScheduler } from "../../services/cron/scheduler.js";
import type { CreateCronJobRequest, UpdateCronJobRequest } from "../../services/cron/types.js";

export function createCronRoutes(): Hono {
  const router = new Hono();
  const service = new CronService();
  const scheduler = new CronScheduler();

  // Start the scheduler on first API call
  let schedulerStarted = false;
  function ensureScheduler() {
    if (!schedulerStarted) {
      scheduler.start();
      schedulerStarted = true;
    }
  }

  // -----------------------------------------------------------------------
  // Job CRUD
  // -----------------------------------------------------------------------

  /** List all cron jobs */
  router.get("/jobs", async (c) => {
    ensureScheduler();
    const jobs = await service.listJobs();
    return c.json(jobs);
  });

  /** Get single job detail */
  router.get("/jobs/:id", async (c) => {
    const job = await service.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json(job);
  });

  /** Create a new cron job */
  router.post("/jobs", async (c) => {
    const body = await c.req.json<CreateCronJobRequest>();

    if (!body.name?.trim()) return c.json({ error: "任务名称不能为空" }, 400);
    if (!body.schedule?.trim()) return c.json({ error: "cron 表达式不能为空" }, 400);
    // Either message or action must be provided
    if (!body.message?.trim() && !body.action) {
      return c.json({ error: "执行消息或系统动作必须提供一项" }, 400);
    }

    try {
      const job = await service.createJob(body);
      ensureScheduler();
      return c.json(job, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "创建失败" }, 400);
    }
  });

  /** Update a cron job */
  router.put("/jobs/:id", async (c) => {
    const body = await c.req.json<UpdateCronJobRequest>();
    try {
      const job = await service.updateJob(c.req.param("id"), body);
      if (!job) return c.json({ error: "Job not found" }, 404);
      return c.json(job);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "更新失败" }, 400);
    }
  });

  /** Delete a cron job */
  router.delete("/jobs/:id", async (c) => {
    const ok = await service.deleteJob(c.req.param("id"));
    if (!ok) return c.json({ error: "Job not found" }, 404);
    return c.json({ success: true });
  });

  /** Manually execute a job */
  router.post("/jobs/:id/run", async (c) => {
    const id = c.req.param("id");
    const job = await service.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);

    // Execute in background
    ensureScheduler();
    // Fire-and-forget: works in both Node.js and Cloudflare Workers
    scheduler.executeJob(id).catch((err) => {
      console.error("[CronAPI] Manual execution error:", err);
    });

    return c.json({ success: true, message: "任务已触发" });
  });

  /** Validate a cron expression */
  router.post("/validate", async (c) => {
    const { schedule } = await c.req.json<{ schedule: string }>();
    if (!schedule) return c.json({ error: "schedule is required" }, 400);

    const valid = service.validateSchedule(schedule);
    const description = valid ? service.describeSchedule(schedule) : "";
    const nextRun = valid ? service.calculateNextRun(schedule) : null;

    return c.json({ valid, description, nextRun });
  });

  return router;
}
