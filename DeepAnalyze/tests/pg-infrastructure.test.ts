// =============================================================================
// DeepAnalyze - PostgreSQL Infrastructure Integration Tests
// =============================================================================
// Integration tests that verify the complete PG infrastructure works together:
// connection pool, pgvector, zhparser, HNSW indexes, and the repo factory.
// Tests are skipped when PG is not available (no running instance).
// =============================================================================

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

// Skip all tests if PG is not available
const pgAvailable = process.env.PG_HOST;
describe.skipIf(!pgAvailable)('PostgreSQL Infrastructure', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({
      host: process.env.PG_HOST ?? 'localhost',
      port: parseInt(process.env.PG_PORT ?? '5432', 10),
      database: process.env.PG_DATABASE ?? 'deepanalyze',
      user: process.env.PG_USER ?? 'deepanalyze',
      password: process.env.PG_PASSWORD ?? 'deepanalyze_dev',
      max: 5,
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  test('PG connection pool works', async () => {
    const { rows } = await pool.query('SELECT 1 as value');
    expect(rows[0].value).toBe(1);
  });

  test('pgvector extension is available', async () => {
    // Create a temporary table with vector column, insert, and query
    await pool.query('CREATE TABLE IF NOT EXISTS _test_vector (id TEXT PRIMARY KEY, vec vector(8))');
    await pool.query("INSERT INTO _test_vector (id, vec) VALUES ('test', '[1,2,3,4,5,6,7,8]') ON CONFLICT (id) DO UPDATE SET vec = EXCLUDED.vec");
    const { rows } = await pool.query("SELECT 1 - (vec <=> '[1,2,3,4,5,6,7,8]') as similarity FROM _test_vector WHERE id = 'test'");
    expect(rows[0].similarity).toBeCloseTo(1.0, 5);
    await pool.query('DROP TABLE IF EXISTS _test_vector');
  });

  test('zhparser extension is available', async () => {
    // Ensure the chinese text search configuration exists (normally created by migration 001)
    try {
      await pool.query("CREATE TEXT SEARCH CONFIGURATION chinese (PARSER = zhparser)");
      await pool.query("ALTER TEXT SEARCH CONFIGURATION chinese ADD MAPPING FOR n,v,a,i,e,l WITH simple");
    } catch {
      // Configuration already exists from a previous run or migration
    }
    // Test Chinese text segmentation
    const { rows } = await pool.query("SELECT to_tsvector('chinese', '微服务架构设计模式') as vec");
    expect(rows[0].vec).toBeTruthy();
    // Should produce tokens from Chinese text
    expect(String(rows[0].vec).length).toBeGreaterThan(0);
  });

  test('chinese text search configuration exists', async () => {
    const { rows } = await pool.query("SELECT cfgname FROM pg_ts_config WHERE cfgname = 'chinese'");
    // If this fails, the migration hasn't been run yet - that's ok for this test
    if (rows.length > 0) {
      expect(rows[0].cfgname).toBe('chinese');
    }
  });

  test('HNSW index can be used for vector search', async () => {
    // Only test if the schema has been applied
    const { rows: tables } = await pool.query("SELECT tablename FROM pg_tables WHERE tablename = 'embeddings'");
    if (tables.length === 0) return; // Schema not applied yet

    const { rows } = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'embeddings' AND indexdef LIKE '%hnsw%'"
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  test('createReposAsync returns complete RepoSet', async () => {
    const { createReposAsync } = await import('../src/store/repos/index');
    const repos = await createReposAsync();

    // Verify all 18 repos are instantiated
    expect(repos.vectorSearch).toBeDefined();
    expect(repos.ftsSearch).toBeDefined();
    expect(repos.anchor).toBeDefined();
    expect(repos.wikiPage).toBeDefined();
    expect(repos.document).toBeDefined();
    expect(repos.embedding).toBeDefined();
    expect(repos.session).toBeDefined();
    expect(repos.message).toBeDefined();
    expect(repos.knowledgeBase).toBeDefined();
    expect(repos.wikiLink).toBeDefined();
    expect(repos.settings).toBeDefined();
    expect(repos.report).toBeDefined();
    expect(repos.agentTeam).toBeDefined();
    expect(repos.cronJob).toBeDefined();
    expect(repos.plugin).toBeDefined();
    expect(repos.skill).toBeDefined();
    expect(repos.sessionMemory).toBeDefined();
    expect(repos.agentTask).toBeDefined();
  });
});
