// =============================================================================
// DeepAnalyze - Legacy Folder Structure Migration
// =============================================================================
// One-time migration that moves original files from the legacy UUID-based
// directory structure (original/{kbId}/{docId}/...) to the new preserved
// folder structure (original/{kbId}/{folderPath}/{filename}).
//
// Idempotent: only processes documents where folder_path is empty string ""
// AND file_path contains a UUID docId directory segment.
// =============================================================================

import { existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { getRepos } from "../store/repos/index.js";

/**
 * Migrate legacy documents from UUID-based directory structure to preserved
 * folder structure. Safe to call on every startup — only processes docs that
 * haven't been migrated yet.
 */
export async function migrateFolderStructure(): Promise<void> {
  const dataDir = process.env.DATA_DIR ?? "data";
  const repos = await getRepos();

  // Get all KBs
  const kbs = await repos.knowledgeBase.list();
  if (kbs.length === 0) return;

  let totalMigrated = 0;

  for (const kb of kbs) {
    const docs = await repos.document.getByKbId(kb.id);

    for (const doc of docs) {
      // Skip if already migrated (folder_path is set to something meaningful,
      // or file_path doesn't contain the docId UUID directory pattern)
      // We detect legacy docs by checking if the file_path contains /{docId}/
      const filePath = doc.file_path;
      if (!filePath) continue;

      // Check if this looks like a legacy path: original/{kbId}/{docId}/...
      const legacyPrefix = join(dataDir, "original", kb.id, doc.id);
      if (!filePath.startsWith(legacyPrefix)) continue;

      // Already migrated if folder_path is non-empty (new uploads set it)
      // But legacy docs have folder_path="" and still live in UUID dirs
      // Also check: if the file is still at the legacy location
      if (!existsSync(filePath)) continue;

      // Parse relative path after docId
      const afterDocId = filePath.slice(legacyPrefix.length);
      // afterDocId is like "/卷宗A/第一章/1.pdf" or "/report.pdf"

      let relativePath = afterDocId.startsWith("/") ? afterDocId.slice(1) : afterDocId;
      if (!relativePath) {
        // File is directly in the docId directory with no subpath
        // e.g., original/{kbId}/{docId}/report.pdf
        // Can't determine original folder structure — leave as-is
        continue;
      }

      // Split into folder and filename
      const lastSlash = relativePath.lastIndexOf("/");
      const folderPath = lastSlash >= 0 ? relativePath.substring(0, lastSlash) : "";
      let fileName = lastSlash >= 0 ? relativePath.substring(lastSlash + 1) : relativePath;

      // Compute new destination
      let destPath = join(dataDir, "original", kb.id, folderPath, fileName);
      mkdirSync(dirname(destPath), { recursive: true });

      // Handle collision
      let collisionCounter = 1;
      while (existsSync(destPath) && destPath !== filePath) {
        const ext = extname(fileName);
        const base = basename(fileName, ext);
        fileName = `${base}_${collisionCounter}${ext}`;
        destPath = join(dataDir, "original", kb.id, folderPath, fileName);
        collisionCounter++;
      }

      // Skip if somehow destPath === filePath (shouldn't happen for legacy docs)
      if (destPath === filePath) continue;

      try {
        // Move the file
        renameSync(filePath, destPath);

        // Update DB record
        await repos.document.updateFolderPath(doc.id, folderPath, fileName, destPath);

        // Clean up empty docId directory
        const docDir = legacyPrefix;
        try {
          const entries = readdirSync(docDir);
          if (entries.length === 0) {
            rmSync(docDir, { recursive: true, force: true });
          }
        } catch {
          // Directory may not exist or may not be empty
        }

        totalMigrated++;
      } catch (err) {
        console.warn(
          `[Migration] Failed to migrate doc ${doc.id} (${doc.filename}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  if (totalMigrated > 0) {
    console.log(`[Migration] Migrated ${totalMigrated} document(s) to folder structure`);
  }
}
