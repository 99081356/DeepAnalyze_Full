import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SessionMemoryRepo, SessionMemory } from './interfaces';

/** Strip PostgreSQL-incompatible characters from a JSON string.
 *  PG jsonb rejects \u0000 (null byte escape) and lone UTF-16 surrogates.
 *  IMPORTANT: Only replace LONE surrogates, not valid surrogate pairs (emoji etc.). */
function sanitizeJsonStr(str: string): string {
  return str
    .replace(/\\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\ufffd');
}

export class PgSessionMemoryRepo implements SessionMemoryRepo {
  constructor(private pool: pg.Pool) {}

  async load(sessionId: string): Promise<SessionMemory | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM session_memory WHERE session_id = $1', [sessionId]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async save(sessionId: string, content: string, tokenCount: number, lastTokenPosition: number, searchIndexJson?: string): Promise<void> {
    // Sanitize and validate searchIndexJson before passing to PG jsonb column.
    // PG rejects \u0000, lone surrogates, and structurally invalid JSON.
    let safeIndexJson: string | null = null;
    if (searchIndexJson != null) {
      try {
        const raw = typeof searchIndexJson === 'string' ? searchIndexJson : JSON.stringify(searchIndexJson);
        const sanitized = sanitizeJsonStr(raw);
        // Validate that the result is parseable JSON
        JSON.parse(sanitized);
        safeIndexJson = sanitized;
      } catch {
        // If JSON is structurally invalid, skip persisting the search index
        // rather than crashing the agent. The memory content itself is still saved.
        safeIndexJson = null;
      }
    }

    await this.pool.query(
      `INSERT INTO session_memory (id, session_id, content, token_count, last_token_position, search_index_json) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO UPDATE SET content = $3, token_count = $4, last_token_position = $5, search_index_json = $6, updated_at = now()`,
      [randomUUID(), sessionId, content, tokenCount, lastTokenPosition, safeIndexJson],
    );
  }

  async listRecent(limit: number): Promise<Array<{ sessionId: string; content: string }>> {
    const { rows } = await this.pool.query(
      'SELECT session_id, content FROM session_memory ORDER BY updated_at DESC LIMIT $1', [limit],
    );
    return rows.map(r => ({ sessionId: r.session_id, content: r.content }));
  }

  private mapRow(row: any): SessionMemory {
    const rawIndex = row.search_index_json;
    return {
      id: row.id, sessionId: row.session_id, content: row.content,
      tokenCount: row.token_count, lastTokenPosition: row.last_token_position,
      // pg returns jsonb as parsed object; stringify for consistent type handling
      searchIndexJson: rawIndex != null
        ? (typeof rawIndex === 'string' ? rawIndex : JSON.stringify(rawIndex))
        : undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
