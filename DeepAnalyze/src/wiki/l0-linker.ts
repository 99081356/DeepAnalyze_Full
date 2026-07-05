// =============================================================================
// DeepAnalyze - L0 Knowledge Linker
// Builds cross-document associations at the abstract (L0) layer by matching
// entities and tags across documents within the same knowledge base.
// Uses PG Repository layer for all database operations.
// =============================================================================

import { Linker } from "./linker.js";
import { getRepos } from "../store/repos/index.js";

export class L0Linker {
  /**
   * Build L0 associations for all documents in a knowledge base.
   * Reads every abstract page, extracts entity/tag lines, and creates
   * bidirectional links between documents whose abstracts share 2+ entities.
   */
  async buildL0Associations(kbId: string): Promise<void> {
    const repos = await getRepos();

    // 1. Get all abstract pages for this KB
    const abstracts = await repos.wikiPage.getByKbAndType(kbId, "abstract");
    if (abstracts.length < 2) {
      console.log(
        `[L0Linker] KB ${kbId}: fewer than 2 abstracts, skipping association build`,
      );
      return;
    }

    // 2. Extract entities/tags from each abstract page
    const pageEntities = new Map<string, Set<string>>();
    for (const page of abstracts) {
      const content = page.content || "";
      if (!content || content.trim().length === 0) continue;

      const entities = this.parseL0Entities(content);
      if (entities.size > 0) {
        pageEntities.set(page.id, entities);
      }
    }

    if (pageEntities.size < 2) {
      console.log(
        `[L0Linker] KB ${kbId}: fewer than 2 pages with entities, skipping`,
      );
      return;
    }

    // 3. Build bidirectional links between pages sharing 2+ entities
    const linker = new Linker();
    let linksCreated = 0;
    const pages = Array.from(pageEntities.entries());

    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 1; j < pages.length; j++) {
        const [pageIdA, entitiesA] = pages[i];
        const [pageIdB, entitiesB] = pages[j];

        // Count shared entities
        const overlap = this.intersection(entitiesA, entitiesB);
        if (overlap.size >= 2) {
          const sharedEntities = Array.from(overlap).join(", ");
          await linker.createBidirectionalLinks(
            pageIdA,
            pageIdB,
            undefined,
            `Shared entities: ${sharedEntities}`,
          );
          linksCreated++;
        }
      }
    }

    console.log(
      `[L0Linker] KB ${kbId}: created ${linksCreated} associations across ${pageEntities.size} abstracts`,
    );
  }

  /**
   * Parse entity/tag lines from L0 abstract content.
   * L0 format (from WikiCompiler):
   *   Line 1: one-line summary
   *   Line 2: 标签：tag1,tag2,...
   *   Line 3: 类型：document type
   *   Line 4: 日期：date
   *
   * Extracts tags from the "标签：" line, plus significant words from the summary.
   */
  private parseL0Entities(content: string): Set<string> {
    const entities = new Set<string>();
    const lines = content.split("\n").map((l) => l.trim());

    for (const line of lines) {
      // Extract tags from "标签：" or "tags:" line
      const tagMatch = line.match(/^标签[：:]\s*(.+)$/i) ||
        line.match(/^tags?[：:]\s*(.+)$/i);
      if (tagMatch) {
        const tags = tagMatch[1]
          .split(/[,，、;；]/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && t.length <= 20);
        for (const tag of tags) {
          entities.add(tag);
        }
      }

      // Also extract from "类型：" line as a single entity
      const typeMatch = line.match(/^类型[：:]\s*(.+)$/i);
      if (typeMatch) {
        const typeVal = typeMatch[1].trim().replace(/[\[\]]/g, "");
        if (typeVal) {
          entities.add(typeVal);
        }
      }
    }

    return entities;
  }

  /**
   * Compute the intersection of two sets.
   */
  private intersection(a: Set<string>, b: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const item of a) {
      if (b.has(item)) {
        result.add(item);
      }
    }
    return result;
  }
}
