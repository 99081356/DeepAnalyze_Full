// =============================================================================
// DeepAnalyze - PgVectorSearchRepo Integration Tests
// =============================================================================
// Integration tests that verify vector search operations against a running
// PostgreSQL instance with pgvector. Tests require a running PG instance.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { PgVectorSearchRepo } from '../../src/store/repos/vector-search.js';
import type { EmbeddingCreate } from '../../src/store/repos/interfaces.js';

// ---------------------------------------------------------------------------
// PG availability check - skip entire suite when PG is not reachable
// ---------------------------------------------------------------------------

const pgHost = process.env.PG_HOST ?? '';
const pgAvailable = !!pgHost;

// Helper to create a random UUID-like string for test IDs
function uid(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

// Helper to build a simple Float32Array vector of given dimension
// Uses a deterministic pattern based on a seed value for reproducibility
function makeVector(dimension: number, seed: number): Float32Array {
  const arr = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) {
    arr[i] = Math.sin(seed + i) * 0.5 + 0.5;
  }
  return arr;
}

// Normalize a vector for cosine similarity
function normalize(v: Float32Array): Float32Array {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const result = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    result[i] = v[i] / norm;
  }
  return result;
}

describe.skipIf(!pgAvailable)('PgVectorSearchRepo', () => {
  let pool: pg.Pool;
  let repo: PgVectorSearchRepo;
  const cleanupIds: { kbIds: string[]; docIds: string[]; pageIds: string[] } = {
    kbIds: [],
    docIds: [],
    pageIds: [],
  };

  beforeAll(async () => {
    pool = new pg.Pool({
      host: pgHost,
      port: parseInt(process.env.PG_PORT ?? '5432', 10),
      database: process.env.PG_DATABASE ?? 'deepanalyze',
      user: process.env.PG_USER ?? 'deepanalyze',
      password: process.env.PG_PASSWORD ?? 'deepanalyze_dev',
      max: 5,
    });

    // Verify connectivity
    await pool.query('SELECT 1');

    repo = new PgVectorSearchRepo(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // Clean up test data after each test to avoid interference
  afterEach(async () => {
    if (!pool) return;
    // Delete in reverse dependency order
    await pool.query('DELETE FROM embeddings WHERE page_id = ANY($1)', [
      cleanupIds.pageIds.length > 0 ? cleanupIds.pageIds : ['__none__'],
    ]);
    await pool.query('DELETE FROM wiki_pages WHERE id = ANY($1)', [
      cleanupIds.pageIds.length > 0 ? cleanupIds.pageIds : ['__none__'],
    ]);
    await pool.query('DELETE FROM documents WHERE id = ANY($1)', [
      cleanupIds.docIds.length > 0 ? cleanupIds.docIds : ['__none__'],
    ]);
    await pool.query('DELETE FROM knowledge_bases WHERE id = ANY($1)', [
      cleanupIds.kbIds.length > 0 ? cleanupIds.kbIds : ['__none__'],
    ]);
    cleanupIds.kbIds = [];
    cleanupIds.docIds = [];
    cleanupIds.pageIds = [];
  });

  // Helper to insert prerequisite test data (kb, doc, page)
  async function insertPrerequisites(kbId: string, docId: string, pageId: string) {
    cleanupIds.kbIds.push(kbId);
    cleanupIds.docIds.push(docId);
    cleanupIds.pageIds.push(pageId);

    await pool.query(
      `INSERT INTO knowledge_bases (id, name, owner_id, visibility)
       VALUES ($1, $2, 'test-owner', 'private')
       ON CONFLICT (id) DO NOTHING`,
      [kbId, `Test KB ${kbId}`],
    );
    await pool.query(
      `INSERT INTO documents (id, kb_id, filename, file_path, file_hash, file_size, file_type, status)
       VALUES ($1, $2, $3, $4, $5, 0, 'pdf', 'uploaded')
       ON CONFLICT (id) DO NOTHING`,
      [docId, kbId, `test-doc-${docId}.pdf`, `/test/${docId}.pdf`, `hash-${docId}`],
    );
    await pool.query(
      `INSERT INTO wiki_pages (id, kb_id, doc_id, page_type, title, file_path, content_hash, token_count)
       VALUES ($1, $2, $3, 'fulltext', $4, $5, '', 0)
       ON CONFLICT (id) DO NOTHING`,
      [pageId, kbId, docId, `Test Page ${pageId}`, `/test/${pageId}.md`],
    );
  }

  // -------------------------------------------------------------------------
  // Test: upsertEmbedding + searchByVector returns top-K sorted by similarity
  // -------------------------------------------------------------------------
  test('upsertEmbedding + searchByVector returns top-K results sorted by similarity descending', async () => {
    const kbId = uid();
    const docId = uid();
    const dim = 1024;

    // Create 5 pages with different vectors
    const pageIds: string[] = [];
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 5; i++) {
      const pageId = uid();
      pageIds.push(pageId);
      const vec = normalize(makeVector(dim, i * 100));
      vectors.push(vec);
      await insertPrerequisites(kbId, docId, pageId);

      const row: EmbeddingCreate = {
        id: uid(),
        page_id: pageId,
        model_name: 'test-model',
        dimension: dim,
        vector: vec,
        text_chunk: `Chunk content for page ${i}`,
        chunk_index: 0,
      };
      await repo.upsertEmbedding(row);
    }

    // Query with vector similar to page 2 (seed=200)
    const queryVec = normalize(makeVector(dim, 200));
    const results = await repo.searchByVector(queryVec, [kbId], {
      topK: 3,
      modelName: 'test-model',
    });

    expect(results.length).toBe(3);

    // Results should be sorted by similarity descending (i.e., distance ascending)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(
        results[i].similarity,
      );
    }

    // The first result should be the page whose vector was generated with seed 200
    expect(results[0].page_id).toBe(pageIds[2]);

    // Verify all result fields are present
    for (const r of results) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('page_id');
      expect(r).toHaveProperty('text_chunk');
      expect(r).toHaveProperty('model_name');
      expect(r).toHaveProperty('similarity');
      expect(r).toHaveProperty('kb_id');
      expect(r).toHaveProperty('doc_id');
      expect(r).toHaveProperty('page_type');
      expect(r).toHaveProperty('title');
      expect(r.kb_id).toBe(kbId);
    }
  });

  // -------------------------------------------------------------------------
  // Test: searchByVector supports kbIds filtering
  // -------------------------------------------------------------------------
  test('searchByVector supports kbIds filtering', async () => {
    const kbId1 = uid();
    const kbId2 = uid();
    const docId1 = uid();
    const docId2 = uid();
    const dim = 1024;

    // Insert pages in two different knowledge bases
    const pageId1 = uid();
    const pageId2 = uid();
    await insertPrerequisites(kbId1, docId1, pageId1);
    await insertPrerequisites(kbId2, docId2, pageId2);

    const vec1 = normalize(makeVector(dim, 10));
    const vec2 = normalize(makeVector(dim, 20));

    await repo.upsertEmbedding({
      id: uid(),
      page_id: pageId1,
      model_name: 'filter-model',
      dimension: dim,
      vector: vec1,
      text_chunk: 'KB1 content',
      chunk_index: 0,
    });
    await repo.upsertEmbedding({
      id: uid(),
      page_id: pageId2,
      model_name: 'filter-model',
      dimension: dim,
      vector: vec2,
      text_chunk: 'KB2 content',
      chunk_index: 0,
    });

    // Search only in kbId1
    const results1 = await repo.searchByVector(vec1, [kbId1], {
      topK: 10,
      modelName: 'filter-model',
    });
    expect(results1.length).toBe(1);
    expect(results1[0].kb_id).toBe(kbId1);

    // Search only in kbId2
    const results2 = await repo.searchByVector(vec2, [kbId2], {
      topK: 10,
      modelName: 'filter-model',
    });
    expect(results2.length).toBe(1);
    expect(results2[0].kb_id).toBe(kbId2);

    // Search in both KBs
    const results3 = await repo.searchByVector(vec1, [kbId1, kbId2], {
      topK: 10,
      modelName: 'filter-model',
    });
    expect(results3.length).toBe(2);

    // Search in an empty KB list (non-existent KB)
    const results4 = await repo.searchByVector(vec1, ['non-existent-kb'], {
      topK: 10,
      modelName: 'filter-model',
    });
    expect(results4.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test: deleteByPageId removes vectors so they are no longer searchable
  // -------------------------------------------------------------------------
  test('deleteByPageId removes vectors so they are no longer searchable', async () => {
    const kbId = uid();
    const docId = uid();
    const dim = 1024;

    const pageId1 = uid();
    const pageId2 = uid();
    await insertPrerequisites(kbId, docId, pageId1);
    await insertPrerequisites(kbId, docId, pageId2);

    const vec1 = normalize(makeVector(dim, 42));
    const vec2 = normalize(makeVector(dim, 99));

    await repo.upsertEmbedding({
      id: uid(),
      page_id: pageId1,
      model_name: 'delete-model',
      dimension: dim,
      vector: vec1,
      text_chunk: 'Page 1 content',
      chunk_index: 0,
    });
    await repo.upsertEmbedding({
      id: uid(),
      page_id: pageId2,
      model_name: 'delete-model',
      dimension: dim,
      vector: vec2,
      text_chunk: 'Page 2 content',
      chunk_index: 0,
    });

    // Verify both are searchable
    const beforeDelete = await repo.searchByVector(vec1, [kbId], {
      topK: 10,
      modelName: 'delete-model',
    });
    expect(beforeDelete.length).toBe(2);

    // Delete page1's embeddings
    await repo.deleteByPageId(pageId1);

    // Verify only page2 is searchable
    const afterDelete = await repo.searchByVector(vec1, [kbId], {
      topK: 10,
      modelName: 'delete-model',
    });
    expect(afterDelete.length).toBe(1);
    expect(afterDelete[0].page_id).toBe(pageId2);

    // Clean up the deleted page id from cleanup list (already deleted from DB)
    // pageId1's wiki_page still exists so afterEach can clean it
  });
});
