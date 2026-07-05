// =============================================================================
// DeepAnalyze - Core Harness Index
// =============================================================================
// Re-exports the core harness components from the Claude Code agent engine.
// These files form the heart of the TAOR (Think-Act-Observe-Reflect) loop.
// =============================================================================

// Core Tool interface and types
export type { Tool, ToolUseContext, ToolInputJSONSchema, ValidationResult } from './Tool.js'

// Query engine (TAOR loop) - re-exports as types only since query.ts is a complex
// module with runtime dependencies that need to be adapted in Task 1.1/1.2
export type { QueryParams } from './query.js'

// Auto-approve permission replacement (bypasses interactive prompts)
export { autoApprove, getAuditLog, clearAuditLog } from './auto-approve.js'
export type { AuditEntry } from './auto-approve.js'

// Central configuration
export { DEEPANALYZE_CONFIG } from './config.js'
export type { DeepAnalyzeConfig } from './config.js'
