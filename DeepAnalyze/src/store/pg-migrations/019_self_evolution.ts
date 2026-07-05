import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 19,
  name: 'self_evolution',

  sql: `
    -- Agent memory: universal experience notes (no user profiling)
    CREATE TABLE IF NOT EXISTS agent_memory (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category    TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT DEFAULT 'foreground',
      relevance   INT DEFAULT 5,
      use_count   INT DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory (category);

    -- Skill usage telemetry for Curator lifecycle decisions
    CREATE TABLE IF NOT EXISTS skill_usage (
      skill_id        TEXT PRIMARY KEY REFERENCES agent_skills(id) ON DELETE CASCADE,
      created_by      TEXT DEFAULT 'user',
      use_count       INT DEFAULT 0,
      patch_count     INT DEFAULT 0,
      last_used_at    TIMESTAMPTZ,
      last_patched_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT now(),
      state           TEXT DEFAULT 'active',
      pinned          BOOLEAN DEFAULT false
    );

    -- Skill version history for rollback/rollforward
    CREATE TABLE IF NOT EXISTS skill_versions (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      skill_id       TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
      version        INT NOT NULL,
      prompt         TEXT NOT NULL,
      description    TEXT,
      change_type    TEXT NOT NULL,
      change_source  TEXT NOT NULL,
      change_summary TEXT,
      diff_patch     TEXT,
      created_at     TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_unique ON skill_versions (skill_id, version);
    CREATE INDEX IF NOT EXISTS idx_skill_versions_time ON skill_versions (skill_id, created_at DESC);

    -- Full-text search index on messages for session recall
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;
    CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING GIN (search_vector);
  `,
};
