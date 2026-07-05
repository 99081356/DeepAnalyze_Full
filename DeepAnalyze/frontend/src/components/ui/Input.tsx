import React, { forwardRef } from 'react';
import { cn } from '../../utils/cn';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'size'> {
  /** Label rendered above the input */
  label?: string;
  /** Error message rendered below the input */
  error?: string;
  /** Hint text rendered below the input (hidden when error is set) */
  hint?: string;
  /** Element rendered inside the input on the left (e.g. search icon) */
  prefix?: React.ReactNode;
  /** Element rendered inside the input on the right (e.g. clear button) */
  suffix?: React.ReactNode;
  /** Additional wrapper class */
  wrapperClassName?: string;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      prefix,
      suffix,
      className,
      wrapperClassName,
      disabled,
      id,
      style,
      ...rest
    },
    ref,
  ) => {
    const inputId = id ?? (label ? `input-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);

    const wrapperStyle: React.CSSProperties = {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-1)',
      width: '100%',
    };

    const labelStyle: React.CSSProperties = {
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--font-medium)' as unknown as number,
      color: 'var(--text-primary)',
      lineHeight: 'var(--leading-tight)' as unknown as number,
    };

    const inputBoxStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-2)',
      background: disabled ? 'var(--bg-tertiary)' : 'var(--bg-primary)',
      border: `1px solid ${error ? 'var(--error)' : 'var(--border-primary)'}`,
      borderRadius: 'var(--radius-md)',
      padding: `0 var(--space-3)`,
      height: '36px',
      transition: `border-color var(--transition-fast), box-shadow var(--transition-fast), background var(--transition-fast)`,
    };

    const inputStyle: React.CSSProperties = {
      flex: 1,
      background: 'transparent',
      border: 'none',
      outline: 'none',
      fontSize: 'var(--text-sm)',
      color: disabled ? 'var(--text-disabled)' : 'var(--text-primary)',
      lineHeight: 'var(--leading-normal)' as unknown as number,
      width: '100%',
      height: '100%',
      fontFamily: 'var(--font-sans)',
    };

    const messageStyle: React.CSSProperties = {
      fontSize: 'var(--text-xs)',
      lineHeight: 'var(--leading-normal)' as unknown as number,
      color: error ? 'var(--error)' : 'var(--text-tertiary)',
      marginTop: 'var(--space-0)',
    };

    const handleFocus = (e: React.FocusEvent<HTMLDivElement>) => {
      const box = e.currentTarget;
      if (!error) {
        box.style.borderColor = 'var(--interactive)';
        box.style.boxShadow = `0 0 0 3px rgba(59, 130, 246, 0.12)`;
      } else {
        box.style.boxShadow = `0 0 0 3px rgba(239, 68, 68, 0.12)`;
      }
    };

    const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
      const box = e.currentTarget;
      box.style.borderColor = error ? 'var(--error)' : 'var(--border-primary)';
      box.style.boxShadow = 'none';
    };

    return (
      <div className={wrapperClassName} style={wrapperStyle}>
        {label && (
          <label htmlFor={inputId} style={labelStyle}>
            {label}
          </label>
        )}

        <div
          className={cn('da-input-box', error && 'da-input-error')}
          style={inputBoxStyle}
          onFocus={handleFocus}
          onBlur={handleBlur}
        >
          {prefix && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--text-tertiary)',
                flexShrink: 0,
              }}
            >
              {prefix}
            </span>
          )}

          <input
            ref={ref}
            id={inputId}
            className={cn('da-input', className)}
            style={{ ...inputStyle, ...style }}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
            {...rest}
          />

          {suffix && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--text-tertiary)',
                flexShrink: 0,
              }}
            >
              {suffix}
            </span>
          )}
        </div>

        {error && (
          <span id={`${inputId}-error`} style={messageStyle} role="alert">
            {error}
          </span>
        )}
        {!error && hint && (
          <span id={`${inputId}-hint`} style={messageStyle}>
            {hint}
          </span>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';

export default Input;
