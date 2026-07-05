# Skills 系统重构设计

> 日期：2026-05-07
> 目标：合并重叠 Skills、厘清 Skill 与 Plugin 边界、修正层级引导错误、优化输出引导策略

---

## 一、当前问题诊断

### 1.1 两套 Skill 系统并存

| 系统 | 表 | 定义文件 | 调用方式 | 可被子Agent调用 |
|------|-----|---------|---------|---------------|
| Agent Skills | `agent_skills` | `builtin-skills.ts` | `skill_invoke` 工具 | 是（通过 skill_invoke → agent-runner 子Agent） |
| Plugin Skills | `skills` | `skills/built-in-skills.ts` | 前端 SkillBrowser / API | **否** |

问题：两套系统功能大量重叠，且 Plugin Skills 无法被 Agent 在分析过程中自动发现和调用。

### 1.2 Skill 与 Plugin 边界混淆

当前状况：13 个 Plugin Skills 中大量包含"报告生成"、"全面分析"等重型分析流程，但**通用场景的日常分析不应该总是生成报告**。

正确理解（参考 Claude Code 设计）：
- **Skill**：轻量级场景经验，是一组特定场景下的最佳实践提示词 + 工具组合。如同一个经验丰富的助手在不同场景下的"做事诀窍"
- **Plugin**：重量级领域模块，包含一组相关的 Skills + 自定义 Agents + 领域特定工具 + 专属配置。如公检法分析需要完整的证据链、时间线、实体网络、交叉验证等一整套能力

当前 `plugins/judicial-analysis/` 已有正确的 Plugin 结构，但通用 Skills 中混入了大量"报告生成"、"全面分析"等本应属于特定场景的能力。

### 1.3 输出引导问题

多个 Skill 硬性规定"8000-20000字"，导致：
- 简单问题被过度展开
- 复杂问题可能仍然不够
- 模型为凑字数而注水

应改为**自适应深度引导**：根据问题复杂度和发现的信息量自然决定输出深度。

### 1.4 层级引导错误

多个 Skill 和 workflow 子Agent 指令中错误描述了层级关系：

**当前错误引导**（出现在"全面分块分析"、"全面知识库分析"等 Skill 中）：
```
- PDF/DOCX：L1 已包含完整全文，L2 与 L1 完全相同，展开到 L2 是浪费
```

**正确理解**（根据需求文档 C-07~C-12）：
- **L0 (Abstract)**：文档摘要+标签+类型，极轻量，用于文档路由
- **L1 (Structure)**：DocTags/Markdown 格式的章节分块，**Agent 分析工作的主要层级**
- **L2 (Raw)**：Docling 解析的完整结构化 JSON，包含坐标、锚点、表格结构、阅读顺序等原始信息

**关键区别**：
- PDF/DOCX：L1 的 Markdown 是 LLM 友好的可读文本，L2 是 Docling JSON 结构化数据。两者**内容覆盖范围相同但格式不同**。L1 适合阅读和分析，L2 适合精确定位、锚点校验、结构信息提取
- 图片：L1 包含 VLM 视觉描述 + OCR 文本（预编译），L2 是原始 Docling JSON
- 音频：L1 包含转写文本（按说话者分组），L2 是原始 JSON
- 视频：L1 包含场景描述+转写，L2 是原始 JSON
- Excel 小表格：L1/L2 都有内容，L1 更适合阅读
- Excel 大表格：L1 为元数据描述，L2 是原始 CSV，**大表格应用 bash+pandas 分析源文件**

**Agent 工作原则**：
- 分析阅读 → 优先用 L1（Markdown/DocTags）
- 精确校验、锚点溯源、结构定位 → 用 L2
- 日常工作流默认 L1 即可

---

## 二、重构方案

### 2.1 统一 Skill 存储到 `agent_skills` 表

**方案**：将所有通用 Skill 统一注册到 `agent_skills` 表（通过 `ensureBuiltinSkills`），删除 `src/services/skills/built-in-skills.ts`。

理由：
1. `skill_invoke` 工具查的是 `agent_skills` 表 → Agent 可自动发现和调用
2. `agent_skills` 表已有 `antiHallucinationLevel`、`testScenarios` 等高级字段
3. `skills` 表是 `plugins` 系统的一部分，通用 Skill 不应放在插件表中

**前端改造**：`SkillBrowser` 组件改为读取 `agent_skills` 表（复用已有 API `/api/agent-skills`）。

### 2.2 Skill 与 Plugin 分离

| 层级 | 职责 | 示例 |
|------|------|------|
| **通用 Skills** | 场景化的轻量级经验指导，由主Agent/子Agent按需调用 | 深度检索、文档摘要、对比分析、精确问答 |
| **领域 Plugins** | 完整的垂直领域能力包，含多个 Skills + Agents + 配置 | judicial-analysis（证据链、时间线、实体网络、交叉验证、案件分析） |

**关键区别**：
- Skill 是单文件级别的经验指导，不包含 workflow_run 编排逻辑
- Plugin 可以包含多个 Skill、自定义 Agent、领域配置，形成一个完整的领域方案

### 2.3 弹性轮次控制（不设硬性 maxTurns）

**当前架构已具备弹性控制能力**：

```
AgentRunner 轮次控制链：
1. maxTurns = -1 → estimateTaskComplexity() 动态计算 minTurns
2. ProgressTracker: minTurns 保底 + checkpoint 渐进检查
3. 有进展 → 自动延长（checkpointInterval +10，最大50）
4. 无进展 → 引导换策略（连续3次无进展才建议收尾）
5. hardLimit = advisoryLimit × 5（至少200），真正的硬上限
```

**问题**：当前 Plugin Skills 中的 `maxTurns: 20/30/40/50/60` 是硬性约束，传给 `agent-runner` 后成为 `advisoryLimit`，虽然 ProgressTracker 会扩展，但初始值太低会压缩复杂任务的执行空间。

**方案**：所有 Skill **不设置 maxTurns 字段**（或设为 -1），统一使用 `estimateTaskComplexity` 动态计算。Skill 的定位是经验指导，不是执行约束。

**具体改动**：
- `builtin-skills.ts` 中的 Skill 定义：删除 `maxTurns` 字段（或全部设为 `-1`）
- `skill_invoke` 调用时：`maxTurns: undefined`（而非当前的 `agentSettings.subAgentMaxTurns`），让 agent-runner 自动计算
- 保留 `agentSettings.subAgentMaxTurns` 作为全局默认值（用于 workflow_run 子Agent），但 skill_invoke 不硬性传递

**参考**：Claude Code 不限制 Skill 执行轮数——Agent 按需工作，完成任务为止。

### 2.3 关于"报告生成"的处理

**当前问题**：多个通用 Skill 都包含 `report_generate` 步骤，导致通用分析任务总在生成报告。

**正确原则**：
- 通用 Agent 默认直接在对话中流式输出分析结果（已在 GENERAL_AGENT 中体现）
- **仅在用户明确要求"生成报告"、"保存分析"、"写一份报告"时**才调用 `report_generate`
- 通用 Skill 不应内置报告生成步骤，而是引导 Agent 完成分析后直接输出

**保留独立的"报告生成" Skill**：用于用户明确需要生成结构化报告时调用，作为一个专门的输出格式化技能。

### 2.4 "全面知识库分析"类 Skill 的处理

当前"全面分块分析"、"全面知识库分析"、"深度知识库分析"三个 Skill 的本质是**编排流程**（workflow_run parallel），不是轻量级经验指导。

**方案**：合并为一个 Skill `全面知识库分析`，保留完整的编排能力。这个 Skill 是特殊的编排型 Skill，允许包含 workflow_run 调度逻辑。

---

## 三、合并后最终 Skill 清单

### 3.1 通用 Skills（`agent_skills` 表，`ensureBuiltinSkills` 注册）

> **所有 Skill 不设 maxTurns 硬性约束**，统一使用 `estimateTaskComplexity` 动态计算 + `ProgressTracker` 弹性管理。

| # | 名称 | 类别 | 来源 | 变化 |
|---|------|------|------|------|
| 1 | `deep-research` | 研究 | Agent | **增强**：吸收"深度调研"+"深度文档分析"的最佳实践 |
| 2 | `chunked-analysis` | 分析 | Agent | **保留**：分组分析方法论 |
| 3 | `precise-qa` | QA | Agent | **保留**：GAIA 优化的精确问答 |
| 4 | `全面知识库分析` | 编排 | 合并 | **新**：融合"全面分块分析"+"全面知识库分析"+"深度知识库分析" |
| 5 | `深度检索` | 检索 | 合并 | **新**：融合"三层递进检索"+"多模态综合检索" |
| 6 | `报告生成` | 输出 | Plugin→Agent | **迁移**：从 Plugin Skills 迁入，修正引用格式 |
| 7 | `长篇写作` | 编排 | Plugin→Agent | **迁移**：从 Plugin Skills 迁入 |
| 8 | `文档摘要` | 分析 | Plugin→Agent | **迁移**：轻量摘要 |
| 9 | `对比分析` | 分析 | Plugin→Agent | **迁移**：多文档对比 |
| 10 | `表格专项分析` | 分析 | Plugin→Agent | **迁移**：表格分析 |
| 11 | `实体提取` | 提取 | Plugin→Agent | **迁移**：命名实体提取 |

### 3.2 被合并/吸收的 Skill

| 被吸收的 Skill | 去向 | 吸收的关键优化点 |
|----------------|------|----------------|
| `深度调研` | → `deep-research` | timeline_build/graph_build 使用指导、report_generate 流程 |
| `深度文档分析` | → `deep-research` | 三层验证流程、push_content 双输出 |
| `全面分块分析` | → `全面知识库分析` | workflow_run 分派流程、子Agent输出管理、层级选择指南 |
| `全面知识库分析`（旧） | → `全面知识库分析`（新） | 按类型分类策略 |
| `深度知识库分析` | → `全面知识库分析` | strict 级反幻觉规则 → 设为该 Skill 的 antiHallucinationLevel |
| `三层递进检索` | → `深度检索` | L0→L1→L2 递进方法论 |
| `多模态综合检索` | → `深度检索` | 跨模态搜索策略 |

### 3.3 司法 Plugin（保持独立）

`plugins/judicial-analysis/` 保持不变，包含 6 个司法领域 Skill + 2 个司法 Agent。`plugins/justice/` 是旧版本，可清理。

---

## 四、核心 Skill 设计详情

### 4.1 `deep-research`（增强版）

**定位**：通用深度分析和研究方法论——不限于知识库，也支持外网搜索。

**关键改动**：
- 删除硬性"8000-20000字"要求 → 改为自适应深度引导
- 吸收"深度文档分析"的三层验证流程
- 吸收"深度调研"的 timeline_build/graph_build 使用指导
- 加入正确的层级使用引导（L1 分析为主，L2 校验）
- **不内置 report_generate**——分析结果直接流式输出，用户要求时再生成报告

**prompt 核心结构**：
```
# 深度研究方法论

## 研究流程
1. 规划阶段：分析问题维度，确定检索策略
2. 广泛搜索：多角度多工具搜索
3. 深度获取：expand 展开关键内容（L1 为主）
4. 交叉验证：多来源印证关键数据
5. 综合输出：详尽完整的分析结果

## 自适应深度引导
- 根据问题复杂度和发现的信息量自然决定输出深度
- 简单问题简明回答，复杂问题详尽展开
- 核心标准：充分回答用户问题，不多不少，无遗漏无幻觉
- 判断依据：如果分析中发现了需要展开的发现点，展开它；如果信息已充分，简洁总结即可
- 不要为了凑篇幅而注水，也不要在需要详尽分析的地方压缩输出

## 层级使用原则
- 分析阅读 → expand 到 L1（Markdown/DocTags，LLM 友好）
- 精确校验/锚点溯源/结构定位 → expand 到 L2（原始 JSON）
- 日常工作默认 L1 即可
- 图片描述已在入库时预编译到 L1，优先用 expand 获取

## 工具选择
- 知识库内搜索：kb_search + wiki_browse + expand + doc_grep
- 外网信息：web_search + web_fetch + wikipedia
- 时间线/关系图：timeline_build / graph_build（当涉及时间事件或实体关系时）
- 输出方式：分析结论直接流式文字输出（用户实时可见）

${getAntiHallucinationSection("standard")}
${getOutputFormatSection()}
${getLanguageRule()}
```

### 4.2 `全面知识库分析`（合并版）

**定位**：编排型 Skill——对知识库中的大量文档进行分类、并行分派子Agent深度分析、合成完整报告。

**与 deep-research 的区别**：
- `deep-research`：自身执行的深度分析（单 Agent）
- `全面知识库分析`：编排多个子 Agent 并行执行（workflow_run），适用于文档数量大、需要全量覆盖的场景

**prompt 核心结构**：
```
# 全面知识库分析

## 核心原则
- 每个子Agent有独立完整上下文窗口，详尽完成负责部分
- 覆盖全部文档，不遗漏
- 事实性声明必须标注来源

## 工作流程

### 第一步：知识库总览
wiki_browse(listDocuments=true) 获取完整文档列表（docId、文件名、类型、L0摘要）。

### 第二步：制定分组计划
根据文档自然属性分组（类型、目录、主题），每组5-20个文档，3-8组。

### 第三步：并行分派子Agent
使用 workflow_run(mode="parallel") 分派。

每个子Agent task 必须包含：
- 文档列表（docId + 文件名）+ kbId
- 分析要求 + 输出格式
- 层级选择引导：分析阅读用 L1，校验用 L2
- 图片：expand L1 获取预编译描述，按需调用 VLM 补充
- 反幻觉要求：来源标注、禁止编造、区分推理
- 输出管理：write_file 保存详细结果，文本输出仅摘要+文件路径

### 第四步：合成
1. push_content 推送各子Agent分析文件到前端
2. 基于摘要写跨分块关联分析（直接文字输出）
3. report_generate 保存综合报告

### 第五步：完成
调用 finish 结束。

## 自适应深度引导
（同 deep-research 的自适应引导，不硬性规定字数）
```

**antiHallucinationLevel**: `strict`（从"深度知识库分析"继承）

### 4.3 `深度检索`（合并版）

**定位**：融合三层递进检索 + 跨模态搜索的专门检索方法论。

**prompt 核心结构**：
```
# 深度检索方法论

## 第一层：文档路由（L0）
用 kb_search 搜索 Abstract 层，确定相关文档范围。

## 第二层：精准检索（L1 Structure）
在 L1 层多角度搜索（至少3个不同关键词），doc_grep 精确匹配，expand 展开关键内容。
L1 是 Markdown/DocTags 格式，是分析和检索的主要层级。

## 第三层：校验与补充（L2 Raw）
对关键信息 expand 到 L2 验证原始数据、锚点、结构信息。
L2 是 Docling JSON，包含坐标、页码、完整结构化数据。

## 跨模态策略
- 文档/PDF：L1 检索为主，L2 校验
- 图片：L1 含 VLM 描述+OCR，按需调用 VLM 补充
- 音频：L1 含转写文本（按说话者分组）
- 视频：L1 含场景描述+转写
- Excel：小表格 L1 查看内容，大表格 bash+pandas 分析源文件

## 输出要求
- 列出所有发现，标注来源文件名+层级+位置
- 标注信息置信度
- 矛盾信息明确指出
```

### 4.4 其他迁移 Skill 的改动要点

**通用改动**（所有从 Plugin Skills 迁入的 Skill）：
1. 去掉硬性字数/篇幅要求，改为自适应引导
2. 修正层级引导：L1 分析为主，L2 校验
3. 加入 `antiHallucinationLevel` 字段
4. 加入 `${getAntiHallucinationSection()}`、`${getOutputFormatSection()}`、`${getLanguageRule()}` 模板函数

**各 Skill 具体调整**：

| Skill | 调整 |
|-------|------|
| `报告生成` | 修正引用格式模板，加入层级引导，**不内置到其他 Skill 中，仅用户明确要求时调用** |
| `长篇写作` | 修正层级引导，基本无其他改动 |
| `文档摘要` | 轻量 Skill，基本无改动，迁移即可 |
| `对比分析` | 基本无改动，迁移即可 |
| `表格专项分析` | 修正层级引导：L1 查看 Markdown 表格内容，大表格用 bash+pandas |
| `实体提取` | 基本无改动，迁移即可 |

---

## 五、层级引导修正（全局）

### 当前错误（需修正的位置）

1. **"全面分块分析" prompt** 第371-376行：
   ```
   - PDF/DOCX 文本：expand 到 L1 即可（L1 已包含完整全文，L2 与 L1 完全相同，展开到 L2 是浪费）
   ```
   **修正为**：
   ```
   - PDF/DOCX：分析阅读用 expand L1（Markdown格式），精确校验和锚点溯源用 L2（原始结构化JSON）
   ```

2. **"全面知识库分析"（旧）prompt** 第505-510行：
   ```
   - PDF/DOCX 文本：expand 到 L1 即可（L1 已包含完整全文，L2 与 L1 完全相同）
   ```
   **修正为**：同上

3. **expand 工具描述**（tool-setup.ts 第363行）：
   ```
   - PDF/DOCX：L1 包含完整全文（Markdown），与 L2 内容相同，分析时只看 L1 即可
   ```
   **修正为**：
   ```
   - PDF/DOCX：L1 为 Markdown/DocTags 格式的章节分块，适合分析和阅读；L2 为 Docling JSON 原始结构化数据，包含坐标、锚点、页码等，适合精确校验和结构定位
   ```

### 正确的层级使用原则（写入 CLAUDE.md）

```
L0 (Abstract)：文档摘要+标签+类型。极轻量，用于文档路由和快速分类
L1 (Structure)：DocTags/Markdown 格式章节分块。Agent 分析工作的主要层级
L2 (Raw)：Docling JSON 完整结构化原始数据。用于精确校验、锚点溯源、结构信息提取

通用原则：
- 日常分析阅读 → L1（Markdown/DocTags，LLM 友好）
- 精确校验/锚点溯源/结构定位 → L2（原始 JSON）
- PDF/DOCX 的 L1 和 L2 内容覆盖范围相同，但格式不同：L1 是可读 Markdown，L2 是结构化 JSON
- 不应描述为"L2与L1相同所以不需要展开"——两者格式不同，用途不同
```

---

## 六、Skill 可被子Agent调用的保障

当前架构已支持：
1. `skill_invoke` 工具在 `tool-setup.ts` 中注册，所有有该工具的 Agent 都可调用
2. `agent-runner.ts` 检测到 `__skill_invoke__` 标记后，以 `isSkillInvocation: true` 启动子Agent
3. `isSkillInvocation: true` 的子Agent **不受递归防护限制**，可以使用 `workflow_run` 等管理工具

**需要确认的保障**：
- 子Agent（通过 `workflow_run` 创建的子Agent）的工具列表中包含 `skill_invoke` 和 `list_skills`
- 当前 `workflow_run` 创建的子Agent如果 `tools=["*"]`，则自动包含 `skill_invoke`

**无需额外修改**——统一到 `agent_skills` 表后，所有 Agent 只要有 `skill_invoke` 工具就能调用。

---

## 七、实施步骤

### 步骤 1：修正 expand 工具描述中的层级引导
**文件**：`src/services/agent/tool-setup.ts`
**改动**：修正 PDF/DOCX 的 L1/L2 描述

### 步骤 2：重写 `builtin-skills.ts`
**文件**：`src/services/agent/builtin-skills.ts`
**改动**：
- 增强 `deep-research` prompt（吸收深度调研+深度文档分析）
- 新增 `全面知识库分析` prompt（合并三合一）
- 新增 `深度检索` prompt（合并二合一）
- 新增从 Plugin Skills 迁入的 7 个 Skill（报告生成、长篇写作、文档摘要、对比分析、表格专项分析、实体提取）
- 所有 Skill 加入自适应深度引导、修正层级引导、加入模板函数
- **所有 Skill 不设 maxTurns**（或设为 -1），使用动态计算
- 更新 `BUILTIN_SKILLS` 数组

### 步骤 2b：修正 skill_invoke 的 maxTurns 传递
**文件**：`src/services/agent/agent-runner.ts`
**改动**：
```typescript
// 修改前（line 2405）
maxTurns: agentSettings.subAgentMaxTurns,
// 修改后：不传递 maxTurns，让 agent-runner 动态计算
// （删除 maxTurns 参数，默认 undefined → 触发 estimateTaskComplexity）
```

### 步骤 3：清理旧的 Plugin Skills 定义
**文件**：`src/services/skills/built-in-skills.ts`
**改动**：清空 `BUILT_IN_SKILLS` 数组（或标记为 deprecated），避免重复注册

### 步骤 4：更新 `skill_invoke` 工具描述
**文件**：`src/services/agent/tool-setup.ts`
**改动**：更新描述以反映合并后的 Skill 清单，帮助 LLM 正确发现和选择 Skill

### 步骤 5：更新 Skill Chains
**文件**：`src/services/agent/skill-chain.ts`
**改动**：修正 `research-to-report` chain 中的 skill 名称引用

### 步骤 6：更新 CLAUDE.md
**文件**：`CLAUDE.md`
**改动**：添加层级使用原则、Skill 设计原则、输出引导原则

### 步骤 7：更新需求文档
**文件**：`requirements-checklist.md`
**改动**：记录 Skill 系统重构变更

---

## 八、CLAUDE.md 新增原则

### 8.1 数据层级使用原则

```
## 数据层级使用原则（L0/L1/L2）

- L0 (Abstract)：文档摘要+标签+类型。极轻量，用于文档路由和快速分类
- L1 (Structure)：DocTags/Markdown 格式章节分块。Agent 分析工作的主要层级
- L2 (Raw)：Docling JSON 完整结构化原始数据。用于精确校验、锚点溯源、结构信息提取

关键认知：
- PDF/DOCX 的 L1 和 L2 **内容覆盖范围相同但格式不同**：L1 是可读 Markdown/DocTags，L2 是结构化 JSON
- 不应描述为"L2 与 L1 相同所以不需要展开"——两者格式不同，用途不同
- 日常分析阅读用 L1，精确校验和结构定位用 L2
- 图片 L1 含 VLM 预编译描述+OCR，优先用 expand 获取
```

### 8.2 Skill 设计原则

```
## Skill 与 Plugin 设计原则

### Skill（轻量级场景经验）
- 单文件级别的经验指导，帮助 Agent 在特定场景下更高效地工作
- 可包含工具推荐、工作流建议、输出格式引导，但不应强制硬性约束
- 可被主 Agent 和子 Agent 通过 skill_invoke 按需调用
- 通用 Skill 不内置 report_generate——分析结果默认流式输出，仅在用户明确要求时生成报告
- **自适应深度引导**：引导模型根据任务复杂度自然决定输出深度，不硬性规定字数

### Plugin（重量级领域模块）
- 包含一组相关的 Skills + 自定义 Agents + 领域配置
- 如 judicial-analysis：证据链、时间线、实体网络、交叉验证、案件分析 + 验证器/提取器 Agent
- 领域特定需求（如公检法的报告格式、反幻觉级别）通过 Plugin 实现，不污染通用系统

### 判断标准
- 如果一个能力是"在某个场景下如何更好地使用通用工具" → Skill
- 如果一个能力需要"自定义 Agent + 多个 Skills + 领域配置" → Plugin
- 如果修改只对一个领域有效 → Plugin；对所有领域都有效 → 通用 Skill 或核心系统
```

### 8.3 输出引导原则

```
## Agent 输出引导原则

- **自适应深度**：引导模型根据问题复杂度和信息发现量自然决定输出深度
- 不硬性规定字数/篇幅（如"8000-20000字"），而是引导"充分回答，不多不少"
- 判断依据：发现的信息量、问题的复杂度、用户的期望
- 简单问题简明回答，复杂问题详尽展开
- 核心标准：充分解决问题、无遗漏关键信息、无幻觉、不注水
```

### 8.4 弹性执行原则

```
## 弹性执行原则（禁止硬性执行约束）

Agent 执行过程中不应设置硬性的轮次、时间、长度等限制。所有约束都应是弹性的、根据任务动态调整的：

- **轮次控制**：使用 estimateTaskComplexity 动态估算 + ProgressTracker 弹性管理（有进展自动延长，无进展引导换策略）
- **输出长度**：使用 max_output_tokens 分级恢复机制（截断后自动续写），不硬性限制单次输出
- **执行时间**：根据任务复杂度动态分配（C-105），而非统一超时
- **Skill 执行**：Skill 定义不包含 maxTurns 硬性约束，Skill 是经验指导，不是执行限制

禁止事项：
- Skill 定义中不设 maxTurns 硬性值
- 不硬性规定输出字数范围
- 不硬性规定工具调用次数上限
- 不硬性规定执行时间上限

参考：Claude Code 的 Agent 执行无硬性轮次/时间限制，按需工作，完成任务为止
```
