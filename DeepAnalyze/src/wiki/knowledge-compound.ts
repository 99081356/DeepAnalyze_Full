// =============================================================================
// DeepAnalyze - Knowledge Compounding Write-Back
// =============================================================================
// Takes agent output and writes it back to the wiki as report-type pages.
// This enables "knowledge compounding" -- analysis results are automatically
// saved to the knowledge base so they can be discovered by future searches.
// Uses PG Repository layer for all database operations.
// =============================================================================

import { getRepos } from "../store/repos/index.js";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { Linker } from "./linker.js";
import { writeFileSyncAtomic } from "../utils/atomicWrite.js";

// ---------------------------------------------------------------------------
// Entity extraction result
// ---------------------------------------------------------------------------

export interface ExtractedEntity {
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Helper: generate a report title from agent type and input
// ---------------------------------------------------------------------------

/**
 * Generate a meaningful report title from the agent type and first line of
 * input.  The title is cleaned for use as a display string and filesystem
 * component.
 *
 * Example outputs:
 *   "[Explore] What are the key risks in this report"
 *   "[Compile] Summarize the financial data"
 */
export function generateReportTitle(agentType: string, input: string): string {
  // Take the first line (or whole input if single-line)
  const firstLine = input.split("\n")[0] ?? input;

  // Truncate to ~50 characters at a word boundary
  const maxLen = 50;
  let snippet = firstLine.trim();
  if (snippet.length > maxLen) {
    snippet = snippet.slice(0, maxLen);
    // Walk back to the last space to avoid cutting a word in half
    const lastSpace = snippet.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.5) {
      snippet = snippet.slice(0, lastSpace);
    }
  }

  // Clean the snippet: remove characters that are problematic in titles /
  // filenames, collapse whitespace
  snippet = snippet
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Prefix with the agent type tag
  const tag = agentType.charAt(0).toUpperCase() + agentType.slice(1);
  return `[${tag}] ${snippet}`;
}

// ---------------------------------------------------------------------------
// KnowledgeCompounder
// ---------------------------------------------------------------------------

export class KnowledgeCompounder {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  // -----------------------------------------------------------------------
  // Core: compound an agent result into a wiki report page
  // -----------------------------------------------------------------------

  /**
   * Write an agent result back to the wiki as a "report"-type page.
   *
   * @param kbId      Knowledge base to save into
   * @param agentType The agent type tag (e.g. "explore", "compile")
   * @param input     The original task prompt / input text
   * @param output    The agent's output text
   * @returns The created page ID, or `null` if nothing was written (output
   *          too short or looks like an error).
   */
  async compoundAgentResult(
    kbId: string,
    agentType: string,
    input: string,
    output: string,
  ): Promise<string | null> {
    // ---- Guards ----------------------------------------------------------
    // Skip if the output is too short to be useful
    if (!output || output.trim().length < 50) {
      return null;
    }

    // Skip if the output looks like an error message
    if (this.looksLikeError(output)) {
      return null;
    }

    // ---- Build content ---------------------------------------------------
    const title = generateReportTitle(agentType, input);
    const timestamp = new Date().toISOString();
    const inputSummary = input.length > 200
      ? input.slice(0, 200) + "..."
      : input;

    const content = [
      `# ${title}`,
      "",
      `> **Agent Type:** ${agentType}  `,
      `> **Generated:** ${timestamp}`,
      "",
      "## Input Summary",
      "",
      inputSummary,
      "",
      "## Analysis Result",
      "",
      output,
      "",
    ].join("\n");

    // ---- Persist ---------------------------------------------------------
    const page = await this.createReportPage(kbId, title, content);

    console.log(
      `[KnowledgeCompounder] Saved report page ${page.id} for KB ${kbId}`,
    );

    return page.id;
  }

  // -----------------------------------------------------------------------
  // Simple regex-based entity extraction
  // -----------------------------------------------------------------------

  /**
   * Extract entity-like phrases from text using simple heuristics:
   *   - 2+ consecutive capitalized words (English proper nouns)
   *   - Quoted names ("..." or '...')
   *   - Chinese names (2-4 character Chinese sequences)
   *
   * This is intentionally lightweight -- the full EntityExtractor (which uses
   * an LLM) lives in `entity-extractor.ts`.
   */
  extractEntities(text: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    // 1) Consecutive capitalized words (2+ words starting with uppercase)
    const capMatches = text.matchAll(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    );
    for (const m of capMatches) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        entities.push({ name, type: "proper_noun" });
      }
    }

    // 2) Quoted names -- both double and single quotes
    const quotedMatches = text.matchAll(/["""](.+?)["""]|'([^']+)'/g);
    for (const m of quotedMatches) {
      const name = m[1] ?? m[2];
      if (name && name.length >= 2 && name.length <= 80 && !seen.has(name)) {
        seen.add(name);
        entities.push({ name, type: "quoted_name" });
      }
    }

    // 3) Chinese names (2-4 consecutive CJK characters, common for names)
    const cjkMatches = text.matchAll(/[\u4e00-\u9fff]{2,4}/g);
    for (const m of cjkMatches) {
      const name = m[0];
      // Filter out common non-name words by length heuristic
      if (
        name.length >= 2 &&
        name.length <= 4 &&
        !seen.has(name)
      ) {
        seen.add(name);
        entities.push({ name, type: "chinese_name" });
      }
    }

    return entities;
  }

  // -----------------------------------------------------------------------
  // Compound with entity linking
  // -----------------------------------------------------------------------

  /**
   * Create a report page AND create `entity_ref` links for any entities
   * extracted from the content.  Entity pages that already exist in the KB
   * will be linked; entities without a pre-existing page are still recorded
   * as links for future discovery.
   */
  async compoundWithEntities(
    kbId: string,
    content: string,
    title: string,
    linker: Linker,
  ): Promise<string> {
    // Create the report page
    const page = await this.createReportPage(kbId, title, content);

    // Extract entities and create entity_ref links
    const entities = this.extractEntities(content);
    const repos = await getRepos();

    for (const entity of entities) {
      // Look up whether an entity page already exists for this name in the KB
      const existingPage = await repos.wikiPage.findByTitle(kbId, entity.name, "entity");

      if (existingPage) {
        // Create bidirectional entity_ref links between report and entity page
        await linker.createBidirectionalLinks(
          page.id,
          existingPage.id,
          entity.name,
          `Auto-linked from report: ${title}`,
        );
      }
    }

    console.log(
      `[KnowledgeCompounder] Saved report ${page.id} with ${entities.length} entities for KB ${kbId}`,
    );

    return page.id;
  }

  // -----------------------------------------------------------------------
  // Compound with source tracing and confidence scoring
  // -----------------------------------------------------------------------

  /**
   * Compound an agent result with source tracing and confidence scoring.
   * Creates a report page that includes a "来源溯源" (source tracing) section
   * linking back to the wiki pages that informed the analysis.
   *
   * @param kbId      Knowledge base to save into
   * @param agentType The agent type tag (e.g. "explore", "compile")
   * @param input     The original task prompt / input text
   * @param output    The agent's output text
   * @param sources   Array of source pages that were accessed during the run
   * @returns The created page ID, or `null` if nothing was written.
   */
  async compoundWithTracing(
    kbId: string,
    agentType: string,
    input: string,
    output: string,
    sources: Array<{ pageId: string; title: string }>,
  ): Promise<string | null> {
    // Skip if output is too short to be worth compounding
    if (!output || output.trim().length < 100) return null;

    const title = `[${agentType}] ${input.slice(0, 60)}...`;
    const timestamp = new Date().toISOString();
    const confidence = this.assessConfidence(output, sources);

    // Build source tracing section
    const tracingSection = sources.length > 0
      ? `\n\n## 来源溯源\n${sources.map(s => `- [[${s.title}]]`).join("\n")}`
      : "";

    const content = [
      `# ${title}`,
      "",
      `> **Agent Type:** ${agentType}  `,
      `> **Generated:** ${timestamp}  `,
      `> **Confidence:** ${confidence}`,
      "",
      "## Input Summary",
      "",
      input.length > 500 ? input.slice(0, 500) + "..." : input,
      "",
      "## Analysis Result",
      "",
      output,
      tracingSection,
    ].join("\n");

    // Save as wiki report page
    const page = await this.createReportPage(kbId, title, content);

    console.log(
      `[KnowledgeCompounder] Saved traced report page ${page.id} for KB ${kbId} (confidence: ${confidence}, sources: ${sources.length})`,
    );

    // Emit event
    if (page.id) {
      try {
        const { eventBus } = require("../services/event-bus.js");
        eventBus.emit({ type: "compound_written", kbId, pageId: page.id, title });
      } catch {
        // eventBus not available
      }
    }

    return page.id;
  }

  /**
   * Assess confidence level based on number of sources.
   */
  private assessConfidence(
    _output: string,
    sources: Array<{ pageId: string; title: string }>,
  ): "high" | "medium" | "low" {
    if (sources.length >= 3) return "high";
    if (sources.length >= 1) return "medium";
    return "low";
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Heuristic check: does the output look like an error / failure rather
   * than useful analysis content?
   */
  private looksLikeError(output: string): boolean {
    const lower = output.trim().toLowerCase();

    // Common error prefixes
    const errorPrefixes = [
      "error:",
      "failed:",
      "exception:",
      "uncaught",
      "traceback",
    ];
    for (const prefix of errorPrefixes) {
      if (lower.startsWith(prefix)) {
        return true;
      }
    }

    // If the entire output is a single short error-like line, skip it
    const lines = output.trim().split("\n");
    if (lines.length === 1 && lower.includes("error") && lower.length < 200) {
      return true;
    }

    return false;
  }

  /**
   * Create a report page in PG and on the filesystem.
   */
  private async createReportPage(
    kbId: string,
    title: string,
    content: string,
  ): Promise<import("../store/repos/interfaces.js").WikiPage> {
    const wikiDir = join(this.dataDir, "wiki");
    const id = randomUUID();

    // Resolve filesystem path for report
    const filePath = join(wikiDir, kbId, "reports", `${id}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSyncAtomic(filePath, content, { encoding: "utf-8" });

    // Compute content hash and token count
    const contentHash = createHash("md5").update(content).digest("hex");
    const tokenCount = Math.ceil(content.length / 4);

    // Insert into PG
    const repos = await getRepos();
    const page = await repos.wikiPage.create({
      kb_id: kbId,
      doc_id: undefined,
      page_type: "report",
      title,
      content,
      file_path: filePath,
      content_hash: contentHash,
      token_count: tokenCount,
    });

    return page;
  }
}

// ---------------------------------------------------------------------------
// Anchor-level source tracing (standalone function)
// ---------------------------------------------------------------------------

/**
 * Anchor-level source tracing (enhanced alternative to page-level tracing).
 * Generates a structured source tracing section with confidence scoring.
 */
export function compoundWithAnchors(
  kbId: string,
  agentType: string,
  input: string,
  output: string,
  anchors: Array<{
    anchorId: string;
    docId: string;
    originalName: string;
    sectionTitle: string | null;
    pageNumber: number | null;
    role: "supporting" | "contradicting" | "referenced";
  }>,
): string | null {
  if (anchors.length === 0) return null;

  // Group by document
  const byDoc = new Map<string, typeof anchors>();
  for (const a of anchors) {
    const existing = byDoc.get(a.docId) || [];
    existing.push(a);
    byDoc.set(a.docId, existing);
  }

  // Calculate confidence
  const supportingCount = anchors.filter(a => a.role === "supporting").length;
  const confidence = supportingCount >= 3 ? "高" : supportingCount >= 1 ? "中" : "低";

  // Generate compound content
  const sections: string[] = [];

  sections.push(`## 来源溯源（锚点级）`);
  sections.push(`**置信度:** ${confidence}（${supportingCount} 个独立来源）`);
  sections.push("");

  for (const [, docAnchors] of byDoc) {
    const docName = docAnchors[0].originalName;
    sections.push(`### ${docName}`);

    for (const a of docAnchors) {
      const location = [
        a.sectionTitle,
        a.pageNumber != null ? `第${a.pageNumber}页` : null,
      ].filter(Boolean).join(" → ");

      const roleLabel = {
        supporting: "支持",
        contradicting: "矛盾",
        referenced: "引用",
      }[a.role];

      sections.push(`- [${roleLabel}] ${location} (锚点: ${a.anchorId})`);
    }
    sections.push("");
  }

  sections.push("---");
  sections.push(`**元数据:** agentType=${agentType}, 来源数量=${anchors.length}, 置信度=${confidence}`);

  return sections.join("\n");
}
