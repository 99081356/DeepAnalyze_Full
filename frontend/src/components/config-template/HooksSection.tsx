// =============================================================================
// HooksSection — 生命周期钩子（列表 CRUD）
// =============================================================================
// hooks 是数组，每项描述一个钩子：event（27 个枚举之一）+ type（command/http/
// callback）+ matcher（glob）+ config（按 type 不同的子结构）。
// 字段对齐 DA 的 HookDefinition（DeepAnalyze/src/services/agent/hooks.ts:26）。
// =============================================================================

import { SectionCard } from "./SectionCard.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { Toggle } from "../ui/Toggle.js";
import { Button } from "../ui/Button.js";
import { Plus, Trash2 } from "lucide-react";
import {
  HOOK_EVENTS,
  type TemplateHook,
  type HookEvent,
  type HookKind,
} from "../../types/config-template.js";

const HOOK_TYPES: Array<{ value: HookKind; label: string }> = [
  { value: "command", label: "命令 (shell)" },
  { value: "http", label: "HTTP POST" },
  // callback 类型是进程内回调，模板下发无意义（不持久化），不暴露
];

export interface HooksSectionProps {
  value: TemplateHook[] | null | undefined;
  locked: boolean;
  onChange: (next: TemplateHook[] | null) => void;
  onLockChange: (locked: boolean) => void;
}

export function HooksSection({
  value,
  locked,
  onChange,
  onLockChange,
}: HooksSectionProps) {
  const list = value ?? [];

  const add = () => {
    const next: TemplateHook[] = [
      ...list,
      {
        id: `hook_${Date.now().toString(36)}`,
        event: "PreToolUse",
        type: "command",
        matcher: "*",
        config: { command: "" },
        enabled: true,
      },
    ];
    onChange(next);
  };

  const update = (idx: number, patch: Partial<TemplateHook>) => {
    const next = list.map((h, i) => (i === idx ? { ...h, ...patch } : h));
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
      title="生命周期钩子 (hooks)"
      description="在 Agent 执行的各阶段触发外部命令或 HTTP 回调。matcher 用 glob 匹配工具名。"
      lockKey="hooks"
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
          暂无钩子。点右上角「添加」新建。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {list.map((h, idx) => (
            <div key={h.id ?? idx} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  #{idx + 1} {h.id}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <Toggle
                    checked={h.enabled}
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
                <div>
                  <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)", marginBottom: "var(--space-1)" }}>
                    事件
                  </div>
                  <Select
                    value={h.event}
                    onChange={(v) => update(idx, { event: v as HookEvent })}
                    options={HOOK_EVENTS.map((e) => ({ value: e, label: e }))}
                    searchable
                    aria-label="事件"
                  />
                </div>
                <div>
                  <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)", marginBottom: "var(--space-1)" }}>
                    类型
                  </div>
                  <Select
                    value={h.type}
                    onChange={(v) => {
                      const kind = v as HookKind;
                      // 切换 type 时重置 config 子结构
                      const config =
                        kind === "command" ? { command: "" } : kind === "http" ? { url: "" } : {};
                      update(idx, { type: kind, config });
                    }}
                    options={HOOK_TYPES}
                    aria-label="类型"
                  />
                </div>
                <Input
                  label="matcher (glob)"
                  value={h.matcher ?? ""}
                  onChange={(e) => update(idx, { matcher: e.target.value || undefined })}
                  placeholder="* 匹配全部工具"
                />
              </div>
              {/* 按 type 显示不同的 config 输入 */}
              {h.type === "command" && (
                <Input
                  label="Shell 命令"
                  value={h.config?.command ?? ""}
                  onChange={(e) =>
                    update(idx, { config: { ...h.config, command: e.target.value } })
                  }
                  placeholder="可用环境变量 $TOOL_NAME $TASK_ID $HOOK_TYPE"
                />
              )}
              {h.type === "http" && (
                <Input
                  label="POST URL"
                  value={h.config?.url ?? ""}
                  onChange={(e) => update(idx, { config: { ...h.config, url: e.target.value } })}
                  placeholder="https://example.com/hook"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export default HooksSection;
