import { useEffect, useState } from 'react';
import { api, type GpuInfo } from '../../api/client';
import './FirstRunModuleWizard.css';

type PresetTier = 'minimal' | 'medium' | 'full';

/**
 * Per-module preset config. All fields optional so that each preset can
 * specify only the fields relevant to that module (e.g. whisperSize only
 * for ASR, vlmBackend only for docling). Avoids the awkward `as any`
 * casting that the original brief's narrower type required.
 */
interface ModulePresetConfig {
  mode: 'remote' | 'local';
  install?: boolean;
  gpuRequired?: boolean;
  whisperSize?: 'tiny' | 'base' | 'medium';
  vlmBackend?: string;
}

interface PresetSpec {
  tier: PresetTier;
  label: string;
  sizeLabel: string;
  description: string;
  modules: Record<string, ModulePresetConfig>;
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
            gpuRequired: cfg.gpuRequired ?? (gpu?.tier === 'high'),
          });
          log(`✓ ${moduleId} 安装完成`);
        }
      }

      log('预设应用完毕');
      onDone();
    } catch (err: unknown) {
      log(`✗ 错误: ${errorMessage(err)}`);
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
