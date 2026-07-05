import { useState, useEffect } from "react";
import {
  Sun, Moon, Settings,
  History, Puzzle, Zap, Clock, Users, Brain, Store, Cable,
} from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { useUIStore, type PanelContentType } from '../../store/ui';
import { useHubStore } from '../../store/hub';
import { api } from '../../api/client';
import { isWsConnected } from '../../hooks/useWebSocket';

// ---------------------------------------------------------------------------
// Header action buttons config
// ---------------------------------------------------------------------------

const headerActions: { id: PanelContentType; icon: typeof History; title: string; workerOnly?: boolean }[] = [
  { id: 'sessions', icon: History, title: '会话历史' },
  { id: 'plugins', icon: Puzzle, title: '插件管理' },
  { id: 'skills', icon: Zap, title: '技能库' },
  { id: 'teams', icon: Users, title: '团队管理' },
  { id: 'cron', icon: Clock, title: '定时任务' },
  { id: 'evolution', icon: Brain, title: '自进化' },
  { id: 'mcp', icon: Cable, title: 'MCP 服务' },
  { id: 'marketplace', icon: Store, title: '资源市场', workerOnly: true },
  { id: 'settings', icon: Settings, title: '设置' },
];

// ---------------------------------------------------------------------------
// UserBadge component
// ---------------------------------------------------------------------------

function UserBadge() {
  const [user, setUser] = useState<{ name: string; source: string } | null>(null);

  useEffect(() => {
    // hub 模式靠 da_session cookie 认证（无 localStorage token），仍要调 /me。
    // local 模式无 token 则跳过（避免未登录时多发请求）。
    const token = localStorage.getItem("da_access_token");
    api.auth.me().then(u => { if (u) setUser(u); }).catch(() => {
      // local 模式无 token 时 me() 会返回 null，这里什么都不做
      void token;
    });
  }, []);

  if (!user) return null;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)",
      marginLeft: "var(--space-2)",
      paddingLeft: "var(--space-2)",
      borderLeft: "1px solid var(--border-primary)",
      flexShrink: 0,
    }}>
      <span style={{
        fontSize: "var(--text-xs)",
        color: "var(--text-secondary)",
        maxWidth: "120px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {user.name}
      </span>
      <button
        onClick={async () => {
          await api.auth.logout();
          window.location.reload();
        }}
        title="登出"
        style={{
          padding: "4px 8px",
          border: "none",
          borderRadius: "var(--radius-sm)",
          background: "transparent",
          color: "var(--text-secondary)",
          fontSize: "var(--text-xs)",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-tertiary)";
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-secondary)";
        }}
      >
        登出
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header component
// ---------------------------------------------------------------------------

export function Header() {
  const { isDark, toggleTheme } = useTheme();
  const openRightPanel = useUIStore((s) => s.openRightPanel);
  const rightPanelContentType = useUIStore((s) => s.rightPanelContentType);
  const isWorkerMode = useHubStore((s) => s.isWorkerMode);

  const visibleActions = headerActions.filter((a) => !a.workerOnly || isWorkerMode === true);

  const [healthStatus, setHealthStatus] = useState<"ok" | "error" | "loading">("loading");

  // Health polling
  useEffect(() => {
    const check = () => {
      api.health().then((info) => {
        setHealthStatus(info.status === "ok" ? "ok" : "error");
      }).catch(() => setHealthStatus("error"));
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  // WebSocket connection status
  const [wsStatus, setWsStatus] = useState<"connected" | "disconnected">("disconnected");
  useEffect(() => {
    const check = () => {
      setWsStatus(isWsConnected() ? "connected" : "disconnected");
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  const healthColor = healthStatus === "ok" ? "var(--success)" : healthStatus === "error" ? "var(--error)" : "var(--warning)";

  // Action button style helper
  const actionBtnBase: React.CSSProperties = {
    width: 34,
    height: 34,
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all var(--transition-fast)',
    position: 'relative' as const,
    flexShrink: 0,
  };

  const handleActionEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'var(--bg-tertiary)';
    e.currentTarget.style.color = 'var(--text-primary)';
  };
  const handleActionLeave = (e: React.MouseEvent<HTMLButtonElement>, isActive: boolean) => {
    e.currentTarget.style.background = isActive ? 'var(--bg-tertiary)' : 'transparent';
    e.currentTarget.style.color = isActive ? 'var(--interactive)' : 'var(--text-secondary)';
  };

  return (
    <header
      style={{
        height: 'var(--header-height)',
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border-primary)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 var(--space-4)',
        gap: 'var(--space-3)',
        flexShrink: 0,
        zIndex: 'var(--z-sticky)',
        position: 'relative',
      }}
    >
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
        {/* Health dot */}
        <div
          title={healthStatus === "ok" ? "API 正常" : healthStatus === "error" ? "API 异常" : "连接中..."}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: healthColor,
            flexShrink: 0,
          }}
        />
        {/* WS status dot */}
        <div
          title={wsStatus === "connected" ? "实时连接正常" : "实时连接断开"}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: wsStatus === "connected" ? "var(--success)" : "var(--warning)",
            flexShrink: 0,
          }}
        />
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-md)',
            background: 'linear-gradient(135deg, #3b82f6, #06b6d4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          D
        </div>
        <span
          style={{
            fontWeight: 600,
            fontSize: 'var(--text-lg)',
            color: 'var(--text-primary)',
            letterSpacing: '-0.01em',
          }}
        >
          DeepAnalyze
        </span>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {/* Panel action buttons */}
        {visibleActions.map(({ id, icon: Icon, title }) => {
          const isActive = rightPanelContentType === id;
          return (
            <button
              key={id}
              onClick={() => openRightPanel(id)}
              title={title}
              style={{
                ...actionBtnBase,
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                color: isActive ? 'var(--interactive)' : 'var(--text-secondary)',
              }}
              onMouseEnter={(e) => handleActionEnter(e)}
              onMouseLeave={(e) => handleActionLeave(e, isActive)}
            >
              <Icon size={18} />
            </button>
          );
        })}

        {/* Divider */}
        <div style={{
          width: 1,
          height: 20,
          background: 'var(--border-primary)',
          margin: '0 var(--space-1)',
          flexShrink: 0,
        }} />

        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          title={isDark ? '切换浅色主题' : '切换深色主题'}
          style={actionBtnBase}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-tertiary)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {/* User Badge with Logout */}
        <UserBadge />
      </div>
    </header>
  );
}
