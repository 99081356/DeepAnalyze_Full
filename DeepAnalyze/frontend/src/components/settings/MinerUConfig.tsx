import { useEffect, useState, useCallback } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  XCircle,
  Save,
  RefreshCw,
} from "lucide-react";
import { ModuleCard } from "./ModuleCard";
import { api } from "../../api/client";
import type { MinerUConfig as MinerUConfigShape } from "../../types/index.js";

const DEFAULT_CONFIG: MinerUConfigShape = {
  apiUrl: "http://127.0.0.1:8001",
  defaultBackend: "hybrid-auto-engine",
  defaultLang: "ch",
  formulaEnable: true,
  tableEnable: true,
  imageAnalysis: true,
  timeout: 300,
  enabled: false,
};

const BACKEND_OPTIONS: Array<{
  value: MinerUConfigShape["defaultBackend"];
  label: string;
  hint: string;
}> = [
  {
    value: "hybrid-auto-engine",
    label: "Hybrid (推荐)",
    hint: "VLM 布局 + OCR 文字，兼顾精度和可靠性",
  },
  {
    value: "pipeline",
    label: "Pipeline",
    hint: "纯 OCR 管线，无幻觉，适合印章、轻量场景",
  },
  {
    value: "vlm-auto-engine",
    label: "VLM",
    hint: "纯视觉模型，适合复杂排版，可能有幻觉",
  },
];

const LANG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "ch", label: "中文" },
  { value: "en", label: "English" },
  { value: "japan", label: "日本語" },
  { value: "korean", label: "한국어" },
];

/**
 * MinerU configuration — ModuleCard (local Docker / remote endpoint) + 解析选项.
 *
 * 双轨制:
 * - 部署生命周期 (install/start/stop/mode) 走 ModuleCard → /api/modules/mineru/*
 * - 功能配置 (backend/lang/formula/...) 走本组件 → /api/settings/mineru-config
 */
export function MinerUConfig() {
  return (
    <div className="mineru-config">
      <ModuleCard moduleId="mineru" />
      <MinerUAdvancedOptions />
    </div>
  );
}

function MinerUAdvancedOptions() {
  const [config, setConfig] = useState<MinerUConfigShape | null>(null);
  const [status, setStatus] = useState<{
    connected: boolean;
    version?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await api.getMinerUConfig();
      setConfig({ ...DEFAULT_CONFIG, ...(cfg as Partial<MinerUConfigShape>) });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    if (!config?.enabled) {
      setStatus(null);
      return;
    }
    setChecking(true);
    try {
      const r = await api.checkMinerUStatus();
      setStatus({ connected: r.connected, version: r.version });
    } catch {
      setStatus({ connected: false });
    } finally {
      setChecking(false);
    }
  }, [config?.enabled]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (config?.enabled) {
      void checkStatus();
    }
  }, [config?.enabled, config?.apiUrl, checkStatus]);

  const updateField = async <K extends keyof MinerUConfigShape>(
    field: K,
    value: MinerUConfigShape[K],
  ) => {
    if (!config) return;
    const updated = { ...config, [field]: value };
    setConfig(updated);
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveMinerUConfig(config);
      await loadConfig();
      await checkStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mineru-advanced" style={{ marginTop: 12 }}>
        <div className="module-card__progress">
          <Loader2 size={14} className="spin" /> 加载 MinerU 配置…
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="mineru-advanced" style={{ marginTop: 12 }}>
        <div className="module-card__error-row">
          <AlertCircle size={14} /> 无法加载配置: {error}
        </div>
      </div>
    );
  }

  return (
    <div
      className="mineru-advanced module-card"
      style={{ marginTop: 12 }}
    >
      <div className="module-card__header">
        <h3 className="module-card__title">MinerU 解析选项</h3>
        {config.enabled && (
          <span
            className={`module-card__badge module-card__badge--${
              checking
                ? "yellow"
                : status?.connected
                ? "green"
                : "red"
            }`}
          >
            {checking ? (
              <>
                <Loader2 size={12} className="spin" /> 检测中
              </>
            ) : status?.connected ? (
              <>
                <CheckCircle2 size={12} /> 已连接
                {status.version && ` (v${status.version})`}
              </>
            ) : (
              <>
                <XCircle size={12} /> 未连接
              </>
            )}
          </span>
        )}
      </div>

      {error && (
        <div className="module-card__error">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div className="mineru-enable-row">
        <div className="mineru-toggle-label">
          <strong>启用 MinerU</strong>
          <small>开启后才会实际调用 MinerU 服务解析文档</small>
        </div>
        <label className="mineru-switch mineru-switch--lg">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => updateField("enabled", e.target.checked)}
          />
          <span className="mineru-slider" />
        </label>
      </div>

      <label className="module-card__field">
        <span>API 服务地址</span>
        <input
          type="text"
          value={config.apiUrl}
          onChange={(e) => updateField("apiUrl", e.target.value)}
          placeholder="http://127.0.0.1:8001"
        />
      </label>

      <div className="module-card__field">
        <span>默认后端</span>
        <div className="mineru-backend-group">
          {BACKEND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`mineru-backend-btn ${
                config.defaultBackend === opt.value ? "active" : ""
              }`}
              onClick={() => updateField("defaultBackend", opt.value)}
            >
              <strong>{opt.label}</strong>
              <small>{opt.hint}</small>
            </button>
          ))}
        </div>
      </div>

      <label className="module-card__field">
        <span>语言</span>
        <select
          value={config.defaultLang}
          onChange={(e) => updateField("defaultLang", e.target.value)}
        >
          {LANG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <div className="module-card__field">
        <span>识别选项</span>
        <div className="mineru-toggles">
          <div className="mineru-toggle-row">
            <div className="mineru-toggle-label">
              <strong>公式识别</strong>
              <small>LaTeX 数学公式</small>
            </div>
            <label className="mineru-switch mineru-switch--lg">
              <input
                type="checkbox"
                checked={config.formulaEnable}
                onChange={(e) => updateField("formulaEnable", e.target.checked)}
              />
              <span className="mineru-slider" />
            </label>
          </div>
          <div className="mineru-toggle-row">
            <div className="mineru-toggle-label">
              <strong>表格识别</strong>
              <small>表格结构与单元格</small>
            </div>
            <label className="mineru-switch mineru-switch--lg">
              <input
                type="checkbox"
                checked={config.tableEnable}
                onChange={(e) => updateField("tableEnable", e.target.checked)}
              />
              <span className="mineru-slider" />
            </label>
          </div>
          <div className="mineru-toggle-row">
            <div className="mineru-toggle-label">
              <strong>图片分析</strong>
              <small>插图内容理解</small>
            </div>
            <label className="mineru-switch mineru-switch--lg">
              <input
                type="checkbox"
                checked={config.imageAnalysis}
                onChange={(e) => updateField("imageAnalysis", e.target.checked)}
              />
              <span className="mineru-slider" />
            </label>
          </div>
        </div>
      </div>

      <label className="module-card__field">
        <span>请求超时（秒）</span>
        <input
          type="number"
          min={30}
          max={1800}
          value={config.timeout}
          onChange={(e) =>
            updateField("timeout", Math.max(30, Math.min(1800, Number(e.target.value) || 300)))
          }
        />
      </label>

      <div className="module-card__actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={saving}
        >
          <Save size={14} /> {saving ? "保存中…" : "保存配置"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void checkStatus();
          }}
          disabled={checking || !config.enabled}
        >
          <RefreshCw size={14} /> 重新检测
        </button>
      </div>
    </div>
  );
}
