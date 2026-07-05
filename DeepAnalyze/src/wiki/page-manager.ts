// =============================================================================
// DeepAnalyze - Page Manager
// High-level wiki page management that coordinates DB records and filesystem.
// Uses PG Repository layer for all database operations.
// =============================================================================

import { getRepos } from "../store/repos/index.js";
import type { WikiPage } from "../types/index.js";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileSyncAtomic } from "../utils/atomicWrite.js";

export class PageManager {
  private readonly wikiDir: string;

  constructor(dataDir: string) {
    this.wikiDir = join(dataDir, "wiki");
  }

  /**
   * Expose the base wiki directory for use by the compiler.
   */
  getWikiDir(): string {
    return this.wikiDir;
  }

  /**
   * Initialize the wiki directory structure for a knowledge base.
   * Creates all required subdirectories and seed files.
   */
  async initKb(kbId: string): Promise<void> {
    const kbDir = join(this.wikiDir, kbId);

    // Create directory structure
    const dirs = [
      join(kbDir, "documents"),
      join(kbDir, "entities"),
      join(kbDir, "concepts"),
      join(kbDir, "reports"),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // Create index.md if it doesn't exist
    const indexPath = join(kbDir, "index.md");
    if (!existsSync(indexPath)) {
      writeFileSyncAtomic(
        indexPath,
        `# Knowledge Base: ${kbId}\n\nThis is the wiki index for knowledge base **${kbId}**.\n`,
        { encoding: "utf-8" },
      );
    }

    // Create log.md if it doesn't exist
    const logPath = join(kbDir, "log.md");
    if (!existsSync(logPath)) {
      writeFileSyncAtomic(
        logPath,
        `# Compilation Log: ${kbId}\n\nCompilation events are recorded here.\n`,
        { encoding: "utf-8" },
      );
    }
  }

  /**
   * Read the content of a wiki page.
   * Tries DB content column first, falls back to filesystem read.
   */
  async getPageContent(pageId: string): Promise<string> {
    const repos = await getRepos();
    const page = await repos.wikiPage.getById(pageId);
    if (!page) {
      throw new Error(`Wiki page not found: ${pageId}`);
    }

    // Use content from DB if available
    if (page.content) {
      return page.content;
    }

    // Fallback to filesystem
    if (page.file_path) {
      try {
        const { readFileSync } = await import("node:fs");
        return readFileSync(page.file_path, "utf-8");
      } catch {
        throw new Error(`Failed to read content for wiki page: ${pageId}`);
      }
    }

    return "";
  }

  /**
   * Update the content of a wiki page on both filesystem and DB.
   */
  async updatePage(pageId: string, content: string): Promise<void> {
    const repos = await getRepos();
    const page = await repos.wikiPage.getById(pageId);
    if (!page) {
      throw new Error(`Wiki page not found: ${pageId}`);
    }

    // Write to filesystem
    if (page.file_path) {
      try {
        writeFileSyncAtomic(page.file_path, content, { encoding: "utf-8" });
      } catch {
        // Filesystem write may fail; continue with DB update
      }
    }

    // Update DB
    const { createHash } = await import("node:crypto");
    const contentHash = createHash("md5").update(content).digest("hex");
    const tokenCount = Math.ceil(content.length / 4);
    await repos.wikiPage.updateContent(pageId, content, contentHash, tokenCount);
  }

  /**
   * List all pages for a knowledge base, optionally filtered by page type.
   */
  async listPages(kbId: string, pageType?: string): Promise<WikiPage[]> {
    const repos = await getRepos();
    const pages = await repos.wikiPage.getByKbAndType(kbId, pageType);

    return pages.map((p) => ({
      id: p.id,
      kbId: p.kb_id,
      docId: p.doc_id,
      pageType: p.page_type as WikiPage["pageType"],
      title: p.title,
      filePath: p.file_path,
      contentHash: p.content_hash,
      tokenCount: p.token_count,
      metadata: p.metadata ? JSON.stringify(p.metadata) : null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));
  }
}
