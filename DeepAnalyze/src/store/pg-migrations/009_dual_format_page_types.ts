// =============================================================================
// DeepAnalyze - PG Migration 009: Dual-Format L1 Page Types
// =============================================================================
// Updates the wiki_pages page_type CHECK constraint to include 'structure_md'
// and 'structure_dt' used by the Docling-centric dual-format L1 architecture.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 9,
  name: 'dual_format_page_types',

  sql: `
    -- Update wiki_pages page_type CHECK constraint to include dual-format types
    -- structure_md = Markdown rendering of document structure (L1 layer)
    -- structure_dt = DocTags rendering of document structure (L1 layer)
    ALTER TABLE wiki_pages DROP CONSTRAINT IF EXISTS wiki_pages_page_type_check;
    ALTER TABLE wiki_pages ADD CONSTRAINT wiki_pages_page_type_check
      CHECK (page_type IN ('abstract', 'overview', 'fulltext', 'structure', 'structure_md', 'structure_dt', 'entity', 'concept', 'report'));
  `,
};
