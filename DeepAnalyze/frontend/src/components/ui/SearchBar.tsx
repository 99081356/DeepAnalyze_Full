import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../utils/cn';

interface SearchBarProps {
  value?: string;
  onChange?: (value: string) => void;
  onSearch?: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function SearchBar({
  value: controlledValue,
  onChange,
  onSearch,
  placeholder = 'Search...',
  debounceMs = 300,
  className,
  style,
}: SearchBarProps) {
  const [internalValue, setInternalValue] = useState('');
  const isControlled = controlledValue !== undefined;
  const currentValue = isControlled ? controlledValue : internalValue;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;

      if (!isControlled) {
        setInternalValue(newValue);
      }

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (onChange) {
        debounceRef.current = setTimeout(() => {
          onChange(newValue);
        }, debounceMs);
      }
    },
    [isControlled, onChange, debounceMs]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && onSearch) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        onSearch(currentValue);
      }
      if (e.key === 'Escape') {
        if (!isControlled) {
          setInternalValue('');
        }
        if (onChange) {
          onChange('');
        }
        inputRef.current?.blur();
      }
    },
    [currentValue, onSearch, onChange, isControlled]
  );

  const handleClear = useCallback(() => {
    if (!isControlled) {
      setInternalValue('');
    }
    if (onChange) {
      onChange('');
    }
    if (onSearch) {
      onSearch('');
    }
    inputRef.current?.focus();
  }, [isControlled, onChange, onSearch]);

  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--border-focus)';
    e.currentTarget.style.background = 'var(--bg-primary)';
    e.currentTarget.style.boxShadow = '0 0 0 3px var(--brand-light)';
  }, []);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--border-primary)';
    e.currentTarget.style.background = 'var(--bg-tertiary)';
    e.currentTarget.style.boxShadow = 'none';
  }, []);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    ...style,
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    height: 36,
    padding: currentValue
      ? '0 var(--space-8) 0 36px'
      : '0 var(--space-4) 0 36px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-full)',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    outline: 'none',
    transition: 'all var(--transition-fast)',
  };

  const searchIconStyle: React.CSSProperties = {
    position: 'absolute',
    left: 12,
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'var(--text-tertiary)',
    pointerEvents: 'none',
    flexShrink: 0,
  };

  const clearButtonStyle: React.CSSProperties = {
    position: 'absolute',
    right: 4,
    top: '50%',
    transform: 'translateY(-50%)',
    display: currentValue ? 'flex' : 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: 'var(--radius-full)',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    outline: 'none',
    padding: 0,
  };

  return (
    <div className={cn('search-bar', className)} style={containerStyle}>
      <Search size={16} style={searchIconStyle} />
      <input
        ref={inputRef}
        type="text"
        value={currentValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        style={inputStyle}
        aria-label={placeholder}
      />
      <button
        onClick={handleClear}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-hover)';
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-tertiary)';
        }}
        style={clearButtonStyle}
        tabIndex={-1}
        aria-label="Clear search"
        type="button"
      >
        <X size={14} />
      </button>
    </div>
  );
}
