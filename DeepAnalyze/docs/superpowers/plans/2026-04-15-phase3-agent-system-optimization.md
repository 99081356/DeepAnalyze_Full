# 阶段 3：Agent 系统优化

> **给执行代理的说明：** 必须使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 来逐步实施本计划。

**目标：** 更新 Agent 定义、Skills 和 Team 模板，使其充分利用三层架构、并行检索和锚点追溯能力。

**架构方案：** Agent 通过更新的系统提示词了解三层结构。新增 Skills 编码最优检索工作流。新增 Team 模板实现并行检索。报告生成使用锚点进行来源追溯。名称解析器确保面向用户的输出显示原始文件名。

**技术栈：** TypeScript，现有的 AgentRunner/WorkflowEngine/ToolRegistry 基础设施

**前置条件：** 阶段 0（PostgreSQL + Repository 层）、阶段 1（三层数据、锚点、检索器、名称解析器）

**设计规格：** `docs/superpowers/specs/2026-04-15-three-layer-architecture-redesign.md` 第 7 章

**冻结范围：** 图谱和正反向关联系统（linker.ts、l0-linker.ts、GraphTool）不修改，详见设计规格 1.4 节。不新增 Agent 类型，复用现有 AgentTeam + WorkflowEngine。

---

## 文件清单

| 操作 | 文件路径 | 职责说明 |
|------|---------|---------|
| 修改 | `src/services/agent/agent-definitions.ts` | 更新所有 Agent 类型的系统提示词 |
| 修改 | `src/services/skills/built-in-skills.ts` | 新增三层检索、表格分析、多模态检索技能 |
| 修改 | `src/services/agent/agent-team-manager.ts` | 新增并行检索 + 跨库对比 Team 模板 |
| 修改 | `src/wiki/knowledge-compound.ts` | 增强 compoundWithAnchors() 锚点溯源 |
| 修改 | `src/services/agent/agent-runner.ts` | 工具结果自动注入显示名称 |

---

## 任务 1：更新 Agent 系统提示词

**涉及文件：** `src/services/agent/agent-definitions.ts`

- [ ] **步骤 1：通读当前 agent-definitions.ts**

理解所有现有 Agent 类型的定义方式，特别是系统提示词的结构和变量插值方式。

- [ ] **步骤 2：更新 GENERAL_AGENT 提示词**

在系统提示词中新增以下章节（插入到现有提示词末尾、结束标记之前）：

```typescript
// 在 GENERAL_AGENT 的 systemPrompt 字段中追加：

`
## 数据层级
本系统使用三层文档架构：
- Abstract 层：文档摘要和目录大纲（极轻量，用于文档路由）
- Structure 层：DocTags/Markdown 格式的章节分块（检索主战场）
- Raw 层：DoclingDocument JSON 完整原始数据（按需访问）

## 检索工作流
1. 先用 kb_search 在 Abstract 层判断哪些文档相关
2. 在 Structure 层执行精准检索（BM25 + 向量融合）
3. 需要原始数据时使用 expandToRaw 获取 Raw 层内容
4. 可以使用 grep 工具在 Structure 层文件中精确搜索

## 引用规则
所有分析结果必须标注来源：
- 文件名（使用原始文件名，不是内部ID）
- 章节/页码
- 锚点ID（如果有）

## 信息验证
- 不要编造文档中不存在的信息
- 对关键数据，使用 expandToRaw 验证原文
`
```

- [ ] **步骤 3：更新 EXPLORE_AGENT 提示词**

在 EXPLORE_AGENT 的系统提示词中追加：

```typescript
`
## 检索策略
- 默认搜索 Structure 层（page_type='structure'），这是最精准的层级
- 使用多个查询角度（至少3个不同关键词/表述）全面覆盖
- 搜索完成后使用 expandToRaw 验证关键发现
- 注意搜索不同模态的文件（文档、Excel、图片描述、音频转写、视频场景）
`
```

- [ ] **步骤 4：更新 REPORT_AGENT 提示词**

在 REPORT_AGENT 的系统提示词中追加：

```typescript
`
## 报告引用格式
所有事实陈述必须引用来源，格式：
[来源: {原始文件名} → {章节标题} (第X页)]

示例：
华东地区Q1销售额为1250万元 [来源: 销售数据.xlsx → Sheet1:Q1销售 (表格1)]
项目采用微服务架构 [来源: 技术方案.pdf → 第二章 技术方案 (第6页)]

## 报告结构要求
1. 执行摘要（5条以内核心发现）
2. 详细分析（按主题分段，每段引用来源）
3. 数据支撑（引用具体数值，标注来源表格）
4. 信息来源清单（所有引用的文件 + 章节 + 锚点ID）

## 多模态引用
- Excel 表格：标注 Sheet 名和表格编号
- 音频：标注发言者和时间范围
- 视频：标注场景编号和时间范围
- 图片：标注图片描述和文件名
`
```

- [ ] **步骤 5：更新 COORDINATOR_AGENT 提示词**

在 COORDINATOR_AGENT 的系统提示词中追加：

```typescript
`
## 子任务类型
检索子任务可分配为以下类型：
- 语义检索：kb_search + wiki_browse，适用于概念性搜索
- 精确搜索：grep + glob + read_file，适用于术语/编号/数据精确查找
- 表格分析：kb_search + expand，适用于数据统计和表格内容分析
- 多模态检索：跨文档/Excel/音频/视频搜索，每种模态使用对应检索策略

## 团队模板选择
- 简单查询：单 Agent 深度检索
- 复杂查询：并行深度检索团队（语义+精确并行）
- 跨库对比：跨库对比分析团队（每个知识库一个成员）
- 全面分析：全面深度分析团队（4 Agent graph 模式）
`
```

- [ ] **步骤 6：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 7：提交**
```bash
git add src/services/agent/agent-definitions.ts
git commit -m "feat: 更新所有 Agent 系统提示词，适配三层架构和多模态"
```

---

## 任务 2：新增 Skills — 三层检索 + 表格分析 + 多模态检索

**涉及文件：** `src/services/skills/built-in-skills.ts`

- [ ] **步骤 1：通读当前 built-in-skills.ts**

理解现有 Skill 的定义格式（name, systemPrompt, tools, maxTurns, variables 等字段）。

- [ ] **步骤 2：新增"三层递进检索"技能**

```typescript
{
  name: '三层递进检索',
  description: '使用 Abstract→Structure→Raw 三层递进策略进行深度检索',
  systemPrompt: `你是一个专业的文档检索分析师。请按照以下三层递进策略完成任务：

## 第一层：文档路由
1. 使用 kb_search 搜索 Abstract 层，确定哪些文档与问题相关
2. 记录相关文档的标题和摘要

## 第二层：精准检索
1. 在 Structure 层用多个关键词搜索（至少3个不同角度）
2. 使用 wiki_browse 浏览相关章节的完整内容
3. 使用 grep 对关键术语进行精确搜索
4. 合并结果，去重并记录锚点ID

## 第三层：验证与补充
1. 对关键信息使用 expandToRaw 验证原始内容
2. 检查是否遗漏了重要表格、数据
3. 确认所有引用的准确性

## 输出要求
- 列出所有发现，标注来源文件名 + 章节 + 页码
- 标注信息置信度（高/中/低）
- 如有矛盾信息，明确指出`,
  tools: ['kb_search', 'wiki_browse', 'expand', 'grep', 'think', 'finish'],
  maxTurns: 25,
  variables: [
    { name: 'topic', required: true, description: '要检索的主题或问题' },
  ],
}
```

- [ ] **步骤 3：新增"表格专项分析"技能**

```typescript
{
  name: '表格专项分析',
  description: '定位并深度分析文档中的表格数据',
  systemPrompt: `你是一个专业的数据分析专家。请按照以下步骤完成表格分析任务：

## 步骤 1：定位表格
- 使用 kb_search 搜索包含表格关键词的 Structure 页面
- 优先搜索 Excel 文件（modality=excel）

## 步骤 2：浏览 Structure 层
- 使用 wiki_browse 查看相关 Structure 页面的 Markdown 表格内容
- 识别表格的行列结构和数据范围

## 步骤 3：读取 Raw 层
- 使用 expandToRaw 获取表格的完整单元格数据
- 获取合并单元格、公式等结构化信息

## 步骤 4：执行分析
- 根据任务要求进行数据统计、对比、趋势分析
- 所有数据引用标注单元格范围：如 [Sheet1!A1:C10]

## 输出要求
- 分析结论
- 关键数据点（标注来源表格和单元格范围）
- 如有计算过程，列出计算步骤`,
  tools: ['kb_search', 'wiki_browse', 'expand', 'bash', 'think', 'finish'],
  maxTurns: 20,
  variables: [
    { name: 'task', required: true, description: '分析任务描述' },
    { name: 'targetFile', required: false, description: '目标文件名（可选，缩小搜索范围）' },
  ],
}
```

- [ ] **步骤 4：新增"多模态综合检索"技能**

```typescript
{
  name: '多模态综合检索',
  description: '跨模态搜索文档、图片、音频、视频内容',
  systemPrompt: `你是一个多模态信息检索专家。请跨模态搜索相关信息：

## 检索策略
不同模态采用不同的深入策略：

### 文档/Excel
- kb_search 语义搜索 + grep 精确搜索
- Structure 层查看章节/表格内容

### 图片
- 搜索图片描述文本（modality=image）
- 查看视觉描述和 OCR 提取的文本

### 音频
- 搜索音频转写文本（modality=audio）
- 查看发言者分段和对话内容

### 视频
- 搜索视频场景描述（modality=video）
- 查看关键帧描述和对话转写

## 交叉验证
- 跨模态信息相互印证
- 同一主题在不同模态中的表述可能不同
- 标注每条信息的模态来源

## 输出要求
- 按主题组织发现，标注每条来源的模态
- 列出跨模态交叉验证的结果
- 标注信息完整度（哪些模态有覆盖、哪些没有）`,
  tools: ['kb_search', 'wiki_browse', 'expand', 'grep', 'think', 'finish'],
  maxTurns: 30,
  variables: [
    { name: 'topic', required: true, description: '要跨模态检索的主题' },
  ],
}
```

- [ ] **步骤 5：更新现有"深度文档分析"技能**

找到现有的深度文档分析 Skill，在系统提示词末尾追加：

```typescript
`
## 三层验证
完成初步分析后：
1. 对关键发现使用 expandToRaw 查看原始数据验证
2. 引用格式：[来源: {原始文件名} → {章节标题} (第X页)]
3. 列出所有引用的锚点ID
`
```

- [ ] **步骤 6：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 7：提交**
```bash
git add src/services/skills/built-in-skills.ts
git commit -m "feat: 新增三层递进检索、表格专项分析、多模态综合检索技能"
```

---

## 任务 3：新增 Team 模板 — 并行检索 + 跨库对比

**涉及文件：** `src/services/agent/agent-team-manager.ts`

- [ ] **步骤 1：通读当前 agent-team-manager.ts**

理解现有 Team 模板的定义格式（mode, agents, dependsOn 等字段）。

- [ ] **步骤 2：新增"并行深度检索"团队**

```typescript
// graph 模式：agent-0 和 agent-1 并行，agent-2 汇总
{
  name: '并行深度检索',
  mode: 'graph',
  description: '语义检索和精确检索并行执行，汇总分析师合并结果',
  agents: [
    {
      id: 'agent-0',
      name: '语义检索员',
      role: '使用 kb_search 从多个语义角度进行检索，收集相关 Structure 页面内容。',
      tools: ['kb_search', 'wiki_browse', 'expand', 'think', 'finish'],
      dependsOn: [],
    },
    {
      id: 'agent-1',
      name: '精确检索员',
      role: '使用 grep 精确匹配关键词、编号、数据，定位精确的文档段落。',
      tools: ['grep', 'glob', 'read_file', 'think', 'finish'],
      dependsOn: [],
    },
    {
      id: 'agent-2',
      name: '汇总分析师',
      role: '合并语义检索和精确检索的结果，使用 expandToRaw 验证关键信息，生成最终分析报告。引用格式：[来源: {原始文件名} → {章节标题} (第X页)]',
      tools: ['kb_search', 'wiki_browse', 'expand', 'report_generate', 'think', 'finish'],
      dependsOn: ['agent-0', 'agent-1'],
    },
  ],
}
```

- [ ] **步骤 3：新增"跨库对比分析"团队**

```typescript
// parallel 模式：动态生成成员
{
  name: '跨库对比分析',
  mode: 'parallel',
  description: '每个知识库分配一个成员，各自在自己的 KB 范围内检索，最后汇总对比',
  dynamicGeneration: true, // 运行时根据用户选择的 KB 数量动态创建成员
  agentTemplate: {
    role: '在知识库 {kbName} (ID: {kbId}) 中搜索相关信息。使用 kb_search 检索 Structure 层，浏览相关章节内容，提取关键数据。',
    tools: ['kb_search', 'wiki_browse', 'expand', 'think', 'finish'],
  },
  // 汇总 Agent
  summaryAgent: {
    name: '对比分析师',
    role: '汇总所有知识库的检索结果，进行跨库对比分析。标注每个发现来自哪个知识库的哪个文档。',
    tools: ['kb_search', 'wiki_browse', 'expand', 'report_generate', 'think', 'finish'],
  },
}
```

注意：`dynamicGeneration` 和 `summaryAgent` 是新增字段。`agentTemplate` 中的 `{kbName}` 和 `{kbId}` 在运行时注入。实现时需在 `agent-team-manager.ts` 中添加动态团队创建逻辑。

- [ ] **步骤 4：新增"全面深度分析"团队**

```typescript
// graph 模式：4 Agent 增强版
{
  name: '全面深度分析',
  mode: 'graph',
  description: '4 Agent graph 模式：初步调查 → 语义+精确并行检索 → 验证报告',
  agents: [
    {
      id: 'agent-0',
      name: '初步调查员',
      role: '在 Abstract 层进行文档路由，确定哪些文档与任务相关。返回相关文档列表和初步方向。',
      tools: ['kb_search', 'think', 'finish'],
      dependsOn: [],
    },
    {
      id: 'agent-1',
      name: '语义深度检索',
      role: '根据初步调查结果，在 Structure 层用多个语义角度深度搜索相关章节。',
      tools: ['kb_search', 'wiki_browse', 'expand', 'think', 'finish'],
      dependsOn: ['agent-0'],
    },
    {
      id: 'agent-2',
      name: '精确检索',
      role: '根据初步调查结果，使用 grep 精确匹配关键术语和数据。',
      tools: ['grep', 'glob', 'read_file', 'think', 'finish'],
      dependsOn: ['agent-0'],
    },
    {
      id: 'agent-3',
      name: '验证报告员',
      role: '合并语义和精确检索结果，使用 expandToRaw 验证关键信息，生成最终分析报告。引用格式：[来源: {原始文件名} → {章节标题} (第X页)]',
      tools: ['kb_search', 'wiki_browse', 'expand', 'report_generate', 'think', 'finish'],
      dependsOn: ['agent-1', 'agent-2'],
    },
  ],
}
```

- [ ] **步骤 5：运行动态团队创建逻辑**

在 `agent-team-manager.ts` 中新增 `createDynamicTeam()` 方法：

```typescript
/**
 * 根据模板动态创建团队
 * 对于 dynamicGeneration=true 的模板（如跨库对比），根据参数动态生成成员
 */
createDynamicTeam(templateName: string, params: Record<string, unknown>): AgentTeam {
  const template = this.templates.find(t => t.name === templateName);
  if (!template) throw new Error(`Team template "${templateName}" not found`);

  if (template.dynamicGeneration && template.agentTemplate) {
    // 跨库对比：为每个 KB 创建一个成员
    const kbIds = params.kbIds as string[];
    const kbNames = params.kbNames as Record<string, string>;
    const agents = kbIds.map((kbId, i) => ({
      id: `agent-${i}`,
      name: `${kbNames[kbId] || kbId} 检索员`,
      role: template.agentTemplate!.role
        .replace('{kbName}', kbNames[kbId] || kbId)
        .replace('{kbId}', kbId),
      tools: [...template.agentTemplate!.tools],
      dependsOn: [],
    }));

    // 添加汇总 Agent
    if (template.summaryAgent) {
      agents.push({
        id: `agent-${kbIds.length}`,
        name: template.summaryAgent.name,
        role: template.summaryAgent.role,
        tools: template.summaryAgent.tools,
        dependsOn: kbIds.map((_, i) => `agent-${i}`),
      });
    }

    return { name: template.name, mode: template.mode, agents };
  }

  // 非动态模板，直接使用预定义 agents
  return { name: template.name, mode: template.mode, agents: template.agents! };
}
```

- [ ] **步骤 6：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 7：提交**
```bash
git add src/services/agent/agent-team-manager.ts
git commit -m "feat: 新增并行检索、跨库对比、全面深度分析 Team 模板"
```

---

## 任务 4：增强知识复合 — 锚点级来源追溯

**涉及文件：** `src/wiki/knowledge-compound.ts`、`src/services/agent/agent-runner.ts`

- [ ] **步骤 1：通读当前 knowledge-compound.ts**

理解现有的 `compoundWithTracing()` 方法的输入参数、输出格式和来源追溯逻辑。

- [ ] **步骤 2：新增 compoundWithAnchors() 方法**

在 `knowledge-compound.ts` 中新增方法：

```typescript
/**
 * 锚点级来源追溯（替代页面级追溯的增强版）
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
    role: 'supporting' | 'contradicting' | 'referenced';
  }>,
): string | null {
  if (anchors.length === 0) return null;

  // 按文档分组
  const byDoc = new Map<string, typeof anchors>();
  for (const a of anchors) {
    const existing = byDoc.get(a.docId) || [];
    existing.push(a);
    byDoc.set(a.docId, existing);
  }

  // 计算置信度
  const supportingCount = anchors.filter(a => a.role === 'supporting').length;
  const confidence = supportingCount >= 3 ? '高' : supportingCount >= 1 ? '中' : '低';

  // 生成复合内容
  const sections: string[] = [];

  sections.push(`## 来源溯源（锚点级）`);
  sections.push(`**置信度:** ${confidence}（${supportingCount} 个独立来源）`);
  sections.push('');

  for (const [docId, docAnchors] of byDoc) {
    const docName = docAnchors[0].originalName;
    sections.push(`### ${docName}`);

    for (const a of docAnchors) {
      const location = [
        a.sectionTitle,
        a.pageNumber != null ? `第${a.pageNumber}页` : null,
      ].filter(Boolean).join(' → ');

      const roleLabel = {
        supporting: '支持',
        contradicting: '矛盾',
        referenced: '引用',
      }[a.role];

      sections.push(`- [${roleLabel}] ${location} (锚点: ${a.anchorId})`);
    }
    sections.push('');
  }

  sections.push('---');
  sections.push(`**元数据:** agentType=${agentType}, 来源数量=${anchors.length}, 置信度=${confidence}`);

  return sections.join('\n');
}
```

- [ ] **步骤 3：更新 AgentRunner 自动复合逻辑**

在 `src/services/agent/agent-runner.ts` 中，找到 `collectAccessedPages()` 或类似的来源收集逻辑（约第 365 行附近）。

当 `accessedPages` 中有锚点数据时，调用 `compoundWithAnchors()` 替代 `compoundWithTracing()`：

```typescript
// 在 Agent 执行完成后的复合逻辑中：
import { compoundWithAnchors, compoundWithTracing } from '../wiki/knowledge-compound';

// 检查是否有锚点数据
const anchorData = accessedPages
  .filter(p => p.anchorId)
  .map(p => ({
    anchorId: p.anchorId!,
    docId: p.docId,
    originalName: p.originalName ?? p.docId,
    sectionTitle: p.sectionTitle ?? null,
    pageNumber: p.pageNumber ?? null,
    role: 'supporting' as const,
  }));

let compound: string | null;
if (anchorData.length > 0) {
  compound = compoundWithAnchors(kbId, agentType, input, output, anchorData);
} else {
  // 回退到旧的页面级追溯
  compound = compoundWithTracing(kbId, agentType, input, output, accessedPages);
}
```

- [ ] **步骤 4：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 5：提交**
```bash
git add src/wiki/knowledge-compound.ts src/services/agent/agent-runner.ts
git commit -m "feat: 知识复合增强为锚点级来源追溯，支持置信度评估"
```

---

## 任务 5：工具结果注入显示名称

**涉及文件：** `src/services/agent/agent-runner.ts`

- [ ] **步骤 1：通读 AgentRunner 中工具结果处理逻辑**

找到 `collectAccessedPages()` 方法和工具结果后处理的位置。理解当前如何收集 pageId、title 等信息。

- [ ] **步骤 2：创建 DisplayResolver 实例**

在 AgentRunner 中创建 DisplayResolver 的延迟初始化实例（Phase 1 任务 5 已实现 DisplayResolver）：

```typescript
import { DisplayResolver } from '../services/display-resolver';

// 在 AgentRunner 类中
private displayResolver: DisplayResolver | null = null;

private async getDisplayResolver(): Promise<DisplayResolver> {
  if (!this.displayResolver) {
    this.displayResolver = new DisplayResolver();
  }
  return this.displayResolver;
}
```

- [ ] **步骤 3：在 collectAccessedPages 中收集 originalName 和 kbName**

修改 `collectAccessedPages()` 方法，在收集 pageId 和 title 的同时，查询并存储 `originalName` 和 `kbName`：

```typescript
// 在 collectAccessedPages() 中，获取页面信息后：
const resolver = await this.getDisplayResolver();
const displayInfo = await resolver.resolve(page.docId);
// 将 displayInfo.originalName 和 displayInfo.kbName 存入 accessedPage 记录
```

- [ ] **步骤 4：注入到工具结果**

对 kb_search、wiki_browse、expand 三个工具的返回结果，在返回给 Agent 之前注入 `originalName` 和 `kbName` 字段：

```typescript
// 在工具结果后处理中（可能是 afterToolCall 或结果格式化处）
if (['kb_search', 'wiki_browse', 'expand'].includes(toolName)) {
  // 解析结果中的 docId
  const docIds = extractDocIdsFromResult(result);
  if (docIds.length > 0) {
    const resolver = await this.getDisplayResolver();
    const displayMap = await resolver.resolveBatch(docIds);
    // 注入到结果 JSON 中
    result = injectDisplayNames(result, displayMap);
  }
}
```

这样 LLM 在处理工具返回结果时就能看到原始文件名，而非内部 UUID。

- [ ] **步骤 5：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 6：提交**
```bash
git add src/services/agent/agent-runner.ts
git commit -m "feat: Agent 工具结果自动注入原始文件名和知识库名称"
```

---

## 执行顺序

任务 1-3 可并行（独立的提示词/技能/模板更新）。
任务 4 依赖阶段 1 的锚点系统（AnchorRepo + AnchorGenerator）。
任务 5 依赖阶段 1 的名称解析器（DisplayResolver）。

```
任务 1（提示词）──────┐
任务 2（技能）───────┼── 可并行执行
任务 3（团队模板）───┘
任务 4（知识复合）─── 依赖阶段 1 锚点系统
任务 5（显示注入）─── 依赖阶段 1 名称解析器
```

任务 1、2、3 无外部依赖，可立即开始。
任务 4、5 依赖阶段 1 完成，但彼此之间可并行。
