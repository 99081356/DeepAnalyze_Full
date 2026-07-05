// =============================================================================
// DeepAnalyze - CronService
// CRUD operations and scheduling logic for cron jobs
// =============================================================================

import { randomUUID } from "node:crypto";
import { getRepos, type CronJob } from "../../store/repos/index.js";
import {
  type CreateCronJobRequest,
  type UpdateCronJobRequest,
} from "./types.js";

export class CronService {
  private async getRepo() {
    return (await getRepos()).cronJob;
  }

  /** Validate a 5-part cron expression */
  validateSchedule(schedule: string): boolean {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    // Basic validation: each part should match cron patterns
    const partPatterns = [
      /^(\*|[0-5]?\d|([0-5]?\d-[0-5]?\d)(,[0-5]?\d(-[0-5]?\d)?)*|([*]\/[0-5]?\d))$/,  // minute
      /^(\*|[01]?\d|2[0-3]|([01]?\d-[01]?\d)(,[01]?\d(-[01]?\d)?)*|([*]\/[01]?\d))$/,     // hour
      /^(\*|[0-2]?\d|3[01]|([0-2]?\d-[0-2]?\d)(,[0-2]?\d(-[0-2]?\d)?)*|([*]\/[0-2]?\d))$/, // day
      /^(\*|[0]?[1-9]|1[0-2]|([0]?[1-9]-[0]?[1-9])(,[0]?[1-9](-[0]?[1-9])?)*)$/,           // month
      /^(\*|[0-6]|([0-6]-[0-6])(,[0-6](-[0-6])?)*)$/,                                        // weekday
    ];
    return parts.every((part, i) => {
      // Also allow */N patterns for all fields
      if (/^\*\/\d+$/.test(part)) return true;
      // Also allow simple numbers
      if (/^\d+$/.test(part)) return true;
      return partPatterns[i].test(part);
    });
  }

  /** Calculate next run time from a cron expression */
  calculateNextRun(schedule: string): string {
    const now = new Date();
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return now.toISOString();

    // Simple next-run calculation: find the next matching time
    // by checking each minute for the next 366 days
    const test = new Date(now.getTime());
    test.setSeconds(0, 0);
    // Start from the next minute
    test.setMinutes(test.getMinutes() + 1);

    const maxIterations = 525960; // 366 days in minutes
    for (let i = 0; i < maxIterations; i++) {
      const minute = test.getMinutes();
      const hour = test.getHours();
      const day = test.getDate();
      const month = test.getMonth() + 1;
      const weekday = test.getDay();

      if (
        this.matchesPart(parts[0], minute, 0, 59) &&
        this.matchesPart(parts[1], hour, 0, 23) &&
        this.matchesPart(parts[2], day, 1, 31) &&
        this.matchesPart(parts[3], month, 1, 12) &&
        this.matchesPart(parts[4], weekday, 0, 6)
      ) {
        return test.toISOString();
      }
      test.setMinutes(test.getMinutes() + 1);
    }

    // Fallback: 1 year from now
    return new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  }

  private matchesPart(part: string, value: number, min: number, max: number): boolean {
    if (part === "*") return true;
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2));
      return step > 0 && (value - min) % step === 0;
    }
    if (part.includes(",")) {
      return part.split(",").some((p) => this.matchesPart(p, value, min, max));
    }
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      return value >= start && value <= end;
    }
    return parseInt(part) === value;
  }

  /** Generate a human-readable description of a cron schedule */
  describeSchedule(schedule: string): string {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return schedule;

    const [minute, hour, day, month, weekday] = parts;

    if (minute.startsWith("*/")) {
      const n = minute.slice(2);
      return `每 ${n} 分钟`;
    }
    if (hour === "*" && minute !== "*" && !minute.startsWith("*/")) {
      return `每小时第 ${minute} 分钟`;
    }
    if (weekday !== "*" && hour !== "*" && minute !== "*") {
      const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      return `${days[parseInt(weekday)] ?? "周" + weekday} ${hour}:${minute.padStart(2, "0")}`;
    }
    if (day !== "*" && day !== "*/1" && hour !== "*" && minute !== "*") {
      return `每月 ${day} 日 ${hour}:${minute.padStart(2, "0")}`;
    }
    if (hour !== "*" && minute !== "*") {
      return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    }
    return schedule;
  }

  // --- CRUD ---

  async createJob(data: CreateCronJobRequest): Promise<CronJob> {
    if (!this.validateSchedule(data.schedule)) {
      throw new Error("无效的 cron 表达式");
    }

    // Either message or action must be provided
    if (!data.message?.trim() && !data.action) {
      throw new Error("执行消息或系统动作必须提供一项");
    }

    const nextRun = this.calculateNextRun(data.schedule);
    const repo = await this.getRepo();

    return repo.create({
      name: data.name,
      schedule: data.schedule,
      message: data.message ?? "",
      action: data.action ?? null,
      enabled: data.enabled ?? true,
      channel: data.channel ?? null,
      chatId: data.chatId ?? null,
      deliverResponse: data.deliverResponse ?? false,
      nextRun,
      kbId: data.kbId ?? null,
      agentType: data.agentType ?? null,
    });
  }

  async getJob(id: string): Promise<CronJob | null> {
    const repo = await this.getRepo();
    return (await repo.get(id)) ?? null;
  }

  async listJobs(): Promise<CronJob[]> {
    const repo = await this.getRepo();
    return repo.list();
  }

  async updateJob(id: string, data: UpdateCronJobRequest): Promise<CronJob | null> {
    const repo = await this.getRepo();
    const existing = await repo.get(id);
    if (!existing) return null;

    if (data.schedule && !this.validateSchedule(data.schedule)) {
      throw new Error("无效的 cron 表达式");
    }

    const fields: Record<string, unknown> = {};
    if (data.name !== undefined) fields.name = data.name;
    if (data.schedule !== undefined) fields.schedule = data.schedule;
    if (data.message !== undefined) fields.message = data.message;
    if (data.action !== undefined) fields.action = data.action;
    if (data.enabled !== undefined) fields.enabled = data.enabled;
    if (data.channel !== undefined) fields.channel = data.channel;
    if (data.chatId !== undefined) fields.chatId = data.chatId;
    if (data.deliverResponse !== undefined) fields.deliverResponse = data.deliverResponse;
    if (data.kbId !== undefined) fields.kbId = data.kbId;
    if (data.agentType !== undefined) fields.agentType = data.agentType;

    // Recalculate next_run if schedule changed
    if (data.schedule) {
      fields.nextRun = this.calculateNextRun(data.schedule);
    }

    if (Object.keys(fields).length === 0) return existing;

    await repo.update(id, fields);
    return (await repo.get(id)) ?? null;
  }

  async deleteJob(id: string): Promise<boolean> {
    const repo = await this.getRepo();
    return repo.delete(id);
  }

  /** Get jobs that are due to run (next_run <= now AND enabled) */
  async getDueJobs(): Promise<CronJob[]> {
    const repo = await this.getRepo();
    return repo.getDueJobs(new Date());
  }

  /** Mark a job as completed */
  async markCompleted(id: string): Promise<void> {
    const repo = await this.getRepo();
    const job = await repo.get(id);
    if (!job) return;
    const nextRun = this.calculateNextRun(job.schedule);
    await repo.markCompleted(id, new Date(nextRun));
  }

  /** Mark a job as failed */
  async markFailed(id: string, error: string): Promise<void> {
    const repo = await this.getRepo();
    const job = await repo.get(id);
    if (!job) return;
    const nextRun = this.calculateNextRun(job.schedule);
    await repo.markFailed(id, error, new Date(nextRun));
  }
}
