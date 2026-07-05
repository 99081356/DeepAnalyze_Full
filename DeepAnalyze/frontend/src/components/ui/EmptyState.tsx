import React from 'react';
import { cn } from '../../utils/cn';
import { Button } from './Button';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface EmptyStateProps {
  /** Icon displayed above the title */
  icon?: React.ReactNode;
  /** Primary heading */
  title: string;
  /** Supporting description */
  description?: string;
  /** Optional action button label */
  actionLabel?: string;
  /** Fired when the action button is clicked */
  onAction?: () => void;
  /** Additional class */
  className?: string;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  className,
}) => {
  const wrapperStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 'var(--space-10) var(--space-6)',
    width: '100%',
  };

  const iconWrapStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '56px',
    height: '56px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-tertiary)',
    marginBottom: 'var(--space-4)',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: 'var(--text-lg)',
    fontWeight: 'var(--font-semibold)' as unknown as number,
    color: 'var(--text-primary)',
    lineHeight: 'var(--leading-tight)' as unknown as number,
    margin: 0,
  };

  const descStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-secondary)',
    lineHeight: 'var(--leading-relaxed)' as unknown as number,
    margin: 0,
    marginTop: 'var(--space-2)',
    maxWidth: '360px',
  };

  return (
    <div className={cn('da-empty-state', className)} style={wrapperStyle}>
      {icon && <span style={iconWrapStyle}>{icon}</span>}

      <h3 style={titleStyle}>{title}</h3>

      {description && <p style={descStyle}>{description}</p>}

      {actionLabel && onAction && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <Button variant="secondary" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
};

export default EmptyState;
