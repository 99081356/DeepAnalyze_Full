// =============================================================================
// DeepAnalyze - PG Migration 002: Anchors Indexes & Structure PageType
// =============================================================================
// Adds additional indexes on the anchors table and updates the wiki_pages
// page_type CHECK constraint to include 'structure'.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 2,
  name: 'anchors_structure',

  sql: `
    -- anchors table already created in 001_init.ts, but add additional indexes
    -- that may not have been included. Use IF NOT EXISTS for safety.
    CREATE INDEX IF NOT EXISTS idx_anchors_doc ON anchors(doc_id);
    CREATE INDEX IF NOT EXISTS idx_anchors_kb ON anchors(kb_id);
    CREATE INDEX IF NOT EXISTS idx_anchors_structure ON anchors(structure_page_id);
    CREATE INDEX IF NOT EXISTS idx_anchors_type ON anchors(element_type);
    CREATE INDEX IF NOT EXISTS idx_anchors_section ON anchors(section_path);

    -- Update wiki_pages page_type CHECK constraint to include 'structure'
    -- PG doesn't support ALTER CONSTRAINT directly, so we drop and re-add
    ALTER TABLE wiki_pages DROP CONSTRAINT IF EXISTS wiki_pages_page_type_check;
    ALTER TABLE wiki_pages ADD CONSTRAINT wiki_pages_page_type_check
      CHECK (page_type IN ('abstract', 'overview', 'fulltext', 'structure', 'entity', 'concept', 'report'));
  `,
};
