import pg from 'pg';
import type { PluginRepo, Plugin, NewPlugin } from './interfaces';

export class PgPluginRepo implements PluginRepo {
  constructor(private pool: pg.Pool) {}

  async upsert(plugin: NewPlugin): Promise<void> {
    await this.pool.query(
      `INSERT INTO plugins (id, name, version, enabled, config) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, enabled = EXCLUDED.enabled, config = EXCLUDED.config`,
      [plugin.id, plugin.name, plugin.version ?? '0.0.1', plugin.enabled ?? true, plugin.config ? JSON.stringify(plugin.config) : null],
    );
  }

  async get(id: string): Promise<Plugin | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM plugins WHERE id = $1', [id]);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async list(): Promise<Plugin[]> {
    const { rows } = await this.pool.query('SELECT * FROM plugins ORDER BY created_at');
    return rows.map(r => this.mapRow(r));
  }

  async updateEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query('UPDATE plugins SET enabled = $1 WHERE id = $2', [enabled, id]);
  }

  async updateConfig(id: string, config: Record<string, unknown>): Promise<void> {
    await this.pool.query('UPDATE plugins SET config = $1 WHERE id = $2', [JSON.stringify(config), id]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM plugins WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  private mapRow(row: any): Plugin {
    return {
      id: row.id, name: row.name, version: row.version ?? '0.0.1', enabled: row.enabled,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }
}
