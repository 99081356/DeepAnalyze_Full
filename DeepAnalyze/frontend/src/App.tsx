import { useState, useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { useChatStore } from "./store/chat";
import { useUIStore, registerRouterNavigate } from "./store/ui";
import { useHubStore } from "./store/hub";
import { AppLayout } from "./components/layout/AppLayout";
import { SystemStatusBanner } from "./components/common/SystemStatusBanner";
import { LoginPage } from "./components/auth/LoginPage";
import { SetupWizard } from "./components/auth/SetupWizard";
import { FirstRunModuleWizard } from "./components/wizard/FirstRunModuleWizard";
import { api } from "./api/client";
import { router } from "./router";

const ROUTE_STORAGE_KEY = "deepanalyze-route";

export default function App() {
  const loadSessions = useChatStore((s) => s.loadSessions);
  const setCurrentKbId = useUIStore((s) => s.setCurrentKbId);
  const [authReady, setAuthReady] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showWizard, setShowWizard] = useState(false);

  // Setup gate: check if first-run setup wizard is needed
  useEffect(() => {
    api.setup.getState()
      .then(({ complete }) => {
        if (!complete) setNeedsSetup(true);
      })
      .catch(() => {
        // Setup endpoint unreachable — assume setup not needed (backward compat)
      });
  }, []);

  // Auth gate: check auth mode and token validity before rendering app
  useEffect(() => {
    api.auth.getAuthMode()
      .then(({ mode }: { mode: string }) => {
        if (mode === "none") {
          setNeedsLogin(false);
          setAuthReady(true);
          return;
        }
        // hub 模式：后端只认 da_session cookie（由 SSO /sso/callback 签发），
        // 前端不能用 localStorage token 判断登录态（SSO 链路根本不写 token）。
        // 直接调 /me 接口，cookie 会被浏览器自动带上，能否 200 即登录态。
        if (mode === "hub") {
          api.auth.me()
            .then((user: unknown) => {
              setNeedsLogin(!user);
              setAuthReady(true);
            })
            .catch(() => {
              setNeedsLogin(true);
              setAuthReady(true);
            });
          return;
        }
        // local 模式：仍走 Bearer token（登录接口写入 localStorage）
        const token = localStorage.getItem("da_access_token");
        if (!token) {
          setNeedsLogin(true);
          setAuthReady(true);
          return;
        }
        api.auth.me().then((user: unknown) => {
          setNeedsLogin(!user);
          setAuthReady(true);
        }).catch(() => {
          setNeedsLogin(true);
          setAuthReady(true);
        });
      })
      .catch(() => {
        // If mode endpoint fails, assume no auth needed
        setNeedsLogin(false);
        setAuthReady(true);
      });
  }, []);

  // First-run module wizard: only check after auth + setup gates pass.
  // The wizard appears only for full-bundle installs where no modules are
  // configured yet (data/_bundled/ exists AND all modules are 'disabled').
  useEffect(() => {
    if (!authReady || needsLogin || needsSetup) return;
    api.getFirstRunStatus()
      .then(({ isFirstRun }) => {
        if (isFirstRun) setShowWizard(true);
      })
      .catch(() => {
        // Endpoint unreachable — assume not a first-run bundle (backward compat)
      });
  }, [authReady, needsLogin, needsSetup]);

  // Clean up polluted pathname on mount.
  // HashRouter only modifies the hash; if the browser has a stale pathname
  // (e.g. /wiki/.../documents/... from history or a bookmark), it stays
  // forever. Normalize to "/" + current hash so URLs stay clean.
  useEffect(() => {
    const { pathname, hash } = window.location;
    if (pathname !== "/") {
      window.history.replaceState(null, "", "/" + hash);
    }
  }, []);

  // Load sessions on mount
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Register router.navigate globally so Zustand store can use proper navigation
  useEffect(() => {
    registerRouterNavigate((path, options) => {
      router.navigate(path, options);
    });
    return () => {
      // Fallback to direct hash manipulation on unmount
      registerRouterNavigate(() => {});
    };
  }, []);

  // Expose stores on window for E2E testing (Playwright)
  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__uiStore = useUIStore;
      (window as any).__chatStore = useChatStore;
    }
  }, []);

  // Detect run mode (Worker vs Standalone) on mount
  useEffect(() => {
    useHubStore.getState().detectRunMode();
  }, []);

  // Pre-load knowledge bases and set a default kbId, then restore route
  useEffect(() => {
    api.listKnowledgeBases()
      .then((kbs) => {
        const currentKbId = useUIStore.getState().currentKbId;
        if (Array.isArray(kbs) && kbs.length > 0) {
          // Validate cached kbId still exists; if not, auto-select the first KB
          const cachedExists = kbs.some((kb: { id: string }) => kb.id === currentKbId);
          if (!currentKbId || !cachedExists) {
            setCurrentKbId(kbs[0].id);
          }
        }

        // Restore persisted route if current URL has no meaningful hash
        const currentHash = window.location.hash;
        if (!currentHash || currentHash === "#" || currentHash === "#/" || currentHash === "#") {
          try {
            const savedRoute = localStorage.getItem(ROUTE_STORAGE_KEY);
            if (savedRoute) {
              // If the saved route is /knowledge without kbId, append the default kbId
              if (savedRoute === "/knowledge" && kbs.length > 0) {
                const defaultKbId = currentKbId || kbs[0].id;
                window.location.hash = `#/knowledge/${defaultKbId}`;
              } else {
                window.location.hash = `#${savedRoute}`;
              }
            }
          } catch {
            // localStorage unavailable
          }
        }
      })
      .catch(() => {
        // Non-critical — KnowledgePanel will handle its own loading
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL hash changes back to Zustand store so Sidebar highlights stay correct
  // Also persist the current route to localStorage for refresh recovery
  useEffect(() => {
    function syncRouteToStore() {
      const hash = window.location.hash.replace("#", "");
      const path = hash.split("/")[1] || "chat"; // first segment after /
      const viewMap: Record<string, "chat" | "knowledge" | "reports" | "tasks"> = {
        chat: "chat",
        sessions: "chat",
        knowledge: "knowledge",
        reports: "reports",
        tasks: "tasks",
      };
      const view = viewMap[path];
      if (view && view !== useUIStore.getState().activeView) {
        useUIStore.getState().setActiveView(view);
      }

      // Persist the route (store the path without hash)
      try {
        localStorage.setItem(ROUTE_STORAGE_KEY, hash || "/chat");
      } catch {
        // localStorage unavailable
      }
    }

    // Sync initial route
    syncRouteToStore();

    // Listen for hash changes
    window.addEventListener("hashchange", syncRouteToStore);
    return () => window.removeEventListener("hashchange", syncRouteToStore);
  }, []);

  if (!authReady) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)" }}>
        <div style={{ color: "var(--text-secondary)" }}>Loading...</div>
      </div>
    );
  }

  if (needsSetup) {
    return <SetupWizard onComplete={() => window.location.reload()} />;
  }

  if (needsLogin) {
    return <LoginPage onLoggedIn={() => setNeedsLogin(false)} />;
  }

  return (
    <AppLayout>
      <SystemStatusBanner />
      <RouterProvider router={router} />
      {showWizard && (
        <FirstRunModuleWizard onDone={() => setShowWizard(false)} />
      )}
    </AppLayout>
  );
}
