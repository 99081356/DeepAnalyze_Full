import React from 'react';
import { Download } from 'lucide-react';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { SCOPE_LABEL, SCOPE_VARIANT } from './skill-constants.js';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SkillCardData {
  id: string;
  name: string;
  display_name: string;
  description: string;
  scope: 'system' | 'org' | 'user';
  category: string;
  tags: string[];
  icon: string;
  version: string;
  trust_level: string;
  author_name: string;
  subscriptions: number;
  is_kill_switched: boolean;
}

export interface SkillCardProps {
  skill: SkillCardData;
  onSubscribe?: () => void;
  onDetail?: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Color palette for icon backgrounds                                        */
/* -------------------------------------------------------------------------- */

const ICON_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
];

function getIconColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function SkillCard({ skill, onSubscribe, onDetail }: SkillCardProps) {
  const iconColor = getIconColor(skill.name);
  const hasChildren = skill.subscriptions > 0;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (onDetail) {
      e.preventDefault();
      onDetail();
    }
  };

  const handleSubscribe = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onSubscribe) {
      onSubscribe();
    }
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-4)',
    cursor: onDetail ? 'pointer' : 'default',
    transition: 'all var(--transition-fast)',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-3)',
  };

  const iconBoxStyle: React.CSSProperties = {
    width: 44,
    height: 44,
    minWidth: 44,
    borderRadius: 'var(--radius-md)',
    background: iconColor,
    color: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '20px',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
  };

  const headerTextStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  const nameRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    marginBottom: '4px',
  };

  const nameStyle: React.CSSProperties = {
    fontSize: 'var(--text-base)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  };

  const slugStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono, monospace)',
  };

  const descriptionStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden',
  };

  const tagsStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 'var(--space-1)',
  };

  const tagStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-xs)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-primary)',
  };

  const footerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 'var(--space-2)',
    borderTop: '1px solid var(--border-primary)',
  };

  const authorStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-tertiary)',
  };

  return (
    <div
      style={cardStyle}
      onClick={handleClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--brand-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-primary)';
      }}
    >
      {/* Header: icon + name + scope badge + slug */}
      <div style={headerStyle}>
        <div style={iconBoxStyle}>
          {skill.icon || skill.display_name.charAt(0) || skill.name.charAt(0)}
        </div>
        <div style={headerTextStyle}>
          <div style={nameRowStyle}>
            <span style={nameStyle}>{skill.display_name || skill.name}</span>
            <Badge variant={SCOPE_VARIANT[skill.scope]} size="sm">
              {SCOPE_LABEL[skill.scope]}
            </Badge>
            {skill.is_kill_switched && (
              <Badge variant="error" size="sm">
                已禁用
              </Badge>
            )}
          </div>
          <div style={slugStyle}>
            {skill.name} {skill.version && `v${skill.version}`}
          </div>
        </div>
      </div>

      {/* Description (2-line clamp) */}
      {skill.description && (
        <div style={descriptionStyle}>{skill.description}</div>
      )}

      {/* Tag chips */}
      {skill.tags.length > 0 && (
        <div style={tagsStyle}>
          {skill.tags.slice(0, 6).map((tag) => (
            <span key={tag} style={tagStyle}>
              {tag}
            </span>
          ))}
          {skill.tags.length > 6 && (
            <span style={tagStyle}>+{skill.tags.length - 6}</span>
          )}
        </div>
      )}

      {/* Footer: author + subscribe button */}
      <div style={footerStyle}>
        <span style={authorStyle}>
          {skill.author_name || '未知'}
          {hasChildren && ` ${skill.subscriptions} 订阅`}
        </span>
        {onSubscribe && (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSubscribe}
            icon={<Download size={14} />}
          >
            订阅
          </Button>
        )}
      </div>
    </div>
  );
}

export default SkillCard;
