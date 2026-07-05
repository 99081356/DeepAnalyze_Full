import { downloadModel, verifyModel, removeModel } from '../services/model-downloader.ts';
import { PgModuleStatesRepo } from '../store/repos/module-states.ts';
import type { ModuleId, ModuleState } from '../store/repos/module-states.ts';
import type { GpuInfo } from './gpu-detector.ts';

export interface ModuleInstallOptions {
  gpuRequired?: boolean; // override auto-detection
  onProgress?: (p: { percent: number; downloadedMB: number; totalMB: number }) => void;
}

export interface ModuleDefault {
  manifestName: string;       // key in da-assets/manifest.json
  weightsPath: string;        // relative to data/models/
  processType: 'subprocess' | 'docker';
  recommendedGpuTier: 'none' | 'low' | 'high'; // minimum tier for GPU mode
  defaultRemoteProtocol?: 'openai' | 'mineru-rest' | 'docling-rest';
}

export const MODULE_DEFAULTS: Record<ModuleId, ModuleDefault> = {
  embedding: {
    manifestName: 'bge-m3',
    weightsPath: 'data/models/bge-m3',
    processType: 'subprocess',
    recommendedGpuTier: 'low',
    defaultRemoteProtocol: 'openai',
  },
  asr: {
    manifestName: 'whisper-base',
    weightsPath: 'data/models/whisper',
    processType: 'subprocess',
    recommendedGpuTier: 'low',
    defaultRemoteProtocol: 'openai',
  },
  docling: {
    manifestName: 'docling-layout',
    weightsPath: 'data/models/docling',
    processType: 'subprocess',
    recommendedGpuTier: 'none', // docling itself runs on CPU; VLM backend is separate
    defaultRemoteProtocol: 'docling-rest',
  },
  mineru: {
    manifestName: 'mineru',
    weightsPath: 'data/models/mineru',
    processType: 'docker',
    recommendedGpuTier: 'high',
    defaultRemoteProtocol: 'mineru-rest',
  },
};

export async function installModule(
  repo: PgModuleStatesRepo,
  moduleId: ModuleId,
  gpuInfo: GpuInfo,
  options: ModuleInstallOptions = {},
): Promise<ModuleState> {
  const def = MODULE_DEFAULTS[moduleId];
  const gpuRequired = options.gpuRequired ?? (gpuInfo.tier !== 'none' && def.recommendedGpuTier !== 'none');

  // Mark installing
  await repo.upsert({
    moduleId,
    status: 'installing',
    mode: 'local',
    processType: def.processType,
    gpuRequired,
    weightsPath: def.weightsPath,
  });

  try {
    // downloadModel's onProgress receives a single DownloadProgress object
    // { fileName, bytesDownloaded, bytesTotal, percent }. Adapt to our callback shape.
    const result = await downloadModel(def.manifestName, 'hf_mirror', (p) => {
      if (options.onProgress && p.bytesTotal > 0) {
        options.onProgress({
          percent: p.percent / 100, // normalize to 0..1
          downloadedMB: Math.floor(p.bytesDownloaded / 1024 / 1024),
          totalMB: Math.floor(p.bytesTotal / 1024 / 1024),
        });
      }
    });

    if (!result.ok) {
      throw new Error(result.error ?? `download failed for ${def.manifestName}`);
    }

    // Verify checksums
    const verifyResult = await verifyModel(def.manifestName);
    if (!verifyResult.ok) {
      throw new Error(verifyResult.reason ?? `verification failed for ${def.manifestName}`);
    }

    // downloadModel reports total bytes downloaded directly via DownloadResult.bytesDownloaded.
    // Use it for weights size — no need to stat files individually.
    const sizeMB = Math.floor(result.bytesDownloaded / 1024 / 1024);

    return await repo.upsert({
      moduleId,
      status: 'installed',
      mode: 'local',
      weightsPath: def.weightsPath,
      weightsSizeMb: sizeMB,
      gpuRequired,
      processType: def.processType,
      installedAt: new Date(),
      lastError: null,
    });
  } catch (err: any) {
    await repo.upsert({
      moduleId,
      status: 'error',
      lastError: err?.message ?? String(err),
    });
    throw err;
  }
}

export async function uninstallModule(
  repo: PgModuleStatesRepo,
  moduleId: ModuleId,
): Promise<void> {
  const def = MODULE_DEFAULTS[moduleId];
  try {
    await removeModel(def.manifestName);
  } catch { /* weights may not exist */ }
  await repo.upsert({
    moduleId,
    status: 'not_installed',
    mode: 'disabled',
    weightsPath: null,
    weightsSizeMb: null,
    installedAt: null,
    startedAt: null,
    lastError: null,
  });
}
