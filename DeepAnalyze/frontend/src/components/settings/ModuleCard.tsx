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

  const refresh = useCallback(async () => {
    try {
      const { module } = await api.getModule(moduleId);
      setState(module);
    } catch {
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    setBusy(true);
    try {
      await api.startModule(moduleId);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await api.stopModule(moduleId);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoteConfigSave = async (patch: Partial<ModuleState>) => {
    setBusy(true);
    try {
      const { module } = await api.updateModuleConfig(moduleId, patch);
      setState(module);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
            此模块已禁用。切换到&ldquo;本地部署&rdquo;或&ldquo;远端 API&rdquo;以启用。
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
  state, busy, onSave,
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
        onChange={(e) => onSave({ vlmBackend: e.target.value })}
        disabled={busy}
      >
        {backends.map((b) => (
          <option key={b.value} value={b.value}>{b.label}</option>
        ))}
      </select>
    </div>
  );
}
