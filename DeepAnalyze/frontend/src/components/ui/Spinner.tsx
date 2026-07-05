import React from 'react';
import { cn } from '../../utils/cn';

export interface SpinnerProps {
  /** Visual size */
  size?: 'sm' | 'md' | 'lg';
  /** Custom color – any valid CSS color string */
  color?: string;
  /** Additional CSS class names */
  className?: string;
}

const sizeMap: Record<NonNullable<SpinnerProps['size']>, number> = {
  sm: 16,
  md: 24,
  lg: 32,
};

export const Spinner: React.FC<SpinnerProps> = ({
  size = 'md',
  color,
  className,
}) => {
  const px = sizeMap[size];
  const strokeWidth = size === 'sm' ? 2.5 : 2;

  return (
    <svg
      className={cn('animate-spin', className)}
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
      style={{ animationDuration: '0.75s' }}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke={color ?? 'var(--text-tertiary)'}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        opacity={0.25}
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke={color ?? 'var(--text-primary)'}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
};

export default Spinner;
