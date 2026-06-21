import React, { useRef, useEffect, useState, useCallback } from 'react';
import { cn } from '../../utils/cn';

interface TabItem {
  key: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function Tabs({ items, activeKey, onChange, className, style }: TabsProps) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({
    left: 0,
    width: 0,
  });

  const updateIndicator = useCallback(() => {
    const activeTab = tabRefs.current.get(activeKey);
    if (activeTab) {
      const parent = activeTab.parentElement;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();
        setIndicatorStyle({
          left: tabRect.left - parentRect.left,
          width: tabRect.width,
        });
      }
    }
  }, [activeKey]);

  useEffect(() => {
    updateIndicator();
  }, [activeKey, items, updateIndicator]);

  useEffect(() => {
    window.addEventListener('resize', updateIndicator);
    return () => window.removeEventListener('resize', updateIndicator);
  }, [updateIndicator]);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    borderBottom: '1px solid var(--border-primary)',
    ...style,
  };

  const indicatorBase: React.CSSProperties = {
    position: 'absolute',
    bottom: -1,
    height: 2,
    background: 'var(--brand-primary)',
    borderRadius: 'var(--radius-full)',
    transition: 'left var(--transition-base), width var(--transition-base)',
    ...indicatorStyle,
  };

  return (
    <div className={cn('tabs', className)} style={containerStyle}>
      {items.map((item) => {
        const isActive = item.key === activeKey;
        return (
          <button
            key={item.key}
            ref={(el) => {
              if (el) {
                tabRefs.current.set(item.key, el);
              } else {
                tabRefs.current.delete(item.key);
              }
            }}
            onClick={() => onChange(item.key)}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'var(--space-3) var(--space-4)',
              border: 'none',
              background: 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontSize: 'var(--text-sm)',
              fontWeight: isActive ? 'var(--font-semibold)' : 'var(--font-medium)',
              cursor: 'pointer',
              transition: 'color var(--transition-fast)',
              whiteSpace: 'nowrap',
              outline: 'none',
              lineHeight: 'var(--leading-normal)',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--text-secondary)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--text-tertiary)';
              }
            }}
          >
            {item.label}
          </button>
        );
      })}
      <div style={indicatorBase} />
    </div>
  );
}
