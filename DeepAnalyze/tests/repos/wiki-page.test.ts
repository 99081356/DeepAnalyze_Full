// =============================================================================
// DeepAnalyze - PgWikiPageRepo Integration Tests
// =============================================================================
// Integration tests that verify wiki page CRUD operations against a running
// PostgreSQL instance. Tests require a running PG instance.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { PgWikiPageRepo } from '../../src/store/repos/wiki-page.js';

const pgHost = process.env.PG_HOST ?? '';
const pgAvailable = !!pgHost;

function uid(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!pgAvailable)('PgWikiPageRepo', () => {
  let pool: pg.Pool;
  let repo: PgWikiPageRepo;
  const cleanupIds: { kbIds: string[]; docIds: string[]; pageIds: string[] } = {
    kbIds: [], docIds: [], pageIds: [],
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
    repo = new PgWikiPageRepo(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
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

  async function insertPrerequisites(kbId: string, docId: string) {
    cleanupIds.kbIds.push(kbId);
    cleanupIds.docIds.push(docId);
    await pool.query(
      `INSERT INTO knowledge_bases (id, name, owner_id, visibility) VALUES ($1, $2, 'test-owner', 'private')`,
      [kbId, `Test KB ${kbId}`],
    );
    await pool.query(
      `INSERT INTO documents (id, kb_id, filename, file_path, file_hash, file_size, file_type, status)
       VALUES ($1, $2, $3, $4, $5, 0, 'pdf', 'uploaded')`,
      [docId, kbId, `test-doc-${docId}.pdf`, `/test/${docId}.pdf`, `hash-${docId}`],
    );
  }

  test('create + getById round-trip', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const created = await repo.create({
      kb_id: kbId, doc_id: docId, page_type: 'fulltext', title: 'Test Page',
      content: 'Hello world', file_path: '/test/page.md', content_hash: 'hash123',
      token_count: 2, metadata: { source: 'test' },
    });
    cleanupIds.pageIds.push(created.id);

    expect(created.id).toBeDefined();
    expect(created.title).toBe('Test Page');
    expect(created.content).toBe('Hello world');
    expect(created.metadata).toEqual({ source: 'test' });

    const fetched = await repo.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('Test Page');
  });

  test('getByDocAndType returns matching page', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const created = await repo.create({ kb_id: kbId, doc_id: docId, page_type: 'structure', title: 'Structure Page' });
    cleanupIds.pageIds.push(created.id);

    const result = await repo.getByDocAndType(docId, 'structure');
    expect(result).toBeDefined();
    expect(result!.id).toBe(created.id);

    const missing = await repo.getByDocAndType(docId, 'fulltext');
    expect(missing).toBeUndefined();
  });

  test('getManyByDocAndType returns multiple pages', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const p1 = await repo.create({ kb_id: kbId, doc_id: docId, page_type: 'fulltext', title: 'Fulltext 1' });
    const p2 = await repo.create({ kb_id: kbId, doc_id: docId, page_type: 'fulltext', title: 'Fulltext 2' });
    cleanupIds.pageIds.push(p1.id, p2.id);

    const results = await repo.getManyByDocAndType(docId, 'fulltext');
    expect(results.length).toBe(2);
    expect(results.map((r) => r.title)).toEqual(expect.arrayContaining(['Fulltext 1', 'Fulltext 2']));
  });

  test('getByKbAndType with and without pageType filter', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const p1 = await repo.create({ kb_id: kbId, doc_id: docId, page_type: 'fulltext', title: 'Fulltext' });
    const p2 = await repo.create({ kb_id: kbId, doc_id: docId, page_type: 'structure', title: 'Structure' });
    cleanupIds.pageIds.push(p1.id, p2.id);

    const filtered = await repo.getByKbAndType(kbId, 'fulltext');
    expect(filtered.length).toBe(1);
    expect(filtered[0].page_type).toBe('fulltext');

    const all = await repo.getByKbAndType(kbId);
    expect(all.length).toBe(2);
  });

  test('updateMetadata persists changes', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const created = await repo.create({
      kb_id: kbId, doc_id: docId, page_type: 'fulltext', title: 'Meta Test', metadata: { version: 1 },
    });
    cleanupIds.pageIds.push(created.id);

    await repo.updateMetadata(created.id, { version: 2, updated: true });
    const fetched = await repo.getById(created.id);
    expect(fetched!.metadata).toEqual({ version: 2, updated: true });
  });

  test('updateContent persists changes', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const created = await repo.create({
      kb_id: kbId, doc_id: docId, page_type: 'fulltext', title: 'Content Test', content: 'old',
    });
    cleanupIds.pageIds.push(created.id);

    await repo.updateContent(created.id, 'new content', 'newhash', 42);
    const fetched = await repo.getById(created.id);
    expect(fetched!.content).toBe('new content');
    expect(fetched!.content_hash).toBe('newhash');
    expect(fetched!.token_count).toBe(42);
  });

  test('deleteById removes page', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const created = await repo.create({ kb_id: kbId, doc_id: docId, page_type: 'fulltext', title: 'Delete Test' });
    await repo.deleteById(created.id);

    const fetched = await repo.getById(created.id);
    expect(fetched).toBeUndefined();
  });
});
