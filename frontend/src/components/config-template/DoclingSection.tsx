// =============================================================================
// DoclingSection — 文档解析选项表单
// =============================================================================
// 8 个字段：layout_model / ocr_engine / ocr_backend / table_mode /
// use_vlm / vlm_mode / vlm_model / parallelism。
// 字段值可选：undefined = 不写入模板。
// 字段定义对齐 DA 的 DoclingConfig（DeepAnalyze/src/store/repos/interfaces.ts:801）。
// =============================================================================

import { SectionCard } from "./SectionCard.js";
import { Select } from "../ui/Select.js";
import { Toggle } from "../ui/Toggle.js";
import type { TemplateDoclingConfig } from "../../types/config-template.js";

export interface DoclingSectionProps {
  value: TemplateDoclingConfig | null | undefined;
  locked: boolean;
  onChange: (next: TemplateDoclingConfig | null) => void;
  onLockChange: (locked: boolean) => void;
}

export function DoclingSection({
  value,
  locked,
  onChange,
  onLockChange,
}: DoclingSectionProps) {
  const cfg = value ?? {};

  const update = (patch: Partial<TemplateDoclingConfig>) => {
    const next: TemplateDoclingConfig = { ...cfg, ...patch };
    // 删除值为 undefined 的字段（不下发）
    for (const k of Object.keys(next) as Array<keyof TemplateDoclingConfig>) {
      if (next[k] === undefined) delete next[k];
    }
    onChange(Object.keys(next).length > 0 ? next : null);
  };

  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: "var(--space-3)",
  };

  const fieldStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    fontWeight: 500,
    color: "var(--text-primary)",
  };

  // table_mode 按钮组样式
  const btnGroupStyle: React.CSSProperties = {
    display: "inline-flex",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
  };

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    background: active ? "var(--brand-primary)" : "var(--bg-primary)",
    color: active ? "var(--brand-foreground)" : "var(--text-primary)",
    border: "none",
    cursor: "pointer",
    fontSize: "var(--text-sm)",
  });

  return (
    <SectionCard
      title="文档解析 (Docling)"
      description="Docling 解析引擎的 OCR、表格、VLM 后端等选项。"
      lockKey="doclingConfig"
      locked={locked}
      onLockChange={onLockChange}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <div style={rowStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>布局模型</label>
            <Select
              value={cfg.layout_model ?? ""}
              onChange={(v) => update({ layout_model: v || undefined })}
              options={[
                { value: "", label: "（不下发）" },
                { value: "docling-project/docling-layout-heron", label: "docling-layout-heron (默认)" },
              ]}
              aria-label="布局模型"
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>OCR 引擎</label>
            <Select
              value={cfg.ocr_engine ?? ""}
              onChange={(v) =>
                update({ ocr_engine: (v || undefined) as TemplateDoclingConfig["ocr_engine"] })
              }
              options={[
                { value: "", label: "（不下发）" },
                { value: "rapidocr", label: "RapidOCR (推荐)" },
                { value: "easyocr", label: "EasyOCR" },
                { value: "tesseract", label: "Tesseract" },
              ]}
              aria-label="OCR 引擎"
            />
          </div>

          {cfg.ocr_engine === "rapidocr" && (
            <div style={fieldStyle}>
              <label style={labelStyle}>OCR 后端</label>
              <Select
                value={cfg.ocr_backend ?? ""}
                onChange={(v) =>
                  update({ ocr_backend: (v || undefined) as TemplateDoclingConfig["ocr_backend"] })
                }
                options={[
                  { value: "", label: "（不下发）" },
                  { value: "torch", label: "Torch" },
                  { value: "onnxruntime", label: "ONNX Runtime" },
                ]}
                aria-label="OCR 后端"
              />
            </div>
          )}

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

        {/* table_mode 按钮组 */}
        <div style={fieldStyle}>
          <label style={labelStyle}>表格模式</label>
          <div style={btnGroupStyle}>
            <button
              type="button"
              style={btnStyle(cfg.table_mode === "accurate")}
              onClick={() => update({ table_mode: cfg.table_mode === "accurate" ? undefined : "accurate" })}
            >
              精确 (accurate)
            </button>
            <button
              type="button"
              style={btnStyle(cfg.table_mode === "fast")}
              onClick={() => update({ table_mode: cfg.table_mode === "fast" ? undefined : "fast" })}
            >
              快速 (fast)
            </button>
            <button
              type="button"
              style={btnStyle(cfg.table_mode === undefined)}
              onClick={() => update({ table_mode: undefined })}
            >
              不下发
            </button>
          </div>
        </div>

        {/* use_vlm 开关 */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <Toggle
            checked={cfg.use_vlm === true}
            onChange={(c) => update({ use_vlm: c || undefined })}
            label="启用 VLM 后端（视觉模型辅助解析）"
            aria-label="启用 VLM"
          />
        </div>

        {/* vlm_mode（仅 use_vlm 时显示） */}
        {cfg.use_vlm && (
          <div style={fieldStyle}>
            <label style={labelStyle}>VLM 模式</label>
            <div style={btnGroupStyle}>
              <button
                type="button"
                style={btnStyle(cfg.vlm_mode === "inline")}
                onClick={() => update({ vlm_mode: cfg.vlm_mode === "inline" ? undefined : "inline" })}
              >
                内联 (inline)
              </button>
              <button
                type="button"
                style={btnStyle(cfg.vlm_mode === "api")}
                onClick={() => update({ vlm_mode: cfg.vlm_mode === "api" ? undefined : "api" })}
              >
                API
              </button>
            </div>
          </div>
        )}

        {/* parallelism 滑块 */}
        <div style={fieldStyle}>
          <label style={labelStyle}>
            并行度：{cfg.parallelism ?? "（不下发）"}
          </label>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={cfg.parallelism ?? 0}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              update({ parallelism: n === 0 ? undefined : n });
            }}
            style={{ width: 240 }}
          />
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            0 = 不下发；1-10 控制解析并行度
          </span>
        </div>
      </div>
    </SectionCard>
  );
}

export default DoclingSection;
