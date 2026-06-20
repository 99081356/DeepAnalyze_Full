/**
 * Security Gateway middleware — Phase 4.
 *
 * Applies SecurityGateway filterInput to inbound JSON request bodies.
 * Bypassed when gateway disabled or for skipped paths (login, health, assets).
 *
 * Behavior:
 *   - block   → returns 400 with reason + matched rules
 *   - sanitize → records sanitized body in c.var.securitySanitizedBody so
 *                handlers can opt-in to use it (we don't rewrite c.req because
 *                Hono's body caching makes transparent rewriting unreliable)
 *   - approve → passes through
 *
 * Output filtering is exposed via the /api/v1/security admin route rather
 * than transparent middleware, because Hono response rewriting is brittle.
 *
 * Note: Hono caches the body after first c.req.text()/json() call, so
 * downstream handlers can still call c.req.json() and get the original body.
 */

import type { MiddlewareHandler } from "hono";
import { getSecurityGateway, type SecurityContext } from "../../domain/security-gateway.js";

const SKIP_PATH_PREFIXES = [
  "/api/health",
  "/api/v1/auth/login",
  "/api/v1/auth/refresh",
  "/api/v1/auth/mfa/challenge",
  "/api/v1/security/scan",
  "/api/v1/security/check-tool",
  // Skill content goes through PublishGate + RedFlagScanner (offline review,
  // per design §9.5). Runtime Security Gateway shouldn't gate storage.
  "/api/v1/skills/",
  "/assets/",
  "/favicon.ico",
];

function shouldSkip(path: string): boolean {
  return SKIP_PATH_PREFIXES.some((p) => path.startsWith(p));
}

function buildContext(c: Parameters<MiddlewareHandler>[0]): SecurityContext {
  return {
    endpoint: c.req.path,
    method: c.req.method,
    user_id: c.get("userId") || undefined,
    org_id: c.get("userOrgId") ?? undefined,
    worker_id: c.get("workerId") || undefined,
  };
}

export const securityInputFilter: MiddlewareHandler = async (c, next) => {
  const gateway = getSecurityGateway();
  if (!gateway.isEnabled() || shouldSkip(c.req.path)) {
    await next();
    return;
  }

  const method = c.req.method.toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
    await next();
    return;
  }

  const ctype = c.req.header("content-type") ?? "";
  if (!ctype.includes("application/json")) {
    await next();
    return;
  }

  try {
    // Read body — Hono caches it, so handlers downstream can re-read
    const raw = await c.req.text();
    if (!raw) {
      await next();
      return;
    }

    const ctx = buildContext(c);
    const result = await gateway.filterInput(raw, ctx);

    if (result.action === "block") {
      return c.json(
        {
          error: "Request blocked by Security Gateway",
          reason: result.reason,
          severity: result.severity,
          matches: result.matches.map((m) => ({
            rule_id: m.rule_id,
            category: m.category,
            severity: m.severity,
          })),
        },
        400,
      );
    }

    if (result.action === "sanitize" && result.sanitized) {
      c.set("securitySanitizedBody", result.sanitized);
    }
    c.set("securityInputMatches", result.matches);
    c.set("securityInputAction", result.action);

    await next();
  } catch (err) {
    console.error("[securityInputFilter] error:", err);
    // Fail open: let request proceed
    await next();
  }
};
