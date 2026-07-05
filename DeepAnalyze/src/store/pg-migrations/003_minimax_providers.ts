// =============================================================================
// DeepAnalyze - PG Migration 003: MiniMax Provider Configuration
// =============================================================================
// Seeds the settings table with MiniMax provider entries. Uses ON CONFLICT
// DO NOTHING and wraps all logic in exception handling for robustness.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 3,
  name: 'minimax_providers',

  sql: `
-- Seed MiniMax providers into settings using safe jsonb operations.
DO $$
DECLARE
  existing_value JSONB;
  new_providers JSONB;
  merged_providers JSONB;
  merged_value JSONB;
  api_key TEXT;
  existing_ids TEXT[];
BEGIN
  -- Try to read API key from env vars (gracefully handle missing settings)
  BEGIN
    api_key := current_setting('minimax.api_key', true);
  EXCEPTION WHEN OTHERS THEN
    api_key := NULL;
  END;

  IF api_key IS NULL OR api_key = '' THEN
    BEGIN
      api_key := current_setting('env.var.MINIMAX_API_KEY', true);
    EXCEPTION WHEN OTHERS THEN
      api_key := '';
    END;
  END IF;

  -- Build MiniMax provider entries using jsonb_build_object for safe escaping
  new_providers := jsonb_build_array(
    jsonb_build_object(
      'id', 'minimax-text',
      'name', 'MiniMax Text (M2.7-highspeed)',
      'type', 'openai-compatible',
      'endpoint', 'https://api.minimaxi.com/v1',
      'apiKey', COALESCE(api_key, ''),
      'model', 'MiniMax-M2.7-highspeed',
      'maxTokens', 131072,
      'supportsToolUse', true,
      'enabled', true,
      'contextWindow', 131072
    ),
    jsonb_build_object(
      'id', 'minimax-embedding',
      'name', 'MiniMax Embedding (embo-01)',
      'type', 'openai-compatible',
      'endpoint', 'https://api.minimaxi.com/v1',
      'apiKey', COALESCE(api_key, ''),
      'model', 'embo-01',
      'maxTokens', 8192,
      'supportsToolUse', false,
      'enabled', true,
      'dimension', 1024
    ),
    jsonb_build_object(
      'id', 'minimax-tts',
      'name', 'MiniMax TTS (speech-01-hd)',
      'type', 'openai-compatible',
      'endpoint', 'https://api.minimaxi.com/v1',
      'apiKey', COALESCE(api_key, ''),
      'model', 'speech-01-hd',
      'maxTokens', 4096,
      'supportsToolUse', false,
      'enabled', true
    ),
    jsonb_build_object(
      'id', 'minimax-image',
      'name', 'MiniMax Image Gen (image-01)',
      'type', 'openai-compatible',
      'endpoint', 'https://api.minimaxi.com/v1',
      'apiKey', COALESCE(api_key, ''),
      'model', 'image-01',
      'maxTokens', 4096,
      'supportsToolUse', false,
      'enabled', true
    ),
    jsonb_build_object(
      'id', 'minimax-video',
      'name', 'MiniMax Video Gen (video-01)',
      'type', 'openai-compatible',
      'endpoint', 'https://api.minimaxi.com/v1',
      'apiKey', COALESCE(api_key, ''),
      'model', 'video-01',
      'maxTokens', 2048,
      'supportsToolUse', false,
      'enabled', true
    ),
    jsonb_build_object(
      'id', 'minimax-music',
      'name', 'MiniMax Music Gen (music-2.6)',
      'type', 'openai-compatible',
      'endpoint', 'https://api.minimaxi.com/v1',
      'apiKey', COALESCE(api_key, ''),
      'model', 'music-2.6',
      'maxTokens', 4096,
      'supportsToolUse', false,
      'enabled', true
    )
  );

  -- Read existing providers setting
  SELECT value INTO existing_value FROM settings WHERE key = 'providers';

  IF existing_value IS NOT NULL THEN
    -- Collect existing provider IDs that are NOT minimax
    SELECT array_agg(elem->>'id') INTO existing_ids
    FROM jsonb_array_elements(existing_value->'providers') AS elem
    WHERE elem->>'id' NOT LIKE 'minimax%';

    -- Keep non-minimax existing providers
    merged_providers := COALESCE(
      (SELECT jsonb_agg(elem)
       FROM jsonb_array_elements(existing_value->'providers') AS elem
       WHERE elem->>'id' NOT LIKE 'minimax%'),
      '[]'::jsonb
    );

    -- Append new minimax providers
    merged_providers := merged_providers || new_providers;

    -- Build merged value
    merged_value := jsonb_build_object(
      'providers', merged_providers,
      'defaults', COALESCE(
        existing_value->'defaults',
        '{"main":"","summarizer":"","embedding":"","vlm":"","tts":"","image_gen":"","video_gen":"","music_gen":""}'::jsonb
      )
    );

    -- Set minimax-text as summarizer fallback if empty
    IF merged_value->'defaults'->>'summarizer' = '' OR
       merged_value->'defaults'->>'summarizer' IS NULL THEN
      merged_value := jsonb_set(merged_value, '{defaults,summarizer}', '"minimax-text"');
    END IF;

    UPDATE settings SET value = merged_value, updated_at = now() WHERE key = 'providers';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Migration 003 (minimax_providers) skipped: %', SQLERRM;
END $$;

-- =============================================================================
-- Seed enhanced model entries for non-chat capabilities
-- =============================================================================
INSERT INTO settings (key, value)
VALUES ('enhanced_models', '[
  {
    "id": "minimax-tts",
    "modelType": "audio_gen",
    "name": "MiniMax TTS (speech-01-hd)",
    "description": "High-quality Chinese/English text-to-speech",
    "providerId": "minimax-tts",
    "model": "speech-01-hd",
    "enabled": true,
    "capabilities": ["tts", "chinese", "english"],
    "priority": 1,
    "maxTokens": 4096
  },
  {
    "id": "minimax-image-gen",
    "modelType": "image_gen",
    "name": "MiniMax Image Gen (image-01)",
    "description": "AI image generation",
    "providerId": "minimax-image",
    "model": "image-01",
    "enabled": true,
    "capabilities": ["image_generation"],
    "priority": 1,
    "maxTokens": 4096
  },
  {
    "id": "minimax-video-gen",
    "modelType": "video_gen",
    "name": "MiniMax Video Gen (video-01)",
    "description": "AI video generation (Hailuo)",
    "providerId": "minimax-video",
    "model": "video-01",
    "enabled": true,
    "capabilities": ["video_generation"],
    "priority": 1,
    "maxTokens": 2048
  },
  {
    "id": "minimax-music-gen",
    "modelType": "music_gen",
    "name": "MiniMax Music Gen (music-2.6)",
    "description": "AI music generation",
    "providerId": "minimax-music",
    "model": "music-2.6",
    "enabled": true,
    "capabilities": ["music_generation"],
    "priority": 1,
    "maxTokens": 4096
  }
]'::jsonb)
ON CONFLICT (key) DO NOTHING;
`,
};
