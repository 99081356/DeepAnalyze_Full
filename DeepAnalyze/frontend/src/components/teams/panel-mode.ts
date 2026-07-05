// =============================================================================
// DeepAnalyze - SubAgentPanel Mode Selector (pure functions)
// =============================================================================
// Pure functions for computing panel display mode and auto-compaction.
// Kept module-local (no React/zustand imports) so they can be unit-tested in
// isolation once frontend test infrastructure is in place.
// =============================================================================

/** Display mode for a single SubAgentPanel. */
export type PanelMode = "expanded" | "compact";

/** Minimal workflow shape needed by the selectors (avoids coupling to store). */
export interface PanelWorkflowInfo {
  workflowId: string;
  agents: Array<{ status: string }>;
}

/** Context flags driving the selector. */
export interface PanelModeContext {
  /** True when the global "collapse all" toggle is on. */
  forceCompactAll: boolean;
  /** Per-workflow user override. */
  userOverride: Map<string, PanelMode>;
  /** True when stack height estimate exceeds the "keep status quo" threshold. */
  autoCompact: boolean;
}

/**
 * Decide how a single panel should render.
 *
 * Priority (highest first):
 *   1. userOverride        — user explicitly clicked this panel
 *   2. forceCompactAll     — global "collapse all" toggle
 *   3. hasRunningAgents    — running workflows always show chips
 *   4. autoCompact         — stack-height-driven compaction for non-running
 *   5. default: expanded   — preserve current behavior
 */
export function selectPanelMode(
  wf: PanelWorkflowInfo,
  ctx: PanelModeContext,
): PanelMode {
  const override = ctx.userOverride.get(wf.workflowId);
  if (override) return override;

  if (ctx.forceCompactAll) return "compact";

  const hasRunning = wf.agents.some(
    (a) => a.status === "running" || a.status === "waiting" || a.status === "queued",
  );
  if (hasRunning) return "expanded";

  if (ctx.autoCompact) return "compact";

  return "expanded";
}

/** Estimated pixel height of an expanded panel (title bar + chips row). */
export const EXPANDED_HEIGHT_PX = 88;
/** Estimated pixel height of a compacted panel (single row). */
export const COMPACT_HEIGHT_PX = 28;
/** Fraction of viewport height at or below which we keep the current layout. */
export const AUTOCOMPACT_VH_THRESHOLD = 0.4;

/**
 * Decide whether non-running panels should auto-compact.
 *
 * Uses an estimated height rather than DOM measurement to avoid the
 * measure → setState → re-render → measure loop. The estimate is
 * deliberately conservative (偏向更大), so when in doubt we compact.
 */
export function computeAutoCompact(
  wfs: PanelWorkflowInfo[],
  viewportHeight: number,
): boolean {
  if (wfs.length === 0) return false;
  const normalTotal = wfs.reduce(
    (sum, w) => sum + (w.agents.length > 0 ? EXPANDED_HEIGHT_PX : 60),
    0,
  );
  return normalTotal > viewportHeight * AUTOCOMPACT_VH_THRESHOLD;
}
