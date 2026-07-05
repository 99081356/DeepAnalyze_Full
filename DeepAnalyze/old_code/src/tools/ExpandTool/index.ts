// =============================================================================
// DeepAnalyze - Expand Tool
// Expand from summary to detailed content, drilling down through wiki layers.
// Supports expanding by page ID, document ID, specific heading, or token budget.
// =============================================================================

import type { Expander, ExpandResult } from "../../wiki/expander.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface ExpandInput {
  /** Expand a specific page by its ID. */
  pageId?: string;
  /** Expand to a specific level starting from a document. */
  docId?: string;
  /** Target expansion level (L0=abstract, L1=overview, L2=fulltext). */
  targetLevel?: "L0" | "L1" | "L2";
  /** Expand a specific section within a page by heading. */
  heading?: string;
  /** Expand with a token budget (progressive detail). */
  tokenBudget?: number;
}

export interface ExpandOutput {
  /** The expanded page result. */
  result: ExpandResult;
}

// ---------------------------------------------------------------------------
// ExpandTool
// ---------------------------------------------------------------------------

export class ExpandTool {
  readonly name = "expand";
  readonly description =
    "从摘要逐层深入到详细内容，通过 Wiki 层级展开 " +
    "（L0 摘要 -> L1 结构概述 -> L2 全文 -> 原始数据）。支持指定层级、章节或 token 预算。";

  private expander: Expander;

  constructor(expander: Expander) {
    this.expander = expander;
  }

  /**
   * Execute the expand operation.
   */
  async execute(input: ExpandInput): Promise<ExpandOutput> {
    // Expand by page ID
    if (input.pageId && !input.heading) {
      const result = await this.expander.expand(input.pageId);
      return { result };
    }

    // Expand a specific section by heading
    if (input.pageId && input.heading) {
      const result = await this.expander.expandSection(input.pageId, input.heading);
      if (!result) {
        throw new Error(
          `Section "${input.heading}" not found in page ${input.pageId}`,
        );
      }
      return { result };
    }

    // Expand to a specific level from a document
    if (input.docId && input.targetLevel) {
      const result = await this.expander.expandToLevel(
        input.docId,
        input.targetLevel,
      );
      return { result };
    }

    // Expand with token budget
    if (input.docId && input.tokenBudget) {
      const result = await this.expander.expandWithBudget(
        input.docId,
        input.tokenBudget,
      );
      return { result };
    }

    // Default: if only docId provided, expand to L0 (abstract)
    if (input.docId) {
      const result = await this.expander.expandToLevel(input.docId, "L0");
      return { result };
    }

    throw new Error(
      "Must provide either pageId or docId. " +
        "Use targetLevel, heading, or tokenBudget to control expansion.",
    );
  }
}
