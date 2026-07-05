/**
 * DA shim for CC's bootstrap/state.ts
 *
 * CC (Claude Code) has a global mutable state module that tracks session IDs,
 * CWD, interactive mode flags, feature flags, etc. DA runs as a web server
 * and does not have this concept. This module provides no-op stubs for all
 * the exports that CC-ported code expects.
 *
 * Getter functions return safe defaults (empty strings, false, empty arrays, etc.)
 * Setter/mutator functions are no-ops.
 * Type exports are re-declared as empty interfaces/types.
 */

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------
let _sessionId = `da-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
export function getSessionId(): string { return _sessionId }

// ---------------------------------------------------------------------------
// Working directory / paths
// ---------------------------------------------------------------------------
export function getOriginalCwd(): string { return process.cwd() }
export function setOriginalCwd(_cwd: string): void {}
export function getProjectRoot(): string { return process.cwd() }

// ---------------------------------------------------------------------------
// Interactive / session mode flags
// ---------------------------------------------------------------------------
export function getIsNonInteractiveSession(): boolean { return true }
export function getIsInteractive(): boolean { return false }
export function getIsRemoteMode(): boolean { return false }
export function isReplBridgeActive(): boolean { return false }

// ---------------------------------------------------------------------------
// SDK / feature flags
// ---------------------------------------------------------------------------
export function getSdkBetas(): string[] { return [] }
export function getKairosActive(): boolean { return false }
export function getSdkAgentProgressSummariesEnabled(): boolean { return false }
export function getQuestionPreviewFormat(): string { return 'default' }
export function isSessionPersistenceDisabled(): boolean { return false }
export function getStrictToolResultPairing(): boolean { return false }
export function getHasUnknownModelCost(): boolean { return false }
export function setHasUnknownModelCost(_v: boolean): void {}

// ---------------------------------------------------------------------------
// Allowed channels / settings
// ---------------------------------------------------------------------------
export function getAllowedChannels(): unknown[] { return [] }
export function getHasDevChannels(): boolean { return false }
export function getAllowedSettingSources(): unknown[] { return [] }

// ---------------------------------------------------------------------------
// User opt-in / trust
// ---------------------------------------------------------------------------
export function getUserMsgOptIn(): boolean | undefined { return undefined }
export function setUserMsgOptIn(_v: boolean): void {}
export function getSessionTrustAccepted(): boolean { return false }
export function setSessionTrustAccepted(_v: boolean): void {}

// ---------------------------------------------------------------------------
// Teams / sessions
// ---------------------------------------------------------------------------
export function getSessionCreatedTeams(): unknown[] { return [] }

// ---------------------------------------------------------------------------
// Token budgets
// ---------------------------------------------------------------------------
export function getCurrentTurnTokenBudget(): number | undefined { return undefined }
export function getTurnOutputTokens(): number { return 0 }
export function incrementBudgetContinuationCount(): void {}

// ---------------------------------------------------------------------------
// Compaction / scroll
// ---------------------------------------------------------------------------
export function markPostCompaction(): void {}
export function markScrollActivity(): void {}
export function getIsScrollDraining(): boolean { return false }
export function waitForScrollIdle(): Promise<void> { return Promise.resolve() }

// ---------------------------------------------------------------------------
// Model / agent
// ---------------------------------------------------------------------------
export function getMainLoopModelOverride(): string | undefined { return undefined }
export function setMainLoopModelOverride(_model: string | undefined): void {}
export function getInitialMainLoopModel(): string | undefined { return undefined }
export function getMainThreadAgentType(): string { return 'main' }

// ---------------------------------------------------------------------------
// Slow operations / telemetry
// ---------------------------------------------------------------------------
export function addSlowOperation(_description: string, _duration: number): void {}
export function getSlowOperations(): Array<{ description: string; duration: number }> { return [] }
export function getEventLogger(): unknown { return null }
export function getPromptId(): string { return '' }
export function setPromptId(_id: string): void {}

// ---------------------------------------------------------------------------
// Activity tracking
// ---------------------------------------------------------------------------
export function getLastInteractionTime(): number { return Date.now() }
export function getActiveTimeCounter(): number { return 0 }
export function updateLastInteractionTime(): void {}
export function flushInteractionTime(): void {}

// ---------------------------------------------------------------------------
// Loc / commit / PR counters
// ---------------------------------------------------------------------------
export function getLocCounter(): number { return 0 }
export function getCommitCounter(): number { return 0 }
export function getPrCounter(): number { return 0 }
export function getCodeEditToolDecisionCounter(): number { return 0 }

// ---------------------------------------------------------------------------
// Direct connect / URL
// ---------------------------------------------------------------------------
export function getDirectConnectServerUrl(): string | undefined { return undefined }

// ---------------------------------------------------------------------------
// Skill tracking
// ---------------------------------------------------------------------------
export function addInvokedSkill(_agentId: string, _skill: unknown): void {}
export function getInvokedSkillsForAgent(_agentId: string): unknown[] { return [] }
export function clearInvokedSkillsForAgent(_agentId: string): void {}

// ---------------------------------------------------------------------------
// Plugin / skill management
// ---------------------------------------------------------------------------
export function getInlinePlugins(): unknown[] { return [] }
export function getUseCoworkPlugins(): boolean { return false }
export function setUseCoworkPlugins(_v: boolean): void {}

// ---------------------------------------------------------------------------
// Plan mode
// ---------------------------------------------------------------------------
export function handlePlanModeTransition(_from: string, _to: string): void {}
export function setHasExitedPlanMode(): void {}
export function setNeedsAutoModeExitAttachment(_v: boolean): void {}
export function setNeedsPlanModeExitAttachment(_v: boolean): void {}
export function getPlanSlugCache(): Map<string, string> { return new Map() }

// ---------------------------------------------------------------------------
// Claude.md directories
// ---------------------------------------------------------------------------
export function getAdditionalDirectoriesForClaudeMd(): string[] { return [] }
export function setAdditionalDirectoriesForClaudeMd(_dirs: string[]): void {}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------
export function setScheduledTasksEnabled(_v: boolean): void {}

// ---------------------------------------------------------------------------
// Teleport
// ---------------------------------------------------------------------------
export function setTeleportedSessionInfo(_info: unknown): void {}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export function registerHookCallbacks(_callbacks: unknown): void {}
export function getRegisteredHooks(): unknown[] { return [] }

// ---------------------------------------------------------------------------
// SDK init
// ---------------------------------------------------------------------------
export function resetSdkInitState(): void {}

// ---------------------------------------------------------------------------
// Agent colors
// ---------------------------------------------------------------------------
export function getAgentColorMap(): Map<string, string> { return new Map() }

// ---------------------------------------------------------------------------
// Last API request
// ---------------------------------------------------------------------------
export function setLastAPIRequest(_req: unknown): void {}
export function setLastAPIRequestMessages(_msgs: unknown): void {}
export function getLastAPIRequest(): unknown { return null }

// ---------------------------------------------------------------------------
// LSP
// ---------------------------------------------------------------------------
export function hasShownLspRecommendationThisSession(): boolean { return false }
export function setLspRecommendationShownThisSession(): void {}

// ---------------------------------------------------------------------------
// Cached claude.md
// ---------------------------------------------------------------------------
export function setCachedClaudeMdContent(_key: string, _content: unknown): void {}

// ---------------------------------------------------------------------------
// Client type
// ---------------------------------------------------------------------------
export function getClientType(): string { return 'da' }

// ---------------------------------------------------------------------------
// CWD state
// ---------------------------------------------------------------------------
export function getCwdState(): unknown { return { cwd: process.cwd() } }

// ---------------------------------------------------------------------------
// Channel entry type (used by DevChannelsDialog)
// ---------------------------------------------------------------------------
export type ChannelEntry = {
  name: string
  description?: string
}
