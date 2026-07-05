import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { WikiLinkRepo, WikiLink, WikiPageSummary } from './interfaces';

export class PgWikiLinkRepo implements WikiLinkRepo {
  constructor(private pool: pg.Pool) {}

  async create(sourcePageId: string, targetPageId: string, linkType: string, entityName?: string, context?: string): Promise<WikiLink> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO wiki_links (id, source_page_id, target_page_id, link_type, entity_name, context) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, sourcePageId, targetPageId, linkType, entityName ?? null, context ?? null],
    );
    return this.mapRow(rows[0]);
  }

  async getOutgoing(pageId: string): Promise<WikiLink[]> {
    const { rows } = await this.pool.query('SELECT * FROM wiki_links WHERE source_page_id = $1', [pageId]);
    return rows.map(r => this.mapRow(r));
  }

  async getIncoming(pageId: string): Promise<WikiLink[]> {
    const { rows } = await this.pool.query('SELECT * FROM wiki_links WHERE target_page_id = $1', [pageId]);
    return rows.map(r => this.mapRow(r));
  }

  async deleteByPageId(pageId: string): Promise<void> {
    await this.pool.query('DELETE FROM wiki_links WHERE source_page_id = $1 OR target_page_id = $1', [pageId]);
  }

  async findExisting(sourcePageId: string, targetPageId: string, linkType: string, entityName?: string): Promise<WikiLink | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM wiki_links WHERE source_page_id = $1 AND target_page_id = $2 AND link_type = $3',
      [sourcePageId, targetPageId, linkType],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async findEntityLinksByKb(kbId: string): Promise<Array<{ sourcePageId: string; entityName: string }>> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT wl.source_page_id AS "sourcePageId", wl.entity_name AS "entityName"
       FROM wiki_links wl JOIN wiki_pages wp ON wp.id = wl.source_page_id
       WHERE wp.kb_id = $1 AND wl.link_type = 'entity_ref'`,
      [kbId],
    );
    return rows;
  }

  async findRelatedByEntity(kbId: string, entityName: string): Promise<WikiPageSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT wp.id, wp.kb_id AS "kbId", wp.doc_id AS "docId", wp.page_type AS "pageType", wp.title, wp.file_path AS "filePath"
       FROM wiki_pages wp JOIN wiki_links wl ON wl.source_page_id = wp.id
       WHERE wp.kb_id = $1 AND wl.entity_name = $2`,
      [kbId, entityName],
    );
    return rows;
  }

  private mapRow(row: any): WikiLink {
    return {
      id: row.id,
      sourcePageId: row.source_page_id,
      targetPageId: row.target_page_id,
      linkType: row.link_type,
      entityName: row.entity_name,
      context: row.context,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
