// =============================================================================
// DeepAnalyze - PgAnchorRepo
// PostgreSQL implementation of AnchorRepo.
// Manages structural element anchors for documents.
// =============================================================================

import pg from 'pg';
import type { AnchorRepo, AnchorDef } from './interfaces';

export class PgAnchorRepo implements AnchorRepo {
  constructor(private pool: pg.Pool) {}

  async batchInsert(anchors: AnchorDef[]): Promise<void> {
    if (anchors.length === 0) return;
    for (const a of anchors) {
      await this.pool.query(
        `INSERT INTO anchors (id, doc_id, kb_id, element_type, element_index, section_path, section_title, page_number, raw_json_path, structure_page_id, content_preview, content_hash, line_start, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id,
          a.doc_id,
          a.kb_id,
          a.element_type,
          a.element_index,
          a.section_path ?? null,
          a.section_title ?? null,
          a.page_number ?? null,
          a.raw_json_path ?? null,
          a.structure_page_id ?? null,
          a.content_preview ?? null,
          a.content_hash ?? null,
          a.line_start ?? null,
          JSON.stringify(a.metadata ?? {}),
        ],
      );
    }
  }

  async getByDocId(docId: string): Promise<AnchorDef[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM anchors WHERE doc_id = $1 ORDER BY element_index',
      [docId],
    );
    return rows.map((r: any) => this.mapRow(r));
  }

  async getById(anchorId: string): Promise<AnchorDef | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM anchors WHERE id = $1',
      [anchorId],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  /**
   * Fuzzy anchor lookup: matches short UUID prefix + tolerant element_type.
   * Anchor IDs are "{docId}:{elementType}:{index}".
   * Agent may generate "269d741c:text:0" but DB stores "269d741c-95e2-...:unknown:0".
   */
  async getByFuzzyId(anchorId: string): Promise<AnchorDef | undefined> {
    const parts = anchorId.split(':');
    if (parts.length < 3) return undefined;

    const [prefix, type, indexStr] = parts;
    const index = parseInt(indexStr, 10);
    if (isNaN(index)) return undefined;

    // Attempt 1: prefix LIKE match on anchor ID (covers full UUID prefix)
    const { rows } = await this.pool.query(
      `SELECT * FROM anchors
       WHERE id LIKE $1
       ORDER BY
         CASE WHEN element_type = $2 THEN 0 ELSE 1 END,
         id ASC
       LIMIT 1`,
      [`${prefix}-%:%:${index}`, type],
    );
    if (rows.length > 0) return this.mapRow(rows[0]);

    // Attempt 2: prefix LIKE match on doc_id column + element_index
    const { rows: rows2 } = await this.pool.query(
      `SELECT a.* FROM anchors a
       WHERE a.doc_id::text LIKE $1
       AND a.element_index = $2
       ORDER BY
         CASE WHEN a.element_type = $3 THEN 0 ELSE 1 END,
         a.id ASC
       LIMIT 1`,
      [`${prefix}%`, index, type],
    );
    if (rows2.length > 0) return this.mapRow(rows2[0]);

    return undefined;
  }

  async getByStructurePageId(pageId: string): Promise<AnchorDef[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM anchors WHERE structure_page_id = $1 ORDER BY element_index',
      [pageId],
    );
    return rows.map((r: any) => this.mapRow(r));
  }

  async updateStructurePageId(anchorIds: string[], pageId: string): Promise<void> {
    await this.pool.query(
      'UPDATE anchors SET structure_page_id = $1 WHERE id = ANY($2)',
      [pageId, anchorIds],
    );
  }

  async deleteByDocId(docId: string): Promise<void> {
    await this.pool.query('DELETE FROM anchors WHERE doc_id = $1', [docId]);
  }

  private mapRow(row: any): AnchorDef {
    return {
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    };
  }
}
