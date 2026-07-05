import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AgentTeamRepo, AgentTeam, AgentTeamMember, AgentTeamWithMembers, CreateTeamData, UpdateTeamData, TeamMode } from './interfaces';

export class PgAgentTeamRepo implements AgentTeamRepo {
  constructor(private pool: pg.Pool) {}

  async create(data: CreateTeamData): Promise<AgentTeamWithMembers> {
    const teamId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO agent_teams (id, name, description, mode, is_active, cross_review, enable_skills, model_config) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [teamId, data.name, data.description, data.mode, data.isActive !== false, data.crossReview ?? false, data.enableSkills ?? false, data.modelConfig ? JSON.stringify(data.modelConfig) : null],
      );
      const members: AgentTeamMember[] = [];
      for (const m of (data.members ?? [])) {
        const mId = randomUUID();
        await client.query(
          `INSERT INTO agent_team_members (id, team_id, role, system_prompt, task, perspective, depends_on, condition_config, tools, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [mId, teamId, m.role, m.systemPrompt ?? null, m.task, m.perspective ?? null, JSON.stringify(m.dependsOn ?? []), m.condition ? JSON.stringify(m.condition) : null, JSON.stringify(m.tools ?? []), m.sortOrder ?? 0],
        );
        members.push({ id: mId, teamId, role: m.role, systemPrompt: m.systemPrompt, task: m.task, perspective: m.perspective, dependsOn: m.dependsOn ?? [], condition: m.condition, tools: m.tools ?? [], sortOrder: m.sortOrder ?? 0 });
      }
      await client.query('COMMIT');
      const { rows } = await this.pool.query('SELECT * FROM agent_teams WHERE id = $1', [teamId]);
      return { ...this.mapTeam(rows[0])!, members };
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  async get(id: string): Promise<AgentTeamWithMembers | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM agent_teams WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const team = this.mapTeam(rows[0])!;
    const { rows: mRows } = await this.pool.query('SELECT * FROM agent_team_members WHERE team_id = $1 ORDER BY sort_order', [id]);
    return { ...team, members: mRows.map(r => this.mapMember(r)) };
  }

  async getByName(name: string): Promise<AgentTeamWithMembers | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM agent_teams WHERE name = $1', [name]);
    if (!rows[0]) return undefined;
    return this.get(rows[0].id);
  }

  async list(): Promise<AgentTeam[]> {
    const { rows } = await this.pool.query('SELECT * FROM agent_teams ORDER BY updated_at DESC');
    return rows.map(r => this.mapTeam(r)!);
  }

  async update(id: string, data: UpdateTeamData): Promise<AgentTeamWithMembers | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sets: string[] = [];
      const vals: any[] = [];
      let i = 1;
      if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
      if (data.description !== undefined) { sets.push(`description = $${i++}`); vals.push(data.description); }
      if (data.mode !== undefined) { sets.push(`mode = $${i++}`); vals.push(data.mode); }
      if (data.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(data.isActive); }
      if (data.crossReview !== undefined) { sets.push(`cross_review = $${i++}`); vals.push(data.crossReview); }
      if (data.enableSkills !== undefined) { sets.push(`enable_skills = $${i++}`); vals.push(data.enableSkills); }
      if (data.modelConfig !== undefined) { sets.push(`model_config = $${i++}`); vals.push(data.modelConfig ? JSON.stringify(data.modelConfig) : null); }
      sets.push(`updated_at = now()`);
      vals.push(id);
      await client.query(`UPDATE agent_teams SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      if (data.members !== undefined) {
        await client.query('DELETE FROM agent_team_members WHERE team_id = $1', [id]);
        for (const m of data.members) {
          const mId = randomUUID();
          await client.query(
            `INSERT INTO agent_team_members (id, team_id, role, system_prompt, task, perspective, depends_on, condition_config, tools, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [mId, id, m.role, m.systemPrompt ?? null, m.task, m.perspective ?? null, JSON.stringify(m.dependsOn ?? []), m.condition ? JSON.stringify(m.condition) : null, JSON.stringify(m.tools ?? []), m.sortOrder ?? 0],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM agent_teams WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapTeam(row: any): AgentTeam | undefined {
    if (!row) return undefined;
    let modelConfig: Record<string, unknown> | undefined;
    try { modelConfig = row.model_config ? (typeof row.model_config === 'string' ? JSON.parse(row.model_config) : row.model_config) : undefined; } catch {}
    return {
      id: row.id, name: row.name, description: row.description, mode: row.mode as TeamMode,
      isActive: row.is_active, crossReview: row.cross_review, enableSkills: row.enable_skills,
      modelConfig, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  private mapMember(row: any): AgentTeamMember {
    let dependsOn: string[] = [];
    try { const p = typeof row.depends_on === 'string' ? JSON.parse(row.depends_on) : row.depends_on; dependsOn = Array.isArray(p) ? p : []; } catch {}
    let condition: Record<string, unknown> | undefined;
    try { condition = row.condition_config ? (typeof row.condition_config === 'string' ? JSON.parse(row.condition_config) : row.condition_config) : undefined; } catch {}
    let tools: string[] = [];
    try { const p = typeof row.tools === 'string' ? JSON.parse(row.tools) : row.tools; tools = Array.isArray(p) ? p : []; } catch {}
    return {
      id: row.id, teamId: row.team_id, role: row.role, systemPrompt: row.system_prompt ?? undefined,
      task: row.task, perspective: row.perspective ?? undefined, dependsOn, condition, tools, sortOrder: row.sort_order,
    };
  }
}
