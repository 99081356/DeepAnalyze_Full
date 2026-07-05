import { mkdir, writeFile, readFile, rm, readdir } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { getSessionMediaDir, getSessionMediaItemDir } from "./session-paths.js";
import { writeFileAtomic } from "../../utils/atomicWrite.js";

export interface MediaMeta {
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface MediaRef {
  mediaId: string;
  mimeType: string;
  fileName: string;
  size: number;
}

export class MediaStore {
  /**
   * Save uploaded media file, generate thumbnail for images, return metadata.
   */
  static async save(
    dataDir: string,
    sessionId: string,
    file: { name: string; type: string; data: Buffer },
  ): Promise<MediaMeta> {
    const mediaId = randomUUID();
    const itemDir = getSessionMediaItemDir(dataDir, sessionId, mediaId);
    await mkdir(itemDir, { recursive: true });

    const ext = file.name.includes(".") ? file.name.split(".").pop()! : "bin";
    const originalPath = join(itemDir, `original.${ext}`);
    await writeFile(originalPath, file.data);

    const meta: MediaMeta = {
      mediaId,
      fileName: file.name,
      mimeType: file.type,
      size: file.data.length,
      createdAt: new Date().toISOString(),
    };

    // Generate thumbnail for images
    if (file.type.startsWith("image/")) {
      try {
        const thumbnailPath = join(itemDir, "thumbnail.webp");
        const image = sharp(file.data);
        const metadata = await image.metadata();
        meta.width = metadata.width;
        meta.height = metadata.height;

        await sharp(file.data)
          .resize(400, undefined, { withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(thumbnailPath);
      } catch {
        // Thumbnail generation failed — non-fatal
      }
    }

    await writeFileAtomic(join(itemDir, "meta.json"), JSON.stringify(meta, null, 2), { encoding: "utf-8" });
    return meta;
  }

  /**
   * Read media metadata.
   */
  static async getMeta(dataDir: string, sessionId: string, mediaId: string): Promise<MediaMeta | null> {
    const metaPath = join(getSessionMediaItemDir(dataDir, sessionId, mediaId), "meta.json");
    if (!existsSync(metaPath)) return null;
    const content = await readFile(metaPath, "utf-8");
    return JSON.parse(content);
  }

  /**
   * Read original file.
   */
  static async readOriginal(
    dataDir: string,
    sessionId: string,
    mediaId: string,
  ): Promise<{ data: Buffer; mimeType: string; fileName: string } | null> {
    const itemDir = getSessionMediaItemDir(dataDir, sessionId, mediaId);
    const meta = await this.getMeta(dataDir, sessionId, mediaId);
    if (!meta) return null;

    const files = await readdir(itemDir);
    const originalFile = files.find((f) => f.startsWith("original."));
    if (!originalFile) return null;

    const data = await readFile(join(itemDir, originalFile));
    return { data, mimeType: meta.mimeType, fileName: meta.fileName };
  }

  /**
   * Read thumbnail.
   */
  static async readThumbnail(
    dataDir: string,
    sessionId: string,
    mediaId: string,
  ): Promise<Buffer | null> {
    const thumbnailPath = join(getSessionMediaItemDir(dataDir, sessionId, mediaId), "thumbnail.webp");
    if (!existsSync(thumbnailPath)) return null;
    return readFile(thumbnailPath);
  }

  /**
   * Check if media exists.
   */
  static exists(dataDir: string, sessionId: string, mediaId: string): boolean {
    return existsSync(getSessionMediaItemDir(dataDir, sessionId, mediaId));
  }

  /**
   * Get the absolute filesystem path of the original file (synchronous).
   * Returns null if media item or original file doesn't exist.
   */
  static getOriginalPath(dataDir: string, sessionId: string, mediaId: string): string | null {
    const itemDir = getSessionMediaItemDir(dataDir, sessionId, mediaId);
    if (!existsSync(itemDir)) return null;
    const files = readdirSync(itemDir);
    const originalFile = files.find(f => f.startsWith("original."));
    return originalFile ? join(itemDir, originalFile) : null;
  }

  /**
   * Convert media to base64 data URI (for sending to model).
   */
  static async toDataUri(
    dataDir: string,
    sessionId: string,
    mediaId: string,
  ): Promise<string | null> {
    const result = await this.readOriginal(dataDir, sessionId, mediaId);
    if (!result) return null;
    const base64 = result.data.toString("base64");
    return `data:${result.mimeType};base64,${base64}`;
  }

  /**
   * Clean up all media files for a session.
   */
  static async cleanupSession(dataDir: string, sessionId: string): Promise<void> {
    const dir = getSessionMediaDir(dataDir, sessionId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
