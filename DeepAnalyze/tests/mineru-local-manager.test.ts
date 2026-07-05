import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

// Working promisify mock pattern (mirrors T5 glm-ocr-manager.test.ts).
// The brief's `async (orig)` template is broken — it returns undefined
// instead of a Promise. This synchronous factory wraps execFile's
// (err, stdout, stderr) callback contract into a resolved/rejected Promise.
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

import {
  getMinerULocalStatus,
  startMinerULocalContainer,
  stopMinerULocalContainer,
} from '../src/server/mineru-local-manager.ts';

beforeEach(() => vi.clearAllMocks());

describe('getMinerULocalStatus', () => {
  it('returns unavailable when docker missing', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(new Error('not found')));
    const info = await getMinerULocalStatus();
    expect(info.status).toBe('unavailable');
  });

  it('returns running with device info', async () => {
    process.env.MINERU_DEVICE = 'cuda';
    mockExecFile
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Docker version 24', ''))
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, JSON.stringify({
        Id: 'xyz',
        State: 'running',
      }), ''));
    const info = await getMinerULocalStatus();
    expect(info.status).toBe('running');
    expect(info.device).toBe('cuda');
    delete process.env.MINERU_DEVICE;
  });
});

describe('startMinerULocalContainer', () => {
  it('passes gpuRequired via MINERU_DEVICE env', async () => {
    mockExecFile
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Docker version 24', ''))
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, '', ''));
    await startMinerULocalContainer(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--profile', 'mineru', 'up', '-d']),
      expect.objectContaining({ env: expect.objectContaining({ MINERU_DEVICE: 'cuda' }) }),
      expect.any(Function),
    );
  });
});

describe('stopMinerULocalContainer', () => {
  it('calls docker compose stop', async () => {
    mockExecFile
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Docker version 24', ''))
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, '', ''));
    const info = await stopMinerULocalContainer();
    expect(info.status).toBe('stopped');
  });
});
