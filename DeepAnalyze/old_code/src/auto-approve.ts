// =============================================================================
// DeepAnalyze - Auto-Approve Permission Module
// =============================================================================
//
// Standalone replacement for the interactive permission system.  Every tool
// call is automatically approved and recorded to an in-memory audit log so
// the agent can execute long tasks without pausing for human confirmation.
//
// This module is intentionally self-contained: it has zero runtime imports
// from the rest of the codebase and can be wired into the query loop by
// simply passing `autoApprove` as the `canUseTool` parameter of QueryParams.
//
// The return type matches CanUseToolFn (defined in src/hooks/useCanUseTool.tsx)
// which expects:  (tool, input, toolUseContext, assistantMessage, toolUseID)
//   => Promise<PermissionDecision>
//
// PermissionDecision is a union of:
//   PermissionAllowDecision  { behavior: 'allow', updatedInput?, ... }
//   PermissionAskDecision    { behavior: 'ask',   message, ... }
//   PermissionDenyDecision   { behavior: 'deny',  message, decisionReason }
//
// We always return the 'allow' variant with a decisionReason that mimics the
// existing bypassPermissions mode so downstream consumers (e.g. analytics,
// logging) can attribute the decision correctly.
// =============================================================================

import type { Tool, ToolUseContext } from "./Tool.js"
import type { PermissionAllowDecision } from "../types/permissions.js"

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  /** ISO-8601 timestamp of when the approval was recorded */
  timestamp: string
  /** Name of the tool that was approved */
  toolName: string
  /** The tool input that was approved (may contain sensitive data) */
  input: unknown
  /** Always "approved" -- kept for forward-compatibility if we add deny later */
  decision: "approved"
  /** Human-readable reason string for audit trail */
  reason: string
}

/** In-memory audit buffer.  Can be swapped out for a persistent store later. */
const auditLog: AuditEntry[] = []

/** Return a shallow copy of the current audit log. */
export function getAuditLog(): AuditEntry[] {
  return [...auditLog]
}

/** Clear the in-memory audit log (useful in tests). */
export function clearAuditLog(): void {
  auditLog.length = 0
}

// ---------------------------------------------------------------------------
// Auto-approve implementation
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for the interactive `CanUseToolFn`.
 *
 * Every invocation is logged to the in-memory audit buffer and immediately
 * approved without prompting the user.
 */
export async function autoApprove<Input extends Record<string, unknown> = Record<string, unknown>>(
  _tool: Tool,
  input: Input,
  _context: ToolUseContext,
  _assistantMessage: unknown,
  _toolUseID: string,
): Promise<PermissionAllowDecision<Input>> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    toolName: _tool.name,
    input,
    decision: "approved",
    reason: "auto-approved (bypassPermissions mode)",
  }
  auditLog.push(entry)

  const decisionReason = {
    type: "mode" as const,
    mode: "bypassPermissions" as const,
  }

  return {
    behavior: "allow",
    updatedInput: input,
    decisionReason,
  }
}
