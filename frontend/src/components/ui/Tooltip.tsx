import React, { useState, useCallback, useRef, useId } from 'react';
import { cn } from '../../utils/cn';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: string;
  position?: TooltipPosition;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  delayMs?: number;
}

function getPositionStyles(position: TooltipPosition): {
  tooltip: React.CSSProperties;
  arrow: React.CSSProperties;
} {
  const baseTooltip: React.CSSProperties = {
    position: 'absolute',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  };

  const baseArrow: React.CSSProperties = {
    position: 'absolute',
    width: 6,
    height: 6,
    transform: 'rotate(45deg)',
    background: 'var(--bg-inverse)',
  };

  switch (position) {
    case 'top':
      return {
        tooltip: {
          ...baseTooltip,
          bottom: 'calc(100% + 8px)',
          left: '50%',
          transform: 'translateX(-50%)',
        },
        arrow: {
          ...baseArrow,
          top: '100%',
          left: '50%',
          marginLeft: -3,
        },
      };
    case 'bottom':
      return {
        tooltip: {
          ...baseTooltip,
          top: 'calc(100% + 8px)',
          left: '50%',
          transform: 'translateX(-50%)',
        },
        arrow: {
          ...baseArrow,
          bottom: '100%',
          left: '50%',
          marginLeft: -3,
        },
      };
    case 'left':
      return {
        tooltip: {
          ...baseTooltip,
          right: 'calc(100% + 8px)',
          top: '50%',
          transform: 'translateY(-50%)',
        },
        arrow: {
          ...baseArrow,
          left: '100%',
          top: '50%',
          marginTop: -3,
        },
      };
    case 'right':
      return {
        tooltip: {
          ...baseTooltip,
          left: 'calc(100% + 8px)',
          top: '50%',
          transform: 'translateY(-50%)',
        },
        arrow: {
          ...baseArrow,
          right: '100%',
          top: '50%',
          marginTop: -3,
        },
      };
  }
}

export function Tooltip({
  content,
  position = 'top',
  children,
  className,
  style,
  delayMs = 200,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  const show = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setVisible(true);
    }, delayMs);
  }, [delayMs]);

  const hide = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setVisible(false);
  }, []);

  const positions = getPositionStyles(position);

  const wrapperStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    ...style,
  };

  const tooltipStyle: React.CSSProperties = {
    ...positions.tooltip,
    background: 'var(--bg-inverse)',
    color: 'var(--text-inverse)',
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--font-medium)',
    lineHeight: 'var(--leading-tight)',
    padding: 'var(--space-1) var(--space-2)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-md)',
    zIndex: 'var(--z-tooltip)',
    opacity: visible ? 1 : 0,
    transition: 'opacity var(--transition-fast)',
  };

  const arrowStyle: React.CSSProperties = {
    ...positions.arrow,
  };

  return (
    <div
      className={cn('tooltip-wrapper', className)}
      style={wrapperStyle}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      <div
        id={tooltipId}
        role="tooltip"
        style={tooltipStyle}
        aria-hidden={!visible}
      >
        {content}
        <div style={arrowStyle} />
      </div>
    </div>
  );
}
