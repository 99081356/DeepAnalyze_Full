// =============================================================================
// DeepAnalyze - Wiki Browse Tool
// Browse wiki pages and follow links between related documents.
// Provides page content viewing and link traversal capabilities.
// Uses PG Repository layer for all database operations.
// =============================================================================

import { getRepos } from "../../store/repos/index.js";
import type { Linker } from "../../wiki/linker.js";
import type { PageManager } from "../../wiki/page-manager.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface WikiBrowseInput {
  /** View a specific page by ID. */
  pageId?: string;
  /** List pages in a knowledge base. */
  kbId?: string;
  /** Filter listed pages by type. */
  pageType?: string;
  /** Follow links from a page. */
  followLinks?: boolean;
  /** Depth of link traversal (default 1, max 3). */
  depth?: number;
}

export interface PageView {
  id: string;
  title: string;
  pageType: string;
  content: string;
  tokenCount: number;
  outgoingLinks: Array<{ targetId: string; targetTitle: string; linkType: string }>;
  incomingLinks: Array<{ sourceId: string; sourceTitle: string; linkType: string }>;
}

export interface WikiBrowseOutput {
  /** The viewed page (when pageId is provided). */
  page?: PageView;
  /** Listed pages (when kbId is provided). */
  pages?: Array<{
    id: string;
    title: string;
    pageType: string;
    tokenCount: number;
  }>;
  /** Linked pages discovered through traversal. */
  linkedPages?: Array<{
    id: string;
    title: string;
    pageType: string;
    distance: number;
    linkType: string;
  }>;
}

// ---------------------------------------------------------------------------
// WikiBrowseTool
// ---------------------------------------------------------------------------

export class WikiBrowseTool {
  readonly name = "wiki_browse";
  readonly description =
    "通过 ID 浏览 Wiki 页面或列出知识库中的页面。" +
    "跟踪相关文档之间的链接以发现关联内容。" +
    "支持查看页面内容和遍历链接图谱。";

  private linker: Linker;
  private pageManager: PageManager;

  constructor(linker: Linker, pageManager: PageManager) {
    this.linker = linker;
    this.pageManager = pageManager;
  }

  /**
   * Execute the browse operation.
   */
  async execute(input: WikiBrowseInput): Promise<WikiBrowseOutput> {
    const repos = await getRepos();
    const output: WikiBrowseOutput = {};

    // View a specific page
    if (input.pageId) {
      const page = await repos.wikiPage.getById(input.pageId);
      if (!page) {
        throw new Error(`Wiki page not found: ${input.pageId}`);
      }

      const content = page.content || "";

      // Get outgoing and incoming links
      const outgoing = await this.linker.getOutgoingLinks(page.id);
      const incoming = await this.linker.getIncomingLinks(page.id);

      const outgoingLinks = [];
      for (const l of outgoing) {
        const target = await repos.wikiPage.getById(l.targetPageId);
        outgoingLinks.push({
          targetId: l.targetPageId,
          targetTitle: target?.title ?? l.targetPageId,
          linkType: l.linkType,
        });
      }

      const incomingLinks = [];
      for (const l of incoming) {
        const source = await repos.wikiPage.getById(l.sourcePageId);
        incomingLinks.push({
          sourceId: l.sourcePageId,
          sourceTitle: source?.title ?? l.sourcePageId,
          linkType: l.linkType,
        });
      }

      output.page = {
        id: page.id,
        title: page.title,
        pageType: page.page_type,
        content,
        tokenCount: page.token_count,
        outgoingLinks,
        incomingLinks,
      };
    }

    // List pages in a knowledge base
    if (input.kbId) {
      const pages = await this.pageManager.listPages(input.kbId, input.pageType);
      output.pages = pages.map((p) => ({
        id: p.id,
        title: p.title,
        pageType: p.pageType,
        tokenCount: p.tokenCount,
      }));
    }

    // Follow links from a page
    if (input.followLinks && input.pageId) {
      const depth = Math.min(input.depth ?? 1, 3);
      const linkedPages = await this.linker.getLinkedPages(input.pageId, depth);

      output.linkedPages = linkedPages.map((lp) => ({
        id: lp.page.id,
        title: lp.page.title,
        pageType: lp.page.pageType,
        distance: lp.distance,
        linkType: lp.linkType,
      }));
    }

    return output;
  }
}
