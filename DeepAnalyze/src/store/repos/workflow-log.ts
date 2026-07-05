import { randomUUID } from "node:crypto";
import pg from "pg";
import type { WorkflowLogRepo, WorkflowLog, NewWorkflowLog } from "./interfaces";

export class PgWorkflowLogRepo implements WorkflowLogRepo {
  constructor(private pool: pg.Pool) {}

  async insert(log: NewWorkflowLog): Promise<void> {
    const id = log.id ?? randomUUID();
    await this.pool.query(
      `INSERT INTO workflow_logs (id, workflow_id, agent_id, role, turn, event_type, tool_name, content, duration_ms, model_id, tokens_in, tokens_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        log.workflowId,
        log.agentId,
        log.role ?? null,
        log.turn ?? null,
        log.eventType,
        log.toolName ?? null,
        log.content ? JSON.stringify(log.content) : null,
        log.durationMs ?? null,
        log.modelId ?? null,
        log.tokensIn ?? null,
        log.tokensOut ?? null,
      ],
    );
  }

  async insertBatch(logs: NewWorkflowLog[]): Promise<void> {
    if (logs.length === 0) return;
    // Use a single multi-row INSERT for efficiency
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const log of logs) {
      const id = log.id ?? randomUUID();
      placeholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
      );
      values.push(
        id,
        log.workflowId,
        log.agentId,
        log.role ?? null,
        log.turn ?? null,
        log.eventType,
        log.toolName ?? null,
        log.content ? JSON.stringify(log.content) : null,
        log.durationMs ?? null,
        log.modelId ?? null,
        log.tokensIn ?? null,
        log.tokensOut ?? null,
      );
    }
    await this.pool.query(
      `INSERT INTO workflow_logs (id, workflow_id, agent_id, role, turn, event_type, tool_name, content, duration_ms, model_id, tokens_in, tokens_out)
       VALUES ${placeholders.join(", ")}`,
      values,
    );
  }

  async listByWorkflow(workflowId: string, agentId?: string): Promise<WorkflowLog[]> {
    let sql = "SELECT * FROM workflow_logs WHERE workflow_id = $1";
    const params: unknown[] = [workflowId];
    if (agentId) {
      sql += " AND agent_id = $2";
      params.push(agentId);
    }
    sql += " ORDER BY created_at ASC";
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => this.mapRow(r));
  }

  async deleteOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM workflow_logs WHERE created_at < now() - ($1 || ' days')::interval",
      [String(days)],
    );
    return rowCount ?? 0;
  }

  private mapRow(row: any): WorkflowLog {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      agentId: row.agent_id,
      role: row.role,
      turn: row.turn,
      eventType: row.event_type,
      toolName: row.tool_name,
      content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
      durationMs: row.duration_ms,
      modelId: row.model_id,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
