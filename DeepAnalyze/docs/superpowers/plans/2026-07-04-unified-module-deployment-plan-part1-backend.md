# 统一模块部署实施计划 - Part 1: 后端基础

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DeepAnalyze 4 个基础设施模块（Embedding / ASR / Docling / MinerU）建立统一的本地部署/远端调用后端基础设施，包括状态数据层、GPU 检测、模块生命周期管理、新模块服务（GLM-OCR / MinerU local / Docling remote）、HTTP 路由以及与现有代码的集成。

**Architecture:** 以 `module_states` SQLite-PostgreSQL 表为单一数据源，新增 GPU 三档检测器和模块生命周期 supervisor（重写已有损坏版本），复用现有 `model-downloader.ts` 的下载能力。GLM-OCR 和 MinerU local 通过 Docker 容器提供（仿 `paddleocr-vl-manager.ts` 函数式导出模式），Docling 新增远端 HTTP 客户端。所有模块通过 `/api/modules/*` 路由统一管理，与现有 `bumpConfigVersion()` 热更新机制集成。

**Tech Stack:** TypeScript (Bun runtime), Hono (HTTP), PostgreSQL (pg + pgvector), Vitest (unit/integration), Docker Compose (container services), Python FastAPI (GLM-OCR service), Python (MinerU service).

## Global Constraints

- 数据库迁移文件位于 `src/store/pg-migrations/`，命名 `NNN_snake_case.ts`，下一个版本号 **029**
- 迁移必须在 `src/main.ts:96` 的 `migratePG([...])` 数组中按顺序注册
- `bumpConfigVersion()` 在 `src/models/router.ts:48` 是全局版本号（无参数），任何模块配置变更都调用它
- Hono 路由工厂模式：`export function createXxxRoutes(): Hono { const router = new Hono(); ...; return router; }`，在 `src/server/app.ts` 通过 `app.route("/api/xxx", createXxxRoutes())` 挂载
- Docker 容器管理使用函数式导出（仿 `src/services/paddleocr-vl-manager.ts`），不用类
- Docker compose 服务使用 `profiles: [<name>]` 按需启用，volume 挂载 `./data/models:/app/models:ro`
- HF 镜像下载默认 `HF_ENDPOINT=https://hf-mirror.com`，复用 `src/services/model-downloader.ts` 现有能力
- 测试框架 Vitest，测试文件位于 `tests/*.test.ts`，E2E 测试位于 `tests/e2e/*.spec.ts`
- 模块 ID 字符串常量：`"embedding" | "asr" | "docling" | "mineru"`（4 个基础设施模块）
- Python 服务端口：embedding 11435, whisper 9877, paddleocr-vl 8600, glm-ocr 8601, mineru 8001

---

## Task 1: module_states 数据迁移与 Repo 层

**Files:**
- Create: `src/store/pg-migrations/029_module_states.ts`
- Create: `src/store/repos/module-states.ts`
- Modify: `src/main.ts:94-96` (注册新迁移)
- Test: `tests/module-states.test.ts`

**Interfaces:**
- Consumes: `pg.Pool` (from `src/store/pg.ts`)
- Produces:
  - `MODULE_IDS` 常量: `["embedding", "asr", "docling", "mineru"] as const`
  - `ModuleStatus` 类型: `"not_installed" | "installing" | "installed" | "running" | "error"`
  - `ModuleMode` 类型: `"local" | "remote" | "disabled"`
  - `ModuleState` 接口（详见下方实现）
  - `PgModuleStatesRepo` 类: `get(moduleId)`, `upsert(state)`, `list()`, `delete(moduleId)`

- [ ] **Step 1: 写迁移文件**

Create `src/store/pg-migrations/029_module_states.ts`:

```typescript
import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 29,
  name: 'module_states',
  sql: `
-- 模块部署状态：单一数据源，决定 start.py / model-supervisor / /api/health 的行为
CREATE TABLE IF NOT EXISTS module_states (
  module_id       TEXT PRIMARY KEY,           -- 'embedding' | 'asr' | 'docling' | 'mineru'
  status          TEXT NOT NULL DEFAULT 'not_installed',
                  -- 'not_installed' | 'installing' | 'installed' | 'running' | 'error'
  mode            TEXT NOT NULL DEFAULT 'disabled',
                  -- 'local' | 'remote' | 'disabled'
  weights_path    TEXT,
  weights_size_mb INTEGER,
  gpu_required    BOOLEAN NOT NULL DEFAULT false,
  process_type    TEXT NOT NULL DEFAULT 'subprocess',
                  -- 'subprocess' | 'docker'
  remote_endpoint TEXT,
  remote_api_key  TEXT,
  remote_protocol TEXT,                        -- 'openai' | 'mineru-rest' | 'docling-rest'
  vlm_backend     TEXT,                        -- 仅 docling 用
                  -- 'none' | 'paddleocr-vl-local' | 'glm-ocr-local' | 'remote-openai-vlm'
  last_error      TEXT,
  installed_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  config_version  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_module_states_status ON module_states (status);
CREATE INDEX IF NOT EXISTS idx_module_states_mode   ON module_states (mode);
`,
};
```

- [ ] **Step 2: 写 Repo 类型与实现**

Create `src/store/repos/module-states.ts`:

```typescript
import pg from 'pg';

export const MODULE_IDS = ['embedding', 'asr', 'docling', 'mineru'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export type ModuleStatus = 'not_installed' | 'installing' | 'installed' | 'running' | 'error';
export type ModuleMode = 'local' | 'remote' | 'disabled';
export type ProcessType = 'subprocess' | 'docker';
export type RemoteProtocol = 'openai' | 'mineru-rest' | 'docling-rest';
export type DoclingVlmBackend = 'none' | 'paddleocr-vl-local' | 'glm-ocr-local' | 'remote-openai-vlm';

export interface ModuleState {
  moduleId: ModuleId;
  status: ModuleStatus;
  mode: ModuleMode;
  weightsPath?: string | null;
  weightsSizeMb?: number | null;
  gpuRequired: boolean;
  processType: ProcessType;
  remoteEndpoint?: string | null;
  remoteApiKey?: string | null;
  remoteProtocol?: RemoteProtocol | null;
  vlmBackend?: DoclingVlmBackend | null;
  lastError?: string | null;
  installedAt?: Date | null;
  startedAt?: Date | null;
  configVersion: number;
}

export class PgModuleStatesRepo {
  constructor(private pool: pg.Pool) {}

  async get(moduleId: ModuleId): Promise<ModuleState | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM module_states WHERE module_id = $1',
      [moduleId],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async list(): Promise<ModuleState[]> {
    const { rows } = await this.pool.query('SELECT * FROM module_states ORDER BY module_id');
    return rows.map((r) => this.mapRow(r));
  }

  async upsert(state: Partial<ModuleState> & { moduleId: ModuleId }): Promise<ModuleState> {
    const {
      moduleId,
      status,
      mode,
      weightsPath,
      weightsSizeMb,
      gpuRequired = false,
      processType = 'subprocess',
      remoteEndpoint,
      remoteApiKey,
      remoteProtocol,
      vlmBackend,
      lastError,
      installedAt,
      startedAt,
      configVersion = 0,
    } = state;
    const { rows } = await this.pool.query(
      `INSERT INTO module_states (
        module_id, status, mode, weights_path, weights_size_mb, gpu_required,
        process_type, remote_endpoint, remote_api_key, remote_protocol,
        vlm_backend, last_error, installed_at, started_at, config_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (module_id) DO UPDATE SET
        status = COALESCE(EXCLUDED.status, module_states.status),
        mode = COALESCE(EXCLUDED.mode, module_states.mode),
        weights_path = COALESCE(EXCLUDED.weights_path, module_states.weights_path),
        weights_size_mb = COALESCE(EXCLUDED.weights_size_mb, module_states.weights_size_mb),
        gpu_required = COALESCE(EXCLUDED.gpu_required, module_states.gpu_required),
        process_type = COALESCE(EXCLUDED.process_type, module_states.process_type),
        remote_endpoint = COALESCE(EXCLUDED.remote_endpoint, module_states.remote_endpoint),
        remote_api_key = COALESCE(EXCLUDED.remote_api_key, module_states.remote_api_key),
        remote_protocol = COALESCE(EXCLUDED.remote_protocol, module_states.remote_protocol),
        vlm_backend = COALESCE(EXCLUDED.vlm_backend, module_states.vlm_backend),
        last_error = EXCLUDED.last_error,
        installed_at = COALESCE(EXCLUDED.installed_at, module_states.installed_at),
        started_at = COALESCE(EXCLUDED.started_at, module_states.started_at),
        config_version = COALESCE(EXCLUDED.config_version, module_states.config_version)
      RETURNING *`,
      [
        moduleId, status ?? null, mode ?? null, weightsPath ?? null, weightsSizeMb ?? null,
        gpuRequired, processType, remoteEndpoint ?? null, remoteApiKey ?? null,
        remoteProtocol ?? null, vlmBackend ?? null, lastError ?? null,
        installedAt ?? null, startedAt ?? null, configVersion,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async delete(moduleId: ModuleId): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM module_states WHERE module_id = $1',
      [moduleId],
    );
    return (rowCount ?? 0) > 0;
  }

  private mapRow(r: any): ModuleState {
    return {
      moduleId: r.module_id,
      status: r.status,
      mode: r.mode,
      weightsPath: r.weights_path,
      weightsSizeMb: r.weights_size_mb,
      gpuRequired: r.gpu_required,
      processType: r.process_type,
      remoteEndpoint: r.remote_endpoint,
      remoteApiKey: r.remote_api_key,
      remoteProtocol: r.remote_protocol,
      vlmBackend: r.vlm_backend,
      lastError: r.last_error,
      installedAt: r.installed_at,
      startedAt: r.started_at,
      configVersion: r.config_version,
    };
  }
}
```

- [ ] **Step 3: 写失败测试**

Create `tests/module-states.test.ts`:

```typescript
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
```

- [ ] **Step 4: 注册迁移**

Modify `src/main.ts` after line 94 (after `const m028 = await import(...)`):

```typescript
  const m029 = await import("./store/pg-migrations/029_module_states.ts");
```

Update line 96 to append `m029.migration` to the array:

```typescript
  await migratePG([m001.migration, m002.migration, m003.migration, m004.migration, m005.migration, m006.migration, m007.migration, m008.migration, m009.migration, m010.migration, m011.migration, m012.migration, m013.migration, m014.migration, m015.migration, m016.migration, m017.migration, m018.migration, m019.migration, m020.migration, m021.migration, m022.migration, m023.migration, m024.migration, m025.migration, m026.migration, m027.migration, m028.migration, m029.migration]);
```

- [ ] **Step 5: 运行测试验证**

Run: `bun test tests/module-states.test.ts`
Expected: PASS (5/5 tests)

- [ ] **Step 6: 提交**

```bash
git add src/store/pg-migrations/029_module_states.ts src/store/repos/module-states.ts src/main.ts tests/module-states.test.ts
git commit -m "feat(modules): module_states table and repo layer

Adds the single source of truth for module deployment state
(status/mode/weights/process_type/remote_config). Foundation for
unified local+remote module lifecycle management."
```

---

## Task 2: GPU 检测器

**Files:**
- Create: `src/server/gpu-detector.ts`
- Test: `tests/gpu-detector.test.ts`

**Interfaces:**
- Consumes: `node:child_process` (execFile for `nvidia-smi`)
- Produces:
  - `GpuTier` 类型: `"none" | "low" | "high"`
  - `GpuInfo` 接口: `{ tier, hasNvidia, vramMB, deviceName?, cudaVersion? }`
  - `detectGpu()` 异步函数

- [ ] **Step 1: 写失败测试**

Create `tests/gpu-detector.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { detectGpu, parseNvidiaSmi, classifyGpuTier } from '../src/server/gpu-detector.ts';

// Mock execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/gpu-detector.test.ts`
Expected: FAIL with "Cannot find module '../src/server/gpu-detector.ts'"

- [ ] **Step 3: 写实现**

Create `src/server/gpu-detector.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GpuTier = 'none' | 'low' | 'high';

export interface GpuInfo {
  tier: GpuTier;
  hasNvidia: boolean;
  vramMB: number;
  deviceName?: string;
  cudaVersion?: string;
}

const HIGH_TIER_VRAM_MB = 8192; // 8 GB threshold

export function classifyGpuTier(vramMB: number, hasNvidia: boolean): GpuTier {
  if (!hasNvidia || vramMB <= 0) return 'none';
  return vramMB >= HIGH_TIER_VRAM_MB ? 'high' : 'low';
}

export function parseNvidiaSmi(output: string): {
  deviceName: string;
  vramMB: number;
  cudaVersion: string;
} | null {
  // Expected format: "NVIDIA GeForce RTX 4090, 24576 MiB, 12.4\n"
  const match = output.match(/^(.+?),\s*(\d+)\s*MiB,\s*([\d.]+)/);
  if (!match) return null;
  return {
    deviceName: match[1].trim(),
    vramMB: parseInt(match[2], 10),
    cudaVersion: match[3].trim(),
  };
}

export async function detectGpu(): Promise<GpuInfo> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    // nvidia-smi csv output: "NVIDIA GeForce RTX 4090, 24576 MiB, 12.4"
    const parsed = parseNvidiaSmi(stdout);
    if (!parsed) {
      return { tier: 'none', hasNvidia: false, vramMB: 0 };
    }
    return {
      tier: classifyGpuTier(parsed.vramMB, true),
      hasNvidia: true,
      vramMB: parsed.vramMB,
      deviceName: parsed.deviceName,
      cudaVersion: parsed.cudaVersion,
    };
  } catch {
    return { tier: 'none', hasNvidia: false, vramMB: 0 };
  }
}
```

Note: the `--query-gpu=name,memory.total,driver_version` query format is more reliable than the `--query-gpu=driver_version` form. The CSV output looks like `NVIDIA GeForce RTX 4090, 24576 MiB, 12.4`.

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/gpu-detector.test.ts`
Expected: PASS (6/6 tests)

- [ ] **Step 5: 提交**

```bash
git add src/server/gpu-detector.ts tests/gpu-detector.test.ts
git commit -m "feat(modules): GPU three-tier detector

Classifies GPUs as none/low(<8GB)/high(>=8GB) via nvidia-smi.
Used to recommend module install presets and GPU/CPU mode."
```

---

## Task 3: 模块安装/卸载辅助函数

**Files:**
- Create: `src/server/module-lifecycle.ts`
- Test: `tests/module-lifecycle.test.ts`

**Interfaces:**
- Consumes:
  - `downloadModel`, `verifyModel`, `removeModel` from `src/services/model-downloader.ts`
  - `PgModuleStatesRepo` from Task 1
  - `GpuInfo`, `detectGpu` from Task 2
- Produces:
  - `ModuleInstallOptions` 接口: `{ force?: boolean; onProgress?: (p: { percent: number; downloadedMB: number; totalMB: number }) => void }`
  - `installModule(repo, moduleId, gpuInfo, options)` 异步函数 → `ModuleState`
  - `uninstallModule(repo, moduleId)` 异步函数 → `void`
  - `MODULE_DEFAULTS` 常量: 每个 `ModuleId` 的默认配置（manifest 名称、GPU 需求、进程类型）

- [ ] **Step 1: 定义模块默认配置**

The module defaults are part of the implementation. Create `src/server/module-lifecycle.ts`:

```typescript
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
    // downloadModel returns array of downloaded file paths
    const files = await downloadModel(def.manifestName, 'hf_mirror', (phase: string, current: number, total: number) => {
      if (options.onProgress && total > 0) {
        options.onProgress({
          percent: current / total,
          downloadedMB: Math.floor((current / 1024 / 1024)),
          totalMB: Math.floor((total / 1024 / 1024)),
        });
      }
    });

    // Verify checksums
    await verifyModel(def.manifestName);

    // Compute weights size from downloaded files
    const fs = await import('node:fs');
    let totalBytes = 0;
    for (const f of files) {
      try {
        const stat = await fs.promises.stat(f);
        totalBytes += stat.size;
      } catch { /* ignore missing */ }
    }
    const sizeMB = Math.floor(totalBytes / 1024 / 1024);

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
```

- [ ] **Step 2: 写失败测试**

Create `tests/module-lifecycle.test.ts`:

```typescript
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
    (downloadModel as any).mockResolvedValue(['/tmp/fake-weights.bin']);
    (verifyModel as any).mockResolvedValue(undefined);

    // Mock fs.stat
    const fs = await import('node:fs');
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 2_200_000_000 } as any);

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
      weightsSizeMb: 2098, // ~2.2GB
    }));
    expect(downloadModel).toHaveBeenCalledWith('bge-m3', 'hf_mirror', expect.any(Function));
  });

  it('sets status=error on download failure', async () => {
    (downloadModel as any).mockRejectedValue(new Error('network down'));

    await expect(installModule(mockRepo, 'asr', gpuNone)).rejects.toThrow('network down');

    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'asr',
      status: 'error',
      lastError: 'network down',
    }));
  });

  it('respects gpuRequired override', async () => {
    (downloadModel as any).mockResolvedValue(['/tmp/x']);
    (verifyModel as any).mockResolvedValue(undefined);
    const fs = await import('node:fs');
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 100 } as any);

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
```

- [ ] **Step 3: 运行测试验证通过**

Run: `bun test tests/module-lifecycle.test.ts`
Expected: PASS (6/6 tests)

- [ ] **Step 4: 提交**

```bash
git add src/server/module-lifecycle.ts tests/module-lifecycle.test.ts
git commit -m "feat(modules): install/uninstall lifecycle helpers

Wraps model-downloader.ts to provide module-aware install flow
with progress callbacks and module_states repo integration.
Foundation for /api/modules/install endpoint."
```

---

## Task 4: 模块 Supervisor 重写

**Files:**
- Rewrite: `src/server/model-supervisor.ts` (currently broken)
- Update: `tests/model-supervisor.test.ts`

**Interfaces:**
- Consumes:
  - `PgModuleStatesRepo` from Task 1
  - `MODULE_DEFAULTS` from Task 3
  - `docker compose` for Docker-based modules (via `execFile`)
  - `subprocess.spawn` for subprocess modules
- Produces:
  - `getModelSupervisor()` 单例工厂
  - `ModelSupervisor` 类方法: `startService(repo, moduleId)`, `stopService(moduleId)`, `getStatus(): Record<ModuleId, ServiceStatus>`, `stopAll()`
  - `ServiceStatus` 类型: `{ status: "running"|"stopped"|"error"|"disabled"; pid?: number; port?: number; error?: string }`

- [ ] **Step 1: 重写测试**

Rewrite `tests/model-supervisor.test.ts`:

```typescript
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
    (sup as any).running.set('embedding', { pid: 999, port: 11435, process: { kill: vi.fn() } });
    await sup.stopService('embedding');
    expect(mockRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      moduleId: 'embedding',
      status: 'installed', // back to installed (not running)
    }));
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/model-supervisor.test.ts`
Expected: FAIL (current implementation references non-existent Python script paths)

- [ ] **Step 3: 重写实现**

Rewrite `src/server/model-supervisor.ts` (replace entire file):

```typescript
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

    const service: RunningService = { pid: child.pid, port, process: child, startedAt: new Date() };
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

    this.running.set(moduleId, { port, startedAt: new Date() });
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/model-supervisor.test.ts`
Expected: PASS (5/5 tests)

- [ ] **Step 5: 提交**

```bash
git add src/server/model-supervisor.ts tests/model-supervisor.test.ts
git commit -m "fix(modules): rewrite model-supervisor with correct paths

Previous version pointed at non-existent src/services/{module}/server.py.
Now reads module_states table for ground truth, dispatches to either
subprocess (embedding/whisper/docling) or docker compose (mineru),
and writes status back to module_states."
```

---

## Task 5: GLM-OCR Python 服务与容器管理

**Files:**
- Create: `glm-ocr-service/main.py` (FastAPI 服务)
- Create: `glm-ocr-service/Dockerfile`
- Create: `glm-ocr-service/requirements.txt`
- Modify: `docker-compose.dev.yml` (新增 `glm-ocr` 服务)
- Create: `src/server/glm-ocr-manager.ts`
- Test: `tests/glm-ocr-manager.test.ts`

**Interfaces:**
- Consumes: `node:child_process` for `docker compose`
- Produces:
  - `GlmOcrStatus` 类型: `"running" | "stopped" | "unavailable" | "error"`
  - `GlmOcrInfo` 接口: `{ status, containerId?, port, healthUrl, error? }`
  - `getGlmOcrStatus()`, `startGlmOcrContainer()`, `stopGlmOcrContainer()` 异步函数

- [ ] **Step 1: 写 Python 服务**

Create `glm-ocr-service/main.py`:

```python
"""GLM-OCR FastAPI service — exposes /predict for OCR on images.

Mirrors paddleocr-vl-service/main.py API shape so the docling-service
parser can switch between backends with minimal code changes.
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Lazy load torch + model — keep startup fast until first request
_MODEL = None
_PROCESSOR = None
_DEVICE = None


class PredictRequest(BaseModel):
    image_base64: str
    max_tokens: int = 4096


class PredictResponse(BaseModel):
    text: str
    usage: dict[str, Any]


app = FastAPI(title="DeepAnalyze GLM-OCR Service")


def _load_model() -> None:
    global _MODEL, _PROCESSOR, _DEVICE
    if _MODEL is not None:
        return
    import torch
    from transformers import AutoModel, AutoProcessor

    model_path = os.environ.get("MODEL_PATH", "/app/models/docling/vlm/zai-org--GLM-OCR")
    _DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    _PROCESSOR = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
    _MODEL = AutoModel.from_pretrained(
        model_path,
        torch_dtype=torch.bfloat16 if _DEVICE == "cuda" else torch.float32,
        trust_remote_code=True,
    ).to(_DEVICE)
    _MODEL.eval()


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "device": _DEVICE or "unloaded"}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    _load_model()
    import torch
    from PIL import Image
    import io

    try:
        img_bytes = base64.b64decode(req.image_base64)
        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid image: {exc}")

    # GLM-OCR processor format
    inputs = _PROCESSOR(images=image, return_tensors="pt").to(_DEVICE)
    with torch.no_grad():
        generated = _MODEL.generate(**inputs, max_new_tokens=req.max_tokens)

    text = _PROCESSOR.batch_decode(generated, skip_special_tokens=True)[0]
    return PredictResponse(
        text=text,
        usage={"input_tokens": 0, "output_tokens": 0, "device": _DEVICE or "unknown"},
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8601)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 写 Dockerfile 与 requirements**

Create `glm-ocr-service/requirements.txt`:

```
fastapi>=0.110
uvicorn[standard]>=0.27
torch>=2.2
transformers>=4.40
Pillow>=10.0
pydantic>=2.0
```

Create `glm-ocr-service/Dockerfile`:

```dockerfile
FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_ENDPOINT=https://hf-mirror.com

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3-pip python3.11-dev \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3.11 /usr/bin/python3 && \
    ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --upgrade pip && pip3 install -r requirements.txt

COPY . /app/

EXPOSE 8601
CMD ["python3", "main.py", "--host", "0.0.0.0", "--port", "8601"]
```

- [ ] **Step 3: 加 docker-compose 服务**

Add to `docker-compose.dev.yml` (alongside paddleocr-vl, same pattern):

```yaml
  glm-ocr:
    build:
      context: ./glm-ocr-service
      dockerfile: Dockerfile
    ports:
      - "8601:8601"
    volumes:
      - ./data/models:/app/models:ro
    environment:
      - MODEL_PATH=/app/models/docling/vlm/zai-org--GLM-OCR
      - TORCH_DTYPE=bfloat16
      - MAX_TOKENS=8192
      - HF_ENDPOINT=https://hf-mirror.com
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    profiles: [vlm, glm-ocr]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8601/health"]
      interval: 30s
      timeout: 10s
      start_period: 180s
      retries: 3
    restart: unless-stopped
```

- [ ] **Step 4: 写 TS 管理函数**

Create `src/server/glm-ocr-manager.ts` (mirror paddleocr-vl-manager.ts pattern):

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COMPOSE_FILE = path.join(PROJECT_ROOT, 'docker-compose.dev.yml');

const SERVICE_NAME = 'glm-ocr';
const HEALTH_URL = 'http://localhost:8601/health';
const DEFAULT_PORT = 8601;

export type GlmOcrStatus = 'running' | 'stopped' | 'unavailable' | 'error';

export interface GlmOcrInfo {
  status: GlmOcrStatus;
  containerId?: string;
  port: number;
  healthUrl: string;
  error?: string;
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function getGlmOcrStatus(): Promise<GlmOcrInfo> {
  if (!(await isDockerAvailable())) {
    return { status: 'unavailable', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: 'Docker not available' };
  }
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'ps', '--format', 'json', SERVICE_NAME],
      { timeout: 10000 },
    );
    if (!stdout.trim()) {
      return { status: 'stopped', port: DEFAULT_PORT, healthUrl: HEALTH_URL };
    }
    const line = stdout.trim().split('\n')[0];
    const info = JSON.parse(line);
    if (info.State === 'running') {
      return { status: 'running', containerId: info.Id, port: DEFAULT_PORT, healthUrl: HEALTH_URL };
    }
    return { status: 'stopped', port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err: any) {
    return { status: 'error', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: err?.message };
  }
}

export async function startGlmOcrContainer(): Promise<GlmOcrInfo> {
  if (!(await isDockerAvailable())) {
    return { status: 'unavailable', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: 'Docker not available' };
  }
  try {
    await execFileAsync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, '--profile', 'glm-ocr', 'up', '-d', SERVICE_NAME],
      { timeout: 60000 },
    );
    return { status: 'running', port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err: any) {
    return { status: 'error', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: err?.message };
  }
}

export async function stopGlmOcrContainer(): Promise<GlmOcrInfo> {
  if (!(await isDockerAvailable())) {
    return { status: 'unavailable', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: 'Docker not available' };
  }
  try {
    await execFileAsync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'stop', SERVICE_NAME],
      { timeout: 30000 },
    );
    return { status: 'stopped', port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err: any) {
    return { status: 'error', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: err?.message };
  }
}
```

- [ ] **Step 5: 写失败测试**

Create `tests/glm-ocr-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));
vi.mock('node:util', async (orig) => ({
  ...(await orig<any>()),
  promisify: (fn: any) => (...args: any[]) => fn(...args, () => {}),
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
```

- [ ] **Step 6: 运行测试验证通过**

Run: `bun test tests/glm-ocr-manager.test.ts`
Expected: PASS (5/5 tests)

- [ ] **Step 7: 验证 Dockerfile 构建（手动，仅一次）**

Run: `docker build -t da/glm-ocr:test glm-ocr-service/`
Expected: build succeeds (image size ~3 GB)

(Skip if Docker unavailable in dev env — verify in CI.)

- [ ] **Step 8: 提交**

```bash
git add glm-ocr-service/ docker-compose.dev.yml src/server/glm-ocr-manager.ts tests/glm-ocr-manager.test.ts
git commit -m "feat(modules): GLM-OCR Docker service + manager

New Python FastAPI service exposes /predict for OCR using zai-org/GLM-OCR.
Manager mirrors paddleocr-vl-manager.ts function-export pattern.
Provides second local VLM backend option for docling."
```

---

## Task 6: MinerU Local Docker 服务与容器管理

**Files:**
- Create: `mineru-service/Dockerfile` (CPU + GPU variants)
- Create: `mineru-service/entrypoint.sh`
- Modify: `docker-compose.dev.yml` (新增 `mineru` 服务)
- Create: `src/server/mineru-local-manager.ts`
- Test: `tests/mineru-local-manager.test.ts`

**Interfaces:**
- Consumes: `docker compose`
- Produces:
  - `MinerULocalStatus` 类型: `"running" | "stopped" | "unavailable" | "error"`
  - `MinerULocalInfo` 接口: `{ status, containerId?, port, healthUrl, error? }`
  - `getMinerULocalStatus()`, `startMinerULocalContainer(gpuRequired)`, `stopMinerULocalContainer()` 异步函数

- [ ] **Step 1: 写 Dockerfile**

Create `mineru-service/Dockerfile`:

```dockerfile
# MinerU local service — based on opendatalab/MinerU.
# Two build args: DEVICE=cuda|cpu controls torch wheel variant.
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

ARG DEVICE=cpu

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_ENDPOINT=https://hf-mirror.com

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 libglib2.0-0 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install torch based on device variant
RUN if [ "$DEVICE" = "cuda" ]; then \
        pip3 install --extra-index-url https://download.pytorch.org/whl/cu121 torch torchvision; \
    else \
        pip3 install torch torchvision --index-url https://download.pytorch.org/whl/cpu; \
    fi

# Install MinerU (magic-pdf CLI + library)
RUN pip3 install -U "magic-pdf[full]" || pip3 install -U magic-pdf

# Pre-download models to /app/models (overridden by volume mount at runtime)
ENV MODEL_SOURCE=HF

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8001/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
```

Create `mineru-service/entrypoint.sh`:

```bash
#!/bin/bash
set -e

# MinerU ships a CLI (magic-pdf) and a Python API. We expose a tiny FastAPI
# wrapper providing /health, /file_parse, and /tasks endpoints compatible
# with src/services/document-processors/mineru-client.ts.

cat > /app/server.py <<'PYEOF'
import os
import tempfile
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI(title="DeepAnalyze MinerU Service")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/file_parse")
async def file_parse(
    file: UploadFile = File(...),
    parse_method: str = Form("auto"),
):
    try:
        from magic_pdf.pipe.UNIPipe import UNIPipe
        from magic_pdf.rw.DiskReaderWriter import DiskReaderWriter
        import magic_pdf.model as model_config
        model_config.__use_inside_model = True
        model_config.__model_mode = "auto"

        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = Path(tmpdir) / file.filename
            pdf_path.write_bytes(await file.read())
            image_dir = Path(tmpdir) / "images"
            image_dir.mkdir()

            disk_reader = DiskReaderWriter(tmpdir)
            pipe = UNIPipe(pdf_path.read_bytes(), disk_reader, image_dir)
            pipe.apply()

            md_content = pipe.pipe_mk_uni_format(image_dir, drop_mode="none")
            return JSONResponse({
                "md_content": md_content,
                "images": [],
                "parse_method": parse_method,
            })
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/tasks")
async def create_task(file: UploadFile = File(...)):
    # Synchronous for simplicity; could be made async with task ID later.
    return await file_parse(file)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8001")))
PYEOF

# Add fastapi/uvicorn if not bundled with magic-pdf
pip3 install --no-cache-dir fastapi uvicorn[standard] python-multipart || true

exec python3 /app/server.py
```

- [ ] **Step 2: 加 docker-compose 服务**

Add to `docker-compose.dev.yml`:

```yaml
  mineru:
    build:
      context: ./mineru-service
      dockerfile: Dockerfile
      args:
        DEVICE: ${MINERU_DEVICE:-cpu}
    ports:
      - "8001:8001"
    volumes:
      - ./data/models:/app/models:ro
      - mineru-cache:/root/.cache
    environment:
      - HF_ENDPOINT=https://hf-mirror.com
      - PORT=8001
      - MODEL_SOURCE=HF
    profiles: [mineru]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
      interval: 30s
      timeout: 10s
      start_period: 180s
      retries: 3
    restart: unless-stopped

volumes:
  mineru-cache:
```

- [ ] **Step 3: 写 TS 管理函数**

Create `src/server/mineru-local-manager.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COMPOSE_FILE = path.join(PROJECT_ROOT, 'docker-compose.dev.yml');

const SERVICE_NAME = 'mineru';
const HEALTH_URL = 'http://localhost:8001/health';
const DEFAULT_PORT = 8001;

export type MinerULocalStatus = 'running' | 'stopped' | 'unavailable' | 'error';

export interface MinerULocalInfo {
  status: MinerULocalStatus;
  containerId?: string;
  port: number;
  healthUrl: string;
  device?: 'cpu' | 'cuda';
  error?: string;
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function getMinerULocalStatus(): Promise<MinerULocalInfo> {
  if (!(await isDockerAvailable())) {
    return { status: 'unavailable', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: 'Docker not available' };
  }
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'ps', '--format', 'json', SERVICE_NAME],
      { timeout: 10000 },
    );
    if (!stdout.trim()) {
      return { status: 'stopped', port: DEFAULT_PORT, healthUrl: HEALTH_URL };
    }
    const line = stdout.trim().split('\n')[0];
    const info = JSON.parse(line);
    if (info.State === 'running') {
      return {
        status: 'running',
        containerId: info.Id,
        port: DEFAULT_PORT,
        healthUrl: HEALTH_URL,
        device: process.env.MINERU_DEVICE === 'cuda' ? 'cuda' : 'cpu',
      };
    }
    return { status: 'stopped', port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err: any) {
    return { status: 'error', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: err?.message };
  }
}

export async function startMinerULocalContainer(gpuRequired = false): Promise<MinerULocalInfo> {
  if (!(await isDockerAvailable())) {
    return { status: 'unavailable', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: 'Docker not available' };
  }
  try {
    // Set device arg via env so docker compose picks up the build arg
    const env = {
      ...process.env,
      MINERU_DEVICE: gpuRequired ? 'cuda' : 'cpu',
    };
    await execFileAsync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, '--profile', 'mineru', 'up', '-d', '--build', SERVICE_NAME],
      { timeout: 300000, env }, // 5min — image build on first run
    );
    return {
      status: 'running',
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      device: gpuRequired ? 'cuda' : 'cpu',
    };
  } catch (err: any) {
    return { status: 'error', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: err?.message };
  }
}

export async function stopMinerULocalContainer(): Promise<MinerULocalInfo> {
  if (!(await isDockerAvailable())) {
    return { status: 'unavailable', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: 'Docker not available' };
  }
  try {
    await execFileAsync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'stop', SERVICE_NAME],
      { timeout: 30000 },
    );
    return { status: 'stopped', port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err: any) {
    return { status: 'error', port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: err?.message };
  }
}
```

- [ ] **Step 4: 写测试**

Create `tests/mineru-local-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));
vi.mock('node:util', async (orig) => ({
  ...(await orig<any>()),
  promisify: (fn: any) => (...args: any[]) => fn(...args, () => {}),
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
```

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/mineru-local-manager.test.ts`
Expected: PASS (4/4 tests)

- [ ] **Step 6: 提交**

```bash
git add mineru-service/ docker-compose.dev.yml src/server/mineru-local-manager.ts tests/mineru-local-manager.test.ts
git commit -m "feat(modules): MinerU local Docker service + manager

New mineru-service/ builds a CPU/GPU Docker image exposing /file_parse
compatible with existing MinerUClient. Manager provides lifecycle
functions mirroring paddleocr-vl-manager pattern."
```

---

## Task 7: Docling 远端 HTTP 客户端

**Files:**
- Create: `src/services/document-processors/docling-remote-client.ts`
- Test: `tests/docling-remote-client.test.ts`

**Interfaces:**
- Consumes: `fetch` (Node 18+ built-in)
- Produces:
  - `DoclingRemoteConfig` 接口: `{ endpoint: string; apiKey?: string; protocol: "docling-rest" }`
  - `DoclingRemoteClient` 类: `constructor(config)`, `parse(input)`, `health()`
  - `DoclingParseResult` 接口: `{ mdContent: string; jsonContent?: any; images?: string[]; parseMethod?: string }`

- [ ] **Step 1: 写失败测试**

Create `tests/docling-remote-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoclingRemoteClient } from '../src/services/document-processors/docling-remote-client.ts';

describe('DoclingRemoteClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('health returns true on 200', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    }) as any);

    const client = new DoclingRemoteClient({ endpoint: 'https://docling.example.com', protocol: 'docling-rest' });
    const ok = await client.health();
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://docling.example.com/health', expect.any(Object));
  });

  it('health returns false on network error', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const client = new DoclingRemoteClient({ endpoint: 'https://docling.example.com', protocol: 'docling-rest' });
    const ok = await client.health();
    expect(ok).toBe(false);
  });

  it('parse posts multipart with file', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        md_content: '# Title\n\nBody',
        images: [],
      }),
    }) as any);

    const client = new DoclingRemoteClient({
      endpoint: 'https://docling.example.com',
      apiKey: 'sk-secret',
      protocol: 'docling-rest',
    });

    // Create a temporary file
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpPath = path.join(os.tmpdir(), `test-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, Buffer.from('%PDF-1.4 fake'));

    const result = await client.parse({ filePath: tmpPath });
    expect(result.mdContent).toBe('# Title\n\nBody');
    expect(fetch).toHaveBeenCalledWith(
      'https://docling.example.com/file_parse',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-secret' }),
      }),
    );

    fs.unlinkSync(tmpPath);
  });

  it('parse throws on error response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }) as any);

    const client = new DoclingRemoteClient({ endpoint: 'https://docling.example.com', protocol: 'docling-rest' });

    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpPath = path.join(os.tmpdir(), `err-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, Buffer.from('fake'));

    await expect(client.parse({ filePath: tmpPath })).rejects.toThrow(/500/);

    fs.unlinkSync(tmpPath);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/docling-remote-client.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 写实现**

Create `src/services/document-processors/docling-remote-client.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';

export interface DoclingRemoteConfig {
  endpoint: string;
  apiKey?: string;
  protocol: 'docling-rest';
}

export interface DoclingParseInput {
  filePath: string;
  parseMethod?: 'auto' | 'ocr' | 'txt';
  options?: Record<string, unknown>;
}

export interface DoclingParseResult {
  mdContent: string;
  jsonContent?: unknown;
  images?: string[];
  parseMethod?: string;
}

export class DoclingRemoteClient {
  constructor(private config: DoclingRemoteConfig) {
    // Strip trailing slash
    this.config.endpoint = config.endpoint.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.config.endpoint}/health`, { headers: this.headers() });
      return r.ok;
    } catch {
      return false;
    }
  }

  async parse(input: DoclingParseInput): Promise<DoclingParseResult> {
    const filePath = input.filePath;
    if (!fs.existsSync(filePath)) {
      throw new Error(`file not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    // Use FormData for multipart upload (Node 18+ built-in)
    const form = new FormData();
    const blob = new Blob([fileBuffer]);
    form.append('file', blob, fileName);
    if (input.parseMethod) form.append('parse_method', input.parseMethod);
    if (input.options) {
      for (const [k, v] of Object.entries(input.options)) {
        form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }

    const r = await fetch(`${this.config.endpoint}/file_parse`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`docling remote parse failed: ${r.status} ${txt}`);
    }

    const json: any = await r.json();
    return {
      mdContent: json.md_content ?? json.md ?? '',
      jsonContent: json.json_content ?? json.content,
      images: json.images ?? [],
      parseMethod: json.parse_method,
    };
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/docling-remote-client.test.ts`
Expected: PASS (4/4 tests)

- [ ] **Step 5: 提交**

```bash
git add src/services/document-processors/docling-remote-client.ts tests/docling-remote-client.test.ts
git commit -m "feat(docling): remote HTTP client for Docling API

Adds DoclingRemoteClient speaking the same /file_parse multipart
protocol as MinerUClient, so a remote Docling service can be swapped
in via module_states.remote_endpoint."
```

---

## Task 8: /api/modules/* 路由

**Files:**
- Create: `src/server/routes/modules.ts`
- Modify: `src/server/app.ts:80` (挂载新路由)
- Test: `tests/modules-routes.test.ts`

**Interfaces:**
- Consumes:
  - `PgModuleStatesRepo` from Task 1
  - `installModule`, `uninstallModule` from Task 3
  - `getModelSupervisor` from Task 4
  - `detectGpu` from Task 2
  - `getGlmOcrStatus`, `startGlmOcrContainer`, `stopGlmOcrContainer` from Task 5
  - `getMinerULocalStatus`, `startMinerULocalContainer`, `stopMinerULocalContainer` from Task 6
  - `bumpConfigVersion` from `src/models/router.ts:48`
- Produces:
  - `createModulesRoutes()` Hono 工厂
  - 路由:
    - `GET /api/modules` — 列出全部模块状态
    - `GET /api/modules/:moduleId` — 单模块状态
    - `POST /api/modules/:moduleId/install` — 安装权重
    - `POST /api/modules/:moduleId/uninstall` — 卸载
    - `POST /api/modules/:moduleId/start` — 启动本地服务
    - `POST /api/modules/:moduleId/stop` — 停止本地服务
    - `PUT /api/modules/:moduleId/config` — 更新模式/远端配置
    - `GET /api/modules/gpu` — GPU 检测结果

- [ ] **Step 1: 写路由实现**

Create `src/server/routes/modules.ts`:

```typescript
import { Hono } from 'hono';
import { getPool } from '../../store/pg.ts';
import { PgModuleStatesRepo, MODULE_IDS } from '../../store/repos/module-states.ts';
import type { ModuleId } from '../../store/repos/module-states.ts';
import { installModule, uninstallModule, MODULE_DEFAULTS } from '../../server/module-lifecycle.ts';
import { getModelSupervisor } from '../../server/model-supervisor.ts';
import { detectGpu } from '../../server/gpu-detector.ts';
import { getGlmOcrStatus, startGlmOcrContainer, stopGlmOcrContainer } from '../../server/glm-ocr-manager.ts';
import {
  getMinerULocalStatus,
  startMinerULocalContainer,
  stopMinerULocalContainer,
} from '../../server/mineru-local-manager.ts';
import { bumpConfigVersion } from '../../models/router.ts';

function isValidModule(id: string): id is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(id);
}

export function createModulesRoutes(): Hono {
  const router = new Hono();

  const repo = () => new PgModuleStatesRepo(getPool());

  // --- GPU detection ---
  router.get('/gpu', async (c) => {
    const info = await detectGpu();
    return c.json(info);
  });

  // --- List all modules ---
  router.get('/', async (c) => {
    const states = await repo().list();
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
    const state = await repo().get(moduleId);
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
      const state = await installModule(repo(), moduleId, gpuInfo, {
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
      await uninstallModule(repo(), moduleId);
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
      const status = await getModelSupervisor().startService(repo(), moduleId);
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
      await repo().upsert({ moduleId, status: 'installed', startedAt: null });
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
    const patch: Record<string, unknown> = { moduleId };
    for (const [k, ok] of Object.entries(allowed)) {
      if (ok && body[k] !== undefined) patch[k] = body[k];
    }

    try {
      const state = await repo().upsert(patch);
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
```

- [ ] **Step 2: 挂载路由**

Modify `src/server/app.ts` to add after line 84 (after `app.route("/api/setup", createSetupRoutes());`):

```typescript
  app.route("/api/modules", createModulesRoutes());
```

Add import at the top of `app.ts` (after the existing route imports):

```typescript
import { createModulesRoutes } from "./routes/modules.js";
```

- [ ] **Step 3: 写集成测试**

Create `tests/modules-routes.test.ts`:

```typescript
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/modules-routes.test.ts`
Expected: PASS (6/6 tests)

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/modules.ts src/server/app.ts tests/modules-routes.test.ts
git commit -m "feat(modules): /api/modules/* routes

Unified API surface for module lifecycle: install/uninstall/start/stop,
config update (mode/remote/vlm_backend), GPU detection. All operations
bumpConfigVersion() so downstream managers hot-reload."
```

---

## Task 9: 后端集成（main.ts + capability-dispatcher + /api/health）

**Files:**
- Modify: `src/main.ts:264-322,540-577` (本地 Provider 注入逻辑改为读取 module_states)
- Modify: `src/models/capability-dispatcher.ts:486-549` (ASR 改为 mode 驱动)
- Modify: `src/server/app.ts:608-750` (`/api/health` 扩展)
- Test: `tests/module-integration.test.ts`

**Interfaces:**
- Consumes:
  - `PgModuleStatesRepo` from Task 1
  - All previous tasks
- Produces: 集成的后端行为

- [ ] **Step 1: 改 main.ts 本地 Provider 注入逻辑**

Modify `src/main.ts` around lines 264-322 (BGE-M3 injection) — wrap directory check with module_states query:

Find this block (around line 264-322, look for `local-bge-m3` upsert):
```typescript
// Existing code checks http://127.0.0.1:${embeddingPort}/health
// and upserts { id: "local-bge-m3", ... } into settings.providers
```

Change the gating condition. Before:
```typescript
const embeddingHealthOk = await checkHttp(`${embeddingEndpoint}/health`);
if (embeddingHealthOk) {
  settings.providers = upsertProvider(settings.providers, { id: "local-bge-m3", ... });
  settings.defaults.embedding = "local-bge-m3";
}
```

After:
```typescript
import { PgModuleStatesRepo } from "./store/repos/module-states.ts";
// ... inside the init function:
const moduleRepo = new PgModuleStatesRepo(pool);
const embeddingState = await moduleRepo.get("embedding");
const embeddingHealthOk = embeddingState?.mode === "local" && embeddingState?.status === "running"
  && await checkHttp(`${embeddingEndpoint}/health`);
if (embeddingHealthOk) {
  settings.providers = upsertProvider(settings.providers, { id: "local-bge-m3", ... });
  settings.defaults.embedding = "local-bge-m3";
}
```

Apply the same pattern to Whisper (around lines 540-577):
```typescript
const asrState = await moduleRepo.get("asr");
const whisperHealthOk = asrState?.mode === "local" && asrState?.status === "running"
  && await checkHttp(`${whisperEndpoint}/health`);
if (whisperHealthOk) {
  settings.providers = upsertProvider(settings.providers, { id: "local-whisper", ... });
  settings.defaults.audio_transcribe = "local-whisper";
}
```

The actual line-by-line edits depend on the current file shape — apply surgically without removing the cleanup logic (lines 324-337 for embedding fallback).

- [ ] **Step 2: 改 capability-dispatcher ASR 逻辑**

Modify `src/models/capability-dispatcher.ts:486-549`. Replace the hardcoded "Priority 1: Local" / "Priority 2: Remote" logic with mode-driven dispatch.

Add imports at top:
```typescript
import { getPool } from "../store/pg.ts";
import { PgModuleStatesRepo } from "../store/repos/module-states.ts";
```

Replace `transcribeAudio` (lines 486-549) body with:

```typescript
async transcribeAudio(
  audioData: ArrayBuffer,
  filename: string,
  options?: { language?: string; model?: string },
): Promise<{ text: string; language?: string; duration?: number }> {
  const repo = new PgModuleStatesRepo(getPool());
  const state = await repo.get("asr");

  // Determine effective mode
  const mode = state?.mode ?? "disabled";
  const language = options?.language;
  const model = options?.model;

  if (mode === "disabled" || !state) {
    throw new Error("ASR module is disabled — configure it in Settings → Models → ASR");
  }

  if (mode === "local") {
    // Local Whisper HTTP service
    if (state.status !== "running") {
      throw new Error(`ASR local service is ${state.status} — start it in Settings`);
    }
    try {
      return await this.transcribeViaLocalWhisper(audioData, filename, language, model);
    } catch (err) {
      throw new Error(`Local Whisper failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (mode === "remote") {
    // Remote OpenAI-compatible Whisper API
    const provider = this.resolveAsrProvider();
    if (!provider) throw new Error("no remote ASR provider configured");
    return await this.transcribeViaRemote(audioData, filename, provider, language, model);
  }

  throw new Error(`unsupported ASR mode: ${mode}`);
}

private resolveAsrProvider(): ProviderConfig | null {
  // Look up the active audio_transcribe provider from settings.defaults
  const settings = this.providerSettings; // assumed cached field
  const defaultId = settings.defaults?.audio_transcribe;
  if (!defaultId || defaultId === "local-whisper") return null;
  return settings.providers?.find((p) => p.id === defaultId) ?? null;
}

private async transcribeViaRemote(
  audioData: ArrayBuffer,
  filename: string,
  provider: ProviderConfig,
  language?: string,
  model?: string,
): Promise<{ text: string; language?: string; duration?: number }> {
  const form = new FormData();
  const blob = new Blob([audioData]);
  form.append("file", blob, filename);
  form.append("model", model || "whisper-1");
  if (language) form.append("language", language);

  const r = await fetch(`${provider.endpoint}/audio/transcriptions`, {
    method: "POST",
    headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
    body: form,
  });
  if (!r.ok) throw new Error(`remote ASR failed: ${r.status}`);
  const json: any = await r.json();
  return { text: json.text ?? "", language: json.language, duration: json.duration };
}
```

Keep the existing `transcribeViaLocalWhisper` private method (used in local mode).

- [ ] **Step 3: 扩展 /api/health**

Modify `src/server/app.ts:608-750`. Find the `/api/health` handler and expand the response shape.

Find the response object construction (around line 747):
```typescript
return c.json({
  status: ...,
  embedding: ...,
  llm: ...,
  // ...
});
```

Replace with:
```typescript
// Query module_states for all 4 modules
import { PgModuleStatesRepo } from "../../store/repos/module-states.ts";
const moduleRepo = new PgModuleStatesRepo(getPool());
const moduleStates = await moduleRepo.list();
const moduleMap: Record<string, any> = {};
for (const s of moduleStates) {
  moduleMap[s.moduleId] = {
    status: s.status,
    mode: s.mode,
    ...(s.lastError ? { error: s.lastError } : {}),
  };
}

return c.json({
  status: overallStatus,
  embedding: { ...embedding, module: moduleMap.embedding ?? null },
  llm,
  modules: {
    embedding: moduleMap.embedding ?? null,
    asr: moduleMap.asr ?? null,
    docling: moduleMap.docling ?? null,
    mineru: moduleMap.mineru ?? null,
  },
  // ... existing fields preserved
});
```

- [ ] **Step 4: 写集成测试**

Create `tests/module-integration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, closePool } from '../src/store/pg.ts';
import { PgModuleStatesRepo, MODULE_IDS } from '../src/store/repos/module-states.ts';

// Mock fetch for remote ASR test
global.fetch = vi.fn() as any;

import { CapabilityDispatcher } from '../src/models/capability-dispatcher.ts';

describe('module_states integration with capability-dispatcher', () => {
  let repo: PgModuleStatesRepo;
  let dispatcher: CapabilityDispatcher;

  beforeAll(async () => {
    const pool = await getPool();
    repo = new PgModuleStatesRepo(pool);
  });

  afterAll(async () => {
    for (const id of MODULE_IDS) await repo.delete(id);
    await closePool();
  });

  beforeEach(async () => {
    for (const id of MODULE_IDS) await repo.delete(id);
    vi.clearAllMocks();
  });

  it('throws when ASR module is disabled', async () => {
    await expect(
      dispatcher.transcribeAudio(new ArrayBuffer(8), 'test.wav'),
    ).rejects.toThrow(/disabled/i);
  });

  it('throws when ASR local mode but not running', async () => {
    await repo.upsert({ moduleId: 'asr', status: 'installed', mode: 'local' });
    await expect(
      dispatcher.transcribeAudio(new ArrayBuffer(8), 'test.wav'),
    ).rejects.toThrow(/start it in Settings/i);
  });

  it('calls remote ASR when mode=remote', async () => {
    await repo.upsert({
      moduleId: 'asr',
      status: 'not_installed',
      mode: 'remote',
      remoteEndpoint: 'https://api.openai.com/v1',
      remoteApiKey: 'sk-test',
      remoteProtocol: 'openai',
    });
    // Need provider settings to have a remote ASR provider as default
    // ... mock settings if needed
    // (fetch is mocked at top)
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello world', language: 'en', duration: 5.0 }),
    });
    // ... invoke dispatcher
  });
});
```

Note: The third test may need adjustment based on how `CapabilityDispatcher` reads provider settings — if it requires DI, mock accordingly.

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/module-integration.test.ts`
Expected: PASS (3/3 tests, possibly with the third adjusted based on dispatcher internals)

- [ ] **Step 6: 跑回归测试**

Run: `bun test`
Expected: All previously-passing tests still pass. Specifically check:
- `tests/embedding.test.ts` (if exists)
- `tests/orchestrator.test.ts`
- `tests/auth.test.ts`

If any test fails because it expected the old hardcoded ASR priority, fix the test to use the new module_states-based dispatch.

- [ ] **Step 7: 提交**

```bash
git add src/main.ts src/models/capability-dispatcher.ts src/server/app.ts tests/module-integration.test.ts
git commit -m "feat(modules): integrate module_states into main.ts, dispatcher, health

- main.ts local-provider injection now gated by module_states.mode=local+status=running
- ASR capability-dispatcher removes hardcoded local-first priority, reads mode from DB
- /api/health reports status/mode for all 4 infrastructure modules

Downstream consumers (EmbeddingManager, capability-dispatcher) reload
via bumpConfigVersion when mode changes."
```

---

## Task 10: start.py 重写

**Files:**
- Modify: `start.py:655-737` (subprocess 启动逻辑)

**Interfaces:**
- Consumes: PostgreSQL `module_states` 表（通过 psycopg2 或 `psql` 子进程查询）
- Produces: 启动本地模块进程的 Python 实现

- [ ] **Step 1: 加 PostgreSQL 查询辅助函数**

Add near the top of `start.py` (after imports, around line 100):

```python
def query_module_states() -> dict[str, dict]:
    """Read module_states table to decide which local services to launch.

    Returns dict keyed by module_id with status/mode/weights_path/gpu_required.
    Single source of truth — replaces directory-scanning heuristics.
    """
    try:
        import psycopg2  # type: ignore
    except ImportError:
        # psycopg2 not available (e.g., in CI without python deps) — fall back to no services
        return {}

    pg_host = dotenv_vars.get("PG_HOST", "localhost")
    pg_port = dotenv_vars.get("PG_PORT", "5433")
    pg_db = dotenv_vars.get("PG_DATABASE", "deepanalyze_hub")
    pg_user = dotenv_vars.get("PG_USER", "deepanalyze_hub")
    pg_password = dotenv_vars.get("PG_PASSWORD", "")

    try:
        conn = psycopg2.connect(
            host=pg_host, port=pg_port, dbname=pg_db,
            user=pg_user, password=pg_password,
            connect_timeout=5,
        )
        cur = conn.cursor()
        cur.execute("""
            SELECT module_id, status, mode, weights_path, gpu_required, process_type
            FROM module_states
            WHERE status = 'running' AND mode = 'local'
        """)
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return {
            r[0]: {
                "status": r[1], "mode": r[2], "weights_path": r[3],
                "gpu_required": r[4], "process_type": r[5],
            }
            for r in rows
        }
    except Exception as exc:
        print(f"[start] warning: cannot query module_states: {exc}", flush=True)
        return {}
```

- [ ] **Step 2: 替换 embedding 启动逻辑**

Find the existing embedding launch block (lines ~654-695) and replace:

**Before** (existing):
```python
bge_model_dir = DATA_DIR / "models" / "bge-m3"
embedding_port = int(dotenv_vars.get("EMBEDDING_PORT", "11435"))
embedding_server_path = PROJECT_ROOT / "embedding_server.py"
if bge_model_dir.is_dir() and embedding_server_path.is_file():
    # ... launches subprocess
```

**After**:
```python
embedding_port = int(dotenv_vars.get("EMBEDDING_PORT", "11435"))
embedding_server_path = PROJECT_ROOT / "embedding_server.py"
module_states = query_module_states()
embedding_state = module_states.get("embedding")

if embedding_state and embedding_server_path.is_file():
    bge_model_dir = Path(embedding_state["weights_path"]) if embedding_state.get("weights_path") else (DATA_DIR / "models" / "bge-m3")
    if not bge_model_dir.is_absolute():
        bge_model_dir = PROJECT_ROOT / bge_model_dir
    print(f"[start] launching embedding service (module_states says running/local)", flush=True)
    _kill_port_user(embedding_port)
    embedding_proc = subprocess.Popen(
        [sys.executable, str(embedding_server_path),
         "--host", "127.0.0.1", "--port", str(embedding_port),
         "--model-path", str(bge_model_dir)],
        stdout=open(DATA_DIR / "logs" / "embedding.log", "a"),
        stderr=subprocess.STDOUT,
        env={**os.environ, "HF_ENDPOINT": os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")},
    )
    backend_env["EMBEDDING_PORT"] = str(embedding_port)
    # Wait for health (existing logic preserved)
    _wait_for_health(f"http://127.0.0.1:{embedding_port}/health", timeout=120, name="embedding")
else:
    print("[start] embedding module not in 'running/local' state — skipping", flush=True)
```

- [ ] **Step 3: 替换 whisper 启动逻辑**

Find the existing whisper block (lines ~697-737) and replace similarly:

**Before**:
```python
whisper_script = PROJECT_ROOT / "whisper-service" / "main.py"
if whisper_script.is_file():
    if subprocess.run([sys.executable, "-c", "import whisper"]).returncode == 0:
        # ... launches
```

**After**:
```python
whisper_script = PROJECT_ROOT / "whisper-service" / "main.py"
whisper_port = int(dotenv_vars.get("WHISPER_HTTP_PORT", "9877"))
asr_state = module_states.get("asr")

if asr_state and asr_state.get("status") == "running" and asr_state.get("mode") == "local" and whisper_script.is_file():
    if subprocess.run([sys.executable, "-c", "import whisper"]).returncode == 0:
        print(f"[start] launching whisper service (module_states says running/local)", flush=True)
        _kill_port_user(whisper_port)
        whisper_http_proc = subprocess.Popen(
            [sys.executable, str(whisper_script), "--http", "--host", "127.0.0.1", "--port", str(whisper_port)],
            stdout=open(DATA_DIR / "logs" / "whisper.log", "a"),
            stderr=subprocess.STDOUT,
        )
        backend_env["WHISPER_HTTP_PORT"] = str(whisper_port)
        _wait_for_health(f"http://127.0.0.1:{whisper_port}/health", timeout=120, name="whisper")
    else:
        print("[start] whisper module enabled but `whisper` Python package not installed", flush=True)
else:
    print("[start] asr module not in 'running/local' state — skipping whisper", flush=True)
```

- [ ] **Step 4: 加 _wait_for_health 辅助函数（如不存在）**

If `_wait_for_health` doesn't already exist, add near `_kill_port_user`:

```python
def _wait_for_health(url: str, timeout: int = 120, name: str = "service") -> bool:
    """Poll a /health endpoint until it returns 200 or timeout."""
    import time
    import urllib.request
    import urllib.error

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    print(f"[start] {name} healthy at {url}", flush=True)
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(2)
    print(f"[start] warning: {name} did not become healthy within {timeout}s", flush=True)
    return False
```

- [ ] **Step 5: 手动验证**

This step is a manual smoke test. With a running PG + applied migration:

```bash
# Insert a row saying embedding is running/local
psql -h localhost -U deepanalyze_hub -d deepanalyze_hub -c "
INSERT INTO module_states (module_id, status, mode, weights_path, gpu_required, process_type)
VALUES ('embedding', 'running', 'local', 'data/models/bge-m3', false, 'subprocess')
ON CONFLICT (module_id) DO UPDATE SET status='running', mode='local';
"

# Start — embedding service should launch
python3 start.py --no-docker --skip-frontend --port 21000 &
# Verify embedding_server.py is running
ps aux | grep embedding_server
curl http://127.0.0.1:11435/health
# Stop
kill %1

# Now mark embedding as 'installed' (not running)
psql ... -c "UPDATE module_states SET status='installed' WHERE module_id='embedding';"
# Restart — embedding should NOT launch
python3 start.py --no-docker --skip-frontend --port 21000 &
ps aux | grep embedding_server  # should be empty
```

Expected: service launches only when `status='running' AND mode='local'`.

- [ ] **Step 6: 提交**

```bash
git add start.py
git commit -m "fix(startup): start.py reads module_states for service launch

Replaces directory-existence heuristics with module_states table query.
Services launch only when status='running' AND mode='local'. Aligns
Python startup with the single-source-of-truth principle established
in the unified module deployment design."
```

---

## 验证清单（Part 1 完成标志）

完成所有 10 个任务后，验证：

1. ✅ `module_states` 表存在，CRUD 工作（Task 1）
2. ✅ `detectGpu()` 在有/无 NVIDIA 时正确分类（Task 2）
3. ✅ `installModule`/`uninstallModule` 流程通过测试（Task 3）
4. ✅ `model-supervisor.ts` 不再引用不存在的 Python 脚本路径（Task 4）
5. ✅ `glm-ocr-service` Docker 镜像可构建（Task 5）
6. ✅ `mineru-service` Docker 镜像可构建（Task 6）
7. ✅ `DoclingRemoteClient` 能解析远端响应（Task 7）
8. ✅ `curl http://localhost:21000/api/modules` 返回模块状态 JSON（Task 8）
9. ✅ `curl http://localhost:21000/api/health` 报告 5 类模块状态（Task 9）
10. ✅ `python3 start.py` 行为符合 module_states 表（Task 10）
11. ✅ 所有现有测试 (`bun test`) 仍通过
12. ✅ `tests/e2e/` 不需修改（向后兼容）

---

## 后续衔接

**Part 2 (Frontend + Packaging)** 覆盖：
- Task 11: `ModuleCard` 共享 React 组件
- Task 12: 4-pill 状态栏 + ModelsPanel 集成
- Task 13: 重写 4 个配置组件（Embedding/ASR/Docling/MinerU）使用 ModuleCard
- Task 14: 全量包首次启动向导（极简/中等/完整 三档）
- Task 15: 打包发布（Dockerfile.personal-core/full）+ 现有用户迁移脚本

Part 2 计划文件：`docs/superpowers/plans/2026-07-04-unified-module-deployment-plan-part2-frontend-packaging.md`
