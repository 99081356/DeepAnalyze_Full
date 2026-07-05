// =============================================================================
// DeepAnalyze - PgEmbeddingRepo Integration Tests
// =============================================================================
// Integration tests that verify embedding CRUD operations against a running
// PostgreSQL instance with pgvector. Tests require a running PG instance.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { PgEmbeddingRepo } from '../../src/store/repos/embedding.js';
import type { EmbeddingCreate } from '../../src/store/repos/interfaces.js';

const pgHost = process.env.PG_HOST ?? '';
const pgAvailable = !!pgHost;

function uid(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

function makeVector(dimension: number, seed: number): Float32Array {
  const arr = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) {
    arr[i] = Math.sin(seed + i) * 0.5 + 0.5;
  }
  return arr;
}

describe.skipIf(!pgAvailable)('PgEmbeddingRepo', () => {
  let pool: pg.Pool;
  let repo: PgEmbeddingRepo;
  const cleanupIds: { kbIds: string[]; docIds: string[]; pageIds: string[]; embeddingIds: string[] } = {
    kbIds: [], docIds: [], pageIds: [], embeddingIds: [],
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
    await pool.query('SELECT 1');
    repo = new PgEmbeddingRepo(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  afterEach(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM embeddings WHERE id = ANY($1)', [
      cleanupIds.embeddingIds.length > 0 ? cleanupIds.embeddingIds : ['__none__'],
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
    cleanupIds.embeddingIds = [];
  });

  async function insertPrerequisites(kbId: string, docId: string, pageId: string) {
    cleanupIds.kbIds.push(kbId);
    cleanupIds.docIds.push(docId);
    cleanupIds.pageIds.push(pageId);
    await pool.query(
      `INSERT INTO knowledge_bases (id, name, owner_id, visibility) VALUES ($1, $2, 'test-owner', 'private')`,
      [kbId, `Test KB ${kbId}`],
    );
    await pool.query(
      `INSERT INTO documents (id, kb_id, filename, file_path, file_hash, file_size, file_type, status)
       VALUES ($1, $2, $3, $4, $5, 0, 'pdf', 'uploaded')`,
      [docId, kbId, `test-doc-${docId}.pdf`, `/test/${docId}.pdf`, `hash-${docId}`],
    );
    await pool.query(
      `INSERT INTO wiki_pages (id, kb_id, doc_id, page_type, title, file_path, content_hash, token_count)
       VALUES ($1, $2, $3, 'fulltext', $4, $5, '', 0)`,
      [pageId, kbId, docId, `Test Page ${pageId}`, `/test/${pageId}.md`],
    );
  }

  test('upsert + getOrNone round-trip', async () => {
    const kbId = uid();
    const docId = uid();
    const pageId = uid();
    await insertPrerequisites(kbId, docId, pageId);

    const dim = 1024;
    const vec = makeVector(dim, 42);
    const embId = uid();
    cleanupIds.embeddingIds.push(embId);

    await repo.upsert({
      id: embId, page_id: pageId, model_name: 'test-model', dimension: dim,
      vector: vec, text_chunk: 'Test chunk content', chunk_index: 0,
    });

    const fetched = await repo.getOrNone(pageId, 'test-model', 0);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(embId);
    expect(fetched!.model_name).toBe('test-model');
    expect(fetched!.dimension).toBe(dim);
    expect(fetched!.text_chunk).toBe('Test chunk content');
    expect(fetched!.vector.length).toBe(dim);
    for (let i = 0; i < dim; i++) {
      expect(Math.abs(fetched!.vector[i] - vec[i])).toBeLessThan(1e-6);
    }
  });

  test('upsert on conflict updates existing embedding', async () => {
    const kbId = uid();
    const docId = uid();
    const pageId = uid();
    await insertPrerequisites(kbId, docId, pageId);

    const dim = 1024;
    const embId1 = uid();
    cleanupIds.embeddingIds.push(embId1);

    await repo.upsert({
      id: embId1, page_id: pageId, model_name: 'conflict-model', dimension: dim,
      vector: makeVector(dim, 10), text_chunk: 'Original', chunk_index: 0,
    });

    const fetched1 = await repo.getOrNone(pageId, 'conflict-model', 0);
    expect(fetched1!.text_chunk).toBe('Original');

    const vec2 = makeVector(dim, 20);
    const embId2 = uid();
    cleanupIds.embeddingIds.push(embId2);

    await repo.upsert({
      id: embId2, page_id: pageId, model_name: 'conflict-model', dimension: dim,
      vector: vec2, text_chunk: 'Updated', chunk_index: 0,
    });

    const fetched2 = await repo.getOrNone(pageId, 'conflict-model', 0);
    expect(fetched2!.id).toBe(embId2);
    expect(fetched2!.text_chunk).toBe('Updated');
    for (let i = 0; i < dim; i++) {
      expect(Math.abs(fetched2!.vector[i] - vec2[i])).toBeLessThan(1e-6);
    }
  });

  test('deleteByPageId removes embedding', async () => {
    const kbId = uid();
    const docId = uid();
    const pageId = uid();
    await insertPrerequisites(kbId, docId, pageId);

    const embId = uid();
    cleanupIds.embeddingIds.push(embId);

    await repo.upsert({
      id: embId, page_id: pageId, model_name: 'delete-model', dimension: 1024,
      vector: makeVector(1024, 99), text_chunk: 'To be deleted', chunk_index: 0,
    });

    const before = await repo.getOrNone(pageId, 'delete-model', 0);
    expect(before).toBeDefined();

    await repo.deleteByPageId(pageId);
    const after = await repo.getOrNone(pageId, 'delete-model', 0);
    expect(after).toBeUndefined();
  });
});
