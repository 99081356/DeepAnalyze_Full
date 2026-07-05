import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 6,
  name: 'document_status_expand',

  sql: `
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('uploaded', 'parsing', 'compiling', 'indexing', 'linking', 'ready', 'error'));
`,
};
