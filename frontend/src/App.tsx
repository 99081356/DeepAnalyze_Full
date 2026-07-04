import { useEffect, useState, useCallback } from "react";
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Search, LogOut } from "lucide-react";
import { api, type MeResponse } from "./api/client.js";
import { ThemeToggle } from "./components/ui/ThemeToggle.js";
import { Login } from "./pages/Login.js";
import { Dashboard } from "./pages/Dashboard.js";
import { OrgTree } from "./pages/OrgTree.js";
import { UserList } from "./pages/UserList.js";
import { WorkerApproval } from "./pages/WorkerApproval.js";
import { Skills } from "./pages/Skills.js";
import { SkillDetail } from "./pages/SkillDetail.js";
import { SkillSubmissions } from "./pages/SkillSubmissions.js";
import { Sharings } from "./pages/Sharings.js";
import { Security } from "./pages/Security.js";
import { WorkerSkills } from "./pages/WorkerSkills.js";
import { Models } from "./pages/Models.js";
import { HostServersPage } from "./pages/HostServersPage.js";
import { HostServerDetail } from "./pages/HostServerDetail.js";
import { HostServerForm } from "./pages/HostServerForm.js";
import { ConfirmDialog } from "./components/ui/ConfirmDialog.js";
import { ToastContainer } from "./components/ui/Toast.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Navigation items — used by both Sidebar and Header
 * ────────────────────────────────────────────────────────────────────────── */

const NAV_ITEMS = [
  { to: "/", label: "仪表盘", icon: "📊" },
  { to: "/orgs", label: "组织树", icon: "🏢" },
  { to: "/users", label: "用户", icon: "👥" },
  { to: "/skills", label: "企业技能包", icon: "📦" },
  { to: "/worker-skills", label: "Worker 技能市场", icon: "🌐" },
  { to: "/submissions", label: "Skill 提交审核", icon: "📋" },
  { to: "/sharings", label: "跨组织共享", icon: "🔄" },
  { to: "/workers", label: "Worker 审批", icon: "🖥️" },
  { to: "/host-servers", label: "物理机", icon: "🏭" },
  { to: "/models", label: "模型仓库", icon: "🧠" },
  { to: "/security", label: "安全网关", icon: "🛡️" },
] as const;

/** Match a pathname to a NAV_ITEM, preferring the longest prefix. */
function matchNavItem(pathname: string) {
  let best: (typeof NAV_ITEMS)[number] | null = null;
  for (const item of NAV_ITEMS) {
    if (item.to === "/") {
      if (pathname === "/") return item;
      continue;
    }
    if (pathname.startsWith(item.to)) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best ?? NAV_ITEMS[0];
}

/* ──────────────────────────────────────────────────────────────────────────
 * Sidebar
 * ────────────────────────────────────────────────────────────────────────── */

const SIDEBAR_STORAGE_KEY = "hub_sidebar_collapsed";

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function Sidebar({
  collapsed,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const location = useLocation();
  const width = collapsed ? 64 : 240;

  return (
    <aside
      style={{
        width,
        minWidth: width,
        background: "var(--bg-sidebar)",
        color: "var(--text-on-dark)",
        display: "flex",
        flexDirection: "column",
        transition: "width var(--transition-base), min-width var(--transition-base)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {/* Logo + title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: collapsed
            ? "var(--space-4) var(--space-2)"
            : "var(--space-4) var(--space-5)",
          height: 56,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            minWidth: 32,
            borderRadius: "var(--radius-lg)",
            background: "var(--brand-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            fontWeight: 700,
            color: "var(--brand-foreground)",
          }}
        >
          D
        </div>
        {!collapsed && (
          <span
            style={{
              fontSize: "var(--text-lg)",
              fontWeight: "var(--font-semibold)",
              whiteSpace: "nowrap",
            }}
          >
            DeepAnalyze Hub
          </span>
        )}
      </div>

      {/* Nav items */}
      <nav
        style={{
          flex: 1,
          padding: "var(--space-2) 0",
          overflowY: "auto",
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active =
            item.to === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                padding: collapsed
                  ? "var(--space-3) var(--space-2)"
                  : "var(--space-3) var(--space-5)",
                color: active ? "#ffffff" : "var(--text-on-dark)",
                opacity: active ? 1 : 0.65,
                textDecoration: "none",
                fontSize: "var(--text-base)",
                fontWeight: active ? "var(--font-medium)" : "var(--font-normal)",
                background: active ? "rgba(255,255,255,0.08)" : "transparent",
                borderLeft: active
                  ? "3px solid var(--brand-primary)"
                  : "3px solid transparent",
                transition:
                  "background var(--transition-fast), opacity var(--transition-fast)",
                justifyContent: collapsed ? "center" : "flex-start",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.opacity = "0.9";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.opacity = "0.65";
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>
                {item.icon}
              </span>
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.08)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--space-2)",
            padding: "var(--space-3)",
            background: "transparent",
            color: "var(--text-on-dark)",
            opacity: 0.65,
            border: "none",
            cursor: "pointer",
            fontSize: "var(--text-base)",
            transition: "opacity var(--transition-fast)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.65";
          }}
        >
          {collapsed ? (
            <ChevronRight size={18} />
          ) : (
            <>
              <ChevronLeft size={18} />
              <span>收起</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Header
 * ────────────────────────────────────────────────────────────────────────── */

function Header({
  user,
  onLogout,
}: {
  user: MeResponse;
  onLogout: () => void;
}) {
  const location = useLocation();
  const current = matchNavItem(location.pathname);

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 56,
        padding: "0 var(--space-6)",
        background: "var(--bg-card)",
        borderBottom: "1px solid var(--border-primary)",
        flexShrink: 0,
      }}
    >
      {/* Left: page title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontSize: "var(--text-lg)",
          fontWeight: "var(--font-semibold)",
          color: "var(--text-primary)",
        }}
      >
        <span style={{ fontSize: 18 }}>{current.icon}</span>
        <span>{current.label}</span>
      </div>

      {/* Right: search, theme toggle, avatar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
        }}
      >
        {/* Search placeholder */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--bg-tertiary)",
            borderRadius: "var(--radius-lg)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-tertiary)",
            fontSize: "var(--text-sm)",
            cursor: "pointer",
            transition: "border-color var(--transition-fast)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--border-secondary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border-primary)";
          }}
        >
          <Search size={14} />
          <span>搜索...</span>
          <kbd
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-secondary)",
              background: "var(--bg-card)",
            }}
          >
            ⌘K
          </kbd>
        </div>

        {/* Theme toggle */}
        <ThemeToggle />

        {/* Avatar + logout */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            paddingLeft: "var(--space-3)",
            borderLeft: "1px solid var(--border-primary)",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              minWidth: 32,
              borderRadius: "var(--radius-full)",
              background: "var(--brand-primary)",
              color: "var(--brand-foreground)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--font-semibold)",
            }}
          >
            {(user.display_name || user.username || "?").charAt(0).toUpperCase()}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              lineHeight: 1.3,
            }}
          >
            <span
              style={{
                fontSize: "var(--text-sm)",
                fontWeight: "var(--font-medium)",
                color: "var(--text-primary)",
              }}
            >
              {user.display_name || user.username}
            </span>
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
              }}
            >
              {user.is_super_admin ? "超级管理员" : "管理员"}
            </span>
          </div>
          <button
            onClick={onLogout}
            aria-label="退出登录"
            title="退出登录"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border-primary)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              transition: "all var(--transition-fast)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Layout
 * ────────────────────────────────────────────────────────────────────────── */

function Layout({
  user,
  onLogout,
  children,
}: {
  user: MeResponse;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "var(--font-sans)",
      }}
    >
      <Sidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: "var(--bg-page)",
        }}
      >
        <Header user={user} onLogout={onLogout} />
        <main
          style={{
            flex: 1,
            padding: "var(--space-6)",
            maxWidth: 1400,
            width: "100%",
            margin: "0 auto",
          }}
        >
          {children}
        </main>
        <ConfirmDialog />
        <ToastContainer />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * ProtectedRoute
 * ────────────────────────────────────────────────────────────────────────── */

function ProtectedRoute({
  user,
  setUser,
  children,
}: {
  user: MeResponse | null;
  setUser: (u: MeResponse | null) => void;
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(!user);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem("hub_access_token");
    if (!token) {
      navigate("/login");
      return;
    }
    if (!user) {
      api
        .me()
        .then((u) => {
          setUser(u);
          setLoading(false);
        })
        .catch(() => {
          localStorage.removeItem("hub_access_token");
          navigate("/login");
        });
    }
  }, [user, setUser, navigate]);

  if (loading || !user) {
    return (
      <div
        style={{
          padding: "var(--space-10)",
          textAlign: "center",
          color: "var(--text-tertiary)",
        }}
      >
        加载中...
      </div>
    );
  }

  const handleLogout = () => {
    localStorage.removeItem("hub_access_token");
    setUser(null);
    navigate("/login");
  };

  return <Layout user={user} onLogout={handleLogout}>{children}</Layout>;
}

/* ──────────────────────────────────────────────────────────────────────────
 * App
 * ────────────────────────────────────────────────────────────────────────── */

export default function App() {
  const [user, setUser] = useState<MeResponse | null>(null);

  return (
    <Routes>
      <Route path="/login" element={<Login onLogin={setUser} />} />
      <Route path="/" element={<ProtectedRoute user={user} setUser={setUser}><Dashboard /></ProtectedRoute>} />
      <Route path="/orgs" element={<ProtectedRoute user={user} setUser={setUser}><OrgTree /></ProtectedRoute>} />
      <Route path="/users" element={<ProtectedRoute user={user} setUser={setUser}><UserList /></ProtectedRoute>} />
      <Route path="/workers" element={<ProtectedRoute user={user} setUser={setUser}><WorkerApproval /></ProtectedRoute>} />
      <Route path="/host-servers" element={<ProtectedRoute user={user} setUser={setUser}><HostServersPage /></ProtectedRoute>} />
      <Route path="/host-servers/new" element={<ProtectedRoute user={user} setUser={setUser}><HostServerForm /></ProtectedRoute>} />
      <Route path="/host-servers/:id" element={<ProtectedRoute user={user} setUser={setUser}><HostServerDetail /></ProtectedRoute>} />
      <Route path="/host-servers/:id/edit" element={<ProtectedRoute user={user} setUser={setUser}><HostServerForm /></ProtectedRoute>} />
      <Route path="/skills" element={<ProtectedRoute user={user} setUser={setUser}><Skills user={user!} /></ProtectedRoute>} />
      <Route path="/worker-skills" element={<ProtectedRoute user={user} setUser={setUser}><WorkerSkills /></ProtectedRoute>} />
      <Route path="/skills/:id" element={<ProtectedRoute user={user} setUser={setUser}><SkillDetail user={user!} /></ProtectedRoute>} />
      <Route path="/submissions" element={<ProtectedRoute user={user} setUser={setUser}><SkillSubmissions /></ProtectedRoute>} />
      <Route path="/sharings" element={<ProtectedRoute user={user} setUser={setUser}><Sharings /></ProtectedRoute>} />
      <Route path="/models" element={<ProtectedRoute user={user} setUser={setUser}><Models /></ProtectedRoute>} />
      <Route path="/security" element={<ProtectedRoute user={user} setUser={setUser}><Security /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
