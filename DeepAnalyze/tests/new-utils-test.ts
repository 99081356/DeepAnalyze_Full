/**
 * End-to-end test for the 3 newly migrated utils:
 *   atomicWrite.ts, logger.ts, retry.ts
 *
 * Run with: npx tsx tests/new-utils-test.ts
 */
import assert from "assert";
import { existsSync, readFileSync, unlinkSync, statSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// =========================================================================
// 1. atomicWrite.ts
// =========================================================================
console.log("\n=== Testing atomicWrite.ts ===");
const { writeFileSyncAtomic } = await import("../src/utils/atomicWrite.ts");

const testDir = join(tmpdir(), `da-atomic-test-${Date.now()}`);

// Helper to create test files
function testFile(name: string): string {
  return join(testDir, name);
}

// Setup
import { mkdirSync } from "node:fs";
mkdirSync(testDir, { recursive: true });

// Basic atomic write
const f1 = testFile("basic.txt");
writeFileSyncAtomic(f1, "hello world");
assert.ok(existsSync(f1));
assert.strictEqual(readFileSync(f1, "utf-8"), "hello world");
console.log("  ✅ Basic atomic write");

// Overwrite existing file
writeFileSyncAtomic(f1, "updated content");
assert.strictEqual(readFileSync(f1, "utf-8"), "updated content");
console.log("  ✅ Overwrite existing file");

// Permission preservation
const f2 = testFile("perms.txt");
writeFileSync(f2, "original", { mode: 0o644 });
const origMode = statSync(f2).mode;
writeFileSyncAtomic(f2, "updated");
const newMode = statSync(f2).mode;
assert.strictEqual(origMode, newMode, "permissions preserved");
console.log("  ✅ Permission preservation");

// Custom encoding
const f3 = testFile("encoding.txt");
writeFileSyncAtomic(f3, "hello", { encoding: "ascii" });
assert.strictEqual(readFileSync(f3, "ascii"), "hello");
console.log("  ✅ Custom encoding");

// Unicode content
const f4 = testFile("unicode.txt");
writeFileSyncAtomic(f4, "你好世界 🌍");
assert.strictEqual(readFileSync(f4, "utf-8"), "你好世界 🌍");
console.log("  ✅ Unicode content");

// Cleanup test dir
try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }

// =========================================================================
// 2. logger.ts
// =========================================================================
console.log("\n=== Testing logger.ts ===");
const { logError, attachErrorLogSink, getInMemoryErrors, _resetErrorLogForTesting, ErrorLogSink } = await import("../src/utils/logger.ts");

// Reset state
_resetErrorLogForTesting();

// Basic logError adds to in-memory buffer
logError(new Error("test error 1"));
logError("string error");
logError(42);
const errors = getInMemoryErrors();
assert.strictEqual(errors.length, 3, "3 errors in buffer");
assert.ok(errors[0]!.error.includes("test error 1"));
assert.ok(errors[1]!.error.includes("string error"));
assert.ok(errors[2]!.error.includes("42"));
console.log("  ✅ logError — adds to in-memory buffer");

// Ring buffer cap at 100
_resetErrorLogForTesting();
for (let i = 0; i < 110; i++) {
  logError(new Error(`error ${i}`));
}
assert.strictEqual(getInMemoryErrors().length, 100, "capped at 100");
// Oldest should be error 10 (first 10 evicted)
assert.ok(getInMemoryErrors()[0]!.error.includes("error 10"));
console.log("  ✅ Ring buffer cap at 100");

// Queue + drain on attach
_resetErrorLogForTesting();
const queuedErrors: Error[] = [];
logError(new Error("before sink 1"));
logError(new Error("before sink 2"));
assert.strictEqual(queuedErrors.length, 0, "nothing forwarded yet");

attachErrorLogSink({
  logError: (err) => { queuedErrors.push(err); },
});
assert.strictEqual(queuedErrors.length, 2, "queued errors drained");
assert.strictEqual(queuedErrors[0]!.message, "before sink 1");
assert.strictEqual(queuedErrors[1]!.message, "before sink 2");
console.log("  ✅ Queue + drain on attach");

// After attach, errors go directly to sink
logError(new Error("after sink"));
assert.strictEqual(queuedErrors.length, 3);
assert.strictEqual(queuedErrors[2]!.message, "after sink");
console.log("  ✅ Direct forwarding after attach");

// Idempotent attach
const secondSinkErrors: Error[] = [];
attachErrorLogSink({
  logError: (err) => { secondSinkErrors.push(err); },
});
logError(new Error("still first sink"));
assert.strictEqual(secondSinkErrors.length, 0, "second sink ignored");
assert.strictEqual(queuedErrors.length, 4, "first sink still active");
console.log("  ✅ Idempotent attach");

// Reset
_resetErrorLogForTesting();
assert.strictEqual(getInMemoryErrors().length, 0);
console.log("  ✅ _resetErrorLogForTesting");

// =========================================================================
// 3. retry.ts
// =========================================================================
console.log("\n=== Testing retry.ts ===");
const { withRetry, getRetryDelay, CannotRetryError, BASE_DELAY_MS } = await import("../src/utils/retry.ts");

// getRetryDelay — exponential backoff
const d1 = getRetryDelay(1);
assert.ok(d1 >= BASE_DELAY_MS && d1 < BASE_DELAY_MS * 1.3, `attempt 1: ${d1}ms in range`);
const d2 = getRetryDelay(2);
assert.ok(d2 >= BASE_DELAY_MS * 2 && d2 < BASE_DELAY_MS * 2.6, `attempt 2: ${d2}ms in range`);
const d3 = getRetryDelay(3);
assert.ok(d3 >= BASE_DELAY_MS * 4 && d3 < BASE_DELAY_MS * 4 * 1.26, `attempt 3: ${d3}ms in range`);
console.log("  ✅ getRetryDelay — exponential backoff with jitter");

// getRetryDelay — respects retryAfter override
const d4 = getRetryDelay(1, 5000);
assert.strictEqual(d4, 5000, "retryAfter overrides backoff");
console.log("  ✅ getRetryDelay — retryAfter override");

// getRetryDelay — respects maxDelay
const d5 = getRetryDelay(10, null, 1000);
assert.ok(d5 >= 1000 && d5 < 1300, `maxDelay capped: ${d5}ms`);
console.log("  ✅ getRetryDelay — maxDelay cap");

// withRetry — succeeds on first try
let callCount = 0;
const r1 = await withRetry(async () => {
  callCount++;
  return 42;
});
assert.strictEqual(r1, 42);
assert.strictEqual(callCount, 1);
console.log("  ✅ withRetry — succeeds on first try");

// withRetry — retries and succeeds
let attempt = 0;
const r2 = await withRetry(
  async (a) => {
    attempt = a;
    if (a < 3) throw Object.assign(new Error("not yet"), { status: 500 });
    return "success";
  },
  { maxRetries: 3, baseDelayMs: 10 },
);
assert.strictEqual(r2, "success");
assert.strictEqual(attempt, 3);
console.log("  ✅ withRetry — retries and succeeds on attempt 3");

// withRetry — CannotRetryError when exhausted
try {
  await withRetry(
    async () => { throw Object.assign(new Error("always fail"), { status: 500 }); },
    { maxRetries: 1, baseDelayMs: 10 },
  );
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e instanceof CannotRetryError);
  assert.strictEqual(e.attempts, 2, "initial + 1 retry");
  assert.ok(e.message.includes("always fail"));
  console.log("  ✅ withRetry — CannotRetryError on exhaustion");
}

// withRetry — non-retryable error throws immediately
try {
  await withRetry(
    async () => { throw new Error("not retryable"); },
    {
      maxRetries: 5,
      baseDelayMs: 10,
      isRetryable: () => false,
    },
  );
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e instanceof CannotRetryError);
  assert.strictEqual(e.attempts, 1, "no retries for non-retryable");
  console.log("  ✅ withRetry — non-retryable error throws immediately");
}

// withRetry — onRetry callback
const retryLog: Array<{ attempt: number; delay: number }> = [];
await withRetry(
  async (a) => {
    if (a < 2) throw Object.assign(new Error("retry me"), { status: 500 });
    return "ok";
  },
  {
    maxRetries: 3,
    baseDelayMs: 10,
    onRetry: (_err, attempt, delay) => { retryLog.push({ attempt, delay }); },
  },
);
assert.strictEqual(retryLog.length, 1, "onRetry called once");
assert.strictEqual(retryLog[0]!.attempt, 1);
console.log("  ✅ withRetry — onRetry callback");

// withRetry — abort signal
const ac = new AbortController();
ac.abort();
try {
  await withRetry(
    async () => "never",
    { signal: ac.signal, baseDelayMs: 10 },
  );
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e instanceof DOMException || (e as Error).name === "AbortError");
  console.log("  ✅ withRetry — abort signal");
}

// withRetry — default retryable: 5xx errors
let retryCount = 0;
try {
  await withRetry(
    async () => {
      retryCount++;
      throw Object.assign(new Error("server error"), { status: 503 });
    },
    { maxRetries: 2, baseDelayMs: 10 },
  );
} catch {
  // expected
}
assert.ok(retryCount > 1, "5xx retried");
console.log("  ✅ withRetry — default retryable (5xx)");

// withRetry — default retryable: network errors
let networkRetryCount = 0;
const r3 = await withRetry(
  async (a) => {
    networkRetryCount = a;
    if (a === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return "recovered";
  },
  { maxRetries: 2, baseDelayMs: 10 },
);
assert.strictEqual(r3, "recovered");
assert.strictEqual(networkRetryCount, 2);
console.log("  ✅ withRetry — default retryable (network error)");

// =========================================================================
// SUMMARY
// =========================================================================
console.log("\n" + "=".repeat(60));
console.log("ALL NEW UTILS TESTS PASSED ✅");
console.log("=".repeat(60));
