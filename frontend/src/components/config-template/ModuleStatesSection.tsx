// =============================================================================
// ModuleStatesSection — 4 个本地模块状态表单
// =============================================================================
// embedding / asr / docling / mineru 四个固定模块，每个选 mode：
//   - disabled：禁用（不下发该模块配置）
//   - local：本地部署
//   - remote：远端 API（需填 endpoint）
//
// 锁定粒度特殊：每个模块单独锁定，lockKey = "moduleStates.<id>"。
// sync-from-hub.ts 对 moduleStates 用前缀匹配，所以也可锁 "moduleStates" 整体，
// 但表单按模块粒度暴露更直观。
// =============================================================================

import { SectionCard } from "./SectionCard.js";
import { Input } from "../ui/Input.js";
import {
  TEMPLATE_MODULES,
  type ModuleStateTemplate,
} from "../../types/config-template.js";

export interface ModuleStatesSectionProps {
  value: Record<string, ModuleStateTemplate> | null | undefined;
  /** 各模块的锁定状态（key = "moduleStates.<id>"） */
  lockedMap: Record<string, boolean>;
  onChange: (next: Record<string, ModuleStateTemplate> | null) => void;
  onLockChange: (moduleId: string, locked: boolean) => void;
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
}: ModuleStatesSectionProps) {
  const states = value ?? {};

  const updateModule = (moduleId: string, patch: Partial<ModuleStateTemplate>) => {
    const next = { ...states };
    const cur = next[moduleId] ?? {};
    const merged = { ...cur, ...patch };
    // mode=disabled 或空对象时清除
    if (patch.mode === "disabled") {
      delete next[moduleId];
    } else {
      next[moduleId] = merged;
    }
    onChange(Object.keys(next).length > 0 ? next : null);
  };

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

  return (
    <SectionCard
      title="本地模块状态"
      description="embedding / asr / docling / mineru 四个模块的部署模式。每个模块可单独锁定。"
    >
      <div style={gridStyle}>
        {TEMPLATE_MODULES.map((m) => {
          const st = states[m.id] ?? {};
          const mode = st.mode ?? "disabled";
          const lockKey = `moduleStates.${m.id}`;
          const isLocked = lockedMap[lockKey] ?? false;
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
                <Input
                  label="远端 Endpoint"
                  value={st.endpoint ?? ""}
                  onChange={(e) => updateModule(m.id, { endpoint: e.target.value })}
                  placeholder="http://host:port"
                />
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

export default ModuleStatesSection;
