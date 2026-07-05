import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/store/pg.ts';
import { PgModuleStatesRepo, MODULE_IDS } from '../src/store/repos/module-states.ts';

describe('PgModuleStatesRepo', () => {
  let repo: PgModuleStatesRepo;

  beforeAll(async () => {
    const pool = await getPool();
    repo = new PgModuleStatesRepo(pool);
    // Clean slate
    for (const id of MODULE_IDS) await repo.delete(id);
  });

  afterAll(async () => {
    for (const id of MODULE_IDS) await repo.delete(id);
    await closePool();
  });

  it('returns null for missing module', async () => {
    const state = await repo.get('embedding');
    expect(state).toBeNull();
  });

  it('upserts and retrieves embedding module state', async () => {
    await repo.upsert({
      moduleId: 'embedding',
      status: 'running',
      mode: 'local',
      weightsPath: 'data/models/bge-m3',
      weightsSizeMb: 2200,
      gpuRequired: true,
      processType: 'subprocess',
    });
    const state = await repo.get('embedding');
    expect(state).not.toBeNull();
    expect(state!.status).toBe('running');
    expect(state!.mode).toBe('local');
    expect(state!.gpuRequired).toBe(true);
    expect(state!.configVersion).toBe(0);
  });

  it('partial upsert preserves existing fields', async () => {
    await repo.upsert({ moduleId: 'embedding', status: 'error', lastError: 'OOM' });
    const state = await repo.get('embedding');
    expect(state!.status).toBe('error');
    expect(state!.lastError).toBe('OOM');
    expect(state!.mode).toBe('local'); // preserved
    expect(state!.weightsSizeMb).toBe(2200); // preserved
  });

  it('lists all module states', async () => {
    await repo.upsert({ moduleId: 'asr', status: 'installed', mode: 'local' });
    const all = await repo.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((s) => s.moduleId)).toContain('embedding');
    expect(all.map((s) => s.moduleId)).toContain('asr');
  });

  it('deletes module state', async () => {
    await repo.upsert({ moduleId: 'mineru', status: 'not_installed', mode: 'disabled' });
    const ok = await repo.delete('mineru');
    expect(ok).toBe(true);
    const state = await repo.get('mineru');
    expect(state).toBeNull();
  });
});
