/**
 * Structured error logging with pluggable sink and in-memory ring buffer.
 *
 * Core pattern from CC's log.ts:
 * - Errors are always stored in an in-memory ring buffer (max 100)
 * - A pluggable ErrorLogSink can be attached for persistent logging
 * - Events logged before sink attachment are queued and drained on attach
 *
 * Usage:
 *   import { logError, attachErrorLogSink, getInMemoryErrors } from './logger.ts'
 *
 *   // During startup, errors are buffered in memory
 *   logError(new Error('something failed'))
 *
 *   // Later, attach a persistent sink — queued events drain immediately
 *   attachErrorLogSink({
 *     logError: (err) => fs.appendFileSync('errors.log', err.stack + '\n'),
 *   })
 */

import { toError } from './errors.ts'

// ---------------------------------------------------------------------------
// In-memory error ring buffer
// ---------------------------------------------------------------------------

const MAX_IN_MEMORY_ERRORS = 100
const inMemoryErrorLog: Array<{ error: string; timestamp: string }> = []

function addToInMemoryErrorLog(errorInfo: { error: string; timestamp: string }): void {
  if (inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    inMemoryErrorLog.shift()
  }
  inMemoryErrorLog.push(errorInfo)
}

/**
 * Return a snapshot of the in-memory error ring buffer (most recent last).
 */
export function getInMemoryErrors(): ReadonlyArray<{ error: string; timestamp: string }> {
  return [...inMemoryErrorLog]
}

// ---------------------------------------------------------------------------
// Pluggable error log sink
// ---------------------------------------------------------------------------

export interface ErrorLogSink {
  logError: (error: Error) => void
}

// Queued events for errors logged before sink attachment
type QueuedErrorEvent = { type: 'error'; error: Error }
const errorQueue: QueuedErrorEvent[] = []

let errorLogSink: ErrorLogSink | null = null

/**
 * Attach a persistent error log sink.
 *
 * Queued events (logged before this call) are drained immediately.
 * Idempotent: calling again after a sink is attached is a no-op.
 */
export function attachErrorLogSink(sink: ErrorLogSink): void {
  if (errorLogSink !== null) return
  errorLogSink = sink

  // Drain queue
  if (errorQueue.length > 0) {
    const queued = [...errorQueue]
    errorQueue.length = 0
    for (const event of queued) {
      sink.logError(event.error)
    }
  }
}

// ---------------------------------------------------------------------------
// Public logError
// ---------------------------------------------------------------------------

/**
 * Log an error to the in-memory ring buffer and (if attached) the persistent sink.
 *
 * Never throws — errors in the logging itself are silently swallowed.
 */
export function logError(error: unknown): void {
  try {
    const err = toError(error)
    const errorStr = err.stack || err.message

    addToInMemoryErrorLog({
      error: errorStr,
      timestamp: new Date().toISOString(),
    })

    if (errorLogSink === null) {
      errorQueue.push({ type: 'error', error: err })
      return
    }

    errorLogSink.logError(err)
  } catch {
    // Swallow — logging must never throw
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset all error log state. For testing only.
 * @internal
 */
export function _resetErrorLogForTesting(): void {
  errorLogSink = null
  errorQueue.length = 0
  inMemoryErrorLog.length = 0
}
