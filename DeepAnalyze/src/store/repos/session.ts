import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SessionRepo, Session } from './interfaces';

export class PgSessionRepo implements SessionRepo {
  constructor(private pool: pg.Pool) {}

  async create(title?: string, kbScope?: Record<string, unknown>): Promise<Session> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO sessions (id, title, kb_scope) VALUES ($1, $2, $3) RETURNING *`,
      [id, title ?? null, kbScope ? JSON.stringify(kbScope) : null],
    );
    return this.mapRow(rows[0]);
  }

  async list(): Promise<Session[]> {
    const { rows } = await this.pool.query('SELECT * FROM sessions ORDER BY updated_at DESC');
    return rows.map(r => this.mapRow(r));
  }

  async get(id: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async updateTimestamp(id: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET updated_at = now() WHERE id = $1', [id]);
  }

  async updateKbScope(id: string, kbScope: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET kb_scope = $2 WHERE id = $1',
      [id, JSON.stringify(kbScope)],
    );
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET title = $2 WHERE id = $1',
      [id, title],
    );
  }

  private mapRow(row: any): Session {
    return {
      id: row.id,
      title: row.title,
      kbScope: typeof row.kb_scope === 'string' ? row.kb_scope : row.kb_scope ? JSON.stringify(row.kb_scope) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
