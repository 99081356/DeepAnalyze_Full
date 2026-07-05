// =============================================================================
// Task 9: module_states integration with capability-dispatcher
// =============================================================================
// Verifies that transcribeAudio() reads from module_states to determine the
// effective ASR mode (disabled / local / remote) instead of using the old
// hardcoded local-first priority.
// =============================================================================

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, closePool } from '../src/store/pg.ts';
import { PgModuleStatesRepo, MODULE_IDS } from '../src/store/repos/module-states.ts';
import { getRepos, resetRepos } from '../src/store/repos/index.ts';

// Mock global.fetch for the remote ASR test path.
const fetchMock = vi.fn();
global.fetch = fetchMock as any;

import { CapabilityDispatcher } from '../src/models/capability-dispatcher.ts';

describe('module_states integration with capability-dispatcher', () => {
  let repo: PgModuleStatesRepo;
  let dispatcher: CapabilityDispatcher;

  beforeAll(async () => {
    const pool = await getPool();
    repo = new PgModuleStatesRepo(pool);
    dispatcher = new CapabilityDispatcher();
  });

  afterAll(async () => {
    for (const id of MODULE_IDS) {
      try { await repo.delete(id); } catch { /* ignore */ }
    }
    // Clean up any provider settings written by the remote test
    try {
      const repos = await getRepos();
      const settings = await repos.settings.getProviderSettings();
      settings.providers = settings.providers.filter(
        (p: any) => p.id !== 'remote-whisper-test',
      );
      if (settings.defaults?.audio_transcribe === 'remote-whisper-test') {
        settings.defaults.audio_transcribe = '';
      }
      await repos.settings.saveProviderSettings(settings);
    } catch { /* ignore */ }
    await closePool();
  });

  beforeEach(async () => {
    for (const id of MODULE_IDS) {
      try { await repo.delete(id); } catch { /* ignore */ }
    }
    fetchMock.mockReset();
  });

  it('throws when ASR module is disabled (no module_states row)', async () => {
    // No upsert — module is effectively disabled
    await expect(
      dispatcher.transcribeAudio(new ArrayBuffer(8), 'test.wav'),
    ).rejects.toThrow(/disabled/i);
  });

  it('throws when ASR mode=local but status is not running', async () => {
    await repo.upsert({ moduleId: 'asr', status: 'installed', mode: 'local' });
    await expect(
      dispatcher.transcribeAudio(new ArrayBuffer(8), 'test.wav'),
    ).rejects.toThrow(/start it in Settings/i);
  });

  it('calls remote ASR provider when mode=remote', async () => {
    // Configure a remote ASR provider in settings
    const repos = await getRepos();
    const settings = await repos.settings.getProviderSettings();
    const remoteProvider = {
      id: 'remote-whisper-test',
      name: 'Remote Whisper (test)',
      type: 'openai-compatible',
      endpoint: 'https://api.example.com/v1',
      apiKey: 'sk-test-key',
      model: 'whisper-1',
      maxTokens: 0,
      supportsToolUse: false,
      enabled: true,
    };
    const existingIdx = settings.providers.findIndex((p: any) => p.id === 'remote-whisper-test');
    if (existingIdx >= 0) {
      settings.providers[existingIdx] = remoteProvider;
    } else {
      settings.providers.push(remoteProvider);
    }
    settings.defaults.audio_transcribe = 'remote-whisper-test';
    await repos.settings.saveProviderSettings(settings);

    // Reset cached repos so resolveProvider() picks up the new settings
    resetRepos();

    await repo.upsert({
      moduleId: 'asr',
      status: 'not_installed',
      mode: 'remote',
    });

    // Mock fetch to return a successful transcription response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello world', language: 'en', duration: 5.0 }),
      text: async () => '',
    });

    const result = await dispatcher.transcribeAudio(new ArrayBuffer(8), 'test.wav');
    expect(result.text).toBe('hello world');
    expect(result.language).toBe('en');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify the fetch URL includes the audio/transcriptions endpoint
    const callArgs = fetchMock.mock.calls[0];
    expect(String(callArgs[0])).toContain('/audio/transcriptions');
  });
});
