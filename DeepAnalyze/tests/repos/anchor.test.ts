// =============================================================================
// DeepAnalyze - PgAnchorRepo Integration Tests
// =============================================================================
// Integration tests that verify anchor CRUD operations against a running
// PostgreSQL instance. Tests require a running PG instance.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { PgAnchorRepo } from '../../src/store/repos/anchor.js';
import type { AnchorDef } from '../../src/store/repos/interfaces.js';

const pgHost = process.env.PG_HOST ?? '';
const pgAvailable = !!pgHost;

function uid(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

function makeAnchor(overrides: Partial<AnchorDef> & { id: string; doc_id: string; kb_id: string }): AnchorDef {
  return {
    element_type: 'heading',
    element_index: 0,
    section_path: '/root',
    section_title: 'Section',
    page_number: 1,
    raw_json_path: '$.sections[0]',
    structure_page_id: null,
    content_preview: 'Test content',
    content_hash: 'abc123',
    metadata: {},
    ...overrides,
  };
}

describe.skipIf(!pgAvailable)('PgAnchorRepo', () => {
  let pool: pg.Pool;
  let repo: PgAnchorRepo;
  const cleanupIds: { kbIds: string[]; docIds: string[]; pageIds: string[]; anchorIds: string[] } = {
    kbIds: [], docIds: [], pageIds: [], anchorIds: [],
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
    repo = new PgAnchorRepo(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  afterEach(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM anchors WHERE id = ANY($1)', [
      cleanupIds.anchorIds.length > 0 ? cleanupIds.anchorIds : ['__none__'],
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
    cleanupIds.anchorIds = [];
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

  test('batchInsert + getByDocId returns anchors ordered by element_index', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    const anchors: AnchorDef[] = [
      makeAnchor({ id: uid(), doc_id: docId, kb_id: kbId, element_index: 2, element_type: 'paragraph' }),
      makeAnchor({ id: uid(), doc_id: docId, kb_id: kbId, element_index: 0, element_type: 'heading' }),
      makeAnchor({ id: uid(), doc_id: docId, kb_id: kbId, element_index: 1, element_type: 'table' }),
    ];
    cleanupIds.anchorIds.push(...anchors.map((a) => a.id));

    await repo.batchInsert(anchors);
    const result = await repo.getByDocId(docId);

    expect(result.length).toBe(3);
    expect(result[0].element_index).toBe(0);
    expect(result[1].element_index).toBe(1);
    expect(result[2].element_index).toBe(2);
  });

  test('getById returns single anchor', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);
    const anchorId = uid();
    cleanupIds.anchorIds.push(anchorId);

    await repo.batchInsert([
      makeAnchor({ id: anchorId, doc_id: docId, kb_id: kbId, element_type: 'heading', content_preview: 'Unique' }),
    ]);

    const result = await repo.getById(anchorId);
    expect(result).toBeDefined();
    expect(result!.id).toBe(anchorId);
    expect(result!.content_preview).toBe('Unique');

    const missing = await repo.getById('non-existent-id');
    expect(missing).toBeUndefined();
  });

  test('getByStructurePageId returns matching anchors', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);

    // Create a real wiki_page so the FK constraint on structure_page_id is satisfied
    const pageId = uid();
    cleanupIds.pageIds.push(pageId);
    await pool.query(
      `INSERT INTO wiki_pages (id, kb_id, doc_id, page_type, title, file_path, content_hash, token_count)
       VALUES ($1, $2, $3, 'structure', $4, $5, '', 0)`,
      [pageId, kbId, docId, `Test Page ${pageId}`, `/test/${pageId}.md`],
    );

    const a1 = uid();
    const a2 = uid();
    cleanupIds.anchorIds.push(a1, a2);

    await repo.batchInsert([
      makeAnchor({ id: a1, doc_id: docId, kb_id: kbId, element_index: 0, structure_page_id: pageId }),
      makeAnchor({ id: a2, doc_id: docId, kb_id: kbId, element_index: 1, structure_page_id: pageId }),
    ]);

    const results = await repo.getByStructurePageId(pageId);
    expect(results.length).toBe(2);
  });

  test('updateStructurePageId updates anchors', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);
    const a1 = uid();
    const a2 = uid();
    cleanupIds.anchorIds.push(a1, a2);

    await repo.batchInsert([
      makeAnchor({ id: a1, doc_id: docId, kb_id: kbId, element_index: 0 }),
      makeAnchor({ id: a2, doc_id: docId, kb_id: kbId, element_index: 1 }),
    ]);

    // Create a real wiki_page so the FK constraint on structure_page_id is satisfied
    const pageId = uid();
    cleanupIds.pageIds.push(pageId);
    await pool.query(
      `INSERT INTO wiki_pages (id, kb_id, doc_id, page_type, title, file_path, content_hash, token_count)
       VALUES ($1, $2, $3, 'structure', $4, $5, '', 0)`,
      [pageId, kbId, docId, `Test Page ${pageId}`, `/test/${pageId}.md`],
    );

    await repo.updateStructurePageId([a1, a2], pageId);
    const results = await repo.getByStructurePageId(pageId);
    expect(results.length).toBe(2);
  });

  test('deleteByDocId removes all anchors for a document', async () => {
    const kbId = uid();
    const docId = uid();
    await insertPrerequisites(kbId, docId);
    const a1 = uid();
    const a2 = uid();
    cleanupIds.anchorIds.push(a1, a2);

    await repo.batchInsert([
      makeAnchor({ id: a1, doc_id: docId, kb_id: kbId, element_index: 0 }),
      makeAnchor({ id: a2, doc_id: docId, kb_id: kbId, element_index: 1 }),
    ]);

    expect((await repo.getByDocId(docId)).length).toBe(2);
    await repo.deleteByDocId(docId);
    expect((await repo.getByDocId(docId)).length).toBe(0);
  });
});
