import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { CronJobRepo, CronJob, NewCronJob } from './interfaces';

export class PgCronJobRepo implements CronJobRepo {
  constructor(private pool: pg.Pool) {}

  async create(job: NewCronJob): Promise<CronJob> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO cron_jobs (id, name, schedule, message, action, enabled, channel, chat_id, deliver_response, next_run, kb_id, agent_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [id, job.name, job.schedule, job.message ?? "", job.action ?? null, job.enabled ?? true, job.channel ?? null, job.chatId ?? null, job.deliverResponse ?? false, job.nextRun ?? null, (job as any).kbId ?? null, (job as any).agentType ?? null],
    );
    return this.mapRow(rows[0]);
  }

  async get(id: string): Promise<CronJob | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM cron_jobs WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(): Promise<CronJob[]> {
    const { rows } = await this.pool.query('SELECT * FROM cron_jobs ORDER BY created_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async update(id: string, fields: Partial<CronJob>): Promise<void> {
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    const allowedKeys: Record<string, string> = { name: 'name', schedule: 'schedule', message: 'message', action: 'action', enabled: 'enabled', channel: 'channel', chatId: 'chat_id', deliverResponse: 'deliver_response', kbId: 'kb_id', agentType: 'agent_type' };
    for (const [camelKey, pgCol] of Object.entries(allowedKeys)) {
      if ((fields as any)[camelKey] !== undefined) { sets.push(`${pgCol} = $${i++}`); vals.push((fields as any)[camelKey]); }
    }
    if (fields.nextRun !== undefined) { sets.push(`next_run = $${i++}`); vals.push(fields.nextRun); }
    sets.push(`updated_at = now()`);
    vals.push(id);
    if (sets.length > 1) await this.pool.query(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM cron_jobs WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async getDueJobs(now: Date): Promise<CronJob[]> {
    const { rows } = await this.pool.query('SELECT * FROM cron_jobs WHERE enabled = true AND next_run <= $1', [now.toISOString()]);
    return rows.map(r => this.mapRow(r));
  }

  async markCompleted(id: string, nextRun: Date): Promise<void> {
    await this.pool.query(
      `UPDATE cron_jobs SET last_run = now(), last_status = 'success', last_error = NULL, run_count = run_count + 1, next_run = $2, updated_at = now() WHERE id = $1`,
      [id, nextRun.toISOString()],
    );
  }

  async markFailed(id: string, error: string, nextRun: Date): Promise<void> {
    await this.pool.query(
      `UPDATE cron_jobs SET last_run = now(), last_status = 'failed', last_error = $2, run_count = run_count + 1, error_count = error_count + 1, next_run = $3, updated_at = now() WHERE id = $1`,
      [id, error, nextRun.toISOString()],
    );
  }

  private mapRow(row: any): CronJob {
    return {
      id: row.id, name: row.name, schedule: row.schedule, message: row.message,
      action: row.action ?? null,
      enabled: row.enabled, channel: row.channel ?? null, chatId: row.chat_id ?? null,
      deliverResponse: row.deliver_response ?? false, lastRun: row.last_run?.toISOString?.() ?? row.last_run ?? null,
      nextRun: row.next_run?.toISOString?.() ?? row.next_run ?? null,
      lastStatus: row.last_status ?? null, lastError: row.last_error ?? null,
      runCount: row.run_count ?? 0, errorCount: row.error_count ?? 0,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      kbId: row.kb_id ?? null,
      agentType: row.agent_type ?? null,
    };
  }
}
