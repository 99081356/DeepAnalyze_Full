import { Hono } from 'hono';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool } from '../../store/pg.ts';
import { PgModuleStatesRepo, MODULE_IDS } from '../../store/repos/module-states.ts';
import type { ModuleId, ModuleState } from '../../store/repos/module-states.ts';
import { installModule, uninstallModule } from '../module-lifecycle.ts';
import { getModelSupervisor } from '../model-supervisor.ts';
import { detectGpu } from '../gpu-detector.ts';
import { getGlmOcrStatus, startGlmOcrContainer, stopGlmOcrContainer } from '../glm-ocr-manager.ts';
import {
  getMinerULocalStatus,
  startMinerULocalContainer,
  stopMinerULocalContainer,
} from '../mineru-local-manager.ts';
import { bumpConfigVersion } from '../../models/router.ts';

function isValidModule(id: string): id is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(id);
}

export function createModulesRoutes(): Hono {
  const router = new Hono();

  const repo = async () => new PgModuleStatesRepo(await getPool());

  // --- GPU detection ---
  router.get('/gpu', async (c) => {
    const info = await detectGpu();
    return c.json(info);
  });

  // --- First-run status (must be before /:moduleId to avoid param capture) ---
  router.get('/first-run-status', async (c) => {
    const bundledDir = resolve(process.cwd(), 'data', '_bundled');
    const hasBundle = existsSync(bundledDir) && readdirSync(bundledDir).length > 0;
    // Check if any module has been configured (indicates first run completed)
    const pool = await getPool();
    const statesRepo = new PgModuleStatesRepo(pool);
    const states = await statesRepo.list();
    const configured = states.some((s) => s.mode !== 'disabled');
    return c.json({
      hasBundle,
      isFirstRun: hasBundle && !configured,
    });
  });

  // --- List all modules ---
  router.get('/', async (c) => {
    const states = await (await repo()).list();
    const supervisorStatus = getModelSupervisor().getStatus();
    // Augment with docker-only auxiliary status (glm-ocr, mineru-local)
    const [glmStatus, mineruStatus] = await Promise.all([
      getGlmOcrStatus().catch(() => null),
      getMinerULocalStatus().catch(() => null),
    ]);
    return c.json({
      modules: states,
      running: supervisorStatus,
      auxiliary: { glmOcr: glmStatus, mineruLocal: mineruStatus },
    });
  });

  // --- Single module ---
  router.get('/:moduleId', async (c) => {
    const moduleId = c.req.param('moduleId');
    if (!isValidModule(moduleId)) return c.json({ error: 'invalid module' }, 400);
    const state = await (await repo()).get(moduleId);
    if (!state) return c.json({ error: 'not configured' }, 404);
    return c.json({ module: state });
  });

  // --- Install ---
  router.post('/:moduleId/install', async (c) => {
    const moduleId = c.req.param('moduleId');
    if (!isValidModule(moduleId)) return c.json({ error: 'invalid module' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const gpuInfo = await detectGpu();
    try {
      const state = await installModule(await repo(), moduleId, gpuInfo, {
        gpuRequired: body.gpuRequired,
        onProgress: (p) => {
          // SSE streaming could be added later; for now we just log
          console.log(`[modules] install ${moduleId}: ${(p.percent * 100).toFixed(0)}%`);
        },
      });
      return c.json({ module: state });
    } catch (err: any) {
      return c.json({ error: err?.message ?? 'install failed' }, 500);
    }
  });

  // --- Uninstall ---
  router.post('/:moduleId/uninstall', async (c) => {
    const moduleId = c.req.param('moduleId');
    if (!isValidModule(moduleId)) return c.json({ error: 'invalid module' }, 400);
    try {
      await uninstallModule(await repo(), moduleId);
      bumpConfigVersion();
      return c.json({ success: true });
    } catch (err: any) {
      return c.json({ error: err?.message ?? 'uninstall failed' }, 500);
    }
  });

  // --- Start service ---
  router.post('/:moduleId/start', async (c) => {
    const moduleId = c.req.param('moduleId');
    if (!isValidModule(moduleId)) return c.json({ error: 'invalid module' }, 400);
    try {
      const status = await getModelSupervisor().startService(await repo(), moduleId);
      // Also bump config so downstream consumers reload
      bumpConfigVersion();
      return c.json({ status });
    } catch (err: any) {
      return c.json({ error: err?.message ?? 'start failed' }, 500);
    }
  });

  // --- Stop service ---
  router.post('/:moduleId/stop', async (c) => {
    const moduleId = c.req.param('moduleId');
    if (!isValidModule(moduleId)) return c.json({ error: 'invalid module' }, 400);
    try {
      const status = await getModelSupervisor().stopService(moduleId);
      // Mark back to installed in DB
      await (await repo()).upsert({ moduleId, status: 'installed', startedAt: null });
      bumpConfigVersion();
      return c.json({ status });
    } catch (err: any) {
      return c.json({ error: err?.message ?? 'stop failed' }, 500);
    }
  });

  // --- Update config (mode/remote/vlm_backend) ---
  router.put('/:moduleId/config', async (c) => {
    const moduleId = c.req.param('moduleId');
    if (!isValidModule(moduleId)) return c.json({ error: 'invalid module' }, 400);

    const body = await c.req.json();
    const allowed: Record<string, boolean> = {
      mode: typeof body.mode === 'string',
      remoteEndpoint: typeof body.remoteEndpoint === 'string',
      remoteApiKey: typeof body.remoteApiKey === 'string',
      remoteProtocol: typeof body.remoteProtocol === 'string',
      vlmBackend: typeof body.vlmBackend === 'string',
      gpuRequired: typeof body.gpuRequired === 'boolean',
    };
    const patch: Partial<ModuleState> & { moduleId: ModuleId } = { moduleId };
    for (const [k, ok] of Object.entries(allowed)) {
      if (ok && body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    }

    try {
      const state = await (await repo()).upsert(patch);
      bumpConfigVersion();
      return c.json({ module: state });
    } catch (err: any) {
      return c.json({ error: err?.message ?? 'config update failed' }, 500);
    }
  });

  // --- Auxiliary: GLM-OCR container direct control (when used standalone) ---
  router.post('/glm-ocr/start', async (c) => {
    const info = await startGlmOcrContainer();
    return c.json({ info });
  });
  router.post('/glm-ocr/stop', async (c) => {
    const info = await stopGlmOcrContainer();
    return c.json({ info });
  });

  return router;
}
