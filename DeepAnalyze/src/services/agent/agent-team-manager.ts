// =============================================================================
// DeepAnalyze - Agent Team Manager
// =============================================================================
// High-level manager for agent teams. Wraps the CRUD operations from
// the PG-backed agent-team repo and provides preset templates for common
// team patterns.
// =============================================================================

import { getRepos } from "../../store/repos/index.js";
import type {
  AgentTeam,
  AgentTeamWithMembers,
  CreateTeamData,
  UpdateTeamData,
  TeamMode,
} from "../../store/repos/index.js";

// ---------------------------------------------------------------------------
// Template types
// ---------------------------------------------------------------------------

/** A preset template for creating a team quickly. */
export interface TeamTemplate {
  /** Unique template name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Scheduling mode for the workflow. */
  mode: TeamMode;
  /** Whether cross-review is enabled (council mode). */
  crossReview?: boolean;
  /** Pre-defined member definitions. */
  members?: CreateTeamData["members"];
  /** Whether members are generated dynamically at runtime. */
  dynamicGeneration?: boolean;
  /** Template for dynamic member generation. */
  agentTemplate?: {
    role: string;
    tools: string[];
  };
  /** Summary agent for dynamic templates (runs after all dynamic members). */
  summaryAgent?: {
    name: string;
    role: string;
    tools: string[];
  };
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

const TEMPLATES: TeamTemplate[] = [
  {
    name: "研究管道",
    description: "通用文档研究流程：依次检索、分析、总结",
    mode: "pipeline",
    members: [
      {
        role: "检索员",
        task: "根据目标，检索和收集所有相关信息源",
        tools: ["kb_search", "web_search"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "分析师",
        task: "对检索到的信息进行深度分析，识别关键模式和洞察",
        tools: ["*"],
        dependsOn: [],
        sortOrder: 1,
      },
      {
        role: "总结员",
        task: "将分析结果整合为结构化的总结报告",
        tools: ["think", "finish"],
        dependsOn: [],
        sortOrder: 2,
      },
    ],
  },
  {
    name: "多视角分析",
    description: "从不同视角平衡分析，然后交叉审查得出综合结论",
    mode: "council",
    crossReview: true,
    members: [
      {
        role: "安全分析师",
        task: "从安全合规角度分析问题",
        perspective: "安全与合规",
        tools: ["*"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "性能分析师",
        task: "从性能和效率角度分析问题",
        perspective: "性能与效率",
        tools: ["*"],
        dependsOn: [],
        sortOrder: 1,
      },
      {
        role: "用户体验分析师",
        task: "从用户体验角度分析问题",
        perspective: "用户体验",
        tools: ["*"],
        dependsOn: [],
        sortOrder: 2,
      },
    ],
  },
  {
    name: "并行研究",
    description: "快速并行文档扫描，多个研究员同时工作",
    mode: "parallel",
    members: [
      {
        role: "研究员-文档",
        task: "搜索和整理文档中的关键信息",
        tools: ["kb_search"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "研究员-网络",
        task: "搜索和整理网络上的相关补充信息",
        tools: ["web_search"],
        dependsOn: [],
        sortOrder: 1,
      },
      {
        role: "研究员-数据",
        task: "从数据角度分析和整理相关信息",
        tools: ["kb_search", "think"],
        dependsOn: [],
        sortOrder: 2,
      },
    ],
  },
  {
    name: "全面分析",
    description: "DAG驱动的复杂案件分析，依赖关系可控",
    mode: "graph",
    members: [
      {
        role: "初步调查员",
        task: "进行初步调查，收集基本事实和信息",
        tools: ["kb_search", "web_search"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "深度分析师",
        task: "基于初步调查结果进行深度分析",
        tools: ["*"],
        dependsOn: ["agent-0"],
        sortOrder: 1,
      },
      {
        role: "验证员",
        task: "独立验证初步调查结果的真实性",
        tools: ["kb_search", "web_search"],
        dependsOn: ["agent-0"],
        sortOrder: 2,
      },
      {
        role: "报告员",
        task: "整合深度分析和验证结果，生成最终报告",
        tools: ["think", "finish"],
        dependsOn: ["agent-1", "agent-2"],
        sortOrder: 3,
      },
    ],
  },
  // --- New three-layer architecture templates ---
  {
    name: "并行深度检索",
    description: "语义检索和精确检索并行执行，汇总分析师合并结果",
    mode: "graph",
    members: [
      {
        role: "语义检索员",
        task: "使用 kb_search 从多个语义角度进行检索，收集相关 Structure 页面内容。",
        tools: ["kb_search", "wiki_browse", "expand", "think", "finish"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "精确检索员",
        task: "使用 grep 精确匹配关键词、编号、数据，定位精确的文档段落。",
        tools: ["grep", "glob", "read_file", "think", "finish"],
        dependsOn: [],
        sortOrder: 1,
      },
      {
        role: "汇总分析师",
        task: "合并语义检索和精确检索的结果，使用 expand 验证关键信息，生成最终分析报告。引用格式：[来源: {原始文件名} → {章节标题} (第X页)]",
        tools: ["kb_search", "wiki_browse", "expand", "write_file", "push_content", "think", "finish"],
        dependsOn: ["agent-0", "agent-1"],
        sortOrder: 2,
      },
    ],
  },
  {
    name: "跨库对比分析",
    description: "每个知识库分配一个成员，各自在自己的 KB 范围内检索，最后汇总对比",
    mode: "parallel",
    dynamicGeneration: true,
    agentTemplate: {
      role: "在知识库 {kbName} (ID: {kbId}) 中搜索相关信息。使用 kb_search 检索 Structure 层，浏览相关章节内容，提取关键数据。",
      tools: ["kb_search", "wiki_browse", "expand", "think", "finish"],
    },
    summaryAgent: {
      name: "对比分析师",
      role: "汇总所有知识库的检索结果，进行跨库对比分析。标注每个发现来自哪个知识库的哪个文档。",
      tools: ["kb_search", "wiki_browse", "expand", "write_file", "push_content", "think", "finish"],
    },
  },
  {
    name: "全面深度分析",
    description: "4 Agent graph 模式：初步调查 → 语义+精确并行检索 → 验证报告",
    mode: "graph",
    members: [
      {
        role: "初步调查员",
        task: "在 Abstract 层进行文档路由，确定哪些文档与任务相关。返回相关文档列表和初步方向。",
        tools: ["kb_search", "think", "finish"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "语义深度检索",
        task: "根据初步调查结果，在 Structure 层用多个语义角度深度搜索相关章节。",
        tools: ["kb_search", "wiki_browse", "expand", "think", "finish"],
        dependsOn: ["agent-0"],
        sortOrder: 1,
      },
      {
        role: "精确检索",
        task: "根据初步调查结果，使用 grep 精确匹配关键术语和数据。",
        tools: ["grep", "glob", "read_file", "think", "finish"],
        dependsOn: ["agent-0"],
        sortOrder: 2,
      },
      {
        role: "验证报告员",
        task: "合并语义和精确检索结果，使用 expand 验证关键信息，生成最终分析报告。引用格式：[来源: {原始文件名} → {章节标题} (第X页)]",
        tools: ["kb_search", "wiki_browse", "expand", "write_file", "push_content", "think", "finish"],
        dependsOn: ["agent-1", "agent-2"],
        sortOrder: 3,
      },
    ],
  },
  {
    name: "通用并行检索",
    description: "通用并行检索模板：多个检索 Agent 并行搜索不同角度，汇总后输出结果。适合快速覆盖大量文档。",
    mode: "parallel",
    members: [
      {
        role: "语义检索员",
        task: "使用 kb_search 从多个语义角度搜索相关文档，用 expand 阅读关键文档的 L1 层内容。返回所有发现的文档和关键信息摘要。",
        tools: ["kb_search", "wiki_browse", "expand", "think", "finish"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "精确检索员",
        task: "使用 grep 和 kb_search 精确匹配关键词、编号、人名、数据，定位具体的文档段落。返回所有精确匹配结果及上下文。",
        tools: ["kb_search", "grep", "glob", "read_file", "think", "finish"],
        dependsOn: [],
        sortOrder: 1,
      },
      {
        role: "文档浏览员",
        task: "使用 wiki_browse 浏览知识库中所有文档的列表和摘要，识别与任务相关的所有文档。用 expand 展开有潜力的文档获取详细信息。返回完整的文档清单和每个文档的核心要点。",
        tools: ["wiki_browse", "expand", "kb_search", "think", "finish"],
        dependsOn: [],
        sortOrder: 2,
      },
    ],
  },
  // O5.5: No-hallucination analysis team — 3-stage graph pipeline with
  // strict citation discipline: multi-angle search → cross-verification → cited report
  {
    name: "零幻觉分析",
    description: "三阶段无幻觉分析流水线：多角度检索 → 交叉验证 → 引用报告。每一步强制要求来源标注，确保零幻觉输出。",
    mode: "graph",
    members: [
      {
        role: "多角度检索员",
        task: [
          "使用 kb_search 从至少 3 个不同的关键词角度搜索所有相关文档。",
          "对每个有价值的搜索结果，用 expand 展开阅读完整内容（L2 层）。",
          "同时使用 wiki_browse 浏览文档结构，确保不遗漏任何相关文档。",
          "输出要求：",
          "- 列出每个找到的文档，包含：标题、原始文件名、页码范围",
          "- 对每个文档提供关键摘录（直接引用原文）",
          "- 标注每个摘录的具体位置：[来源: 文件名 → 章节/页码]",
          "- 不要编造或推测任何信息",
          "- 如果某个角度搜索无结果，明确标注'该角度无结果'",
        ].join("\n"),
        tools: ["kb_search", "wiki_browse", "expand", "doc_grep", "push_content", "think", "finish"],
        dependsOn: [],
        sortOrder: 0,
      },
      {
        role: "交叉验证员",
        task: [
          "对多角度检索员提交的每个关键发现进行交叉验证：",
          "1. 使用 expand 重新展开阅读原始文档的相关段落",
          "2. 核对每条声明是否与原始文档内容一致",
          "3. 检查是否存在矛盾或遗漏的重要信息",
          "4. 对每条声明标注验证状态：已验证 / 部分验证 / 未验证 / 矛盾",
          "输出要求：",
          "- 每条验证结果必须附上原始文档的具体位置",
          "- 发现矛盾时，列出冲突的两个来源及其具体内容",
          "- 发现遗漏时，补充被遗漏的信息并标注来源",
          "- 给出整体准确度评估",
          "- 绝对不要基于模型记忆补充文档中不存在的内容",
        ].join("\n"),
        tools: ["kb_search", "wiki_browse", "expand", "doc_grep", "push_content", "think", "finish"],
        dependsOn: ["agent-0"],
        sortOrder: 1,
      },
      {
        role: "引用报告员",
        task: [
          "基于多角度检索和交叉验证的结果，生成最终分析报告。",
          "报告必须严格遵守以下规则：",
          "- 每个事实性陈述必须附有 [来源: 文件名 → 章节/页码] 引用",
          "- 推理结论必须标注 [推理]",
          "- 不确定的内容必须标注 [需验证]",
          "- 关键结论附置信度：[高]/[中]/[低]",
          "- 所有数字、日期、名称必须来自工具实际返回的数据",
          "- 如果某信息未在文档中找到，明确标注'文档中未提及'，不推测",
          "使用 write_file 保存报告，使用 push_content 推送到前端。在报告中用 [[doc:文档ID|文档名]] 标注所有引用的文档。",
          "报告结构：执行摘要 → 背景介绍 → 详细分析 → 关键发现 → 待解决问题",
        ].join("\n"),
        tools: ["kb_search", "wiki_browse", "expand", "write_file", "push_content", "think", "finish"],
        dependsOn: ["agent-0", "agent-1"],
        sortOrder: 2,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// AgentTeamManager
// ---------------------------------------------------------------------------

/**
 * High-level manager for agent teams. Wraps the PG-backed agent-team repo
 * and provides preset templates for quickly spinning up common team patterns.
 *
 * Usage:
 *   const manager = new AgentTeamManager();
 *   const team = await manager.createFromTemplate("研究管道", "我的研究项目");
 */
export class AgentTeamManager {
  // -----------------------------------------------------------------------
  // Delegated CRUD operations (async, backed by PG repo)
  // -----------------------------------------------------------------------

  /** Get a team by its unique ID. */
  async getTeam(teamId: string): Promise<AgentTeamWithMembers | undefined> {
    const repos = await getRepos();
    return repos.agentTeam.get(teamId);
  }

  /** Look up a team by its unique name. */
  async getTeamByName(name: string): Promise<AgentTeamWithMembers | undefined> {
    const repos = await getRepos();
    return repos.agentTeam.getByName(name);
  }

  /** List all teams (without members), ordered by most recently updated. */
  async listTeams(): Promise<AgentTeam[]> {
    const repos = await getRepos();
    return repos.agentTeam.list();
  }

  /** Create a new team with members. */
  async createTeam(data: CreateTeamData): Promise<AgentTeamWithMembers> {
    const repos = await getRepos();
    return repos.agentTeam.create(data);
  }

  /** Partially update a team (and optionally replace its members). */
  async updateTeam(teamId: string, data: UpdateTeamData): Promise<AgentTeamWithMembers | undefined> {
    const repos = await getRepos();
    return repos.agentTeam.update(teamId, data);
  }

  /** Delete a team by ID. Returns true if the team existed and was deleted. */
  async deleteTeam(teamId: string): Promise<boolean> {
    const repos = await getRepos();
    return repos.agentTeam.delete(teamId);
  }

  // -----------------------------------------------------------------------
  // Template API
  // -----------------------------------------------------------------------

  /**
   * Return all available preset templates. Each template describes a team
   * configuration (mode, members, etc.) that can be materialized via
   * {@link createFromTemplate}.
   */
  getTemplates(): TeamTemplate[] {
    return TEMPLATES;
  }

  /**
   * Find a template by its name.
   *
   * @param templateName - The `name` field of the template (e.g. "研究管道").
   * @returns The matching template, or `undefined` if not found.
   */
  getTemplate(templateName: string): TeamTemplate | undefined {
    return TEMPLATES.find((t) => t.name === templateName);
  }

  /**
   * Materialise a template into a persisted team.
   *
   * @param templateName - Name of the preset template to use.
   * @param customName   - Optional custom team name. If omitted the template
   *                       name is used as the team name.
   * @param extra        - Optional partial overrides applied on top of the
   *                       template data (e.g. custom description or model config).
   * @returns The newly created team with its members.
   * @throws Error if the template name does not match any preset.
   */
  async createFromTemplate(
    templateName: string,
    customName?: string,
    extra?: Partial<Pick<CreateTeamData, "description" | "modelConfig" | "enableSkills" | "crossReview">>,
  ): Promise<AgentTeamWithMembers> {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Unknown team template: "${templateName}". Available: ${TEMPLATES.map((t) => t.name).join(", ")}`);
    }

    const data: CreateTeamData = {
      name: customName ?? template.name,
      description: extra?.description ?? template.description,
      mode: template.mode,
      crossReview: extra?.crossReview ?? template.crossReview ?? false,
      enableSkills: extra?.enableSkills ?? false,
      modelConfig: extra?.modelConfig,
      members: template.members,
    };

    return this.createTeam(data);
  }

  /**
   * Create a team from a dynamic template (e.g. "跨库对比分析").
   * For templates with `dynamicGeneration: true`, members are generated at
   * runtime based on the provided parameters.
   *
   * @param templateName - Name of the dynamic template.
   * @param params       - Parameters for member generation.
   *                        For "跨库对比分析": `{ kbIds: string[], kbNames: Record<string, string> }`
   * @returns The newly created team with its members.
   */
  async createDynamicTeam(
    templateName: string,
    params: Record<string, unknown>,
  ): Promise<AgentTeamWithMembers> {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Unknown team template: "${templateName}". Available: ${TEMPLATES.map((t) => t.name).join(", ")}`);
    }

    if (!template.dynamicGeneration || !template.agentTemplate) {
      // Non-dynamic template, fall back to normal createFromTemplate
      return this.createFromTemplate(templateName);
    }

    const kbIds = params.kbIds as string[];
    const kbNames = params.kbNames as Record<string, string>;

    if (!Array.isArray(kbIds) || kbIds.length === 0) {
      throw new Error("Dynamic template requires kbIds array with at least one entry");
    }

    // Generate one member per KB
    const members: CreateTeamData["members"] = kbIds.map((kbId, i) => ({
      role: `${kbNames[kbId] || kbId} 检索员`,
      task: template.agentTemplate!.role
        .replace("{kbName}", kbNames[kbId] || kbId)
        .replace("{kbId}", kbId),
      tools: [...template.agentTemplate!.tools],
      dependsOn: [],
      sortOrder: i,
    }));

    // Add summary agent that depends on all KB agents
    if (template.summaryAgent) {
      members.push({
        role: template.summaryAgent.name,
        task: template.summaryAgent.role,
        tools: [...template.summaryAgent.tools],
        dependsOn: kbIds.map((_, i) => `agent-${i}`),
        sortOrder: kbIds.length,
      });
    }

    const data: CreateTeamData = {
      name: templateName,
      description: template.description,
      mode: template.mode,
      crossReview: false,
      enableSkills: false,
      members,
    };

    return this.createTeam(data);
  }
}
