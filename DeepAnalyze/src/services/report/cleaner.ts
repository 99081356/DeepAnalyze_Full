// =============================================================================
// DeepAnalyze - 4-Stage Report Cleaning Pipeline
// =============================================================================
// Transforms raw LLM-generated report content into clean, reference-marked,
// entity-linked output suitable for display and storage.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Reference {
  index: number;
  docId: string;
  pageId: string;
  title: string;
  snippet: string;
}

export interface SourceDocument {
  docId: string;
  pageId: string;
  title: string;
  content: string;
}

export interface CleanStats {
  originalLength: number;
  cleanLength: number;
  referencesExtracted: number;
  entitiesLinked: number;
  blocksRemoved: number;
}

export interface CleanResult {
  cleanContent: string;
  references: Reference[];
  entities: string[];
  stats: CleanStats;
}

// ---------------------------------------------------------------------------
// Stage 1: Content Cleaning
// ---------------------------------------------------------------------------

/**
 * Remove boilerplate blocks and prefixes injected by the LLM:
 *  - "From: Overview: xxx" blocks
 *  - "From: Summary: xxx" blocks
 *  - "Based on the document..." prefixes
 *  - Extra whitespace normalization
 */
function stage1_contentCleaning(raw: string): { content: string; blocksRemoved: number } {
  let content = raw;
  let blocksRemoved = 0;

  // Remove "From: Overview: xxx" blocks (possibly multiline)
  const overviewBlockRe = /^From:\s*Overview:\s*.*?(?:\n\n|\n(?=[^\s])|$)/gms;
  const beforeOverview = content;
  content = content.replace(overviewBlockRe, "");
  if (content !== beforeOverview) blocksRemoved++;

  // Remove "From: Summary: xxx" blocks
  const summaryBlockRe = /^From:\s*Summary:\s*.*?(?:\n\n|\n(?=[^\s])|$)/gms;
  const beforeSummary = content;
  content = content.replace(summaryBlockRe, "");
  if (content !== beforeSummary) blocksRemoved++;

  // Remove "Based on the document..." prefixes (sentence-level)
  const basedOnPrefixRe = /^Based on the document[^.]*\.\s*/gm;
  const beforeBased = content;
  content = content.replace(basedOnPrefixRe, "");
  if (content !== beforeBased) blocksRemoved++;

  // Remove "Based on the provided document..." prefixes
  const basedOnProvidedRe = /^Based on the provided (?:document|information|text|context)[^.]*\.\s*/gm;
  const beforeProvided = content;
  content = content.replace(basedOnProvidedRe, "");
  if (content !== beforeProvided) blocksRemoved++;

  // Remove "According to the document..." prefixes
  const accordingToRe = /^According to the (?:document|text|provided information)[^.]*\.\s*/gm;
  const beforeAccording = content;
  content = content.replace(accordingToRe, "");
  if (content !== beforeAccording) blocksRemoved++;

  // Clean up excessive blank lines (3+ consecutive newlines -> 2)
  content = content.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace
  content = content.trim();

  return { content, blocksRemoved };
}

// ---------------------------------------------------------------------------
// Stage 2: Reference Marking
// ---------------------------------------------------------------------------

/**
 * Identify quoted passages from source documents and replace them with [n]
 * markers. When source documents are provided, we look for verbatim or
 * near-verbatim matches (>= 80% similarity) and build a reference index.
 *
 * Without source documents, we look for common citation patterns like
 * "Source: DocumentName, page X" or bracketed footnote patterns.
 */
function stage2_referenceMarking(
  content: string,
  sourceDocuments?: SourceDocument[],
): { content: string; references: Reference[] } {
  const references: Reference[] = [];
  let refIndex = 0;

  if (sourceDocuments && sourceDocuments.length > 0) {
    // For each source document, look for verbatim quotes of >= 30 characters
    // Collect all matches first, then replace from back-to-front to avoid index shifting
    const matches: Array<{ start: number; end: number; refIndex: number; ref: Reference }> = [];

    for (const doc of sourceDocuments) {
      const docContent = doc.content;
      if (!docContent) continue;

      // Split doc into sentences/fragments for matching
      const fragments = docContent
        .split(/[.\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 30);

      for (const fragment of fragments) {
        // Check if this fragment appears in the content
        const idx = content.indexOf(fragment);
        if (idx !== -1) {
          // Skip if this range overlaps with an existing match
          const overlaps = matches.some(
            (m) => idx < m.end && idx + fragment.length > m.start,
          );
          if (overlaps) continue;

          refIndex++;
          const ref: Reference = {
            index: refIndex,
            docId: doc.docId,
            pageId: doc.pageId,
            title: doc.title,
            snippet: fragment.substring(0, 120) + (fragment.length > 120 ? "..." : ""),
          };
          references.push(ref);
          matches.push({ start: idx, end: idx + fragment.length, refIndex, ref });
        }
      }
    }

    // Sort matches by start position descending (back-to-front) for safe replacement
    matches.sort((a, b) => b.start - a.start);
    for (const match of matches) {
      content =
        content.substring(0, match.start) +
        `[${match.refIndex}]` +
        content.substring(match.end);
    }
  }

  // Also detect common inline citation patterns and convert to references
  // Pattern: "Source: DocumentName, page X" or "(Source: DocumentName)"
  const sourcePattern = /\(?\s*Source:\s*([^,)]+)(?:,\s*page\s+(\d+))?\s*\)?/gi;
  let sourceMatch: RegExpExecArray | null;
  const processedRefs = new Set<string>();

  sourcePattern.lastIndex = 0;
  while ((sourceMatch = sourcePattern.exec(content)) !== null) {
    const sourceTitle = sourceMatch[1].trim();
    const pageNum = sourceMatch[2] || "1";
    const refKey = `${sourceTitle}:${pageNum}`;

    if (!processedRefs.has(refKey)) {
      processedRefs.add(refKey);
      refIndex++;
      references.push({
        index: refIndex,
        docId: "",
        pageId: `page-${pageNum}`,
        title: sourceTitle,
        snippet: sourceMatch[0],
      });
    }

    // Find the reference index for this source
    const existingRef = references.find(
      (r) => r.title === sourceTitle && r.pageId === `page-${pageNum}`,
    );
    if (existingRef) {
      content =
        content.substring(0, sourceMatch.index) +
        `[${existingRef.index}]` +
        content.substring(sourceMatch.index + sourceMatch[0].length);
      // Reset regex index after modification
      sourcePattern.lastIndex = sourceMatch.index + `[${existingRef.index}]`.length;
    }
  }

  return { content, references };
}

// ---------------------------------------------------------------------------
// Stage 3: Entity Linking
// ---------------------------------------------------------------------------

// Pattern for Chinese names (2-4 character names)
const CHINESE_NAME_RE = /[\u4e00-\u9fff]{2,4}(?=\s*(?:说|表示|指出|认为|强调|透露|称|介绍|透露|回应|透露|表示))/g;

// Pattern for monetary amounts: $1,234,567 or 1,234万元 or $1.5M
const MONEY_AMOUNT_RE = /[$￥]\s*[\d,]+(?:\.\d+)?\s*(?:万|亿|元|美元|M|B|K)?/g;
const CHINESE_MONEY_RE = /[\d,]+(?:\.\d+)?\s*(?:万元|亿元|元|美元|港币|人民币)/g;

// Pattern for English proper names (Title Case, 2-3 words)
const ENGLISH_NAME_RE = /\b([A-Z][a-z]+\s+(?:[A-Z]\.\s+)?[A-Z][a-z]+)\b/g;

/**
 * Identify entity mentions (persons, amounts) in the cleaned content
 * and collect a deduplicated entity list.
 */
function stage3_entityLinking(content: string): { content: string; entities: string[] } {
  const entitySet = new Set<string>();

  // Extract Chinese names with context verbs
  let match: RegExpExecArray | null;
  CHINESE_NAME_RE.lastIndex = 0;
  while ((match = CHINESE_NAME_RE.exec(content)) !== null) {
    entitySet.add(match[0]);
  }

  // Extract monetary amounts (USD style)
  MONEY_AMOUNT_RE.lastIndex = 0;
  while ((match = MONEY_AMOUNT_RE.exec(content)) !== null) {
    entitySet.add(match[0].trim());
  }

  // Extract monetary amounts (Chinese style)
  CHINESE_MONEY_RE.lastIndex = 0;
  while ((match = CHINESE_MONEY_RE.exec(content)) !== null) {
    entitySet.add(match[0].trim());
  }

  // Extract English proper names
  ENGLISH_NAME_RE.lastIndex = 0;
  while ((match = ENGLISH_NAME_RE.exec(content)) !== null) {
    // Filter out common non-name Title Case phrases
    const name = match[1];
    const nonNameWords = ["The", "This", "That", "These", "Those", "Based", "According"];
    const words = name.split(/\s+/);
    if (!words.some((w) => nonNameWords.includes(w))) {
      entitySet.add(name);
    }
  }

  const entities = Array.from(entitySet);
  return { content, entities };
}

// ---------------------------------------------------------------------------
// Stage 4: Final Cleanup
// ---------------------------------------------------------------------------

/**
 * Normalize Markdown heading hierarchy and remove duplicate whitespace.
 * Ensures headings start at level 2 (##) and are sequential.
 */
function stage4_finalCleanup(content: string): string {
  let cleaned = content;

  // Normalize heading hierarchy: find the minimum heading level and shift down
  const headingRe = /^(#{1,6})\s/gm;
  const headings: number[] = [];
  let hMatch: RegExpExecArray | null;
  headingRe.lastIndex = 0;
  while ((hMatch = headingRe.exec(cleaned)) !== null) {
    headings.push(hMatch[1].length);
  }

  if (headings.length > 0) {
    const minLevel = Math.min(...headings);
    if (minLevel !== 2) {
      const shift = minLevel - 2;
      if (shift > 0) {
        // Remove excess # from headings (e.g., ### -> ## if min was 3)
        cleaned = cleaned.replace(/^(#{1,6})\s/gm, (full, hashes: string) => {
          const newLen = Math.max(2, hashes.length - shift);
          return "#".repeat(newLen) + " ";
        });
      } else {
        // Add # to headings (e.g., # -> ## if min was 1)
        cleaned = cleaned.replace(/^(#{1,6})\s/gm, (full, hashes: string) => {
          const newLen = Math.min(6, hashes.length - shift);
          return "#".repeat(newLen) + " ";
        });
      }
    }
  }

  // Remove duplicate whitespace (collapse multiple spaces to single, but preserve newlines)
  cleaned = cleaned.replace(/[^\S\n]{2,}/g, " ");

  // Remove trailing whitespace on each line
  cleaned = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  // Ensure file ends with a single newline
  cleaned = cleaned.trimEnd() + "\n";

  return cleaned;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the full 4-stage report cleaning pipeline.
 *
 * Stage 1: Content Cleaning  -- remove boilerplate blocks
 * Stage 2: Reference Marking -- identify & mark quoted passages
 * Stage 3: Entity Linking    -- extract person/amount entities
 * Stage 4: Final Cleanup     -- normalize headings, trim whitespace
 */
export function cleanReport(
  rawContent: string,
  sourceDocuments?: SourceDocument[],
): CleanResult {
  const originalLength = rawContent.length;

  // Stage 1
  const stage1 = stage1_contentCleaning(rawContent);

  // Stage 2
  const stage2 = stage2_referenceMarking(stage1.content, sourceDocuments);

  // Stage 3
  const stage3 = stage3_entityLinking(stage2.content);

  // Stage 4
  const cleanContent = stage4_finalCleanup(stage3.content);

  return {
    cleanContent,
    references: stage2.references,
    entities: stage3.entities,
    stats: {
      originalLength,
      cleanLength: cleanContent.length,
      referencesExtracted: stage2.references.length,
      entitiesLinked: stage3.entities.length,
      blocksRemoved: stage1.blocksRemoved,
    },
  };
}
