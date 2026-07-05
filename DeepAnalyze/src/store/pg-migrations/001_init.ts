// =============================================================================
// DeepAnalyze - PG Migration 001: Initial Schema
// =============================================================================
// Consolidated PostgreSQL schema with pgvector + zhparser support.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 1,
  name: 'init',

  sql: `
-- =============================================================================
-- Full-Text Search Configuration (zhparser for Chinese)
-- Use DROP + CREATE to ensure idempotency (migration may re-run after failure).
-- zhparser is optional: when the extension is unavailable (prebuilt pgvector
-- images, native Windows PG), fall back to the default parser so FTS still
-- works (with poorer Chinese tokenization) instead of failing the migration.
-- =============================================================================
DROP TEXT SEARCH CONFIGURATION IF EXISTS chinese CASCADE;
DO $$
BEGIN
  CREATE TEXT SEARCH CONFIGURATION chinese (PARSER = zhparser);
  ALTER TEXT SEARCH CONFIGURATION chinese ADD MAPPING FOR n,v,a,i,e,l WITH simple;
EXCEPTION WHEN OTHERS THEN
  -- zhparser unavailable: use the default parser. Its token types differ from
  -- zhparser's (n,v,a,i,e,l), so map default-parser token types instead —
  -- otherwise ADD MAPPING fails with "token type n does not exist".
  CREATE TEXT SEARCH CONFIGURATION chinese (PARSER = default);
  ALTER TEXT SEARCH CONFIGURATION chinese ADD MAPPING FOR asciiword, word, numword, int, uint, float, sfloat WITH simple;
END $$;

-- =============================================================================
-- Knowledge Bases
-- =============================================================================
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'private'
              CHECK (visibility IN ('private', 'team', 'public')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Documents
-- =============================================================================
CREATE TABLE IF NOT EXISTS documents (
  id                   TEXT PRIMARY KEY,
  kb_id                TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  filename             TEXT NOT NULL,
  file_path            TEXT NOT NULL,
  file_hash            TEXT NOT NULL,
  file_size            INTEGER NOT NULL DEFAULT 0,
  file_type            TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded', 'parsing', 'compiling', 'ready', 'error')),
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_step      TEXT,
  processing_progress  DOUBLE PRECISION DEFAULT 0.0,
  processing_error     TEXT
);

-- =============================================================================
-- Wiki Pages
-- =============================================================================
CREATE TABLE IF NOT EXISTS wiki_pages (
  id            TEXT PRIMARY KEY,
  kb_id         TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  doc_id        TEXT REFERENCES documents(id) ON DELETE SET NULL,
  page_type     TEXT NOT NULL
                CHECK (page_type IN ('abstract', 'overview', 'fulltext', 'structure', 'entity', 'concept', 'report')),
  title         TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  content       TEXT DEFAULT '',
  content_hash  TEXT DEFAULT '',
  token_count   INTEGER NOT NULL DEFAULT 0,
  metadata      JSONB,
  fts_vector    tsvector,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Wiki Links
-- =============================================================================
CREATE TABLE IF NOT EXISTS wiki_links (
  id              TEXT PRIMARY KEY,
  source_page_id  TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  target_page_id  TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL
                  CHECK (link_type IN ('forward', 'backward', 'entity_ref', 'concept_ref')),
  entity_name     TEXT,
  context         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Tags
-- =============================================================================
CREATE TABLE IF NOT EXISTS tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id       TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

-- =============================================================================
-- Sessions (Chat)
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  kb_scope    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Messages
-- =============================================================================
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL
              CHECK (role IN ('user', 'assistant', 'tool')),
  content     TEXT DEFAULT '',
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Users
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user'
                CHECK (role IN ('admin', 'user')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Audit Log
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  resource    TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Agent Tasks
-- =============================================================================
CREATE TABLE IF NOT EXISTS agent_tasks (
  id              TEXT PRIMARY KEY,
  parent_task_id  TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_type      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  input           JSONB,
  output          JSONB,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- =============================================================================
-- Plugins
-- =============================================================================
CREATE TABLE IF NOT EXISTS plugins (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  version     TEXT DEFAULT '0.0.1',
  enabled     BOOLEAN DEFAULT true,
  config      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Skills
-- =============================================================================
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  plugin_id   TEXT REFERENCES plugins(id) ON DELETE CASCADE,
  description TEXT,
  config      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Settings (key-value store)
-- =============================================================================
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Embeddings (pgvector)
-- =============================================================================
CREATE TABLE IF NOT EXISTS embeddings (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  model_name  TEXT NOT NULL,
  dimension   INTEGER NOT NULL,
  vector      vector(1024) NOT NULL,
  text_chunk  TEXT,
  chunk_index INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Search Cache
-- =============================================================================
CREATE TABLE IF NOT EXISTS search_cache (
  id          TEXT PRIMARY KEY,
  query_hash  TEXT NOT NULL,
  kb_ids      TEXT NOT NULL,
  results     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ
);

-- =============================================================================
-- Session Memory
-- =============================================================================
CREATE TABLE IF NOT EXISTS session_memory (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE UNIQUE,
  content              TEXT NOT NULL,
  token_count          INTEGER DEFAULT 0,
  last_token_position  INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Cron Jobs
-- =============================================================================
CREATE TABLE IF NOT EXISTS cron_jobs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  schedule          TEXT NOT NULL,
  message           TEXT NOT NULL,
  enabled           BOOLEAN DEFAULT true,
  channel           TEXT,
  chat_id           TEXT,
  deliver_response  BOOLEAN DEFAULT false,
  last_run          TIMESTAMPTZ,
  next_run          TIMESTAMPTZ,
  last_status       TEXT,
  last_error        TEXT,
  run_count         INTEGER DEFAULT 0,
  error_count       INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Anchors (Phase 1 structural element tracking)
-- =============================================================================
CREATE TABLE IF NOT EXISTS anchors (
  id                TEXT PRIMARY KEY,
  doc_id            TEXT REFERENCES documents(id) ON DELETE CASCADE,
  kb_id             TEXT REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  element_type      TEXT NOT NULL,
  element_index     INTEGER NOT NULL,
  section_path      TEXT,
  section_title     TEXT,
  page_number       INTEGER,
  raw_json_path     TEXT,
  structure_page_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  content_preview   TEXT,
  content_hash      TEXT,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Indexes - Documents
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_documents_kb_id     ON documents(kb_id);
CREATE INDEX IF NOT EXISTS idx_documents_status    ON documents(status);

-- =============================================================================
-- Indexes - Wiki Pages
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_wiki_pages_kb_id     ON wiki_pages(kb_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_page_type ON wiki_pages(page_type);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_doc_id    ON wiki_pages(doc_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_kb_type   ON wiki_pages(kb_id, page_type);

-- =============================================================================
-- Indexes - Wiki Links
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_wiki_links_source   ON wiki_links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_links_target   ON wiki_links(target_page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_links_entity   ON wiki_links(entity_name);

-- =============================================================================
-- Indexes - Tags
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

-- =============================================================================
-- Indexes - Messages
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

-- =============================================================================
-- Indexes - Agent Tasks
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status  ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id);

-- =============================================================================
-- Indexes - Embeddings
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_embeddings_page_id ON embeddings(page_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_model   ON embeddings(model_name);

-- Unique index for embedding upserts (one vector per page+model+chunk)
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_page_model_chunk
  ON embeddings(page_id, model_name, chunk_index);

-- HNSW index for vector similarity search (pgvector)
CREATE INDEX IF NOT EXISTS idx_embeddings_vector
  ON embeddings USING hnsw (vector vector_cosine_ops);

-- =============================================================================
-- Indexes - Search Cache
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_search_cache_query ON search_cache(query_hash);

-- =============================================================================
-- Indexes - Session Memory
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_memory_session
  ON session_memory(session_id);

-- =============================================================================
-- Indexes - Cron Jobs
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled  ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run);

-- =============================================================================
-- Indexes - Anchors
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_anchors_doc_id ON anchors(doc_id);
CREATE INDEX IF NOT EXISTS idx_anchors_kb_id  ON anchors(kb_id);

-- =============================================================================
-- Full-Text Search: GIN index on wiki_pages fts_vector
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_wiki_pages_fts
  ON wiki_pages USING gin(fts_vector);

-- =============================================================================
-- Trigger: auto-update wiki_pages fts_vector on INSERT/UPDATE
-- =============================================================================
CREATE OR REPLACE FUNCTION wiki_pages_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('chinese', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('chinese', COALESCE(substring(NEW.content from 1 for 500000), '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wiki_pages_fts ON wiki_pages;
CREATE TRIGGER trg_wiki_pages_fts
  BEFORE INSERT OR UPDATE OF title, content ON wiki_pages
  FOR EACH ROW
  EXECUTE FUNCTION wiki_pages_fts_trigger();

-- =============================================================================
-- Seed: Default provider settings
-- =============================================================================
INSERT INTO settings (key, value)
VALUES ('providers', '{
  "providers": [],
  "defaults": {
    "main": "",
    "summarizer": "",
    "embedding": "",
    "vlm": "",
    "tts": "",
    "image_gen": "",
    "video_gen": "",
    "music_gen": ""
  }
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Seed: Auto-process setting
INSERT INTO settings (key, value)
VALUES ('auto_process', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Seed: Processing concurrency setting
INSERT INTO settings (key, value)
VALUES ('processing_concurrency', '1'::jsonb)
ON CONFLICT (key) DO NOTHING;
`,
};
