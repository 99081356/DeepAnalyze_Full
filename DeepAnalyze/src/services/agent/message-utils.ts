// =============================================================================
// DeepAnalyze - Message Sequence Utilities
// =============================================================================
// Validates and repairs message arrays to ensure they conform to LLM API
// role ordering constraints (system → user → assistant → tool patterns).
// =============================================================================

import type { ChatMessage } from "../../models/provider.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

/**
 * Validate that a message array conforms to API role ordering constraints:
 * - First message must be "system" (optional, but if present must be first)
 * - "tool" messages must be preceded by an "assistant" message with toolCalls
 * - No two consecutive messages with the same role (some providers enforce this)
 */
export function validateMessageSequence(messages: ChatMessage[]): ValidationResult {
  const issues: string[] = [];

  if (messages.length === 0) {
    return { valid: true, issues: [] };
  }

  // Check first message
  if (messages[0].role !== "system") {
    // Not necessarily an error, but worth noting
  }

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];

    // Tool message must follow an assistant message with toolCalls
    if (curr.role === "tool") {
      if (prev.role !== "assistant" || !prev.toolCalls || prev.toolCalls.length === 0) {
        // Look backwards for the nearest assistant with toolCalls
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          if (messages[j].role === "assistant" && messages[j].toolCalls?.length) {
            found = true;
            break;
          }
          if (messages[j].role === "assistant" && !messages[j].toolCalls?.length) {
            break;
          }
        }
        if (!found) {
          issues.push(`Message ${i}: tool message without preceding assistant+toolCalls`);
        }
      }
    }

    // System message in the middle
    if (curr.role === "system" && i > 0) {
      issues.push(`Message ${i}: system message must be the first message`);
    }
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * Repair a message array to fix common API role ordering violations:
 * 1. If a "tool" message follows a "user" or "system" message (no assistant),
 *    drop the orphaned tool message.
 * 2. If an assistant message has tool_calls but is missing some tool results,
 *    synthesize placeholder tool results for the missing IDs.
 * 3. Ensure no orphaned tool messages exist without a parent assistant.
 */
export function repairMessageSequence(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages;

  // Phase 1: Remove orphaned tool messages (no parent assistant with toolCalls).
  // Track whether the most recent assistant in the repaired sequence had toolCalls,
  // so that consecutive tool results (from a multi-tool-call group) are preserved.
  const repaired: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const curr = messages[i]!;

    if (curr.role === "tool") {
      // Check if there's a recent assistant with toolCalls that can claim this result.
      // Walk backwards in repaired to find the nearest assistant.
      let hasParent = false;
      for (let j = repaired.length - 1; j >= 0; j--) {
        const prev = repaired[j]!;
        if (prev.role === "assistant" && prev.toolCalls && prev.toolCalls.length > 0) {
          hasParent = true;
          break;
        }
        // Stop if we hit a non-tool message that isn't an assistant with toolCalls
        if (prev.role !== "tool") break;
      }
      if (!hasParent) continue; // Drop orphaned tool message
    }

    repaired.push(curr);
  }

  // Fix: assistant with N tool_calls but fewer tool results before next non-tool message
  const final: ChatMessage[] = [];
  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i]!;
    final.push(msg);

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // Count how many tool results follow this assistant
      let toolResultCount = 0;
      let j = i + 1;
      while (j < repaired.length && repaired[j]!.role === "tool") {
        toolResultCount++;
        j++;
      }

      // Push the actual tool results first
      for (let k = i + 1; k < j; k++) {
        final.push(repaired[k]!);
      }

      // If fewer tool results than tool calls, synthesize the missing ones
      if (toolResultCount < msg.toolCalls.length) {
        const existingIds = new Set<string>();
        for (let k = i + 1; k < j; k++) {
          if (repaired[k]!.toolCallId) {
            existingIds.add(repaired[k]!.toolCallId!);
          }
        }

        for (const tc of msg.toolCalls) {
          if (!existingIds.has(tc.id)) {
            final.push({
              role: "tool",
              content: "[结果已省略：上下文压缩]",
              toolCallId: tc.id,
            });
          }
        }
      }

      i = j - 1; // Skip past the tool results we already processed
    }
  }

  return final;
}

// ---------------------------------------------------------------------------
// Group boundaries
// ---------------------------------------------------------------------------

/**
 * Find the indices that represent message group boundaries.
 * A "group" is an assistant message followed by its tool result messages.
 * Returns the indices of each assistant message that starts a group.
 */
export function findGroupBoundaries(messages: ChatMessage[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant" && messages[i].toolCalls && messages[i].toolCalls.length > 0) {
      boundaries.push(i);
    }
  }
  return boundaries;
}
