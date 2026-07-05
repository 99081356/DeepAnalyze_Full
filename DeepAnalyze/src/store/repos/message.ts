import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { MessageRepo, Message } from './interfaces';

/** Strip PostgreSQL-incompatible characters before JSON serialization.
 *  PG jsonb rejects \u0000 (null byte) and lone UTF-16 surrogates.
 *  These appear when strings are sliced mid-surrogate-pair (e.g. `.slice(0, 200)`
 *  cutting an emoji in half) or when tool output contains binary data.
 *
 *  IMPORTANT: Must use a replacer so sanitization runs on the RAW JS string values
 *  BEFORE JSON.stringify converts them to \uXXXX escapes. A post-stringify regex
 *  cannot match surrogates because they're already in escape-sequence text form. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function sanitizeJsonForPg(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'string') {
      return value
        .replace(/\u0000/g, '')
        .replace(LONE_SURROGATE_RE, '\ufffd');
    }
    return value;
  });
}

export class PgMessageRepo implements MessageRepo {
  constructor(private pool: pg.Pool) {}

  async create(sessionId: string, role: string, content: string | null, metadata?: Record<string, unknown>): Promise<Message> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO messages (id, session_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, sessionId, role, content ?? '', metadata ? sanitizeJsonForPg(metadata) : null],
    );
    await this.pool.query('UPDATE sessions SET updated_at = now() WHERE id = $1', [sessionId]);
    return this.mapRow(rows[0]);
  }

  async list(sessionId: string): Promise<Message[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC',
      [sessionId],
    );
    return rows.map(r => this.mapRow(r));
  }

  async updateContent(id: string, content: string, metadata?: Record<string, unknown>): Promise<Message | undefined> {
    const sets = ['content = $2'];
    const params: any[] = [id, content];
    let paramIdx = 3;
    if (metadata !== undefined) {
      sets.push(`metadata = $${paramIdx}`);
      params.push(sanitizeJsonForPg(metadata));
      paramIdx++;
    }
    const { rows } = await this.pool.query(
      `UPDATE messages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    // Invalidate enrichedMessagesCache by bumping session timestamp
    if (rows[0]) {
      await this.pool.query(
        'UPDATE sessions SET updated_at = now() WHERE id = $1',
        [(rows[0] as any).session_id],
      );
    }
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async getLatestCompactBoundary(sessionId: string): Promise<Message | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM messages
       WHERE session_id = $1 AND role = 'user' AND content LIKE '[COMPACT_BOUNDARY:%'
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  private mapRow(row: any): Message {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      metadata: typeof row.metadata === 'string' ? row.metadata : row.metadata ? JSON.stringify(row.metadata) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
