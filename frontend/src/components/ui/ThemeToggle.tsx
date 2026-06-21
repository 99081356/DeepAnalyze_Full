import React, { useCallback } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { cn } from '../../utils/cn';

interface ThemeToggleProps {
  className?: string;
  style?: React.CSSProperties;
  size?: number;
}

export function ThemeToggle({ className, style, size = 18 }: ThemeToggleProps) {
  const { isDark, toggleTheme } = useTheme();

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'var(--bg-tertiary)';
    e.currentTarget.style.color = 'var(--text-primary)';
  }, []);

  const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'transparent';
    e.currentTarget.style.color = 'var(--text-secondary)';
  }, []);

  const buttonStyle: React.CSSProperties = {
    width: 34,
    height: 34,
    borderRadius: 'var(--radius-full)',
    border: '1px solid var(--border-primary)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all var(--transition-fast)',
    outline: 'none',
    ...style,
  };

  return (
    <button
      className={cn('theme-toggle', className)}
      onClick={toggleTheme}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      style={buttonStyle}
    >
      {isDark ? <Sun size={size} /> : <Moon size={size} />}
    </button>
  );
}
