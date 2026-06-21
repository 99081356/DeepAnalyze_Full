import React from 'react';
import { Clock, Inbox } from 'lucide-react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface AuditEntry {
  id: string;
  actor_name: string;
  action: string;
  from_status?: string | null;
  to_status?: string | null;
  details?: Record<string, unknown>;
  created_at: string;
}

export interface AuditTimelineProps {
  entries: AuditEntry[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return iso;
  }
}

const ACTION_LABELS: Record<string, string> = {
  create: '创建',
  update: '更新',
  delete: '删除',
  approve: '批准',
  reject: '拒绝',
  submit: '提交',
  share: '分享',
  unshare: '取消分享',
  enable: '启用',
  disable: '禁用',
};

function getActionLabel(action: string): string {
  return ACTION_LABELS[action] || action;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function AuditTimeline({ entries }: AuditTimelineProps) {
  const containerStyle: React.CSSProperties = {
    position: 'relative',
    padding: 'var(--space-2) 0',
  };

  const emptyStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)',
    padding: 'var(--space-8) var(--space-4)',
    color: 'var(--text-tertiary)',
    fontSize: 'var(--text-sm)',
  };

  if (!entries || entries.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={emptyStyle}>
          <Inbox size={32} />
          <span>暂无审计记录</span>
        </div>
      </div>
    );
  }

  const timelineLineStyle: React.CSSProperties = {
    position: 'absolute',
    left: 7,
    top: 'var(--space-3)',
    bottom: 'var(--space-3)',
    width: 2,
    background: 'var(--border-primary)',
    borderRadius: 'var(--radius-full)',
  };

  const entryStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    gap: 'var(--space-3)',
    padding: 'var(--space-2) 0',
    paddingLeft: 24,
  };

  const dotStyle: React.CSSProperties = {
    position: 'absolute',
    left: 2,
    top: 'var(--space-3)',
    width: 12,
    height: 12,
    borderRadius: 'var(--radius-full)',
    background: 'var(--brand-primary)',
    border: '2px solid var(--bg-card)',
    boxShadow: '0 0 0 1px var(--border-primary)',
    flexShrink: 0,
    zIndex: 1,
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  const headerRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    flexWrap: 'wrap' as const,
  };

  const actionStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
  };

  const actorStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-secondary)',
  };

  const statusChangeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: 'var(--text-xs)',
    color: 'var(--text-tertiary)',
  };

  const fromStatusStyle: React.CSSProperties = {
    padding: '1px 6px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
  };

  const toStatusStyle: React.CSSProperties = {
    padding: '1px 6px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--brand-light)',
    color: 'var(--brand-primary)',
  };

  const arrowStyle: React.CSSProperties = {
    color: 'var(--text-tertiary)',
    fontSize: 'var(--text-xs)',
  };

  const timestampStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: 'var(--text-xs)',
    color: 'var(--text-tertiary)',
    marginTop: '4px',
  };

  return (
    <div style={containerStyle}>
      <div style={timelineLineStyle} />
      {entries.map((entry) => (
        <div key={entry.id} style={entryStyle}>
          <div style={dotStyle} />
          <div style={contentStyle}>
            <div style={headerRowStyle}>
              <span style={actionStyle}>{getActionLabel(entry.action)}</span>
              <span style={actorStyle}>by {entry.actor_name}</span>
              {entry.from_status != null && entry.to_status != null && (
                <span style={statusChangeStyle}>
                  <span style={fromStatusStyle}>{entry.from_status}</span>
                  <span style={arrowStyle}>→</span>
                  <span style={toStatusStyle}>{entry.to_status}</span>
                </span>
              )}
            </div>
            <div style={timestampStyle}>
              <Clock size={12} />
              {formatTimestamp(entry.created_at)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default AuditTimeline;
