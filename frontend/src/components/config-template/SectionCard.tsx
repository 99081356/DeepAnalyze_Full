// =============================================================================
// SectionCard — 配置模板表单的统一区块外壳
// =============================================================================
// 每个配置区块（providers / agentSettings / doclingConfig / ...）都用这个
// 外壳包裹，统一标题、折叠、锁定开关的视觉。
//
// 锁定开关（LockToggle）：勾选 = 把该区块 key 加入 fieldLocks.lockedPaths，
// 表示「强制覆盖 Worker 本地值」（而非仅本地为空时填充）。
// =============================================================================

import { useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface SectionCardProps {
  /** 区块标题 */
  title: string;
  /** 区块说明（标题下方小字） */
  description?: string;
  /** 区块对应的锁定 key（如 "providers" / "moduleStates.docling"）。
   *  不传则不显示锁定开关（用于 fieldLocks 自身等元数据区块）。 */
  lockKey?: string;
  /** 当前是否锁定 */
  locked?: boolean;
  /** 锁定状态切换回调 */
  onLockChange?: (locked: boolean) => void;
  /** 默认是否展开 */
  defaultExpanded?: boolean;
  /** 右上角额外操作区（如"添加"按钮） */
  actions?: ReactNode;
  children: ReactNode;
}

export function SectionCard({
  title,
  description,
  lockKey,
  locked = false,
  onLockChange,
  defaultExpanded = true,
  actions,
  children,
}: SectionCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const cardStyle: CSSProperties = {
    background: "var(--bg-card)",
    border: `1px solid ${locked ? "var(--warning)" : "var(--border-primary)"}`,
    borderLeft: locked ? "4px solid var(--warning)" : undefined,
    borderRadius: "var(--radius-lg)",
    overflow: "hidden",
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "var(--space-3) var(--space-4)",
    cursor: "pointer",
    userSelect: "none",
    borderBottom: expanded ? "1px solid var(--border-primary)" : "none",
  };

  const titleBlockStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    flex: 1,
    minWidth: 0,
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--text-base)",
    fontWeight: 600,
    color: "var(--text-primary)",
    margin: 0,
  };

  const descStyle: CSSProperties = {
    fontSize: 12,
    color: "var(--text-tertiary)",
    marginTop: 2,
  };

  const bodyStyle: CSSProperties = {
    padding: "var(--space-4)",
  };

  // 锁定开关（紧凑型，放在标题右侧）
  const lockBlockStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "2px 8px",
    borderRadius: "var(--radius-sm)",
    background: locked ? "var(--warning-light)" : "var(--bg-tertiary)",
    cursor: "pointer",
    fontSize: 12,
    color: locked ? "var(--warning-dark, var(--warning))" : "var(--text-secondary)",
    transition: "background var(--transition-fast)",
  };

  return (
    <div style={cardStyle}>
      <div style={headerStyle} onClick={() => setExpanded((e) => !e)}>
        <div style={titleBlockStyle}>
          {expanded ? (
            <ChevronDown size={16} color="var(--text-tertiary)" />
          ) : (
            <ChevronRight size={16} color="var(--text-tertiary)" />
          )}
          <div>
            <h3 style={titleStyle}>{title}</h3>
            {description && <div style={descStyle}>{description}</div>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {actions}
          {lockKey && onLockChange && (
            <div
              style={lockBlockStyle}
              onClick={(e) => {
                e.stopPropagation();
                onLockChange(!locked);
              }}
              title={
                locked
                  ? "已锁定：强制覆盖 Worker 本地值（即使 Worker 已有自定义配置）"
                  : "未锁定：仅当 Worker 本地值为空时才填充此区块"
              }
            >
              <span>{locked ? "🔒" : "🔓"}</span>
              <span>{locked ? "强制覆盖" : "仅填空"}</span>
            </div>
          )}
        </div>
      </div>
      {expanded && <div style={bodyStyle}>{children}</div>}
    </div>
  );
}

export default SectionCard;
