// =============================================================================
// EnhancedModelsSection — 图像/视频/音乐/语音生成模型（列表 CRUD）
// =============================================================================
// enhancedModels 是数组，每项描述一个生成模型（image_gen/video_gen/music_gen/
// tts/audio_gen）关联到某个 provider。表单提供列表 + 增删改。
// 字段对齐 DA 的 EnhancedModelEntry（DeepAnalyze/frontend/src/types/index.ts）。
// =============================================================================

import { SectionCard } from "./SectionCard.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Toggle } from "../ui/Toggle.js";
import { Button } from "../ui/Button.js";
import { Plus, Trash2 } from "lucide-react";
import type {
  TemplateEnhancedModel,
  EnhancedModelType,
} from "../../types/config-template.js";

const MODEL_TYPES: Array<{ value: EnhancedModelType; label: string }> = [
  { value: "image_gen", label: "图像生成" },
  { value: "video_gen", label: "视频生成" },
  { value: "music_gen", label: "音乐生成" },
  { value: "tts", label: "语音合成 (TTS)" },
  { value: "audio_gen", label: "音频生成" },
];

export interface EnhancedModelsSectionProps {
  value: TemplateEnhancedModel[] | null | undefined;
  locked: boolean;
  onChange: (next: TemplateEnhancedModel[] | null) => void;
  onLockChange: (locked: boolean) => void;
}

export function EnhancedModelsSection({
  value,
  locked,
  onChange,
  onLockChange,
}: EnhancedModelsSectionProps) {
  const list = value ?? [];

  const add = () => {
    const next = [
      ...list,
      {
        id: `em_${Date.now().toString(36)}`,
        modelType: "image_gen" as EnhancedModelType,
        name: "",
        providerId: "",
        model: "",
        enabled: true,
        priority: 1,
      },
    ];
    onChange(next);
  };

  const update = (idx: number, patch: Partial<TemplateEnhancedModel>) => {
    const next = list.map((m, i) => (i === idx ? { ...m, ...patch } : m));
    onChange(next);
  };

  const remove = (idx: number) => {
    const next = list.filter((_, i) => i !== idx);
    onChange(next.length > 0 ? next : null);
  };

  const cardStyle: React.CSSProperties = {
    padding: "var(--space-3)",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr auto",
    gap: "var(--space-2)",
    alignItems: "end",
  };

  return (
    <SectionCard
      title="生成模型 (enhancedModels)"
      description="图像/视频/音乐/语音生成模型列表，每个关联到某个 provider。"
      lockKey="enhancedModels"
      locked={locked}
      onLockChange={onLockChange}
      actions={
        <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={add}>
          添加
        </Button>
      }
    >
      {list.length === 0 ? (
        <div style={{ color: "var(--text-tertiary)", fontSize: 13, padding: "var(--space-2)" }}>
          暂无生成模型。点右上角「添加」新建。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {list.map((m, idx) => (
            <div key={m.id ?? idx} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  #{idx + 1} {m.id}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <Toggle
                    checked={m.enabled}
                    onChange={(c) => update(idx, { enabled: c })}
                    size="sm"
                    aria-label="启用"
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    onClick={() => remove(idx)}
                  />
                </div>
              </div>
              <div style={rowStyle}>
                <Input
                  label="名称"
                  value={m.name}
                  onChange={(e) => update(idx, { name: e.target.value })}
                  placeholder="例如 MiniMax Image Gen"
                />
                <div>
                  <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)", marginBottom: "var(--space-1)" }}>
                    类型
                  </div>
                  <Select
                    value={m.modelType}
                    onChange={(v) => update(idx, { modelType: v as EnhancedModelType })}
                    options={MODEL_TYPES}
                    aria-label="类型"
                  />
                </div>
                <Input
                  label="模型 ID"
                  value={m.model}
                  onChange={(e) => update(idx, { model: e.target.value })}
                  placeholder="例如 image-01"
                />
              </div>
              <div style={rowStyle}>
                <Input
                  label="Provider ID"
                  value={m.providerId}
                  onChange={(e) => update(idx, { providerId: e.target.value })}
                  placeholder="关联到上方 providers[].id"
                />
                <Input
                  label="优先级"
                  type="number"
                  value={String(m.priority ?? 1)}
                  onChange={(e) => update(idx, { priority: parseInt(e.target.value, 10) || 1 })}
                />
                <Input
                  label="最大 Tokens"
                  type="number"
                  value={String(m.maxTokens ?? 0)}
                  onChange={(e) => update(idx, { maxTokens: parseInt(e.target.value, 10) || undefined })}
                />
              </div>
              <Input
                label="描述（可选）"
                value={m.description ?? ""}
                onChange={(e) => update(idx, { description: e.target.value || undefined })}
                placeholder="模型说明"
              />
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export default EnhancedModelsSection;
