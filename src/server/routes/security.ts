/**
 * Security Gateway admin route — Phase 4.
 *
 * Endpoints:
 *   GET    /security/status                 — Is gateway enabled? Rule counts.
 *   POST   /security/scan                   — Scan arbitrary text (admin testing)
 *   POST   /security/scan-output            — Test output filtering
 *   POST   /security/check-tool             — Test tool-call guard
 *   GET    /security/rules                  — List active rules
 */

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import {
  getSecurityGateway,
  WordEngine,
  RegexEngine,
} from "../../domain/security-gateway.js";

export function createSecurityRoutes(): Hono {
  const app = new Hono();

  // ─── Status ─────────────────────────────────────────────────────────

  app.get("/status", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const gateway = getSecurityGateway();
    return c.json({
      enabled: gateway.isEnabled(),
      fail_open: process.env.SECURITY_GATEWAY_FAIL_OPEN !== "false",
      timeout_ms: parseInt(process.env.SECURITY_GATEWAY_TIMEOUT || "5000", 10),
    });
  });

  // ─── Scan text (input simulation) ───────────────────────────────────

  app.post("/scan", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const body = await c.req.json<{ text: string; direction?: "input" | "output" }>();
    if (!body.text) return c.json({ error: "text required" }, 400);

    const gateway = getSecurityGateway();
    const result = body.direction === "output"
      ? await gateway.filterOutput(body.text, { endpoint: "/security/scan", method: "POST" })
      : await gateway.filterInput(body.text, { endpoint: "/security/scan", method: "POST" });

    return c.json({ result });
  });

  // ─── Check tool call ────────────────────────────────────────────────

  app.post("/check-tool", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const body = await c.req.json<{
      tool_name: string;
      args: unknown;
    }>();
    if (!body.tool_name) return c.json({ error: "tool_name required" }, 400);

    const gateway = getSecurityGateway();
    const result = await gateway.checkTool(body.tool_name, body.args, {
      endpoint: "/security/check-tool",
      method: "POST",
    });
    return c.json({ result });
  });

  // ─── List rules ─────────────────────────────────────────────────────

  app.get("/rules", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const wordEngine = new WordEngine();
    const regexEngine = new RegexEngine();
    // Word engine rules aren't directly enumerable in current impl; expose counts
    return c.json({
      word_engine: {
        sensitive_count: DEFAULT_SENSITIVE_COUNT,
        risky_count: DEFAULT_RISKY_COUNT,
      },
      regex_engine: {
        patterns: DEFAULT_REGEX_RULES,
      },
    });
  });

  return app;
}

// Static rule metadata (mirrors security-gateway.ts defaults)
const DEFAULT_SENSITIVE_COUNT = 7;
const DEFAULT_RISKY_COUNT = 8;
const DEFAULT_REGEX_RULES = [
  { rule_id: "REGEX_PII_ID_CARD_CN", severity: 2, category: "pii" },
  { rule_id: "REGEX_PII_PHONE_CN", severity: 2, category: "pii" },
  { rule_id: "REGEX_PII_BANK_CARD", severity: 2, category: "pii" },
  { rule_id: "REGEX_INTRANET_IP", severity: 2, category: "intranet_leak" },
  { rule_id: "REGEX_PII_EMAIL", severity: 1, category: "pii" },
];
