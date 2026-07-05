/**
 * Wait/polling helpers for async operations.
 */
import { APIRequestContext } from "@playwright/test";
import { createApi, Document } from "./api";

const DEFAULT_POLL_INTERVAL = 2000;
const DEFAULT_TIMEOUT = 180_000; // 3 minutes

/**
 * Poll until a document reaches "ready" or "failed" status.
 */
export async function waitForDocumentReady(
  request: APIRequestContext,
  kbId: string,
  docId: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<Document> {
  const api = createApi(request);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const doc = await api.getDocument(kbId, docId);
      if (doc.status === "ready" || doc.status === "failed") return doc;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL));
  }
  throw new Error(`Document ${docId} not ready after ${timeout / 1000}s`);
}

/**
 * Poll until an agent task reaches a terminal state.
 */
export async function waitForAgentTask(
  request: APIRequestContext,
  sessionId: string,
  timeout = 300_000,
): Promise<any> {
  const api = createApi(request);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const tasks = await api.getTaskStatus(sessionId);
      if (Array.isArray(tasks) && tasks.length > 0) {
        const latest = tasks[tasks.length - 1];
        if (latest.status === "completed" || latest.status === "failed" || latest.status === "cancelled") {
          return latest;
        }
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL));
  }
  throw new Error(`Agent task for session ${sessionId} not complete after ${timeout / 1000}s`);
}

/**
 * Poll until a session has at least `minCount` messages.
 */
export async function waitForMessages(
  request: APIRequestContext,
  sessionId: string,
  minCount: number,
  timeout = DEFAULT_TIMEOUT,
): Promise<any[]> {
  const api = createApi(request);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const msgs = await api.getMessages(sessionId);
      if (msgs.length >= minCount) return msgs;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, DEFAULT_POLL_INTERVAL));
  }
  throw new Error(`Session ${sessionId} did not reach ${minCount} messages after ${timeout / 1000}s`);
}

/**
 * Generic poll with custom condition.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  timeout = DEFAULT_TIMEOUT,
  interval = DEFAULT_POLL_INTERVAL,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (condition(result)) return result;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Poll condition not met after ${timeout / 1000}s`);
}
