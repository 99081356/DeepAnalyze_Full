// =============================================================================
// DeepAnalyze - Output Template System (S6.5)
// =============================================================================
// Lightweight template system for enforcing structured output from agents.
// Templates define required sections/fields that must appear in the output.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputTemplate {
  /** Unique template name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Fields that MUST appear as section headers in the output. */
  requiredFields: string[];
  /** Descriptions for each field, used to generate guidance. */
  fieldDescriptions: Record<string, string>;
  /** Optional per-field validation rules. */
  validationRules?: Record<string, (value: string) => boolean>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  missingFields: string[];
  warnings: string[];
}

/**
 * Validate whether the content contains all required fields from the template.
 * A field is considered present if its name appears as a Markdown header
 * (## Field Name) or as a bold label (**Field Name**) in the content.
 */
export function validateOutput(
  template: OutputTemplate,
  content: string,
): ValidationResult {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  for (const field of template.requiredFields) {
    // Check for Markdown header: ## Field Name
    const headerPattern = new RegExp(
      `^#{1,4}\\s+${escapeRegex(field)}`,
      "m",
    );
    // Check for bold label: **Field Name**
    const boldPattern = new RegExp(
      `\\*\\*${escapeRegex(field)}\\*\\*`,
    );

    if (!headerPattern.test(content) && !boldPattern.test(content)) {
      missingFields.push(field);
      continue;
    }

    // Run custom validation if provided
    if (template.validationRules?.[field]) {
      try {
        if (!template.validationRules[field]!(content)) {
          warnings.push(`字段 "${field}" 存在但未通过验证规则`);
        }
      } catch {
        warnings.push(`字段 "${field}" 验证时发生错误`);
      }
    }
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Guidance generation
// ---------------------------------------------------------------------------

/**
 * Generate prompt guidance text that tells the model which fields to include.
 * This text can be appended to a skill's system prompt.
 */
export function formatTemplateGuidance(template: OutputTemplate): string {
  const lines: string[] = [
    `## 输出模板: ${template.name}`,
    "",
    template.description,
    "",
    "你的输出必须包含以下必需章节：",
    "",
  ];

  for (const field of template.requiredFields) {
    const desc = template.fieldDescriptions[field] ?? "";
    lines.push(`- **${field}**: ${desc}`);
  }

  lines.push("");
  lines.push(
    "请确保每个必需章节都有实质性内容，不要留空或仅写标题。使用 Markdown 二级标题（##）标记每个章节。",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

export const BUILTIN_TEMPLATES: OutputTemplate[] = [
  {
    name: "analysis-report",
    description: "综合分析报告模板——适用于案件分析、技术评估、竞品研究等场景",
    requiredFields: [
      "执行摘要",
      "背景介绍",
      "详细分析",
      "关键发现",
      "待解决问题",
    ],
    fieldDescriptions: {
      "执行摘要": "对分析结论的简要概述，包含最重要的发现和建议",
      "背景介绍": "分析对象的背景信息、分析目的和范围",
      "详细分析": "分维度、分层次的深入分析内容",
      "关键发现": "编号列出最重要的分析发现，每条附来源引用",
      "待解决问题": "列出仍需补充信息或深入调查的问题",
    },
  },
  {
    name: "evidence-review",
    description: "证据审查模板——适用于证据链完整性评估和矛盾分析",
    requiredFields: [
      "证据清单",
      "关联分析",
      "完整性评估",
      "矛盾标注",
    ],
    fieldDescriptions: {
      "证据清单": "逐条列出所有相关证据，包含原文引用和来源标注",
      "关联分析": "分析证据之间的逻辑关系、时间顺序和因果关系",
      "完整性评估": "评估证据链是否完整，标注缺失环节",
      "矛盾标注": "标注并分析证据之间的矛盾和不一致之处",
    },
    validationRules: {
      "证据清单": (content: string) => {
        // Must contain at least one source citation marker
        return /\[来源[:：]/.test(content) || /\[数据来源/.test(content);
      },
    },
  },
  {
    name: "fact-check",
    description: "事实核查模板——适用于声明验证和来源追溯",
    requiredFields: [
      "待验证声明",
      "验证结果",
      "来源引用",
      "置信度",
    ],
    fieldDescriptions: {
      "待验证声明": "列出需要验证的事实性声明",
      "验证结果": "对每条声明给出验证结论（确认/否认/无法验证）",
      "来源引用": "支撑验证结论的具体来源和数据",
      "置信度": "对每条验证结果的置信度评估（高/中/低）",
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
