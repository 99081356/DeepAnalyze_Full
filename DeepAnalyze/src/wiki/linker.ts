// =============================================================================
// DeepAnalyze - Wiki Linker
// Manages forward/backward links between wiki pages, including entity
// references and concept references. Supports BFS-based link traversal.
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { getRepos } from "../store/repos/index.js";
import type { WikiLink, WikiPage, LinkType } from "../types/index.js";
import type { WikiLink as PgWikiLink, WikiPage as PgWikiPage } from "../store/repos/interfaces.js";

// ---------------------------------------------------------------------------
// Linked page result (includes distance from start)
// ---------------------------------------------------------------------------

export interface LinkedPageResult {
  page: WikiPage;
  distance: number;
  linkType: LinkType;
}

// ---------------------------------------------------------------------------
// PG repo result → domain type mappers
// ---------------------------------------------------------------------------

function pgLinkToWikiLink(link: PgWikiLink): WikiLink {
  return {
    id: link.id,
    sourcePageId: link.sourcePageId,
    targetPageId: link.targetPageId,
    linkType: link.linkType as LinkType,
    entityName: link.entityName,
    context: link.context,
    createdAt: link.createdAt,
  };
}

function pgPageToWikiPage(page: PgWikiPage): WikiPage {
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

// ---------------------------------------------------------------------------
// Linker
// ---------------------------------------------------------------------------

export class Linker {
  // -----------------------------------------------------------------------
  // Link creation
  // -----------------------------------------------------------------------

  /**
   * Create a link between two pages.
   */
  async createLink(
    sourcePageId: string,
    targetPageId: string,
    linkType: LinkType,
    entityName?: string,
    context?: string,
  ): Promise<WikiLink> {
    const repos = await getRepos();

    // Check for duplicate link
    const existing = await repos.wikiLink.findExisting(
      sourcePageId,
      targetPageId,
      linkType,
      entityName,
    );

    if (existing) {
      return pgLinkToWikiLink(existing);
    }

    const link = await repos.wikiLink.create(
      sourcePageId,
      targetPageId,
      linkType,
      entityName,
      context,
    );

    return pgLinkToWikiLink(link);
  }

  /**
   * Create bidirectional forward/backward links between two pages.
   * Returns a tuple of [forwardLink, backwardLink].
   */
  async createBidirectionalLinks(
    pageA: string,
    pageB: string,
    entityName?: string,
    context?: string,
  ): Promise<[WikiLink, WikiLink]> {
    const forward = await this.createLink(pageA, pageB, "forward", entityName, context);
    const backward = await this.createLink(pageB, pageA, "backward", entityName, context);
    return [forward, backward];
  }

  // -----------------------------------------------------------------------
  // Link retrieval
  // -----------------------------------------------------------------------

  /**
   * Get all outgoing links from a page.
   */
  async getOutgoingLinks(pageId: string): Promise<WikiLink[]> {
    const repos = await getRepos();
    const links = await repos.wikiLink.getOutgoing(pageId);
    return links.map(pgLinkToWikiLink);
  }

  /**
   * Get all incoming links to a page.
   */
  async getIncomingLinks(pageId: string): Promise<WikiLink[]> {
    const repos = await getRepos();
    const links = await repos.wikiLink.getIncoming(pageId);
    return links.map(pgLinkToWikiLink);
  }

  /**
   * Get all linked pages within N hops using BFS traversal.
   * Returns pages with their distance from the start page and the link type.
   */
  async getLinkedPages(
    startPageId: string,
    depth: number,
  ): Promise<LinkedPageResult[]> {
    if (depth <= 0) return [];

    const repos = await getRepos();
    const visited = new Set<string>([startPageId]);
    const results: LinkedPageResult[] = [];
    const queue: Array<{ pageId: string; distance: number }> = [
      { pageId: startPageId, distance: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.distance >= depth) continue;

      // Get all links from the current page
      const links = await repos.wikiLink.getOutgoing(current.pageId);

      for (const link of links) {
        const targetId = link.targetPageId;
        const linkType = link.linkType as LinkType;

        if (visited.has(targetId)) continue;
        visited.add(targetId);

        // Look up the target page
        const pageRow = await repos.wikiPage.getById(targetId);

        if (pageRow) {
          const page = pgPageToWikiPage(pageRow);
          results.push({
            page,
            distance: current.distance + 1,
            linkType,
          });

          // Enqueue for further traversal
          queue.push({
            pageId: targetId,
            distance: current.distance + 1,
          });
        }
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Link removal
  // -----------------------------------------------------------------------

  /**
   * Remove all links for a page (both incoming and outgoing).
   */
  async removePageLinks(pageId: string): Promise<void> {
    const repos = await getRepos();
    await repos.wikiLink.deleteByPageId(pageId);
  }

  // -----------------------------------------------------------------------
  // Entity-based discovery
  // -----------------------------------------------------------------------

  /**
   * Find all pages that reference a specific entity within a knowledge base.
   */
  async findRelatedByEntity(kbId: string, entityName: string): Promise<WikiPage[]> {
    const repos = await getRepos();
    const summaries = await repos.wikiLink.findRelatedByEntity(kbId, entityName);

    // For each summary, fetch the full page to get complete WikiPage data
    const pages: WikiPage[] = [];
    for (const summary of summaries) {
      const fullPage = await repos.wikiPage.getById(summary.id);
      if (fullPage) {
        pages.push(pgPageToWikiPage(fullPage));
      }
    }
    return pages;
  }

  // -----------------------------------------------------------------------
  // Forward link building
  // -----------------------------------------------------------------------

  /**
   * Build forward links between documents in a knowledge base based on
   * entity co-occurrence. Documents that share entities get linked.
   */
  async buildForwardLinks(kbId: string): Promise<void> {
    const repos = await getRepos();

    // Get all pages in the KB that have entity references
    const entityLinks = await repos.wikiLink.findEntityLinksByKb(kbId);

    // Group pages by shared entities
    const entityToPages = new Map<string, string[]>();
    for (const row of entityLinks) {
      const pages = entityToPages.get(row.entityName) ?? [];
      pages.push(row.sourcePageId);
      entityToPages.set(row.entityName, pages);
    }

    // For each entity shared by multiple pages, create forward links
    for (const [_entity, pages] of entityToPages) {
      if (pages.length < 2) continue;

      for (let i = 0; i < pages.length; i++) {
        for (let j = i + 1; j < pages.length; j++) {
          await this.createBidirectionalLinks(pages[i], pages[j]);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // L1 Overview link updating
  // -----------------------------------------------------------------------

  /**
   * Update the L1 overview page for a document by appending a
   * "## Related Pages" section that lists outgoing and incoming links.
   * This keeps the overview page in sync with the link graph.
   */
  async updateOverviewLinks(docId: string): Promise<void> {
    const repos = await getRepos();

    // Find the overview page for this document
    const overviewPage = await repos.wikiPage.getByDocAndType(docId, "overview");

    if (!overviewPage) return;

    const pageId = overviewPage.id;

    // Get outgoing and incoming links
    const outgoing = await this.getOutgoingLinks(pageId);
    const incoming = await this.getIncomingLinks(pageId);

    if (outgoing.length === 0 && incoming.length === 0) return;

    // Read current overview content from DB (content column) or filesystem
    let content: string;
    try {
      content = overviewPage.content || readFileSync(overviewPage.file_path, "utf-8");
    } catch {
      return;
    }

    // Remove any existing "## Related Pages" section
    const marker = "## Related Pages";
    const markerIdx = content.indexOf(marker);
    if (markerIdx !== -1) {
      content = content.slice(0, markerIdx).trimEnd();
    }

    // Build the related pages section
    const lines: string[] = ["", "", marker, ""];

    if (outgoing.length > 0) {
      lines.push("### Outgoing References");
      for (const link of outgoing) {
        const targetPage = await repos.wikiPage.getById(link.targetPageId);
        if (targetPage) {
          const entityLabel = link.entityName ? ` (${link.entityName})` : "";
          lines.push(
            `- → [[${targetPage.title}]] (${targetPage.page_type})${entityLabel}`,
          );
        }
      }
      lines.push("");
    }

    if (incoming.length > 0) {
      lines.push("### Incoming References");
      for (const link of incoming) {
        const sourcePage = await repos.wikiPage.getById(link.sourcePageId);
        if (sourcePage) {
          const entityLabel = link.entityName ? ` (${link.entityName})` : "";
          lines.push(
            `- ← [[${sourcePage.title}]] (${sourcePage.page_type})${entityLabel}`,
          );
        }
      }
      lines.push("");
    }

    // Append the related pages section to the overview
    const updatedContent = content + lines.join("\n") + "\n";

    // Update the page content (filesystem + DB)
    try {
      writeFileSync(overviewPage.file_path, updatedContent, "utf-8");
    } catch {
      // Filesystem write may fail; continue with DB update
    }

    const { createHash } = await import("node:crypto");
    const contentHash = createHash("md5").update(updatedContent).digest("hex");
    const tokenCount = Math.ceil(updatedContent.length / 4);
    await repos.wikiPage.updateContent(pageId, updatedContent, contentHash, tokenCount);
  }
}
