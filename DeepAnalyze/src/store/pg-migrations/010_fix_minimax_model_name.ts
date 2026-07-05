// =============================================================================
// DeepAnalyze - PG Migration 010: Fix MiniMax Model Name
// =============================================================================
// Originally intended to strip the "MiniMax-" prefix from stored model names.
// Investigation showed that the MiniMax API REQUIRES the full "MiniMax-" prefix
// in model names (e.g. "MiniMax-M2.7-highspeed"). The actual issue was max_tokens
// being too high (200000), not the model name. This migration is now a no-op.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 10,
  name: 'fix_minimax_model_name',

  sql: `
    -- Migration 010: Originally intended to fix MiniMax model names.
    -- Investigation showed that MiniMax API requires the full "MiniMax-" prefix.
    -- The actual issue was max_tokens being too high, not the model name.
    -- This migration is now a no-op.
    SELECT 1;
  `,
};
