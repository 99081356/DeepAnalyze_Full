import pg from 'pg';
import type { SettingsRepo } from './interfaces';

const EMPTY_PROVIDER_DEFAULTS = {
  main: '', summarizer: '', embedding: '', vlm: '', tts: '', image_gen: '', video_gen: '', music_gen: '', audio_transcribe: '', video_understand: '',
};

export class PgSettingsRepo implements SettingsRepo {
  constructor(private pool: pg.Pool) {}

  async get(key: string): Promise<string | null> {
    const { rows } = await this.pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (!rows[0]) return null;
    const raw = rows[0].value;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  }

  async set(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [key, value],
    );
  }

  async delete(key: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM settings WHERE key = $1', [key]);
    return (rowCount ?? 0) > 0;
  }

  async getProviderSettings(): Promise<any> {
    const raw = await this.get('providers');
    if (!raw) return { providers: [], defaults: { ...EMPTY_PROVIDER_DEFAULTS } };
    try {
      const settings = JSON.parse(raw);
      settings.defaults = { ...EMPTY_PROVIDER_DEFAULTS, ...settings.defaults };
      return settings;
    } catch {
      return { providers: [], defaults: { ...EMPTY_PROVIDER_DEFAULTS } };
    }
  }

  async saveProviderSettings(settings: any): Promise<void> {
    await this.set('providers', JSON.stringify(settings));
  }
}
