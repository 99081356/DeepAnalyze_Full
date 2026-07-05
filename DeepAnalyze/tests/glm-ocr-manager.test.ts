import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

// Mirror the T2 (gpu-detector) mock pattern: promisify wraps execFile's
// callback contract (err, stdout, stderr) into a Promise so the manager's
// `await execFileAsync(...)` works under test.
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

import { getGlmOcrStatus, startGlmOcrContainer, stopGlmOcrContainer } from '../src/server/glm-ocr-manager.ts';

beforeEach(() => vi.clearAllMocks());

describe('getGlmOcrStatus', () => {
  it('returns unavailable when docker missing', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(new Error('not found')));
    const info = await getGlmOcrStatus();
    expect(info.status).toBe('unavailable');
  });

  it('returns running when container State=running', async () => {
    mockExecFile
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Docker version 24', ''))  // docker --version
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, JSON.stringify({
        Id: 'abc123',
        State: 'running',
      }), ''));
    const info = await getGlmOcrStatus();
    expect(info.status).toBe('running');
    expect(info.containerId).toBe('abc123');
  });

  it('returns stopped when container missing', async () => {
    mockExecFile
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Docker version 24', ''))
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, '', ''));
    const info = await getGlmOcrStatus();
    expect(info.status).toBe('stopped');
  });
});

describe('startGlmOcrContainer', () => {
  it('calls docker compose up with profile', async () => {
    mockExecFile
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Docker version 24', ''))
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Container Started', ''));
    const info = await startGlmOcrContainer();
    expect(info.status).toBe('running');
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', '--profile', 'glm-ocr', 'up', '-d', 'glm-ocr']),
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe('stopGlmOcrContainer', () => {
  it('calls docker compose stop', async () => {
    mockExecFile
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, 'Docker version 24', ''))
      .mockImplementationOnce((cmd, args, opts, cb) => cb(null, '', ''));
    const info = await stopGlmOcrContainer();
    expect(info.status).toBe('stopped');
  });
});
