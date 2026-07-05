import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ReportRepo, Report, ReportReference, ReportWithReferences, CreateReportData } from './interfaces';

export class PgReportRepo implements ReportRepo {
  constructor(private pool: pg.Pool) {}

  async create(data: CreateReportData): Promise<ReportWithReferences> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO reports (id, session_id, message_id, title, clean_content, raw_content, entities) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, data.sessionId, data.messageId, data.title, data.cleanContent, data.rawContent, JSON.stringify(data.entities ?? [])],
      );
      const refs: ReportReference[] = [];
      if (data.references) {
        for (const ref of data.references) {
          const { rows } = await client.query(
            `INSERT INTO report_references (report_id, ref_index, doc_id, page_id, title, level, snippet, highlight) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [id, ref.refIndex, ref.docId, ref.pageId, ref.title, ref.level, ref.snippet, ref.highlight],
          );
          refs.push({ ...ref, id: rows[0].id, reportId: id });
        }
      }
      await client.query('COMMIT');
      const report = await this.get(id);
      return report!;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<ReportWithReferences | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM reports WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const report = this.mapReport(rows[0]);
    const { rows: refRows } = await this.pool.query(
      'SELECT * FROM report_references WHERE report_id = $1 ORDER BY ref_index', [id],
    );
    return { ...report, references: refRows.map(this.mapRef) };
  }

  async getByMessageId(messageId: string): Promise<ReportWithReferences | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM reports WHERE message_id = $1', [messageId]);
    if (!rows[0]) return undefined;
    return this.get(rows[0].id);
  }

  async list(limit: number = 20, offset: number = 0): Promise<Report[]> {
    const { rows } = await this.pool.query('SELECT * FROM reports ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return rows.map(r => this.mapReport(r));
  }

  async listBySession(sessionId: string): Promise<Report[]> {
    const { rows } = await this.pool.query('SELECT * FROM reports WHERE session_id = $1 ORDER BY created_at DESC', [sessionId]);
    return rows.map(r => this.mapReport(r));
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM reports WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapReport(row: any): Report {
    let entities: string[] = [];
    try {
      const parsed = typeof row.entities === 'string' ? JSON.parse(row.entities) : row.entities;
      entities = Array.isArray(parsed) ? parsed : [];
    } catch {}
    return {
      id: row.id, sessionId: row.session_id, messageId: row.message_id,
      title: row.title, cleanContent: row.clean_content, rawContent: row.raw_content,
      entities, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }

  private mapRef(row: any): ReportReference {
    return {
      id: row.id, reportId: row.report_id, refIndex: row.ref_index,
      docId: row.doc_id, pageId: row.page_id, title: row.title,
      level: row.level, snippet: row.snippet, highlight: row.highlight,
    };
  }
}
