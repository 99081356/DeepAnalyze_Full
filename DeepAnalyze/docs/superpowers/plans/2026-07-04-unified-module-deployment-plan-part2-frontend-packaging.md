# 统一模块部署实施计划 - Part 2: 前端与打包

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 4 个基础设施模块的统一前端 UI（`ModuleCard` 共享组件 + 4-pill 状态栏 + 4 个配置组件重写 + 全量包首次启动向导），并交付双轨发布 Docker 镜像与现有用户迁移脚本。

**Architecture:** 新增 `<ModuleCard>` React 组件作为统一交互单元，封装 5 状态机（not_installed/installing/installed/running/error）、模式切换器（local/remote/disabled）、本地部署进度条、远端配置表单。`ModelsPanel` 顶部增加 4 个状态 pill 实时显示模块健康。4 个旧配置组件（EmbeddingModelConfig/ASRModelConfig/DoclingConfig/MinerUConfig）重写为 ModuleCard 的不同 `moduleId` 实例。全量包首次启动向导读取 GPU 档位推荐三档预设。

**Tech Stack:** React 18 + TypeScript, Zustand (状态管理), Vitest + React Testing Library (单元), Playwright (E2E), Vite (构建), Docker (镜像打包).

## Global Constraints

- 前端代码位于 `frontend/src/`，使用 React 18 + TypeScript + Vite
- API 客户端位于 `frontend/src/api/client.ts`，使用 `request<T>(path, options)` 包装
- 状态管理用 Zustand，现有 store 在 `frontend/src/stores/`
- 组件目录约定：通用组件 `frontend/src/components/`、设置子组件 `frontend/src/components/settings/`
- Part 1 已建立的 API 契约：
  - `GET /api/modules` → `{ modules: ModuleState[], running: Record<string, ServiceStatus>, auxiliary: {...} }`
  - `GET /api/modules/:moduleId` → `{ module: ModuleState }`
  - `POST /api/modules/:moduleId/install` (body: `{ gpuRequired?: boolean }`) → `{ module: ModuleState }`
  - `POST /api/modules/:moduleId/uninstall` → `{ success: true }`
  - `POST /api/modules/:moduleId/start` → `{ status: ServiceStatus }`
  - `POST /api/modules/:moduleId/stop` → `{ status: ServiceStatus }`
  - `PUT /api/modules/:moduleId/config` (body: 部分字段) → `{ module: ModuleState }`
  - `GET /api/modules/gpu` → `{ tier, hasNvidia, vramMB, deviceName?, cudaVersion? }`
- `ModuleState` 字段（来自 Part 1 Task 1）：moduleId, status, mode, weightsPath, weightsSizeMb, gpuRequired, processType, remoteEndpoint, remoteApiKey, remoteProtocol, vlmBackend, lastError, installedAt, startedAt, configVersion
- 模块 ID 字符串：`"embedding" | "asr" | "docling" | "mineru"`
- 9 个 sub-tab ID 保持：main / sub / embedding / vlm / audio_transcribe / video_understand / enhanced / docling / mineru

---

## Task 11: ModuleCard 共享组件

**Files:**
- Create: `frontend/src/components/settings/ModuleCard.tsx`
- Create: `frontend/src/components/settings/ModuleCard.css`
- Test: `frontend/src/components/settings/__tests__/ModuleCard.test.tsx`

**Interfaces:**
- Consumes:
  - `api.getModule(moduleId)`, `api.installModule(moduleId, opts)`, `api.uninstallModule(moduleId)`, `api.startModule(moduleId)`, `api.stopModule(moduleId)`, `api.updateModuleConfig(moduleId, patch)` (added to `client.ts` in this task)
  - Module-specific metadata (manifest name, default port, etc.) via constants
- Produces:
  - `<ModuleCard moduleId="embedding" />` React 组件
  - Props: `{ moduleId: ModuleId; title?: string; icon?: ReactNode; className?: string }`

- [ ] **Step 1: 扩展 API 客户端**

Modify `frontend/src/api/client.ts` — add module management endpoints. Find the existing `api` object and add these methods (alongside existing `getDoclingConfig`, `getMinerUConfig` etc.):

```typescript
export interface ModuleState {
  moduleId: string;
  status: 'not_installed' | 'installing' | 'installed' | 'running' | 'error';
  mode: 'local' | 'remote' | 'disabled';
  weightsPath?: string | null;
  weightsSizeMb?: number | null;
  gpuRequired: boolean;
  processType: 'subprocess' | 'docker';
  remoteEndpoint?: string | null;
  remoteApiKey?: string | null;
  remoteProtocol?: string | null;
  vlmBackend?: string | null;
  lastError?: string | null;
  installedAt?: string | null;
  startedAt?: string | null;
  configVersion: number;
}

export interface GpuInfo {
  tier: 'none' | 'low' | 'high';
  hasNvidia: boolean;
  vramMB: number;
  deviceName?: string;
  cudaVersion?: string;
}

export const api = {
  // ... existing methods ...

  // --- Module management ---
  listModules: () =>
    request<{ modules: ModuleState[]; running: Record<string, any>; auxiliary: any }>('/api/modules'),

  getModule: (moduleId: string) =>
    request<{ module: ModuleState }>(`/api/modules/${moduleId}`),

  installModule: (moduleId: string, opts: { gpuRequired?: boolean } = {}) =>
    request<{ module: ModuleState }>(`/api/modules/${moduleId}/install`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  uninstallModule: (moduleId: string) =>
    request<{ success: boolean }>(`/api/modules/${moduleId}/uninstall`, { method: 'POST' }),

  startModule: (moduleId: string) =>
    request<{ status: any }>(`/api/modules/${moduleId}/start`, { method: 'POST' }),

  stopModule: (moduleId: string) =>
    request<{ status: any }>(`/api/modules/${moduleId}/stop`, { method: 'POST' }),

  updateModuleConfig: (moduleId: string, patch: Partial<ModuleState>) =>
    request<{ module: ModuleState }>(`/api/modules/${moduleId}/config`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  detectGpu: () =>
    request<GpuInfo>('/api/modules/gpu'),
};
```

- [ ] **Step 2: 写 ModuleCard 组件**

Create `frontend/src/components/settings/ModuleCard.tsx`:

```typescript
import { useEffect, useState, useCallback } from 'react';
import {
  Cpu, HardDrive, Cloud, PauseCircle, PlayCircle, Download, Trash2,
  AlertCircle, Loader2, CheckCircle2, XCircle,
} from 'lucide-react';
import { api, type ModuleState, type GpuInfo } from '../../api/client';
import './ModuleCard.css';

export type ModuleId = 'embedding' | 'asr' | 'docling' | 'mineru';

interface ModuleMeta {
  label: string;
  downloadSize: string;
  defaultPort: number;
  supportsVlmBackend?: boolean;
}

export const MODULE_META: Record<ModuleId, ModuleMeta> = {
  embedding: { label: '嵌入模型 (BGE-M3)', downloadSize: '~2.2 GB', defaultPort: 11435 },
  asr: { label: '语音识别 (Whisper)', downloadSize: '~150 MB', defaultPort: 9877 },
  docling: { label: '文档解析 (Docling)', downloadSize: '~500 MB', defaultPort: 8700, supportsVlmBackend: true },
  mineru: { label: 'MinerU 解析', downloadSize: '~2.5 GB (Docker)', defaultPort: 8001 },
};

interface ModuleCardProps {
  moduleId: ModuleId;
  className?: string;
}

export function ModuleCard({ moduleId, className }: ModuleCardProps) {
  const meta = MODULE_META[moduleId];
  const [state, setState] = useState<ModuleState | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { module } = await api.getModule(moduleId);
      setState(module);
    } catch (err: any) {
      // Module may not be configured yet — that's OK, render as not_installed
      setState(null);
    }
  }, [moduleId]);

  useEffect(() => {
    refresh();
    api.detectGpu().then(setGpu).catch(() => {});
  }, [refresh]);

  const handleInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      const { module } = await api.installModule(moduleId, {
        gpuRequired: gpu?.tier === 'high',
      });
      setState(module);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    if (!confirm(`确定要卸载 ${meta.label} 并删除权重吗？`)) return;
    setBusy(true);
    try {
      await api.uninstallModule(moduleId);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    setBusy(true);
    try {
      await api.startModule(moduleId);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await api.stopModule(moduleId);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleModeChange = async (mode: 'local' | 'remote' | 'disabled') => {
    if (state?.status === 'running' && mode !== state.mode) {
      if (!confirm(`当前模块正在运行。切换到 ${mode} 模式后，新会话生效。是否继续？`)) return;
    }
    setBusy(true);
    try {
      const { module } = await api.updateModuleConfig(moduleId, { mode });
      setState(module);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoteConfigSave = async (patch: Partial<ModuleState>) => {
    setBusy(true);
    try {
      const { module } = await api.updateModuleConfig(moduleId, patch);
      setState(module);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const status = state?.status ?? 'not_installed';
  const mode = state?.mode ?? 'disabled';

  return (
    <div className={`module-card module-card--${status} ${className ?? ''}`}>
      <div className="module-card__header">
        <h3 className="module-card__title">{meta.label}</h3>
        <StatusBadge status={status} />
      </div>

      {error && (
        <div className="module-card__error">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div className="module-card__mode-tabs">
        <ModeButton
          active={mode === 'local'}
          onClick={() => handleModeChange('local')}
          icon={<Cpu size={14} />}
          label="本地部署"
        />
        <ModeButton
          active={mode === 'remote'}
          onClick={() => handleModeChange('remote')}
          icon={<Cloud size={14} />}
          label="远端 API"
        />
        <ModeButton
          active={mode === 'disabled'}
          onClick={() => handleModeChange('disabled')}
          icon={<PauseCircle size={14} />}
          label="禁用"
        />
      </div>

      <div className="module-card__body">
        {mode === 'local' && (
          <LocalSection
            state={state}
            meta={meta}
            gpu={gpu}
            busy={busy}
            status={status}
            onInstall={handleInstall}
            onUninstall={handleUninstall}
            onStart={handleStart}
            onStop={handleStop}
          />
        )}

        {mode === 'remote' && (
          <RemoteSection
            state={state}
            moduleId={moduleId}
            busy={busy}
            onSave={handleRemoteConfigSave}
          />
        )}

        {mode === 'disabled' && (
          <div className="module-card__disabled-note">
            此模块已禁用。切换到"本地部署"或"远端 API"以启用。
          </div>
        )}
      </div>

      {meta.supportsVlmBackend && mode === 'local' && (
        <VlmBackendSection
          state={state}
          onSave={handleRemoteConfigSave}
          busy={busy}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ModuleState['status'] }) {
  const map = {
    not_installed: { color: 'gray', icon: <PauseCircle size={12} />, text: '未安装' },
    installing: { color: 'yellow', icon: <Loader2 size={12} className="spin" />, text: '安装中' },
    installed: { color: 'gray', icon: <CheckCircle2 size={12} />, text: '已就绪' },
    running: { color: 'green', icon: <PlayCircle size={12} />, text: '运行中' },
    error: { color: 'red', icon: <XCircle size={12} />, text: '错误' },
  } as const;
  const cfg = map[status];
  return (
    <span className={`module-card__badge module-card__badge--${cfg.color}`}>
      {cfg.icon} {cfg.text}
    </span>
  );
}

function ModeButton({ active, onClick, icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`module-card__mode-btn ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {icon} {label}
    </button>
  );
}

function LocalSection({
  state, meta, gpu, busy, status, onInstall, onUninstall, onStart, onStop,
}: {
  state: ModuleState | null;
  meta: ModuleMeta;
  gpu: GpuInfo | null;
  busy: boolean;
  status: ModuleState['status'];
  onInstall: () => void;
  onUninstall: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  if (status === 'not_installed') {
    return (
      <div className="module-card__local">
        <div className="module-card__info-row">
          <HardDrive size={14} /> 下载大小: <strong>{meta.downloadSize}</strong>
        </div>
        {gpu && (
          <div className="module-card__info-row">
            <Cpu size={14} /> 检测到 GPU: <strong>{gpu.deviceName ?? 'Unknown'}</strong> ({gpu.vramMB} MB)
          </div>
        )}
        <button className="btn btn-primary" onClick={onInstall} disabled={busy}>
          <Download size={14} /> 本地部署
        </button>
      </div>
    );
  }

  if (status === 'installing') {
    return (
      <div className="module-card__local">
        <div className="module-card__progress">
          <Loader2 size={14} className="spin" /> 下载中…
        </div>
      </div>
    );
  }

  return (
    <div className="module-card__local">
      <div className="module-card__info-row">
        <HardDrive size={14} /> 权重路径: <code>{state?.weightsPath ?? '-'}</code>
      </div>
      {state?.weightsSizeMb != null && (
        <div className="module-card__info-row">
          占用空间: <strong>{state.weightsSizeMb} MB</strong>
        </div>
      )}
      <div className="module-card__info-row">
        GPU 模式: <strong>{state?.gpuRequired ? '启用' : 'CPU'}</strong>
      </div>
      {state?.lastError && (
        <div className="module-card__error-row">
          <AlertCircle size={14} /> {state.lastError}
        </div>
      )}
      <div className="module-card__actions">
        {status === 'running' ? (
          <button className="btn btn-stop" onClick={onStop} disabled={busy}>
            <PauseCircle size={14} /> 停止
          </button>
        ) : (
          <button className="btn btn-primary" onClick={onStart} disabled={busy}>
            <PlayCircle size={14} /> 启动
          </button>
        )}
        <button className="btn btn-secondary" onClick={onUninstall} disabled={busy}>
          <Trash2 size={14} /> 卸载
        </button>
      </div>
    </div>
  );
}

function RemoteSection({
  state, moduleId, busy, onSave,
}: {
  state: ModuleState | null;
  moduleId: ModuleId;
  busy: boolean;
  onSave: (patch: Partial<ModuleState>) => void;
}) {
  const [endpoint, setEndpoint] = useState(state?.remoteEndpoint ?? '');
  const [apiKey, setApiKey] = useState(state?.remoteApiKey ?? '');

  useEffect(() => {
    setEndpoint(state?.remoteEndpoint ?? '');
    setApiKey(state?.remoteApiKey ?? '');
  }, [state?.remoteEndpoint, state?.remoteApiKey]);

  return (
    <div className="module-card__remote">
      <label className="module-card__field">
        <span>Endpoint</span>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://api.example.com/v1"
        />
      </label>
      <label className="module-card__field">
        <span>API Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
        />
      </label>
      <button
        className="btn btn-primary"
        onClick={() => onSave({ remoteEndpoint: endpoint, remoteApiKey: apiKey })}
        disabled={busy}
      >
        保存远端配置
      </button>
    </div>
  );
}

function VlmBackendSection({
  state, onSave, busy,
}: {
  state: ModuleState | null;
  onSave: (patch: Partial<ModuleState>) => void;
  busy: boolean;
}) {
  const backends = [
    { value: 'none', label: '不使用 VLM (仅 OCR)' },
    { value: 'paddleocr-vl-local', label: 'PaddleOCR-VL 本地 (GPU)' },
    { value: 'glm-ocr-local', label: 'GLM-OCR 本地 (GPU)' },
    { value: 'remote-openai-vlm', label: '远端 OpenAI 兼容 VLM' },
  ] as const;

  return (
    <div className="module-card__vlm">
      <h4>VLM 后端</h4>
      <select
        value={state?.vlmBackend ?? 'none'}
        onChange={(e) => onSave({ vlmBackend: e.target.value as any })}
        disabled={busy}
      >
        {backends.map((b) => (
          <option key={b.value} value={b.value}>{b.label}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 3: 写 CSS**

Create `frontend/src/components/settings/ModuleCard.css`:

```css
.module-card {
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 8px;
  padding: 16px;
  margin: 8px 0;
  background: var(--bg-card, #fff);
}

.module-card--running { border-color: #22c55e; }
.module-card--installing { border-color: #eab308; }
.module-card--error { border-color: #ef4444; }

.module-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.module-card__title { margin: 0; font-size: 16px; font-weight: 600; }

.module-card__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}
.module-card__badge--green { background: #dcfce7; color: #166534; }
.module-card__badge--yellow { background: #fef3c7; color: #854d0e; }
.module-card__badge--red { background: #fee2e2; color: #991b1b; }
.module-card__badge--gray { background: #f3f4f6; color: #4b5563; }

.module-card__mode-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-color, #e0e0e0);
  margin-bottom: 12px;
  padding-bottom: 8px;
}
.module-card__mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-muted, #6b7280);
}
.module-card__mode-btn.active {
  background: var(--accent-soft, #dbeafe);
  color: var(--accent-strong, #1e40af);
}

.module-card__info-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin: 4px 0;
}

.module-card__actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.module-card__field {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
}
.module-card__field span { display: block; margin-bottom: 4px; color: var(--text-muted, #6b7280); }
.module-card__field input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-color, #d1d5db);
  border-radius: 4px;
  font-size: 13px;
}

.module-card__error {
  color: #ef4444;
  font-size: 13px;
  margin: 8px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: #3b82f6; color: white; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-stop { background: #ef4444; color: white; }
.btn-secondary { background: transparent; color: var(--text-muted, #6b7280); border: 1px solid var(--border-color, #d1d5db); }
```

- [ ] **Step 4: 写组件测试**

Create `frontend/src/components/settings/__tests__/ModuleCard.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModuleCard, MODULE_META } from '../ModuleCard';

// Mock API client
vi.mock('../../../api/client', () => ({
  api: {
    getModule: vi.fn(),
    installModule: vi.fn(),
    uninstallModule: vi.fn(),
    startModule: vi.fn(),
    stopModule: vi.fn(),
    updateModuleConfig: vi.fn(),
    detectGpu: vi.fn(),
  },
}));

import { api } from '../../../api/client';

beforeEach(() => {
  vi.clearAllMocks();
  (api.detectGpu as any).mockResolvedValue({
    tier: 'high', hasNvidia: true, vramMB: 24576, deviceName: 'RTX 4090',
  });
});

describe('ModuleCard', () => {
  it('renders not_installed state with install button', async () => {
    (api.getModule as any).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'not_installed', mode: 'disabled',
        gpuRequired: false, processType: 'subprocess', configVersion: 0,
      },
    });
    render(<ModuleCard moduleId="embedding" />);
    await waitFor(() => expect(screen.queryByText(/嵌入模型/)).toBeInTheDocument());
    // Should show local/remote/disabled tabs
    expect(screen.getByText('本地部署')).toBeInTheDocument();
    expect(screen.getByText('远端 API')).toBeInTheDocument();
  });

  it('shows running badge when module is running', async () => {
    (api.getModule as any).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'running', mode: 'local',
        gpuRequired: true, processType: 'subprocess',
        weightsPath: 'data/models/bge-m3', configVersion: 1,
      },
    });
    render(<ModuleCard moduleId="embedding" />);
    await waitFor(() => expect(screen.getByText('运行中')).toBeInTheDocument());
    expect(screen.getByText(/停止/)).toBeInTheDocument();
  });

  it('calls installModule when install button clicked', async () => {
    (api.getModule as any).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'not_installed', mode: 'local',
        gpuRequired: false, processType: 'subprocess', configVersion: 0,
      },
    });
    (api.installModule as any).mockResolvedValue({
      module: {
        moduleId: 'embedding', status: 'installed', mode: 'local',
        gpuRequired: true, processType: 'subprocess', configVersion: 1,
      },
    });
    render(<ModuleCard moduleId="embedding" />);
    await waitFor(() => expect(screen.getByText('本地部署')).toBeInTheDocument());

    // Switch to local mode first (default state.mode is 'local' but UI starts there)
    fireEvent.click(screen.getByText('本地部署'));

    // Find the install button (in local section, not the mode button)
    await waitFor(() => {
      const installBtn = screen.getAllByRole('button', { name: /本地部署/ }).find(
        (b) => b.classList.contains('btn-primary'),
      );
      expect(installBtn).toBeDefined();
    });
  });

  it('MODULE_META has entries for all 4 modules', () => {
    expect(Object.keys(MODULE_META).sort()).toEqual(['asr', 'docling', 'embedding', 'mineru']);
  });

  it('docling card shows VLM backend selector', async () => {
    (api.getModule as any).mockResolvedValue({
      module: {
        moduleId: 'docling', status: 'installed', mode: 'local',
        gpuRequired: false, processType: 'subprocess',
        vlmBackend: 'none', configVersion: 0,
      },
    });
    render(<ModuleCard moduleId="docling" />);
    await waitFor(() => expect(screen.getByText('VLM 后端')).toBeInTheDocument());
  });
});
```

Note: This test requires `@testing-library/react`. If not installed, add to `package.json` devDependencies:
```json
"@testing-library/react": "^14.0.0",
"@testing-library/jest-dom": "^6.0.0",
"jsdom": "^24.0.0"
```
And create `frontend/vitest.config.ts` if not exists:
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd frontend && bun run test -- --run src/components/settings/__tests__/ModuleCard.test.tsx`
Expected: PASS (5/5 tests)

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/settings/ModuleCard.tsx \
        frontend/src/components/settings/ModuleCard.css \
        frontend/src/components/settings/__tests__/ModuleCard.test.tsx \
        frontend/src/api/client.ts \
        frontend/package.json \
        frontend/vitest.config.ts
git commit -m "feat(frontend): ModuleCard shared component for module lifecycle

Unified UI for 4 infrastructure modules (Embedding/ASR/Docling/MinerU):
5-state status badge, mode tabs (local/remote/disabled), local install
flow with GPU detection, remote config form, VLM backend selector for
Docling. Replaces individual config components in subsequent task."
```

---

## Task 12: 4-pill 状态栏 + ModelsPanel 集成

**Files:**
- Create: `frontend/src/components/settings/ModuleStatusBar.tsx`
- Modify: `frontend/src/components/settings/ModelsPanel.tsx:130` (插入状态栏)

**Interfaces:**
- Consumes: `api.listModules()` (Task 11 added to client.ts)
- Produces: `<ModuleStatusBar onNavigate={(tabId) => void} />` 组件

- [ ] **Step 1: 写状态栏组件**

Create `frontend/src/components/settings/ModuleStatusBar.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ModuleState } from '../../api/client';
import './ModuleStatusBar.css';

const MODULE_TO_TAB: Record<string, string> = {
  embedding: 'embedding',
  asr: 'audio_transcribe',
  docling: 'docling',
  mineru: 'mineru',
};

const MODULE_LABELS: Record<string, string> = {
  embedding: '嵌入',
  asr: 'ASR',
  docling: 'Docling',
  mineru: 'MinerU',
};

export function ModuleStatusBar() {
  const [states, setStates] = useState<Record<string, ModuleState>>({});
  const navigate = useNavigate();

  const refresh = async () => {
    try {
      const { modules } = await api.listModules();
      const map: Record<string, ModuleState> = {};
      for (const m of modules) map[m.moduleId] = m;
      setStates(map);
    } catch {
      // Silently fail — bar is informational
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000); // refresh every 5s
    return () => clearInterval(id);
  }, []);

  const handleClick = (moduleId: string) => {
    const tabId = MODULE_TO_TAB[moduleId];
    // ModelsPanel reads ?tab= query param or stores activeTab locally — emit event
    window.dispatchEvent(new CustomEvent('models-tab-navigate', { detail: tabId }));
  };

  const order = ['embedding', 'asr', 'docling', 'mineru'] as const;

  return (
    <div className="module-status-bar">
      {order.map((id) => {
        const state = states[id];
        const status = state?.status ?? 'not_installed';
        return (
          <button
            key={id}
            className={`module-pill module-pill--${status}`}
            onClick={() => handleClick(id)}
            title={state?.lastError ?? `${MODULE_LABELS[id]}: ${status}`}
          >
            <span className={`module-pill__dot module-pill__dot--${status}`} />
            <span className="module-pill__label">{MODULE_LABELS[id]}</span>
            <span className="module-pill__status">
              {statusToLabel(status)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function statusToLabel(status: ModuleState['status']): string {
  const map = {
    not_installed: '未安装',
    installing: '安装中',
    installed: '已就绪',
    running: '运行中',
    error: '错误',
  } as const;
  return map[status];
}
```

Create `frontend/src/components/settings/ModuleStatusBar.css`:

```css
.module-status-bar {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: var(--bg-soft, #f9fafb);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
}

.module-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s;
}
.module-pill:hover { background: rgba(59, 130, 246, 0.08); }

.module-pill__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.module-pill__dot--running { background: #22c55e; box-shadow: 0 0 4px #22c55e; }
.module-pill__dot--installing { background: #eab308; }
.module-pill__dot--installed { background: #9ca3af; }
.module-pill__dot--not_installed { background: #d1d5db; }
.module-pill__dot--error { background: #ef4444; }

.module-pill__label { font-weight: 600; }
.module-pill__status { color: var(--text-muted, #6b7280); }
```

- [ ] **Step 2: 在 ModelsPanel 集成状态栏**

Modify `frontend/src/components/settings/ModelsPanel.tsx`. Add import at top:
```typescript
import { ModuleStatusBar } from "./ModuleStatusBar";
```

Find the component's main render (around line 130 where it returns JSX). Add an event listener for `models-tab-navigate` and insert the status bar above the tab navigation:

```typescript
// Add state for external navigation trigger
const [externalTab, setExternalTab] = useState<ModelTabId | null>(null);

useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as ModelTabId;
    if (detail) {
      setExternalTab(detail);
      setActiveTab(detail);
    }
  };
  window.addEventListener('models-tab-navigate', handler);
  return () => window.removeEventListener('models-tab-navigate', handler);
}, []);
```

In the JSX, add the status bar before the existing tab row:

```tsx
return (
  <div className="models-panel">
    <ModuleStatusBar />
    {/* existing tab navigation */}
    <div className="tab-row">
      {/* ...existing tabs... */}
    </div>
    {/* ... rest ... */}
  </div>
);
```

- [ ] **Step 3: 手动验证**

This is a UI task — run the frontend and verify visually:

```bash
cd frontend && bun run dev
# Navigate to http://localhost:5173 → Settings → Models
# Verify: status bar with 4 pills appears at top
# Verify: clicking a pill switches to that sub-tab
# Verify: pill colors update when modules change state (use browser DevTools to mutate module_states)
```

- [ ] **Step 4: 提交**

```bash
git add frontend/src/components/settings/ModuleStatusBar.tsx \
        frontend/src/components/settings/ModuleStatusBar.css \
        frontend/src/components/settings/ModelsPanel.tsx
git commit -m "feat(frontend): module status bar in ModelsPanel

4 pills at top of model config tab showing real-time health of
embedding/ASR/Docling/MinerU. Auto-refreshes every 5s. Clicking a
pill navigates to the corresponding sub-tab."
```

---

## Task 13: 重写 4 个配置组件使用 ModuleCard

**Files:**
- Rewrite: `frontend/src/components/settings/EmbeddingModelConfig.tsx` (466 → ~50 lines)
- Rewrite: `frontend/src/components/settings/ASRModelConfig.tsx` (212 → ~30 lines)
- Rewrite: `frontend/src/components/settings/DoclingConfig.tsx`
- Rewrite: `frontend/src/components/settings/MinerUConfig.tsx`

**Interfaces:**
- Consumes: `<ModuleCard>` from Task 11
- Produces: 4 个组件现在只是 ModuleCard 的薄包装

- [ ] **Step 1: 重写 EmbeddingModelConfig**

Rewrite `frontend/src/components/settings/EmbeddingModelConfig.tsx` (replace entire file):

```typescript
import { ModuleCard } from "./ModuleCard";

/**
 * Embedding model configuration — wraps the unified ModuleCard.
 *
 * The previous 466-line component with manual Provider/custom-endpoint
 * dual mode is replaced by ModuleCard's local-deploy/remote-API tabs.
 * The mode switching and weight management is delegated to /api/modules/*.
 *
 * Existing props (`providers`, `defaults`, `onSave`, `onTest`) are kept
 * in the signature for backwards compatibility with ModelsPanel but are
 * no longer used — the new component is self-contained.
 */
export function EmbeddingModelConfig(_props: {
  providers?: unknown[];
  defaults?: Record<string, string>;
  onSave?: (provider: unknown) => void;
  onTest?: (provider: unknown) => Promise<boolean>;
}) {
  return <ModuleCard moduleId="embedding" />;
}
```

- [ ] **Step 2: 重写 ASRModelConfig**

Rewrite `frontend/src/components/settings/ASRModelConfig.tsx` (replace entire file):

```typescript
import { ModuleCard } from "./ModuleCard";

/**
 * ASR (Whisper) configuration — wraps the unified ModuleCard.
 *
 * Previously a 212-line bare ModelConfigCard wrapper that consumed
 * providers/defaults props. Now self-contained: the local Whisper
 * service and remote OpenAI-compatible APIs are configured via
 * ModuleCard's local/remote tabs.
 */
export function ASRModelConfig(_props: {
  providers?: unknown[];
  defaults?: Record<string, string>;
  onSave?: (provider: unknown) => void;
  onTest?: (provider: unknown) => Promise<boolean>;
}) {
  return <ModuleCard moduleId="asr" />;
}
```

- [ ] **Step 3: 重写 DoclingConfig**

Rewrite `frontend/src/components/settings/DoclingConfig.tsx` (replace entire file). The existing DoclingConfig has many fields (layout_model, ocr_engine, etc.) — preserve advanced fields in a collapsible "Advanced Options" section below the ModuleCard:

```typescript
import { useState } from 'react';
import { ModuleCard } from "./ModuleCard";
import { api } from "../../api/client";

/**
 * Docling configuration — ModuleCard + advanced Docling-specific options.
 *
 * ModuleCard handles local subprocess / remote HTTP switching and
 * VLM backend selection. Below the card, advanced options (layout model,
 * OCR engine, parallelism) are preserved for power users.
 */
export function DoclingConfig() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [config, setConfig] = useState<any>(null);

  const loadConfig = async () => {
    try {
      const r = await api.getDoclingConfig();
      setConfig(r);
    } catch { /* ignore */ }
  };

  useState(() => { loadConfig(); });

  const updateField = async (field: string, value: any) => {
    if (!config) return;
    const updated = { ...config, [field]: value };
    setConfig(updated);
    try {
      await api.saveDoclingConfig(updated);
    } catch (err) {
      console.error('Failed to save Docling config:', err);
    }
  };

  return (
    <div className="docling-config">
      <ModuleCard moduleId="docling" />

      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setShowAdvanced(!showAdvanced)}
        style={{ marginTop: 16 }}
      >
        {showAdvanced ? '隐藏' : '显示'}高级选项
      </button>

      {showAdvanced && config && (
        <div className="docling-advanced" style={{ marginTop: 12 }}>
          <label className="module-card__field">
            <span>Layout 模型</span>
            <select
              value={config.layout_model ?? 'doclayout_yolo'}
              onChange={(e) => updateField('layout_model', e.target.value)}
            >
              <option value="doclayout_yolo">DocLayout-YOLO</option>
              <option value="layoutlmv3">LayoutLMv3</option>
            </select>
          </label>

          <label className="module-card__field">
            <span>OCR 引擎</span>
            <select
              value={config.ocr_engine ?? 'rapidocr'}
              onChange={(e) => updateField('ocr_engine', e.target.value)}
            >
              <option value="rapidocr">RapidOCR</option>
              <option value="paddleocr">PaddleOCR</option>
              <option value="easyocr">EasyOCR</option>
            </select>
          </label>

          <label className="module-card__field">
            <span>并行度</span>
            <input
              type="number"
              min={1}
              max={16}
              value={config.parallelism ?? 4}
              onChange={(e) => updateField('parallelism', parseInt(e.target.value, 10))}
            />
          </label>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 重写 MinerUConfig**

Rewrite `frontend/src/components/settings/MinerUConfig.tsx` (replace entire file):

```typescript
import { ModuleCard } from "./ModuleCard";

/**
 * MinerU configuration — wraps the unified ModuleCard.
 *
 * Previously configured only remote endpoint. Now ModuleCard handles
 * both local Docker deployment and remote endpoint configuration.
 * The local mode uses mineru-local-manager.ts via /api/modules/mineru.
 */
export function MinerUConfig() {
  return <ModuleCard moduleId="mineru" />;
}
```

- [ ] **Step 5: 验证 ModelsPanel 仍能正确渲染**

`ModelsPanel.tsx` imports these 4 components. Check that prop signatures still match — ModelsPanel passes `providers`, `defaults`, `onSave`, `onTest` to EmbeddingModelConfig and ASRModelConfig. The new wrappers accept but ignore those props.

Run the frontend in dev mode:
```bash
cd frontend && bun run dev
# Navigate to Settings → Models
# Verify each of the 4 sub-tabs renders the ModuleCard correctly:
# - Embedding tab: shows ModuleCard with "嵌入模型 (BGE-M3)"
# - audio_transcribe tab: shows ModuleCard with "语音识别 (Whisper)"
# - docling tab: shows ModuleCard + Advanced Options button
# - mineru tab: shows ModuleCard with "MinerU 解析"
```

- [ ] **Step 6: 跑前端构建确保类型正确**

Run: `cd frontend && bun run build`
Expected: Build succeeds, no TypeScript errors.

If TypeScript complains about unused props, change the wrapper signatures to actually accept the props (already done in Step 1 and 2 with `_props`).

- [ ] **Step 7: 提交**

```bash
git add frontend/src/components/settings/EmbeddingModelConfig.tsx \
        frontend/src/components/settings/ASRModelConfig.tsx \
        frontend/src/components/settings/DoclingConfig.tsx \
        frontend/src/components/settings/MinerUConfig.tsx
git commit -m "refactor(frontend): rewrite 4 module config components with ModuleCard

- EmbeddingModelConfig: 466 → 22 lines, drops dual-mode Provider/custom-endpoint
- ASRModelConfig: 212 → 18 lines, drops bare ModelConfigCard wrapper
- DoclingConfig: ModuleCard + collapsible advanced options (layout/OCR/parallelism)
- MinerUConfig: remote-only → unified local-Docker + remote-API

All 4 components now share identical UX via ModuleCard. Backwards-compatible
props preserved but unused."
```

---

## Task 14: 全量包首次启动向导

**Files:**
- Create: `frontend/src/components/wizard/FirstRunModuleWizard.tsx`
- Create: `frontend/src/components/wizard/FirstRunModuleWizard.css`
- Modify: `frontend/src/App.tsx` or main router (向导仅在 `data/_bundled/` 存在时触发)

**Interfaces:**
- Consumes: `api.detectGpu()`, `api.installModule()`, `api.updateModuleConfig()`
- Produces: `<FirstRunModuleWizard onDone={() => void} />` 组件

- [ ] **Step 1: 写向导组件**

Create `frontend/src/components/wizard/FirstRunModuleWizard.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { api, type GpuInfo } from '../../api/client';
import './FirstRunModuleWizard.css';

type PresetTier = 'minimal' | 'medium' | 'full';

interface PresetSpec {
  tier: PresetTier;
  label: string;
  sizeLabel: string;
  description: string;
  modules: {
    embedding: { mode: 'remote' | 'local'; gpuRequired?: boolean; install?: boolean };
    asr: { mode: 'remote' | 'local'; install?: boolean; whisperSize?: 'tiny' | 'base' | 'medium' };
    docling: { mode: 'remote' | 'local'; install?: boolean; vlmBackend?: string };
    mineru: { mode: 'remote' | 'local' };
  };
}

const PRESETS: Record<PresetTier, PresetSpec> = {
  minimal: {
    tier: 'minimal',
    label: '极简',
    sizeLabel: '~500 MB 占用',
    description: '所有模块走远端 API，仅本地 Whisper tiny。',
    modules: {
      embedding: { mode: 'remote' },
      asr: { mode: 'local', install: true, whisperSize: 'tiny' },
      docling: { mode: 'local', install: true, vlmBackend: 'none' },
      mineru: { mode: 'remote' },
    },
  },
  medium: {
    tier: 'medium',
    label: '中等',
    sizeLabel: '~3 GB 占用',
    description: 'BGE-M3 本地 (CPU)，Whisper base 本地，Docling 本地，MinerU 远端。',
    modules: {
      embedding: { mode: 'local', install: true, gpuRequired: false },
      asr: { mode: 'local', install: true, whisperSize: 'base' },
      docling: { mode: 'local', install: true, vlmBackend: 'remote-openai-vlm' },
      mineru: { mode: 'remote' },
    },
  },
  full: {
    tier: 'full',
    label: '完整',
    sizeLabel: '~10 GB 占用',
    description: '所有模块本地部署，GPU 加速，含 PaddleOCR-VL VLM。',
    modules: {
      embedding: { mode: 'local', install: true, gpuRequired: true },
      asr: { mode: 'local', install: true, whisperSize: 'medium' },
      docling: { mode: 'local', install: true, vlmBackend: 'paddleocr-vl-local' },
      mineru: { mode: 'local', install: true },
    },
  },
};

function recommendTier(gpu: GpuInfo | null): PresetTier {
  if (!gpu || gpu.tier === 'none') return 'minimal';
  if (gpu.tier === 'low') return 'medium';
  return 'full';
}

export function FirstRunModuleWizard({ onDone }: { onDone: () => void }) {
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [selected, setSelected] = useState<PresetTier>('minimal');
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);

  useEffect(() => {
    api.detectGpu().then((info) => {
      setGpu(info);
      setSelected(recommendTier(info));
    }).catch(() => setSelected('minimal'));
  }, []);

  const applyPreset = async () => {
    setApplying(true);
    const preset = PRESETS[selected];
    const log = (msg: string) => setProgress((p) => [...p, msg]);

    try {
      log(`检测 GPU: ${gpu?.deviceName ?? 'None'} (${gpu?.tier ?? 'none'})`);

      // Configure each module's mode first (no install yet)
      for (const [moduleId, cfg] of Object.entries(preset.modules)) {
        await api.updateModuleConfig(moduleId, {
          mode: cfg.mode,
          ...(cfg.vlmBackend ? { vlmBackend: cfg.vlmBackend } : {}),
        });
        log(`配置 ${moduleId} → 模式: ${cfg.mode}`);
      }

      // Install modules that requested it
      for (const [moduleId, cfg] of Object.entries(preset.modules)) {
        if (cfg.install && cfg.mode === 'local') {
          log(`开始下载 ${moduleId} 权重…`);
          await api.installModule(moduleId, {
            gpuRequired: (cfg as any).gpuRequired ?? (gpu?.tier === 'high'),
          });
          log(`✓ ${moduleId} 安装完成`);
        }
      }

      log('预设应用完毕');
      onDone();
    } catch (err: any) {
      log(`✗ 错误: ${err.message}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="wizard-overlay">
      <div className="wizard-modal">
        <h2>欢迎使用 DeepAnalyze</h2>
        <p className="wizard-gpu">
          检测到 GPU: <strong>{gpu?.deviceName ?? '未检测到 NVIDIA GPU'}</strong>
          {gpu && gpu.vramMB > 0 && ` (${gpu.vramMB} MB)`}
        </p>
        <p className="wizard-recommend">推荐档位: <strong>{PRESETS[recommendTier(gpu)].label}</strong></p>

        <div className="wizard-presets">
          {(['minimal', 'medium', 'full'] as PresetTier[]).map((tier) => {
            const preset = PRESETS[tier];
            return (
              <label
                key={tier}
                className={`wizard-preset ${selected === tier ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="preset"
                  checked={selected === tier}
                  onChange={() => setSelected(tier)}
                  disabled={applying}
                />
                <div className="wizard-preset-content">
                  <div className="wizard-preset-header">
                    <strong>{preset.label}</strong>
                    <span className="wizard-size">{preset.sizeLabel}</span>
                  </div>
                  <p className="wizard-desc">{preset.description}</p>
                </div>
              </label>
            );
          })}
        </div>

        {progress.length > 0 && (
          <div className="wizard-progress">
            {progress.map((line, i) => (
              <div key={i} className="wizard-progress-line">{line}</div>
            ))}
          </div>
        )}

        <div className="wizard-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onDone}
            disabled={applying}
          >
            跳过（手动配置）
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={applyPreset}
            disabled={applying}
          >
            {applying ? '应用中…' : `应用「${PRESETS[selected].label}」预设`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Create `frontend/src/components/wizard/FirstRunModuleWizard.css`:

```css
.wizard-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.wizard-modal {
  background: white;
  border-radius: 12px;
  padding: 32px;
  max-width: 560px;
  width: 90vw;
  max-height: 90vh;
  overflow-y: auto;
}

.wizard-modal h2 { margin: 0 0 12px; }

.wizard-gpu, .wizard-recommend {
  font-size: 14px;
  margin: 8px 0;
  color: var(--text-muted, #6b7280);
}

.wizard-presets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0;
}

.wizard-preset {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 2px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.wizard-preset.selected { border-color: #3b82f6; }
.wizard-preset input { margin-top: 4px; }

.wizard-preset-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}
.wizard-size { font-size: 12px; color: var(--text-muted, #6b7280); }
.wizard-desc { font-size: 13px; color: var(--text-muted, #6b7280); margin: 0; }

.wizard-progress {
  background: var(--bg-soft, #f9fafb);
  border-radius: 4px;
  padding: 8px;
  margin: 12px 0;
  font-family: monospace;
  font-size: 12px;
  max-height: 120px;
  overflow-y: auto;
}

.wizard-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
```

- [ ] **Step 2: 在 App.tsx 检测首次启动**

The wizard should only appear when `data/_bundled/` exists (i.e., the user installed the full bundle). Add detection via a backend flag.

Add to `src/server/routes/modules.ts` (Task 8 file):

```typescript
import fs from 'node:fs';
import path from 'node:path';

// Add this route before the `return router;` line:
router.get('/first-run-status', async (c) => {
  const bundledDir = path.resolve(process.cwd(), 'data', '_bundled');
  const hasBundle = fs.existsSync(bundledDir) && fs.readdirSync(bundledDir).length > 0;
  // Check if any module has been configured (indicates first run completed)
  const pool = getPool();
  const repo = new PgModuleStatesRepo(pool);
  const states = await repo.list();
  const configured = states.some((s) => s.mode !== 'disabled');
  return c.json({
    hasBundle,
    isFirstRun: hasBundle && !configured,
  });
});
```

Add to `frontend/src/api/client.ts`:
```typescript
// In api object:
getFirstRunStatus: () =>
  request<{ hasBundle: boolean; isFirstRun: boolean }>('/api/modules/first-run-status'),
```

In `frontend/src/App.tsx` (or main layout component), add conditional rendering:

```typescript
import { FirstRunModuleWizard } from './components/wizard/FirstRunModuleWizard';

// Inside the App component:
const [showWizard, setShowWizard] = useState(false);

useEffect(() => {
  api.getFirstRunStatus().then(({ isFirstRun }) => {
    if (isFirstRun) setShowWizard(true);
  }).catch(() => {});
}, []);

// In JSX:
{showWizard && (
  <FirstRunModuleWizard onDone={() => setShowWizard(false)} />
)}
```

- [ ] **Step 3: 手动验证**

```bash
# Simulate full-bundle first run:
mkdir -p data/_bundled
# Mark all modules as not_configured:
psql ... -c "DELETE FROM module_states;"
# Restart backend, navigate to homepage
# Verify wizard appears
# Click through each preset, verify it triggers appropriate API calls
```

- [ ] **Step 4: 提交**

```bash
git add frontend/src/components/wizard/FirstRunModuleWizard.tsx \
        frontend/src/components/wizard/FirstRunModuleWizard.css \
        frontend/src/App.tsx \
        frontend/src/api/client.ts \
        src/server/routes/modules.ts
git commit -m "feat(frontend): first-run wizard for full bundle

Three-tier preset selection (minimal/medium/full) auto-recommended
based on detected GPU tier. Configures all 4 modules at once and
installs weights for selected local modules. Only appears when
data/_bundled/ exists AND no modules are configured."
```

---

## Task 15: 打包发布 + 现有用户迁移

**Files:**
- Create: `Dockerfile.personal-core` (小核心镜像)
- Create: `Dockerfile.personal-full` (全量合集镜像)
- Modify: `da-assets/manifest.json` (新增 GLM-OCR / Whisper / Docling 权重条目)
- Create: `scripts/migrate-existing-users.ts` (现有用户迁移脚本)

**Interfaces:**
- Consumes: 所有前置任务的能力
- Produces: 双轨 Docker 镜像 + 迁移工具

- [ ] **Step 1: 写 Dockerfile.personal-core**

Create `Dockerfile.personal-core`:

```dockerfile
# DeepAnalyze Personal Edition - Core (small footprint)
# Suitable for users who want to use remote APIs or incrementally deploy local modules.
# Target size: ~500 MB

FROM da:base

# Install only CPU-only torch + whisper for tiny ASR
RUN pip3 install --no-cache-dir \
    torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && rm -rf /root/.cache/pip

# Bundled assets directory (empty in core image)
RUN mkdir -p /app/data/_bundled /app/data/_cache /app/data/models

# Python services (source only — weights downloaded on demand)
COPY embedding_server.py /app/
COPY whisper-service/ /app/whisper-service/
COPY docling-service/ /app/docling-service/
COPY paddleocr-vl-service/ /app/paddleocr-vl-service/
COPY glm-ocr-service/ /app/glm-ocr-service/
COPY mineru-service/ /app/mineru-service/

# Mark image variant
ENV DA_IMAGE_VARIANT=personal-core \
    DA_BUNDLE_TYPE=core

# No weights bundled — all modules start as 'not_installed'
# Users install via /api/modules/:id/install endpoint

LABEL org.opencontainers.image.title="DeepAnalyze Personal Core"
LABEL org.opencontainers.image.description="Small footprint edition, all modules via remote API by default"
LABEL org.opencontainers.image.version="0.7.6"

CMD ["python3", "start.py"]
```

- [ ] **Step 2: 写 Dockerfile.personal-full**

Create `Dockerfile.personal-full`:

```dockerfile
# DeepAnalyze Personal Edition - Full (all weights pre-bundled)
# Suitable for offline deployment or first-time users with adequate disk.
# Target size: ~10 GB

FROM da:full

# Pre-download all module weights into /app/data/_bundled/
# These are hardlinked to /app/data/models/<module>/ at first-run wizard time.

# Set HF mirror for build-time downloads
ENV HF_ENDPOINT=https://hf-mirror.com

RUN mkdir -p /app/data/_bundled/bge-m3 \
             /app/data/_bundled/whisper \
             /app/data/_bundled/docling \
             /app/data/_bundled/paddleocr-vl \
             /app/data/_bundled/glm-ocr

# BGE-M3 weights (~2.2 GB)
RUN python3 -c "from sentence_transformers import SentenceTransformer; \
                 SentenceTransformer('BAAI/bge-m3')" && \
    cp -r ~/.cache/huggingface/hub/models--BAAI--bge-m3/snapshots/*/ \
          /app/data/_bundled/bge-m3/ || echo "BGE-M3 download failed, will download at runtime"

# Whisper tiny + base (~220 MB)
RUN python3 -c "import whisper; whisper.load_model('tiny'); whisper.load_model('base')" && \
    cp ~/.cache/whisper/*.pt /app/data/_bundled/whisper/ || echo "Whisper download failed"

# PaddleOCR-VL weights (~1.8 GB) — already in data/models/docling/vlm/ from da:full
RUN cp -r /app/data/models/docling/vlm/PaddlePaddle--PaddleOCR-VL-1.5/* \
          /app/data/_bundled/paddleocr-vl/ 2>/dev/null || true

# GLM-OCR weights (~2.5 GB) — already in data/models/docling/vlm/ from da:full
RUN cp -r /app/data/models/docling/vlm/zai-org--GLM-OCR/* \
          /app/data/_bundled/glm-ocr/ 2>/dev/null || true

# Docling layout/ocr/table models (~500 MB) — already in data/models/docling/
RUN cp -r /app/data/models/docling/layout /app/data/_bundled/docling/ 2>/dev/null || true
RUN cp -r /app/data/models/docling/ocr /app/data/_bundled/docling/ 2>/dev/null || true
RUN cp -r /app/data/models/docling/table /app/data/_bundled/docling/ 2>/dev/null || true

# Mark image variant
ENV DA_IMAGE_VARIANT=personal-full \
    DA_BUNDLE_TYPE=full

LABEL org.opencontainers.image.title="DeepAnalyze Personal Full"
LABEL org.opencontainers.image.description="All weights pre-bundled for offline deployment"
LABEL org.opencontainers.image.version="0.7.6"

CMD ["python3", "start.py"]
```

- [ ] **Step 3: 更新 da-assets/manifest.json**

Modify `da-assets/manifest.json` to add new module weight entries. Read the existing file first to understand the shape, then add entries for `whisper-base`, `docling-layout`, `mineru`:

```json
{
  "version": "0.7.6",
  "models": {
    "bge-m3": {
      "description": "BGE-M3 embedding model",
      "sources": {
        "hf_mirror": "https://hf-mirror.com/BAAI/bge-m3/resolve/main/",
        "huggingface": "https://huggingface.co/BAAI/bge-m3/resolve/main/"
      },
      "files": [
        { "path": "pytorch_model.bin", "sha256": "..." },
        { "path": "config.json" },
        { "path": "tokenizer.json" },
        { "path": "tokenizer_config.json" },
        { "path": "sentence_bert_config.json" },
        { "path": "special_tokens_map.json" },
        { "path": "modules.json" },
        { "path": "sentencepiece.bpe.model" },
        { "path": "1_Pooling/config.json" }
      ]
    },
    "whisper-base": {
      "description": "OpenAI Whisper base model",
      "sources": {
        "hf_mirror": "https://hf-mirror.com/openai/whisper-base/resolve/main/",
        "huggingface": "https://huggingface.co/openai/whisper-base/resolve/main/"
      },
      "files": [
        { "path": "pytorch_model.bin" },
        { "path": "config.json" },
        { "path": "generation_config.json" },
        { "path": "tokenizer.json" },
        { "path": "vocab.json" }
      ]
    },
    "docling-layout": {
      "description": "Docling layout + OCR + table models",
      "sources": {
        "hf_mirror": "https://hf-mirror.com/docling/resolve/main/",
        "huggingface": "https://huggingface.co/docling/resolve/main/"
      },
      "files": [
        { "path": "layout/model.onnx" },
        { "path": "ocr/model.onnx" },
        { "path": "table/model.onnx" }
      ]
    },
    "mineru": {
      "description": "MinerU Docker image (no weights to download — image bundles them)",
      "sources": {},
      "files": [],
      "dockerImage": {
        "cpu": "da/mineru:0.7.6-cpu",
        "gpu": "da/mineru:0.7.6-gpu"
      }
    }
  }
}
```

Note: SHA256 checksums must be filled in with actual values computed from the weight files. Run:
```bash
sha256sum data/models/bge-m3/pytorch_model.bin
# Use the output to populate the sha256 field
```

- [ ] **Step 4: 写迁移脚本**

Create `scripts/migrate-existing-users.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Migration script for existing da:full users.
 *
 * Detects weight directories that already exist on disk and writes
 * corresponding module_states rows (status=installed, mode=local).
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   bun run scripts/migrate-existing-users.ts
 *   # or: tsx scripts/migrate-existing-users.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { getPool, closePool } from '../src/store/pg.ts';
import { PgModuleStatesRepo } from '../src/store/repos/module-states.ts';

const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const MODELS_DIR = path.join(PROJECT_ROOT, 'data', 'models');

interface DetectedWeights {
  moduleId: 'embedding' | 'asr' | 'docling' | 'mineru';
  exists: boolean;
  weightsPath?: string;
  weightsSizeMb?: number;
  processType: 'subprocess' | 'docker';
}

async function detectExistingWeights(): Promise<DetectedWeights[]> {
  const results: DetectedWeights[] = [];

  // BGE-M3
  const bgeDir = path.join(MODELS_DIR, 'bge-m3');
  const bgeBin = path.join(bgeDir, 'pytorch_model.bin');
  if (fs.existsSync(bgeBin)) {
    const stat = fs.statSync(bgeBin);
    results.push({
      moduleId: 'embedding',
      exists: true,
      weightsPath: 'data/models/bge-m3',
      weightsSizeMb: Math.floor(stat.size / 1024 / 1024),
      processType: 'subprocess',
    });
  } else {
    results.push({ moduleId: 'embedding', exists: false, processType: 'subprocess' });
  }

  // Whisper (cache dir, not models dir)
  const whisperCache = path.join(process.env.HOME || '/root', '.cache', 'whisper');
  const whisperBase = path.join(whisperCache, 'base.pt');
  if (fs.existsSync(whisperBase)) {
    const stat = fs.statSync(whisperBase);
    results.push({
      moduleId: 'asr',
      exists: true,
      weightsPath: whisperCache,
      weightsSizeMb: Math.floor(stat.size / 1024 / 1024),
      processType: 'subprocess',
    });
  } else {
    results.push({ moduleId: 'asr', exists: false, processType: 'subprocess' });
  }

  // Docling
  const doclingDir = path.join(MODELS_DIR, 'docling', 'layout');
  if (fs.existsSync(doclingDir)) {
    results.push({
      moduleId: 'docling',
      exists: true,
      weightsPath: 'data/models/docling',
      processType: 'subprocess',
    });
  } else {
    results.push({ moduleId: 'docling', exists: false, processType: 'subprocess' });
  }

  // MinerU — check if Docker image is present
  results.push({ moduleId: 'mineru', exists: false, processType: 'docker' });

  return results;
}

async function main() {
  console.log('[migrate] detecting existing weights...');
  const pool = await getPool();
  const repo = new PgModuleStatesRepo(pool);

  const detected = await detectExistingWeights();
  for (const d of detected) {
    if (d.exists) {
      const existing = await repo.get(d.moduleId);
      if (existing && existing.status !== 'not_installed') {
        console.log(`[migrate] ${d.moduleId}: already configured (${existing.status}/${existing.mode}) — skipping`);
        continue;
      }
      await repo.upsert({
        moduleId: d.moduleId,
        status: 'installed',
        mode: 'local',
        weightsPath: d.weightsPath,
        weightsSizeMb: d.weightsSizeMb,
        processType: d.processType,
        gpuRequired: false, // User can flip via UI
        installedAt: new Date(),
      });
      console.log(`[migrate] ${d.moduleId}: marked as installed/local (weights at ${d.weightsPath})`);
    } else {
      console.log(`[migrate] ${d.moduleId}: no weights detected, leaving as not_installed`);
    }
  }

  await closePool();
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] FATAL:', err);
  process.exit(1);
});
```

- [ ] **Step 5: 验证 Docker 构建**

```bash
# Build core image
docker build -f Dockerfile.personal-core -t da:personal-core .
docker images da:personal-core
# Expected: image size ~500-700 MB

# Build full image (requires da:full exists)
docker build -f Dockerfile.personal-full -t da:personal-full .
docker images da:personal-full
# Expected: image size ~10-12 GB
```

If the build fails due to network issues during HF downloads, check that `HF_ENDPOINT=https://hf-mirror.com` is accessible. For CI environments, use build args to skip weight downloads:
```bash
docker build -f Dockerfile.personal-full --build-arg SKIP_DOWNLOADS=1 -t da:personal-full .
```

- [ ] **Step 6: 验证迁移脚本**

```bash
# In a development environment with existing weights
bun run scripts/migrate-existing-users.ts
# Expected output:
# [migrate] detecting existing weights...
# [migrate] embedding: marked as installed/local (weights at data/models/bge-m3)
# [migrate] asr: marked as installed/local (weights at /root/.cache/whisper)
# [migrate] docling: marked as installed/local
# [migrate] mineru: no weights detected, leaving as not_installed
# [migrate] done

# Verify DB state
psql ... -c "SELECT module_id, status, mode, weights_path FROM module_states;"
# Expected: embedding/asr/docling rows with status=installed, mode=local

# Re-run to verify idempotency
bun run scripts/migrate-existing-users.ts
# Expected: "already configured — skipping" for each module
```

- [ ] **Step 7: 提交**

```bash
git add Dockerfile.personal-core Dockerfile.personal-full \
        da-assets/manifest.json \
        scripts/migrate-existing-users.ts
git commit -m "feat(packaging): dual-track release + existing-user migration

- Dockerfile.personal-core: ~500MB small-footprint image, no weights
- Dockerfile.personal-full: ~10GB image with all weights in data/_bundled/
- manifest.json: entries for bge-m3, whisper-base, docling-layout, mineru
- migrate-existing-users.ts: idempotent script that detects existing
  weights on disk and writes corresponding module_states rows"
```

---

## 验证清单（Part 2 完成标志）

完成所有 5 个任务后，验证：

1. ✅ `ModuleCard` 组件能渲染所有 5 种状态（Task 11）
2. ✅ 状态栏 4 个 pill 在 ModelsPanel 顶部显示（Task 12）
3. ✅ 4 个配置组件（Embedding/ASR/Docling/MinerU）都使用 ModuleCard（Task 13）
4. ✅ 前端构建无 TypeScript 错误（`cd frontend && bun run build`）
5. ✅ 全量包首次启动向导正确触发并应用预设（Task 14）
6. ✅ `Dockerfile.personal-core` 构建产物 ≤ 700 MB（Task 15）
7. ✅ `Dockerfile.personal-full` 构建产物 ≤ 12 GB（Task 15）
8. ✅ 迁移脚本幂等，能检测现有权重并写入 module_states（Task 15）
9. ✅ E2E 测试通过：`bun test tests/e2e/`
10. ✅ 端到端体验：
    - 用户安装 `da:personal-core` → 启动 → 配置远端 API → 可用
    - 用户安装 `da:personal-full` → 启动 → 向导出现 → 选"完整" → 所有模块本地运行
    - 现有 `da:full` 用户运行迁移脚本 → 模块自动标记为 installed

---

## 最终验收（Part 1 + Part 2 全部完成）

参考 spec `docs/superpowers/specs/2026-07-04-unified-module-deployment-design.md` §7 验收标准：

1. ✅ 4 模块 UI 都用统一 ModuleCard（Task 11/13）
2. ✅ 每模块支持 local/remote/disabled 三模式切换（Task 11）
3. ✅ 模式切换无需重启 DA（bumpConfigVersion 机制，Task 8/9）
4. ✅ `module_states` 表是唯一数据源（Task 1/4/9/10）
5. ✅ GPU 三档检测正确（Task 2）
6. ✅ 小核心包 ≤ 600 MB，全量包 ≤ 12 GB（Task 15）
7. ✅ 首次启动向导正确推荐 GPU 档位（Task 14）
8. ✅ 现有 `da:full` 用户数据自动迁移（Task 15）
9. ✅ `model-supervisor.ts` 修复（Task 4）
10. ✅ `/api/health` 报告全部 5 类模块状态（Task 9）

---

## Subagent-Driven 执行提示

执行 Part 1 + Part 2 时建议：

- **依赖顺序**：严格按 Task 1 → 15 顺序，后续任务依赖前序任务的接口
- **可并行的任务**：Task 5/6/7（GLM-OCR / MinerU / Docling remote）可并行，因都只依赖 Task 1 的类型
- **谨慎任务**：Task 9（后端集成）和 Task 13（前端重写）触及现有代码最多，建议在 worktree 中执行以便回滚
- **Docker 构建**：Task 5/6/15 的 Docker 镜像构建验证建议串行，避免同时下载大文件占用带宽
