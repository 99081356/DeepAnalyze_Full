// =============================================================================
// DeepAnalyze Hub - Bundle Distribution Routes
// =============================================================================
// GET /api/v1/bundle/manifest     Current bundle manifest (public)
// GET /api/v1/bundle/images       Available image list (public)
//
// Image tar streaming is in routes/images.ts (separate mount point).
// =============================================================================

import { Hono } from "hono";
import {
  getLatestBundleManifest,
  listAvailableImages,
} from "../../domain/bundle.js";

export function createBundleRoutes(): Hono {
  const app = new Hono();

  // GET /manifest — latest bundle manifest
  app.get("/manifest", async (c) => {
    const m = await getLatestBundleManifest();
    if (!m) return c.json({ error: "no bundle available" }, 404);
    return c.json(m);
  });

  // GET /images — list of available image tars (without .tar extension)
  app.get("/images", (c) => {
    return c.json({ images: listAvailableImages() });
  });

  return app;
}
