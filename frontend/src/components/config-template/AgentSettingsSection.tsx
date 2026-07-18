// =============================================================================
// AgentSettingsSection — Agent 运行参数表单
// =============================================================================
// 9 个常用字段，每个用 Select 离散选项（照搬 Worker SettingsPanel 的选项集）。
// 字段值可选：undefined 表示「不写入模板」（sync 时跳过该字段）。
//
// 选项集来源：DeepAnalyze/frontend/src/components/settings/SettingsPanel.tsx
// 的 agent settings select 选项。
// =============================================================================

import { SectionCard } from "./SectionCard.js";
import { Select } from "../ui/Select.js";
import type {
  TemplateAgentSettings,
} from "../../types/config-template.js";

// 选项集（value 是实际写入模板的数值，label 是显示文本）
const OPTIONS = {
  maxTurns: [
    { value: "-1", label: "无限制 (-1)" },
    { value: "100", label: "100" },
    { value: "500", label: "500" },
    { value: "1000", label: "1000" },
    { value: "9999", label: "9999" },
  ],
  contextWindow: [
    { value: "32000", label: "32K" },
    { value: "64000", label: "64K" },
    { value: "128000", label: "128K" },
    { value: "200000", label: "200K" },
    { value: "256000", label: "256K" },
    { value: "512000", label: "512K" },
    { value: "1048576", label: "1M" },
    { value: "2097152", label: "2M" },
  ],
  outputTokenBudget: [
    { value: "0", label: "0 (不限)" },
    { value: "8192", label: "8K" },
    { value: "16384", label: "16K" },
    { value: "32768", label: "32K" },
    { value: "65536", label: "64K" },
    { value: "131072", label: "128K" },
  ],
  compactionBuffer: [
    { value: "8192", label: "8K" },
    { value: "13000", label: "13K" },
    { value: "20480", label: "20K" },
    { value: "30720", label: "30K" },
  ],
  toolResultMaxTokens: [
    { value: "4096", label: "4K" },
    { value: "8192", label: "8K" },
    { value: "16384", label: "16K" },
    { value: "32768", label: "32K" },
    { value: "65536", label: "64K" },
  ],
  subAgentMaxTurns: [
    { value: "50", label: "50" },
    { value: "100", label: "100" },
    { value: "200", label: "200" },
    { value: "300", label: "300" },
    { value: "500", label: "500" },
  ],
  consecutiveErrorThreshold: [
    { value: "2", label: "2" },
    { value: "3", label: "3" },
    { value: "5", label: "5" },
    { value: "8", label: "8" },
    { value: "10", label: "10" },
  ],
  stuckDetectionThreshold: [
    { value: "3", label: "3" },
    { value: "5", label: "5" },
    { value: "8", label: "8" },
    { value: "10", label: "10" },
    { value: "15", label: "15" },
  ],
} as const;

// 字段定义：key + label + 选项 + 说明
const FIELDS: Array<{
  key: keyof TemplateAgentSettings;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  hint?: string;
}> = [
  { key: "maxTurns", label: "最大轮数", options: OPTIONS.maxTurns, hint: "Agent 单次任务最多调用多少轮工具" },
  { key: "contextWindow", label: "上下文窗口", options: OPTIONS.contextWindow, hint: "Token 预算上限" },
  { key: "outputTokenBudget", label: "输出 Token 预算", options: OPTIONS.outputTokenBudget },
  { key: "compactionBuffer", label: "压缩缓冲区", options: OPTIONS.compactionBuffer, hint: "触发上下文压缩的阈值" },
  { key: "toolResultMaxTokens", label: "工具结果上限", options: OPTIONS.toolResultMaxTokens },
  { key: "subAgentMaxTurns", label: "子 Agent 最大轮数", options: OPTIONS.subAgentMaxTurns },
  { key: "consecutiveErrorThreshold", label: "连续错误阈值", options: OPTIONS.consecutiveErrorThreshold, hint: "连续失败多少次后中止" },
  { key: "stuckDetectionThreshold", label: "卡死检测阈值", options: OPTIONS.stuckDetectionThreshold },
];

export interface AgentSettingsSectionProps {
  value: TemplateAgentSettings | null | undefined;
  locked: boolean;
  onChange: (next: TemplateAgentSettings | null) => void;
  onLockChange: (locked: boolean) => void;
}

export function AgentSettingsSection({
  value,
  locked,
  onChange,
  onLockChange,
}: AgentSettingsSectionProps) {
  const settings = value ?? {};

  const updateField = (key: keyof TemplateAgentSettings, raw: string) => {
    // 空字符串 = 清除该字段（不写入模板）
    const next: TemplateAgentSettings = { ...settings };
    if (raw === "") {
      delete next[key];
    } else {
      next[key] = Number(raw) as never;
    }
    onChange(Object.keys(next).length > 0 ? next : null);
  };

  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
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

  const hintStyle: React.CSSProperties = {
    fontSize: 11,
    color: "var(--text-tertiary)",
  };

  return (
    <SectionCard
      title="Agent 运行参数"
      description="控制 Agent 的轮数、上下文、压缩等行为。留空 = 不下发此字段。"
      lockKey="agentSettings"
      locked={locked}
      onLockChange={onLockChange}
    >
      <div style={gridStyle}>
        {FIELDS.map((f) => {
          const v = settings[f.key];
          return (
            <div key={f.key} style={fieldStyle}>
              <label style={labelStyle}>{f.label}</label>
              <Select
                value={v !== undefined ? String(v) : ""}
                onChange={(val) => updateField(f.key, val)}
                options={[
                  { value: "", label: "（不下发）" },
                  ...f.options,
                ]}
                aria-label={f.label}
              />
              {f.hint && <span style={hintStyle}>{f.hint}</span>}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

export default AgentSettingsSection;
