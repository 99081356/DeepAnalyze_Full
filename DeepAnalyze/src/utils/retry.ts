/**
 * Generic retry utility with exponential backoff and jitter.
 *
 * Extracted from CC's withRetry.ts, stripped of all Anthropic SDK / auth /
 * fast-mode / analytics coupling. Provides a clean, generic retry primitive
 * for any async operation.
 *
 * Usage:
 *   import { withRetry } from './retry.ts'
 *
 *   const result = await withRetry(
 *     () => fetch('https://api.example.com/data'),
 *     { maxRetries: 3, isRetryable: (err) => err.status >= 500 },
 *   )
 */

import { sleep } from './sleep.ts'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const BASE_DELAY_MS = 500
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_DELAY_MS = 32_000

export interface RetryOptions {
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number
  /** Base delay in ms for exponential backoff (default: 500) */
  baseDelayMs?: number
  /** Maximum delay in ms (default: 32000) */
  maxDelayMs?: number
  /** Abort signal to cancel retries */
  signal?: AbortSignal
  /** Called before each retry with the error and attempt number */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void
  /** Predicate to determine if an error is retryable. Default: retry on network errors and 5xx */
  isRetryable?: (error: unknown) => boolean
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly attempts: number,
  ) {
    const message =
      originalError instanceof Error
        ? originalError.message
        : String(originalError)
    super(`Failed after ${attempts} attempt(s): ${message}`)
    this.name = 'CannotRetryError'

    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

// ---------------------------------------------------------------------------
// Delay calculation
// ---------------------------------------------------------------------------

/**
 * Calculate retry delay with exponential backoff and jitter.
 *
 * @param attempt - Current attempt number (1-based)
 * @param retryAfterMs - Optional server-suggested delay in ms (overrides backoff)
 * @param maxDelayMs - Maximum delay cap
 * @returns Delay in milliseconds
 */
export function getRetryDelay(
  attempt: number,
  retryAfterMs?: number | null,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
  baseDelayMs: number = BASE_DELAY_MS,
): number {
  // Honor server-suggested delay
  if (retryAfterMs != null && retryAfterMs > 0) {
    return retryAfterMs
  }

  // Exponential backoff: base * 2^(attempt-1), capped at maxDelay
  const baseDelay = Math.min(
    baseDelayMs * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  // Add jitter: 0..25% of base delay
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

// ---------------------------------------------------------------------------
// Default retryable predicate
// ---------------------------------------------------------------------------

function defaultIsRetryable(error: unknown): boolean {
  // Network errors
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true
  }
  // HTTP errors with status >= 500 (except 501 Not Implemented)
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    const status = (error as { status: number }).status
    return status >= 500 && status !== 501
  }
  // Connection reset / timeout errors
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error
  ) {
    const code = (error as { code: string }).code
    return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE'
  }
  return false
}

// ---------------------------------------------------------------------------
// Main retry loop
// ---------------------------------------------------------------------------

/**
 * Execute an async operation with automatic retry on retryable errors.
 *
 * @param operation - The async function to execute
 * @param options - Retry configuration
 * @returns The result of the operation
 * @throws CannotRetryError when all retries are exhausted
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelay = options.baseDelayMs ?? BASE_DELAY_MS
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const isRetryable = options.isRetryable ?? defaultIsRetryable

  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error

      // Check if we've exhausted retries
      if (attempt > maxRetries) {
        throw new CannotRetryError(error, attempt)
      }

      // Check if error is retryable
      if (!isRetryable(error)) {
        throw new CannotRetryError(error, attempt)
      }

      // Calculate delay
      const retryAfterMs = extractRetryAfterMs(error)
      const delayMs = getRetryDelay(attempt, retryAfterMs, maxDelay, baseDelay)

      // Notify caller
      const err = error instanceof Error ? error : new Error(String(error))
      options.onRetry?.(err, attempt, delayMs)

      // Wait before retrying
      await sleep(delayMs, options.signal)
    }
  }

  throw new CannotRetryError(lastError, maxRetries + 1)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract Retry-After value from an error object (in ms).
 * Handles both header-based and property-based patterns.
 */
function extractRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null

  // Check for headers.get('retry-after') pattern (fetch Response-like)
  const headers = (error as { headers?: { get?: (name: string) => string | null } }).headers
  if (headers?.get) {
    const retryAfter = headers.get('retry-after')
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) return seconds * 1000
    }
  }

  // Check for retryAfter property (ms)
  if ('retryAfterMs' in error && typeof (error as { retryAfterMs: unknown }).retryAfterMs === 'number') {
    return (error as { retryAfterMs: number }).retryAfterMs
  }

  return null
}
