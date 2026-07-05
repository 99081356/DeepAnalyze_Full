import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MODULE_DEFAULTS, installModule, uninstallModule } from '../src/server/module-lifecycle.ts';

vi.mock('../src/services/model-downloader.ts', () => ({
  downloadModel: vi.fn(),
  verifyModel: vi.fn(),
  removeModel: vi.fn(),
}));

import { downloadModel, verifyModel, removeModel } from '../src/services/model-downloader.ts';

const mockRepo: any = {
  upsert: vi.fn(async (state: any) => ({ ...state, configVersion: 0 })),
  delete: vi.fn(async () => true),
};

const gpuHigh = { tier: 'high' as const, hasNvidia: true, vramMB: 24576, deviceName: 'RTX 4090', cudaVersion: '12.4' };
const gpuNone = { tier: 'none' as const, hasNvidia: false, vramMB: 0 };

describe('MODULE_DEFAULTS', () => {
  it('has entries for all 4 modules', () => {
    expect(Object.keys(MODULE_DEFAULTS).sort()).toEqual(['asr', 'docling', 'embedding', 'mineru']);
  });

  it('mineru uses docker process type', () => {
    expect(MODULE_DEFAULTS.mineru.processType).toBe('docker');
  });
});

describe('installModule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets status=installing then installed on success', async () => {
    // downloadModel returns DownloadResult, not file path array.
    // downloadModel reports bytesDownloaded directly via DownloadResult.
    (downloadModel as any).mockResolvedValue({
      ok: true,
      modelName: 'bge-m3',
      bytesDownloaded: 2_200_000_000,
      duration: 1000,
    });
    (verifyModel as any).mockResolvedValue({ ok: true });

    const progressCalls: number[] = [];
    await installModule(mockRepo, 'embedding', gpuHigh, {
      onProgress: (p) => progressCalls.push(p.percent),
    });

    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'embedding',
      status: 'installing',
    }));
    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'embedding',
      status: 'installed',
      weightsSizeMb: 2098, // floor(2_200_000_000 / 1024 / 1024)
    }));
    expect(downloadModel).toHaveBeenCalledWith('bge-m3', 'hf_mirror', expect.any(Function));
  });

  it('sets status=error on download failure', async () => {
    (downloadModel as any).mockResolvedValue({
      ok: false,
      modelName: 'whisper-base',
      bytesDownloaded: 0,
      duration: 0,
      error: 'network down',
    });

    await expect(installModule(mockRepo, 'asr', gpuNone)).rejects.toThrow('network down');

    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'asr',
      status: 'error',
      lastError: 'network down',
    }));
  });

  it('respects gpuRequired override', async () => {
    (downloadModel as any).mockResolvedValue({
      ok: true,
      modelName: 'bge-m3',
      bytesDownloaded: 100,
      duration: 10,
    });
    (verifyModel as any).mockResolvedValue({ ok: true });

    await installModule(mockRepo, 'embedding', gpuNone, { gpuRequired: true });

    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'embedding',
      gpuRequired: true,
    }));
  });
});

describe('uninstallModule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes weights and resets state', async () => {
    (removeModel as any).mockResolvedValue(undefined);

    await uninstallModule(mockRepo, 'mineru');

    expect(removeModel).toHaveBeenCalledWith('mineru');
    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'mineru',
      status: 'not_installed',
      mode: 'disabled',
      weightsPath: null,
    }));
  });
});
