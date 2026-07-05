// =============================================================================
// DeepAnalyze - Full-Text Search Repository (PostgreSQL + zhparser)
// Implements FTSSearchRepo using PostgreSQL's tsvector/tsquery with the
// chinese text search configuration (zhparser for Chinese word segmentation).
// =============================================================================

import pg from 'pg';
import type { FTSSearchRepo, FTSSearchResult } from './interfaces';

export class PgFTSSearchRepo implements FTSSearchRepo {
  constructor(private pool: pg.Pool) {}

  async upsertFTSEntry(pageId: string, title: string, content: string): Promise<void> {
    // Update fts_vector column using the chinese text search configuration.
    // The trigger on wiki_pages should handle this, but we also do it explicitly for safety.
    await this.pool.query(
      `UPDATE wiki_pages SET
         title = $2,
         content = $3,
         fts_vector = setweight(to_tsvector('chinese', COALESCE($2, '')), 'A')
                    || setweight(to_tsvector('chinese', COALESCE($3, '')), 'B')
       WHERE id = $1`,
      [pageId, title, content],
    );
  }

  async searchByText(
    query: string,
    kbIds: string[],
    options: { topK: number },
  ): Promise<FTSSearchResult[]> {
    // Use plainto_tsquery for user-friendly query parsing.
    // zhparser handles Chinese word segmentation via the 'chinese' configuration.
    const sql = `
      SELECT wp.id, wp.kb_id, wp.doc_id, wp.page_type, wp.title, wp.file_path,
             ts_rank(wp.fts_vector, q.query) as rank
      FROM wiki_pages wp, plainto_tsquery('chinese', $1) q(query)
      WHERE wp.fts_vector @@ q.query
        AND wp.kb_id = ANY($2)
      ORDER BY rank DESC
      LIMIT $3`;

    const { rows } = await this.pool.query(sql, [query, kbIds, options.topK]);
    return rows as FTSSearchResult[];
  }

  async deleteByPageId(pageId: string): Promise<void> {
    // FTS entries are part of wiki_pages, so we just clear the fts_vector.
    await this.pool.query(
      'UPDATE wiki_pages SET fts_vector = NULL WHERE id = $1',
      [pageId],
    );
  }
}
