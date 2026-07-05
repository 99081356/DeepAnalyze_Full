// =============================================================================
// DeepAnalyze - Wiki Indexer
// Manages the indexing of wiki pages into both the full-text search table
// and the embeddings table for vector similarity search.
// Uses PG Repository layer for all database operations.
// =============================================================================

import { randomUUID } from "node:crypto";
import { getRepos } from "../store/repos/index.js";
import type { WikiPage } from "../types/index.js";
import type { EmbeddingManager } from "../models/embedding.js";

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

export class Indexer {
  private embeddingManager: EmbeddingManager;

  constructor(embeddingManager: EmbeddingManager) {
    this.embeddingManager = embeddingManager;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Index all pages for a specific document. L0 (abstract) and L1 (overview)
   * pages are indexed into the embeddings table; L2 (fulltext) pages are
   * indexed into both FTS and embeddings.
   */
  async indexDocument(kbId: string, docId: string): Promise<void> {
    const repos = await getRepos();

    // Get all pages for this document
    // Fetch all page types and combine
    const pageTypes = ["abstract", "overview", "fulltext", "structure", "structure_md", "structure_dt", "entity", "concept", "report"];
    const allPages: WikiPage[] = [];

    for (const pageType of pageTypes) {
      const pages = await repos.wikiPage.getManyByDocAndType(docId, pageType);
      for (const page of pages) {
        allPages.push(this.pgPageToWikiPage(page));
      }
    }

    for (const page of allPages) {
      const content = page.filePath
        ? await this.getPageContent(page)
        : "";
      await this.indexPage(page, content);
    }
  }

  /**
   * Index a single page into both FTS and embeddings.
   * Accepts either a types/index.js WikiPage or a repos WikiPage (both have id and title).
   */
  async indexPage(page: { id: string; title: string }, content: string): Promise<void> {
    const repos = await getRepos();

    // Insert into FTS using PG upsert
    try {
      await repos.ftsSearch.upsertFTSEntry(page.id, page.title, content);
    } catch (err) {
      // FTS operations may fail if the table is misconfigured.
      // Log but do not crash -- embedding indexing can still proceed.
      console.warn(
        `[Indexer] FTS indexing failed for page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Compute and store embedding
    try {
      await this.getOrComputeEmbedding(page.id, content, 0);
    } catch (err) {
      console.warn(
        `[Indexer] Embedding computation failed for page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Re-index an entire knowledge base: all pages in all documents.
   */
  async indexKb(kbId: string): Promise<void> {
    const repos = await getRepos();
    const pages = await repos.wikiPage.getByKbAndType(kbId);

    for (const page of pages) {
      try {
        const content = page.content || "";
        await this.indexPage(this.pgPageToWikiPage(page), content);
      } catch (err) {
        console.warn(
          `[Indexer] Failed to index page ${page.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Remove all embeddings for a page.
   */
  async removePageIndex(pageId: string): Promise<void> {
    const repos = await getRepos();

    // Remove embeddings
    await repos.embedding.deleteByPageId(pageId);

    // Remove from FTS
    try {
      await repos.ftsSearch.deleteByPageId(pageId);
    } catch {
      // Ignore FTS errors during removal
    }
  }

  /**
   * Get an existing embedding for a page/chunk or compute and store a new one.
   */
  async getOrComputeEmbedding(
    pageId: string,
    text: string,
    chunkIndex: number = 0,
  ): Promise<Float32Array> {
    const repos = await getRepos();
    const modelName = this.embeddingManager.providerName;

    // Check for an existing embedding (skip if stale)
    const existing = await repos.embedding.getOrNone(pageId, modelName, chunkIndex);

    if (existing && !(existing as any).stale) {
      return existing.vector;
    }

    // Compute new embedding
    const result = await this.embeddingManager.embed(text);
    const vector = result.embedding;

    const id = randomUUID();
    await repos.embedding.upsert({
      id,
      page_id: pageId,
      model_name: modelName,
      dimension: this.embeddingManager.dimension,
      vector,
      text_chunk: text,
      chunk_index: chunkIndex,
    });

    return vector;
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(
        `Vector dimension mismatch: ${a.length} vs ${b.length}`,
      );
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;

    return dot / denom;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private pgPageToWikiPage(page: any): WikiPage {
    return {
      id: page.id,
      kbId: page.kb_id,
      docId: page.doc_id,
      pageType: page.page_type as WikiPage["pageType"],
      title: page.title,
      filePath: page.file_path,
      contentHash: page.content_hash,
      tokenCount: page.token_count,
      metadata: page.metadata ? JSON.stringify(page.metadata) : null,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
    };
  }

  /**
   * Get page content from the DB content column, falling back to filesystem read.
   */
  private async getPageContent(page: WikiPage): Promise<string> {
    const repos = await getRepos();
    const pgPage = await repos.wikiPage.getById(page.id);
    if (pgPage && pgPage.content) {
      return pgPage.content;
    }
    // Fallback: read from filesystem
    if (page.filePath) {
      try {
        const { readFileSync } = await import("node:fs");
        return readFileSync(page.filePath, "utf-8");
      } catch {
        return "";
      }
    }
    return "";
  }
}
