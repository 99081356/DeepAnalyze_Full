import React, { useCallback } from 'react';
import { cn } from '../../utils/cn';

type ToggleSize = 'sm' | 'md';

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: ToggleSize;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
}

const trackSizeMap: Record<ToggleSize, { width: number; height: number }> = {
  sm: { width: 32, height: 18 },
  md: { width: 40, height: 22 },
};

const thumbSizeMap: Record<ToggleSize, number> = {
  sm: 14,
  md: 18,
};

const thumbOffsetMap: Record<ToggleSize, number> = {
  sm: 2,
  md: 2,
};

export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  className,
  style,
  'aria-label': ariaLabel,
}: ToggleSwitchProps) {
  const track = trackSizeMap[size];
  const thumbSize = thumbSizeMap[size];
  const offset = thumbOffsetMap[size];
  const thumbTranslate = checked ? track.width - thumbSize - offset * 2 : 0;

  const handleClick = useCallback(() => {
    if (!disabled) {
      onChange(!checked);
    }
  }, [checked, disabled, onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!disabled) {
          onChange(!checked);
        }
      }
    },
    [checked, disabled, onChange]
  );

  const trackStyle: React.CSSProperties = {
    position: 'relative',
    width: track.width,
    height: track.height,
    borderRadius: 'var(--radius-full)',
    background: checked ? 'var(--brand-primary)' : 'var(--bg-tertiary)',
    border: checked
      ? '1px solid var(--brand-primary)'
      : '1px solid var(--border-secondary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background var(--transition-fast), border-color var(--transition-fast)',
    flexShrink: 0,
    outline: 'none',
    ...style,
  };

  const thumbStyle: React.CSSProperties = {
    position: 'absolute',
    top: offset,
    left: offset,
    width: thumbSize,
    height: thumbSize,
    borderRadius: 'var(--radius-full)',
    background: checked ? 'var(--brand-foreground)' : '#ffffff',
    transform: `translateX(${thumbTranslate}px)`,
    transition: 'transform var(--transition-fast), background var(--transition-fast)',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
  };

  return (
    <div
      className={cn('toggle-switch', className)}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      tabIndex={disabled ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={trackStyle}
    >
      <div style={thumbStyle} />
    </div>
  );
}
