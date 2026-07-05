// =============================================================================
// DeepAnalyze - RightPanel Component
// Content-aware right-side slide-out panel
// =============================================================================

import React, { useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { useUIStore, type PanelContentType } from "../../store/ui";
import { X } from "lucide-react";
import { Spinner } from "../ui/Spinner";
import { ErrorBoundary } from "../ui/ErrorBoundary";

// ---------------------------------------------------------------------------
// Lazy-loaded panel content components
// ---------------------------------------------------------------------------

const SessionsPanel = lazy(() =>
  import("../sessions/SessionsPanel").then((m) => ({ default: m.SessionsPanel }))
);
const PluginManager = lazy(() =>
  import("../plugins/PluginManager").then((m) => ({ default: m.PluginManager }))
);
const SkillBrowser = lazy(() =>
  import("../plugins/SkillBrowser").then((m) => ({ default: m.SkillBrowser }))
);
const SettingsPanel = lazy(() =>
  import("../settings/SettingsPanel").then((m) => ({ default: m.SettingsPanel }))
);
const CronManager = lazy(() =>
  import("../cron/CronManager").then((m) => ({ default: m.CronManager }))
);
const TeamManager = lazy(() =>
  import("../teams/TeamManager").then((m) => ({ default: m.TeamManager }))
);
const EvolutionPanel = lazy(() =>
  import("../evolution/EvolutionPanel").then((m) => ({ default: m.EvolutionPanel }))
);
const MarketplacePanel = lazy(() =>
  import("../marketplace/MarketplacePanel").then((m) => ({ default: m.MarketplacePanel }))
);
const MCPServersPanel = lazy(() =>
  import("../settings/MCPServersPanel").then((m) => ({ default: m.MCPServersPanel }))
);

// ---------------------------------------------------------------------------
// Panel configuration
// ---------------------------------------------------------------------------

const PANEL_TITLES: Record<PanelContentType, string> = {
  sessions: "会话历史",
  plugins: "插件管理",
  skills: "技能库",
  cron: "定时任务",
  settings: "设置",
  teams: "团队管理",
  evolution: "自进化",
  marketplace: "资源市场",
  mcp: "MCP 服务",
};

const PANEL_WIDTHS: Record<PanelContentType, number> = {
  sessions: 420,
  plugins: 480,
  skills: 480,
  cron: 560,
  settings: 640,
  teams: 560,
  evolution: 560,
  marketplace: 560,
  mcp: 560,
};

// ---------------------------------------------------------------------------
// Panel content renderer
// ---------------------------------------------------------------------------

function PanelContent({ type }: { type: PanelContentType }) {
  return (
    <Suspense
      fallback={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200 }}>
          <Spinner size="md" />
        </div>
      }
    >
      {(() => {
        switch (type) {
          case "sessions":
            return <SessionsPanel />;
          case "plugins":
            return <PluginManager />;
          case "skills":
            return <SkillBrowser />;
          case "cron":
            return <CronManager />;
          case "settings":
            return <SettingsPanel />;
          case "teams":
            return <TeamManager />;
          case "evolution":
            return <EvolutionPanel />;
          case "marketplace":
            return <MarketplacePanel />;
          case "mcp":
            return <MCPServersPanel />;
        }
      })()}
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// RightPanel component
// ---------------------------------------------------------------------------

export function RightPanel() {
  const { rightPanelOpen, closeRightPanel, rightPanelContentType } = useUIStore();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRightPanel();
    },
    [closeRightPanel],
  );

  useEffect(() => {
    if (rightPanelOpen) {
      window.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [rightPanelOpen, handleKeyDown]);

  // Not open: render nothing
  if (!rightPanelOpen || !rightPanelContentType) return null;

  const width = PANEL_WIDTHS[rightPanelContentType] ?? 480;
  const title = PANEL_TITLES[rightPanelContentType] ?? "";

  // =====================================================================
  // Render
  // =====================================================================

  const content = (
    <>
      {/* Overlay */}
      <div
        onClick={closeRightPanel}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          zIndex: 1200,
          animation: "rightPanelFadeIn var(--transition-base) ease-out",
        }}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width,
          backgroundColor: "var(--bg-primary)",
          borderLeft: "1px solid var(--border-primary)",
          boxShadow: "var(--shadow-2xl)",
          zIndex: 1300,
          display: "flex",
          flexDirection: "column",
          animation: "rightPanelSlideIn var(--transition-slow) ease-out",
        }}
      >
        {/* Header */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--space-3) var(--space-4)",
            borderBottom: "1px solid var(--border-primary)",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-base)",
              fontWeight: "var(--font-semibold)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </h3>
          <button
            onClick={closeRightPanel}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: "var(--radius-md)",
              border: "none",
              backgroundColor: "transparent",
              color: "var(--text-tertiary)",
              cursor: "pointer",
              transition:
                "background-color var(--transition-fast), color var(--transition-fast)",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--text-tertiary)";
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content area */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
          }}
        >
          <ErrorBoundary>
            <PanelContent type={rightPanelContentType} />
          </ErrorBoundary>
        </div>
      </div>

      {/* Inline keyframes for panel animations */}
      <style>{`
        @keyframes rightPanelFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes rightPanelSlideIn {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </>
  );

  return createPortal(content, document.body);
}

export default RightPanel;
