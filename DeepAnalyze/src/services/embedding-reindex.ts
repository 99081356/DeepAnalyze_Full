// =============================================================================
// DeepAnalyze - Embedding Reindex Service
// Re-embeds all wiki pages when the embedding model changes.
// Runs asynchronously with progress tracking.
// =============================================================================

import { getEmbeddingManager } from "../models/embedding.js";
import { randomUUID } from "node:crypto";

export interface ReindexProgress {
  total: number;
  completed: number;
  failed: number;
  status: "running" | "completed" | "failed";
  error?: string;
}

type ProgressCallback = (progress: ReindexProgress) => void;

/**
 * Re-embed all wiki pages across all knowledge bases using the current
 * embedding provider. Progress is reported via an optional callback.
 */
export async function reindexAllEmbeddings(
  onProgress?: ProgressCallback,
): Promise<ReindexProgress> {
  const progress: ReindexProgress = {
    total: 0,
    completed: 0,
    failed: 0,
    status: "running",
  };

  try {
    const { getRepos } = await import("../store/repos/index.js");
    const repos = await getRepos();
    const embeddingManager = getEmbeddingManager();

    // Get all wiki pages
    const kbs = await repos.knowledgeBase.list();
    const allPages: Array<{ id: string; content: string }> = [];

    for (const kb of kbs) {
      const pages = await repos.wikiPage.getByKbAndType(kb.id);
      for (const page of pages) {
        if (page.content && page.content.trim().length > 0) {
          allPages.push({ id: page.id, content: page.content });
        }
      }
    }

    progress.total = allPages.length;
    onProgress?.(progress);

    // Process in batches of 32
    const batchSize = 32;
    for (let i = 0; i < allPages.length; i += batchSize) {
      const batch = allPages.slice(i, i + batchSize);
      const texts = batch.map((p) => {
        // Truncate to avoid exceeding token limits (rough char-based limit)
        const maxLen = 8000;
        return p.content.length > maxLen
          ? p.content.substring(0, maxLen)
          : p.content;
      });

      try {
        const results = await embeddingManager.embedBatch(texts);

        // Upsert each embedding
        for (let j = 0; j < results.length; j++) {
          const page = batch[j];
          const result = results[j];
          try {
            const embeddingArr = Array.from(result.embedding);
            await repos.embedding.upsert({
              id: randomUUID(),
              page_id: page.id,
              model_name: embeddingManager.providerName,
              dimension: result.embedding.length,
              vector: embeddingArr as unknown as Float32Array,
              text_chunk: texts[j],
              chunk_index: 0,
            });
          } catch {
            progress.failed++;
          }
        }

        progress.completed += batch.length;
      } catch {
        progress.failed += batch.length;
      }

      onProgress?.(progress);
    }

    progress.status = progress.failed > 0 && progress.completed === 0
      ? "failed"
      : "completed";

    onProgress?.(progress);
    return progress;
  } catch (err) {
    progress.status = "failed";
    progress.error = err instanceof Error ? err.message : String(err);
    onProgress?.(progress);
    return progress;
  }
}
