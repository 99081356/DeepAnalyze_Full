import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getPool, closePool } from '../src/store/pg.ts';
import { PgModuleStatesRepo, MODULE_IDS } from '../src/store/repos/module-states.ts';
import { createModulesRoutes } from '../src/server/routes/modules.ts';

// Mock GPU detection
vi.mock('../src/server/gpu-detector.ts', () => ({
  detectGpu: vi.fn(async () => ({
    tier: 'high', hasNvidia: true, vramMB: 24576, deviceName: 'RTX 4090', cudaVersion: '12.4',
  })),
}));

// Mock install (don't actually download)
vi.mock('../src/server/module-lifecycle.ts', async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    installModule: vi.fn(async (repo, moduleId, gpuInfo) => {
      return repo.upsert({
        moduleId,
        status: 'installed',
        mode: 'local',
        weightsPath: '/tmp/fake',
        weightsSizeMb: 100,
        gpuRequired: gpuInfo.tier !== 'none',
        processType: actual.MODULE_DEFAULTS[moduleId].processType,
        installedAt: new Date(),
      });
    }),
    uninstallModule: vi.fn(async (repo, moduleId) => {
      return repo.upsert({ moduleId, status: 'not_installed', mode: 'disabled', weightsPath: null });
    }),
  };
});

// Mock supervisor
vi.mock('../src/server/model-supervisor.ts', () => ({
  getModelSupervisor: () => ({
    startService: vi.fn(async () => ({ status: 'running', pid: 12345, port: 11435 })),
    stopService: vi.fn(async () => ({ status: 'stopped' })),
    getStatus: () => ({}),
  }),
}));

// Mock docker managers
vi.mock('../src/server/glm-ocr-manager.ts', () => ({
  getGlmOcrStatus: vi.fn(async () => ({ status: 'stopped', port: 8601, healthUrl: '' })),
  startGlmOcrContainer: vi.fn(),
  stopGlmOcrContainer: vi.fn(),
}));
vi.mock('../src/server/mineru-local-manager.ts', () => ({
  getMinerULocalStatus: vi.fn(async () => ({ status: 'stopped', port: 8001, healthUrl: '' })),
  startMinerULocalContainer: vi.fn(),
  stopMinerULocalContainer: vi.fn(),
}));

describe('createModulesRoutes', () => {
  let app: Hono;
  let repo: PgModuleStatesRepo;

  beforeAll(async () => {
    const pool = await getPool();
    repo = new PgModuleStatesRepo(pool);
    app = new Hono();
    app.route('/api/modules', createModulesRoutes());
  });

  afterAll(async () => {
    for (const id of MODULE_IDS) await repo.delete(id);
    await closePool();
  });

  beforeEach(async () => {
    for (const id of MODULE_IDS) await repo.delete(id);
  });

  it('GET / returns empty list initially', async () => {
    const r = await app.request('/api/modules');
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.modules).toEqual([]);
  });

  it('GET /gpu returns detected GPU', async () => {
    const r = await app.request('/api/modules/gpu');
    const json: any = await r.json();
    expect(json.tier).toBe('high');
    expect(json.vramMB).toBe(24576);
  });

  it('POST /:moduleId/install creates state', async () => {
    const r = await app.request('/api/modules/embedding/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.module.status).toBe('installed');
    expect(json.module.moduleId).toBe('embedding');
  });

  it('PUT /:moduleId/config updates mode', async () => {
    await repo.upsert({ moduleId: 'asr', status: 'installed', mode: 'local' });
    const r = await app.request('/api/modules/asr/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'remote', remoteEndpoint: 'https://api.example.com' }),
    });
    expect(r.status).toBe(200);
    const state = await repo.get('asr');
    expect(state!.mode).toBe('remote');
    expect(state!.remoteEndpoint).toBe('https://api.example.com');
  });

  it('POST /:moduleId/start returns running status', async () => {
    await repo.upsert({ moduleId: 'embedding', status: 'installed', mode: 'local' });
    const r = await app.request('/api/modules/embedding/start', { method: 'POST' });
    const json: any = await r.json();
    expect(json.status.status).toBe('running');
  });

  it('rejects invalid moduleId', async () => {
    const r = await app.request('/api/modules/invalid/install', { method: 'POST' });
    expect(r.status).toBe(400);
  });
});
