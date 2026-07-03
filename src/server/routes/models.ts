// =============================================================================
// DeepAnalyze Hub - Model Repository Routes
// =============================================================================
// POST   /api/v1/models/upload           Admin upload (multipart)
// GET    /api/v1/models/manifests/:name  Latest manifest (public)
// GET    /api/v1/models/blobs/:sha256    Blob streaming download (public)
// DELETE /api/v1/models/:name/:version   Admin cleanup of old versions
// =============================================================================

import { Hono } from "hono";
import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import {
  uploadModelArtifact,
  getLatestManifest,
  resolveBlobStream,
  deleteModelVersion,
} from "../../domain/model-artifact.js";

export function createModelRoutes(): Hono {
  const app = new Hono();

  // POST /upload — multipart upload (admin only)
  app.post("/upload", jwtAuth, requirePermission("model:upload"), async (c) => {
    const formData = await c.req.formData();
    const name = formData.get("name") as string;
    const version = formData.get("version") as string;
    const category = formData.get("category") as string;
    if (!name || !version || !category) {
      return c.json({ error: "name, version, category required" }, 400);
    }

    const files: Array<{ originalName: string; stream: Readable }> = [];
    formData.forEach((value, key) => {
      if (key === "file" && value instanceof File) {
        // Hono's File.stream() returns a Web ReadableStream — convert to Node Readable
        const nodeStream = NodeReadable.fromWeb(value.stream() as any);
        files.push({ originalName: value.name, stream: nodeStream });
      }
    });
    if (files.length === 0) {
      return c.json({ error: "at least one file required" }, 400);
    }

    const result = await uploadModelArtifact(
      name,
      version,
      category,
      files,
      c.get("userId"),
    );
    return c.json({ id: result.id, files: result.files }, 201);
  });

  // GET /manifests/:name — DA pulls the latest manifest
  app.get("/manifests/:name", async (c) => {
    const name = c.req.param("name");
    const manifest = await getLatestManifest(name);
    if (!manifest) return c.json({ error: "model not found" }, 404);
    return c.json(manifest);
  });

  // GET /blobs/:sha256 — DA streams a blob by content hash
  app.get("/blobs/:sha256", async (c) => {
    const sha = c.req.param("sha256").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      return c.json({ error: "invalid sha256" }, 400);
    }
    const resolved = await resolveBlobStream(sha);
    if (!resolved) return c.json({ error: "blob not found" }, 404);

    // Convert Node Readable to Web ReadableStream for Hono's c.body()
    const webStream = NodeReadable.toWeb(resolved.stream) as unknown as ReadableStream;
    c.header("Content-Type", resolved.contentType);
    c.header("Content-Length", String(resolved.size));
    return c.body(webStream);
  });

  // DELETE /:name/:version — admin cleanup of old versions
  app.delete("/:name/:version", jwtAuth, requirePermission("model:upload"), async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const ok = await deleteModelVersion(name, version);
    if (!ok) return c.json({ error: "version not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
