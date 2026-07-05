// =============================================================================
// DeepAnalyze - PG Migration 024: Add line_start to anchors
// =============================================================================
// Adds line_start column to anchors table for Markdown-line-based positioning.
// This enables precise scroll-to-position in the L1 content viewer.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 24,
  name: 'anchor_line_start',

  sql: `
    ALTER TABLE anchors ADD COLUMN IF NOT EXISTS line_start INTEGER;
  `,
};
