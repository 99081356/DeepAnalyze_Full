import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 18,
  name: 'document_updated_at',

  sql: `
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at);
  `,
};
