import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ModelManager } from '../src/services/model-manager';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

const TEST_MODELS_DIR = join(__dirname, 'fixtures/test-models');

beforeEach(() => {
  // Clean up test fixtures
  if (existsSync(TEST_MODELS_DIR)) {
    rmSync(TEST_MODELS_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_MODELS_DIR, { recursive: true });
});

describe('ModelManager', () => {
  const manager = new ModelManager(TEST_MODELS_DIR);

  test('getModelPath returns path when model exists locally', async () => {
    // Create a fake local model
    const modelDir = join(TEST_MODELS_DIR, 'bge-m3');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'config.json'), '{}');

    const path = await manager.getModelPath('bge-m3');
    expect(path).toBe(modelDir);
  });

  test('getModelPath throws when model does not exist and download fails', async () => {
    // Mock download to fail
    const manager = new ModelManager(TEST_MODELS_DIR);
    vi.spyOn(manager as any, 'download').mockRejectedValue(new Error('Download failed'));

    await expect(manager.getModelPath('nonexistent-model')).rejects.toThrow('Download failed');
  });

  test('listLocalModels returns names of locally available models', () => {
    // Create two fake models
    for (const name of ['bge-m3', 'whisper-small']) {
      const dir = join(TEST_MODELS_DIR, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), '{}');
    }

    const models = manager.listLocalModels();
    expect(models).toContain('bge-m3');
    expect(models).toContain('whisper-small');
    expect(models).toHaveLength(2);
  });

  test('listLocalModels ignores directories without config.json', () => {
    const dir = join(TEST_MODELS_DIR, 'incomplete-model');
    mkdirSync(dir, { recursive: true });
    // No config.json

    const models = manager.listLocalModels();
    expect(models).not.toContain('incomplete-model');
  });
});
