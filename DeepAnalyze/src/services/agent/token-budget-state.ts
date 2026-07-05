// =============================================================================
// DeepAnalyze - Token Budget Warning State
// =============================================================================
// Multi-level token budget warning system.
// Computes a state (normal/warning/error/critical) based on current token usage
// relative to the effective context window. Emits state changes via SSE.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BudgetState = "normal" | "warning" | "error" | "critical";

export interface BudgetStateInfo {
  state: BudgetState;
  currentTokens: number;
  effectiveWindow: number;
  ratio: number;
  percentUsed: number;
}

export interface BudgetStateChangeEvent {
  type: "budget_state";
  previousState: BudgetState;
  newState: BudgetState;
  info: BudgetStateInfo;
}

// ---------------------------------------------------------------------------
// Thresholds (ratios of effective window)
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  normal: 0.70,    // < 70% → normal
  warning: 0.85,   // 70-85% → warning
  error: 0.95,     // 85-95% → error
  // > 95% → critical
} as const;

// ---------------------------------------------------------------------------
// State computation
// ---------------------------------------------------------------------------

/**
 * Compute the current budget state based on token usage.
 *
 * @param currentTokens - Current estimated token count
 * @param effectiveWindow - Effective context window size (total - reserved)
 * @returns BudgetStateInfo with state and metrics
 */
export function getTokenBudgetState(
  currentTokens: number,
  effectiveWindow: number,
): BudgetStateInfo {
  const ratio = effectiveWindow > 0 ? currentTokens / effectiveWindow : 0;
  const percentUsed = Math.round(ratio * 100);

  let state: BudgetState;
  if (ratio >= THRESHOLDS.error) {
    state = "critical";
  } else if (ratio >= THRESHOLDS.warning) {
    state = "error";
  } else if (ratio >= THRESHOLDS.normal) {
    state = "warning";
  } else {
    state = "normal";
  }

  return {
    state,
    currentTokens,
    effectiveWindow,
    ratio,
    percentUsed,
  };
}

/**
 * Check if the budget state has changed and return a change event if so.
 * Returns null if the state hasn't changed.
 */
export function checkBudgetStateChange(
  prevState: BudgetState,
  currentTokens: number,
  effectiveWindow: number,
): BudgetStateChangeEvent | null {
  const info = getTokenBudgetState(currentTokens, effectiveWindow);
  if (info.state !== prevState) {
    return {
      type: "budget_state",
      previousState: prevState,
      newState: info.state,
      info,
    };
  }
  return null;
}
