// deepanalyze-hub/src/store/migrations/027_host_servers.ts
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS host_servers (
      id                TEXT PRIMARY KEY,
      hostname          TEXT NOT NULL UNIQUE,
      ssh_target_host   TEXT NOT NULL,
      ssh_target_port   INT NOT NULL DEFAULT 22,
      ssh_user          TEXT NOT NULL DEFAULT 'root',
      ssh_key_encrypted TEXT,
      ssh_key_salt      TEXT,
      port_range_start  INT NOT NULL DEFAULT 21000,
      port_range_end    INT NOT NULL DEFAULT 21099,
      port_block_size   INT NOT NULL DEFAULT 10,
      cpu_cores         INT,
      memory_gb         INT,
      gpu_count         INT NOT NULL DEFAULT 0,
      gpu_vram_mb       INT,
      gpu_model         TEXT,
      status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','maintenance','retired')),
      last_probe_at     TIMESTAMPTZ,
      last_probe_ok     BOOLEAN,
      labels            JSONB DEFAULT '{}'::jsonb,
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_host_servers_status ON host_servers(status);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS host_servers;`);
}
