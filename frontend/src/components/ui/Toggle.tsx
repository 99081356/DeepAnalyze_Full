// =============================================================================
// Toggle — 受控开关组件
// =============================================================================
// Hub 前端此前无 Switch/Toggle 组件。配置模板表单的「字段启用」「强制覆盖」
// 等场景需要开关，原生 checkbox 视觉上不够清晰，故新增此组件。
//
// 样式与 Button/Badge 对齐：CSS 变量 + 内联 style，无 Tailwind。
// 参考 Worker 端 DeepAnalyze/frontend/src/components/ui/ToggleSwitch.tsx 的视觉
// 但独立实现，避免跨目录依赖。
// =============================================================================

import React from "react";

export interface ToggleProps {
  /** 当前是否开启 */
  checked: boolean;
  /** 切换回调 */
  onChange: (checked: boolean) => void;
  /** 标签（渲染在开关右侧） */
  label?: string;
  /** 尺寸 */
  size?: "sm" | "md";
  /** 禁用 */
  disabled?: boolean;
  /** 无障碍标签 */
  "aria-label"?: string;
}

const SIZES = {
  sm: {
    width: 32,
    height: 18,
    knob: 14,
    translate: 14,
  },
  md: {
    width: 40,
    height: 22,
    knob: 18,
    translate: 18,
  },
} as const;

export function Toggle({
  checked,
  onChange,
  label,
  size = "md",
  disabled = false,
  "aria-label": ariaLabel,
}: ToggleProps) {
  const s = SIZES[size];

  const wrapperStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    userSelect: "none",
  };

  const trackStyle: React.CSSProperties = {
    position: "relative",
    width: s.width,
    height: s.height,
    borderRadius: s.height,
    background: checked ? "var(--success)" : "var(--bg-tertiary)",
    border: `1px solid ${checked ? "var(--success)" : "var(--border-primary)"}`,
    transition: "background var(--transition-fast), border-color var(--transition-fast)",
    flexShrink: 0,
  };

  const knobStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: 1,
    width: s.knob,
    height: s.knob,
    borderRadius: "50%",
    background: "var(--bg-primary)",
    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
    transform: `translate(0, -50%)`,
    transition: "transform var(--transition-fast)",
    ...(checked ? { transform: `translate(${s.translate}px, -50%)` } : {}),
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-primary)",
  };

  return (
    <label style={wrapperStyle}>
      <span
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? label}
        style={trackStyle}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
      >
        <span style={knobStyle} />
      </span>
      {label && <span style={labelStyle}>{label}</span>}
    </label>
  );
}

export default Toggle;
