import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 5,
  name: 'embedding_stale',

  sql: `
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS stale BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_embeddings_stale ON embeddings(stale) WHERE stale = true;
`,
};
