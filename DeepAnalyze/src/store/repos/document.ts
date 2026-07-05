// =============================================================================
// DeepAnalyze - PgDocumentRepo
// PostgreSQL implementation of DocumentRepo.
// CRUD operations for document records with processing status tracking.
// =============================================================================

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { DocumentRepo, Document } from './interfaces';

export class PgDocumentRepo implements DocumentRepo {
  constructor(private pool: pg.Pool) {}

  async getById(id: string): Promise<Document | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM documents WHERE id = $1',
      [id],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async getByKbId(kbId: string): Promise<Document[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM documents WHERE kb_id = $1 ORDER BY created_at DESC',
      [kbId],
    );
    return rows.map((r: any) => this.mapRow(r));
  }

  async create(doc: Omit<Document, 'id' | 'created_at'>): Promise<Document> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO documents (id, kb_id, filename, file_path, folder_path, file_hash, file_size, file_type, status, metadata, processing_step, processing_progress, processing_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        id,
        doc.kb_id,
        doc.filename,
        doc.file_path,
        doc.folder_path ?? '',
        doc.file_hash,
        doc.file_size,
        doc.file_type,
        doc.status,
        JSON.stringify(doc.metadata ?? {}),
        doc.processing_step ?? null,
        doc.processing_progress ?? 0,
        doc.processing_error ?? null,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE documents SET status = $1, updated_at = now() WHERE id = $2',
      [status, id],
    );
  }

  async updateProcessing(id: string, step: string, progress: number, error?: string): Promise<void> {
    await this.pool.query(
      'UPDATE documents SET processing_step = $1, processing_progress = $2, processing_error = $3, updated_at = now() WHERE id = $4',
      [step, progress, error ?? null, id],
    );
  }

  async deleteById(id: string): Promise<void> {
    await this.pool.query('DELETE FROM documents WHERE id = $1', [id]);
  }

  async deleteByKbId(kbId: string): Promise<void> {
    await this.pool.query('DELETE FROM documents WHERE kb_id = $1', [kbId]);
  }

  async updateStatusWithProcessing(id: string, status: string, step: string, progress: number, error?: string): Promise<void> {
    await this.pool.query(
      'UPDATE documents SET status = $1, processing_step = $2, processing_progress = $3, processing_error = $4, updated_at = now() WHERE id = $5',
      [status, step, progress, error ?? null, id],
    );
  }

  /**
   * Recover documents stuck in intermediate states (parsing, compiling, indexing, linking)
   * by resetting them to "uploaded". Returns the number of documents recovered.
   */
  async recoverStuck(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE documents
       SET status = 'uploaded', processing_step = NULL, processing_progress = 0, processing_error = NULL, updated_at = now()
       WHERE status IN ('parsing', 'compiling', 'indexing', 'linking', 'quality_audit')`
    );
    return rowCount ?? 0;
  }

  /**
   * Find documents by status(es), optionally filtered by staleness threshold.
   * Used by the ProcessingQueue watchdog and startup recovery.
   * @param statuses Array of statuses to match
   * @param staleThresholdMs If provided, only return docs where updated_at is older than this threshold
   */
  async findByStatus(statuses: string[], staleThresholdMs?: number): Promise<Record<string, unknown>[]> {
    let query = `SELECT * FROM documents WHERE status = ANY($1)`;
    const params: unknown[] = [statuses];
    if (staleThresholdMs !== undefined) {
      query += ` AND updated_at < NOW() - ($2 || ' milliseconds')::interval`;
      params.push(staleThresholdMs);
    }
    const { rows } = await this.pool.query(query, params);
    return rows;
  }

  async updateFolderPath(id: string, folderPath: string, filename: string, filePath: string): Promise<void> {
    await this.pool.query(
      'UPDATE documents SET folder_path = $1, filename = $2, file_path = $3, updated_at = now() WHERE id = $4',
      [folderPath, filename, filePath, id],
    );
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    // Read existing metadata, merge with new values, write back
    const { rows } = await this.pool.query(
      'SELECT metadata FROM documents WHERE id = $1',
      [id],
    );
    if (rows.length === 0) return;
    const existing = typeof rows[0].metadata === 'string'
      ? JSON.parse(rows[0].metadata)
      : (rows[0].metadata ?? {});
    const merged = { ...existing, ...metadata };
    await this.pool.query(
      'UPDATE documents SET metadata = $1, updated_at = now() WHERE id = $2',
      [JSON.stringify(merged), id],
    );
  }

  private mapRow(row: any): Document {
    return {
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    };
  }
}
