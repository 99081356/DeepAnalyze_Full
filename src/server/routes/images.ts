// =============================================================================
// DeepAnalyze Hub - Image Tar Streaming Routes
// =============================================================================
// GET /api/v1/images/:name   Stream a .tar image file (curl | docker load)
//
// The :name param accepts either "test-image" or "test-image.tar".
// Files are resolved from HUB_BUNDLE_IMAGES_DIR.
// =============================================================================

import { Hono } from "hono";
import { Readable as NodeReadable } from "node:stream";
import { resolveImageTar } from "../../domain/bundle.js";

export function createImageRoutes(): Hono {
  const app = new Hono();

  // GET /:name — streaming tar download
  app.get("/:name", (c) => {
    const rawName = c.req.param("name");
    // Accept both "test-image" and "test-image.tar"
    const cleaned = rawName.replace(/\.tar$/, "");
    const resolved = resolveImageTar(`${cleaned}.tar`);
    if (!resolved) return c.json({ error: "image not found" }, 404);

    // Convert Node Readable to Web ReadableStream for Hono's c.body()
    const webStream = NodeReadable.toWeb(resolved.stream) as unknown as ReadableStream;
    c.header("Content-Type", "application/x-tar");
    c.header("Content-Length", String(resolved.size));
    c.header("Content-Disposition", `attachment; filename="${cleaned}.tar"`);
    return c.body(webStream);
  });

  return app;
}
