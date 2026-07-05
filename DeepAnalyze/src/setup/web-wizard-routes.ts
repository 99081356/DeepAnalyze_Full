// =============================================================================
// src/setup/web-wizard-routes.ts
// Web-based setup wizard HTTP routes. Mounted at /api/setup.
// Public (bypasses auth) — see PUBLIC_AUTH_PATHS in auth middleware.
// =============================================================================

import { Hono } from "hono";
import { detectEnvironment } from "./environment.js";
import { runWizard, saveConfig, isSetupComplete, type WizardInput } from "./wizard.js";
import { downloadModel, type ModelSource } from "../services/model-downloader.js";
import { hashPassword } from "../services/auth/local-idp.js";
import { getRepos } from "../store/repos/index.js";

export function createSetupRoutes(): Hono {
  const app = new Hono();

  // GET /api/setup/state — current wizard completion flag
  app.get("/state", (c) => c.json({ complete: isSetupComplete() }));

  // GET /api/setup/environment — Phase 1 hardware/network probe
  app.get("/environment", async (c) => {
    const env = await detectEnvironment();
    return c.json(env);
  });

  // POST /api/setup/complete — accept all wizard inputs, apply config
  app.post("/complete", async (c) => {
    if (isSetupComplete()) {
      return c.json({ error: "setup already complete" }, 409);
    }
    const input = await c.req.json<WizardInput>();

    // Phase 3: create admin account (local mode only)
    if (input.mode === "personal" && input.authChoice === "local"
        && input.adminUsername && input.adminPassword) {
      const repo = (await getRepos()).settings;
      const hash = await hashPassword(input.adminPassword);
      await repo.set("auth", JSON.stringify({
        mode: "local",
        username: input.adminUsername,
        passwordHash: hash,
      }));
    }

    const result = runWizard(input);
    await saveConfig(result);

    return c.json({ ok: true, envVars: result.envVars });
  });

  // POST /api/setup/download — trigger a single model download (polled by frontend)
  app.post("/download", async (c) => {
    const body = await c.req.json<{ modelName: string; source: ModelSource }>();
    // Fire-and-forget; frontend polls local model list to track progress
    downloadModel(body.modelName, body.source, (p) => {
      console.log(`[wizard-download] ${p.fileName}: ${p.percent.toFixed(1)}%`);
    }).catch(err => console.error("[wizard-download] failed:", err));
    return c.json({ ok: true, message: "download started" }, 202);
  });

  return app;
}
