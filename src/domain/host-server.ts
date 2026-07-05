// deepanalyze-hub/src/domain/host-server.ts
import type { Pool, QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";

type HostServerFieldName = keyof HostServer | keyof CreateHostServerInput;

/**
 * 允许通过 PATCH 更新的 host_servers 列白名单。
 * 防御 SQL 注入：列名虽然走字符串插值进 SET 子句，但只接受这个 Set 里的编译期常量。
 * 与 routes/host-servers.ts 的 zod schema 配合（路由层先过滤未知 key）。
 */
const UPDATEABLE_HOST_SERVER_FIELDS: ReadonlySet<HostServerFieldName> = Object.freeze(new Set<HostServerFieldName>([
  "hostname",
  "ssh_target_host",
  "ssh_target_port",
  "ssh_user",
  "ssh_key_encrypted",
  "ssh_key_salt",
  "port_range_start",
  "port_range_end",
  "port_block_size",
  "cpu_cores",
  "memory_gb",
  "gpu_count",
  "gpu_vram_mb",
  "gpu_model",
  "labels",
  "notes",
  "status",
]));

export interface HostServer {
  id: string;
  hostname: string;
  ssh_target_host: string;
  ssh_target_port: number;
  ssh_user: string;
  ssh_key_encrypted: string | null;
  ssh_key_salt: string | null;
  port_range_start: number;
  port_range_end: number;
  port_block_size: number;
  cpu_cores: number | null;
  memory_gb: number | null;
  gpu_count: number;
  gpu_vram_mb: number | null;
  gpu_model: string | null;
  status: "active" | "maintenance" | "retired";
  last_probe_at: Date | null;
  last_probe_ok: boolean | null;
  labels: Record<string, unknown>;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateHostServerInput {
  hostname: string;
  ssh_target_host: string;
  ssh_target_port?: number;
  ssh_user?: string;
  ssh_key_encrypted?: string;
  ssh_key_salt?: string;
  port_range_start?: number;
  port_range_end?: number;
  port_block_size?: number;
  cpu_cores?: number;
  memory_gb?: number;
  gpu_count?: number;
  gpu_vram_mb?: number;
  gpu_model?: string | null;
  labels?: Record<string, unknown>;
  notes?: string | null;
}

export class HostServerRepo {
  constructor(private readonly pool: () => Pool) {}

  async create(input: CreateHostServerInput): Promise<HostServer> {
    const id = `hst_${randomUUID()}`;
    const { rows } = await this.pool().query<HostServer>(
      `INSERT INTO host_servers (id, hostname, ssh_target_host, ssh_target_port, ssh_user,
         ssh_key_encrypted, ssh_key_salt, port_range_start, port_range_end, port_block_size,
         cpu_cores, memory_gb, gpu_count, gpu_vram_mb, gpu_model, labels, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [id, input.hostname, input.ssh_target_host, input.ssh_target_port ?? 22,
       input.ssh_user ?? "root", input.ssh_key_encrypted ?? null, input.ssh_key_salt ?? null,
       input.port_range_start ?? 21000, input.port_range_end ?? 21099, input.port_block_size ?? 10,
       input.cpu_cores ?? null, input.memory_gb ?? null, input.gpu_count ?? 0,
       input.gpu_vram_mb ?? null, input.gpu_model ?? null,
       JSON.stringify(input.labels ?? {}), input.notes ?? null],
    );
    return rows[0];
  }

  async getById(id: string): Promise<HostServer | null> {
    const { rows } = await this.pool().query<HostServer>(
      `SELECT * FROM host_servers WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async getByHostname(hostname: string): Promise<HostServer | null> {
    const { rows } = await this.pool().query<HostServer>(
      `SELECT * FROM host_servers WHERE hostname = $1`, [hostname]);
    return rows[0] ?? null;
  }

  async list(filter: { status?: string } = {}): Promise<HostServer[]> {
    if (filter.status) {
      const { rows } = await this.pool().query<HostServer>(
        `SELECT * FROM host_servers WHERE status = $1 ORDER BY created_at DESC`, [filter.status]);
      return rows;
    }
    const { rows } = await this.pool().query<HostServer>(
      `SELECT * FROM host_servers ORDER BY created_at DESC`);
    return rows;
  }

  async update(id: string, patch: Partial<CreateHostServerInput> & { status?: HostServer["status"] }): Promise<HostServer | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      // 列名白名单：拒绝任何不在白名单内的 key（防 SQL 注入）
      if (!UPDATEABLE_HOST_SERVER_FIELDS.has(k as HostServerFieldName)) continue;
      if (k === "labels") {
        fields.push(`labels = $${i++}`); values.push(JSON.stringify(v));
      } else {
        fields.push(`${k} = $${i++}`); values.push(v);
      }
    }
    // 没有可更新字段：返回当前行（PATCH 空对象 = 不变）
    if (fields.length === 0) {
      const { rows } = await this.pool().query<HostServer>(
        `SELECT * FROM host_servers WHERE id = $1`, [id]);
      return rows[0] ?? null;
    }
    fields.push(`updated_at = now()`);
    values.push(id);
    const { rows } = await this.pool().query<HostServer>(
      `UPDATE host_servers SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    return rows[0] ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.pool().query(`DELETE FROM host_servers WHERE id = $1`, [id]);
  }
}
