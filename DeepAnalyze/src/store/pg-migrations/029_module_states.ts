import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 29,
  name: 'module_states',
  sql: `
-- 模块部署状态：单一数据源，决定 start.py / model-supervisor / /api/health 的行为
CREATE TABLE IF NOT EXISTS module_states (
  module_id       TEXT PRIMARY KEY,           -- 'embedding' | 'asr' | 'docling' | 'mineru'
  status          TEXT NOT NULL DEFAULT 'not_installed',
                  -- 'not_installed' | 'installing' | 'installed' | 'running' | 'error'
  mode            TEXT NOT NULL DEFAULT 'disabled',
                  -- 'local' | 'remote' | 'disabled'
  weights_path    TEXT,
  weights_size_mb INTEGER,
  gpu_required    BOOLEAN NOT NULL DEFAULT false,
  process_type    TEXT NOT NULL DEFAULT 'subprocess',
                  -- 'subprocess' | 'docker'
  remote_endpoint TEXT,
  remote_api_key  TEXT,
  remote_protocol TEXT,                        -- 'openai' | 'mineru-rest' | 'docling-rest'
  vlm_backend     TEXT,                        -- 仅 docling 用
                  -- 'none' | 'paddleocr-vl-local' | 'glm-ocr-local' | 'remote-openai-vlm'
  last_error      TEXT,
  installed_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  config_version  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_module_states_status ON module_states (status);
CREATE INDEX IF NOT EXISTS idx_module_states_mode   ON module_states (mode);
`,
};
