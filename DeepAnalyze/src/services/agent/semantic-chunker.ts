// =============================================================================
// DeepAnalyze - Semantic Chunker
// =============================================================================
// Clusters documents by semantic similarity for intelligent batch analysis.
// Uses the existing EmbeddingManager infrastructure (no new dependencies).
// =============================================================================

import type { EmbeddingManager } from "../../models/embedding.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChunkableDocument {
  docId: string;
  title: string;
  /** Brief summary or first N chars of content for embedding */
  summary: string;
}

export interface ChunkGroup {
  /** Group identifier (0-indexed) */
  id: number;
  /** Document IDs in this group */
  docIds: string[];
  /** Top keywords from group titles (for agent guidance) */
  themeHint: string;
  /** Number of documents in this group */
  documentCount: number;
}

// ---------------------------------------------------------------------------
// SemanticChunker
// ---------------------------------------------------------------------------

/**
 * Clusters documents by semantic similarity using embeddings.
 * Designed for S6.7 (超多输入处理) — when there are many documents,
 * group them by topic so each sub-agent can focus on a coherent theme.
 */
export class SemanticChunker {
  constructor(private embeddingManager: EmbeddingManager) {}

  /**
   * Cluster documents into `targetGroups` semantically coherent groups.
   *
   * Algorithm:
   * 1. Embed each document's title + summary
   * 2. Pick the most dissimilar documents as seeds
   * 3. Assign remaining documents to the nearest seed
   *
   * @param documents Documents to cluster
   * @param targetGroups Desired number of groups (actual may be less if fewer documents)
   * @returns Array of ChunkGroup
   */
  async clusterDocuments(
    documents: ChunkableDocument[],
    targetGroups: number,
  ): Promise<ChunkGroup[]> {
    if (documents.length === 0) return [];
    if (documents.length <= targetGroups) {
      // Each document is its own group
      return documents.map((doc, i) => ({
        id: i,
        docIds: [doc.docId],
        themeHint: doc.title,
        documentCount: 1,
      }));
    }

    // Step 1: Compute embeddings
    const texts = documents.map(d => `${d.title} ${d.summary}`.slice(0, 500));
    const embeddings: Float32Array[] = [];
    for (const text of texts) {
      try {
        const result = await this.embeddingManager.embed(text);
        embeddings.push(result.embedding);
      } catch {
        // Fallback: use zero vector (will be assigned randomly)
        embeddings.push(new Float32Array(256));
      }
    }

    // Step 2: Pick seeds — select maximally dissimilar documents
    const seeds = this.selectSeeds(embeddings, Math.min(targetGroups, documents.length));

    // Step 3: Assign each document to the nearest seed
    const assignments = new Array<number>(documents.length);
    for (let i = 0; i < documents.length; i++) {
      let bestSeed = 0;
      let bestSim = -Infinity;
      for (const seedIdx of seeds) {
        const sim = this.cosineSimilarity(embeddings[i]!, embeddings[seedIdx]!);
        if (sim > bestSim) {
          bestSim = sim;
          bestSeed = seedIdx;
        }
      }
      assignments[i] = seeds.indexOf(bestSeed);
    }

    // Step 4: Build groups
    const groups: ChunkGroup[] = [];
    for (let g = 0; g < seeds.length; g++) {
      const memberIndices = assignments.reduce((acc, a, i) => {
        if (a === g) acc.push(i);
        return acc;
      }, [] as number[]);

      const docIds = memberIndices.map(i => documents[i]!.docId);
      const titles = memberIndices.map(i => documents[i]!.title);

      groups.push({
        id: g,
        docIds,
        themeHint: titles.slice(0, 3).join(" / "),
        documentCount: docIds.length,
      });
    }

    return groups;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Select seed indices using a greedy farthest-first approach.
   */
  private selectSeeds(embeddings: Float32Array[], count: number): number[] {
    const seeds: number[] = [0]; // Start with first document

    while (seeds.length < count) {
      let farthest = -1;
      let maxMinDist = -Infinity;

      for (let i = 0; i < embeddings.length; i++) {
        if (seeds.includes(i)) continue;
        // Compute min similarity to any existing seed
        let minSim = Infinity;
        for (const s of seeds) {
          const sim = this.cosineSimilarity(embeddings[i]!, embeddings[s]!);
          if (sim < minSim) minSim = sim;
        }
        // Pick the point with the lowest similarity to nearest seed (most dissimilar)
        if (minSim > maxMinDist) {
          maxMinDist = minSim;
          farthest = i;
        }
      }

      if (farthest >= 0) seeds.push(farthest);
      else break;
    }

    return seeds;
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
