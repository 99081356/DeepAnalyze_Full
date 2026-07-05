import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process and execFile
const mockSpawn = vi.fn();
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  execFile: (...args: any[]) => mockExecFile(...args),
}));
vi.mock('node:util', async (orig) => ({
  ...(await orig<any>()),
  promisify: (fn: any) => (...args: any[]) => fn(...args, () => {}),
}));

import { getModelSupervisor, _resetSupervisor } from '../src/server/model-supervisor.ts';

const mockRepo: any = {
  get: vi.fn(),
  upsert: vi.fn(async (s: any) => s),
};

beforeEach(() => {
  _resetSupervisor();
  vi.clearAllMocks();
});

describe('ModelSupervisor', () => {
  it('returns disabled status when module state is missing', async () => {
    mockRepo.get.mockResolvedValue(null);
    const sup = getModelSupervisor();
    const status = await sup.startService(mockRepo, 'embedding');
    expect(status.status).toBe('disabled');
  });

  it('refuses to start not_installed module', async () => {
    mockRepo.get.mockResolvedValue({
      moduleId: 'embedding',
      status: 'not_installed',
      mode: 'local',
      processType: 'subprocess',
    });
    const sup = getModelSupervisor();
    const status = await sup.startService(mockRepo, 'embedding');
    expect(status.status).toBe('error');
    expect(status.error).toMatch(/not installed/i);
  });

  it('starts subprocess service when module is installed', async () => {
    mockRepo.get.mockResolvedValue({
      moduleId: 'embedding',
      status: 'installed',
      mode: 'local',
      processType: 'subprocess',
      weightsPath: 'data/models/bge-m3',
      gpuRequired: true,
    });
    mockSpawn.mockReturnValue({
      pid: 12345,
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    });
    const sup = getModelSupervisor();
    const status = await sup.startService(mockRepo, 'embedding');
    expect(status.status).toBe('running');
    expect(status.pid).toBe(12345);
    expect(mockSpawn).toHaveBeenCalled();
    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'embedding',
      status: 'running',
      startedAt: expect.any(Date),
    }));
  });

  it('starts docker service for mineru module', async () => {
    mockRepo.get.mockResolvedValue({
      moduleId: 'mineru',
      status: 'installed',
      mode: 'local',
      processType: 'docker',
      gpuRequired: true,
    });
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'Container Started', ''));
    const sup = getModelSupervisor();
    const status = await sup.startService(mockRepo, 'mineru');
    expect(status.status).toBe('running');
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', 'up', '-d']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('stopService stops running subprocess', async () => {
    mockSpawn.mockReturnValue({
      pid: 999,
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: vi.fn(),
    });
    const sup = getModelSupervisor();
    // Pretend it's running
    (sup as any).running.set('embedding', { pid: 999, port: 11435, process: { kill: vi.fn() }, repo: mockRepo });
    await sup.stopService('embedding');
    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'embedding',
      status: 'installed', // back to installed (not running)
    }));
  });
});
