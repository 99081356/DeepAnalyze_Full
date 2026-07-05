import { useState, useEffect } from "react";
import { ModuleCard } from "./ModuleCard";
import { api } from "../../api/client";
import type { DoclingConfig as DoclingConfigShape } from "../../types/index";

/**
 * Docling configuration — ModuleCard + advanced Docling-specific options.
 *
 * ModuleCard handles local subprocess / remote HTTP switching and
 * VLM backend selection. Below the card, advanced options (layout model,
 * OCR engine, parallelism) are preserved for power users.
 *
 * Brief-bug fixes applied vs task-13-brief.md Step 3:
 *  - `useState(() => { loadConfig(); })` is wrong (useState's initializer must
 *    return state, not run side-effects). Replaced with `useEffect(... , [])`.
 *  - `config: any` violates TypeScript strict; replaced with the proper
 *    `DoclingConfigShape` interface from types/index.
 *  - Bare `catch {}` and `catch (err)` without `instanceof Error` narrowing
 *    replaced with `err: unknown` + `instanceof Error` checks (T11 pattern).
 *  - Layout/OCR option lists now match the values used by the server's
 *    DEFAULT_DOCLING_CONFIG (settings.ts) instead of the brief's invented
 *    `doclayout_yolo` / `paddleocr` strings that don't exist in the union type
 *    `ocr_engine: "rapidocr" | "easyocr" | "tesseract"`.
 */
export function DoclingConfig() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [config, setConfig] = useState<DoclingConfigShape | null>(null);

  const loadConfig = async () => {
    try {
      const r = await api.getDoclingConfig();
      setConfig(r);
    } catch (err: unknown) {
      console.error(
        "Failed to load Docling config:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const updateField = async <K extends keyof DoclingConfigShape>(
    field: K,
    value: DoclingConfigShape[K],
  ) => {
    if (!config) return;
    const updated: DoclingConfigShape = { ...config, [field]: value };
    setConfig(updated);
    try {
      await api.saveDoclingConfig(updated);
    } catch (err: unknown) {
      console.error(
        "Failed to save Docling config:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  return (
    <div className="docling-config" style={{ display: "flex", flexDirection: "column" }}>
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
        <div className="docling-advanced" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="module-card__field">
            <span>布局模型</span>
            <select
              value={config.layout_model}
              onChange={(e) => updateField("layout_model", e.target.value)}
            >
              <option value="docling-project/docling-layout-egret-xlarge">Egret-XLarge (高精度)</option>
              <option value="docling-project/docling-layout-heron">Heron (轻量)</option>
            </select>
          </label>

          <label className="module-card__field">
            <span>OCR 引擎</span>
            <select
              value={config.ocr_engine}
              onChange={(e) =>
                updateField("ocr_engine", e.target.value as DoclingConfigShape["ocr_engine"])
              }
            >
              <option value="rapidocr">RapidOCR (推荐，GPU 加速)</option>
              <option value="easyocr">EasyOCR</option>
              <option value="tesseract">Tesseract</option>
            </select>
          </label>

          <label className="module-card__field">
            <span>并行度</span>
            <input
              type="number"
              min={1}
              max={16}
              value={config.parallelism ?? 5}
              onChange={(e) => updateField("parallelism", parseInt(e.target.value, 10))}
            />
          </label>
        </div>
      )}
    </div>
  );
}
