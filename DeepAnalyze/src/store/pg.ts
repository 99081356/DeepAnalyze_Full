// =============================================================================
// DeepAnalyze - PostgreSQL Connection Pool & Migration Framework
// Uses pg.Pool with singleton pattern, migration tracking via _pg_migrations.
// =============================================================================

import pg from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A PG migration definition. */
export interface PGMigration {
  version: number;
  name: string;
  sql: string;
}

// ---------------------------------------------------------------------------
// Connection pool singleton
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let extensionsInitialized = false;

/**
 * Read connection config from environment variables with sensible defaults.
 */
function getPoolConfig(): pg.PoolConfig {
  return {
    host: process.env.PG_HOST ?? 'localhost',
    port: parseInt(process.env.PG_PORT ?? '5432', 10),
    database: process.env.PG_DATABASE ?? 'deepanalyze',
    user: process.env.PG_USER ?? 'deepanalyze',
    password: process.env.PG_PASSWORD ?? 'deepanalyze_dev',
    max: 40,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000, // Fail fast if PG is unreachable (5s)
  };
}

/**
 * Ensure required PostgreSQL extensions are available.
 * Runs only once on first pool creation.
 */
async function ensureExtensions(client: pg.PoolClient): Promise<void> {
  if (extensionsInitialized) return;

  // vector extension for embedding similarity search
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  console.log('[PG] Extension "vector" ensured');

  // zhparser extension for Chinese full-text search.
  // Optional: when unavailable (e.g. prebuilt pgvector images, native Windows
  // PG without zhparser), fall back gracefully — migration 001 creates the
  // 'chinese' text search configuration with the default parser, so FTS still
  // works (with poorer Chinese tokenization) instead of blocking startup.
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS zhparser');
    console.log('[PG] Extension "zhparser" ensured');
  } catch (err) {
    console.warn(
      '[PG] Extension "zhparser" unavailable — Chinese FTS will use the fallback tokenizer. ' +
      (err instanceof Error ? err.message : String(err)),
    );
  }

  extensionsInitialized = true;
}

/**
 * Get or create the singleton pg.Pool instance.
 * On first call, also ensures required extensions are installed.
 */
export async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const config = getPoolConfig();
  pool = new pg.Pool(config);

  // Verify connectivity and install extensions
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log(`[PG] Connected to ${config.host}:${config.port}/${config.database}`);
    await ensureExtensions(client);
  } finally {
    client.release();
  }

  // Log unhandled pool errors so the process does not crash silently
  pool.on('error', (err) => {
    console.error('[PG] Unexpected pool error:', err.message);
  });

  return pool;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Execute a SQL statement with optional parameters.
 * Returns the full pg.QueryResult for maximum flexibility.
 */
export async function query(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult> {
  const p = await getPool();
  return p.query(sql, params);
}

/**
 * Run a callback inside a transaction.
 * Commits on success, rolls back on error, and always releases the client.
 */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Migration framework
// ---------------------------------------------------------------------------

/**
 * Ensure the migration tracking table exists.
 */
async function ensureMigrationTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _pg_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Get the set of already-applied migration versions.
 */
async function getAppliedVersions(pool: pg.Pool): Promise<Set<number>> {
  const { rows } = await pool.query(
    'SELECT version FROM _pg_migrations',
  );
  return new Set(rows.map((r: { version: number }) => r.version));
}

/**
 * Run all pending PG migrations in version order.
 *
 * @param migrations - Array of PGMigration objects, typically imported from
 *   the `pg-migrations/` directory. Sorted by version before execution.
 */
export async function migratePG(migrations: PGMigration[]): Promise<void> {
  const pool = await getPool();

  await ensureMigrationTable(pool);
  const applied = await getAppliedVersions(pool);

  // Sort migrations by version to guarantee order regardless of import order
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const m of sorted) {
    if (applied.has(m.version)) continue;

    console.log(`[PG] Running migration ${m.version}: ${m.name}`);
    await transaction(async (client) => {
      await client.query(m.sql);
      await client.query(
        'INSERT INTO _pg_migrations (version, name) VALUES ($1, $2)',
        [m.version, m.name],
      );
    });
    console.log(`[PG] Migration ${m.version}: ${m.name} applied`);
  }

  console.log('[PG] All migrations complete');
}

// ---------------------------------------------------------------------------
// Graceful shutdown helper
// ---------------------------------------------------------------------------

/**
 * Drain the pool. Call this on process shutdown for a clean exit.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    extensionsInitialized = false;
    console.log('[PG] Connection pool closed');
  }
}
