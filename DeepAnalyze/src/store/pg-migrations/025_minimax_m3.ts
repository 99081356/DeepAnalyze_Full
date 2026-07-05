// =============================================================================
// DeepAnalyze - PG Migration 025: Update MiniMax provider to M3
// =============================================================================
// Updates all MiniMax text providers in the settings table:
// - Changes model from MiniMax-M2.7* to MiniMax-M3
// - Updates contextWindow to 1,000,000
// - Adds supportsVision: true (M3 supports native multimodal)
// Also updates default role assignments to point to minimax-text (M3).
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 25,
  name: 'minimax_m3',

  sql: `
DO $$
DECLARE
  existing_value JSONB;
  provider_elem JSONB;
  new_providers JSONB := '[]'::jsonb;
  i INTEGER;
  arr_len INTEGER;
  changed BOOLEAN := false;
  has_minimax_text BOOLEAN := false;
  main_default TEXT;
  summ_default TEXT;
BEGIN
  SELECT value INTO existing_value FROM settings WHERE key = 'providers';

  IF existing_value IS NOT NULL AND existing_value->'providers' IS NOT NULL THEN
    arr_len := jsonb_array_length(existing_value->'providers');

    -- Check if minimax-text provider exists
    FOR i IN 0..arr_len - 1 LOOP
      IF existing_value->'providers'->i->>'id' = 'minimax-text' THEN
        has_minimax_text := true;
      END IF;
    END LOOP;

    FOR i IN 0..arr_len - 1 LOOP
      provider_elem := existing_value->'providers'->i;

      -- Update minimax-text provider to M3
      IF provider_elem->>'id' = 'minimax-text' THEN
        IF provider_elem->>'model' IN ('MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3') THEN
          provider_elem := jsonb_set(provider_elem, '{model}', '"MiniMax-M3"');
          provider_elem := jsonb_set(provider_elem, '{contextWindow}', '1000000');
          provider_elem := jsonb_set(provider_elem, '{supportsVision}', 'true');
          provider_elem := jsonb_set(provider_elem, '{name}', '"MiniMax Text (M3)"');
          changed := true;
          RAISE NOTICE 'Migration 025: updated minimax-text to MiniMax-M3';
        END IF;
      END IF;

      -- Also update any other MiniMax text provider (e.g. minimax-m2-7-highspeed)
      IF provider_elem->>'id' != 'minimax-text'
         AND provider_elem->>'model' IN ('MiniMax-M2.7', 'MiniMax-M2.7-highspeed') THEN
        provider_elem := jsonb_set(provider_elem, '{model}', '"MiniMax-M3"');
        provider_elem := jsonb_set(provider_elem, '{contextWindow}', '1000000');
        provider_elem := jsonb_set(provider_elem, '{supportsVision}', 'true');
        changed := true;
        RAISE NOTICE 'Migration 025: updated provider % to MiniMax-M3', provider_elem->>'id';
      END IF;

      new_providers := new_providers || jsonb_build_array(provider_elem);
    END LOOP;

    IF changed THEN
      -- Update providers array
      existing_value := jsonb_set(existing_value, '{providers}', new_providers);

      -- Update defaults to use minimax-text if available and current default is a MiniMax provider
      main_default := existing_value->'defaults'->>'main';
      summ_default := existing_value->'defaults'->>'summarizer';

      IF has_minimax_text THEN
        -- Point main/summarizer to minimax-text (the canonical M3 provider)
        IF main_default IS NOT NULL AND main_default LIKE 'minimax%' AND main_default != 'minimax-text' THEN
          existing_value := jsonb_set(existing_value, '{defaults,main}', '"minimax-text"');
          RAISE NOTICE 'Migration 025: updated defaults.main to minimax-text';
        END IF;
        IF summ_default IS NOT NULL AND summ_default LIKE 'minimax%' AND summ_default != 'minimax-text' THEN
          existing_value := jsonb_set(existing_value, '{defaults,summarizer}', '"minimax-text"');
          RAISE NOTICE 'Migration 025: updated defaults.summarizer to minimax-text';
        END IF;
      END IF;

      UPDATE settings
      SET value = existing_value, updated_at = now()
      WHERE key = 'providers';
    END IF;
  END IF;

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Migration 025 (minimax_m3) skipped: %', SQLERRM;
END $$;
`,
};
