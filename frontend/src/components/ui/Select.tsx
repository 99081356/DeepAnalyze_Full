import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useId,
} from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Input } from './Input';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value?: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  searchable = false,
  disabled = false,
  className,
  style,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const buttonId = useId();

  const selectedOption = options.find((opt) => opt.value === value);

  const filteredOptions =
    searchable && searchQuery
      ? options.filter((opt) =>
          opt.label.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : options;

  const handleToggle = useCallback(() => {
    if (disabled) return;
    setIsOpen((prev) => !prev);
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [disabled, isOpen]);

  const handleSelect = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setIsOpen(false);
      setSearchQuery('');
    },
    [onChange]
  );

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (
      containerRef.current &&
      !containerRef.current.contains(e.target as Node)
    ) {
      setIsOpen(false);
      setSearchQuery('');
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      if (searchable && searchInputRef.current) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
        });
      }
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, searchable, handleClickOutside]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setSearchQuery('');
      } else if (e.key === 'Enter' && !isOpen) {
        handleToggle();
      }
    },
    [isOpen, handleToggle]
  );

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    flexDirection: 'column',
    minWidth: 160,
    ...style,
  };

  const triggerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 36,
    padding: '0 var(--space-3)',
    background: 'var(--bg-primary)',
    border: `1px solid ${isOpen ? 'var(--border-focus)' : 'var(--border-primary)'}`,
    borderRadius: 'var(--radius-md)',
    color: selectedOption ? 'var(--text-primary)' : 'var(--text-tertiary)',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition:
      'border-color var(--transition-fast), box-shadow var(--transition-fast)',
    outline: 'none',
    boxShadow: isOpen ? '0 0 0 3px var(--brand-light)' : 'none',
    width: '100%',
  };

  const dropdownStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    background: 'var(--surface-primary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 'var(--z-dropdown)',
    overflow: 'hidden',
    display: isOpen ? 'flex' : 'none',
    flexDirection: 'column',
    maxHeight: 280,
  };

  const searchWrapperStyle: React.CSSProperties = {
    display: searchable ? 'block' : 'none',
    padding: 'var(--space-2)',
    borderBottom: '1px solid var(--border-primary)',
    background: 'var(--bg-secondary)',
  };

  const listStyle: React.CSSProperties = {
    overflowY: 'auto',
    padding: 'var(--space-1) 0',
    flex: 1,
  };

  const optionStyle = (isSelected: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-3)',
    fontSize: 'var(--text-sm)',
    color: isSelected ? 'var(--brand-primary)' : 'var(--text-primary)',
    background: isSelected ? 'var(--brand-light)' : 'transparent',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    fontWeight: isSelected ? 'var(--font-medium)' : 'var(--font-normal)',
  });

  const emptyStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--space-4) var(--space-3)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-tertiary)',
  };

  return (
    <div
      className={cn('select', className)}
      style={containerStyle}
      ref={containerRef}
      onKeyDown={handleKeyDown}
    >
      <button
        id={buttonId}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        style={triggerStyle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-labelledby={buttonId}
        aria-label={ariaLabel}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          size={16}
          style={{
            color: 'var(--text-tertiary)',
            flexShrink: 0,
            transition: 'transform var(--transition-fast)',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      <div
        style={dropdownStyle}
        role="listbox"
        id={listboxId}
        aria-labelledby={buttonId}
      >
        {/* Search input using the Input component */}
        {searchable && (
          <div style={searchWrapperStyle}>
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              prefix={<Search size={14} />}
              suffix={
                searchQuery ? (
                  <button
                    onClick={() => setSearchQuery('')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      padding: 0,
                      outline: 'none',
                    }}
                    tabIndex={-1}
                    aria-label="Clear search"
                    type="button"
                  >
                    <X size={14} />
                  </button>
                ) : undefined
              }
              aria-label="Search options"
            />
          </div>
        )}

        {/* Options list */}
        <div style={listStyle}>
          {filteredOptions.length === 0 ? (
            <div style={emptyStyle}>No options found</div>
          ) : (
            filteredOptions.map((option) => {
              const isSelected = option.value === value;
              return (
                <div
                  key={option.value}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelect(option.value)}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = 'var(--bg-hover)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = 'transparent';
                    }
                  }}
                  style={optionStyle(isSelected)}
                >
                  {option.label}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
