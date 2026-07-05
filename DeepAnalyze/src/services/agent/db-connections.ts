/**
 * External Database Connection Manager for DA Agent System.
 *
 * Manages connections to external databases (PostgreSQL, MySQL, SQLite)
 * and provides a unified query interface for the db_connect and db_query tools.
 *
 * Connection pools are managed per-session and cleaned up when the session ends.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DbConnectionConfig {
  host?: string;
  port?: number;
  database: string;
  user?: string;
  password?: string;
  filePath?: string; // SQLite
}

export interface DbConnection {
  id: string;
  name: string;
  type: "postgresql" | "mysql" | "sqlite";
  config: DbConnectionConfig;
  pool: unknown; // pg.Pool | mysql2.Pool | better-sqlite3.Database
  createdAt: Date;
}

export interface QueryResult {
  rowCount: number;
  showingRows: number;
  columns: string[];
  rows: Record<string, unknown>[];
  command?: string;
  mode: string;
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Connection Manager (per-session)
// ---------------------------------------------------------------------------

const connections = new Map<string, DbConnection>();

/**
 * Create a new database connection and cache it.
 */
export async function createConnection(params: {
  type: "postgresql" | "mysql" | "sqlite";
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  filePath?: string;
  name?: string;
}): Promise<{ connectionId: string; type: string; database: string; status: string }> {
  const { type } = params;

  if (type === "postgresql") {
    return createPostgreSQLConnection(params);
  } else if (type === "mysql") {
    return createMySQLConnection(params);
  } else if (type === "sqlite") {
    return createSQLiteConnection(params);
  }

  throw new Error(`Unsupported database type: ${type}`);
}

async function createPostgreSQLConnection(params: {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  name?: string;
}): Promise<{ connectionId: string; type: string; database: string; status: string }> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({
    host: params.host || "localhost",
    port: params.port || 5432,
    database: params.database || "postgres",
    user: params.user || "postgres",
    password: params.password || "",
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Test connection
  const client = await pool.connect();
  client.release();

  const id = randomUUID();
  connections.set(id, {
    id,
    name: params.name || `pg-${params.database || "postgres"}`,
    type: "postgresql",
    config: {
      host: params.host,
      port: params.port,
      database: params.database || "postgres",
      user: params.user,
      password: params.password,
    },
    pool,
    createdAt: new Date(),
  });

  return {
    connectionId: id,
    type: "postgresql",
    database: params.database || "postgres",
    status: "connected",
  };
}

async function createMySQLConnection(params: {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  name?: string;
}): Promise<{ connectionId: string; type: string; database: string; status: string }> {
  let mysql2: typeof import("mysql2/promise");
  try {
    mysql2 = await import("mysql2/promise");
  } catch {
    throw new Error(
      "MySQL driver (mysql2) is not installed. Install it with: npm install mysql2",
    );
  }

  const pool = mysql2.createPool({
    host: params.host || "localhost",
    port: params.port || 3306,
    database: params.database || "mysql",
    user: params.user || "root",
    password: params.password || "",
    connectionLimit: 10,
    waitForConnections: true,
  });

  // Test connection
  const conn = await pool.getConnection();
  conn.release();

  const id = randomUUID();
  connections.set(id, {
    id,
    name: params.name || `mysql-${params.database || "mysql"}`,
    type: "mysql",
    config: {
      host: params.host,
      port: params.port,
      database: params.database || "mysql",
      user: params.user,
      password: params.password,
    },
    pool,
    createdAt: new Date(),
  });

  return {
    connectionId: id,
    type: "mysql",
    database: params.database || "mysql",
    status: "connected",
  };
}

async function createSQLiteConnection(params: {
  filePath?: string;
  database?: string;
  name?: string;
}): Promise<{ connectionId: string; type: string; database: string; status: string }> {
  const filePath = params.filePath || params.database;
  if (!filePath) {
    throw new Error("SQLite requires a filePath or database parameter pointing to the .db file");
  }
  if (!existsSync(filePath)) {
    throw new Error(`SQLite file not found: ${filePath}`);
  }

  let Database: typeof import("better-sqlite3").default;
  try {
    const mod = await import("better-sqlite3");
    Database = mod.default;
  } catch {
    throw new Error(
      "SQLite driver (better-sqlite3) is not installed. Install it with: npm install better-sqlite3",
    );
  }

  const db = new Database(filePath, { readonly: false });

  const id = randomUUID();
  connections.set(id, {
    id,
    name: params.name || `sqlite-${filePath}`,
    type: "sqlite",
    config: { filePath, database: filePath },
    pool: db,
    createdAt: new Date(),
  });

  return {
    connectionId: id,
    type: "sqlite",
    database: filePath,
    status: "connected",
  };
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/**
 * Execute a SQL query on a cached connection.
 */
export async function executeQuery(params: {
  connectionId: string;
  sql: string;
  mode: string;
  maxRows: number;
}): Promise<QueryResult> {
  const { connectionId, sql, mode, maxRows } = params;
  const conn = connections.get(connectionId);
  if (!conn) {
    throw new Error(
      `Connection not found: ${connectionId}. Available connections: ${[...connections.keys()].join(", ") || "none"}`,
    );
  }

  if (conn.type === "postgresql") {
    return executePostgreSQLQuery(conn, sql, mode, maxRows);
  } else if (conn.type === "mysql") {
    return executeMySQLQuery(conn, sql, mode, maxRows);
  } else if (conn.type === "sqlite") {
    return executeSQLiteQuery(conn, sql, mode, maxRows);
  }

  throw new Error(`Unsupported connection type: ${conn.type}`);
}

async function executePostgreSQLQuery(
  conn: DbConnection,
  sql: string,
  mode: string,
  maxRows: number,
): Promise<QueryResult> {
  const pool = conn.pool as import("pg").Pool;

  // Write operations use transaction
  if (mode === "write" && !/^\s*(SELECT|WITH)\s/i.test(sql)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(sql);
      await client.query("COMMIT");
      const rows = result.rows.slice(0, maxRows);
      return {
        rowCount: result.rows.length,
        showingRows: Math.min(result.rows.length, maxRows),
        columns: result.fields?.map((f) => f.name) || [],
        rows,
        command: result.command,
        mode,
        connectionId: conn.id,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const result = await pool.query(sql);
  const rows = result.rows.slice(0, maxRows);
  return {
    rowCount: result.rows.length,
    showingRows: Math.min(result.rows.length, maxRows),
    columns: result.fields?.map((f) => f.name) || [],
    rows,
    mode,
    connectionId: conn.id,
  };
}

async function executeMySQLQuery(
  conn: DbConnection,
  sql: string,
  mode: string,
  maxRows: number,
): Promise<QueryResult> {
  const pool = conn.pool as import("mysql2/promise").Pool;

  // Write operations use transaction
  if (mode === "write" && !/^\s*(SELECT|WITH)\s/i.test(sql)) {
    const conn2 = await pool.getConnection();
    try {
      await conn2.beginTransaction();
      const [result] = await conn2.query(sql);
      await conn2.commit();

      const rows = Array.isArray(result) ? result.slice(0, maxRows) : [];
      const resultObj = result as unknown as Record<string, unknown>;
      const columns =
        !Array.isArray(result) && resultObj.fields
          ? (resultObj.fields as { name: string }[]).map(
              (f) => f.name,
            )
          : [];

      return {
        rowCount: Array.isArray(result) ? result.length : 0,
        showingRows: rows.length,
        columns,
        rows: rows as Record<string, unknown>[],
        mode,
        connectionId: conn.id,
      };
    } catch (err) {
      await conn2.rollback().catch(() => {});
      throw err;
    } finally {
      conn2.release();
    }
  }

  const [result] = await pool.query(sql);
  const rows = Array.isArray(result) ? result.slice(0, maxRows) : [];
  const resultObj = result as unknown as Record<string, unknown>;
  const columns =
    !Array.isArray(result) && resultObj.fields
      ? (resultObj.fields as { name: string }[]).map(
          (f) => f.name,
        )
      : [];

  return {
    rowCount: Array.isArray(result) ? result.length : 0,
    showingRows: rows.length,
    columns,
    rows: rows as Record<string, unknown>[],
    mode,
    connectionId: conn.id,
  };
}

function executeSQLiteQuery(
  conn: DbConnection,
  sql: string,
  mode: string,
  maxRows: number,
): QueryResult {
  const db = conn.pool as import("better-sqlite3").Database;

  // SQLite sync API — determine if it's a read or write
  const isRead = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\s/i.test(sql);

  if (isRead || mode === "read") {
    const stmt = db.prepare(sql);
    const rows = stmt.all().slice(0, maxRows) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return {
      rowCount: rows.length,
      showingRows: Math.min(rows.length, maxRows),
      columns,
      rows,
      mode,
      connectionId: conn.id,
    };
  }

  // Write operations — wrap in transaction
  const runResult = db.transaction(() => {
    const stmt = db.prepare(sql);
    const info = stmt.run() as { changes: number };
    return info;
  })();
  const info = runResult;

  return {
    rowCount: info.changes,
    showingRows: info.changes,
    columns: [],
    rows: [],
    command: "write",
    mode,
    connectionId: conn.id,
  };
}

// ---------------------------------------------------------------------------
// Connection cleanup
// ---------------------------------------------------------------------------

/**
 * Close a specific connection.
 */
export async function closeConnection(
  connectionId: string,
): Promise<void> {
  const conn = connections.get(connectionId);
  if (!conn) return;

  try {
    if (conn.type === "postgresql") {
      const pool = conn.pool as import("pg").Pool;
      await pool.end();
    } else if (conn.type === "mysql") {
      const pool = conn.pool as import("mysql2/promise").Pool;
      await pool.end();
    } else if (conn.type === "sqlite") {
      const db = conn.pool as import("better-sqlite3").Database;
      db.close();
    }
  } catch {
    // Ignore cleanup errors
  }

  connections.delete(connectionId);
}

/**
 * Close all connections (called on session end).
 */
export async function closeAllConnections(): Promise<void> {
  const ids = [...connections.keys()];
  await Promise.all(ids.map((id) => closeConnection(id)));
}

/**
 * List all active connections.
 */
export function listConnections(): Array<{
  id: string;
  name: string;
  type: string;
  database: string;
  createdAt: string;
}> {
  return [...connections.values()].map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    database: c.config.database || c.config.filePath || "",
    createdAt: c.createdAt.toISOString(),
  }));
}

/**
 * Get a connection by ID.
 */
export function getConnection(
  connectionId: string,
): DbConnection | undefined {
  return connections.get(connectionId);
}
