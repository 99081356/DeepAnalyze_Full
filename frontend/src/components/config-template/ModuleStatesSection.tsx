// =============================================================================
// ModuleStatesSection — 4 个本地模块状态表单
// =============================================================================
// embedding / asr / docling / mineru 四个固定模块，每个选 mode。docling 和
// mineru 的模块卡片内嵌「📐 高级解析选项」折叠区（原 DoclingSection /
// MinerUSection 合并到此），让配置项与模块卡片对应，更贴近 Worker 端的组织。
//
// JSON 结构不变：doclingConfig/mineruConfig 仍为独立顶层 key，Worker sync
// 契约不变。UI 仅实现了视觉上的合并。
// =============================================================================

import { SectionCard } from "./SectionCard.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Toggle } from "../ui/Toggle.js";
import {
  TEMPLATE_MODULES,
  type ModuleStateTemplate,
  type TemplateDoclingConfig,
  type TemplateMinerUConfig,
} from "../../types/config-template.js";

export interface ModuleStatesSectionProps {
  value: Record<string, ModuleStateTemplate> | null | undefined;
  /** 各模块的锁定状态（key = "moduleStates.<id>"） */
  lockedMap: Record<string, boolean>;
  onChange: (next: Record<string, ModuleStateTemplate> | null) => void;
  onLockChange: (moduleId: string, locked: boolean) => void;

  // ── docling/mineru 配置（来自独立顶层 key，UI 合并到模块卡片内） ──
  doclingConfig?: TemplateDoclingConfig | null;
  doclingConfigLocked?: boolean;
  onDoclingConfigChange?: (next: TemplateDoclingConfig | null) => void;
  onDoclingConfigLockChange?: (locked: boolean) => void;

  mineruConfig?: TemplateMinerUConfig | null;
  mineruConfigLocked?: boolean;
  onMineruConfigChange?: (next: TemplateMinerUConfig | null) => void;
  onMineruConfigLockChange?: (locked: boolean) => void;
}

const MODES: Array<{ value: NonNullable<ModuleStateTemplate["mode"]>; label: string }> = [
  { value: "disabled", label: "禁用" },
  { value: "local", label: "本地部署" },
  { value: "remote", label: "远端 API" },
];

export function ModuleStatesSection({
  value,
  lockedMap,
  onChange,
  onLockChange,
  doclingConfig: docCfg,
  doclingConfigLocked = false,
  onDoclingConfigChange,
  onDoclingConfigLockChange,
  mineruConfig: mineruCfg,
  mineruConfigLocked = false,
  onMineruConfigChange,
  onMineruConfigLockChange,
}: ModuleStatesSectionProps) {
  const states = value ?? {};

  const updateModule = (moduleId: string, patch: Partial<ModuleStateTemplate>) => {
    const next = { ...states };
    const cur = next[moduleId] ?? {};
    const merged = { ...cur, ...patch };
    if (patch.mode === "disabled") {
      delete next[moduleId];
    } else {
      next[moduleId] = merged;
    }
    onChange(Object.keys(next).length > 0 ? next : null);
  };

  // ── 共享样式 ──────────────────────────────────────────────────────────────

  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "var(--space-3)",
  };

  const moduleCardStyle: React.CSSProperties = {
    padding: "var(--space-3)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  const moduleNameStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--text-primary)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  const btnGroupStyle: React.CSSProperties = {
    display: "inline-flex",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    width: "fit-content",
  };

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    background: active ? "var(--brand-primary)" : "var(--bg-primary)",
    color: active ? "var(--brand-foreground)" : "var(--text-secondary)",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
  });

  const lockBadgeStyle = (locked: boolean): React.CSSProperties => ({
    fontSize: 11,
    padding: "1px 6px",
    borderRadius: "var(--radius-sm)",
    background: locked ? "var(--warning-light)" : "transparent",
    color: locked ? "var(--warning-dark, var(--warning))" : "var(--text-tertiary)",
    border: locked ? "1px solid var(--warning)" : "1px solid var(--border-secondary)",
    cursor: "pointer",
  });

  const detailStyle: React.CSSProperties = {
    marginTop: "var(--space-1)",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--bg-tertiary)",
    borderRadius: "var(--radius-sm)",
  };

  const summaryStyle: React.CSSProperties = {
    cursor: "pointer",
    fontSize: 12,
    color: "var(--text-secondary)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  const fieldRowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-2)",
    marginTop: "var(--space-2)",
  };

  const fieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-primary)",
  };

  // ── docling/mineru 高级选项内容 ───────────────────────────────────────────

  const renderDoclingAdvanced = () => {
    const cfg = docCfg ?? {};
    const update = (p: Partial<TemplateDoclingConfig>) => {
      const next: TemplateDoclingConfig = { ...cfg, ...p };
      for (const k of Object.keys(next) as Array<keyof TemplateDoclingConfig>) {
        if (next[k] === undefined) delete next[k];
      }
      onDoclingConfigChange?.(Object.keys(next).length > 0 ? next : null);
    };

    return (
      <>
        <div style={fieldRowStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>布局模型</label>
            <Select
              value={cfg.layout_model ?? ""}
              onChange={(v) => update({ layout_model: v || undefined })}
              options={[
                { value: "", label: "（不下发）" },
                { value: "docling-project/docling-layout-heron", label: "docling-layout-heron" },
              ]}
              aria-label="布局模型"
            />
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>OCR 引擎</label>
            <Select
              value={cfg.ocr_engine ?? ""}
              onChange={(v) => update({ ocr_engine: (v || undefined) as TemplateDoclingConfig["ocr_engine"] })}
              options={[
                { value: "", label: "（不下发）" },
                { value: "rapidocr", label: "RapidOCR" },
                { value: "easyocr", label: "EasyOCR" },
                { value: "tesseract", label: "Tesseract" },
              ]}
              aria-label="OCR 引擎"
            />
          </div>
        </div>

        {cfg.ocr_engine === "rapidocr" && (
          <div style={fieldStyle}>
            <label style={labelStyle}>OCR 后端</label>
            <Select
              value={cfg.ocr_backend ?? ""}
              onChange={(v) => update({ ocr_backend: (v || undefined) as TemplateDoclingConfig["ocr_backend"] })}
              options={[
                { value: "", label: "（不下发）" },
                { value: "torch", label: "Torch" },
                { value: "onnxruntime", label: "ONNX Runtime" },
              ]}
              aria-label="OCR 后端"
            />
          </div>
        )}

        {/* 表格模式 + VLM 模型 */}
        <div style={fieldRowStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>表格模式</label>
            <div style={btnGroupStyle}>
              <button type="button" style={btnStyle(cfg.table_mode === "accurate")} onClick={() => update({ table_mode: cfg.table_mode === "accurate" ? undefined : "accurate" })}>精确</button>
              <button type="button" style={btnStyle(cfg.table_mode === "fast")} onClick={() => update({ table_mode: cfg.table_mode === "fast" ? undefined : "fast" })}>快速</button>
            </div>
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>VLM 模型</label>
            <Select
              value={cfg.vlm_model ?? ""}
              onChange={(v) => update({ vlm_model: v || undefined })}
              options={[
                { value: "", label: "（不下发）" },
                { value: "zai-org/GLM-OCR", label: "GLM-OCR" },
              ]}
              aria-label="VLM 模型"
            />
          </div>
        </div>

        {/* use_vlm + vlm_mode + parallelism */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap", marginTop: "var(--space-1)" }}>
          <Toggle checked={cfg.use_vlm === true} onChange={(c) => update({ use_vlm: c || undefined })} size="sm" label="启用 VLM" />
          {cfg.use_vlm && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>模式:</span>
              <div style={btnGroupStyle}>
                <button type="button" style={btnStyle(cfg.vlm_mode === "inline")} onClick={() => update({ vlm_mode: cfg.vlm_mode === "inline" ? undefined : "inline" })}>inline</button>
                <button type="button" style={btnStyle(cfg.vlm_mode === "api")} onClick={() => update({ vlm_mode: cfg.vlm_mode === "api" ? undefined : "api" })}>api</button>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: 2 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>并行度：{cfg.parallelism ?? "—"}</span>
          <input type="range" min={0} max={10} step={1} value={cfg.parallelism ?? 0} onChange={(e) => { const n = parseInt(e.target.value, 10); update({ parallelism: n === 0 ? undefined : n }); }} style={{ width: 100 }} />
        </div>
      </>
    );
  };

  const renderMineruAdvanced = () => {
    const cfg = mineruCfg ?? {};
    const update = (p: Partial<TemplateMinerUConfig>) => {
      const next: TemplateMinerUConfig = { ...cfg, ...p };
      for (const k of Object.keys(next) as Array<keyof TemplateMinerUConfig>) {
        if (next[k] === undefined) delete next[k];
      }
      onMineruConfigChange?.(Object.keys(next).length > 0 ? next : null);
    };

    const BACKENDS = [
      { value: "", label: "（不下发）" }, { value: "hybrid-auto-engine", label: "Hybrid 自动" },
      { value: "pipeline", label: "Pipeline" }, { value: "vlm-auto-engine", label: "VLM 自动" },
    ];
    const LANGS = [
      { value: "", label: "（不下发）" }, { value: "ch", label: "中文" }, { value: "en", label: "英文" },
      { value: "japan", label: "日文" }, { value: "korean", label: "韩文" },
    ];

    return (
      <>
        <Input label="API 地址 (apiUrl)" value={cfg.apiUrl ?? ""} onChange={(e) => update({ apiUrl: e.target.value || undefined })} placeholder="http://127.0.0.1:8001" />
        <div style={fieldRowStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>默认后端</label>
            <Select value={cfg.defaultBackend ?? ""} onChange={(v) => update({ defaultBackend: v || undefined })} options={BACKENDS} aria-label="后端" />
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>默认语言</label>
            <Select value={cfg.defaultLang ?? ""} onChange={(v) => update({ defaultLang: v || undefined })} options={LANGS} aria-label="语言" />
          </div>
          <Input label="超时秒数" type="number" value={String(cfg.timeout ?? 0)} onChange={(e) => { const n = parseInt(e.target.value, 10); update({ timeout: n > 0 ? n : undefined }); }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-1)", marginTop: "var(--space-1)" }}>
          <Toggle checked={cfg.enabled === true} onChange={(c) => update({ enabled: c || undefined })} size="sm" label="启用" />
          <Toggle checked={cfg.formulaEnable === true} onChange={(c) => update({ formulaEnable: c || undefined })} size="sm" label="公式识别" />
          <Toggle checked={cfg.tableEnable === true} onChange={(c) => update({ tableEnable: c || undefined })} size="sm" label="表格识别" />
          <Toggle checked={cfg.imageAnalysis === true} onChange={(c) => update({ imageAnalysis: c || undefined })} size="sm" label="图片分析" />
        </div>
      </>
    );
  };

  // ── 配置锁开关（紧凑版，用在 details summary 右侧） ──
  const renderConfigLock = (locked: boolean, lockKey: string, onChange?: (l: boolean) => void) => {
    if (!onChange) return null;
    return (
      <span
        style={{
          fontSize: 11,
          padding: "1px 6px",
          borderRadius: "var(--radius-sm)",
          background: locked ? "var(--warning-light)" : "var(--bg-tertiary)",
          color: locked ? "var(--warning-dark)" : "var(--text-tertiary)",
          border: `1px solid ${locked ? "var(--warning)" : "var(--border-secondary)"}`,
          cursor: "pointer",
          marginLeft: "var(--space-2)",
        }}
        onClick={(e) => { e.preventDefault(); onChange(!locked); }}
        title={locked ? `已锁定 ${lockKey}：强制覆盖 Worker 本地值` : `未锁定 ${lockKey}：仅本地为空时填充`}
      >
        {locked ? `🔒 ${lockKey}` : `🔓 ${lockKey}`}
      </span>
    );
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <SectionCard
      title="本地模块状态"
      description="embedding / asr / docling / mineru 四个模块的部署模式。每个模块可单独锁定。docling/mineru 的解析选项已合并到卡片内。"
    >
      <div style={gridStyle}>
        {TEMPLATE_MODULES.map((m) => {
          const st = states[m.id] ?? {};
          const mode = st.mode ?? "disabled";
          const lockKey = `moduleStates.${m.id}`;
          const isLocked = lockedMap[lockKey] ?? false;
          const isDocling = m.id === "docling";
          const isMineru = m.id === "mineru";
          return (
            <div key={m.id} style={moduleCardStyle}>
              <div style={moduleNameStyle}>
                <span>{m.label}</span>
                <span
                  style={lockBadgeStyle(isLocked)}
                  onClick={() => onLockChange(m.id, !isLocked)}
                  title={isLocked ? "已锁定：强制覆盖此模块的本地状态" : "未锁定：仅本地为空时填充"}
                >
                  {isLocked ? "🔒 强制覆盖" : "🔓 仅填空"}
                </span>
              </div>
              <div style={btnGroupStyle}>
                {MODES.map((md) => (
                  <button
                    key={md.value}
                    type="button"
                    style={btnStyle(mode === md.value)}
                    onClick={() => updateModule(m.id, { mode: md.value })}
                  >
                    {md.label}
                  </button>
                ))}
              </div>
              {mode === "remote" && (
                <>
                  <Input
                    label="远端 Endpoint"
                    value={st.endpoint ?? ""}
                    onChange={(e) => updateModule(m.id, { endpoint: e.target.value })}
                    placeholder="http://host:port"
                  />
                  <Input
                    label="远端 API Key（可选）"
                    type="password"
                    value={st.apiKey ?? ""}
                    onChange={(e) => updateModule(m.id, { apiKey: e.target.value || undefined })}
                    placeholder="sk-…"
                  />
                  {m.usesProviderSystem && (
                    <div
                      style={{
                        padding: "var(--space-2) var(--space-3)",
                        background: "var(--bg-tertiary)",
                        borderRadius: "var(--radius-sm)",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        borderLeft: "3px solid var(--brand-primary)",
                      }}
                    >
                      💡 实际参数走 <b>Providers 区块</b>：绑定角色
                      （{m.id === "embedding" ? "embedding" : "audio_transcribe"}）。
                    </div>
                  )}
                </>
              )}

              {/* ── docling 高级解析选项 ── */}
              {isDocling && onDoclingConfigChange && (
                <details style={detailStyle}>
                  <summary style={summaryStyle}>
                    <span>📐 Docling 解析选项</span>
                    {renderConfigLock(doclingConfigLocked, "doclingConfig", onDoclingConfigLockChange)}
                  </summary>
                  {renderDoclingAdvanced()}
                </details>
              )}

              {/* ── mineru 高级解析选项 ── */}
              {isMineru && onMineruConfigChange && (
                <details style={detailStyle}>
                  <summary style={summaryStyle}>
                    <span>📐 MinerU 解析选项</span>
                    {renderConfigLock(mineruConfigLocked, "mineruConfig", onMineruConfigLockChange)}
                  </summary>
                  {renderMineruAdvanced()}
                </details>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

export default ModuleStatesSection;
