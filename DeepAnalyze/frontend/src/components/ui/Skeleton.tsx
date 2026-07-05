import React from 'react';
import { cn } from '../../utils/cn';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type SkeletonVariant = 'text' | 'circle' | 'rect';

export interface SkeletonProps {
  /** Shape variant */
  variant?: SkeletonVariant;
  /** Width – any CSS value (px, %, etc.) */
  width?: number | string;
  /** Height – any CSS value (px, %, etc.) */
  height?: number | string;
  /** Additional CSS class names */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export const Skeleton: React.FC<SkeletonProps> = ({
  variant = 'text',
  width,
  height,
  className,
  style,
}) => {
  const baseStyle: React.CSSProperties = {
    display: 'block',
    background: 'var(--bg-tertiary)',
    borderRadius:
      variant === 'circle'
        ? 'var(--radius-full)'
        : variant === 'text'
          ? 'var(--radius-sm)'
          : 'var(--radius-md)',
    width: width ?? (variant === 'text' ? '100%' : undefined),
    height: height ?? (variant === 'text' ? '16px' : variant === 'circle' ? '40px' : '80px'),
    ...style,
  };

  return (
    <div
      className={cn('animate-shimmer', className)}
      style={baseStyle}
      role="status"
      aria-label="Loading"
      aria-busy="true"
    />
  );
};

export default Skeleton;
