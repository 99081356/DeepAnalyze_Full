// =============================================================================
// DeepAnalyze - Global Error Handler Middleware
// =============================================================================
// Catches all unhandled errors thrown in route handlers and returns consistent
// JSON error responses. Logs the full error for debugging while hiding stack
// traces and internal details from clients (especially in production).
// =============================================================================

import type { ErrorHandler } from "hono";
import { logError } from "../../utils/logger.ts";

export const errorHandler: ErrorHandler = (err, c) => {
  const status = (err as any).status ?? 500;
  const message = status === 500 ? "Internal server error" : err.message;

  // Log the full error for debugging
  console.error(
    `[Error] ${c.req.method} ${c.req.path}: ${err.message}`,
    err.stack,
  );
  logError(err);

  return c.json(
    {
      error: message,
      requestId: c.get("requestId") ?? undefined,
      timestamp: new Date().toISOString(),
    },
    status as 500,
  );
};
