// =============================================================================
// DeepAnalyze - PgVectorSearchRepo
// PostgreSQL implementation of VectorSearchRepo using pgvector HNSW index.
// Handles embedding upserts and cosine-similarity lookups.
// =============================================================================

import pg from 'pg';
import type {
  VectorSearchRepo,
  VectorSearchResult,
  EmbeddingCreate,
  VectorSearchOptions,
} from './interfaces';

export class PgVectorSearchRepo implements VectorSearchRepo {
  constructor(private pool: pg.Pool) {}

  async upsertEmbedding(row: EmbeddingCreate): Promise<void> {
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

  async searchByVector(
    queryVector: Float32Array,
    kbIds: string[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const vecStr = `[${Array.from(queryVector).join(',')}]`;
    const conditions = ['wp.kb_id = ANY($2)'];
    const params: unknown[] = [vecStr, kbIds];
    let paramIdx = 3;

    if (options.modelName) {
      conditions.push(`e.model_name = $${paramIdx}`);
      params.push(options.modelName);
      paramIdx++;
    }

    if (options.pageTypes?.length) {
      conditions.push(`wp.page_type = ANY($${paramIdx})`);
      params.push(options.pageTypes);
      paramIdx++;
    }

    const minScoreCondition = options.minScore
      ? `AND 1 - (e.vector <=> $1::vector) >= ${Number(options.minScore)}`
      : '';

    const sql = `
      SELECT e.id,
             e.page_id,
             e.text_chunk,
             e.model_name,
             1 - (e.vector <=> $1::vector) AS similarity,
             wp.kb_id,
             wp.doc_id,
             wp.page_type,
             wp.title
      FROM embeddings e
      JOIN wiki_pages wp ON wp.id = e.page_id
      WHERE ${conditions.join(' AND ')} ${minScoreCondition}
      ORDER BY e.vector <=> $1::vector
      LIMIT $${paramIdx}`;

    params.push(options.topK);
    const { rows } = await this.pool.query(sql, params);
    return rows as VectorSearchResult[];
  }

  async deleteByPageId(pageId: string): Promise<void> {
    await this.pool.query('DELETE FROM embeddings WHERE page_id = $1', [pageId]);
  }

  async deleteByDocId(docId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM embeddings
       WHERE page_id IN (SELECT id FROM wiki_pages WHERE doc_id = $1)`,
      [docId],
    );
  }
}
