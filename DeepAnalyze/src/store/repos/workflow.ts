import pg from "pg";
import type { WorkflowRepo, Workflow, NewWorkflow, WorkflowStatus } from "./interfaces";

/**
 * PG-backed repository for the `workflows` table.
 *
 * Each workflow run gets one row, written at startWorkflow time and updated
 * when the engine completes/fails/cancels. This survives service restarts
 * (unlike WorkflowManager's in-memory `active` Map), so historical workflows
 * can be listed via GET /api/sessions/:id/workflows.
 *
 * Pairs with PgWorkflowLogRepo which stores detailed per-event execution logs.
 */
export class PgWorkflowRepo implements WorkflowRepo {
  constructor(private pool: pg.Pool) {}

  async insert(wf: NewWorkflow): Promise<void> {
    await this.pool.query(
      `INSERT INTO workflows (id, session_id, parent_task_id, team_name, mode, goal, agent_count, status, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', now())
       ON CONFLICT (id) DO NOTHING`,
      [
        wf.id,
        wf.sessionId,
        wf.parentTaskId ?? null,
        wf.teamName ?? null,
        wf.mode ?? null,
        wf.goal ?? null,
        wf.agentCount ?? null,
      ],
    );
  }

  async updateCompletion(
    id: string,
    status: WorkflowStatus,
    result?: unknown,
    error?: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE workflows
       SET status = $2,
           completed_at = now(),
           result = $3,
           error = $4
       WHERE id = $1`,
      [
        id,
        status,
        result !== undefined ? JSON.stringify(result) : null,
        error ?? null,
      ],
    );
  }

  async listBySession(sessionId: string): Promise<Workflow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM workflows WHERE session_id = $1 ORDER BY started_at DESC`,
      [sessionId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async get(id: string): Promise<Workflow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM workflows WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  private mapRow(row: any): Workflow {
    return {
      id: row.id,
      sessionId: row.session_id,
      parentTaskId: row.parent_task_id,
      teamName: row.team_name,
      mode: row.mode,
      goal: row.goal,
      agentCount: row.agent_count,
      status: row.status as WorkflowStatus,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
      completedAt: row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : (row.completed_at ?? null),
      result: typeof row.result === "string" ? JSON.parse(row.result) : (row.result ?? null),
      error: row.error,
    };
  }
}
