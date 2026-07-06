import { useState, useEffect, useCallback } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  XCircle,
  PlayCircle,
  PauseCircle,
  RefreshCw,
} from "lucide-react";
import { ModuleCard } from "./ModuleCard";
import { api } from "../../api/client";
import type {
  DoclingConfig as DoclingConfigShape,
  DoclingModels,
  VlmContainerInfo,
  VlmContainerStatus,
} from "../../types/index.js";

/**
 * Docling configuration — ModuleCard + 完整高级选项 + VLM 容器管理.
 *
 * 双轨制:
 * - 部署生命周期 (install/start/stop/mode) → ModuleCard → /api/modules/docling/*
 * - VLM 后端选择 (none/paddleocr-vl-local/glm-ocr-local/remote-openai-vlm) → ModuleCard
 * - 解析选项 (layout/ocr/table/vlm) → 本组件 → /api/settings/docling-config
 * - VLM 容器生命周期 (start/stop) → 本组件 → /api/settings/vlm-container-*
 */
export function DoclingConfig() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [config, setConfig] = useState<DoclingConfigShape | null>(null);
  const [models, setModels] = useState<DoclingModels | null>(null);
  const [containerStatus, setContainerStatus] = useState<VlmContainerInfo | null>(
    null,
  );
  const [containerAction, setContainerAction] = useState<
    "start" | "stop" | null
  >(null);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const r = await api.getDoclingConfig();
      setConfig(r);
    } catch (err: unknown) {
      console.error(
        "Failed to load Docling config:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const r = await api.getDoclingModels();
      setModels(r);
    } catch {
      // Dynamic model list unavailable — fall back to hardcoded options
    }
  }, []);

  const loadContainerStatus = useCallback(async () => {
    try {
      const r = await api.getVlmContainerStatus();
      setContainerStatus(r);
    } catch {
      // Container API unavailable
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadModels();
  }, [loadConfig, loadModels]);

  // VLM 容器轮询: vlm_mode=api 且容器非 running 时，每 5 秒查询
  useEffect(() => {
    if (config?.vlm_mode !== "api") return;
    if (containerStatus?.status === "running") return;

    void loadContainerStatus();
    const timer = setInterval(() => {
      void loadContainerStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [config?.vlm_mode, containerStatus?.status, loadContainerStatus]);

  const updateField = async <K extends keyof DoclingConfigShape>(
    field: K,
    value: DoclingConfigShape[K],
  ) => {
    if (!config) return;
    const updated: DoclingConfigShape = { ...config, [field]: value };
    setConfig(updated);
    setSaving(true);
    try {
      await api.saveDoclingConfig(updated);
    } catch (err: unknown) {
      console.error(
        "Failed to save Docling config:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleContainerStart = async () => {
    setContainerAction("start");
    setContainerError(null);
    try {
      const r = await api.startVlmContainer();
      setContainerStatus(r);
    } catch (err: unknown) {
      setContainerError(err instanceof Error ? err.message : String(err));
    } finally {
      setContainerAction(null);
    }
  };

  const handleContainerStop = async () => {
    setContainerAction("stop");
    setContainerError(null);
    try {
      const r = await api.stopVlmContainer();
      setContainerStatus(r);
    } catch (err: unknown) {
      setContainerError(err instanceof Error ? err.message : String(err));
    } finally {
      setContainerAction(null);
    }
  };

  const renderContainerBadge = (status: VlmContainerStatus | undefined) => {
    if (!status) return null;
    const map = {
      running: {
        color: "green",
        icon: <CheckCircle2 size={12} />,
        text: "运行中",
      },
      starting: {
        color: "yellow",
        icon: <Loader2 size={12} className="spin" />,
        text: "启动中",
      },
      stopped: {
        color: "gray",
        icon: <PauseCircle size={12} />,
        text: "已停止",
      },
      unavailable: {
        color: "gray",
        icon: <XCircle size={12} />,
        text: "不可用",
      },
      error: { color: "red", icon: <AlertCircle size={12} />, text: "错误" },
    } as const;
    const cfg = map[status];
    return (
      <span className={`module-card__badge module-card__badge--${cfg.color}`}>
        {cfg.icon} {cfg.text}
      </span>
    );
  };

  return (
    <div
      className="docling-config"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <ModuleCard moduleId="docling" />

      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setShowAdvanced(!showAdvanced)}
        style={{ marginTop: 16, alignSelf: "flex-start" }}
      >
        {showAdvanced ? "隐藏" : "显示"}高级选项
      </button>

      {showAdvanced && config && (
        <div
          className="docling-advanced"
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* 布局模型 — 动态从 docling-models 获取 */}
          <label className="module-card__field">
            <span>布局模型</span>
            <select
              value={config.layout_model}
              onChange={(e) => updateField("layout_model", e.target.value)}
            >
              {models && models.layout.length > 0 ? (
                models.layout.map((m) => (
                  <option key={m.id} value={m.path || m.id}>
                    {m.name}
                  </option>
                ))
              ) : (
                <>
                  <option value="docling-project/docling-layout-egret-xlarge">
                    Egret-XLarge (高精度)
                  </option>
                  <option value="docling-project/docling-layout-heron">
                    Heron (轻量)
                  </option>
                </>
              )}
            </select>
          </label>

          {/* OCR 引擎 */}
          <label className="module-card__field">
            <span>OCR 引擎</span>
            <select
              value={config.ocr_engine}
              onChange={(e) =>
                updateField(
                  "ocr_engine",
                  e.target.value as DoclingConfigShape["ocr_engine"],
                )
              }
            >
              <option value="rapidocr">RapidOCR (推荐，GPU 加速)</option>
              <option value="easyocr">EasyOCR</option>
              <option value="tesseract">Tesseract</option>
            </select>
          </label>

          {/* OCR 推理后端 — 仅 rapidocr 时显示 */}
          {config.ocr_engine === "rapidocr" && (
            <label className="module-card__field">
              <span>OCR 推理后端</span>
              <select
                value={config.ocr_backend}
                onChange={(e) =>
                  updateField(
                    "ocr_backend",
                    e.target.value as DoclingConfigShape["ocr_backend"],
                  )
                }
              >
                <option value="torch">Torch (GPU 加速)</option>
                <option value="onnxruntime">ONNX Runtime (CPU 优化)</option>
              </select>
            </label>
          )}

          {/* 表格识别模式 */}
          <div className="module-card__field">
            <span>表格识别模式</span>
            <div style={{ display: "flex", gap: 8 }}>
              {(["accurate", "fast"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`btn ${
                    config.table_mode === mode ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() => updateField("table_mode", mode)}
                  style={{ flex: 1 }}
                >
                  {mode === "accurate" ? "精确 (Accurate)" : "快速 (Fast)"}
                </button>
              ))}
            </div>
            <small style={{ color: "var(--text-tertiary)" }}>
              accurate: 高精度但较慢; fast: 快速但精度略低
            </small>
          </div>

          {/* VLM 视觉模型开关 */}
          <label className="module-card__field">
            <span>VLM 视觉模型</span>
            <input
              type="checkbox"
              checked={config.use_vlm}
              onChange={(e) => updateField("use_vlm", e.target.checked)}
            />
            <small style={{ color: "var(--text-tertiary)" }}>
              启用后，图片和复杂排版将通过 VLM 模型解析（ModuleCard 中的 VLM
              后端选择控制具体使用哪个 VLM）
            </small>
          </label>

          {/* VLM 运行模式 + VLM 模型选择 — 仅 use_vlm=true 时显示 */}
          {config.use_vlm && (
            <>
              <div className="module-card__field">
                <span>VLM 运行模式</span>
                <div style={{ display: "flex", gap: 8 }}>
                  {(["inline", "api"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`btn ${
                        config.vlm_mode === m ? "btn-primary" : "btn-secondary"
                      }`}
                      onClick={() => updateField("vlm_mode", m)}
                      style={{ flex: 1 }}
                    >
                      {m === "inline" ? "内嵌 (Inline)" : "API 服务 (API)"}
                    </button>
                  ))}
                </div>
                <small style={{ color: "var(--text-tertiary)" }}>
                  inline: 直接加载模型; api: 通过容器化 VLM 服务调用 (需启动容器)
                </small>
              </div>

              <label className="module-card__field">
                <span>VLM 模型</span>
                <select
                  value={config.vlm_model}
                  onChange={(e) => updateField("vlm_model", e.target.value)}
                >
                  {models && models.vlm.length > 0 ? (
                    models.vlm.map((m) => (
                      <option key={m.id} value={m.path || m.id}>
                        {m.name}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="GLM-OCR">GLM-OCR</option>
                      <option value="PaddleOCR-VL-1.5">PaddleOCR-VL-1.5</option>
                      <option value="GOT-OCR-2.0">GOT-OCR-2.0</option>
                    </>
                  )}
                </select>
              </label>
            </>
          )}

          {/* 并行度 */}
          <label className="module-card__field">
            <span>并行度: {config.parallelism ?? 5}</span>
            <input
              type="range"
              min={1}
              max={10}
              value={config.parallelism ?? 5}
              onChange={(e) =>
                updateField("parallelism", parseInt(e.target.value, 10))
              }
              style={{ width: "100%" }}
            />
          </label>

          {saving && (
            <div
              className="module-card__progress"
              style={{ color: "var(--text-tertiary)" }}
            >
              <Loader2 size={12} className="spin" /> 保存中…
            </div>
          )}
        </div>
      )}

      {/* VLM 容器管理 — 仅 vlm_mode=api 时显示 */}
      {showAdvanced && config?.vlm_mode === "api" && config.use_vlm && (
        <div
          className="module-card"
          style={{ marginTop: 12 }}
        >
          <div className="module-card__header">
            <h3 className="module-card__title">VLM 容器管理</h3>
            {renderContainerBadge(containerStatus?.status)}
          </div>

          {containerError && (
            <div className="module-card__error">
              <AlertCircle size={14} /> {containerError}
            </div>
          )}

          {containerStatus?.error && (
            <div className="module-card__error-row">
              <AlertCircle size={14} /> {containerStatus.error}
            </div>
          )}

          {containerStatus?.status === "running" && containerStatus.port > 0 && (
            <div className="module-card__info-row">
              <CheckCircle2 size={14} /> 服务地址:{" "}
              <code>http://localhost:{containerStatus.port}</code>
            </div>
          )}

          <div className="module-card__actions">
            {containerStatus?.status === "running" ? (
              <button
                type="button"
                className="btn btn-stop"
                onClick={handleContainerStop}
                disabled={containerAction !== null}
              >
                {containerAction === "stop" ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <PauseCircle size={14} />
                )}
                停止容器
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleContainerStart}
                disabled={containerAction !== null}
              >
                {containerAction === "start" ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <PlayCircle size={14} />
                )}
                启动容器
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void loadContainerStatus()}
              disabled={containerAction !== null}
            >
              <RefreshCw size={14} /> 刷新状态
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
