import React, { forwardRef } from 'react';
import { cn } from '../../utils/cn';
import { Spinner } from './Spinner';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size preset */
  size?: ButtonSize;
  /** Show a loading spinner and disable interaction */
  loading?: boolean;
  /** Icon rendered beside the label */
  icon?: React.ReactNode;
  /** Icon placement relative to children */
  iconPosition?: 'left' | 'right';
}

/* -------------------------------------------------------------------------- */
/*  Style maps                                                                */
/* -------------------------------------------------------------------------- */

const baseStyles: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-2)',
  fontWeight: 'var(--font-medium)' as unknown as number,
  borderRadius: 'var(--radius-md)',
  transition: `all var(--transition-fast)`,
  cursor: 'pointer',
  border: 'none',
  outline: 'none',
  lineHeight: 'var(--leading-tight)' as unknown as number,
  whiteSpace: 'nowrap' as const,
  userSelect: 'none' as const,
  position: 'relative' as const,
};

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--brand-primary)',
    color: 'var(--brand-foreground)',
    boxShadow: 'var(--shadow-sm)',
  },
  secondary: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-primary)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-secondary)',
  },
  danger: {
    background: 'var(--error)',
    color: '#ffffff',
    boxShadow: 'var(--shadow-sm)',
  },
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: {
    height: '30px',
    padding: '0 var(--space-2)',
    fontSize: 'var(--text-xs)',
  },
  md: {
    height: '36px',
    padding: '0 var(--space-3)',
    fontSize: 'var(--text-sm)',
  },
  lg: {
    height: '42px',
    padding: '0 var(--space-4)',
    fontSize: 'var(--text-base)',
  },
};

/* -------------------------------------------------------------------------- */
/*  Variant hover classes (managed via CSS classes for pseudo-selectors)      */
/* -------------------------------------------------------------------------- */

const variantHoverClass: Record<ButtonVariant, string> = {
  primary: 'btn-hover-primary',
  secondary: 'btn-hover-secondary',
  ghost: 'btn-hover-ghost',
  danger: 'btn-hover-danger',
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled = false,
      icon,
      iconPosition = 'left',
      className,
      children,
      style,
      ...rest
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;

    const mergedStyle: React.CSSProperties = {
      ...baseStyles,
      ...variantStyles[variant],
      ...sizeStyles[size],
      ...(isDisabled
        ? {
            opacity: 0.5,
            cursor: 'not-allowed',
            pointerEvents: 'none' as const,
          }
        : {}),
      ...style,
    };

    return (
      <button
        ref={ref}
        className={cn(
          'da-button',
          variantHoverClass[variant],
          className,
        )}
        style={mergedStyle}
        disabled={isDisabled}
        aria-busy={loading}
        {...rest}
      >
        {loading && (
          <Spinner
            size={size === 'sm' ? 'sm' : 'sm'}
            color="currentColor"
          />
        )}
        {!loading && icon && iconPosition === 'left' && (
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            {icon}
          </span>
        )}
        {children && <span>{children}</span>}
        {!loading && icon && iconPosition === 'right' && (
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            {icon}
          </span>
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';

export default Button;
