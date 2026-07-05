// =============================================================================
// DeepAnalyze - Module Supervisor
// Manages lifecycle of local module processes (subprocess + Docker).
// Reads/writes module_states table as single source of truth.
// =============================================================================

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgModuleStatesRepo } from '../store/repos/module-states.ts';
import type { ModuleId, ModuleState } from '../store/repos/module-states.ts';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export type ServiceStatus =
  | { status: 'running'; pid?: number; port?: number }
  | { status: 'stopped' }
  | { status: 'error'; error: string }
  | { status: 'disabled'; reason?: string };

interface RunningService {
  pid?: number;
  port: number;
  process?: any; // ChildProcess
  startedAt: Date;
  repo?: PgModuleStatesRepo;
}

// Module-specific launch configuration
interface LaunchSpec {
  scriptPath?: string;       // for subprocess
  portEnv?: string;          // env var name for port
  defaultPort: number;
  dockerService?: string;    // docker compose service name
  dockerProfile?: string;    // compose profile
  healthUrl: (port: number) => string;
  args?: (weightsPath: string, gpuRequired: boolean) => string[];
}

const LAUNCH_SPECS: Record<ModuleId, LaunchSpec> = {
  embedding: {
    scriptPath: path.join(PROJECT_ROOT, 'embedding_server.py'),
    portEnv: 'EMBEDDING_PORT',
    defaultPort: 11435,
    healthUrl: (p) => `http://127.0.0.1:${p}/health`,
    args: (weightsPath) => ['--host', '127.0.0.1', '--port', '', '--model-path', weightsPath],
  },
  asr: {
    scriptPath: path.join(PROJECT_ROOT, 'whisper-service', 'main.py'),
    portEnv: 'WHISPER_HTTP_PORT',
    defaultPort: 9877,
    healthUrl: (p) => `http://127.0.0.1:${p}/health`,
    args: () => ['--http', '--host', '127.0.0.1', '--port', ''],
  },
  docling: {
    scriptPath: path.join(PROJECT_ROOT, 'docling-service', 'main.py'),
    portEnv: 'DOCLING_PORT',
    defaultPort: 8700,
    healthUrl: (p) => `http://127.0.0.1:${p}/health`,
    args: (weightsPath) => ['--weights', weightsPath],
  },
  mineru: {
    dockerService: 'mineru',
    dockerProfile: 'mineru',
    defaultPort: 8001,
    healthUrl: (p) => `http://127.0.0.1:${p}/health`,
  },
};

class ModelSupervisor {
  private running = new Map<ModuleId, RunningService>();

  async startService(repo: PgModuleStatesRepo, moduleId: ModuleId): Promise<ServiceStatus> {
    const state = await repo.get(moduleId);
    if (!state) return { status: 'disabled', reason: 'module not configured' };
    if (state.status === 'not_installed') {
      return { status: 'error', error: 'module not installed' };
    }
    if (state.mode !== 'local') {
      return { status: 'disabled', reason: `module mode is ${state.mode}` };
    }

    const spec = LAUNCH_SPECS[moduleId];
    const port = parseInt(process.env[spec.portEnv ?? ''] || '', 10) || spec.defaultPort;

    try {
      if (state.processType === 'docker' && spec.dockerService) {
        return await this.startDocker(repo, moduleId, spec, port);
      } else if (spec.scriptPath) {
        return await this.startSubprocess(repo, moduleId, spec, port, state);
      }
      return { status: 'error', error: 'no launch method configured' };
    } catch (err: any) {
      await repo.upsert({
        moduleId,
        status: 'error',
        lastError: err?.message ?? String(err),
      });
      return { status: 'error', error: err?.message ?? String(err) };
    }
  }

  private async startSubprocess(
    repo: PgModuleStatesRepo,
    moduleId: ModuleId,
    spec: LaunchSpec,
    port: number,
    state: ModuleState,
  ): Promise<ServiceStatus> {
    if (!spec.scriptPath) throw new Error('missing scriptPath');
    const args = (spec.args?.(state.weightsPath ?? '', state.gpuRequired) ?? [])
      .map((a) => (a === '' ? String(port) : a));
    const child = spawn('python3', [spec.scriptPath, ...args], {
      env: {
        ...process.env,
        ...(spec.portEnv ? { [spec.portEnv]: String(port) } : {}),
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const service: RunningService = { pid: child.pid, port, process: child, startedAt: new Date(), repo };
    this.running.set(moduleId, service);

    child.on('exit', (code) => {
      this.running.delete(moduleId);
      console.log(`[supervisor] ${moduleId} exited with code ${code}`);
    });

    await repo.upsert({
      moduleId,
      status: 'running',
      startedAt: new Date(),
      lastError: null,
    });

    return { status: 'running', pid: child.pid, port };
  }

  private async startDocker(
    repo: PgModuleStatesRepo,
    moduleId: ModuleId,
    spec: LaunchSpec,
    port: number,
  ): Promise<ServiceStatus> {
    if (!spec.dockerService) throw new Error('missing dockerService');
    const composeFile = path.join(PROJECT_ROOT, 'docker-compose.dev.yml');
    await execFileAsync(
      'docker',
      [
        'compose',
        '-f', composeFile,
        '--profile', spec.dockerProfile ?? spec.dockerService,
        'up', '-d', spec.dockerService,
      ],
      { timeout: 60000 },
    );

    this.running.set(moduleId, { port, startedAt: new Date(), repo });
    await repo.upsert({
      moduleId,
      status: 'running',
      startedAt: new Date(),
      lastError: null,
    });
    return { status: 'running', port };
  }

  async stopService(moduleId: ModuleId): Promise<ServiceStatus> {
    const service = this.running.get(moduleId);
    if (!service) return { status: 'stopped' };

    if (service.process) {
      try { service.process.kill('SIGTERM'); } catch { /* ignore */ }
    } else {
      // Docker container
      const spec = LAUNCH_SPECS[moduleId];
      if (spec.dockerService) {
        const composeFile = path.join(PROJECT_ROOT, 'docker-compose.dev.yml');
        try {
          await execFileAsync('docker', ['compose', '-f', composeFile, 'stop', spec.dockerService], { timeout: 30000 });
        } catch { /* ignore */ }
      }
    }
    this.running.delete(moduleId);
    // Write stopped state back to module_states (status reverts to 'installed')
    if (service.repo) {
      await service.repo.upsert({ moduleId, status: 'installed', startedAt: null, lastError: null });
    }
    return { status: 'stopped' };
  }

  getStatus(): Record<string, ServiceStatus> {
    const result: Record<string, ServiceStatus> = {};
    for (const [id, svc] of this.running.entries()) {
      result[id] = { status: 'running', pid: svc.pid, port: svc.port };
    }
    return result;
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.running.keys());
    await Promise.all(ids.map((id) => this.stopService(id)));
  }
}

let instance: ModelSupervisor | null = null;

export function getModelSupervisor(): ModelSupervisor {
  if (!instance) instance = new ModelSupervisor();
  return instance;
}

export function _resetSupervisor(): void {
  instance = null;
}
