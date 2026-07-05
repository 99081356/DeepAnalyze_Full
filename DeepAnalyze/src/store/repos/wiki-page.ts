// =============================================================================
// DeepAnalyze - PgWikiPageRepo
// PostgreSQL implementation of WikiPageRepo.
// CRUD operations for wiki pages with JSONB metadata support.
// =============================================================================

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { WikiPageRepo, WikiPage, WikiPageCreate } from './interfaces';

export class PgWikiPageRepo implements WikiPageRepo {
  constructor(private pool: pg.Pool) {}

  async create(data: WikiPageCreate): Promise<WikiPage> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO wiki_pages (id, kb_id, doc_id, page_type, title, file_path, content, content_hash, token_count, metadata, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        data.kb_id,
        data.doc_id ?? null,
        data.page_type,
        data.title,
        data.file_path ?? '',
        data.content ?? '',
        data.content_hash ?? '',
        data.token_count ?? 0,
        JSON.stringify(data.metadata ?? {}),
        data.session_id ?? null,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async getById(id: string): Promise<WikiPage | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE id = $1',
      [id],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async getByIds(ids: string[]): Promise<Map<string, WikiPage>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE id = ANY($1)',
      [ids],
    );
    const map = new Map<string, WikiPage>();
    for (const row of rows) {
      const page = this.mapRow(row);
      map.set(page.id, page);
    }
    return map;
  }

  async getByDocAndType(docId: string, pageType: string): Promise<WikiPage | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE doc_id = $1 AND page_type = $2 LIMIT 1',
      [docId, pageType],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async getManyByDocAndType(docId: string, pageType: string): Promise<WikiPage[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE doc_id = $1 AND page_type = $2 ORDER BY created_at',
      [docId, pageType],
    );
    return rows.map((r: any) => this.mapRow(r));
  }

  async getManyByDocAndTypePrefix(docId: string, pageTypePrefix: string): Promise<WikiPage[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE doc_id = $1 AND page_type LIKE $2 ORDER BY created_at',
      [docId, `${pageTypePrefix}%`],
    );
    return rows.map((r: any) => this.mapRow(r));
  }

  async getByKbAndType(kbId: string, pageType?: string): Promise<WikiPage[]> {
    if (pageType) {
      const { rows } = await this.pool.query(
        'SELECT * FROM wiki_pages WHERE kb_id = $1 AND page_type = $2',
        [kbId, pageType],
      );
      return rows.map((r: any) => this.mapRow(r));
    }
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE kb_id = $1',
      [kbId],
    );
    return rows.map((r: any) => this.mapRow(r));
  }

  async getByKbTypeAndSession(kbId: string, pageType: string, sessionId?: string): Promise<WikiPage[]> {
    if (sessionId) {
      const { rows } = await this.pool.query(
        'SELECT * FROM wiki_pages WHERE kb_id = $1 AND page_type = $2 AND session_id = $3 ORDER BY created_at DESC',
        [kbId, pageType, sessionId],
      );
      return rows.map((r: any) => this.mapRow(r));
    }
    return this.getByKbAndType(kbId, pageType);
  }

  async getAllByType(pageType: string, limit: number = 100, offset: number = 0): Promise<WikiPage[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE page_type = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [pageType, limit, offset],
    );
    return rows.map((r: any) => this.mapRow(r));
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      'UPDATE wiki_pages SET metadata = $1, updated_at = now() WHERE id = $2',
      [JSON.stringify(metadata), id],
    );
  }

  async updateContent(id: string, content: string, contentHash: string, tokenCount: number): Promise<void> {
    await this.pool.query(
      'UPDATE wiki_pages SET content = $1, content_hash = $2, token_count = $3, updated_at = now() WHERE id = $4',
      [content, contentHash, tokenCount, id],
    );
  }

  async deleteById(id: string): Promise<void> {
    await this.pool.query('DELETE FROM wiki_pages WHERE id = $1', [id]);
  }

  async deleteByDocId(docId: string): Promise<void> {
    await this.pool.query('DELETE FROM wiki_pages WHERE doc_id = $1', [docId]);
  }

  async findByTitle(kbId: string, title: string, pageType: string): Promise<WikiPage | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_pages WHERE kb_id = $1 AND title = $2 AND page_type = $3 LIMIT 1',
      [kbId, title, pageType],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  /**
   * Get L1 content preview (first ~300 chars) for each document in a KB.
   * Uses COALESCE with priority: structure_md > structure > overview.
   * Returns a map of docId → preview string.
   */
  async getL1Previews(kbId: string): Promise<Record<string, string>> {
    const { rows } = await this.pool.query(
      `SELECT doc_id, LEFT(content, 300) AS preview
       FROM (
         SELECT doc_id, content,
                ROW_NUMBER() OVER (PARTITION BY doc_id ORDER BY
                  CASE page_type
                    WHEN 'structure_md' THEN 1
                    WHEN 'structure_dt' THEN 2
                    WHEN 'structure' THEN 3
                    WHEN 'overview' THEN 4
                    ELSE 5
                  END
                ) AS rn
         FROM wiki_pages
         WHERE kb_id = $1
           AND page_type IN ('structure_md', 'structure_dt', 'structure', 'overview')
           AND doc_id IS NOT NULL
       ) sub
       WHERE rn = 1`,
      [kbId],
    );
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.doc_id && row.preview) {
        result[row.doc_id] = row.preview;
      }
    }
    return result;
  }

  private mapRow(row: any): WikiPage {
    return {
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    };
  }
}
