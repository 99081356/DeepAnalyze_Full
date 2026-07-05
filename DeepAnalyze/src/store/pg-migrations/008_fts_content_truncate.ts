// =============================================================================
// DeepAnalyze - PG Migration 008: Truncate content in FTS trigger
// =============================================================================
// Fixes: "string is too long for tsvector (2646852 bytes, max 1048575 bytes)"
// The trigger now truncates content to 500000 chars before to_tsvector(),
// keeping FTS functional for large documents (Excel sheets, etc.).
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 8,
  name: 'fts_content_truncate',

  sql: `
-- Replace the FTS trigger function to truncate content before tsvector generation.
-- This prevents "string is too long for tsvector" errors on large documents.
CREATE OR REPLACE FUNCTION wiki_pages_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('chinese', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('chinese', COALESCE(substring(NEW.content from 1 for 500000), '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`,
};
