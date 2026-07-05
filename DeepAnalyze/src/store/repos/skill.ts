import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SkillRepo, Skill, NewSkill } from './interfaces';

export class PgSkillRepo implements SkillRepo {
  constructor(private pool: pg.Pool) {}

  async create(skill: NewSkill): Promise<Skill> {
    const { rows } = await this.pool.query(
      `INSERT INTO skills (id, name, plugin_id, description, config) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [skill.id, skill.name, skill.pluginId, skill.description ?? null, skill.config ? JSON.stringify(skill.config) : null],
    );
    return this.mapRow(rows[0]);
  }

  async get(id: string): Promise<Skill | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM skills WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(pluginId?: string): Promise<Skill[]> {
    if (pluginId) {
      const { rows } = await this.pool.query('SELECT * FROM skills WHERE plugin_id = $1 ORDER BY created_at DESC', [pluginId]);
      return rows.map(r => this.mapRow(r));
    }
    const { rows } = await this.pool.query('SELECT * FROM skills ORDER BY created_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM skills WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapRow(row: any): Skill {
    return {
      id: row.id, name: row.name, pluginId: row.plugin_id, description: row.description ?? undefined,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
