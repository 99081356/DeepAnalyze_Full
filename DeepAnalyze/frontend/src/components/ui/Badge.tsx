import React from 'react';
import { cn } from '../../utils/cn';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';
type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const variantStyles: Record<BadgeVariant, React.CSSProperties> = {
  default: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-primary)',
  },
  success: {
    background: 'var(--success-light)',
    color: 'var(--success-dark)',
    border: '1px solid transparent',
  },
  warning: {
    background: 'var(--warning-light)',
    color: 'var(--warning-dark)',
    border: '1px solid transparent',
  },
  error: {
    background: 'var(--error-light)',
    color: 'var(--error-dark)',
    border: '1px solid transparent',
  },
  info: {
    background: 'var(--info-light)',
    color: 'var(--info-dark)',
    border: '1px solid transparent',
  },
};

const sizeStyles: Record<BadgeSize, React.CSSProperties> = {
  sm: {
    height: 20,
    padding: '0 var(--space-2)',
    fontSize: 'var(--text-xs)',
    lineHeight: '20px',
    letterSpacing: '0.01em',
  },
  md: {
    height: 24,
    padding: '0 var(--space-3)',
    fontSize: 'var(--text-sm)',
    lineHeight: '24px',
    letterSpacing: '0.01em',
  },
};

export function Badge({
  variant = 'default',
  size = 'sm',
  children,
  className,
  style,
}: BadgeProps) {
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-full)',
    fontWeight: 'var(--font-medium)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    verticalAlign: 'middle',
    ...variantStyles[variant],
    ...sizeStyles[size],
    ...style,
  };

  return (
    <span className={cn('badge', className)} style={baseStyle}>
      {children}
    </span>
  );
}
