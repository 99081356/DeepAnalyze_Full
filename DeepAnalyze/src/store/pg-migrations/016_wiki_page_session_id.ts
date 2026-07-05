import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 16,
  name: 'wiki_page_session_id',

  sql: `
    ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS session_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_session_id ON wiki_pages(session_id) WHERE page_type = 'report';
  `,
};
