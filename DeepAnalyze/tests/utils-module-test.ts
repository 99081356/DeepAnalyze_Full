/**
 * End-to-end test for all migrated utils modules.
 * Run with: npx tsx tests/utils-module-test.ts
 */
import assert from "assert";

// =========================================================================
// 1. errors.ts
// =========================================================================
console.log("\n=== Testing errors.ts ===");
const { errorMessage, toError, AbortError, isAbortError, AgentTimeoutError, ConfigParseError, ShellError, hasExactErrorMessage, getErrnoCode, isENOENT, getErrnoPath, shortErrorStack, isFsInaccessible } = await import("../src/utils/errors.ts");

// errorMessage
assert.strictEqual(errorMessage(new Error("hello")), "hello", "errorMessage(Error)");
assert.strictEqual(errorMessage("raw string"), "raw string", "errorMessage(string)");
assert.strictEqual(errorMessage(42), "42", "errorMessage(number)");
assert.strictEqual(errorMessage(null), "null", "errorMessage(null)");
assert.strictEqual(errorMessage(undefined), "undefined", "errorMessage(undefined)");
console.log("  ✅ errorMessage() — all types");

// toError
assert.ok(toError(new Error("x")) instanceof Error, "toError(Error)");
assert.ok(toError("str") instanceof Error, "toError(string)");
assert.strictEqual(toError("str").message, "str", "toError(string).message");
console.log("  ✅ toError()");

// AbortError + isAbortError
const abortErr = new AbortError("test abort");
assert.strictEqual(abortErr.name, "AbortError");
assert.ok(isAbortError(abortErr), "isAbortError(AbortError)");
assert.ok(isAbortError(new DOMException("aborted", "AbortError")), "isAbortError(DOMException)");
assert.ok(!isAbortError(new Error("not abort")), "!isAbortError(Error)");
console.log("  ✅ AbortError + isAbortError()");

// AgentTimeoutError
const timeoutErr = new AgentTimeoutError("agent timed out", 30000);
assert.strictEqual(timeoutErr.name, "AgentTimeoutError");
assert.strictEqual(timeoutErr.timeoutMs, 30000);
assert.ok(timeoutErr instanceof Error);
console.log("  ✅ AgentTimeoutError");

// ConfigParseError
const cfgErr = new ConfigParseError("bad config", "/path/to/config", { default: true });
assert.strictEqual(cfgErr.name, "ConfigParseError");
assert.strictEqual(cfgErr.filePath, "/path/to/config");
assert.deepStrictEqual(cfgErr.defaultConfig, { default: true });
console.log("  ✅ ConfigParseError");

// ShellError
const shellErr = new ShellError("stdout", "stderr", 1, false);
assert.strictEqual(shellErr.name, "ShellError");
assert.strictEqual(shellErr.stdout, "stdout");
assert.strictEqual(shellErr.stderr, "stderr");
assert.strictEqual(shellErr.code, 1);
console.log("  ✅ ShellError");

// hasExactErrorMessage
assert.ok(hasExactErrorMessage(new Error("exact"), "exact"));
assert.ok(!hasExactErrorMessage(new Error("exact"), "other"));
assert.ok(!hasExactErrorMessage("string", "string"));
console.log("  ✅ hasExactErrorMessage()");

// getErrnoCode + isENOENT + getErrnoPath + isFsInaccessible
assert.strictEqual(getErrnoCode({ code: "ENOENT" }), "ENOENT");
assert.strictEqual(getErrnoCode(new Error("no code")), undefined);
assert.ok(isENOENT({ code: "ENOENT" }));
assert.ok(!isENOENT({ code: "EACCES" }));
assert.strictEqual(getErrnoPath({ path: "/foo/bar" }), "/foo/bar");
assert.strictEqual(getErrnoPath(new Error("no path")), undefined);
assert.ok(isFsInaccessible({ code: "ENOENT" }));
assert.ok(isFsInaccessible({ code: "EACCES" }));
assert.ok(isFsInaccessible({ code: "EPERM" }));
assert.ok(!isFsInaccessible({ code: "UNKNOWN" }));
console.log("  ✅ getErrnoCode, isENOENT, getErrnoPath, isFsInaccessible");

// shortErrorStack
const longStackErr = new Error("test");
longStackErr.stack = "Error: test\n    at frame1\n    at frame2\n    at frame3\n    at frame4\n    at frame5\n    at frame6\n    at frame7";
const shortStack = shortErrorStack(longStackErr, 3);
assert.ok(shortStack.includes("frame1"));
assert.ok(shortStack.includes("frame3"));
assert.ok(!shortStack.includes("frame4"));
console.log("  ✅ shortErrorStack()");

// =========================================================================
// 2. sleep.ts
// =========================================================================
console.log("\n=== Testing sleep.ts ===");
const { sleep, withTimeout } = await import("../src/utils/sleep.ts");

// Basic sleep
const start = Date.now();
await sleep(50);
const elapsed = Date.now() - start;
assert.ok(elapsed >= 40, `sleep(50) took ${elapsed}ms, expected ~50ms`);
console.log("  ✅ sleep(50) — basic");

// Sleep with abort
const ac = new AbortController();
setTimeout(() => ac.abort(), 20);
const abortStart = Date.now();
await sleep(5000, ac.signal);
const abortElapsed = Date.now() - abortStart;
assert.ok(abortElapsed < 200, `aborted sleep took ${abortElapsed}ms, should be <200ms`);
console.log("  ✅ sleep() — abort resolves early");

// Sleep with throwOnAbort
const ac2 = new AbortController();
setTimeout(() => ac2.abort(), 20);
try {
  await sleep(5000, ac2.signal, { throwOnAbort: true });
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e instanceof Error);
  console.log("  ✅ sleep() — throwOnAbort rejects");
}

// withTimeout — timeout fires when inner promise is slow
const slowPromise = new Promise<never>((resolve) => setTimeout(() => resolve(undefined as never), 10000));
try {
  await withTimeout(slowPromise, 50, "timeout test");
  assert.fail("should have thrown");
} catch (e) {
  assert.ok(e instanceof Error);
  assert.strictEqual(e.message, "timeout test");
  console.log("  ✅ withTimeout() — timeout fires");
}

// withTimeout — promise resolves before timeout
const wtResult2 = await withTimeout(Promise.resolve(42), 5000, "should not fire");
assert.strictEqual(wtResult2, 42);
console.log("  ✅ withTimeout() — promise wins");

// =========================================================================
// 3. CircularBuffer.ts
// =========================================================================
console.log("\n=== Testing CircularBuffer.ts ===");
const { CircularBuffer } = await import("../src/utils/CircularBuffer.ts");

const buf = new CircularBuffer<number>(3);
assert.strictEqual(buf.length(), 0);
buf.add(1);
buf.add(2);
buf.add(3);
assert.strictEqual(buf.length(), 3);
assert.deepStrictEqual(buf.toArray(), [1, 2, 3]);
buf.add(4); // evicts 1
assert.strictEqual(buf.length(), 3);
assert.deepStrictEqual(buf.toArray(), [2, 3, 4]);
assert.deepStrictEqual(buf.getRecent(2), [3, 4]);
buf.clear();
assert.strictEqual(buf.length(), 0);
console.log("  ✅ CircularBuffer — add, evict, toArray, getRecent, clear");

// addAll
const buf2 = new CircularBuffer<number>(5);
buf2.addAll([10, 20, 30]);
assert.deepStrictEqual(buf2.toArray(), [10, 20, 30]);
console.log("  ✅ CircularBuffer — addAll");

// =========================================================================
// 4. sanitization.ts
// =========================================================================
console.log("\n=== Testing sanitization.ts ===");
const { partiallySanitizeUnicode, recursivelySanitizeUnicode } = await import("../src/utils/sanitization.ts");

// Zero-width characters removed
assert.ok(!partiallySanitizeUnicode("hello\u200Bworld").includes("\u200B"), "zero-width space removed");
// BOM removed
assert.ok(!partiallySanitizeUnicode("\uFEFFhello").includes("\uFEFF"), "BOM removed");
// Normal text preserved
assert.strictEqual(partiallySanitizeUnicode("hello world"), "hello world");
// NFKC normalization
assert.strictEqual(partiallySanitizeUnicode("\u004B\u0301"), "\u1E30"); // K + combining accent → Ḱ
console.log("  ✅ partiallySanitizeUnicode()");

// Recursive sanitization
assert.deepStrictEqual(
  recursivelySanitizeUnicode({ key: "val\u200Bue", arr: ["a\u200Bb"] }),
  { key: "value", arr: ["ab"] }
);
console.log("  ✅ recursivelySanitizeUnicode() — objects and arrays");

// =========================================================================
// 5. yaml.ts
// =========================================================================
console.log("\n=== Testing yaml.ts ===");
const { parseYaml } = await import("../src/utils/yaml.ts");

const yamlResult = parseYaml("name: test\nvalue: 42") as Record<string, unknown>;
assert.strictEqual(yamlResult.name, "test");
assert.strictEqual(yamlResult.value, 42);
console.log("  ✅ parseYaml() — basic YAML");

const yamlArray = parseYaml("- a\n- b\n- c") as string[];
assert.deepStrictEqual(yamlArray, ["a", "b", "c"]);
console.log("  ✅ parseYaml() — YAML array");

// =========================================================================
// 6. format.ts
// =========================================================================
console.log("\n=== Testing format.ts ===");
const { formatFileSize, formatDuration, formatSecondsShort, formatNumber, formatTokens, formatRelativeTime, formatRelativeTimeAgo } = await import("../src/utils/format.ts");

assert.ok(formatFileSize(0).includes("0"));
assert.ok(formatFileSize(1023).includes("1023"));
assert.ok(formatFileSize(1024).includes("1"));
assert.ok(formatFileSize(1048576).includes("1"));
assert.ok(formatFileSize(1073741824).includes("1"));
console.log("  ✅ formatFileSize()");

assert.strictEqual(formatSecondsShort(1500), "1.5s");
assert.strictEqual(formatSecondsShort(0), "0.0s");
console.log("  ✅ formatSecondsShort()");

assert.ok(formatDuration(90061000).includes("1d"));
assert.ok(formatDuration(90061000).includes("1h"));
assert.ok(formatDuration(3661000).includes("1h"));
assert.ok(formatDuration(3661000).includes("1m"));
console.log("  ✅ formatDuration()");

assert.ok(typeof formatNumber(1300) === "string" && formatNumber(1300).length > 0);
console.log(`  ✅ formatNumber(1300) = "${formatNumber(1300)}"`);

assert.ok(typeof formatTokens(15000) === "string");
console.log(`  ✅ formatTokens(15000) = "${formatTokens(15000)}"`);

// =========================================================================
// 7. intl.ts
// =========================================================================
console.log("\n=== Testing intl.ts ===");
const { getGraphemeSegmenter, firstGrapheme, lastGrapheme, getWordSegmenter, getRelativeTimeFormat, getTimeZone, getSystemLocaleLanguage } = await import("../src/utils/intl.ts");

assert.strictEqual(firstGrapheme("hello"), "h");
assert.strictEqual(firstGrapheme(""), "");
assert.strictEqual(firstGrapheme("🇺🇸flag"), "🇺🇸");
console.log("  ✅ firstGrapheme()");

assert.strictEqual(lastGrapheme("hello"), "o");
assert.strictEqual(lastGrapheme(""), "");
console.log("  ✅ lastGrapheme()");

assert.ok(getTimeZone().length > 0);
console.log(`  ✅ getTimeZone() = "${getTimeZone()}"`);

assert.ok(typeof getSystemLocaleLanguage() === "string" || getSystemLocaleLanguage() === undefined);
console.log("  ✅ getSystemLocaleLanguage()");

const rtf = getRelativeTimeFormat("short", "auto");
assert.ok(typeof rtf.format(-1, "day") === "string");
console.log("  ✅ getRelativeTimeFormat()");

// =========================================================================
// 8. abortController.ts + combinedAbortSignal.ts
// =========================================================================
console.log("\n=== Testing abortController.ts + combinedAbortSignal.ts ===");
const { createAbortController, createChildAbortController } = await import("../src/utils/abortController.ts");
const { createCombinedAbortSignal } = await import("../src/utils/combinedAbortSignal.ts");

const parent = createAbortController();
const child = createChildAbortController(parent);
assert.ok(!child.signal.aborted);
parent.abort("parent reason");
// Give event loop a tick
await sleep(10);
assert.ok(child.signal.aborted);
assert.strictEqual(child.signal.reason, "parent reason");
console.log("  ✅ createChildAbortController — propagation");

// Combined signal
const cs1 = createCombinedAbortSignal(undefined);
assert.ok(!cs1.signal.aborted);
cs1.cleanup();
console.log("  ✅ createCombinedAbortSignal — no inputs");

const ac3 = new AbortController();
const cs2 = createCombinedAbortSignal(ac3.signal, { timeoutMs: 50 });
assert.ok(!cs2.signal.aborted);
await sleep(80);
assert.ok(cs2.signal.aborted);
cs2.cleanup();
console.log("  ✅ createCombinedAbortSignal — timeout");

// =========================================================================
// 9. cleanupRegistry.ts
// =========================================================================
console.log("\n=== Testing cleanupRegistry.ts ===");
const { registerCleanup, runCleanupFunctions } = await import("../src/utils/cleanupRegistry.ts");

let cleanupCalled = false;
const unregister = registerCleanup(async () => { cleanupCalled = true; });
await runCleanupFunctions();
assert.ok(cleanupCalled, "cleanup function was called");
console.log("  ✅ registerCleanup + runCleanupFunctions");

// Unregister
let cleanup2Called = false;
const unregister2 = registerCleanup(async () => { cleanup2Called = true; });
unregister2();
await runCleanupFunctions();
assert.ok(!cleanup2Called, "unregistered cleanup was NOT called");
console.log("  ✅ unregister prevents cleanup");

// =========================================================================
// 10. memoize.ts
// =========================================================================
console.log("\n=== Testing memoize.ts ===");
const { memoizeWithTTL, memoizeWithTTLAsync, memoizeWithLRU } = await import("../src/utils/memoize.ts");

let callCount = 0;
const memoFn = memoizeWithTTL((x: number) => { callCount++; return x * 2; }, 5000);
assert.strictEqual(memoFn(5), 10);
assert.strictEqual(callCount, 1);
assert.strictEqual(memoFn(5), 10);
assert.strictEqual(callCount, 1); // cached
console.log("  ✅ memoizeWithTTL — caching works");

let asyncCallCount = 0;
const asyncMemo = memoizeWithTTLAsync(async (x: number) => { asyncCallCount++; return x * 3; }, 5000);
assert.strictEqual(await asyncMemo(7), 21);
assert.strictEqual(asyncCallCount, 1);
assert.strictEqual(await asyncMemo(7), 21);
assert.strictEqual(asyncCallCount, 1);
console.log("  ✅ memoizeWithTTLAsync — caching works");

// =========================================================================
// 11. frontmatterParser.ts
// =========================================================================
console.log("\n=== Testing frontmatterParser.ts ===");
const { parseFrontmatter, parsePositiveIntFromFrontmatter, parseBooleanFrontmatter } = await import("../src/utils/frontmatterParser.ts");

const md = `---
name: test-doc
version: 3
enabled: true
---
# Hello
This is content.`;

const parsed = parseFrontmatter(md);
assert.ok(parsed);
assert.strictEqual((parsed?.frontmatter as Record<string, unknown>).name, "test-doc");
assert.strictEqual((parsed?.frontmatter as Record<string, unknown>).version, 3);
assert.strictEqual((parsed?.frontmatter as Record<string, unknown>).enabled, true);
assert.ok(parsed?.content?.includes("# Hello"));
console.log("  ✅ parseFrontmatter()");

assert.strictEqual(parsePositiveIntFromFrontmatter("5"), 5);
assert.strictEqual(parsePositiveIntFromFrontmatter(5), 5);
assert.strictEqual(parsePositiveIntFromFrontmatter("bad"), undefined);
console.log("  ✅ parsePositiveIntFromFrontmatter()");

assert.strictEqual(parseBooleanFrontmatter("true"), true);
assert.strictEqual(parseBooleanFrontmatter("false"), false);
assert.strictEqual(parseBooleanFrontmatter(undefined), false); // default is false
console.log("  ✅ parseBooleanFrontmatter()");

// =========================================================================
// 12. profilerBase.ts + startupProfiler.ts
// =========================================================================
console.log("\n=== Testing profilerBase.ts + startupProfiler.ts ===");
const { getPerformance, formatMs, formatTimelineLine } = await import("../src/utils/profilerBase.ts");
const { profileCheckpoint, profileReport } = await import("../src/utils/startupProfiler.ts");

assert.ok(typeof getPerformance() === "object");
console.log("  ✅ getPerformance()");

assert.strictEqual(formatMs(123.456), "123.456");
assert.strictEqual(formatMs(0.001), "0.001");
console.log("  ✅ formatMs()");

const line = formatTimelineLine(100, 50, "test_checkpoint", undefined, 8, 7);
assert.ok(line.includes("100"));
assert.ok(line.includes("test_checkpoint"));
console.log("  ✅ formatTimelineLine()");

// profileCheckpoint should not throw
profileCheckpoint("test_checkpoint");
console.log("  ✅ profileCheckpoint() — no throw");

// profileReport should not throw (even when not profiling)
profileReport();
console.log("  ✅ profileReport() — no throw");

// =========================================================================
// SUMMARY
// =========================================================================
console.log("\n" + "=".repeat(60));
console.log("ALL UTILS MODULE TESTS PASSED ✅");
console.log("=".repeat(60));
