import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 17,
  name: 'document_folder_path',

  sql: `
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_path TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_documents_kb_folder ON documents(kb_id, folder_path);
  `,
};
