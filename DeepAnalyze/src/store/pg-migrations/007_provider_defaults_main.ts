import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 7,
  name: 'provider_defaults_main',

  sql: `
-- Set defaults.main to "minimax-text" if it is currently empty.
-- Migration 003 only set defaults.summarizer but left defaults.main blank,
-- which caused "provider '' not found" errors on fresh installations.
DO $$
DECLARE
  existing_value JSONB;
BEGIN
  SELECT value INTO existing_value FROM settings WHERE key = 'providers';

  IF existing_value IS NOT NULL THEN
    IF existing_value->'defaults'->>'main' = '' OR
       existing_value->'defaults'->>'main' IS NULL THEN
      -- Check if minimax-text provider exists
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(existing_value->'providers') AS elem
        WHERE elem->>'id' = 'minimax-text'
      ) THEN
        UPDATE settings
        SET value = jsonb_set(existing_value, '{defaults,main}', '"minimax-text"'),
            updated_at = now()
        WHERE key = 'providers';
        RAISE NOTICE 'Migration 007: set defaults.main = minimax-text';
      ELSE
        -- Use the first enabled provider as main default
        DECLARE
          first_id TEXT;
        BEGIN
          SELECT elem->>'id' INTO first_id
          FROM jsonb_array_elements(existing_value->'providers') AS elem
          WHERE (elem->>'enabled')::boolean = true
          LIMIT 1;

          IF first_id IS NOT NULL THEN
            UPDATE settings
            SET value = jsonb_set(existing_value, '{defaults,main}', to_jsonb(first_id)),
                updated_at = now()
            WHERE key = 'providers';
            RAISE NOTICE 'Migration 007: set defaults.main = %', first_id;
          END IF;
        END;
      END IF;
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Migration 007 (provider_defaults_main) skipped: %', SQLERRM;
END $$;
`,
};
