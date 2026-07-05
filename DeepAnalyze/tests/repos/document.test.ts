// =============================================================================
// DeepAnalyze - PgDocumentRepo Integration Tests
// =============================================================================
// Integration tests that verify document CRUD operations against a running
// PostgreSQL instance. Tests require a running PG instance.
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { PgDocumentRepo } from '../../src/store/repos/document.js';

const pgHost = process.env.PG_HOST ?? '';
const pgAvailable = !!pgHost;

function uid(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!pgAvailable)('PgDocumentRepo', () => {
  let pool: pg.Pool;
  let repo: PgDocumentRepo;
  const cleanupIds: { kbIds: string[]; docIds: string[] } = { kbIds: [], docIds: [] };

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
    repo = new PgDocumentRepo(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  afterEach(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM documents WHERE id = ANY($1)', [
      cleanupIds.docIds.length > 0 ? cleanupIds.docIds : ['__none__'],
    ]);
    await pool.query('DELETE FROM knowledge_bases WHERE id = ANY($1)', [
      cleanupIds.kbIds.length > 0 ? cleanupIds.kbIds : ['__none__'],
    ]);
    cleanupIds.kbIds = [];
    cleanupIds.docIds = [];
  });

  async function insertKb(kbId: string) {
    cleanupIds.kbIds.push(kbId);
    await pool.query(
      `INSERT INTO knowledge_bases (id, name, owner_id, visibility) VALUES ($1, $2, 'test-owner', 'private')`,
      [kbId, `Test KB ${kbId}`],
    );
  }

  test('create + getById round-trip', async () => {
    const kbId = uid();
    await insertKb(kbId);

    const created = await repo.create({
      kb_id: kbId, filename: 'report.pdf', file_path: '/uploads/report.pdf',
      file_hash: 'sha256abc', file_size: 1024, file_type: 'pdf', status: 'uploaded',
      metadata: { pages: 10 },
    });
    cleanupIds.docIds.push(created.id);

    expect(created.id).toBeDefined();
    expect(created.filename).toBe('report.pdf');
    expect(created.status).toBe('uploaded');
    expect(created.metadata).toEqual({ pages: 10 });

    const fetched = await repo.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.file_hash).toBe('sha256abc');
  });

  test('getByKbId returns documents for a KB', async () => {
    const kbId = uid();
    await insertKb(kbId);

    const d1 = await repo.create({
      kb_id: kbId, filename: 'doc1.pdf', file_path: '/uploads/doc1.pdf',
      file_hash: 'h1', file_size: 100, file_type: 'pdf', status: 'uploaded', metadata: {},
    });
    const d2 = await repo.create({
      kb_id: kbId, filename: 'doc2.pdf', file_path: '/uploads/doc2.pdf',
      file_hash: 'h2', file_size: 200, file_type: 'pdf', status: 'uploaded', metadata: {},
    });
    cleanupIds.docIds.push(d1.id, d2.id);

    const results = await repo.getByKbId(kbId);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.filename)).toEqual(expect.arrayContaining(['doc1.pdf', 'doc2.pdf']));
  });

  test('updateStatus changes status', async () => {
    const kbId = uid();
    await insertKb(kbId);

    const created = await repo.create({
      kb_id: kbId, filename: 'status.pdf', file_path: '/uploads/status.pdf',
      file_hash: 'hs', file_size: 50, file_type: 'pdf', status: 'uploaded', metadata: {},
    });
    cleanupIds.docIds.push(created.id);

    await repo.updateStatus(created.id, 'parsing');
    const fetched = await repo.getById(created.id);
    expect(fetched!.status).toBe('parsing');
  });

  test('updateProcessing updates step/progress/error', async () => {
    const kbId = uid();
    await insertKb(kbId);

    const created = await repo.create({
      kb_id: kbId, filename: 'proc.pdf', file_path: '/uploads/proc.pdf',
      file_hash: 'hp', file_size: 50, file_type: 'pdf', status: 'parsing', metadata: {},
    });
    cleanupIds.docIds.push(created.id);

    await repo.updateProcessing(created.id, 'extract_text', 50, null);
    let fetched = await repo.getById(created.id);
    expect(fetched!.processing_step).toBe('extract_text');
    expect(fetched!.processing_progress).toBe(50);
    expect(fetched!.processing_error).toBeNull();

    await repo.updateProcessing(created.id, 'extract_text', 75, 'partial failure');
    fetched = await repo.getById(created.id);
    expect(fetched!.processing_progress).toBe(75);
    expect(fetched!.processing_error).toBe('partial failure');
  });

  test('deleteById removes document', async () => {
    const kbId = uid();
    await insertKb(kbId);

    const created = await repo.create({
      kb_id: kbId, filename: 'del.pdf', file_path: '/uploads/del.pdf',
      file_hash: 'hd', file_size: 50, file_type: 'pdf', status: 'uploaded', metadata: {},
    });

    await repo.deleteById(created.id);
    const fetched = await repo.getById(created.id);
    expect(fetched).toBeUndefined();
  });
});
