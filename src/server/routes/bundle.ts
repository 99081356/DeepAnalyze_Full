// =============================================================================
// DeepAnalyze Hub - Bundle Distribution Routes
// =============================================================================
// GET /api/v1/bundle/manifest                       Current bundle manifest (public)
// GET /api/v1/bundle/images                         Available image list (public)
// GET /api/v1/bundle/images/:version/download       Streaming tar.gz download (public)
//
// Image tar streaming is in routes/images.ts (separate mount point).
// Download endpoint is public per T05 Correction 3 — workers fetch via direct URL;
// security is guaranteed by manifest lookup (only registered file_paths are served).
// =============================================================================

import { Hono } from "hono";
import {
  getLatestBundleManifest,
  listAvailableImages,
  listBundleManifests,
} from "../../domain/bundle.js";
import { query as dbQuery } from "../../store/pg.js";

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

  // GET /manifests — list all bundle manifests (for ImageTagSelect dropdown)
  app.get("/manifests", async (c) => {
    const manifests = await listBundleManifests();
    return c.json({ manifests });
  });

  // GET /images/:version/download — 流式下载 tar.gz（公开，见 T05 Correction 3）
  // 按 version 或 da_image_tag 查找 manifest；file_path 来自 DB，不接受用户输入（防路径穿越）
  app.get("/images/:version/download", async (c) => {
    const version = c.req.param("version");
    const { rows } = await dbQuery<{
      file_path: string | null;
      file_size: number | null;
      image_name: string;
      da_image_tag: string;
    }>(
      `SELECT file_path, file_size, image_name, da_image_tag
       FROM bundle_manifests
       WHERE version = $1 OR da_image_tag = $1
       ORDER BY uploaded_at DESC LIMIT 1`,
      [version],
    );
    if (rows.length === 0) {
      return c.json({ error: "version not found" }, 404);
    }
    const row = rows[0];
    if (!row.file_path) {
      return c.json({ error: "file_path is null (upload incomplete)" }, 409);
    }

    const file = Bun.file(row.file_path);
    if (!(await file.exists())) {
      return c.json({ error: "file missing on disk" }, 410);
    }

    c.header("Content-Type", "application/gzip");
    c.header(
      "Content-Disposition",
      `attachment; filename="da-${row.image_name}-${row.da_image_tag}.tar.gz"`,
    );
    c.header("Content-Length", String(row.file_size ?? file.size));
    return c.body(file.stream());
  });

  return app;
}
