// =============================================================================
// MinerUSection — MinerU 远端解析配置表单
// =============================================================================
// 对齐 DA 的 MinerUConfig（DeepAnalyze/src/services/document-processors/
// mineru-client.ts:16-33），8 个字段：apiUrl/defaultBackend/defaultLang/
// formulaEnable/tableEnable/imageAnalysis/timeout/enabled。
//
// 模板下发后，Worker 的 sync-from-hub.ts 会整体写入 settings.mineru_config
// （SYNC_KEYS 已加 mineruConfig，SETTINGS_KEY_MAP 映射到 mineru_config）。
// 字段值 undefined = 不下发。
// =============================================================================

import { SectionCard } from "./SectionCard.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Toggle } from "../ui/Toggle.js";
import type { TemplateMinerUConfig } from "../../types/config-template.js";

const BACKENDS = [
  { value: "", label: "（不下发）" },
  { value: "hybrid-auto-engine", label: "Hybrid 自动 (推荐)" },
  { value: "pipeline", label: "Pipeline" },
  { value: "vlm-auto-engine", label: "VLM 自动" },
];

const LANGS = [
  { value: "", label: "（不下发）" },
  { value: "ch", label: "中文" },
  { value: "en", label: "英文" },
  { value: "japan", label: "日文" },
  { value: "korean", label: "韩文" },
];

export interface MinerUSectionProps {
  value: TemplateMinerUConfig | null | undefined;
  locked: boolean;
  onChange: (next: TemplateMinerUConfig | null) => void;
  onLockChange: (locked: boolean) => void;
}

export function MinerUSection({
  value,
  locked,
  onChange,
  onLockChange,
}: MinerUSectionProps) {
  const cfg = value ?? {};

  const update = (patch: Partial<TemplateMinerUConfig>) => {
    const next: TemplateMinerUConfig = { ...cfg, ...patch };
    for (const k of Object.keys(next) as Array<keyof TemplateMinerUConfig>) {
      if (next[k] === undefined) delete next[k];
    }
    onChange(Object.keys(next).length > 0 ? next : null);
  };

  const gridStyle: React.CSSProperties = {
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

  return (
    <SectionCard
      title="MinerU 解析配置 (mineruConfig)"
      description="MinerU 远端解析服务的地址、后端、语言、识别选项。下发后整体写入 worker 的 settings.mineru_config。"
      lockKey="mineruConfig"
      locked={locked}
      onLockChange={onLockChange}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <Input
          label="API 地址 (apiUrl)"
          value={cfg.apiUrl ?? ""}
          onChange={(e) => update({ apiUrl: e.target.value || undefined })}
          placeholder="http://127.0.0.1:8001"
        />

        <div style={gridStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>默认后端 (defaultBackend)</label>
            <Select
              value={cfg.defaultBackend ?? ""}
              onChange={(v) => update({ defaultBackend: v || undefined })}
              options={BACKENDS}
              aria-label="默认后端"
            />
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>默认语言 (defaultLang)</label>
            <Select
              value={cfg.defaultLang ?? ""}
              onChange={(v) => update({ defaultLang: v || undefined })}
              options={LANGS}
              aria-label="默认语言"
            />
          </div>
          <Input
            label="超时秒数 (timeout)"
            type="number"
            value={String(cfg.timeout ?? 0)}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              update({ timeout: n > 0 ? n : undefined });
            }}
          />
        </div>

        {/* 识别选项开关组 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "var(--space-3)",
            padding: "var(--space-3)",
            background: "var(--bg-secondary)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <Toggle
            checked={cfg.enabled === true}
            onChange={(c) => update({ enabled: c || undefined })}
            label="启用 (enabled)"
            aria-label="启用"
          />
          <Toggle
            checked={cfg.formulaEnable === true}
            onChange={(c) => update({ formulaEnable: c || undefined })}
            label="公式识别 (formulaEnable)"
            aria-label="公式识别"
          />
          <Toggle
            checked={cfg.tableEnable === true}
            onChange={(c) => update({ tableEnable: c || undefined })}
            label="表格识别 (tableEnable)"
            aria-label="表格识别"
          />
          <Toggle
            checked={cfg.imageAnalysis === true}
            onChange={(c) => update({ imageAnalysis: c || undefined })}
            label="图片分析 (imageAnalysis)"
            aria-label="图片分析"
          />
        </div>
      </div>
    </SectionCard>
  );
}

export default MinerUSection;
