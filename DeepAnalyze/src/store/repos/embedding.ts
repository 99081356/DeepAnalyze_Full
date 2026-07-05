// =============================================================================
// DeepAnalyze - PgEmbeddingRepo
// PostgreSQL implementation of EmbeddingRepo.
// Manages embedding rows with deduplication by page+model+chunk using
// the unique index on (page_id, model_name, chunk_index).
// =============================================================================

import pg from 'pg';
import type { EmbeddingRepo, EmbeddingRow, EmbeddingCreate } from './interfaces';

export class PgEmbeddingRepo implements EmbeddingRepo {
  constructor(private pool: pg.Pool) {}

  async getOrNone(pageId: string, modelName: string, chunkIndex: number): Promise<EmbeddingRow | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM embeddings WHERE page_id = $1 AND model_name = $2 AND chunk_index = $3',
      [pageId, modelName, chunkIndex],
    );
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async upsert(row: EmbeddingCreate): Promise<void> {
    const vecStr = `[${Array.from(row.vector).join(',')}]`;
    await this.pool.query(
      `INSERT INTO embeddings (id, page_id, model_name, dimension, vector, text_chunk, chunk_index)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
       ON CONFLICT (page_id, model_name, chunk_index)
       DO UPDATE SET vector = EXCLUDED.vector,
                     text_chunk = EXCLUDED.text_chunk,
                     dimension = EXCLUDED.dimension,
                     id = EXCLUDED.id`,
      [
        row.id,
        row.page_id,
        row.model_name,
        row.dimension,
        vecStr,
        row.text_chunk ?? null,
        row.chunk_index ?? 0,
      ],
    );
  }

  async deleteByPageId(pageId: string): Promise<void> {
    await this.pool.query('DELETE FROM embeddings WHERE page_id = $1', [pageId]);
  }

  async markAllStale(): Promise<void> {
    await this.pool.query('UPDATE embeddings SET stale = true');
  }

  async getStaleCount(): Promise<number> {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int as cnt FROM embeddings WHERE stale = true');
    return rows[0].cnt;
  }

  private mapRow(row: any): EmbeddingRow {
    // Parse the vector column from PG string format "[v1,v2,...]" back to Float32Array
    let vector: Float32Array;
    if (typeof row.vector === 'string') {
      const nums = row.vector
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map(Number);
      vector = new Float32Array(nums);
    } else if (row.vector instanceof Float32Array) {
      vector = row.vector;
    } else {
      // PG might return a Buffer for the vector type
      vector = new Float32Array(row.vector);
    }
    return {
      ...row,
      vector,
    };
  }
}
