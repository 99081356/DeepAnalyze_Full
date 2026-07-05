import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 30,
  name: 'config_versions_and_sync',
  sql: `
-- config_versions: 跟踪配置同步状态（与 Hub /config-templates 协同）
-- 单例行：id='singleton' 永远只有一条记录
CREATE TABLE IF NOT EXISTS config_versions (
  id                TEXT PRIMARY KEY,
  last_hub_sync_at  TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO config_versions (id) VALUES ('singleton')
ON CONFLICT (id) DO NOTHING;
`,
};
