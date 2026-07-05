import type { AgentTool } from "./types.js";
import type { ToolCall, ChatMessage } from "../../models/provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to tool execution */
export interface ToolExecutionContext {
  taskId: string;
  turn: number;
  onEvent?: (event: any) => void;
  accessedPages?: Map<string, { pageId: string; title: string }>;
  agentSettings?: any;
}

/** Result of executing a batch of tool calls */
export interface ToolBatchResult {
  messages: ChatMessage[];
  /** How many tools ran concurrently */
  concurrentCount: number;
  /** How many ran serially */
  serialCount: number;
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

interface ToolBatch {
  toolCalls: ToolCall[];
  isConcurrent: boolean;
  /** Exclusive tier: destructive operations that must never merge with adjacent batches */
  isExclusive?: boolean;
}

/**
 * Partition tool calls into batches of concurrent-safe and non-safe tools.
 * Consecutive concurrency-safe tools are grouped into one batch.
 * Non-safe tools each get their own batch.
 *
 * Ported from: refcode/claude-code/src/services/tools/toolOrchestration.ts partitionToolCalls()
 */
export function partitionToolCalls(
  toolCalls: ToolCall[],
  tools: Map<string, AgentTool>,
): ToolBatch[] {
  const batches: ToolBatch[] = [];

  for (const toolCall of toolCalls) {
    const tool = tools.get(toolCall.function.name);
    let safe = false;
    let destructive = false;

    if (tool) {
      try {
        const input = JSON.parse(toolCall.function.arguments);

        // Check if tool is destructive (exclusive tier)
        if (tool.isDestructive?.(input)) {
          destructive = true;
        }

        // Existing safety check (only if not destructive)
        if (!destructive) {
          if (tool.isConcurrencySafe?.(input)) {
            safe = true;
          } else if (tool.isReadOnly?.(input)) {
            safe = true;
          }
        }
      } catch {
        safe = false; // parse failure -> not safe
      }
    }

    if (destructive) {
      // Destructive: exclusive batch, never merge with adjacent batches
      batches.push({ toolCalls: [toolCall], isConcurrent: false, isExclusive: true });
    } else if (safe) {
      // Try to merge with previous concurrent batch
      const lastBatch = batches[batches.length - 1];
      if (lastBatch && lastBatch.isConcurrent) {
        lastBatch.toolCalls.push(toolCall);
      } else {
        batches.push({ toolCalls: [toolCall], isConcurrent: true });
      }
    } else {
      // Non-safe: separate batch
      batches.push({ toolCalls: [toolCall], isConcurrent: false });
    }
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Serial execution
// ---------------------------------------------------------------------------

/**
 * Execute tool calls one at a time, in order.
 */
export async function runToolsSerially(
  toolCalls: ToolCall[],
  executeFn: (toolCall: ToolCall) => Promise<ChatMessage>,
): Promise<ChatMessage[]> {
  const results: ChatMessage[] = [];
  for (const toolCall of toolCalls) {
    const result = await executeFn(toolCall);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Concurrent execution
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENCY = 10;

/**
 * Execute tool calls in parallel, limited by maxConcurrency.
 * Results are returned in the same order as input toolCalls.
 *
 * Ported from: refcode/claude-code/src/services/tools/toolOrchestration.ts runToolsConcurrently()
 */
export async function runToolsConcurrently(
  toolCalls: ToolCall[],
  executeFn: (toolCall: ToolCall) => Promise<ChatMessage>,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
): Promise<ChatMessage[]> {
  if (toolCalls.length === 0) return [];

  const results: (ChatMessage | null)[] = new Array(toolCalls.length).fill(null);

  // Simple semaphore-based concurrency control
  let running = 0;
  let nextIndex = 0;

  return new Promise((resolve, reject) => {
    const errors: Error[] = [];

    function startNext() {
      while (running < maxConcurrency && nextIndex < toolCalls.length) {
        const idx = nextIndex++;
        running++;

        executeFn(toolCalls[idx]!)
          .then((result) => {
            results[idx] = result;
          })
          .catch((err) => {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          })
          .finally(() => {
            running--;
            if (nextIndex < toolCalls.length) {
              startNext();
            } else if (running === 0) {
              if (errors.length > 0) {
                reject(errors[0]);
              } else {
                resolve(results as ChatMessage[]);
              }
            }
          });
      }
    }

    startNext();
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Orchestrate a mixed set of tool calls: concurrent-safe ones run in parallel,
 * non-safe ones run serially. Batches execute in order.
 *
 * Ported from: refcode/claude-code/src/services/tools/toolOrchestration.ts runTools()
 */
export async function orchestrateToolCalls(
  toolCalls: ToolCall[],
  tools: Map<string, AgentTool>,
  executeFn: (toolCall: ToolCall) => Promise<ChatMessage>,
  maxConcurrency?: number,
): Promise<ToolBatchResult> {
  if (toolCalls.length === 0) {
    return { messages: [], concurrentCount: 0, serialCount: 0 };
  }

  const batches = partitionToolCalls(toolCalls, tools);
  const allResults: ChatMessage[] = [];
  let concurrentCount = 0;
  let serialCount = 0;

  for (const batch of batches) {
    let results: ChatMessage[];
    if (batch.isConcurrent) {
      results = await runToolsConcurrently(batch.toolCalls, executeFn, maxConcurrency);
      concurrentCount += batch.toolCalls.length;
    } else {
      // Exclusive destructive operations run serially to prevent data corruption
      results = await runToolsSerially(batch.toolCalls, executeFn);
      serialCount += batch.toolCalls.length;
    }
    allResults.push(...results);
  }

  return { messages: allResults, concurrentCount, serialCount };
}
