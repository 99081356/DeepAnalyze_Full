import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { detectGpu, parseNvidiaSmi, classifyGpuTier } from '../src/server/gpu-detector.ts';

// Mock execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock promisify to preserve execFile callback signature (err, stdout, stderr)
vi.mock('node:util', () => ({
  promisify: (fn: (...args: any[]) => void) =>
    (...args: any[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, stdout?: string, stderr?: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      }),
}));

describe('classifyGpuTier', () => {
  it('returns none for 0 VRAM', () => {
    expect(classifyGpuTier(0, false)).toBe('none');
  });
  it('returns none when no nvidia', () => {
    expect(classifyGpuTier(8000, false)).toBe('none');
  });
  it('returns low for < 8GB nvidia', () => {
    expect(classifyGpuTier(4096, true)).toBe('low');
    expect(classifyGpuTier(8191, true)).toBe('low');
  });
  it('returns high for >= 8GB nvidia', () => {
    expect(classifyGpuTier(8192, true)).toBe('high');
    expect(classifyGpuTier(24576, true)).toBe('high');
  });
});

describe('parseNvidiaSmi', () => {
  it('parses typical nvidia-smi output', () => {
    const sample = 'NVIDIA GeForce RTX 4090, 24576 MiB, 12.4\n';
    const info = parseNvidiaSmi(sample);
    expect(info.deviceName).toBe('NVIDIA GeForce RTX 4090');
    expect(info.vramMB).toBe(24576);
    expect(info.cudaVersion).toBe('12.4');
  });
  it('returns null on malformed output', () => {
    expect(parseNvidiaSmi('garbage')).toBeNull();
  });
});

describe('detectGpu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns none when nvidia-smi not available', async () => {
    (execFile as any).mockImplementation((cmd, args, opts, cb) => {
      cb(new Error('not found'));
    });
    const info = await detectGpu();
    expect(info.tier).toBe('none');
    expect(info.hasNvidia).toBe(false);
  });

  it('detects high-tier GPU', async () => {
    (execFile as any).mockImplementation((cmd, args, opts, cb) => {
      cb(null, 'NVIDIA GeForce RTX 4090, 24576 MiB, 12.4\n', '');
    });
    const info = await detectGpu();
    expect(info.tier).toBe('high');
    expect(info.hasNvidia).toBe(true);
    expect(info.vramMB).toBe(24576);
  });

  it('detects low-tier GPU', async () => {
    (execFile as any).mockImplementation((cmd, args, opts, cb) => {
      cb(null, 'NVIDIA T4, 4096 MiB, 12.0\n', '');
    });
    const info = await detectGpu();
    expect(info.tier).toBe('low');
  });
});
