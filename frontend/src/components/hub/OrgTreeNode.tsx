import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Building2, Users } from 'lucide-react';
import { Badge } from '../ui/Badge.js';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface OrgTreeNodeData {
  id: string;
  name: string;
  code: string;
  type: string;
  level: number;
  user_count?: number;
  children?: OrgTreeNodeData[];
}

export interface OrgTreeNodeProps {
  node: OrgTreeNodeData;
  selectedId?: string;
  onSelect?: (node: OrgTreeNodeData) => void;
  defaultExpanded?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Type label mapping                                                        */
/* -------------------------------------------------------------------------- */

const TYPE_LABELS: Record<string, string> = {
  group: '集团',
  company: '公司',
  department: '部门',
  team: '团队',
};

function getTypeLabel(type: string): string {
  return TYPE_LABELS[type] || type;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function OrgTreeNode({
  node,
  selectedId,
  onSelect,
  defaultExpanded = true,
}: OrgTreeNodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  };

  const handleSelect = () => {
    if (onSelect) {
      onSelect(node);
    }
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    paddingLeft: 'var(--space-3)',
    paddingRight: 'var(--space-3)',
    height: 36,
    cursor: 'pointer',
    borderRadius: 'var(--radius-md)',
    background: isSelected ? 'var(--brand-light)' : 'transparent',
    color: isSelected ? 'var(--brand-primary)' : 'var(--text-primary)',
    fontWeight: isSelected ? 600 : 400,
    transition: 'background var(--transition-fast)',
    userSelect: 'none',
  };

  const chevronStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    flexShrink: 0,
    cursor: hasChildren ? 'pointer' : 'default',
    color: 'var(--text-tertiary)',
  };

  const iconStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: 'var(--text-secondary)',
  };

  const nameStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  };

  const codeStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono, monospace)',
    flexShrink: 0,
  };

  const userCountStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: 'var(--text-xs)',
    color: 'var(--text-tertiary)',
    flexShrink: 0,
  };

  const childrenContainerStyle: React.CSSProperties = {
    paddingLeft: 24,
  };

  return (
    <div style={containerStyle}>
      {/* Node row */}
      <div
        style={rowStyle}
        onClick={handleSelect}
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
      >
        {/* Expand/collapse chevron */}
        <span style={chevronStyle} onClick={hasChildren ? handleToggle : undefined}>
          {hasChildren ? (
            expanded ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )
          ) : null}
        </span>

        {/* Type icon */}
        <span style={iconStyle}>
          <Building2 size={16} />
        </span>

        {/* Node name */}
        <span style={nameStyle}>{node.name}</span>

        {/* Code */}
        {node.code && <span style={codeStyle}>{node.code}</span>}

        {/* Type badge */}
        <Badge variant="default" size="sm">
          {getTypeLabel(node.type)}
        </Badge>

        {/* User count */}
        {node.user_count !== undefined && node.user_count > 0 && (
          <span style={userCountStyle}>
            <Users size={12} />
            {node.user_count}
          </span>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div style={childrenContainerStyle}>
          {node.children!.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              defaultExpanded={defaultExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default OrgTreeNode;
