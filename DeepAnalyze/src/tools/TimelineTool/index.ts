// =============================================================================
// DeepAnalyze - Timeline Builder Tool
// =============================================================================
// Extracts chronological events from wiki pages using date pattern matching
// and builds timeline data suitable for visualization.
// =============================================================================

import type { AgentTool } from "../../services/agent/types.js";
import type { Retriever } from "../../wiki/retriever.js";
import { getRepos } from "../../store/repos/index.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TimelineToolDeps {
  retriever: Retriever;
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimelineEvent {
  /** ISO-formatted date string (YYYY-MM-DD or YYYY-MM or YYYY) */
  date: string;
  /** Brief title/label for the event */
  title: string;
  /** Description of the event (surrounding context from the source) */
  description: string;
  /** Page ID where this event was found */
  sourcePageId: string;
  /** Title of the page where this event was found */
  sourceTitle: string;
}

interface TimelineResult {
  events: TimelineEvent[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Date extraction patterns
// ---------------------------------------------------------------------------

/**
 * ISO date: 2024-01-15 or 2024/01/15
 */
const ISO_DATE_RE = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g;

/**
 * ISO year-month: 2024-01 or 2024/01
 * (only matches when NOT followed by another -/ digit, to avoid matching full dates)
 */
const ISO_MONTH_RE = /\b(\d{4})[-/](0?[1-9]|1[0-2])\b(?![\-/]\d)/g;

/**
 * Chinese dates: 2024年1月15日 or 2024年1月 or 2024年
 */
const CHINESE_FULL_DATE_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日/g;
const CHINESE_MONTH_DATE_RE = /(\d{4})年(\d{1,2})月(?!\d)/g;
const CHINESE_YEAR_DATE_RE = /(\d{4})年(?!\d)/g;

/**
 * English dates: January 15, 2024 or Jan 15, 2024 or 15 January 2024
 */
const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const ENGLISH_DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/gi;

const ENGLISH_DATE_ALT_RE = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})\b/gi;

// ---------------------------------------------------------------------------
// Date parsing helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a year, month, day to an ISO date string.
 * Pads month and day to 2 digits.
 */
function normalizeDate(year: number, month?: number, day?: number): string {
  if (day && month) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (month) {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  return `${year}`;
}

/**
 * Validate that a year is reasonable (between 1000 and 2100).
 */
function isValidYear(year: number): boolean {
  return year >= 1000 && year <= 2100;
}

/**
 * Validate that a month is between 1 and 12.
 */
function isValidMonth(month: number): boolean {
  return month >= 1 && month <= 12;
}

/**
 * Validate that a day is between 1 and 31.
 */
function isValidDay(day: number): boolean {
  return day >= 1 && day <= 31;
}

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

interface RawEvent {
  date: string;
  dateEnd: number; // character position where the date match ends
  description: string;
  sourcePageId: string;
  sourceTitle: string;
}

/**
 * Extract a sentence or paragraph around a date match position.
 * Looks backward for the start of the sentence and forward for the end.
 */
function extractContext(text: string, matchEnd: number, maxLen: number = 200): string {
  // Look backward for sentence start
  let start = matchEnd;
  for (let i = matchEnd - 1; i >= Math.max(0, matchEnd - maxLen); i--) {
    const ch = text[i];
    if (ch === "." || ch === "\n" || ch === "!" || ch === "?") {
      start = i + 1;
      break;
    }
    if (i === Math.max(0, matchEnd - maxLen)) {
      start = i;
    }
  }

  // Look forward for sentence end
  let end = matchEnd;
  for (let i = matchEnd; i < Math.min(text.length, matchEnd + maxLen); i++) {
    const ch = text[i];
    if (ch === "." || ch === "\n" || ch === "!" || ch === "?") {
      end = i;
      break;
    }
    if (i === Math.min(text.length, matchEnd + maxLen) - 1) {
      end = i + 1;
    }
  }

  let context = text.substring(start, end).trim();
  if (context.length > maxLen) {
    context = context.substring(0, maxLen) + "...";
  }
  return context;
}

/**
 * Extract date-referenced events from text content.
 */
function extractEventsFromText(
  text: string,
  sourcePageId: string,
  sourceTitle: string,
): RawEvent[] {
  const events: RawEvent[] = [];
  const seenDates = new Set<string>();

  // Reset regex indices
  let match: RegExpExecArray | null;

  // ISO dates: 2024-01-15
  ISO_DATE_RE.lastIndex = 0;
  while ((match = ISO_DATE_RE.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (isValidYear(year) && isValidMonth(month) && isValidDay(day)) {
      const date = normalizeDate(year, month, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          dateEnd: match.index + match[0].length,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // Chinese full dates: 2024年1月15日
  CHINESE_FULL_DATE_RE.lastIndex = 0;
  while ((match = CHINESE_FULL_DATE_RE.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (isValidYear(year) && isValidMonth(month) && isValidDay(day)) {
      const date = normalizeDate(year, month, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          dateEnd: match.index + match[0].length,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // Chinese month dates: 2024年1月
  CHINESE_MONTH_DATE_RE.lastIndex = 0;
  while ((match = CHINESE_MONTH_DATE_RE.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    if (isValidYear(year) && isValidMonth(month)) {
      const date = normalizeDate(year, month);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          dateEnd: match.index + match[0].length,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // English dates: Month Day, Year
  ENGLISH_DATE_RE.lastIndex = 0;
  while ((match = ENGLISH_DATE_RE.exec(text)) !== null) {
    const monthNum = MONTH_NAMES[match[1].toLowerCase()];
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    if (monthNum && isValidYear(year) && isValidDay(day)) {
      const date = normalizeDate(year, monthNum, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          dateEnd: match.index + match[0].length,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // English dates alt: Day Month Year
  ENGLISH_DATE_ALT_RE.lastIndex = 0;
  while ((match = ENGLISH_DATE_ALT_RE.exec(text)) !== null) {
    const day = parseInt(match[1], 10);
    const monthNum = MONTH_NAMES[match[2].toLowerCase()];
    const year = parseInt(match[3], 10);
    if (monthNum && isValidYear(year) && isValidDay(day)) {
      const date = normalizeDate(year, monthNum, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          dateEnd: match.index + match[0].length,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createTimelineTool(deps: TimelineToolDeps): AgentTool {
  return {
    name: "timeline_build",
    description:
      "从知识库内容构建时间线。提取包含日期引用的事件并按时间排序。" +
      "返回带日期和描述的时间线事件。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询，用于查找与时间线提取相关的页面",
        },
        kbId: {
          type: "string",
          description: "要搜索的知识库 ID",
        },
        maxEvents: {
          type: "number",
          description: "返回时间线事件的最大数量（默认：50）",
        },
      },
      required: ["query", "kbId"],
    },
    async execute(input: Record<string, unknown>): Promise<TimelineResult | { error: string }> {
      try {
        const query = input.query as string;
        const kbId = input.kbId as string;
        const maxEvents = (input.maxEvents as number) || 50;

        // -------------------------------------------------------------------
        // 1. Search for relevant pages
        // -------------------------------------------------------------------

        const results = await deps.retriever.search(query, {
          kbIds: [kbId],
          topK: 20,
        });

        if (results.length === 0) {
          return {
            events: [],
            totalCount: 0,
          };
        }

        // -------------------------------------------------------------------
        // 2. Extract events from each page
        // -------------------------------------------------------------------

        const allEvents: TimelineEvent[] = [];

        for (const result of results) {
          let content: string;
          try {
            const repos = await getRepos();
            const page = await repos.wikiPage.getById(result.pageId);
            if (!page) continue;
            content = page.content || "";
            if (!content) continue;
          } catch {
            // Skip pages whose content cannot be read
            continue;
          }

          const rawEvents = extractEventsFromText(
            content,
            result.pageId,
            result.title,
          );

          for (const raw of rawEvents) {
            // Generate a brief title from the description
            const title = generateEventTitle(raw.description);

            allEvents.push({
              date: raw.date,
              title,
              description: raw.description,
              sourcePageId: raw.sourcePageId,
              sourceTitle: raw.sourceTitle,
            });
          }
        }

        // -------------------------------------------------------------------
        // 3. Sort chronologically
        // -------------------------------------------------------------------

        allEvents.sort((a, b) => {
          // Compare date strings - ISO format sorts lexicographically
          return a.date.localeCompare(b.date);
        });

        // -------------------------------------------------------------------
        // 4. Limit and return
        // -------------------------------------------------------------------

        const limited = allEvents.slice(0, maxEvents);

        return {
          events: limited,
          totalCount: allEvents.length,
        };
      } catch (err) {
        return {
          error: `Timeline generation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short title from an event description by taking the first
 * sentence or first N characters.
 */
function generateEventTitle(description: string): string {
  // Take the first sentence
  const sentenceEnd = description.search(/[.!?]/);
  if (sentenceEnd !== -1 && sentenceEnd < 100) {
    return description.substring(0, sentenceEnd).trim();
  }

  // Take first 80 characters
  if (description.length > 80) {
    return description.substring(0, 80).trim() + "...";
  }

  return description.trim();
}
