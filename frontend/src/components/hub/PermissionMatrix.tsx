import React, { useState, useMemo } from 'react';
import { Search, Check, Minus } from 'lucide-react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface PermissionDef {
  code: string;
  resource: string;
  description: string;
}

export interface RolePermRow {
  role_id: string;
  role_name: string;
  permissions: string[];
}

export interface PermissionMatrixProps {
  permissions: PermissionDef[];
  roles: RolePermRow[];
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function PermissionMatrix({ permissions, roles }: PermissionMatrixProps) {
  const [search, setSearch] = useState('');

  /* ---- Filter permissions by search query ---- */
  const filteredPermissions = useMemo(() => {
    if (!search.trim()) return permissions;
    const q = search.toLowerCase();
    return permissions.filter(
      (p) =>
        p.code.toLowerCase().includes(q) ||
        p.resource.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [permissions, search]);

  /* ---- Group permissions by resource ---- */
  const grouped = useMemo(() => {
    const map = new Map<string, PermissionDef[]>();
    for (const perm of filteredPermissions) {
      if (!map.has(perm.resource)) {
        map.set(perm.resource, []);
      }
      map.get(perm.resource)!.push(perm);
    }
    return Array.from(map.entries());
  }, [filteredPermissions]);

  /* ---- Styles ---- */
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  };

  const searchContainerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  };

  const searchInputStyle: React.CSSProperties = {
    width: '100%',
    height: 36,
    padding: '0 var(--space-3) 0 36px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    outline: 'none',
    transition: 'all var(--transition-fast)',
  };

  const searchIconStyle: React.CSSProperties = {
    position: 'absolute',
    left: 12,
    color: 'var(--text-tertiary)',
    pointerEvents: 'none',
  };

  const tableWrapperStyle: React.CSSProperties = {
    overflowX: 'auto',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-primary)',
  };

  const tableStyle: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--text-sm)',
  };

  const headerCellStyle: React.CSSProperties = {
    padding: 'var(--space-2) var(--space-3)',
    textAlign: 'left',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    background: 'var(--bg-tertiary)',
    borderBottom: '1px solid var(--border-primary)',
    whiteSpace: 'nowrap' as const,
    position: 'sticky' as const,
    top: 0,
  };

  const groupHeaderStyle: React.CSSProperties = {
    padding: 'var(--space-2) var(--space-3)',
    fontWeight: 600,
    color: 'var(--brand-primary)',
    background: 'var(--brand-light)',
    borderBottom: '1px solid var(--border-primary)',
    borderTop: '1px solid var(--border-primary)',
    fontSize: 'var(--text-xs)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  };

  const cellStyle: React.CSSProperties = {
    padding: 'var(--space-2) var(--space-3)',
    borderBottom: '1px solid var(--border-primary)',
    color: 'var(--text-primary)',
  };

  const permCodeStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 'var(--text-xs)',
    fontWeight: 500,
  };

  const permDescStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-tertiary)',
    marginTop: '2px',
  };

  const checkCellBase: React.CSSProperties = {
    textAlign: 'center' as const,
    borderBottom: '1px solid var(--border-primary)',
    padding: 'var(--space-2)',
  };

  const emptyStyle: React.CSSProperties = {
    padding: 'var(--space-8) var(--space-4)',
    textAlign: 'center',
    color: 'var(--text-tertiary)',
    fontSize: 'var(--text-sm)',
  };

  return (
    <div style={containerStyle}>
      {/* Search bar */}
      <div style={searchContainerStyle}>
        <Search size={16} style={searchIconStyle} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索权限..."
          style={searchInputStyle}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-focus)';
            e.currentTarget.style.background = 'var(--bg-primary)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-primary)';
            e.currentTarget.style.background = 'var(--bg-tertiary)';
          }}
        />
      </div>

      {/* Permission table */}
      {grouped.length === 0 ? (
        <div style={emptyStyle}>没有匹配的权限</div>
      ) : (
        <div style={tableWrapperStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headerCellStyle}>权限</th>
                {roles.map((role) => (
                  <th
                    key={role.role_id}
                    style={{ ...headerCellStyle, textAlign: 'center' }}
                  >
                    {role.role_name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([resource, perms]) => (
                <React.Fragment key={resource}>
                  {/* Resource group header row */}
                  <tr>
                    <td
                      colSpan={roles.length + 1}
                      style={groupHeaderStyle}
                    >
                      {resource}
                    </td>
                  </tr>
                  {/* Permission rows */}
                  {perms.map((perm) => (
                    <tr key={perm.code}>
                      <td style={cellStyle}>
                        <div style={permCodeStyle}>{perm.code}</div>
                        {perm.description && (
                          <div style={permDescStyle}>{perm.description}</div>
                        )}
                      </td>
                      {roles.map((role) => {
                        const has = role.permissions.includes(perm.code);
                        return (
                          <td
                            key={role.role_id + '-' + perm.code}
                            style={{
                              ...checkCellBase,
                              color: has ? 'var(--success)' : 'var(--text-tertiary)',
                            }}
                          >
                            {has ? (
                              <Check size={16} style={{ verticalAlign: 'middle' }} />
                            ) : (
                              <Minus size={16} style={{ verticalAlign: 'middle' }} />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default PermissionMatrix;
