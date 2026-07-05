// =============================================================================
// DeepAnalyze - PgFTSSearchRepo Integration Tests
// =============================================================================
// Integration tests that verify full-text search operations against a running
// PostgreSQL instance with zhparser. Tests require a running PG instance.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { PgFTSSearchRepo } from '../../src/store/repos/fts-search.js';

// ---------------------------------------------------------------------------
// PG availability check - skip entire suite when PG is not reachable
// ---------------------------------------------------------------------------

const pgHost = process.env.PG_HOST ?? '';
const pgAvailable = !!pgHost;

function uid(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!pgAvailable)('PgFTSSearchRepo', () => {
  let pool: pg.Pool;
  let repo: PgFTSSearchRepo;
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
    await pool.query('SELECT 1');
    repo = new PgFTSSearchRepo(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  afterEach(async () => {
    if (!pool) return;
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

  async function insertPrerequisites(kbId: string, docId: string, pageId: string) {
    cleanupIds.kbIds.push(kbId);
    cleanupIds.docIds.push(docId);
    cleanupIds.pageIds.push(pageId);

    await pool.query(
      `INSERT INTO knowledge_bases (id, name, owner_id, visibility)
       VALUES ($1, $2, 'test-owner', 'private')`,
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

  // -------------------------------------------------------------------------
  // Test: upsertFTSEntry + searchByText returns matching results
  // -------------------------------------------------------------------------
  test('upsertFTSEntry + searchByText returns matching results', async () => {
    const kbId = uid();
    const docId = uid();
    const pageId = uid();
    await insertPrerequisites(kbId, docId, pageId);

    await repo.upsertFTSEntry(pageId, 'PostgreSQL database guide', 'This is a guide about PostgreSQL database administration and tuning.');

    const results = await repo.searchByText('PostgreSQL', [kbId], { topK: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);

    const match = results.find((r) => r.id === pageId);
    expect(match).toBeDefined();
    expect(match!.title).toBe('PostgreSQL database guide');
    expect(match!.rank).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test: searchByText with kbIds filtering
  // -------------------------------------------------------------------------
  test('searchByText filters results by kbIds', async () => {
    const kbId1 = uid();
    const kbId2 = uid();
    const docId1 = uid();
    const docId2 = uid();
    const pageId1 = uid();
    const pageId2 = uid();

    await insertPrerequisites(kbId1, docId1, pageId1);
    await insertPrerequisites(kbId2, docId2, pageId2);

    await repo.upsertFTSEntry(pageId1, 'Machine learning basics', 'Introduction to machine learning algorithms and techniques.');
    await repo.upsertFTSEntry(pageId2, 'Machine learning advanced', 'Advanced machine learning topics including deep neural networks.');

    // Search only in kbId1
    const results1 = await repo.searchByText('machine learning', [kbId1], { topK: 10 });
    expect(results1.length).toBe(1);
    expect(results1[0].kb_id).toBe(kbId1);

    // Search only in kbId2
    const results2 = await repo.searchByText('machine learning', [kbId2], { topK: 10 });
    expect(results2.length).toBe(1);
    expect(results2[0].kb_id).toBe(kbId2);

    // Search in non-existent KB
    const results3 = await repo.searchByText('machine learning', ['non-existent-kb'], { topK: 10 });
    expect(results3.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test: deleteByPageId clears FTS vector so results no longer appear
  // -------------------------------------------------------------------------
  test('deleteByPageId clears FTS vector so results no longer appear', async () => {
    const kbId = uid();
    const docId = uid();
    const pageId = uid();
    await insertPrerequisites(kbId, docId, pageId);

    await repo.upsertFTSEntry(pageId, 'Docker container orchestration', 'How to orchestrate Docker containers in production environments.');

    const beforeDelete = await repo.searchByText('Docker', [kbId], { topK: 10 });
    expect(beforeDelete.length).toBeGreaterThanOrEqual(1);

    await repo.deleteByPageId(pageId);

    const afterDelete = await repo.searchByText('Docker', [kbId], { topK: 10 });
    const match = afterDelete.find((r) => r.id === pageId);
    expect(match).toBeUndefined();
  });
});
