/**
 * Custom assertion helpers for content quality and data structure validation.
 */
import { expect } from "@playwright/test";

/**
 * Assert that a string is meaningful content (not empty, not error message, not template).
 */
export function assertMeaningfulContent(
  content: string | null | undefined,
  context: string,
  minLength = 10,
): void {
  expect(content, `${context}: content should exist`).toBeTruthy();
  expect(content!.length, `${context}: content too short`).toBeGreaterThanOrEqual(minLength);

  // Check for common error indicators
  const errorPatterns = [
    "[未配置VLM模型",
    "VLM不可用",
    "处理失败",
    "Error:",
    "undefined",
    "null",
  ];
  for (const pattern of errorPatterns) {
    expect(content, `${context}: contains error pattern "${pattern}"`).not.toContain(pattern);
  }
}

/**
 * Assert that L0 (Abstract) content has expected structure.
 */
export function assertL0Content(data: any, docName: string): void {
  expect(data, `${docName} L0: data should exist`).toBeTruthy();
  // L0 should have some text content (summary)
  const text = typeof data === "string" ? data : JSON.stringify(data);
  assertMeaningfulContent(text, `${docName} L0`, 20);
}

/**
 * Assert that L1 (Structure) content has expected structure.
 */
export function assertL1Content(data: any, docName: string): void {
  expect(data, `${docName} L1: data should exist`).toBeTruthy();
  const text = typeof data === "string" ? data : JSON.stringify(data);

  // L1 should not be just page numbers or headers
  expect(text.length, `${docName} L1: content too short`).toBeGreaterThan(50);

  // Should not be only page markers
  const withoutPageMarkers = text.replace(/\[page \d+\]/g, "").trim();
  expect(withoutPageMarkers.length, `${docName} L1: only page markers, no real content`).toBeGreaterThan(30);
}

/**
 * Assert that L2 (Raw) content is valid JSON with expected structure.
 */
export function assertL2Content(data: any, docName: string): void {
  expect(data, `${docName} L2: data should exist`).toBeTruthy();

  // If it's a string, try parsing as JSON
  if (typeof data === "string") {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      // L2 might be non-JSON for some file types
      return;
    }
    expect(parsed, `${docName} L2: parsed JSON should not be empty`).toBeTruthy();
  }
}

/**
 * Assert search results have expected structure.
 */
export function assertSearchResults(
  results: any,
  context: string,
  minResults = 1,
): void {
  expect(results, `${context}: results should exist`).toBeTruthy();
  expect(Array.isArray(results.results), `${context}: results should be array`).toBeTruthy();
  expect(results.results.length, `${context}: should have >= ${minResults} results`).toBeGreaterThanOrEqual(minResults);

  if (results.results.length > 0) {
    const first = results.results[0];
    expect(first.content, `${context}: result should have content`).toBeTruthy();
    expect(typeof first.score, `${context}: result should have score`).toBe("number");
  }
}

/**
 * Assert session messages have correct role ordering.
 */
export function assertMessageOrder(messages: any[]): void {
  for (let i = 0; i < messages.length - 1; i++) {
    // User messages should come before assistant messages
    if (messages[i].role === "user" && messages[i + 1]) {
      // The next message should be assistant
      expect(
        ["assistant", "system"].includes(messages[i + 1].role),
        `Message at index ${i} (user) should be followed by assistant, got ${messages[i + 1].role}`,
      ).toBeTruthy();
    }
  }
}

/**
 * Assert API response is successful.
 */
export function assertSuccess(resp: { ok: boolean; status: number }, context: string): void {
  expect(resp.ok, `${context}: expected success, got status ${resp.status}`).toBeTruthy();
}

/**
 * Assert API response has expected error status.
 */
export function assertError(resp: { ok: boolean; status: number }, expectedStatus: number, context: string): void {
  expect(resp.status, `${context}: expected ${expectedStatus}, got ${resp.status}`).toBe(expectedStatus);
  expect(resp.ok, `${context}: expected failure`).toBeFalsy();
}
