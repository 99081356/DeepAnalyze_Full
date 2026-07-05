import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { KnowledgeBaseRepo, KnowledgeBase } from './interfaces';

export class PgKnowledgeBaseRepo implements KnowledgeBaseRepo {
  constructor(private pool: pg.Pool) {}

  async create(name: string, ownerId: string, description?: string, visibility?: string): Promise<KnowledgeBase> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO knowledge_bases (id, name, description, owner_id, visibility) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, name, description ?? null, ownerId, visibility ?? 'private'],
    );
    return this.mapRow(rows[0]);
  }

  async get(id: string): Promise<KnowledgeBase | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(): Promise<KnowledgeBase[]> {
    const { rows } = await this.pool.query('SELECT * FROM knowledge_bases ORDER BY created_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async update(id: string, fields: { name?: string; description?: string; visibility?: string; lastPreprocessedAt?: Date | null }): Promise<KnowledgeBase | undefined> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (fields.name !== undefined) { sets.push(`name = $${idx++}`); values.push(fields.name); }
    if (fields.description !== undefined) { sets.push(`description = $${idx++}`); values.push(fields.description); }
    if (fields.visibility !== undefined) { sets.push(`visibility = $${idx++}`); values.push(fields.visibility); }
    if (fields.lastPreprocessedAt !== undefined) { sets.push(`last_preprocessed_at = $${idx++}`); values.push(fields.lastPreprocessedAt); }
    if (sets.length === 0) return this.get(id);
    sets.push(`updated_at = now()`);
    values.push(id);
    const { rowCount } = await this.pool.query(
      `UPDATE knowledge_bases SET ${sets.join(', ')} WHERE id = $${idx}`,
      values,
    );
    if ((rowCount ?? 0) === 0) return undefined;
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM knowledge_bases WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async getAnyId(): Promise<string | undefined> {
    const { rows } = await this.pool.query('SELECT id FROM knowledge_bases LIMIT 1');
    return rows[0]?.id;
  }

  private mapRow(row: any): KnowledgeBase {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      visibility: row.visibility,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      lastPreprocessedAt: row.last_preprocessed_at instanceof Date ? row.last_preprocessed_at.toISOString() : (row.last_preprocessed_at ? String(row.last_preprocessed_at) : undefined),
    };
  }
}
