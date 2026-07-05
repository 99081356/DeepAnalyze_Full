// =============================================================================
// DeepAnalyze - Event Bus
// Lightweight typed event bus for cross-module coordination.
// Modules emit events; other modules subscribe to react to them.
// =============================================================================

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type SystemEvent =
  | { type: "doc_processed"; kbId: string; docId: string; filename: string; status: "ready" | "error" }
  | { type: "doc_processing_progress"; kbId: string; docId: string; step: string; progress: number }
  | { type: "agent_task_complete"; sessionId: string; taskId: string; agentType: string; output: string }
  | { type: "compound_written"; kbId: string; pageId: string; title: string }
  | { type: "knowledge_search"; kbId: string; query: string; resultCount: number };

type EventHandler = (event: SystemEvent) => void | Promise<void>;

import { logError } from "../utils/logger.ts";

// ---------------------------------------------------------------------------
// EventBus — singleton
// ---------------------------------------------------------------------------

class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  /**
   * Subscribe to events of a specific type.
   * Returns an unsubscribe function.
   */
  on(eventType: SystemEvent["type"], handler: EventHandler): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);

    // Return unsubscribe function
    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.handlers.delete(eventType);
      }
    };
  }

  /**
   * Unsubscribe a specific handler from an event type.
   */
  off(eventType: SystemEvent["type"], handler: EventHandler): void {
    const set = this.handlers.get(eventType);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(eventType);
      }
    }
  }

  /**
   * Emit an event to all subscribers.
   * Handlers are called synchronously; if a handler returns a Promise,
   * it is fire-and-forget (errors are logged but not propagated).
   */
  emit(event: SystemEvent): void {
    const set = this.handlers.get(event.type);
    if (!set) return;

    for (const handler of set) {
      try {
        const result = handler(event);
        // If handler returns a promise, catch errors
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(
              `[EventBus] Async handler error for event "${event.type}":`,
              err instanceof Error ? err.message : String(err),
            );
            logError(err);
          });
        }
      } catch (err) {
        console.error(
          `[EventBus] Handler error for event "${event.type}":`,
          err instanceof Error ? err.message : String(err),
        );
        logError(err);
      }
    }
  }

  /**
   * Remove all handlers for a specific event type, or all handlers if no type given.
   */
  clear(eventType?: SystemEvent["type"]): void {
    if (eventType) {
      this.handlers.delete(eventType);
    } else {
      this.handlers.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const eventBus = new EventBus();
