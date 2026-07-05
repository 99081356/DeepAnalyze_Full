// =============================================================================
// DeepAnalyze - Configure MiniMax Providers
// =============================================================================
// One-time script to seed MiniMax provider entries into the PG settings table.
// Run with: npx tsx scripts/configure-minimax.ts
//
# npx tsx scripts/configure-minimax.ts
// Requires: PG_HOST env var pointing to the DeepAnalyze PG instance.
// =============================================================================

import pg from 'pg';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = parseInt(process.env.PG_PORT || '5432', 10);
const PG_DATABASE = process.env.PG_DATABASE || 'deepanalyze';
const PG_USER = process.env.PG_USER || 'deepanalyze';
const PG_PASSWORD = process.env.PG_PASSWORD || 'deepanalyze_dev';

async function main() {
  if (!MINIMAX_API_KEY) {
    console.error('Error: MINIMAX_API_KEY env var is required');
    console.error('Usage: MINIMAX_API_KEY=sk-xxx npx tsx scripts/configure-minimax.ts');
    process.exit(1);
  }

  const pool = new pg.Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DATABASE,
    user: PG_USER,
    password: PG_PASSWORD,
    max: 5,
  });

  try {
    await pool.query('SELECT 1');
    console.log(`Connected to PG at ${PG_HOST}:${PG_PORT}/${PG_DATABASE}`);

    // Read existing providers
    const { rows } = await pool.query(
      "SELECT value FROM settings WHERE key = 'providers'"
    );

    let settings: { providers: any[]; defaults: any };
    if (rows.length > 0) {
      settings = typeof rows[0].value === 'string'
        ? JSON.parse(rows[0].value)
        : rows[0].value;
      console.log(`Found ${settings.providers.length} existing providers`);
    } else {
      settings = {
        providers: [],
        defaults: { main: 'default', summarizer: '', embedding: '', vlm: '' },
      };
    }

    // Define MiniMax providers
    const minimaxProviders = [
      {
        id: 'minimax-text',
        name: 'MiniMax Text (M3)',
        type: 'openai-compatible',
        endpoint: 'https://api.minimaxi.com/v1',
        apiKey: MINIMAX_API_KEY,
        model: 'MiniMax-M3',
        maxTokens: 131072,
        supportsToolUse: true,
        enabled: true,
        contextWindow: 1000000,
      },
      {
        id: 'minimax-embedding',
        name: 'MiniMax Embedding (embo-01)',
        type: 'openai-compatible',
        endpoint: 'https://api.minimaxi.com/v1',
        apiKey: MINIMAX_API_KEY,
        model: 'embo-01',
        maxTokens: 8192,
        supportsToolUse: false,
        enabled: true,
        dimension: 1024,
      },
      {
        id: 'minimax-tts',
        name: 'MiniMax TTS (speech-01-hd)',
        type: 'openai-compatible',
        endpoint: 'https://api.minimaxi.com/v1',
        apiKey: MINIMAX_API_KEY,
        model: 'speech-01-hd',
        maxTokens: 4096,
        supportsToolUse: false,
        enabled: true,
      },
      {
        id: 'minimax-image',
        name: 'MiniMax Image Gen (image-01)',
        type: 'openai-compatible',
        endpoint: 'https://api.minimaxi.com/v1',
        apiKey: MINIMAX_API_KEY,
        model: 'image-01',
        maxTokens: 4096,
        supportsToolUse: false,
        enabled: true,
      },
      {
        id: 'minimax-video',
        name: 'MiniMax Video Gen (video-01)',
        type: 'openai-compatible',
        endpoint: 'https://api.minimaxi.com/v1',
        apiKey: MINIMAX_API_KEY,
        model: 'video-01',
        maxTokens: 2048,
        supportsToolUse: false,
        enabled: true,
      },
      {
        id: 'minimax-music',
        name: 'MiniMax Music Gen (music-2.6)',
        type: 'openai-compatible',
        endpoint: 'https://api.minimaxi.com/v1',
        apiKey: MINIMAX_API_KEY,
        model: 'music-2.6',
        maxTokens: 4096,
        supportsToolUse: false,
        enabled: true,
      },
    ];

    // Merge: remove old MiniMax entries, add new ones
    settings.providers = settings.providers.filter(
      (p: any) => !p.id.startsWith('minimax-')
    );
    settings.providers.push(...minimaxProviders);

    // Update defaults if empty
    if (!settings.defaults.summarizer) {
      settings.defaults.summarizer = 'minimax-text';
    }
    if (!settings.defaults.embedding) {
      settings.defaults.embedding = 'minimax-embedding';
    }
    settings.defaults.tts = settings.defaults.tts || 'minimax-tts';
    settings.defaults.image_gen = settings.defaults.image_gen || 'minimax-image';
    settings.defaults.video_gen = settings.defaults.video_gen || 'minimax-video';
    settings.defaults.music_gen = settings.defaults.music_gen || 'minimax-music';

    // Save back
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('providers', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(settings)]
    );

    console.log(`\nConfigured ${minimaxProviders.length} MiniMax providers:`);
    for (const p of minimaxProviders) {
      console.log(`  - ${p.id}: ${p.model} (${p.name})`);
    }

    // Also seed enhanced models for non-chat capabilities
    const enhancedModels = [
      {
        id: 'minimax-tts',
        modelType: 'audio_gen',
        name: 'MiniMax TTS (speech-01-hd)',
        description: 'High-quality Chinese/English text-to-speech',
        providerId: 'minimax-tts',
        model: 'speech-01-hd',
        enabled: true,
        capabilities: ['tts', 'chinese', 'english'],
        priority: 1,
        maxTokens: 4096,
      },
      {
        id: 'minimax-image-gen',
        modelType: 'image_gen',
        name: 'MiniMax Image Gen (image-01)',
        description: 'AI image generation',
        providerId: 'minimax-image',
        model: 'image-01',
        enabled: true,
        capabilities: ['image_generation'],
        priority: 1,
        maxTokens: 4096,
      },
      {
        id: 'minimax-video-gen',
        modelType: 'video_gen',
        name: 'MiniMax Video Gen (video-01)',
        description: 'AI video generation (Hailuo)',
        providerId: 'minimax-video',
        model: 'video-01',
        enabled: true,
        capabilities: ['video_generation'],
        priority: 1,
        maxTokens: 2048,
      },
      {
        id: 'minimax-music-gen',
        modelType: 'music_gen',
        name: 'MiniMax Music Gen (music-2.6)',
        description: 'AI music generation',
        providerId: 'minimax-music',
        model: 'music-2.6',
        enabled: true,
        capabilities: ['music_generation'],
        priority: 1,
        maxTokens: 4096,
      },
    ];

    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('enhanced_models', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(enhancedModels)]
    );

    console.log(`\nConfigured ${enhancedModels.length} enhanced model entries:`);
    for (const m of enhancedModels) {
      console.log(`  - ${m.id}: ${m.modelType}`);
    }

    console.log('\nDone! MiniMax providers are configured.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
