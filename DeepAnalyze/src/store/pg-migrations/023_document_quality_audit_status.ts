import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 23,
  name: 'document_quality_audit_status',

  sql: `
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('uploaded', 'parsing', 'compiling', 'indexing', 'linking', 'quality_audit', 'ready', 'error'));
`,
};
