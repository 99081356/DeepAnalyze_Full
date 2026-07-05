// =============================================================================
// DeepAnalyze - Task Event Buffer
// =============================================================================
// In-memory per-task event buffer that decouples agent execution from SSE
// connections. Allows clients to disconnect and reconnect without losing
// events, enabling persistent agent tasks across page refreshes.
// =============================================================================

/** Maximum events retained per task before evicting old content_deltas. */
const MAX_EVENTS_PER_TASK = 5000;

/** Events that should never be evicted (important for result integrity). */
const PROTECTED_EVENTS = new Set([
  "push_content",
  "complete",
  "done",
  "error",
  "cancelled",
  "workflow_complete",
  "workflow_event",
  "workflow_start",
]);

/** How long (ms) to keep a completed task's buffer before garbage-collecting. */
const COMPLETED_TTL_MS = 30 * 60 * 1000; // 30 minutes (long tasks need more replay time)

/** A buffered SSE event with its type and serialized data. */
export interface BufferedEvent {
  event: string;
  data: unknown;
  timestamp: number;
}

type Subscriber = (event: string, data: unknown) => void;

interface TaskBuffer {
  events: BufferedEvent[];
  completed: boolean;
  completedAt: number;
  subscribers: Set<Subscriber>;
}

/**
 * Singleton event buffer for decoupling agent execution from HTTP connections.
 * Agent onEvent callbacks push events here; SSE streams subscribe to receive them.
 */
class TaskEventBuffer {
  private buffers = new Map<string, TaskBuffer>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodically garbage-collect completed buffers older than COMPLETED_TTL_MS
    this.gcTimer = setInterval(() => this.gc(), 60_000);
    // Don't prevent process shutdown
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  /**
   * Push an event for a task. All current subscribers are notified immediately.
   */
  push(taskId: string, event: string, data: unknown): void {
    let buf = this.buffers.get(taskId);
    if (!buf) {
      buf = { events: [], completed: false, completedAt: 0, subscribers: new Set() };
      this.buffers.set(taskId, buf);
    }

    const entry: BufferedEvent = { event, data, timestamp: Date.now() };
    buf.events.push(entry);

    // Enforce cap: evict oldest content_delta events first, protect important events
    if (buf.events.length > MAX_EVENTS_PER_TASK) {
      // Strategy 1: Remove oldest content_delta (most common, least valuable for replay)
      const deltaIdx = buf.events.findIndex(
        (e) => e.event === "content_delta" && !PROTECTED_EVENTS.has(e.event)
      );
      if (deltaIdx >= 0) {
        buf.events.splice(deltaIdx, 1);
      } else {
        // Strategy 2: Remove oldest non-protected event
        const nonProtectedIdx = buf.events.findIndex((e) => !PROTECTED_EVENTS.has(e.event));
        if (nonProtectedIdx >= 0) {
          buf.events.splice(nonProtectedIdx, 1);
        } else {
          // All events are protected — shouldn't happen, but drop oldest as last resort
          buf.events.shift();
        }
      }
    }

    // Notify all subscribers
    for (const cb of buf.subscribers) {
      try {
        cb(event, data);
      } catch {
        // Subscriber errors shouldn't crash the buffer
      }
    }
  }

  /**
   * Subscribe to live events for a task. Returns an unsubscribe function.
   */
  subscribe(taskId: string, callback: Subscriber): () => void {
    let buf = this.buffers.get(taskId);
    if (!buf) {
      buf = { events: [], completed: false, completedAt: 0, subscribers: new Set() };
      this.buffers.set(taskId, buf);
    }
    buf.subscribers.add(callback);
    return () => {
      buf!.subscribers.delete(callback);
    };
  }

  /**
   * Get all buffered events for a task (for replay on reconnect).
   */
  getEvents(taskId: string): BufferedEvent[] {
    const buf = this.buffers.get(taskId);
    return buf ? [...buf.events] : [];
  }

  /**
   * Check whether a task buffer exists.
   */
  has(taskId: string): boolean {
    return this.buffers.has(taskId);
  }

  /**
   * Check whether a task has completed.
   */
  isCompleted(taskId: string): boolean {
    const buf = this.buffers.get(taskId);
    return buf?.completed ?? false;
  }

  /**
   * Mark a task as completed. The buffer is retained for COMPLETED_TTL_MS
   * to allow late reconnections.
   */
  markCompleted(taskId: string): void {
    const buf = this.buffers.get(taskId);
    if (buf) {
      buf.completed = true;
      buf.completedAt = Date.now();
    }
  }

  /** Garbage-collect expired completed buffers. */
  private gc(): void {
    const now = Date.now();
    for (const [id, buf] of this.buffers) {
      if (buf.completed && now - buf.completedAt > COMPLETED_TTL_MS) {
        this.buffers.delete(id);
      }
    }
  }

  /** Cleanup for tests or graceful shutdown. */
  destroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    this.buffers.clear();
  }
}

/** Global singleton instance. */
export const taskEventBuffer = new TaskEventBuffer();
