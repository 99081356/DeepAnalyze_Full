// =============================================================================
// DeepAnalyze - Request Logger Middleware
// =============================================================================
// Logs every incoming request (method + path) and the corresponding response
// (status code + duration). Attaches a unique X-Request-Id header to every
// request for distributed tracing and debugging.
// =============================================================================

import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

// Paths that produce high-frequency, low-value log noise (WebSocket
// reconnects, health probes, static assets). Requests to these paths are
// still processed normally -- only the log output is suppressed.
const SKIPPED_PATH_PREFIXES = ["/ws/", "/api/health", "/assets/", "/favicon.ico"];

function shouldSkip(path: string): boolean {
  return SKIPPED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const requestId = randomUUID();
  const start = Date.now();
  const skip = shouldSkip(c.req.path);

  c.header("X-Request-Id", requestId);
  c.set("requestId", requestId);

  if (!skip) {
    console.log(`[Request] ${c.req.method} ${c.req.path}`);
  }

  await next();

  if (!skip) {
    const duration = Date.now() - start;
    console.log(
      `[Response] ${c.req.method} ${c.req.path} ${c.res.status} ${duration}ms`,
    );
  }
};
