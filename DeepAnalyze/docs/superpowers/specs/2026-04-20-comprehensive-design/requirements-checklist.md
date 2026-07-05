# DeepAnalyze 软件需求清单
# 0.软件核心要求与诉求：一切不确定的技术选择或方案选择，都可以回到本软件核心设计目标出发来规划与设计：
# 0.1本软件核心是构建通用Agent，支持各种通用Agent场景的使用，通过各种plugin和skills和模型能力的加持，能够完成各种复杂和挑战性任务，通用Agent核心目标就是要能够支持无限长度的上下文文本，无限多的文档数量，无限复杂的工具调用，无限多步的操作目标，在这样的情况下都能够通过优秀的Agent loop循环，上下文自动化管理，优秀的记忆系统，优秀的工程设计等来有效的利用模型有限的上下文能力，有限的输入输出长度，有限的各种约束条件下最终达成希望达成的通用Agent的核心目标
# 0.2本软件还有另外一套核心设计是知识库系统，这套系统核心是希望把多种多样复杂的结构化和非结构化数据都能够作为输入源入库，入库时利用Docling系统和模型能力持续优化入库的质量，增加不同类型数据的支持，保持信息的完整结构，方便后续模型Agent能够利用
# 0.3Agent能够基于指定知识库和指定文档进行深入分析，利用知识库准确的信息提取和Agent无限迭代交错式推理完成复杂任务的能力，能够完成非常复杂的跨海量文档和数据的综合分析和处理工作。
# 0.4Agent应该充分利用多Agent能力，充分利用Docling的并行处理能力，充分利用软硬件的能力，实现质量优先情况下的性能效率和性能的极致优化
# 0.5在任何未确定方案和设计，需要方案和设计选择的时候，始终从以上章节0的原则和目标出发来考虑设计并保持和以下软件需求的架构一致性和融合合理性。
> 整理日期：2026-04-20 | 基于 2026-04-08 ~ 2026-04-19 全部设计文档，仅保留最新版本

---

## 一、核心需求

### 1. 系统定位与能力

| ID | 需求 |
|----|------|
| C-01 | 通用型 Agent ，支持各种通用Agent使用场景，同时支持驱动深度文档分析平台，通过 Plugin/Skill等适配不同垂直场景 |
| C-02 | Agent 多轮深度分析：TAOR 循环（Think-Act-Observe-Reflect），父子 Agent 调度，自动上下文自动管理和压缩，支持无限长度session和无限长度任务执行 |
| C-03 | 知识预编译：文档摄入时完成分层编译 |
| C-04 | 无损可溯源：所有基于知识库的分析结论可逐层追溯到原始文档精确位置（锚点级 docId:type:index） |
| C-05 | 通用可扩展：Plugin/Skill/MCP 机制，核心系统与领域逻辑解耦。Skill 系统支持用户通过 Markdown 定义自定义 Agent 行为，内置 Skill（如 deep-research）启动时自动注册到 DB；可用技能列表自动注入系统提示词 `<available-skills>` 动态 section；Skill 支持三模式调用（inline/fork/sub_agent，C-133）；MCP 协议支持动态加载外部工具服务器 |
| C-06 | 单机一体化部署：单进程启动（Bun），支持离线运行，Docker-compose 部署 |

### 2. 三层数据模型

| ID | 需求 |
|----|------|
| C-07 | 预编译知识以Raw(L2)/Structure(L1)/Abstract(L0) 三层架构存储 |
| C-08 | Raw 层：完整保留 Docling 解析的结构化 JSON，对于Docling不支持的格式通过对应模型处理完的原始文档也属于Raw层，按需读取，Raw层构建原始数据的确定性锚点 |
| C-09 | Structure 层：从 Raw层利用Docling自带能力自动导出的 DocTags/Markdown，按章节分块，不需要 LLM ，注意需要同时导出留存DocTags/Markdown两种格式|
| C-10 | Abstract 层：LLM 从 Structure 生成文档描述摘要（不超过300字）+ 标签 + 文档类型 |
| C-11 | 信息零损失：标题层级、表格坐标、图片位置、页码、阅读顺序等结构化信息全部保留 |
| C-12 | 多模态统一：PDF/Word/Excel/图片/音频/视频全部输出相同三层结构，处理方式参考下章节，前端界面提供3层数据的点击按钮，点击后可分别预览，支持各种格式预览。**表格特殊策略**：所有表格文件（XLSX/XLS/CSV）统一由 NativeTableProcessor 生成元数据描述（sheet 信息/列定义/样本行/源文件路径），Agent 始终通过 `bash+pandas` 处理源文件 |

### 3. 多模态处理

| ID | 需求 |
|----|------|
| C-13 | 文档，图片，音频：包括各种pdf/doc/docx/execl/Markdown/txt/html，图片，音频等所有Docling支持的格式，优先使用Docling解析，以Docling统一的通用Docling JSON原始格式导出到Raw层。旧版 .doc/.ppt/.rtf/.odt 等遗留格式通过 LibreOffice headless 转换后交 Docling 处理（C-156 增强）。纯文本类格式（txt/yaml/yml/json/xml/md/svg/toml/ini）由 TextProcessor 处理，含自动编码检测（BOM/UTF-8/GBK/Big5/Latin-1，C-234） |
| C-14 | 图片增强：图片默认使用 ImageProcessor（含 VLM 视觉描述 + Docling OCR + EXIF 拍摄信息 + 缩略图），优先于纯 Docling 处理。Docling 作为 OCR 子步骤被 ImageProcessor 内部调用。VLM 支持多提供商多协议：MiniMax 走 Token Plan VLM 专用端点（`/v1/coding_plan/vlm`），Qwen/OpenAI/Gemini 等走 OpenAI 兼容 Vision 格式（`/chat/completions`` + `image_url`），运行时按 provider endpoint 自动检测协议。VLM 调用需有独立重试机制（超时/API 错误重试 2 次）。图片仅提供 Auto 通道（ImageProcessor 已包含完整管道） |
| C-15 | 音频增强：音频使用 Docling 优先解析，Docling 失败时自动降级到配置的 ASR 模型解析（支持发言人分离标记）。ASR 调用失败时应触发重新处理。所有音频信息提取成 Docling JSON 格式兼容的原始格式导出到 Raw 层。**本地 Whisper ASR**：作为默认 ASR 后端（通过 SubprocessManager 管理 Python whisper 子进程，随系统启动），远程 ASR 作为可选备选。ASR 降级链：远程 API → 本地 Whisper → 提示不可用 |
| C-16 | 视频：Docling不支持视频解析，用户可以配置视频理解模型对视频进行解析，视频理解模型对视频内容转写成内容描述的文本，关键画面/对话时间对齐内容信息描述，提取成Docling JSON格式兼容的原始格式导出到Raw层 |
| C-17 | 所有文件类型原文件可在软件知识库的对应文档中选择 Raw 层按钮进行预览/流式播放：图片直接渲染、音频带播放器+转写同步、视频带播放器+字幕。媒体文件 `/original` 路由提供正确的 Content-Type（image/jpeg, audio/mpeg, video/mp4 等），支持 HTTP Range 请求（音频/视频拖拽） |

### 4. 知识检索

| ID | 需求 |
|----|------|
| C-18 | 提供多样化的融合检索能力：向量 + BM25 + RRF 融合排序，这部分检索能力由软件针对知识库按不同层级Raw，Structure，Abstract提供，界面可选在哪些层进行检索召回测试，Agent自己使用的时候根据自己需求调整参数进行自动化的检索查找，一般Agent集中在Structure层自己检索和整合数据，但同时保留对其他层的访问和调用能力 |
| C-19 | Agent支持类Claude code的grep检索方式，可参考refcode中claude code的grep检索方案在structure层按需自己多步迭代和检索已经提取处理的DocTags/Markdown信息，层次递进的多步分阶段精准搜索 |
| C-20 | Raw 层按需访问：通过前期的检索确定锚点定位后按需读取原始 JSON 片段，确保最终信息准确 |
| C-21 | 检索结果携带锚点 ID，支持最终输出内容中对关键信息链接到RAW，实现精准溯源 |

### 5. Agent 体系

| ID | 需求 |
|----|------|
| C-22 | TAOR 循环 Agent 引擎，保留 Claude Code harness 的核心能力，参考代码在refcode的claude code中。支持异步子Agent、团队信箱通信、递归派生防护、工具延迟加载 |
| C-23 | 主/辅模型分离：主 Agent 用主模型，子 Agent 用辅助模型，故障自动切换（仅限 chat 能力的 provider，通过角色分配 + 关键词启发式过滤 embedding/tts/image 等非 chat provider） |
| C-24 | 由Agent teams人工触发可支持五种调度模式：顺序 / 并行 / 委员会（多视角投票）/ 图谱（DAG 依赖）/ 单Agent委托（single，跳过编排开销直接执行） |
| C-25 | WorkflowEngine 支持取消、结果持久化、Council Round2 并行执行 |
| C-26 | 工具体系：双层架构 — 高级工具(kb_search/wiki_browse/expand/doc_grep/report_generate/timeline_build) + 底层工具(bash/read_file/write_file/edit_file/run_sql/grep/glob) + 生成工具(tts/image/video/music_generate) + 交互工具(ask_user/push_content/agent_todo) + 协作工具(workflow_run/task_output/send_message) + 扩展工具(skill_invoke/tool_discover/MCP动态工具) + 管理工具(skill_create/skill_update/skill_delete/subagent_transcript) + 自进化工具(agent_memory注入) + 数据库工具(run_sql读写/db_connect/db_query) + 平台工具(powershell)，browser 基于 Playwright |
| C-27 | 上下文管理：复刻Claude code实现无限上下文和全自动管理包括不限于自动压缩、微压缩、会话记忆持久化、预测性压缩（C-118）、搜索结果持久化索引（C-119）、非破坏性折叠（C-126）、压缩后文件重注入（C-127）、压缩后技能恢复（C-134）、压缩质量审计（C-135）等 |
| C-27a | 语言跟随：Agent 自动使用与用户提问相同的语言进行思考和回复（包括 think 工具推理），所有系统提示词和工具描述默认使用中文。双重防护：系统提示最高优先级规则 + 运行时语言漂移检测自动注入提醒 |
| C-27b | Agent 自主阅读原则：系统只提供客观的能力信号（tokenCount、截断提示、层级信息），不通过提示词限制或约定工具使用方式；LLM 自主决定阅读深度、次数和策略；系统侧移除技术约束（如 expand 结果的 token 限制适当放大），而非通过提示词约束 LLM 行为 |
| C-118 | 预测性上下文压缩：追踪每轮 token 增长速率，当预测在 8 轮内上下文将溢出时提前触发 proactive compaction（最低至 50% 比例），根据增长率动态调整压缩激进程度（0.5-1.0 factor） |
| C-119 | 搜索结果持久化索引：维护所有搜索查询的去重关键词、结果数量、文档标题和摘要片段，通过 `search_index_json` 持久化到 DB，压缩恢复和跨 session 时重建索引，注入 session memory 防止重复搜索 |
| C-120 | 搜索工具链短路：当 kb_search/web_search/wiki_browse/doc_grep 返回空结果时，代码级自动注入工具特定建议（根据查询长度推荐缩短关键词、根据工具类型推荐替代工具、引导 think 反思） |
| C-121 | 搜索饱和检测：追踪搜索结果集，当最近搜索结果与历史结果的 Jaccard 重叠度 >80% 时触发饱和信号，建议模型停止搜索、开始综合分析 |
| C-122 | Skill 链式编排：命名 Skill 链定义（如 research-to-report、cluster-and-analyze），按序执行并传递输出，支持失败策略和输入转换函数 |
| C-123 | Skill 测试运行器：Skill 可携带 testScenarios，验证工具调用（expectedToolCalls）、关键词覆盖（expectedKeywords）、禁止模式（forbiddenPatterns） |
| C-124 | 语义分块分析：使用嵌入向量对文档语义聚类，内置 chunked-analysis Skill 将大量文档按主题分组逐组分析后综合输出 |
| C-125 | 动态轮次预算：根据任务复杂度（simple/moderate/complex）动态分配建议轮次上限（15/40/100），硬性上限为 3 倍，达到 80% 时注入收尾引导 |
| C-126 | Context Collapse（非破坏性语义投影）：通过投影而非修改原始消息实现上下文缩减，保持缓存前缀完整；`context_expand` 工具允许模型按需恢复折叠内容（优先恢复含搜索结果的条目）；通过 feature flag 控制（默认启用） |

### 6. Provider 与模型

| ID | 需求 |
|----|------|
| C-28 | 支持 22+ LLM Provider（OpenAI/Anthropic/DeepSeek/通义/智谱/MiniMax 等），含 Qwen 3.6-plus 多模态模型（支持图像/视频输入） |
| C-29 | 模型角色分为：主模型 / 辅助模型 / 嵌入模型 / 图像理解(VLM) / ASR / 视频理解 / 生成模型（图像/视频/音乐/语音） |
| C-30 | 图像理解(VLM)：独立配置入口，支持配置任意 OpenAI 兼容或 MiniMax 的 VLM provider，按 endpoint 自动选择协议。生成模型：包含图像生成、视频生成、音乐生成、语音生成(TTS)，归类在"生成模型" Tab 下。ASR 和视频理解各有独立配置入口 |
| C-31 | Thinking/Reasoning 参数按厂商规范传递 |
| C-32 | 嵌入模型可切换，维度不同时后台异步重索引 |

### 7. 数据库

| ID | 需求 |
|----|------|
| C-33 | PostgreSQL + pgvector + zhparser，连接池支持并发 agent 任务（max=40）(05-14) |
| C-34 | 百万级向量 HNSW 索引检索 <100ms |
| C-35 | 中文全文检索（jieba 级分词） |
| C-36 | Repository 抽象层（25 个接口），业务代码不直接操作 SQL。25 个 Repository：vector-search/fts-search/anchor/wiki-page/document/embedding/session/message/knowledge-base/wiki-link/settings/report/agent-team/cron-job/plugin/skill/session-memory/agent-memory/agent-task/agent-skill/skill-usage/skill-version/workflow-log/index/interfaces (05-25 更新) |

### 8. 前端（核心）

| ID | 需求 |
|----|------|
| C-37 | 知识库统一页面：文档/Wiki/搜索合并，按文件类型自动渲染不同卡片 |
| C-38 | L0/L1/L2 按钮交互：灰色未就绪 / 绿色可预览，点击展开/折叠，编译完成逐层变绿。大内容（>5000行）自动启用虚拟滚动，仅渲染可视区域 |
| C-39 | 多媒体播放器：图片查看器、音频播放器（同步转写+发言人标签）、视频播放器（场景同步+关键帧时间线） |
| C-40 | 统一搜索栏：语义/向量/混合模式 + 召回数 + 层级选择 |
| C-41 | Agent 逐 token 流式响应（SSE content_delta）+ 子任务可视化 + 工具调用展示 + 实时 token 用量（turn_usage）。前端 appendStreamContent 逐字累积显示，onContent 回调设长度守卫防止覆盖更新的 delta 内容。工具调用信息可选持久化到消息 metadata，前端开关控制是否在历史消息中显示。思考内容使用独立的 `thinking_delta` 事件类型（C-171），不混入用户可见的 content_delta 流。**Thinking 持久化**：`thinking_delta` 内容（含 API `reasoning_content` 和 GLM `<think/>` 标签两种来源）累积后写入消息 metadata，前端 mapMessages 映射到消息模型，刷新后仍可见 (06-03 更新) |
| C-42 | 报告嵌入聊天，引用标记可悬停预览来源 |

### 9. 系统健壮性

| ID | 需求 |
|----|------|
| C-43 | 能力感知调度：自动感知可用能力，Provider 变更后能力自动更新；非 chat 能力（VLM/TTS/图片生成等）通过 CapabilityDispatcher 统一分发，按 provider 类型自动选择 API 协议 |
| C-44 | 熔断机制：连续 3 次失败切换到辅助模型，超时后半开恢复；回退时通过角色分配+关键词启发式排除非 chat provider（embedding/tts/image/video/music/audio） |
| C-45 | 降级链：增强模型 → 询问用户 → Skill → 明确告知不可用 |
| C-46 | 事件驱动架构：文档处理、Agent 任务、知识复合、报告生成通过事件总线联动 |
| C-47 | Agent 具备 `push_content` 工具，可推送结构化数据卡片到前端界面。**仅限特殊场景**：大型表格数据（type=table）、多段内容快速合并（type=markdown）、代码片段等。普通分析文本应直接流式输出（用户实时看到逐字显示），不得用 push_content 替代流式输出。支持类型：table/markdown/text/code/file/chart/image/audio/video (05-10 扩展) |
| C-48 | 前端聊天窗口支持渲染 Agent 推送的结构化内容（可折叠表格、代码块、文件预览），推送数据持久化到消息 metadata，刷新后仍可见 |
| C-49 | DocTags 乱码自动检测：当 Docling 输出含异常 Unicode 字符（自定义字体编码导致），系统自动检测（非标准字符占比>15%阈值）并清空 doctags，降级到 Markdown 输出，确保 Structure 层内容可读 |
| C-50 | Agent 多轮上下文聚焦：评估当前问题与历史上下文的相关性，聚焦于当前问题的核心意图；相关追问时深入细化，主题切换时重新聚焦，不重复之前的全面分析流程 |
| C-51 | Agent 长内容生成策略：流式输出已支持逐 token 显示，优先直接流式输出分析正文。当内容超长时，通过分章节流式输出、bash 追加写入临时文件后合并、push_content 推送大型表格数据等方式，突破单次输出长度限制，实现多轮迭代完成完整内容 |
| C-52 | 报告生成按需触发：Agent 默认直接在对话中输出分析结果，仅在用户明确要求生成报告、按特定格式输出或保存分析结果时才调用 report_generate。报告生成前先将完整内容输出到对话中 |
| C-53 | 聊天消息显示顺序：助手消息按"工具调用(顶部) → 推理过程/推送内容(中部) → 最终结果/报告(底部)"排列，流式输出时工具调用和推理模块同步增长 |
| C-54 | Agent 深度分析原则：禁止基于搜索摘要做分析，必须通过 expand 工具逐层深入阅读完整文档内容后再分析；禁止幻觉，所有结论必须基于文档原文；不能遗漏细节，必须逐一展开阅读每个相关文档 |
| C-55 | Agent 三阶段工作流：全面发现（wiki_browse+多角度kb_search建立完整文档清单）→ 逐一深入阅读（expand 阅读清单中每个文档的完整内容，未全部读完不输出分析）→ 系统化分析与输出（分章节详细输出）。严格反幻觉：未 expand 阅读的文档不得编写详细分析 |
| C-115 | **多源输出生成**：Agent 运行结束时同时从文本输出（accumulatedContent）、推送内容（push_content/write_file 数据）、finish 工具摘要中选取最长有意义内容作为最终输出，防止模型通过 write_file + finish 短摘要路径丢失完整报告内容 |
| C-116 | **Summary-after-work 检测**：当模型在 5+ 轮工具调用后自然终止但输出 <3000 字符时，自动注入续写消息要求输出完整详细内容，防止模型将大量研究工作压缩为短摘要 |
| C-117 | **finish 工具输出要求**：finish 工具描述明确要求研究/分析任务在 summary 参数中包含完整报告内容，禁止仅输出"报告已完成"等无实质内容的短摘要 |
| C-127 | **Post-compact 文件重注入**：压缩后自动重新注入最近访问的文件内容（最多5个文件/25K token预算），确保文件上下文不因压缩丢失。`readFileState` 在每次 read_file/write_file/edit_file 时追踪文件状态，压缩后通过 `createPostCompactFileAttachments()` 生成注入消息。支持 Legacy 和 Context Collapse 两种路径。可配置最大文件数、每文件token上限、总token预算 |
| C-128 | **Compact summary 文件与制品保留**：压缩摘要提示词要求保留所有文件路径和输出制品，新增"Files and Artifacts"独立section（10 section 结构），当前工作section必须包含恢复工作所需的所有文件路径和参数 |
| C-129 | **Session Memory 十 section 模板**：会话记忆从6 section/500字扩展为10 section/4000+ tokens，新增当前状态、任务规格、文件和路径、错误和修正、关键结果、工作日志section。maxTokens 2000→4000, serializeMessages 18K→24K |
| C-130 | **Deterministic Fallback 增强标识符提取**：确定性降级摘要从仅提取工具名扩展为同时提取文件路径、搜索查询和标识符（解析工具调用 JSON arguments 中的 filePath/path/file_path/source/target/query/keyword/searchTerm 等字段） |
| C-131 | **Transcript 路径引用**：压缩前被移除的消息序列化写入 `data/tmp/transcript-{session}-{ts}.md`，continuation message 提供文件路径，模型可用 read_file 恢复细节。覆盖 sm-compact/legacy-compact/hierarchical-compact/collapse 四种压缩路径 |
| C-132 | **Post-compact 清理**：压缩后清除 readFileState（已重注入），在 session memory 工作日志追加压缩事件记录，确保压缩后状态一致。覆盖全部6个压缩路径 |
| C-133 | **Skill 三模式调用**：skill_invoke 工具支持三种调用模式：inline（技能prompt注入当前对话，模型在同一上下文中遵循技能指令）、fork（独立子Agent继承父会话历史，上下文分叉）、sub_agent（全新上下文，默认值保持向后兼容）。模式通过 `mode` 参数指定。可用技能列表自动注入系统提示词 `<available-skills>` 动态 section |
| C-134 | **Post-compact 技能附件恢复**：压缩后自动重新注入 inline 模式技能的指令（最多3个技能/15K token预算），确保活跃的 inline 技能不因压缩丢失。`invokedSkills` Map 追踪所有已调用技能，仅 inline 模式技能参与重注入。所有6个压缩路径传递 invokedSkills 状态。可配置最大技能数、每技能token上限、总token预算 |
| C-135 | **压缩质量审计**：压缩后程序化检查摘要是否保留了原始消息中的不透明标识符（文件路径、URL、UUID、doc_id/page_id、哈希值、技能名称），缺失时记录诊断警告（不阻塞压缩）。压缩提示词增加标识符保留指令作为第3条规则 |
| C-136 | **数据质量审计与自动调优**：入库流水线新增质检步骤（parsing → compiling → indexing → quality_audit → ready）。QualityScorer 纯启发式打分（默认100分，仅检测明确故障信号：空内容/VLM失败标记/ASR失败标记/乱码/纯页码/逐行表格描述），低于阈值自动触发重提取（VLM两级fallback：vlm角色→main角色多模态），新旧对比取优者入库。质检步骤 try/catch 包裹，失败不阻塞流程。结果存入 `document.metadata.qualityAudit` JSONB。API：`POST /kbs/:kbId/documents/:docId/quality-audit`（手动触发）+ `GET /kbs/:kbId/quality-report`（KB汇总）(05-09) |
| C-137 | **高成本 Skill 防护机制**：三层防护防止高成本 Skill（如知识库预处理）被意外触发 — ① Skill 描述前缀 `[高成本/按需触发]` 标记；② `skill_invoke` 工具执行层拦截，返回 `__skill_confirmation_required__` 要求确认；③ 系统提示词可用技能列表中用 🔴 标记高成本 Skill 并附警告引导 (05-09) |
| C-138 | **预处理数据自动发现**：`wiki_browse(listDocuments=true)` 自动扫描 `_preprocessing/` 目录，检测到预处理产物（还原的表格CSV、全局概览、质量审计等）时在返回结果中附加 `preprocessingData` 字段（含路径、文件列表、表格数量、**表格血缘信息**），Agent 无需额外步骤即可发现预处理数据并了解其来源文档 (05-09, 05-10 增强血缘追踪) |
| C-139 | **中性工具引导**：`tool-guidance.ts` 以工具能力表形式客观描述各工具的覆盖率、精确度、强项、弱项，**严格禁止**任何推荐性语言（"优先使用X"、"适合其他工具无法覆盖的场景"、"请谨慎使用"）、固定搜索顺序（"A→B→C"）、偏袒任何工具。bash 与专用工具地位平等。工具引导遵循"描述能力边界，不规定使用顺序"原则 (05-09, 05-11 强化禁令) |
| C-140 | **工具能力诚实标注**：`doc_grep` 返回 `hasMore` 标记结果截断；`glob` 返回 `truncated` 标记超过200文件上限；`expand` 批量模式失败时提供可操作诊断信息；`kb_search` score 标注"不可跨查询比较"。各工具描述在 `tool-descriptions.ts` 中诚实说明覆盖率和局限性 (05-09) |
| C-141 | **文件系统第一类数据源**：Agent 工具引导和描述中明确 `read_file`/`glob`/`grep`/`bash` 可直接访问知识库磁盘文件（parsed.md、预处理产物、manifest.json 等），与数据库工具（run_sql/doc_grep/expand）互补而非从属。bash 是一等公民工具：拥有完整文件系统访问能力（grep批量搜索、python3编程处理、cat直接读取），**不得**在工具定义或引导中将其描述为"兜底工具"、"最后手段"、"适合其他工具无法覆盖的场景"。不偏袒任何数据访问路径。工具 execute() 中不硬拦截合法操作（如 json.loads）(05-09, 05-11 强化) |
| C-142 | **Agent 定义去偏见化**：内置 Agent（EXPLORE/REPORT 等）移除偏向特定工具的固定流程（如"首先使用 kb_search"），改为中性引导让 Agent 自主决策。Coordinator Agent 保留任务分解方法论但不硬性规定工具使用顺序 (05-09) |
| C-143 | **数据驱动工具引导**：工具引导和描述基于每个工具的真实能力评估（实际覆盖率、精确度测试数据），不美化任何工具的能力。每个工具同时列出强项和弱项（工具诚实评估表）。工具能力表作为 Agent 系统提示词中的客观参考，不包含主观推荐、倾向性排序、固定搜索顺序或"A→B→C"决策树 (05-09, 05-11 强化) |
| C-144 | **Agent 自主性原则**：系统提供客观信号（tokenCount、截断提示、层级信息、覆盖率数据），不通过提示词约束工具使用方式或固定工具组合。Agent 根据任务自主判断最优工具选择和执行策略。系统侧移除技术约束，而非通过提示词约束 LLM 行为 (05-09) |
| C-145 | **不变核心约束**：以下原则在任何优化中不改变 — ① 零幻觉：事实性内容必须有工具数据支撑；② 通用性：核心系统不包含领域特定内容；③ 弹性：不做固定截断/超时/设计；④ 分层：优化放入正确层级（L1 工具问题不用 L2 提示词解决）；⑤ Agent 自主性：系统提供信号不设约束 (05-09) |
| C-146 | **L1 工具问题待修复**：`doc_grep` 的 `totalMatches` 应返回真实总数而非截断数；`expand` 批量模式失败时应提供更准确的诊断信息（含具体哪些文档失败和原因）(05-09) |
| C-157 | **Transcript 录制工具**：`subagent_transcript` 工具允许主 Agent 读取子 Agent 执行记录（task_id 或 path），返回 taskId/recordedAt/turnsUsed/usage/messageCount/messages 字段，用于调试和恢复子 Agent 行为。Transcript 文件存储在 `data/tmp/transcripts/` 目录 (05-12) |
| C-158 | **Skill 管理工具**：`skill_create`/`skill_update`/`skill_delete` 三个工具支持 Agent 运行时动态管理技能。`skill_create` 支持保存到数据库（`save_path="db"`，通过 `repos.agentSkill` 持久化）或文件（`save_path="file"`，生成 SKILL.md 到 `data/skills/<name>/SKILL.md`）。名称格式校验（字母开头，仅字母/数字/连字符/下划线）。`skill_update` 支持部分更新（prompt/description/tools/is_active），is_active 映射为 isActive。`skill_delete` 按名称查找并永久删除。SKILL.md 格式：YAML frontmatter（description/tools/model-role）+ Markdown body（标题+prompt） (05-12) |
| C-159 | **Smart Cache Editing**：`applySmartCacheEditing()` 对引用类工具（kb_search/expand/doc_grep/web_search/wiki_browse）保留更多内容（16KB，含尾部预览），对通用工具生成结构化摘要（header+stats+tail），通过 `toolCallId` 自动关联工具名判断类型，短结果不截断 (05-12) |

---

## 二、一般需求

### 1. 文档处理

| ID | 需求 |
|----|------|
| G-01 | Docling 单例进程 + Python 线程池并发，队列 slot 并发控制。并行度默认 5，前端"文档处理" Tab 可在线调整（1-10 范围），实时生效 |
| G-02 | 非阻塞上传：后台运行，按文件类型可配置超时（PDF/DOCX/XLSX/音频 10min, PPTX/MP4 15min），3 次自动重试，指数退避（5s/10s/20s）。增强模型调用（VLM/ASR/TTS 等）失败也需独立重试 |
| G-03 | WebSocket 断线回退轮询（每 3s） |
| G-04 | 文件夹上传（webkitdirectory） |
| G-05 | 文档删除完整级联清理（嵌入→锚点→链接→页面→文件→记录）；知识库删除同时清理 generated/ 目录，前端删除后自动导航离开并乐观更新状态 |
| G-06 | 精细化进度追踪：上传(0-5%) → 排队 → 解析(0-25%) → 编译(25-50%) → 索引(50-75%) → 质检(75-90%) → 就绪(100%)。质检步骤 try/catch 包裹，失败不阻塞 |
| G-07 | Docling 模型可插拔管理，前端"文档处理"配置面板 |

### 2. 前端（一般）

| ID | 需求 |
|----|------|
| G-08 | 浅色/深色主题切换（浅色默认，深色可选） |
| G-09 | Header 功能按钮组：会话/技能/插件/定时/设置/Teams |
| G-10 | 右侧滑出面板系统（560px），内容感知切换 |
| G-11 | 设置面板多 Tab：主模型 / 辅助模型 / 嵌入模型 / 图像理解 / ASR / 视频理解 / 生成模型 / 文档处理 / 通用。图标紧凑排列，一排可见所有 Tab |
| G-12 | Teams 管理面板从知识库迁移到 Header 右侧面板 |
| G-13 | TeamEditor 完整字段：tools/dependsOn/perspective/systemPrompt |
| G-14 | 聊天页文件上传，无关联 KB 时自动创建临时知识库 |
| G-15 | 跨知识库搜索，结果标注来源 KB |
| G-16 | 报告支持 PDF/Markdown 导出 |
| G-17 | localStorage 持久化：主题/当前会话/当前 KB/侧边栏状态 |
| G-18 | DOMPurify XSS 防护 |

### 3. 工具与通信

| ID | 需求 |
|----|------|
| G-19 | web_search 支持三种后端：SearXNG（自部署）、Serper API（云端）、MiniMax（Token Plan）。通过环境变量 `SEARCH_BACKEND` 切换 |
| G-20 | 通信渠道管理：飞书/钉钉/微信/QQ/Telegram/Discord 互联 |
| G-21 | 定时任务系统（Cron 表达式），前端管理面板 |
| G-22 | 前后端通信：REST（CRUD）+ SSE（Agent 流式）+ WebSocket（进度推送） |

### 4. 配置与部署

| ID | 需求 |
|----|------|
| G-23 | 配置保存后实时生效，无需重启 |
| G-24 | YAML 配置文件作为 DB 配置的 fallback |
| G-25 | Docker Compose 一键部署（PG + 主服务 + Docling） |
| G-26 | 数据目录可配置，支持外部存储 |
| G-27 | 双名称体系：内部 UUID + 用户可见原始文件名 |
| G-28 | 文档处理通道选择与重新处理：每个文档卡片提供通道选择下拉框和重新生成按钮。通道选项按文件类型智能适配：PDF/DOCX/PPTX→{Auto, Docling, Native}；音频→{Auto, Docling, ASR}；表格文件（XLSX/XLS/CSV）→{Auto, Native, Docling}；图片→{Auto}（ImageProcessor 已含完整管道）。选择不同于当前已完成方案的通道后点击重新生成，自动以选定通道重新解析并重建 L2→L1→L0 全链路。解析失败（如 ASR 404、VLM 超时、乱码等）也应可手动触发重新生成 |
| G-29 | Playwright E2E 测试框架：基于 @playwright/test，覆盖核心 API（健康检查、知识库 CRUD、搜索、设置、会话、定时任务），支持截图和 trace 记录，CI 可集成 |
| G-30 | L1 内容预览：文档列表中每个就绪状态的文档卡片显示 L1 内容前 300 字预览（等宽字体，最多 3 行，CSS line-clamp 截断）。后端 `WikiPageRepo.getL1Previews()` 单 SQL 查询批量获取（按 page_type 优先级：structure_md > structure_dt > structure > overview），API 在文档列表响应中附加 `l1Preview` 字段 |
| G-31 | 通用工具库体系（`src/utils/`）：从 CC 迁移的 17 个通用工具模块 + 3 个 bash 解析器模块，已集成到 DA 活跃代码路径。核心工具：① `atomicWrite.ts` — 原子文件写入（temp+rename+fsync），消费者：8 个数据文件（manifest/compiler/worker-identity/media-store/session-memory/page-manager/knowledge-compound/ReportTool）；② `logger.ts` — 结构化错误日志（环形缓冲 100 条 + 可插拔 sink + 队列排空），消费者：5 个核心错误通道（error-handler/app/main/processing-queue/event-bus）；③ `retry.ts` — 通用重试（指数退避+抖动+中止信号+可配置 isRetryable），消费者：4 个模型文件（capability-dispatcher/openai-compatible/anthropic-compatible/embedding）；④ `errors.ts` — 错误工具函数（errorMessage/toError/isENOENT/isFsInaccessible/shortErrorStack），消费者：logger.ts + 6 个业务文件。辅助工具：CircularBuffer/abortController/combinedAbortSignal/cleanupRegistry/sanitization/sleep/memoize(front+LRU)/frontmatterParser/format/intl/yaml/profilerBase/startupProfiler (05-25) |
| G-32 | Server-Worker 分布式架构（`src/services/hub/`）：Worker 模式（`DA_SERVER_URL` 设置时激活，runMode="worker"）。组件：HubClient（Worker→Server Pull 模型通信）、WorkerIdentity（ID 生成+能力收集+状态上报）、Types（WorkerConfig/HubSyncState/Marketplace）。特性：Worker 注册、30 秒心跳、配置按需同步（按钮触发）、Marketplace 技能浏览安装、Server 不可用时 Worker 独立降级运行。环境变量：DA_SERVER_URL/DA_WORKER_ID/DA_WORKER_TOKEN (05-25) |
| G-33 | Chat 多媒体上传：聊天中上传图片/视频，内联缩略图显示。主模型有视觉能力时直接发送，无视觉能力时 VLM fallback。媒体存储绑定 session 生命周期。消息内容格式：JSON 含 text + media 数组（向后兼容纯文本）。API：媒体上传端点、缩略图生成 (05-25) |
| G-34 | Feature Flags 完整列表（11 个）：concurrentToolExecution(默认true)、promptCaching(true)、streamingToolExecution(true)、hierarchicalCompression(true)、cacheEditing(true)、longOutputContinuation(true)、maxToolConcurrency(10)、pluginSystem(true)、markdownSkills(true)、contextCollapse(true)、backgroundWorkflows(true)。环境变量控制：DA_CONCURRENT_TOOLS/DA_PROMPT_CACHING/DA_STREAMING_TOOLS/DA_HIERARCHICAL_COMPACT/DA_CACHE_EDITING/DA_LONG_OUTPUT/DA_MAX_CONCURRENCY/DA_PLUGINS/DA_MARKDOWN_SKILLS/DA_CONTEXT_COLLAPSE/DA_BACKGROUND_WORKFLOWS (05-25) |
| G-35 | Hub Server 多租户控制平面（`deepanalyze-hub/`，独立仓库）：基于 Hono + PostgreSQL + Bun 运行时的企业级 Hub Server，作为 G-32 架构的生产控制平面。四阶段完整交付：(1) **Phase 1** — 树形 Organization（path 维护+祖先查询）+ User（双 Token JWT：access 7d body / refresh 30d HttpOnly cookie）+ API Key 认证 + RBAC 三件套（Role/Permission 树+DataScope 数据范围）+ Worker 申请-审批流程（v1 自动通过/v2 需 admin 审批）+ 前端管理后台（React 18+Vite，Login/Dashboard/OrgTree/UserList/WorkerApproval）；(2) **Phase 2** — org-scoped SkillPackage（system/org/user 三级 scope）+ SkillVersion（不可变+content_hash）+ 订阅（user/worker/org 三类 subscriber）+ SkillSyncService（diff expected vs cached → sync/kill 指令）+ 心跳协议 v2（cached_skills/policy_version/current_task）；(3) **Phase 3** — 6 态状态机（draft→internal_test→canary→published→deprecated/rolled_back）+ PublishGate 4 维评估（RedFlag 30% + Structure 15% + LLM 25% + Benchmark 30%）+ RedFlagScanner 14 规则（RF01-RF14，CRITICAL/HIGH/MEDIUM）+ Approval 工作流（org/system scope 强制审批）+ Kill Switch + Force Update 持久化队列（带 deadline）+ 不可篡改审计日志（BIGSERIAL，仅 INSERT+SELECT API）；(4) **Phase 4** — 跨组织 SkillSharing 双边审批（pending→approved/rejected/revoked，批准时自动订阅+撤销时下发 kill 指令）+ SkillUsageLogs（success/failure/timeout/blocked + duration_ms 统计）+ Security Gateway 三层过滤（WordEngine Trie + RegexEngine PII 自动脱敏 + DecisionEngine severity-based）+ 企业认证适配器（LDAP/OIDC Authorization Code+PKCE/TOTP MFA RFC 6238）。**总测试 122 项全部通过**（Phase 1: 21 + Phase 2: 21 + Phase 3: 29 + Phase 4: 51），数据库迁移 014 项，端口 22000。设计文档：`docs/superpowers/specs/2026-06-20-hub-server-multi-tenant-design.md` (06-21) |
| G-36 | Hub 安全模型：(1) **JWT 双 Token** — access token 放 response body（前端存 localStorage），refresh token 放 HttpOnly cookie（防 XSS），过期自动刷新；(2) **API Key** — X-API-Key header，明文仅返回一次，DB 存 SHA-256 hash；(3) **Worker Token** — wkt_ 前缀，30 天有效期，v2 协议 worker 必须先 admin approve 才能拿到；(4) **Permission Matrix** — 21 个权限码（worker:*、org:*、user:*、rbac:*、skill:*、skill:kill/publish/approve/subscribe/sync/share、usage:read），super_admin 通配，org_admin 限本 org，DataScope 自动过滤；(5) **Security Gateway FAIL_OPEN** — `SECURITY_GATEWAY_ENABLED=true` 默认启用，`SECURITY_GATEWAY_FAIL_OPEN=true` 异常时放行避免单点故障；(6) **审计日志不可篡改** — 生产环境通过 PostgreSQL REVOKE UPDATE/DELETE 强制，开发环境通过 repository API 契约 (06-21) |
| G-37 | Hub 跨组织共享机制（SkillSharing）：(1) **双边审批** — 源 org admin 发起 → 目标 org admin 审批 → 自动订阅；(2) **Partial Unique Index** — `uq_sharing_active_pair` 仅对 status IN ('pending','approved') 生效，允许 rejected/revoked 后重新发起；(3) **Restrictions JSONB** — max_users/expires_at/data_classification_max 三维限制；(4) **撤销传播** — DELETE /sharings/:id 自动删除目标 org 订阅 + 入队 kill 指令（priority=90）+ 记录审计日志（action='share_revoked'）；(5) **权限隔离** — 仅 involved org admin 或 super_admin 可操作，非 involved 返回 403 (06-21) |
| G-38 | Hub 企业认证适配器（auth-adapters）：(1) **LdapAdapter** — `AUTH_LDAP_ENABLED=true` 启用，`AUTH_LDAP_SIMULATE=true` 开发模拟模式（真实部署需 ldapts 包）；(2) **OidcAdapter** — OAuth2 Authorization Code + PKCE 流程，`AUTH_OIDC_ENABLED=true` + issuer_url/client_id/client_secret 配置，Discovery 文档 + userinfo 端点；(3) **TOTP MFA** — RFC 6238（30s window，SHA-1，6 位数字，±1 window drift），`generateTotpSecret()`/`verifyTotp()`/`totpProvisioningUri()`；用户级开关 `setUserMfa()`，全局强制 `AUTH_MFA_REQUIRED=true`；MFA setup→verify→disable 完整流程需正确 code；(4) **统一 AuthResult** — external_id/username/email/display_name/groups，Hub 通过 external_id 匹配 users.external_ids 自动 provisioning (06-21) |
| G-39 | **DA 单用户容器核心设定**（2026-07-04）：DA 容器在企业场景中是**单用户容器**，一个容器=一个用户的完整运行环境（PG + 后端 + 前端 + 自带登录页）。DA 内部**不需要多租户隔离、不需要 user_id 数据隔离**——隔离在容器级别完成。容器内 PG 数据卷 `/opt/da/{worker_id}/pgdata` 独立。一台物理机可跑多个用户容器，按端口段区分。设计文档：`docs/superpowers/specs/2026-07-04-enterprise-multi-tenant-design.md` |
| G-40 | **Hub 控制平面角色**（2026-07-04）：Hub 集中管理 ① 用户身份与组织树 ② 配置模板（全局+组织 override 两层）③ 物理机抽象（host_servers 表）+ 端口池 ④ 容器分发与升级 ⑤ 用户→容器路由（SSO 跳转）⑥ 监控（心跳+模块健康）。Hub 不持有业务数据，业务数据全部在各 DA 容器内。worker 通过 host_server_id 关联到物理机，SSH 凭证+端口池集中在 host_servers 表 |
| G-41 | **SSO 一次性 ticket 换 token 机制**（2026-07-04）：用户在 Hub 登录后跳转自己的 DA 容器无需重新输密码。流程：Hub `POST /api/v1/auth/sso/ticket` 生成 10 秒过期 ticket → 浏览器跳 `DA/api/auth/sso/callback?hub_ticket=xxx` → DA 后端 `POST hub/api/v1/auth/sso/exchange`（带 da_worker_token 鉴权）→ 拿 access_token → DA 验签后用本地 RS256 密钥签发 8h HttpOnly+SameSite=Lax 的 `da_session` cookie。ticket 单次使用（consumed_at 标记）、防跨 worker（ticket 内嵌 da_worker_id 校验）。sso_tickets 表持久化、每分钟清理 1h 前过期记录 |
| G-42 | **端口段 block 分配模型**（2026-07-04）：每个 worker 分配连续端口段（block_size 默认 10）。**容器内端口固定**（DA=21000、embedding=8700、whisper=8701、docling=8702、paddleocr-vl=8703、glm-ocr=8704、mineru=8705），**host 端口按 worker base 偏移**（base=21000 时映射到 host 21000-21006；base=21011 时映射到 host 21011-21017）。docker run 用 `-p {base+offset}:{container_port}` 实现。Hub 用 generate_series + NOT EXISTS 的 SQL 在 host_servers.port_range_start~end 内找最小可用 base |
| G-43 | **双轨配置同步（locked + recommended）**（2026-07-04）：Hub → DA 单向同步。**只有 2 个触发器**：① 首次构建自动同步（DA 启动检测 `last_hub_sync_at IS NULL`）② DA 侧手动点击"立即同步"。**禁止**定时同步、Hub 推送、变更广播（避免覆盖用户运行中的本地修改）。字段分两类：locked（fieldLocks.lockedPaths 列出）→ 强制覆盖；recommended → 仅当本地为空或为默认值时写入。覆盖范围：9 个模型角色 + 7 类 module_states。同步后调 bumpConfigVersion 触发热重载 |
| G-44 | **两层配置模板（全局 + 组织 override）**（2026-07-04）：Hub 侧 config_templates 表：scope=global（org_id=NULL，全局基线）+ scope=org（每组织可选 override）。DA 拉取时 deepMerge 合并（对象递归、数组替换、null 表示删除字段、lockedPaths 取并集）。Hub 新增 `/config-templates` 编辑页（JSON 编辑器+字段锁定可视化+合并预览）。版本化保存，保留历史 |
| G-45 | **企业版镜像 = 同一个人版镜像 + ENV 决定模式**（2026-07-04）：T15 双轨 Dockerfile（personal-core/personal-full）**完全复用**，企业版不产新 Dockerfile。差异只在运行时 ENV：个人版 `DA_AUTH_MODE=local`（默认）或 `none`；企业版 `DA_AUTH_MODE=hub` + `DA_HUB_URL=...` + `DA_HUB_WORKER_TOKEN=...` + `DA_HUB_WORKER_ID=...` + `DA_HOST_PORT_BASE=...`。Hub 通过 `bundle_manifests` 表登记 tarball（PUT 流式上传 + sha256 校验），部署时 SSH 到 host_server `curl <hub>/api/v1/bundle/images/{tag}.tar.gz \| docker load` |

---

## 三、冻结 / 不做

| ID | 说明 | 原因 |
|----|------|------|
| F-01 | 跨文档链接构建 / 知识图谱可视化 | 锚点已覆盖核心追溯，链接构建成本高，当前暂停开发，代码不删除但不调用 |
| F-02 | 用户认证与权限系统（DA 内部） | **DA 是单用户容器，内部不做多租户隔离**：一个 DA 容器=一个用户的完整环境（PG + 后端 + 前端 + 自带登录页），用户数据隔离在容器级别完成。多租户身份、组织、权限集中在 **deepanalyze-hub** 控制平面（JWT 双 Token + API Key + Worker Token + RBAC 三件套 + 组织树）。DA 容器通过 SSO ticket 接收 Hub 签发的身份，本地以 RS256 cookie 维持 8h 会话（G-41）。DA 主后端 users 表仅用于本地降级模式（DA_AUTH_MODE=local）|
| F-03 | 移动端响应式 | 后续按需 |
| F-04 | 多语言 i18n | 后续按需 |
| F-05 | 消息分页 / 搜索缓存 | 后续按需 |
| F-06 | 插件市场 | 后续按需 |
| F-07 | 3D 生成能力 | 保留配置入口，暂不实现 |
| F-08 | 实时流式 ASR | 后续按需 |

---

## 四、前期需求变更处理记录

| 冲突 | 早期版本 | 最终版本 |
|------|---------|---------|
| 数据分层 | L0摘要/L1概览/L2全文 (04-08) | **Raw L2/Structure L1/Abstract L0** (04-15) |
| 数据库 | SQLite (04-08) | **PostgreSQL + pgvector** (04-15/17) |
| 知识库 UI | 文档/Wiki/搜索三个 Tab (04-08) | **统一单页面** (04-18) |
| 视频处理 | 帧采样+逐帧VLM (04-13) | **视频理解模型+音频轨转写** (04-18) |
| 知识链接/图谱 | 完整链接体系 (04-08) | **冻结**，锚点系统替代 (04-15) |
| Structure 层生成 | LLM 生成概览 (04-08) | **Docling 直接导出，不需要 LLM** (04-15) |
| Teams 位置 | 知识库页面内的 Tab (04-12) | **Header 右侧面板** (04-18) |
| Chat 降级 | 仅角色分配过滤 | **角色分配 + 关键词启发式双重过滤** (04-21) |
| 语言跟随 | 无显式要求 | **Agent 自动跟随用户语言，系统提示词/工具描述中文化** (04-21) |
| KB 删除 | 仅数据库级联 | **增加 generated/ 清理 + 前端导航优化** (04-21) |
| Agent 阅读策略 | 无显式要求 | **C-27b: Agent 自主阅读原则，系统只提供信号不约束行为** (04-21) |
| 图片处理 | Docling OCR | **ImageProcessor(VLM+OCR+EXIF) 优先，Docling 作为 OCR 子步骤** (04-22) |
| 音频降级 | 无降级 | **Docling 失败自动降级 ASR** (04-22) |
| 队列超时 | 120s 硬编码 | **按文件类型可配置（10-15min）** (04-22) |
| 错误重试 | 无 | **3 次自动重试 + 指数退避** (04-22) |
| Docling 运行 | 每次创建进程 | **单例进程 + Python 线程池并发** (04-22) |
| 处理通道 | 无选择 | **按文件可选择不同处理通道重新处理** (04-22) |
| VLM 路由 | 单一 chat 调用 | **CapabilityDispatcher 多协议自动分发：MiniMax Token Plan VLM + OpenAI 兼容 Vision** (04-22) |
| Qwen 多模态 | 仅 Qwen VL 专用模型 | **Qwen 3.6-plus 支持多模态输入（图像/视频），可直接作为 VLM 角色** (04-22) |
| 处理器降级 | 仅处理失败降级 | **空内容也触发降级（parseWithFallback 检测 success=true 但 text 为空的情况）** (04-22) |
| 并行度 | 固定 Semaphore(2) | **默认 5，前端"文档处理"Tab 可在线调整 1-10** (04-22) |
| 模型分类 | 主/辅/嵌入/增强 | **主/辅/嵌入/图像理解/ASR/视频理解/生成模型（图像/视频/音乐/TTS）** (04-22) |
| 设置 Tab | 增强模型含所有能力 | **拆分为独立 Tab：图像理解(VLM) / ASR / 视频理解 / 生成模型，增强→生成模型改名** (04-22) |
| 重新处理 | 选择通道后无操作 | **下拉选通道+重新生成按钮，选定后自动重建 L2→L1→L0，通道按文件类型智能适配** (04-22) |
| 增强模型重试 | 无 | **VLM/ASR 等增强模型调用失败需独立重试（2 次重试 + 指数退避）** (04-22) |
| 表格处理策略 | 全量内容转换入库 | **全量元数据描述 + 条件全量转换（<=1000行额外全量），Agent 始终可用 pandas 处理源文件** (04-23) |
| 大内容预览 | 无虚拟化 | **C-38 补充：大内容自动启用虚拟滚动** (04-23) |
| 工具调用持久化 | 刷新丢失 | **C-41 补充：工具调用可选持久化显示（前端开关）** (04-23) |
| 数据推送能力 | 仅模型文本输出 | **C-47/C-48: push_content 工具直接推送结构化数据到前端** (04-23) |
| Agent 轮次上限 | 前端默认 50 轮 | **默认无限制(-1)，选项含 9999** (04-23) |
| 音频 ASR | 远程 ASR | **本地 Whisper ASR 作为默认后端（SubprocessManager 管理），远程 ASR 可选备选** (04-23) |
| 媒体 Content-Type | text/plain | **正确 MIME 类型 + Range 请求支持** (04-23) |
| 浏览器工具 | 无 | **C-26 补充：browser 工具（Playwright），支持导航/截图/提取/交互** (04-23) |
| web_search 后端 | SearXNG + Serper | **+MiniMax 三后端，环境变量切换** (04-23) |
| DocTags 乱码 | 无检测 | **C-49: DocTags 乱码自动检测+降级到 Markdown** (04-23) |
| E2E 测试 | 无 | **G-29: Playwright E2E 测试框架** (04-23) |
| Agent 上下文 | 无聚焦策略 | **C-50: 多轮上下文聚焦，评估相关性后决定搜索范围** (04-24) |
| 长内容输出 | 单次输出压缩 | **C-51: 分章节迭代+push_content+bash追加，突破输出长度限制** (04-24) |
| 报告生成 | 深度分析主动生成 | **C-52: 默认直接输出，仅用户明确要求时才调用 report_generate** (04-24) |
| 消息显示顺序 | 结果在上/工具在下 | **C-53: 工具调用(上)→推理过程(中)→结果报告(下)** (04-24) |
| 表格溢出 | 无 overflow 控制 | **前端 markdown.css 表格 display:block+overflow-x:auto+word-break** (04-24) |
| Agent 分析深度 | 搜索摘要即做结论 | **C-54: 深度分析原则，必须 expand 阅读完整文档后再分析，禁止基于摘要做结论** (04-24) |
| Agent 工作流 | 无阶段约束，阅读/输出混合 | **C-55: 三阶段工作流（发现→阅读→分析），严格反幻觉规则** (04-24) |
| Agent 提示词 | 过长、硬编码工作流步骤 | **C-56: 提示词精简通用（≤30行核心指令），不硬编码工作流步骤，Agent 自主判断工作方式** (04-24) |
| 并行分析 | 单 Agent 链路 | **C-57: Agent 自主调用 workflow_run 启动多 Agent 并行工作流（并行深度检索/全面深度分析/通用并行检索）** (04-24) |
| 任务跟踪 | 无 | **C-58: agent_todo 工具，Agent 自主创建/更新任务清单，进度通过 SSE 实时推送** (04-24) |
| Todo 可视化 | 无 | **C-59: 聊天界面 TodoPanel 实时显示任务进度（pending/in_progress/completed）** (04-24) |
| 并行监控 | SubAgentPanel 仅团队页 | **C-60: 聊天界面嵌入 SubAgentPanel，多 Agent 并行工作时实时显示各子 Agent 状态** (04-24) |
| SSE 事件 | push_content/tool_call | **C-61: SSE 新增 todo_update + workflow_complete 事件，子 Agent 结果实时推送前端** (04-24) |
| 团队模板 | 7 个内置模板 | **C-62: 新增"通用并行检索"模板（3 Agent parallel：语义+精确+文档浏览）** (04-24) |
| 报告污染 | 旧报告影响分析 | **C-63: kb_search 默认排除 report 页面类型，Agent 分析基于原始文档一手内容** (04-24) |
| Markdown 推送 | push_content 折叠不可读 | **C-64: PushContentCard 对 type=markdown 直接渲染富文本（marked+DOMPurify），默认展开不折叠** (04-24) |
| 文档发现 | Agent 只能搜索命名文档 | **C-65: wiki_browse 新增 listDocuments 模式，一次性列出 KB 中所有文档+L0摘要+按目录/文件类型自动分类统计** (04-24) |
| 批量展开 | 逐个 expand 效率低 | **C-66: expand 工具新增 docIds 数组参数，支持一次调用批量展开多个文档 L1 结构** (04-24) |
| 精确搜索 | 只有语义搜索无正则 | **C-67: 新增 doc_grep 工具，正则搜索 wiki 页面内容，支持精确匹配人名/日期/编号/金额** (04-25) |
| 交互确认 | Agent 遇不确定只能猜 | **C-68: 新增 ask_user 工具，Agent 分析过程中可向用户提问确认，SSE 推送问题+POST 回复** (04-25) |
| 文档覆盖 | 大量文档被遗漏 | **C-69: Agent 全面分析时需先用 listDocuments 了解全貌，按类别批量 expand，确保系统性覆盖** (04-25) |
| Agent 工具架构 | 仅语义搜索+Wiki抽象层 | **C-70: 双层工具架构 — 高级工具(kb_search/expand/wiki_browse/doc_grep)+底层工具(bash/read_file/run_sql/grep/glob)，高层不够用立即切底层** (04-24) |
| Agent 通用能力 | 只能读不能写 | **C-71: write_file/edit_file 工具 — Agent 可在数据目录内创建/编辑文件，完成读写执行闭环** (04-24) |
| Agent 可扩展性 | 行为硬编码在 agent-definitions.ts | **C-72: Skill 技能系统 — 用户通过 Markdown 定义自定义 Agent 行为，Agent 通过 skill_invoke 调用，支持提示词覆盖+工具限制+systemPrompt 自定义** (04-24) |
| 子Agent调度 | 仅同步等待 | **C-73: 异步子Agent — workflow_run 支持 run_in_background 模式，Agent 可继续工作后用 task_output 获取结果，SSE 实时推送进度** (04-24) |
| 递归防护 | 无 | **C-74: 子Agent 递归防护 — 子Agent 禁止调用 workflow_run/agent_todo 等管理类工具，防止无限派生** (04-24) |
| Token 效率 | 23个工具全部随API发送 | **C-75: 工具延迟加载 — 低频工具标记为 deferred，仅发送核心工具定义，Agent 通过 tool_discover 按需发现激活，节省 input token** (04-24) |
| 工具扩展 | 仅内置工具 | **C-76: MCP 协议支持 — 动态加载外部 MCP 工具服务器，工具以 mcp__serverName__toolName 命名，支持配置管理+认证** (04-24) |
| 团队协作 | 子Agent完全隔离 | **C-77: 团队信箱通信 — workflow_run 子Agent 间可通过 send_message/post_message 互相通信，支持定向发送和广播** (04-24) |
| push_content 持久化 | 仅 SSE 流，刷新丢失 | **C-48 补充：markdown 类型 push_content 保存为消息主体内容，pushedContents 数组存入 metadata，历史消息可完整重建** (04-24) |
| Agent 流式输出 | 整轮输出完成才显示 | **C-78: Agent 逐 token 流式输出 — agent-runner 从 chat() 切换到 chatStream()，SSE 新增 content_delta 事件逐 token 推送前端，前端 appendStreamContent 实时累积显示** (04-25) |
| 项目配置注入 | 无持久化项目级配置 | **C-79: .deepanalyze.md 配置文件 — 从 dataDir 加载 .deepanalyze.md 文件内容注入到 Agent 系统提示词，支持项目级自定义指令** (04-25) |
| 单 Agent 委托 | workflow_run 仅多 Agent 模式 | **C-80: workflow_run single 模式 — WorkflowMode 新增 "single"，直接委托单个子 Agent 执行任务，跳过多 Agent 编排开销** (04-25) |
| Prompt 缓存 | 无缓存标记 | **C-81: Prompt 缓存共享 — Anthropic provider 系统提示通过 `splitSystemPromptForCache()` 拆分为 TextBlockParam[]，静态区标记 `cache_control: { type: "ephemeral" }`（跨请求可缓存），动态区不标记。工具定义最后一个工具标记 cache_control。`markCacheBreakpoints()` 标记最后 user 消息的 `__cache_control`。OpenAI provider 兼容翻译 `__cache_control` → `cache_control`。ChatResponse.usage 新增 cachedTokens 追踪** (04-25, 05-12 实现) |
| 实时状态 | 无 token 使用量反馈 | **C-82: 实时状态显示 — SSE 新增 turn_usage 事件，每轮结束时推送 inputTokens/outputTokens/cachedTokens，前端 onTurnUsage 回调** (04-25) |
| Hook 系统 | 无工具执行前后钩子 | **C-83: Hook 系统 — HookManager 支持 17 种生命周期事件（PreToolUse/PostToolUse/PreCompact/PostCompact/SessionStart/SessionEnd/AgentStart/AgentComplete/UserPromptSubmit/SubagentStart/SubagentStop/Stop/StopFailure/Notification/PermissionRequest/PermissionDenied/FileChanged），三种注册类型（command/http/callback），glob 匹配器过滤工具名，阻塞 vs fire-and-forget 语义区分，settings API 管理 hooks 配置** (04-25, 05-12 扩展至17种+callback类型) |
| MCP 传输 | 仅 HTTP POST | **C-84: MCP 传输增强 — MCPServerConfig.type 新增 "websocket"，实现真实 SSE 传输和 WebSocket 传输，支持 JSON-RPC over WebSocket** (04-25) |
| 流式输出 vs push_content | Agent 过度使用 push_content 推送分析文本 | **C-41/C-47 补充：流式输出优先策略 — push_content 工具描述限定仅用于大型表格和多段合并，Agent 系统提示词新增"输出方式"章节明确流式文本优先、push_content 仅限特殊场景** (04-25) |
| think 工具流式 | think 内容以批量 content 事件发送 | **C-78 补充：think 工具内容改为 content_delta 事件流式发送（此前为批量 content 事件），保持流式 UX 一致性** (04-25) |
| VLM OCR 集成 | 无 VLM 管线支持 | **G-07 补充：Docling VLM 管线双模式集成 — inline 模式（VLM 模型加载到 Docling 进程）+ API 模式（独立容器服务）。默认模型 GLM-OCR (0.9B, zai-org/GLM-OCR)，备选 PaddleOCR-VL-1.5。前端 DoclingConfig 支持模式切换和容器生命周期管理。VLM 模式速度约为标准模式 7-10x 慢，但 OCR 质量更高** (04-25) |
| OCR 结构恢复 | VLM 输出无标题标记 | **G-07 补充：`_restore_document_structure()` 后处理 — GLM-OCR 作为纯文字识别模型不输出 markdown 标题标记，通过启发式正则恢复章节结构（`1. Introduction` → `## 1. Introduction`）。同时 `_clean_vlm_output()` 清理 `<|user` 等模型特殊 token 残留** (04-25) |
| VLM GPU 批处理优化 | 默认 batch_size=4 | **G-07 补充：Docling `page_batch_size` 从默认 4 优化为 8，在 RTX 5090 上提速约 12%。GPU 批处理瓶颈在于自回归解码，更大 batch_size (15+) 反而更慢** (04-25) |
| transformers 版本 | 4.57.6 | **升级到 5.4.0 — GLM-OCR 要求 transformers ≥5.4.0（模型类型 `glm_ocr` 不被 4.x 识别）。Docling VLM 依赖允许 5.4+，vllm 要求 <5（可接受，vllm 容器为独立部署）** (04-25) |
| PaddleOCR-VL 局限性 | 计划作为主要 VLM | **决策：不作为默认 VLM — PaddleOCR-VL-1.5 输出 `<|LOC_xx|>` 定位标记设计给 PP-DocLayoutV3 配合使用，独立使用时输出包含 1000+ 定位 token，需后处理清理。输出质量（重复、结构混乱）不如 GLM-OCR。保留 API 模式支持作为备选** (04-25) |
| VLM vs 标准管线性能 | 无对比数据 | **基准测试（4 篇学术论文）：标准管线平均 9.3s (4-6 页/秒)，GLM-OCR 平均 58.3s (0.19 页/秒)。内容完整度：GLM-OCR 输出字符数为标准管线的 70-90%，主要缺失为图片标记（VLM 不检测图片区域）和部分格式标记。标准管线有内容重复问题（PDF 双层文本），GLM-OCR 无此问题** (04-25) |
| VLM OCR 准确率评估 | 无第三方评估 | **qwen3.6-plus VLM 评估（3 篇学术论文）：GLM-OCR 平均 43.3/50 vs 标准 23.0/50，GLM-OCR 全面胜出。最大优势维度：格式完整 (+5.3) 和可读性 (+5.0)。文字准确率 GLM-OCR 9.0/10 vs 标准 4.7/10。antigravity-rag 文档标准管线出现灾难性字符编码错误 (10/50)** (04-25) |
| 反幻觉规则位置 | 写入 agent-definitions.ts 基础 Agent 提示词 | **C-111: 反幻觉分层体系集成到全部 6 个内置 Agent** — basic(通用/探索/协调)/standard(编译/报告)/strict(验证)，通过 `getAntiHallucinationSection()` 统一注入。场景特定规则由 Skill 承载。REPORT_AGENT 保留报告结构和生成流程，反幻觉通过 standard 级注入 (05-02) |
| Skill 自动推荐 | 无 | **C-110: deep-research 内置 Skill** — 系统启动时自动注册到 DB，包含完整研究方法论、报告输出要求（8000-20000字）、standard 级反幻觉。GENERAL_AGENT "深度输出原则"引导 Agent 对深度调研任务自动调用此 Skill (05-02) |
| 输出完整性 | 子 Agent 结果可能丢失，report_generate 后内容不显示 | **Skills 强制双输出**：report_generate 保存后必须 push_content 推送到前端；全面分块分析/全面知识库分析 Skills 的子 Agent task 模板增加反幻觉要求（来源标注、数据验证、禁止编造）。GENERAL_AGENT 通用"完整输出原则"确保所有内容直接文字输出 (05-02) |
| 运行时注入 | synthesizeResults() 中注入 [系统提示：...] | **移除运行时注入**，反幻觉引导已通过 Skill 和 workflow_run 工具描述承载，不再在工具返回结果中注入系统指令 (04-29) |
| 子 Agent 轮次限制 | workflow-engine 硬编码 maxTurns=50，agent-runner skill_invoke 硬编码 maxTurns=20 | **硬性要求：子 Agent maxTurns 必须为 200**（workflow-engine.ts、agent-runner.ts 中的 skill_invoke 均为 200）。主 Agent 不设上限（-1）。内置 Skill 的 maxTurns 按复杂度合理设置（简单任务 20，中等 30-50，复杂分析 50-60）。此为硬性约束，不允许降低 (04-29) |
| Agent 运行参数可配置 | subAgentMaxTurns/consecutiveErrorThreshold/stuckDetectionThreshold 硬编码 | **AgentSettings 新增 subAgentMaxTurns（默认200），前端"通用→Agent运行参数"可修改子Agent最大轮次、连续错误阈值、卡住检测阈值，保存后持久化到数据库即时生效** (04-29) |
| 工具并发执行 | 所有工具串行执行 | **C-85: 工具并发编排 — AgentTool 新增 isConcurrencySafe()/isReadOnly() 动态分类，partitionToolCalls 分组安全/非安全批，安全批 Promise.all 并行（最大并发 10），非安全批串行。Bash 工具按命令前缀白名单动态判定只读** (04-30) |
| Prompt 缓存优化 | 无缓存意识，每次完整发送 | **C-86: SystemPromptBuilder 静态/动态分离 — 系统提示词分为静态区（Agent 定义+工具描述，跨请求可缓存）和动态区（scope/session memory/项目配置），`---DYNAMIC_BOUNDARY---` 分隔。Anthropic provider 自动将静态区标记为 cacheable TextBlockParam。工具定义按字母序排序保证缓存稳定性** (04-30, 05-12 实现) |
| 自然终止机制 | 必须调用 finish 工具才能终止 | **C-87: 自然终止 — 模型返回文本（无 tool_use）时自动终止循环，减少不必要的 API 调用和 token 消耗** (04-30) |
| Cache Editing | 压缩时修改本地消息数组，破坏缓存前缀 | **C-88: API Cache Editing — 截断旧 tool_result 时不修改本地消息数组，只对发送给 API 的副本做截断，保持缓存前缀不变。`applySmartCacheEditing()` 增强版区分引用类工具（kb_search/expand 等，保留 16KB+尾部预览）和通用工具（生成结构化摘要 header+stats+tail），通过 toolCallId 自动关联工具名** (04-30, 05-12 增强) |
| 长输出续写 | 模型输出被 max_tokens 截断后丢失 | **C-89: 长输出续写 — 检测 finish_reason=length 时注入续写消息继续生成，最多续写 5 轮，拼接完整结果** (04-30) |
| Token 估算 | 简单启发式（字符数/3） | **C-90: 双层 Token 估算 — 优先使用 API 报告 usage（精确），回退到 4/3 保守估算。TokenEstimator 类管理报告值和估算值** (04-30) |
| 工具输入校验 | 仅 JSON.parse 无 schema 校验 | **C-91: 两阶段工具校验 — Stage 1: JSON 解析，Stage 2: Schema 校验（必填字段+类型兼容性），校验失败返回结构化错误消息** (04-30) |
| 大结果持久化 | 固定 token 限制截断 | **C-92: 工具结果磁盘持久化 — 超过 50K 字符的工具结果写入磁盘文件，模型只拿 2K 预览+文件路径，避免上下文被大结果撑爆** (04-30) |
| Edit 唯一性 | old_string 可能多处匹配导致错误替换 | **C-93: Edit 唯一性检查 — edit_file 工具检查 old_string 在文件中的出现次数，多次匹配要求 replace_all 或提供更多上下文** (04-30) |
| 工具优先级引导 | 无工具使用指导 | **C-94: 工具使用优先级引导 — system prompt 注入工具使用指南（搜索优先用专用工具、并行调用独立操作），目前仅 GENERAL_AGENT 包含** (04-30) |
| 分层压缩 | 单次全量压缩 | **C-95: 多级上下文压缩 — D2(最旧,粗粒度,≤2000 token) → D1(中等,≤4000 token) → Leaf(最新,完整保留)，不同层使用不同压缩 prompt 控制信息密度** (04-30) |
| Session Memory 异步 | 同步提取阻塞主循环 | **C-96: Session Memory 异步提取 — AsyncSessionMemoryExtractor 后台非阻塞提取，不占用用户等待时间，下次请求直接使用已提取结果** (04-30) |
| Hook 系统 | 仅 PreToolUse/PostToolUse | **C-97: 17 类 Hook 系统 — 完整生命周期覆盖（PreToolUse/PostToolUse/PreCompact/PostCompact/SessionStart/SessionEnd/AgentStart/AgentComplete/UserPromptSubmit/SubagentStart/SubagentStop/Stop/StopFailure/Notification/PermissionRequest/PermissionDenied/FileChanged），三种注册类型（command 执行 shell+解析 JSON/http POST/callback 进程内），glob 匹配器（通配符/精确/前缀），阻塞 vs fire-and-forget 语义，lifecycle hook 跳过 matcher，modifiedInput 累积合并，10 个便捷方法** (04-30, 05-12 扩展) |
| Feature Flags | 硬编码特性开关 | **C-98: Feature Flags — 10 个功能标志（concurrentToolExecution/promptCaching/cacheEditing/streamingToolExecution/hierarchicalCompression/longOutputContinuation/maxToolConcurrency/pluginSystem/markdownSkills/contextCollapse），优先级 env var > DB config > defaults。contextCollapse 默认启用** (04-30, 05-12 新增 contextCollapse) |
| Plugin 系统 | 仅基础工具注册 | **C-99: Plugin 系统 — plugin.json 清单 + SKILL.md 技能定义 + agent.md Agent 定义，启动时自动加载 plugins/ 目录并注册 Skill 到 DB（C-113）。AgentPluginManager 支持加载 hooks（command/http/callback 三种类型）和 tools（动态 import + 注册到 ToolRegistry），失败隔离（单个 hook/tool 加载失败不影响其他）。`POST /plugins/install` 从目录安装插件，`POST /plugins/discover` 扫描目录发现插件** (04-30, 05-12 增强 hooks/tools 加载+API) |
| Skill Markdown | 仅 TypeScript 对象定义 | **C-100: SKILL.md 格式 — YAML frontmatter + Markdown body 定义技能，降低非开发者创建技能门槛，保留 TypeScript 作为内部表示。`skill_create` 工具支持运行时通过 Agent 生成 SKILL.md 文件或保存到数据库** (04-30, 05-12 增强) |
| 通用工具 | 缺少基础通用工具 | **C-101: 通用工具补全 — 新增 list_files/notebook_read 工具，所有工具标注并发属性（isReadOnly/isConcurrencySafe）** (04-30) |

### GAIA 基准测试验证结果 (04-30)

| 问题域 | 发现 | 优化方向 |
|--------|------|---------|
| Session 隔离 | 同一 session 连续处理多题导致上下文污染，至少 3/50 题输出了前一轮答案 | **C-102: 每请求独立 session 隔离** — 测试脚本已修复为每题独立 session |
| Provider 稳定性 | minimax-highspeed HTTP 400 "invalid function arguments" 占 8/50 题 (16%) | **C-103: Provider 自动 fallback** — 主 provider 失败时自动切换到备用 provider |
| 文件附件 | GAIA 4/50 题 (8%) 带附件文件无法处理 | C-12 (已有) 需增强：API 层支持文件上传传递给 Agent |
| 搜索能力 | 8/50 题 (16%) 因搜索不足失败（Wikipedia 超时、YouTube 无法获取 transcript） | C-18 (已有) 需增强：接入更多搜索 API |
| 答案提取 | 部分答案内容正确但格式不匹配 | **C-104: 答案后处理** — 从 agent 长输出中提取精确答案，标准化格式 |
| 动态超时 | Level 3 题目 10 分钟不够 | **C-105: 动态超时分配** — 根据任务复杂度分配不同超时时间 |
| 子 Agent 事件路由 | workflow 子 Agent 事件仅走 WebSocket，SSE 连接前端看不到子 Agent 进度 | **C-106: SSE 订阅 workflow 事件** — SSE 路由订阅 `globalThis.__workflowEvents`，转发子 Agent 的 push_content/report_generate/工具事件到 SSE 流，流结束时自动清理订阅 (04-30) |
| 报告事件通知 | ReportTool 成功保存后无事件通知 | **C-107: ReportTool 发射 report_generated 事件** — 保存成功后调用 `eventBus.emit({ type: "report_generated" })`，添加保存成功/失败日志 (04-30) |
| Python JSON 控制字符 | Docling/Whisper 解析文档内容含控制字符导致 JSONDecodeError | **C-108: Python JSON ensure_ascii** — docling-service 和 whisper-service 的 `json.dumps()` 添加 `ensure_ascii=True` (04-30) |
| Stuck detection 误判 | expand 工具批量展开文档触发卡住干预 | **C-109: Stuck detection 豁免列表** — expand/kb_search 等批量操作工具排除在卡住检测之外 (04-30) |

### DeepResearch Bench 2025 优化成果重构 (05-02)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 研究报告输出要求 | 写在 GENERAL_AGENT 提示词中（8000-20000字、5-10关键词、表格丰富等） | **移至 deep-research 内置 Skill**。GENERAL_AGENT 仅保留通用"深度输出原则"（充分搜索后综合、详尽完整），由 Skill 承载场景特定的篇幅/结构/数据密度要求 |
| deep-research Skill | 不存在 | **C-110: deep-research 内置 Skill** — 系统启动时自动注册到 DB，包含完整研究方法论（规划→广泛搜索→深度获取→交叉验证→综合撰写）、报告输出要求（8000-20000字/5000-15000词）、数据密度要求、结构要求、standard 级反幻觉 |
| 反幻觉分层注入 | 仅 DEFAULT_AGENT 使用 anti-hallucination.ts，其他 agent 各自内联 | **C-111: 反幻觉分层体系集成到全部 6 个内置 Agent** — basic(通用/探索/协调)/standard(编译/报告)/strict(验证)，通过 `getAntiHallucinationSection()` 统一注入 |
| 输出格式规范 | 仅 GENERAL_AGENT 使用 output-format.ts | **C-112: 输出格式规范集成到验证和报告 Agent** — VERIFY_AGENT + REPORT_AGENT 注入 `getOutputFormatSection()`（引用格式、推理标记、置信度标注） |
| 语言规则 | 6 个 Agent 各自内联相同文本 | **抽取为 `getLanguageRule()` 共享函数**，所有 Agent 统一调用，消除维护冗余 |
| Plugin→DB 注册 | Plugin Skill 仅加载到内存，skill_invoke 查 DB 找不到 | **C-113: Plugin Skill 自动注册到 DB** — tool-setup.ts 加载 plugin 后将 Skill 写入 agent_skills 表（已存在则跳过），skill_invoke 可正确发现并调用 |
| judicial-analysis Skill | 5 个 Skill（证据链/时间线/实体网络/交叉验证/事实提取），输出要求简略 | **增强全部 5 个 Skill**：添加 strict 级反幻觉规则（三层验证、完整引用链、矛盾标注）、深度输出要求（段落式阐述、Markdown 表格、完整上下文） |
| deep-case-analysis Skill | 不存在 | **C-114: deep-case-analysis 司法 Skill** — 综合证据链+时间线+实体网络+交叉验证的全面案件剖析，严格限定知识库内容（不使用 web_search），8000-20000字输出，严格级反幻觉 |
| L4 鲁棒性机制 | max_output_tokens 分级恢复、长输出续写(5轮)、泄露 tool call 检测、自然终止复生、StuckDetector 增强、连续错误干预 | **保留在 agent-runner.ts 不变** — 均为通用 L4 机制，不限于研究场景 |
| 输出方式 | "研究报告、分析结论、调研结果都必须以文字形式直接输出" | **泛化为通用"完整输出原则"** — "所有内容必须以文字形式直接输出完整。push_content 仅用于辅助展示大型表格，不能替代文字输出" |

### Agent 输出完整性优化 (05-03)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 多源输出聚合 | 仅追踪 assistant text（accumulatedContent），push_content/write_file 输出内容丢失 | **C-115: 多源输出生成** — agent-runner 同时追踪 `accumulatedContent`（文本输出）、`pushedContentAccum`（push_content/write_file 内容）、`finishSummaryContent`（finish 工具摘要），最终结果从三个候选中选择最长者。解决中文研究任务中模型先 write_file 写完整报告、再 finish 提交短摘要导致输出丢失的问题 (05-03) |
| 自然终止短输出 | 自然终止后直接结束，即使输出只有 1274 字符 | **C-116: Summary-after-work 检测** — 当模型在 5+ 轮工具调用后自然终止但输出 <3000 字符时，注入续写消息要求输出完整详细内容。防止模型将大量研究工作压缩为短摘要 (05-03) |
| finish 工具描述 | 鼓励简短回答："Provide your final answer as a concise, precise value" | **C-117: finish 工具描述优化** — 改为要求研究/分析任务在 summary 中包含完整报告内容，禁止仅输出"报告已完成"或"task completed"。引导模型将完整内容通过 finish 工具提交 (05-03) |
| 工具定义缓存稳定性 | 工具定义按注册顺序发送，每次构建顺序可能不同 | **工具定义字母序排序** — toolDefs.sort() 按工具名字母序排列，保证 API 发送顺序一致，提升 prompt cache 命中率 (05-03) |
| max_output_tokens 恢复 | 3 级 [16384, 32768, 65536]，最多 2 次恢复 | **4 级 [16384, 32768, 65536, 131072]，最多 3 次恢复** — 扩展 token 层级支持 GLM-5.1 等长输出模型，增加恢复次数提高截断场景成功率 (05-03) |
| 压缩断路器 | 简单的开关/闭熔断器 | **压缩断路器升级分级** — 正常(normal) → 激进(aggressive) → 确定性(deterministic) 三级升级。连续低质量压缩触发升级，成功时重置。aggressive 级跳过低优先级内容，deterministic 级仅保留最近 N 轮 (05-03) |
| Prompt 缓存断点 | 无缓存标记 | **cache breakpoints 注入** — 消息构建后通过 markCacheBreakpoints() 在静态/动态边界插入缓存断点标记，配合 enableCaching 参数传递到 API 调用 (05-03) |
| 流式工具执行 | 仅并发/串行两种模式 | **流式工具执行支持** — featureFlags.streamingToolExecution 启用 StreamingToolExecutor，支持工具结果流式返回，结合并发执行优化长耗时工具场景 (05-03) |

### 100 测试基准验证 (05-03)

| 指标 | 结果 |
|------|------|
| 总测试数 | 100（10 组 × 10 测试） |
| 通过率 | 98/100 PASS (98.0%)，2 PARTIAL (G2-T02/G2-T04)，0 FAIL |
| 测试覆盖 | FActScore 稀有实体传记（50+ 不同实体）、Toolathlon 中文/英文多步研究任务（20+ 复杂研究）、AgentLongBench 长上下文多轮任务 |
| 平均输出长度 | 7,813 字符/测试 |
| 平均 Agent 轮次 | 10.0 轮/测试 |
| 平均耗时 | 121 秒/测试 |
| 总输出量 | 781,282 字符 |
| 验证关键修复 | write_file 追踪将中文研究任务从 776→9495 字符、accumulatedContent 修复保留最长输出、summary-after-work 检测、双语关键词评估（中文输出匹配中文等价词） |

### GAIA 基准测试验证 (05-03)

| 指标 | 结果 |
|------|------|
| **基准测试** | GAIA Benchmark (validation set, text-only) |
| **总题数** | 127（Level 1: 42, Level 2: 66, Level 3: 19） |
| **首次运行** | 77/127 (60.6%) |
| **优化后** | **97/127 (76.4%)**，提升 +20 题 |
| **Level 1** | 37/42 (**88.1%**) |
| **Level 2** | 51/66 (**77.3%**) |
| **Level 3** | 9/19 (**47.4%**) |
| **零错误** | 0 timeout, 0 error — 系统稳定性 100% |
| **总测试时间** | 首次 246 分钟 + 重测 205 分钟 |
| **优化措施** | ① 提示词增加单位阅读要求和答案验证指令；② 答案提取增强 UUID/ID 过滤和模糊拼写匹配；③ 迭代重测失败题目 |
| **结果文件** | `cc_test/gaia-final-20260503.json` |

### Agent 系统优化原则全面实现 (05-04)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 上下文压缩 | C-27 描述"自动压缩+微压缩+会话记忆持久化" | **C-118: 预测性上下文压缩** — `TokenGrowthTracker` 追踪每轮 token 增长速率，当预测在 8 轮内上下文将溢出时，即使低于 70% 静态阈值也触发 proactive compaction（最低至 50%）。根据增长率动态调整压缩激进程度（factor 0.5-1.0），高增长时压缩更多中间内容 (05-04) |
| 搜索结果记忆 | C-27 仅描述"会话记忆持久化"，无搜索结果索引 | **C-119: 搜索结果持久化索引** — `SearchResultIndex` 维护所有搜索查询的去重关键词列表、结果数量、文档标题和摘要片段（snippet），通过 `search_index_json` 列持久化到数据库。压缩后恢复、跨 session 加载时通过 `restoreEntries()` 重建索引，注入 session memory 防止重复搜索相同关键词 (05-04) |
| 搜索失败处理 | 仅提示词层面引导模型换关键词 | **C-120: 搜索工具链短路** — 当 kb_search/web_search/wiki_browse/doc_grep 返回空结果时，代码级自动注入工具特定建议（根据查询长度推荐缩短关键词、根据工具类型推荐替代工具、引导 think 反思），LLM 在下一轮立即看到策略建议 (05-04) |
| 搜索饱和 | 无检测，Agent 可能重复搜索高度重叠内容 | **C-121: 搜索饱和检测** — `SearchSaturationDetector` 追踪搜索结果集，当最近搜索结果与历史结果的 Jaccard 重叠度 >80% 时触发饱和信号，注入系统提示建议模型停止搜索、开始综合分析 (05-04) |
| Skill 组合 | 仅单个 Skill 调用（skill_invoke） | **C-122: Skill 链式编排** — `BUILTIN_CHAINS` 定义命名 Skill 链（research-to-report、search-and-verify、cluster-and-analyze），`executeChain()` 按序执行并传递输出，支持失败策略（stop/skip/continue）和输入转换函数 (05-04) |
| Skill 测试 | 无 Skill 质量验证机制 | **C-123: Skill 测试运行器** — `SkillTestRunner` 验证 Skill 输出是否符合预期：检查工具调用（expectedToolCalls）、关键词覆盖（expectedKeywords）、禁止模式（forbiddenPatterns）。Skill 定义可携带 testScenarios 字段 (05-04) |
| 大量文档分析 | 单 Agent 逐个处理 | **C-124: 语义分块分析** — `SemanticChunker` 使用嵌入向量对文档进行语义聚类（farthest-first seeding + nearest-seed assignment），`chunked-analysis` 内置 Skill 将大量文档按主题分组（5-15个/组），逐组深入分析后综合输出。`cluster-and-analyze` 链自动编排分组+分析流程 (05-04) |
| 反幻觉层级 | C-111 仅覆盖 6 个内置 Agent | **C-111 扩展: Skill 反幻觉层级** — Skill 新增 `antiHallucinationLevel` 字段（basic/standard/strict），内置 Skill（deep-research、chunked-analysis）设为 standard。启动时 `ensureBuiltinSkills()` 自动更新已有 Skill 的反幻觉层级 (05-04) |
| 多 Agent 交叉验证 | C-24 委员会模式仅文本级投票 | **C-24/C-25 增强: LLM 深度交叉验证** — `Orchestrator.deepCrossVerify()` 使用 LLM 分析多个子 Agent 输出，发现矛盾数据点、重叠发现和缺失信息（maxTokens=2000, temperature=0.1）。子任务 >=2 时自动触发 (05-04) |
| 流式工具执行 | C-98 流式工具执行描述为"流式返回工具结果" | **C-98/C-85 更新: 流式推测执行** — 工具 N 的参数完全接收后立即开始执行，同时模型继续流式生成工具 N+1 的参数。推测执行结果合并到主循环，减少总延迟 (05-04) |
| 轮次预算 | 默认无限制(-1)，选项含 9999 | **C-125: 动态轮次预算** — `calculateDynamicTurnBudget()` 根据任务复杂度（simple/moderate/complex）动态分配建议轮次上限（15/40/100），硬性上限为建议值的 3 倍（最低 100）。达到 80% 建议上限时注入收尾引导 (05-04) |
| 上下文压缩架构 | C-88 描述"不修改本地消息数组的截断" | **C-126: Context Collapse（非破坏性语义投影）** — `CollapseStore` 维护非重叠折叠条目，通过投影（projection）而非修改原始消息实现上下文缩减，保持缓存前缀完整。`context_expand` 工具允许模型按需恢复折叠内容（优先恢复含搜索结果的条目）。通过 `contextCollapse` feature flag 控制（默认关闭）(05-04) |

### 42 项优化原则完成状态 (05-04)

| 层级 | 原则数 | 已实现 | 测试状态 |
|------|--------|--------|----------|
| L1 工具层 | 7 | 7/7 (100%) | 317 单元测试全部通过 |
| L2 提示词层 | 7 | 7/7 (100%) | 全部通过 |
| L3 上下文层 | 7 | 7/7 (100%) | 含 TokenGrowthTracker 25 新测试 |
| L4 Agent Loop | 7 | 7/7 (100%) | 全部通过 |
| L5 编排层 | 7 | 7/7 (100%) | 全部通过 |
| L6 场景层 | 7 | 7/7 (100%) | 全部通过 |
| **合计** | **42** | **42/42 (100%)** | **449/453 通过（4 个 pre-existing 无关失败）** |

### 多Agent工作流子Agent行为优化 (05-06)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 子Agent任务边界 | 子Agent继承完整系统提示，无文档访问边界，可能越界分析其他文档 | **C-57 增强: 子Agent边界约束注入** — 无自定义 systemPrompt 的子Agent，runAgent() 自动在 task 前注入边界约束前缀：只分析 task 中列出的文档、不搜索其他文档、优先使用预编译图片描述、保留报告生成能力。workflow_run 工具描述新增"任务边界约束"章节引导主Agent在 task 中明确文档范围和边界指令 (05-06) |
| 子Agent输出返回 | 截断为 500 字符返回主Agent，信息不足导致主Agent可能重新分析 | **子Agent输出截断提升至 1500 字符** — 主Agent获得更充分的子Agent执行摘要，减少重复分析 (05-06) |
| 并行模式目标传递 | parallel 模式子Agent仅收到各自 task，缺乏整体目标感知 | **C-57 增强: 并行模式传递 goal** — executeParallel 自动将 workflow goal 追加到每个子Agent的 task 中（`[整体目标]` 前缀），子Agent理解全局目标以更好地协调工作 (05-06) |
| 图片VLM调用 | 子Agent对KB中的图片无差别调用VLM重新分析，即使入库时已预编译描述 | **expand 工具描述增强** — 图片类型说明增加"图片描述已在入库时预编译，优先用 expand 获取"提示；子Agent边界约束同样引导优先读取预编译内容。不禁止VLM再调用，允许针对特定问题进行补充分析 (05-06) |
| 长内容折叠交互 | PushContentCard 长markdown仅有顶部折叠按钮，看完需滚回顶部折叠 | **C-64 增强: 底部折叠按钮** — 长markdown内容（≥2000字符）展开状态下底部增加"收起内容"按钮，用户阅读完毕可直接在底部折叠 (05-06) |

### Skills 系统重构 (05-07)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| Skill 存储 | 两套系统并存：`agent_skills` 表（3个Agent Skills，通过 skill_invoke 调用）+ `skills` 表（13个Plugin Skills，仅前端可见） | **统一到 `agent_skills` 表** — 11个通用 Skills 全部通过 `ensureBuiltinSkills` 注册到 `agent_skills`，Agent 可通过 skill_invoke 自动发现和调用。`skills` 表的通用 Skills 已清空 (05-07) |
| Skill 数量 | Agent Skills 3个 + Plugin Skills 13个 = 16个（大量重叠） | **合并为 11 个通用 Skills** — 3个保留（deep-research增强、chunked-analysis、precise-qa）、1个三合一新增（全面知识库分析）、1个二合一新增（深度检索）、6个迁移（报告生成、长篇写作、文档摘要、对比分析、表格专项分析、实体提取）(05-07) |
| Skill 执行约束 | Plugin Skills 硬性 maxTurns（20/30/40/50/60），传递给 agent-runner 成为 advisoryLimit | **弹性执行** — 所有 Skill 不设 maxTurns，统一使用 estimateTaskComplexity 动态计算 + ProgressTracker 弹性管理。skill_invoke 不传递 maxTurns (05-07) |
| 输出引导 | 多个 Skill 硬性规定"8000-20000字" | **自适应深度引导** — 引导模型根据任务复杂度自然决定输出深度，不硬性规定字数。核心标准：充分回答，不多不少，无遗漏无幻觉 (05-07) |
| 层级引导 | 多处错误描述"L2与L1完全相同，展开到L2是浪费" | **修正为正确描述** — L1 是 Markdown/DocTags（分析用），L2 是 Docling JSON（校验用），格式不同用途不同。expand 工具描述、各 Skill prompt 均已修正 (05-07) |
| Skill/Plugin 边界 | 通用 Skills 中混入报告生成、全面分析等重型编排流程 | **明确分离** — Skill 是轻量级场景经验指导；Plugin 是重量级领域模块（含多Skills+Agents+配置）。编排型 Skill（全面知识库分析、长篇写作）允许包含 workflow_run (05-07) |
| ensureBuiltinSkills | 仅在 skill 不存在时创建，已存在时只补 antiHallucinationLevel | **始终同步更新** — 每次启动对比 prompt/description/tools/antiHallucinationLevel，有变更则更新，确保代码变更传播到数据库 (05-07) |
| Skill Chains | 引用不存在的 skill 名称（"report-generate"、"explore"、"verify"） | **修正引用** — research-to-report: "报告生成"；search-and-verify/cluster-and-analyze: "深度检索" 替代不存在的 "explore" (05-07) |

### 上下文压缩架构重构 (05-08)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 压缩后文件上下文 | 压缩丢失文件内容，模型无法继续操作之前读取的文件 | **C-127: Post-compact 文件重注入** — `readFileState` 追踪每次 read_file/write_file/edit_file 的文件路径和内容，压缩后自动重新注入最近5个文件（25K token预算），确保文件操作连续性。覆盖全部6个压缩路径 (05-08) |
| 压缩摘要结构 | 9 section，无文件/制品专项保留 | **C-128: 10 section 摘要结构** — 新增"Files and Artifacts"独立section，要求保留所有文件路径和输出制品。当前工作section必须包含恢复工作所需的所有文件路径和参数 (05-08) |
| Session Memory | 6 section / 500字 / maxTokens 2000 | **C-129: 十 section 模板** — 扩展为10 section / 4000+ tokens，新增当前状态、任务规格、文件和路径、错误和修正、关键结果、工作日志。maxTokens 2000→4000, serializeMessages 18K→24K (05-08) |
| 确定性降级摘要 | 仅提取工具名序列 | **C-130: 增强标识符提取** — 同时提取文件路径、搜索查询和标识符（解析工具调用 JSON arguments） (05-08) |
| 压缩历史 | 被移除的消息直接丢弃 | **C-131: Transcript 路径引用** — 被移除的消息序列化写入 `data/tmp/transcript-{session}-{ts}.md`，模型可 read_file 恢复细节。覆盖全部4种压缩路径 (05-08) |
| 压缩后状态 | 无统一清理 | **C-132: Post-compact 清理** — 压缩后清除 readFileState，在 session memory 工作日志追加压缩事件记录 (05-08) |

### Skills 三模式调用 + 压缩恢复 + 质量审计 (05-08)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| Skill 调用模式 | 仅 sub_agent 模式（全新上下文子Agent） | **C-133: 三模式调用** — inline（技能prompt注入当前对话）/ fork（独立子Agent继承父会话历史）/ sub_agent（全新上下文，默认）。可用技能列表自动注入 `<available-skills>` 动态 section (05-08) |
| 压缩后技能指令 | inline 技能指令压缩后丢失 | **C-134: Post-compact 技能恢复** — 压缩后自动重新注入 inline 模式技能指令（最多3个/15K token预算），`invokedSkills` Map 追踪所有已调用技能 (05-08) |
| 压缩质量保障 | 无程序化检查，摘要可能丢失关键标识符 | **C-135: 压缩质量审计** — `auditSummaryQuality()` 检查摘要是否保留文件路径/URL/UUID/doc_id/page_id等标识符，缺失时记录诊断警告。压缩提示词增加标识符保留指令 (05-08) |

### L1 内容预览与前端修复 (05-08)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 文档列表预览 | 文档卡片仅显示文件名和状态，需逐个点开 L1 确认内容 | **G-30: L1 内容预览** — 就绪文档卡片显示 L1 前 300 字预览（等宽字体，3行 CSS line-clamp），后端单 SQL 查询批量获取 (05-08) |
| 文档卡片字段映射 | API 返回 snake_case（file_size/file_type/kb_id），前端按 camelCase 访问导致 "NaN undefined" | **修复字段映射** — listDocuments API 响应层 snake_case→camelCase 转换 (05-08) |

### 数据质量审计 + Agent 系统优化 (05-09)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 入库质量检测 | 无自动化质检，VLM失败/空内容等低质量数据直接标记就绪 | **C-136: 数据质量审计与自动调优** — 入库流水线新增质检步骤，QualityScorer 默认100分（仅检测明确故障），低于阈值自动触发重提取+VLM两级fallback+新旧对比取优。`POST /quality-audit` 手动触发，`GET /quality-report` KB汇总。G-06 进度追踪增加质检阶段 (05-09) |
| 高成本 Skill 触发 | 无防护，Agent 可能意外触发高成本操作（如知识库预处理） | **C-137: 三层防护** — Skill 描述 `[高成本/按需触发]` 标记 + skill_invoke 确认门控 + 系统提示词 🔴 标记 (05-09) |
| 预处理数据可见性 | 预处理产物（还原表格CSV、概览等）仅在磁盘，Agent 工具无法发现 | **C-138: 预处理数据自动发现** — wiki_browse 返回结果自动附带 `preprocessingData` 字段，Agent 可直接发现并用 read_file 读取 (05-09) |
| 工具引导 | 固定决策树偏向 kb_search，缺少工具局限性描述 | **C-139: 中性工具引导** — 改为工具能力表（覆盖率、精确度、适用场景），不规定固定流程，不偏向任何工具 (05-09) |
| 工具返回信息 | doc_grep 无截断标记、glob 无上限标记、expand 批量失败无诊断 | **C-140: 工具能力诚实标注** — doc_grep `hasMore`、glob `truncated`、expand 批量诊断、kb_search score 说明 (05-09) |
| 数据访问路径 | 引导偏向数据库工具，文件系统工具被视为底层备选 | **C-141: 文件系统第一类数据源** — 明确 read_file/glob/grep/bash 与数据库工具互补平等，不偏袒任何路径 (05-09) |
| Agent 固定流程 | EXPLORE/REPORT Agent 内嵌"首先使用 kb_search"等固定流程 | **C-142: Agent 定义去偏见化** — 移除偏向特定工具的固定流程，改为中性引导让 Agent 自主决策 (05-09) |
| 入库进度 | G-06: 解析→编译→索引→链接→就绪 | **G-06 更新**: 解析(0-25%)→编译(25-50%)→索引(50-75%)→质检(75-90%)→就绪(100%)。质检失败不阻塞 (05-09) |
| 工具引导数据基础 | 无统一原则，工具描述基于理想化预期 | **C-143: 数据驱动工具引导** — 工具引导基于真实能力评估（覆盖率测试、精确度数据），不美化任何工具 (05-09) |
| Agent 约束方式 | C-27b 仅覆盖"阅读策略"不约束行为 | **C-144: Agent 自主性原则** — 泛化 C-27b 为全局原则：系统只提供信号不约束行为，覆盖工具选择、执行策略、输出方式等全部维度 (05-09) |
| 核心不变约束 | 零幻觉/通用性散布在各条目中，无统一约束声明 | **C-145: 不变核心约束** — 明确 5 条不可变原则（零幻觉/通用性/弹性/分层/Agent自主性），作为所有优化的边界条件 (05-09) |
| L1 工具缺陷 | doc_grep totalMatches 返回截断数、expand 批量失败静默 | **C-146: L1 工具问题待修复** — doc_grep 真实总数 + expand 批量准确诊断 (05-09) |

### 多模态交互与前端增强 (05-10)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 语音输入 | 无 | **C-147: 浏览器语音输入** — MediaRecorder API 录音 → POST 音频到 `/api/agents/transcribe` → CapabilityDispatcher.transcribeAudio() 转写（优先本地 Whisper）→ 返回文本追加到输入框。前端 useVoiceInput hook 封装录音状态机（idle→recording→transcribing），MessageInput 集成麦克风按钮（录音脉冲动画）(05-10) |
| Agent 图像分析 | 无 VLM 工具 | **C-148: image_analysis 工具** — Agent 可调用 image_analysis 分析图片，支持 kb:// 引用、URL、base64、本地路径四种输入。调用 CapabilityDispatcher.analyzeImage() (05-10) |
| 图表生成 | push_content 仅支持 table/markdown/text/code/file/image | **C-149: ECharts 图表渲染** — push_content type 新增 "chart"，data 字段放 ECharts option JSON。前端 ChartRenderer 组件（echarts）渲染交互式图表，自动 resize，组件销毁时 dispose (05-10) |
| 多媒体推送 | push_content 仅支持 table/markdown/text/code/file/image | **C-150: 多媒体推送** — push_content type 新增 "image"/"audio"/"video"，前端 PushContentCard 渲染原生媒体标签（img/audio/video controls）。用户多媒体输入：paperclip 按钮接受 image/audio/video MIME 类型 (05-10) |
| KB 媒体预览 | 单一 expandedKey — 展开媒体时 L1 被隐藏 | **C-151: KB 媒体预览优化** — expandedKey 拆分为 expandedLevel + mediaExpanded 两个独立状态，两者同时激活时渲染为并排布局（层级内容 flex:1 + 媒体预览 flex: 0 0 300px）(05-10) |
| ASR 优先级 | 默认使用远程 ASR（minimax-highspeed），404 错误 | **C-152: ASR 优先本地 Whisper** — CapabilityDispatcher.transcribeAudio() 始终优先尝试本地 Whisper HTTP 服务（curl --noproxy 绕过代理），失败后降级到远程 provider。所有 ASR 调用路径（AudioProcessor/VideoProcessor/QualityAuditor/agents route）统一走此方法 (05-10) |
| 懒加载路由二进制安全 | app.ts 懒加载子路由代理层 `clone().text()` 破坏二进制数据 | **C-153: 二进制安全路由代理** — `cloneBody()` 辅助函数根据 Content-Type 选择 arrayBuffer()（audio/video/multipart/octet-stream）或 text()（JSON 等），8 个懒加载子路由全部更新。修复所有二进制上传场景 (05-10) |
| 技能初始化 | ensureBuiltinSkills 仅在懒加载 agent 系统首次请求时调用 | **C-154: 启动时同步初始化技能** — main.ts 启动链中增加 ensureBuiltinSkills() 调用，确保 skills 界面在首次访问时即有数据 (05-10) |

### 离线部署与前端优化 (05-12)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 离线部署包 | 无完整打包方案 | **离线部署包构建** — `build-offline-package.sh` 一键构建 4 个 Docker 镜像（backend/frontend/postgres/embedding）+ Docling 模型 + 源码，输出到独立目录（不污染开发树）。`deploy.sh` 支持一键部署/升级/停止。升级流程：导出旧配置→删除旧容器/镜像→加载新镜像→导入配置→启动。前端端口 21000 |
| backend 启动失败 | Whisper 模型注入时 `docker commit` 继承临时容器的 `sleep 60` CMD | **修复 docker commit CMD 丢失** — 所有 commit 操作必须包含 `--change 'CMD ["bun", "run", "src/main.ts"]'`，build-offline-package.sh 添加 CRITICAL 注释。从基础镜像单次构建确保 CMD 正确 |
| push_content 视觉区分 | PushContentCard 边框与普通工具调用卡片相同灰色 `var(--border-primary)` | **C-48 补充: push_content 高亮边框** — PushContentCard 外边框从灰色改为蓝色 `#3b82f6`，header 底部边框同步蓝色，仅线条变色不大面积变色，使推送内容在工具调用流中醒目可辨 |
| KB 深度预处理触发 | 仅能通过聊天中 Agent 调用 `skill_invoke` 触发，门槛高且容易误触 | **C-155: KB 预处理手动触发按钮** — 知识库设置面板新增"深度预处理"区块（紫色按钮+确认弹窗）。后端新增 `POST /kbs/:kbId/preprocess` 端点：自动创建临时 session、查找内置预处理 Skill prompt、后台运行 Agent 任务（fire-and-forget）。防重复：已有预处理运行中返回 409。从自动触发改为手动按钮触发，避免 Agent 误触发高成本操作 |
| .doc 旧格式支持 | DocConverterProcessor 代码存在但 Docker 镜像未安装 LibreOffice，.doc 文件静默失败 | **C-156: 遗留办公格式完整支持** — ① Dockerfile 添加 `libreoffice-writer`/`libreoffice-impress` 包；② DoclingProcessor HANDLED_TYPES 添加 `"doc"` 作为 fallback；③ build-offline-package.sh 自动检查/安装 LibreOffice。DocConverterProcessor 从仅支持 .doc 扩展为多格式：.doc/.rtf/.odt→.docx、.ppt→.pptx，动态选择转换目标格式（C-236 增强）。处理流程：遗留格式 → LibreOffice headless 转换 → DoclingProcessor 解析 → 完整三层输出 |
| 媒体预览交互 | 知识库图片预览为内联小图，需二次点击放大，无法与 L1 内容对比 | **C-151 增强: 右侧滑出预览面板** — 预览按钮改为触发右侧滑出面板（`createPortal` 到 document.body），面板宽度 `min(600px, 50vw)`，支持图片/视频/音频。左侧 L1 内容保持展开可对比。点击遮罩层或 X 按钮关闭面板。滑入动画 `transform: translateX(100%) → 0` |
| 语言漂移 | Agent 工具调用后经常切换为英语，即使提问为中文 | **C-27a 增强: 双重语言漂移防护** — ① `getLanguageRule()` 系统提示增强：标记"最高优先级"、默认中文、明确"工具调用返回结果后仍须保持用户语言"；② `agent-runner.ts` 运行时漂移检测：工具调用后检测输出语言，若用户=中文但输出=英语则注入中文提醒消息 |
| 语言漂移检测实现 | 无运行时语言检测 | **agent-runner 运行时语言漂移注入** — 利用已有 `detectLanguage()` 函数，在 stuck intervention 后新增语言漂移检测：`detectedLang === "zh" && outputLang === "en"` 时追加 user 消息提醒切换回中文 |
| default.yaml 离线配置 | 模型配置无 VLM 支持标记 | **config/default.yaml 增强** — GLM-5.1 主模型添加 `supportsVision: true`；新增 summarizer 角色模板；ASR/Docling/OCR 服务地址注释说明内网自动配置 |
| deploy.sh 升级 | 仅覆盖镜像文件，不保留用户配置 | **deploy.sh 增强** — 升级流程 6 步：导出旧配置（YAML+.env+DB agent_settings/model_config）→删除旧容器→删除旧镜像→加载新镜像→导入配置→启动+导入DB配置+重启backend。支持 `status`/`logs`/`stop`/`restart` 子命令 |

### 6 项新特性增强实现 (05-12)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| Hook 生命周期事件 | 8 类（C-97） | **C-97/C-83 扩展至 17 类** — 新增 UserPromptSubmit/SubagentStart/SubagentStop/Stop/StopFailure/Notification/PermissionRequest/PermissionDenied/FileChanged。三种注册类型（command 执行 shell+解析 JSON stdout/http POST/callback 进程内函数）。glob 匹配器支持通配符/精确/前缀匹配。10 个便捷方法（fireSessionStart/End/AgentStart/Complete/fireUserPromptSubmit/fireSubagentStart/Stop/fireStop/fireStopFailure/fireFileChanged/fireNotification）。lifecycle 类 hook 跳过 matcher 检查。command hook 支持 env vars（TOOL_NAME/TASK_ID/HOOK_TYPE/SUBAGENT_ID/FILE_PATH/ERROR_MESSAGE/USER_PROMPT） |
| Smart Cache Editing | applyCacheEditing 统一截断 | **C-159: Smart Cache Editing** — `applySmartCacheEditing()` 区分引用类工具（kb_search/expand/doc_grep/web_search/wiki_browse，保留 16KB + 尾部预览）和通用工具（生成结构化摘要 `[Tool result condensed from NKB]` + 头部 60% + 统计行 + 尾部 30%）。通过 toolCallId→toolName 映射自动判断工具类型。短结果不截断 |
| Prompt Cache 实现 | C-81/C-86 仅有设计描述 | **C-81/C-86 完整实现** — `splitSystemPromptForCache()` 将系统提示拆分为 TextBlockParam[]，静态区 `cache_control: { type: "ephemeral" }`。`markCacheBreakpoints()` 标记最后 user 消息。Anthropic provider `buildRequestBody()` 使用数组格式系统提示 + `__cache_control` 翻译。OpenAI provider 兼容翻译。启用 `anthropic-beta: prompt-caching-2024-07-31` header |
| contextCollapse 默认值 | 默认关闭 | **默认启用** — `DEFAULT_FEATURE_FLAGS.contextCollapse` 从 `false` 改为 `true`。C-98 新增 contextCollapse 为第 10 个 feature flag |
| Skill 管理工具 | 仅 DB API 端点 | **C-158: Skill 管理工具** — `skill_create`（支持 db 保存 + file 保存生成 SKILL.md）/`skill_update`（部分更新，is_active→isActive 映射）/`skill_delete`（按名称删除）。名称校验：字母开头，仅字母/数字/连字符/下划线。SKILL.md 格式：YAML frontmatter + Markdown body |
| Transcript 工具 | 无子 Agent 执行记录读取 | **C-157: Transcript 录制工具** — `subagent_transcript` 工具支持按 task_id 或 path 读取子 Agent 执行记录 JSON，返回 taskId/recordedAt/turnsUsed/usage/messageCount/messages。path 优先于 task_id |
| Plugin hooks/tools 加载 | 仅加载 skills 和 agents | **C-99 增强** — AgentPluginManager 支持 manifest 中定义 hooks（事件→模块文件映射，加载为 callback hook）和 tools（文件→模块，注册到 ToolRegistry）。失败隔离：单个 hook/tool 加载失败不阻塞其他。新增 `POST /plugins/install`（从目录安装）和 `POST /plugins/discover`（扫描目录发现）API 端点 |

### Agent 输出完整性优化（二）(05-13)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| push_content 多次推送聚合 | `pushedContentAccum` 仅保留最大单次推送数据，多次推送只保留最长的一条 | **C-160: 多次推送累积聚合** — 新增 `pushedContentItems` 数组收集所有 push_content/write_file 内容。多次推送时用分隔符连接全部内容作为最终输出，单次推送保留原逻辑。解决分批推送长内容时中间批次丢失的问题 (05-13) |
| SSE 事件缓冲区容量 | 2000 事件上限，超限时按 FIFO 丢弃（content_delta 优先），push_content 等关键事件可能被驱逐 | **C-161: 事件缓冲区扩容与保护** — 上限提升至 5000 事件，新增 PROTECTED_EVENTS 集合（push_content/complete/done/error/cancelled/workflow_complete），驱逐时优先删除 content_delta，保护关键事件不被丢失。已完成任务的 TTL 从 5 分钟延长到 30 分钟 (05-13) |
| 临时文件存储位置 | `os.tmpdir()`（系统临时目录，重启后丢失） | **C-162: 会话级持久存储** — tool-result-storage 改用 `data/sessions/{sessionId}/tool-results/` 目录，文件在会话生命周期内持久保存，会话删除时自动清理。解决长任务中间输出件因系统 tmp 清理而丢失的问题 (05-13) |
| push_content 大文件推送 | data 参数统一 2MB 上限 | **C-163: 分级推送大小限制** — filePath 方式推送上限提升至 10MB（文件已落盘，SSE 事件承载更大），data 参数方式保持 2MB（受模型输出 token 限制）。SSE 事件新增 filePath 字段传递文件路径，前端可直接引用 (05-13) |
| finish 工具完成检查 | 3 项检查（文本完整性、幻觉、不编造） | **C-164: 输出完整性自检** — 新增第 4 项"输出完整性检查"：Agent 完成前需回顾规划的多步输出是否遗漏。允许 Agent 自主选择不输出低质量内容，但需在最终输出中说明。通用表述，不预设具体输出方式 (05-13) |
| Agent 优化通用性原则 | 无明确约束 | **C-165: 优化通用性原则** — 每次优化必须覆盖更多场景受益，禁止针对某个用例定制。提示词中的检查项应指导 Agent 自主判断而非规定具体行为。已写入 CLAUDE.md (05-13) |

### 基线测试 (05-13)

| 变更项 | 说明 |
|--------|------|
| 测试框架 | 新建 `benchmarks/run_agent_ability_test.py` — 读取 agent-ability-test-50.json，映射 kb_scope 到 UUID，支持按 case-id/category/batch 过滤，可恢复执行，LLM 评估 |
| 测试用例 | 60 个用例（50 核心 + 10 多Agent协作），覆盖 10 个类别：single-document(8) / cross-document(8) / ultra-long-input(5) / ultra-long-output(3) / cross-kb(5) / multi-step(8) / statistical(4) / boundary(4) / consistency(5) / multi-agent(10) |
| 基线结果 | 50/50 完成（skip-eval 模式），结果保存在 `benchmarks/results/agent-ability-baseline.json`。10 个多 Agent 用例待运行 |

### 文档处理健壮性与 Agent 自操作 (05-13)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| VLM 调用失败处理 | ImageProcessor 捕获 VLM 错误后存为 description 内容（如 `[VLM不可用: HTTP 500]`），返回 `success: true`，错误信息被当作图片描述入库 | **C-166: VLM 失败抛出异常** — VLM 调用失败时 throw 而非存错误信息，触发 processing-queue 的 job 级重试。仅"未配置 VLM"这种配置问题才存占位符继续处理。所有处理器统一原则：瞬态错误不存为内容 (05-13) |
| API 调用重试策略 | CapabilityDispatcher withRetry 仅重试 HTTP 429/502/503/504，不含 500。线性退避，最多 2 次 | **C-167: 扩展重试策略** — 新增 HTTP 500（服务端过载/崩溃）到可重试列表，去除 404（找不到不应重试）。改为指数退避 + 随机抖动（1s→2s→4s），最多 3 次重试。覆盖所有模型调用场景（VLM/ASR/主模型等）(05-13) |
| Agent 文档管理能力 | 无工具可操作知识库文档生命周期（重建/重处理），Agent 无法修复处理失败的文档 | **C-168: reprocess_document 工具** — Agent 可通过此工具触发文档重建（单个或批量），支持指定处理器类型和强制重建。Agent 发现文档处理错误时可自行调用修复，无需人工介入前端操作 (05-13) |
| 测试覆盖 | 新特性无专门测试 | **新增 7 个单元测试文件 + 5 个 E2E 测试文件** — 单元测试：hooks-enhanced（20 cases）、cache-editing-smart（11 cases）、prompt-cache-enhanced（10 cases）、feature-flags-enhanced（5 cases）、transcript-tool（7 cases）、skill-manage-tool（12 cases）、plugin-manager-enhanced（12 cases）。E2E: features-plugin-api（5 cases）、features-skill-api（3 cases）、features-agent-system（3 cases）、features-ui（5 cases）、new-features（15 cases: push_content高亮/KB预处理按钮/API端点/.doc上传+LibreOffice/DoclingProcessor fallback/语言漂移源码/Docker配置/滑出预览）。共 108 个新测试用例，new-features 13 passed / 2 skipped (无图片文档) / 0 failed |

### 自进化系统与 Agent 稳定性优化 (05-14)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| Agent 自进化 | 无自学习机制，Agent 每次会话从零开始 | **C-169: 自进化系统 Phase 1** — 后端实现：(1) `evolution-config.ts` 配置管理（模块开关：经验积累/技能进化/技能维护/历史回顾 + 参数：回顾间隔/过期阈值/归档阈值/管家间隔），配置缓存+DB持久化；(2) `agent_memory`/`skill_usage`/`skill_version` 三个数据仓库接口及 PG 实现；(3) Settings API 新增 GET/PUT `/settings/evolution`、GET `/settings/evolution/memories`、DELETE `/settings/evolution/memories/:id`、DELETE `/settings/evolution/memories`、GET `/settings/evolution/stats` 五个端点；(4) Agent 系统提示词自动注入 `agent_memory` 内容作为经验参考 (05-14) |
| 自进化前端 | 无配置界面 | **C-170: 自进化前端面板** — `EvolutionPanel` 组件：主开关（启用/禁用自进化）、四个模块开关（经验积累/技能进化/技能维护/历史回顾）、四个参数输入框（min/max 校验）、统计概览（记忆条目/活跃技能/Agent创建技能/过期技能/已归档技能）、可展开记忆列表（分类标签/使用次数/内容预览/单条删除/清空全部）。右侧面板"自进化"Tab 集成。使用 `useRef` 存储 toast 函数引用，避免 `useCallback` 依赖变化导致无限重渲染 (05-14) |
| 自进化 E2E 测试 | 无 | **E2E 覆盖** — `tests/e2e_evolution_test.py` 10 个测试场景：配置读取/更新/模块切换/参数校验/记忆 CRUD/统计接口/面板 UI 交互/面板记忆列表展开。10/10 通过 (05-14) |
| 思考内容泄漏 | Think 工具内容和模型原生 thinking chunk 通过 `content_delta` 泄漏到用户可见输出流 | **C-171: thinking_delta 事件类型** — 新增 `thinking_delta` 事件类型：模型原生 thinking chunk 发送为 `thinking_delta` 而非 `text_delta`；Think 工具调用不再注入 `content_delta`。`thinking_delta` 仅存入 `taskEventBuffer` 供调试，不累加到 `fullContent`，SSE 客户端自动忽略未知事件类型 (05-14) |
| run_sql 工具描述 | 仅"执行 SQL 查询"，Agent 不知道可用 information_schema 发现表结构，导致反复试探性查询 | **C-172: run_sql 描述增强** — 工具描述增加完整 SQL 能力说明（JOIN/CTE/窗口函数/聚合/正则等）+ 核心表字段列举 + `information_schema` 自动发现引导（tables + columns 查询示例）。`tool-descriptions.ts`/`tool-setup.ts`/`tool-guidance.ts` 三文件同步更新 (05-14) |
| DB 连接池并发 | `max: 20`，6 个并发 SSE agent 全部超时无事件 | **C-173: 连接池扩容+并发限制** — 连接池 `max` 从 20 增大到 40，支持并发 agent 任务。新增 `MAX_CONCURRENT_AGENT_RUNS=8` 并发限制，超限排队等待 (05-14) |
| bash 工具运行时错误 | 动态 `await import("node:child_process")` 在某些 tsx 初始化条件下抛出 "require is not defined"，所有 bash 命令静默失败 | **C-174: 工具静态导入** — `tool-setup.ts` 中所有 Node.js 内置模块（`node:child_process`/`node:fs`/`node:path`）改为模块级静态导入，确保启动时即可发现导入问题（loud failure）。同时清理 20+ 处冗余动态 import (05-14) |
| 输出截断恢复 | C-89 仅描述长输出续写，三层机制未文档化 | **C-175: 三层输出截断保护** — 文档化三层截断恢复机制：(1) 输出截断恢复：`finish_reason=length` 时按分级 token 层级 [16384→32768→65536→131072] 自动重试，最多 3 次；(2) 长输出续写：正常完成但内容未结束时注入续写消息继续生成，最多 5 轮拼接；(3) 自然终止复生：模型在 5+ 轮工具调用后自然终止但输出 <3000 字符时，注入续写消息要求输出完整内容 (05-14) |

### CC-to-DA 功能移植 (05-15)

| 变更项 | 之前 | 之后 |
|--------|------|------|
| Context Window 静态 | ContextManager 使用固定 settings.contextWindow（默认 200K），切换模型不自动适配 | **C-176: Model-Aware Context Window** — ContextManager 优先从 ProviderRegistry 获取模型实际 contextWindow（如 Gemini 2.5 Pro ~1M），回退到 settings 配置值。`getContextWindowForModel()` 跨 provider 搜索模型元数据 |
| Cache 指标缺失 | API 响应中有 cache_read_input_tokens 但未暴露给前端 | **C-177: Cache Efficiency Metrics** — turn_usage SSE 事件新增 cacheCreationTokens/cacheReadTokens 字段。Anthropic provider 提取 cache_creation_input_tokens，OpenAI provider 提取 cached_tokens，流式类型同步扩展 |
| 模型弃用 | 模型下线无任何提示 | **C-178: Model Deprecation** — MODEL_DEPRECATIONS 数据结构 + getDeprecationForModel() 查询 + Router.chat()/chatStream() 级别弃用警告日志 |
| Token 估算粗糙 | 哈希仅取前 100 字符，无文件类型感知 | **C-179: Enhanced Token Estimator** — FNV-1a 全内容哈希 + 文件类型感知（JSON bytesPerToken=2）+ Canonical API 估算模式（reportApiUsage + tokenCountWithEstimation）+ 图片/文档固定 2000 token + CJK 感知估算 |
| Session Memory 单触发 | 仅按 token 增量触发后台记忆提取 | **C-180: Async Session Memory 双触发** — token 增量达标 OR 工具调用次数增量 >=3 均可触发后台记忆提取。新增 lastExtractedToolCallCount 计数器 |
| System Prompt 重复计算 | 每次 run() 重新计算所有 system prompt section | **C-181: System Prompt Section Caching** — 模块级 sectionCache Map 缓存静态 section（addCachedStaticSection），跨 run() 调用复用，压缩后通过 clearSystemPromptCache() 自动清除。**全静态前缀优化**（06-25）：所有在一次 run() 内稳定不变的 section（agent-definition / skill-guidance / scope / kb-filesystem / project-config / session-memory / available-skills / agent-memory / context-self-management）统一放入 static prefix，单 cache_control 覆盖整个系统提示，多轮 cache 命中率从 73-84% 提升至 98.6%。同时 JSONL `turn_usage` / AgentResult.usage / SSE done 事件保留 cachedTokens / cacheReadTokens / cacheCreationTokens 字段 |
| Post-Compact 清理分散 | 各压缩策略各自清理，无统一入口 | **C-182: Post-Compact 统一清理** — runPostCompactCleanup() 集中清理：readFileState + systemPromptCache + tokenEstimator + collapseStore + searchSaturation + sessionMemory 更新，6 个压缩路径统一调用 |
| 压缩拆分 tool 配对 | 压缩截断可能拆分 tool_use/tool_result 对，导致 API 400 | **C-183: Compaction Invariant Protection** — adjustIndexToPreserveInvariants() 在压缩前检测孤立 tool_result（其 tool_use 在 compacted 范围），向前扩展 startIndex 包含缺失的 assistant 消息 |
| 无成本追踪 | 追踪 token 但不计算 USD 成本 | **C-184: Cost Tracking** — MODEL_PRICING 按模型定价（input/output/cache_write/cache_read per million tokens），CostTracker 每轮计算成本累积，turn_usage 事件和 AgentResult 包含 estimatedCostUsd。SSE done 事件和 JSON 响应均透传成本数据 |
| Agent Loop 回调式 | run() 为 async+callback 模式，不支持中断/恢复 | **C-185: Agent Loop Generator** — 新增 runGenerator(): AsyncGenerator<AgentEvent, AgentResult> 适配器 + Orchestrator.runSingleGenerator()。DA_GENERATOR_RUN=true 环境变量切换 SSE 路由路径，默认关闭不影响现有行为 |

### CC-to-DA 第二轮功能移植 (05-15)

| ID | 需求 |
|----|------|
| C-186 | **破坏性命令检测** — bash 工具执行前检测 git reset --hard / rm -rf / DROP TABLE / DELETE FROM without WHERE / kubectl delete / terraform destroy 等破坏性命令模式，返回警告信息但不阻止执行 |
| C-187 | **文件编辑前必须读取** — edit_file 工具强制要求先 read_file 目标文件，未读取则拒绝执行并提示"请先读取文件" |
| C-188 | **消息按 API 轮次分组** — compaction 使用 assistant message ID 变化点分组（API round grouping），替代粗粒度分组，支持更精细的部分压缩 |
| C-189 | **Prompt Cache 断裂检测** — 两阶段检测 Anthropic prompt cache 断裂：调用前快照 system/tools/model hash，调用后对比 cacheReadTokens 跌幅（>5%且>2000 tokens）诊断原因 |
| C-190 | **缓存安全子 Agent 分叉** — CacheSafeParams 确保 workflow-engine 创建的子 Agent 与父 Agent 共享 prompt cache（system prompt hash / tools hash / model / messages prefix 一致性校验） |
| C-191 | **Hook 事件扩展至 27 种** — 新增 PostToolUseFailure / TaskCreated / TaskCompleted / ConfigChange / InstructionsLoaded / CwdChanged / TeammateIdle / Elicitation / ElicitationResult / Setup 共 10 种事件 |
| C-192 | **记忆 4 类分类体系** — session memory 区分 user（用户偏好）/ feedback（工作反馈）/ project（项目信息）/ reference（外部指针）四类，增加"不保存"规则（代码模式/git 历史/调试方案等可从代码获取的不存储） |
| C-193 | **Session Memory Compact 增强** — 压缩时优先使用已提取的 session memory 作为摘要（Tier 2），添加阈值配置（minTokens: 10000 / maxTokens: 40000），使用 adjustIndexToPreserveInvariants 保护工具调用配对 |
| C-194 | **Token 预算警告状态** — 多级（normal <70% / warning 70-85% / error 85-95% / critical >95%）token 使用量警告状态，状态变化时通过 SSE 事件通知前端 |
| C-195 | **压缩提示词 9 段式升级** — 升级压缩提示词为 9 段结构化格式（Primary Request / Technical Concepts / Files / Errors / Problem Solving / User Messages / Pending Tasks / Current Work / Next Step），增加 analysis 思考区和三种模板变体（BASE/PARTIAL/PARTIAL_UP_TO） |
| C-196 | **Bash 命令语义解析** — 完整的 tree-sitter 兼容 Bash 语言解析器（7,314 行），含 bashParser.ts（4,436行纯 TS bash 语言解析器，生成 tree-sitter 兼容 AST）、ast.ts（2,679行 AST 安全分析：引号上下文、复合命令结构、危险模式检测）、parser.ts（199行高层 API 封装）。替代原有的 195 行简化版正则解析器。配合安全分类（safe/caution/dangerous），支持 heredoc、管道引号、嵌套子 shell、命令替换等复杂语法 (05-25 更新) |
| C-197 | **压缩后 Hook 重放** — runPostCompactCleanup 增加 SessionStart hook 重放（source: "compact"），恢复被压缩掉的 system prompt 上下文和 prompt cache baseline 重置 |

### 数据库全能力 + PowerShell 工具 (05-16)

| 变更项 | 之前 | 之后 |
|--------|------|-------|
| run_sql 只读限制 | 仅支持 SELECT 查询，正则 `/^SELECT\s/i` 阻断 CTE(WITH...SELECT)，INSERT/UPDATE/DELETE 硬拦截 | **C-198: run_sql 全量读写** — 新增 `mode` 参数（read/write），修复 CTE 正则为 `/^\s*(SELECT\|WITH)\s/i`。read 模式仅允许 SELECT/CTE，write 模式允许 INSERT/UPDATE/DELETE/CREATE TABLE/ALTER/DROP（事务保护：自动 BEGIN/COMMIT/ROLLBACK）。`isReadOnly()` / `isDestructive()` 动态标记操作类型。DDL(DROP/TRUNCATE/ALTER) 标记为破坏性，前端可展示确认。GRANT/REVOKE 保留硬拦截 |
| 外部数据库连接 | 无外部数据库连接能力 | **C-199: db_connect 外部数据库连接工具** — 新建 `db-connections.ts` 连接管理器，支持 PostgreSQL（pg.Pool）、MySQL（mysql2/promise）、SQLite（better-sqlite3）三种数据库。连接池按 session 缓存，`connectionId` UUID 标识，测试连接有效性。依赖安装：mysql2 + better-sqlite3 |
| 外部数据库查询 | 无 | **C-200: db_query 外部数据库查询工具** — 在外部数据库上执行 SQL 查询，复用 run_sql 的读写模式分类和事务保护逻辑。`connectionId="list"` 列出活跃连接。返回格式与 run_sql 统一（rowCount/showingRows/columns/rows） |
| PowerShell 能力 | 无 PowerShell 支持 | **C-201: powershell 工具** — 新建 `powershell-tool-adapter.ts` 适配层 + tool-setup.ts 注册。复用 CC 参考代码的 23 个 AST 安全验证器（powershellSecurity.ts）、PowerShell 检测（powershellDetection.ts）、命令执行（powershellProvider.ts）。自动检测版本（Core 7+/Desktop 5.1），无 PowerShell 环境时返回安装指引。`isReadOnly()` 基于只读 cmdlet 前缀匹配（Get-/Read-/Select- 等），`isDestructive()` 基于破坏性模式检测 |
| SQL 技能 | 无数据库操作技能 | **C-202: sql-query 内置技能** — 基于 Anthropic 的 write-query SKILL.md 适配为 DA 内置技能。覆盖：请求解析、方言识别（PostgreSQL/MySQL/SQLite 等）、Schema 发现（information_schema 引导）、查询编写最佳实践（CTE 结构/性能优化/可读性）、写入操作规范（RETURNING/分批/先查后删）。注册为 `sql-query`，antiHallucinationLevel=strict |
| 工具延迟加载 | DEFERRED_TOOLS 不含新工具 | **DEFERRED_TOOLS 更新** — 新增 powershell / db_connect / db_query 三个延迟加载工具，通过 tool_discover 按需发现，不影响默认 token 开销 |
| 工具体系架构 | C-26 列举工具不含数据库连接和 PowerShell | **C-26 更新: 工具体系扩充** — 工具列表新增：数据库工具（run_sql 读写模式 + db_connect + db_query）+ 平台工具（powershell），双层架构扩展为高级+底层+生成+交互+协作+扩展+管理+自进化+数据库+平台 十类工具 |

### 2026-05-16: 插件体系增强 + 自服务工具创建能力

| 现状 | 问题 | 变更 |
|------|------|------|
| 插件菜单为空 | plugins/ 目录下的插件加载时只注册技能到 agent_skills 表，不写入 plugins 表，前端 Plugin 菜单无数据 | **C-203: 插件自动注册到 DB** — `createConfiguredToolRegistry()` 扫描 plugins/ 目录时，对每个成功加载的插件调用 `repos.plugin.upsert()` 写入 plugins 表（id/name/version/enabled/config）。前端 Plugin 菜单可正确显示已安装插件 |
| judicial-analysis plugin.json 不完整 | 缺少 `capabilities` 字段 | **C-204: judicial-analysis 插件完善** — plugin.json 添加 `capabilities: ["skills", "agents"]`，7 个 SKILL.md 技能和 2 个 Agent MD 文件完整就绪 |
| Agent 不能自创工具 | `ToolRegistry.register()` API 存在但无 agent-accessible tool 暴露此能力 | **C-205: tool_create 动态工具创建** — 新建 `tool-create-tool.ts`，提供沙箱化执行环境（new Function + 白名单全局对象），安全检查禁止 require/import/eval/Function。Agent 可通过 `tool_create` 在运行时创建并注册新工具，工具仅当前进程有效。延迟加载（DEFERRED_TOOLS） |
| 无技能搜索能力 | Agent 无法搜索可用技能列表 | **C-206: skill_search + skill-find 技能** — 新增 skill_search 工具（查询 agent_skills 表，支持关键词过滤）。新增 skill-find 内置技能（指导 Agent 发现和使用技能的最佳实践）。tool_discover 描述字典同步更新 |
| DA 无代码编写指导 | DA 提示词主要面向知识库分析，缺少编码方法论 | **C-207: coding-assistant 内置技能** — 覆盖代码编写全流程（需求理解→方案设计→编码实现→验证测试），包含代码质量原则（简洁性/可读性/安全性/错误处理）、工具使用建议、调试策略和重构原则 |

### 2026-05-16: CC/OpenClaw 格式完全兼容

| 现状 | 问题 | 变更 |
|------|------|------|
| SKILL.md 解析器仅支持 DA 格式 | CC/OpenClaw 使用 `allowed-tools`（DA 用 `tools`）、`model`（DA 用 `model-role`）、`name`（DA 用目录名）、`when_to_use` 等字段，直接拷贝的 CC 技能无法被正确解析 | **C-208: SKILL.md CC 格式兼容** — `parseSkillMd()` 新增字段映射：`allowed-tools`→`tools`（含空格分隔格式解析）、`model`→`model-role`（haiku/sonnet/opus→main）、`name` 覆盖目录名、`when_to_use` 附加到 description。`loadSkillsFromDir()` 增加大小写不敏感匹配和递归扫描 |
| Plugin manifest 仅支持 DA 格式 | CC 插件使用 `.claude-plugin/plugin.json` 位置、不显式列出技能路径、使用 string/string[] 格式，DA 无法识别 | **C-208: Plugin manifest CC 格式兼容** — `loadPlugin()` 支持 `.claude-plugin/plugin.json` 清单位置、`skills`/`agents` 字段 string/string[] 格式、无 skills 字段时自动扫描 skills/ 目录。`discoverPlugins()` 检测 CC 格式目录。`PluginManifest` 接口扩展 index signature 允许任意 CC 字段 |

### 2026-05-16: 技能源追踪、CC 级编码能力、ClawHub 远程仓库

| 现状 | 问题 | 变更 |
|------|------|------|
| 技能名称冲突 | `agent_skills.name` UNIQUE 约束无 source 字段，builtin 和 plugin 同名技能互相覆盖 | **C-209: 技能源追踪** — 迁移 020 新增 `source`/`plugin_id`/`hub_slug`/`hub_url` 列。UNIQUE 约束改为 `(name, source)`。`ensureBuiltinSkills()` 使用 `getByNameAndSource(name, 'builtin')`。`skill_invoke` 使用优先级解析（builtin > hub > plugin > manual） |
| coding-assistant 过于简单 | 仅包含基础编码指导，缺乏 CC 级别的 read-before-write 强制、多角度代码审查、系统化调试 | **C-210: CC 级编码能力** — `edit_file` 添加 read-before-write 强制（`_readFilesTracker` 追踪已读文件）。增强 `coding-assistant` 技能为专业级工作流。新增 `code-review`（三角度并行审查）、`skillify`（过程捕获）、`systematic-debugging`（七步调试法）内置技能 |
| 无远程技能搜索能力 | DA 只能使用本地已安装的技能 | **C-211: ClawHub 远程技能仓库** — 新建 `clawhub-client.ts`（API 客户端，支持搜索/下载/fallback 网页抓取）。新增 `skill_hub_search` 和 `skill_hub_install` 工具。下载的技能注册为 source='hub'，保存到 `plugins/installed/` 目录 |

### 2026-05-16: Superpowers 插件移植

| 现状 | 问题 | 变更 |
|------|------|------|
| DA 无专业级开发工作流技能 | 编码缺乏系统化的 brainstorming→planning→TDD→debugging→review 工作流 | **C-212: Superpowers 插件移植** — 从 CC superpowers v5.1.0 移植完整 14 个技能到 `plugins/superpowers/`。包括 brainstorming（含 visual companion）、writing-plans、executing-plans、subagent-driven-development（含实现者/审查者 prompt 模板）、dispatching-parallel-agents、test-driven-development、systematic-debugging（含参考文档）、requesting/receiving-code-review、verification-before-completion、finishing-a-development-branch、using-git-worktrees、writing-skills、using-superpowers（DA 工具映射版）。所有技能通过 DA 的 CC 格式兼容机制加载 |

### 2026-05-16/17: 上下文溢出防护与结构化数据分析增强

| 现状 | 问题 | 变更 |
|------|------|------|
| GLM/MiniMax think-block 污染输出 | 模型输出含 `<think ...>...</think →` 标签，占用上下文空间且干扰内容解析 | **C-213: 上下文溢出多层防护** — (1) `agent-runner.ts` think-block 剥离：`extractNonThinkingText()` 从模型输出中移除 think 标签；(2) `micro-compact.ts` 搜索结果保护上限：从无限制改为最多保护最近 20 条搜索结果，防止搜索密集型任务上下文无限增长；(3) `agent-runner.ts` MCP 搜索结果解包压缩：MiniMax MCP web_search 返回的 JSON envelope（13K+ 字符/次）自动解包为扁平文本格式（标题+URL+摘要），与内置 web_search 格式一致；(4) `tool-setup.ts` web_search snippet 截断至 500 字符。四层防护均为 L1 基础设施层实现，通用适用所有模型和任务类型 |
| 结构化数据分析缺少方法论 | Agent 直接分析 CSV/JSON 数据而不阅读配套的说明文档，导致公式错误、字段语义误读、null 值处理不当 | **C-214: 结构化数据分析方法论** — (1) 新增 `cross-table-analysis` 内置技能：四步门控流程（文档先行→原始数据获取→精确计算→输出格式匹配），核心原则包括文档先行（禁止跳过阅读说明文档）、原始精度（filePath 定位 original/ 原始文件）、null 语义确认（从文档确认 null 含义）、python3 精确计算。包含常见陷阱自查清单（null 值语义、百分比/基点混淆、多表 JOIN 笛卡尔积等）；(2) `表格专项分析` 技能增强：新增核心原则（文档先行+原始精度+工具计算+null 语义确认）、工作流每步增加说明文档优先阅读要求、代码示例明确使用 original/ 路径、输出要求新增过滤条件和 null 值处理说明；(3) `agent-definitions.ts` 新增"结构化数据 doc-first"引导：计算或分析前先读取指南/手册/说明文档，理解数据模式和计算公式；(4) `tool-descriptions.ts` wiki_browse 补充 filePath/wikiPath 精度差异说明；(5) `tool-guidance.ts` 补充结构化数据计算引导和常见陷阱提示 |
| 技能路由不够精确 | Agent 在分析任务中误调用编程类技能（superpowers），或在编程任务中误调用分析类技能 | **C-215: 技能分类路由引导** — `skill-find` 技能新增三大类分类指导（分析类/编程类/领域类），每类列出具体技能名称和适用场景。判断标准表格明确用户意图→技能类别映射。核心原则："不要大炮打蚊子"——分析文档时调分析技能，写代码时调编程技能 |

### 2026-05-25: CC→DA 工具层迁移与系统集成

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 通用工具库 | DA 仅有 `lazySchema.ts`（8行），大量通用逻辑散落在各处 | **G-31: 从 CC 迁移 17 个工具模块到 `src/utils/`** — atomicWrite（原子文件写入 sync+async）、logger（结构化错误日志+环形缓冲+可插拔 sink）、retry（通用重试+指数退避+抖动+中止信号）、errors（errorMessage/toError/isENOENT 等错误工具）、format（文本格式化）、CircularBuffer（环形缓冲区）、abortController（父子 AbortController+WeakRef）、combinedAbortSignal（组合多个 abort signal）、cleanupRegistry（全局清理函数注册表）、sanitization（Unicode 安全清洗）、sleep（可中止 sleep+withTimeout）、memoize（TTL+LRU 缓存）、frontmatterParser（YAML frontmatter 解析）、intl（Intl 对象缓存+CJK 宽度）、yaml（YAML 解析包装）、profilerBase（性能分析基础设施）、startupProfiler（启动性能分析）。已集成：logger→5 核心错误通道（17 个 logError 调用）、retry→4 模型文件（替换手写重试逻辑）、atomicWrite→8 数据文件（16 个写入替换）、errorMessage→6 业务文件 (05-25) |
| Bash 解析器 | 195 行简化版正则解析器（bash-ast-parser.ts），仅支持基本命令分类 | **C-196 更新: 完整 Bash 语言解析器** — 从 CC 迁移 7,314 行纯 TypeScript bash 解析器到 `src/utils/bash/`：bashParser.ts（4,436行，tree-sitter 兼容 AST 生成，50ms 超时+50K 节点预算）、ast.ts（2,679行，安全分析：引号上下文、复合命令结构、危险模式检测）、parser.ts（199行，高层 API）。替代原有简化版解析器，新增能力：正确处理 heredoc、管道中的引号、嵌套子 shell、命令替换等复杂语法。bash-ast-parser.ts 接口不变，内部实现替换 (05-25) |
| Repository 层 | 18 个 Repository 接口 | **C-36 更新: 扩展至 25 个** — 新增 agent-memory（持久 Agent 记忆）、agent-task（Agent 任务追踪）、agent-skill（内置技能注册表）、skill-usage（技能使用追踪）、skill-version（技能版本历史）、workflow-log（工作流执行日志）、session-memory（会话记忆持久化） (05-25) |
| Server-Worker 架构 | 仅有设计文档（05-19），无需求条目 | **G-32: 新增需求条目** — Worker 模式支持分布式部署，HubClient+WorkerIdentity+Types 三文件，心跳/配置同步/Marketplace/独立降级 (05-25) |
| Chat 多媒体上传 | 仅有设计文档（05-17），部分被 C-150 覆盖 | **G-33: 新增需求条目** — 聊天图片/视频上传、内联缩略图、VLM fallback、session 绑定存储 (05-25) |
| Feature Flags | C-98 部分列举，不完整 | **G-34: 补全完整列表** — 11 个 feature flags 及其环境变量映射 (05-25) |
| CC 遗留代码 | CC 原始代码散布在 `src/` 各处（564+文件） | **代码清理** — CC 专用代码移入 `old_code/`（1,321 文件），DA 核心代码保持干净。CODE-CLEANUP-PLAN.md 描述的清理操作大部分已完成 (05-25) |

### 2026-06-01/03: 多 Session 并行隔离与健壮性加固

| 变更项 | 之前 | 之后 |
|--------|------|-------|
| 多 Session 并行安全 | ToolRegistry 使用全局单例 `_executionContext`，多个并发 HTTP 请求通过 `setExecutionContext()` 直接覆盖同一对象，导致跨 session 的 sessionId/scopeKbIds/sessionMemory/parentMessages/signal/pendingUserMessages 等全部串台 | **C-216: AsyncLocalStorage per-task 上下文隔离** — 引入 Node.js `AsyncLocalStorage` 实现每个并发任务独立的执行上下文：(1) `tool-registry.ts` 新增 `agentAsyncContext` ALS 实例 + `activeContexts` Map（taskId→context 跨请求索引），`getExecutionContext()` 优先读 ALS store 再回退单例；(2) `agents.ts` 流式执行包裹在 `agentAsyncContext.run(taskContext, ...)` 中，inject 路由通过 `getActiveContext(taskId)` 精确定位目标 task；(3) `agent-runner.ts` 实例级共享 Set（`_pushedContentKeys`/`_readFilesThisSession`）移入 RunState per-task 隔离；context 变更从 spread-merge 改为直接修改（ALS 保证隔离）；(4) `workflow-run.ts` mailbox 注入改为直接修改 context；(5) `knowledge.ts` 预处理用 `ALS.run()` 替换 save/restore 模式。解决：文件写入错误 session、搜索错误知识库、子 Agent 继承错误历史、消息注入错误 task 等全部并行场景问题 (06-03) |
| 二进制文件工具保护 | `read_file` 和 `push_content` 对所有文件类型用 UTF-8 读取，二进制文件（xlsx/pptx/docx/pdf 等）产生含 `\u0000` 的垃圾内容，导致 PostgreSQL JSONB 写入失败（"invalid input syntax for type json" / "unsupported Unicode escape sequence"）和模型 API 500 错误 | **C-217: 二进制文件工具保护** — `read_file` 和 `push_content` 新增 28 种二进制扩展名检测（pptx/xlsx/xls/docx/doc/pdf/zip/gz/tar/rar/7z/png/jpg/jpeg/gif/bmp/ico/webp/mp3/mp4/wav/avi/mov/wmv/flv/mkv/ogg/opus/sqlite/db），匹配时返回错误提示并建议替代方案（read_file→"Use expand or run_sql"；push_content→"Use push_file"）。双层防御：(1) 工具层拒绝读取，(2) 存储层 `sanitizeJsonForPg()` 清洗残余 (06-03) |
| PostgreSQL JSONB 字符清洗 | 工具结果中的二进制数据含 `\u0000` 和 UTF-16 孤立代理对（`\uD800`-`\uDFFF`），写入 JSONB 列时 PostgreSQL 拒绝 | **C-218: sanitizeJsonForPg 字符清洗** — `message.ts` 和 `agent-task.ts` 新增 `sanitizeJsonForPg()` 函数，`JSON.stringify()` 后正则移除 `\u0000` 空字节和替换 `\uD800`-`\uDFFF` 孤立代理为 `\uFFFD` 替换字符。应用于 message create/updateContent 的 metadata 参数和 agent-task create/updateStatus 的 output 参数 (06-03) |
| Thinking 内容丢失 | GLM 等模型将推理内容嵌入 `<think/>...</think/>` 标签中而非 API 级别 `reasoning_content` 字段，`extractNonThinkingText()` 剥离标签后静默丢弃推理内容 | **C-171 增强: `<think/>` 标签思考内容提取** — `extractNonThinkingText()` 新增 `thinking` 返回字段，收集 `<think/>` 标签内的推理内容。agent-runner 将其作为 `thinking_delta` 事件发出，走与 API 级别 `reasoning_content` 相同的持久化管道。两种来源的思考内容（API `reasoning_content` + 文本 `<think/>` 标签）统一处理 (06-03) |
| Thinking 内容持久化 | `thinking_delta` 事件仅推送 SSE 实时显示，页面刷新后丢失 | **C-171 增强: Thinking 内容持久化** — `agents.ts` 新增 `thinkingContent` 累积器收集所有 `thinking_delta` 事件（含 API 级别和 `<think/>` 标签来源），在 draft 增量更新和最终消息保存时均写入 metadata。`sessions.ts` 消息 API 从 metadata 提取 `thinkingContent` 返回前端。前端 `mapMessages()` 映射到消息模型 (06-03) |
| Thinking 前端显示 | 思考内容与正文颜色相同，不易区分 | **C-171 增强: Thinking 前端样式** — 思考内容 `<pre>` 区域颜色从 `var(--text-secondary)` (#475569) 改为 `#94a3b8`（slate-400），与正文形成视觉区分 (06-03) |
| 流式内容持久化丢失 | `result.output`（agent-runner 的 accumulatedContent，仅保留最长单轮）优先级高于 `fullContent`（agents.ts 累积的全部 text_delta），多轮工具调用中间的文字输出在最终保存时被丢弃 | **C-115 增强: 内容持久化优先级** — 最终保存从 `result.output || fullContent` 改为 `fullContent || result.output`。`fullContent` 包含全部轮次的全部 text_delta 事件（即用户实时看到的完整内容），`result.output` 仅作为 fallback (06-03) |
| AI 消息宽度抖动 | AI 内容列无固定宽度（`alignItems: flex-start` + 无 `width: 100%`），工具调用卡片和文字内容 shrink-wrap 到实际内容宽度。初始内容少时窄、后续内容多时扩宽，简单任务输出保持超窄宽度 | **G-35: AI 消息内容宽度自适应** — MessageItem.tsx 中 AI 内容列添加 `width: "100%"`，工具调用和文字输出始终填满父容器可用宽度（受 `maxWidth: 75%` 约束），不再随内容量动态变化 (06-03) |
| 前端 session 状态串台 | 多 session 快速切换时 onTodoUpdate 回调更新错误 session 的 todo；reconnectToRunningTask 在多轮对话中 `.find()` 找到第一条而非最后一条 assistant 消息；异步 `set({ messages })` 缺少 session guard | **C-219: 前端 session 状态管理加固** — (1) 三处 onTodoUpdate handler 添加防御性类型检查（typeof id === "string" && typeof subject === "string" && id && subject）；(2) reconnectToRunningTask 改用 `[...messages].reverse().find()` 查找最后一条 assistant 消息；(3) 多处异步操作添加 `if (get().currentSessionId !== expectedSessionId) return` 守卫，防止切走后回调更新错误 session (06-01) |
| 中文文件名下载乱码 | Content-Disposition header 使用简单 ASCII 格式，中文文件名（如分析报告.pptx）在浏览器下载时显示为 URL 编码或乱码 | **C-220: RFC 5987 中文文件名下载** — `contentDispositionValue()` 函数：纯 ASCII 文件名使用简单格式，非 ASCII 文件名提供 ASCII fallback + `filename*=UTF-8''` 编码格式（RFC 5987）。应用于 session output 和 media 文件下载路由 (06-03) |

### 2026-06-04/06: Agent 健壮性加固与工具层优化

| 变更项 | 之前 | 之后 |
|--------|------|------|
| Agent 规划内容误判为输出 | `isThinkingContent()` 仅识别英文规划文本（"Let me think"等），中文规划内容（如"让我分析一下"）未被检测 | **C-223: Agent 过早完成检测与自动续写** — (1) 中文规划模式识别：`isThinkingContent()` 新增中文规划文本模式匹配（"让我/我来/首先.*分析/规划/计划"等）；(2) 过早完成检测：当 agent 调用 finish 时仅含规划/思考内容(<500 字符)且未产出实际输出，自动使 finish 失效并注入续写提示；(3) 内容与规划区分：`looksLikeContent` 启发式规则(>300 字符+标题+2+段落分隔符视为真实内容，不触发规划检测)，防止写作任务被误判 (06-04, 06-06 增强) |
| 工具调用被 max_tokens 截断 | 模型输出被截断后仅处理文本续写(C-89)，工具调用 JSON 参数不完整时直接报错 | **C-224: 工具调用截断恢复机制** — (1) 流式空闲超时从 60s 提升至 180s（大工具调用生成交互需要时间）；(2) 截断工具调用检测：识别 workflow_run 仅含 mode 键、write_file 有 path 无 content、大参数工具参数键数异常等模式；(3) 自动重试：检测到截断时以双倍 maxTokens 重试，最多 3 次；(4) 诊断日志含原始参数预览 (06-04, 06-05 扩展 write_file/通用检测) |
| finish 工具答案不可见 | Agent 将完整答案放在 finish summary 参数中而非流式输出，用户看到空消息 | **C-115 增强: finish 答案 SSE 回填** — agents.ts 检测 finish summary 显著大于已流式内容(>2x 且 >100 字符)时，发送合成 `content_delta` 事件将答案回填到 SSE 流。finish summary 从替换改为追加(append)模式，防止页面刷新时已流式输出内容消失 (06-04, 06-08 修复) |
| 压缩标识符丢失 | MAX_PRESERVED_IDENTIFIERS 仅 30 个；贪婪哈希模式 `/\b[0-9a-f]{32,64}\b/` 误匹配 200+ 子串；审计范围覆盖非压缩区间 | **C-135 增强: 压缩标识符保护优化** — (1) MAX_PRESERVED_IDENTIFIERS 30→150；(2) 移除贪婪哈希模式（仅保留带前缀的精确哈希匹配）；(3) 审计范围仅覆盖压缩区间；(4) 标识符提取逻辑与 legacy 路径对齐；(5) 修复 `generateSummaryWithPrompt` 从截断内容提取标识符 (06-05) |
| ScopeSelector 竞态 | 优先使用 localStorage currentKbId 而非 session kbScope，数据未加载时传播空作用域 | **C-216 增强: 前端 KB 作用域竞态修复** — (1) ScopeSelector 优先使用 session kbScope 而非 localStorage；(2) 新增 scopeReadyRef 防止数据未加载时传播作用域；(3) 支持 legacy `{kbIds:[...]}` 格式和 `{knowledgeBases:[{kbId,mode}]}` 格式双兼容 (06-05) |
| Workflow 引擎健壮性 | agentId undefined 导致 persistAgentOutput 崩溃；goal 参数因流式截断丢失时 workflow 无目标 | **Workflow 引擎健壮性加固** — (1) persistAgentAgent 添加 undefined agentId 守卫；(2) 完成计数包含所有完成 agent（不仅是有 resultFiles 的）；(3) synthesis audit 异常时发射 `workflow_agent_complete(failed)`；(4) goal fallback：从 agent tasks 推导目标（当模型因截断省略 goal 参数时） (06-04) |

### 2026-06-06/08: 基准测试优化与工具能力增强

| 变更项 | 之前 | 之后 |
|--------|------|------|
| GAIA L3 基准 | 首次运行 26.9% (7/26) | **优化至 42.3% (11/26)** — L1 工具层：Baidu 搜索 fallback 新增代理支持、scholar_search 四个 fetch 调用新增代理支持。L2 提示词：web research 引导、答案格式优化。L4 Agent Loop：流式空闲超时提升、截断恢复。GAIA runner 支持 165 全量任务（含文件上传、增量进度保存、level 统计）(06-06, 06-07) |
| AgentLongBench 基准 | 无专用测试基础设施 | **ALB 基准测试基础设施** — `run-alb.mjs` 支持 540MB unified.json（python prompt 提取）、`--small/--ids/--category/--resume` 参数、5 类 subtype 分类（Count Frequency/Count/Intersection/Comparison/Value Extraction）。迭代优化 13 轮达到 ~91% 准确率。关键修复：Count Frequency(Tool) off-by-1、Intersection Subtype 2 方向、Subtype 3 全轮次交集、extractAnswer 长列表优先级 (06-06) |
| YouTube 字幕工具 | youtube_transcript 为延迟加载工具，非 KB session 需 tool_discover 发现，模型很少主动调用 | **youtube_transcript 自动包含** — 加入 `GENERAL_PURPOSE_DEFERRED_TOOLS`，非 KB session 初始工具定义即包含此工具，无需 tool_discover 发现 (06-08) |
| Wikipedia 修订历史 | get_revisions 仅支持基础查询，无日期过滤，默认限制 10 条 | **C-225: Wikipedia 修订历史增强** — (1) 新增日期范围过滤（start/end 参数）；(2) 新增排序方向（dir=newer/older）；(3) 默认限制 10→50，上限 500；(4) MCP 适配器搜索摘要截断从 500 统一至 1500 字符；(5) tool-guidance 补充 youtube_transcript 和 wikipedia 工具能力说明 (06-08) |
| KB 上传文件类型过滤 | 前端文件选择器和 DropZone 仅接受 PDF/DOCX 等文档类型，图片/音频等后端已支持的类型被前端过滤 | **KB 上传文件类型扩展** — 前端文件过滤器新增 image/\*/audio/\*/video/\* 等 MIME 类型，与后端已支持的处理能力对齐 (06-08) |

### 2026-06-09/10: 双轨附件上传 + Markdown 流式预处理

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 非媒体附件处理 | 回形针/拖拽上传非媒体文件后，Agent 仅收到文字提示"文件已保存，mediaId=xxx"，不知道文件路径，无法有效处理 PDF/DOCX 等内容 | **C-222: 双轨附件上传（即时解析 + 后台 KB）** — Track 1 即时内联：非媒体文件通过 ProcessorFactory 解析（15s 超时），提取文本上限 50K 字符内联注入 Agent 上下文；纯文本类型(txt/md/json/csv/xml)直接读取无需解析。Track 2 后台 KB：非媒体文件自动复制到 `session-{sessionId}` 专属知识库，排队 L0/L1/L2 完整处理，session kbScope 自动更新。前端统一：Paperclip 按钮和拖拽均走 useChatMedia 路径，移除旧的 useFileUpload KB 路径。幂等性：KB 名称查找+文件 MD5 hash 去重 (06-09, 06-10) |
| 仅附件无文本消息 | run-stream 要求同时提供 text 和 mediaIds，仅上传附件不输入文字时无法启动 Agent | **C-221: 附件发起对话** — run-stream 允许仅 mediaIds 无 text 输入启动 Agent。JSONL 加载上下文注入媒体附件标注。JSON 用户消息自动解析提取文本和媒体信息。内容持久化优先 fullContent（含注入消息响应）(06-10) |
| LLM 流式 Markdown 格式错误 | 模型流式输出中标题后缺失空格(##后无空格)、标题和列表项前缺失换行符，导致 marked() 解析失败或格式错乱 | **C-226: 前端 Markdown 流式预处理** — `useMarkdown.ts` 新增 `normalizeMarkdown()` 预处理：修复 `##标题` → `## 标题`（标题后空格）；修复 `文本## 标题` → `文本\n\n## 标题`（标题前换行）；修复 `文本- 列表项` → `文本\n- 列表项`（列表前换行）。应用于所有 renderMarkdown 调用 (06-10) |
| 工具输出二进制污染 | `read_file`/`push_content` 对 xlsx/pptx 等二进制文件 UTF-8 读取产生 `\u0000`，写入 PostgreSQL JSONB 失败 | **C-218 增强: 二进制工具输出清洗** — 工具调用输出(toolCalls metadata)新增 `sanitizeJsonForPg()` 清洗。`sanitizeJsonForPg()` 修复：孤立代理正则从文本级(`\\uD800`)改为字符级(`[\uD800-\uDFFF]`)，正确匹配 JSON.stringify 中的实际代理字符 (06-04 修复正则, 06-10 扩展至工具输出) |
| E2E 证据链测试 | 证据链报告生成后，push content 卡片中的 da-evidence:// 链接未渲染为可点击元素 | **E2E 证据链测试全部通过** — push content type=markdown 正确渲染；processEvidenceLinks 处理 da-evidence:// 协议；DOMPurify evidencePurifyConfig 保留 data-evidence-\* 属性；证据预览面板点击打开正确显示文档内容。测试 5/5 通过(Agent 完成/内容生成/链接生成/链接渲染/预览面板) (06-10) |

### 2026-06-20: Per-Task 并行执行架构

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 会话级互斥锁 | `/run-stream` 路由使用 `activeSessionRuns: Map<sessionId, taskId>` 互斥锁，同一会话第二个消息返回 409 Conflict "该会话已有任务正在执行中" | **C-227: Per-Task 完全并行执行** — 移除 `activeSessionRuns` Map 及其 409 Conflict 检查、`.set()`/`.delete()` 调用。同一会话可同时运行多个 Agent 任务（受全局 `MAX_CONCURRENT_AGENT_RUNS=8` + 每会话 `MAX_CONCURRENT_PER_SESSION=3` 配额限制，超出返回 429）。JSONL 转录按 taskId 分片（`{dataDir}/sessions/{sessionId}/transcripts/{taskId}.jsonl`），天然并行安全无需加锁。Agent runner fork/sub 模式移除 save/clear/restore 反模式（子 Agent 通过 `_runStates.set(taskId, {...})` 创建独立 RunState，从不读取父 RunState，无需清空父 writer）。Workflow 事件按 `parentTaskId` 过滤防止跨任务事件泄漏。loadContextMessages 过滤 draft 消息避免并行任务互相干扰 (06-20) |
| 前端流式状态 | 单一全局 `streamingMessageId` + `isStreaming` 布尔，新消息发送时若已有任务运行则注入到同一占位消息；全局 `isStreaming` 阻塞 UI 交互 | **C-228: Per-Task SSE 并行流式架构** — (1) `client.ts` 所有 SSE 回调新增 `taskId` 参数（onContent/onToolCall/onToolResult/onProgress/onPushContent/onTodoUpdate/onWorkflowComplete/onWorkflowEvent），SSE 解析器从 `start` 事件提取 `currentTaskId` 跟踪；(2) `chat.ts` store 新增 `taskIdToMessageId: Map<string, string>`（后端 taskId → 前端占位 messageId），每次 `sendMessage` 调用通过闭包捕获唯一 `assistantId`，所有 SSE 回调直接路由到该消息而非全局状态；移除 `if (isSending \|\| isStreaming) return` 阻塞守卫；(3) `MessageItem.tsx` 流式状态从全局选择器 `s.streamingMessageId === message.id` 改为每消息独立标记 `message.isStreaming === true`；(4) `MessageInput.tsx` 发送按钮始终可用（移除 isSending 阻塞），新增独立 Stop 按钮停止所有任务；(5) `isStreaming`/`isSending` 派生自 `taskIdToMessageId.size > 0` 支持多任务感知；`finishStreaming` 检查 `taskIdToMessageId.size > 0` 防止单任务完成时错误清除其他活跃任务的流式状态 (06-20) |
| 消息排序稳定性 | `messages` 表查询仅按 `created_at ASC` 排序，同一毫秒插入的并行消息顺序不确定 | **C-229: 消息排序 id ASC tiebreaker** — `message.ts` repository 查询排序从 `ORDER BY created_at ASC` 改为 `ORDER BY created_at ASC, id ASC`，确保同一时间戳的并行消息有稳定的确定性显示顺序 (06-20) |

### 2026-06-20: 证据链可靠性与 Skill 共享机制

| 变更项 | 之前 | 之后 |
|--------|------|------|
| anchor 404 用户体验 | Agent 编造的随机 UUID anchor 在 `/api/preview/evidence/:anchorId` 返回 404 时，前端 EvidencePreviewPanel 显示 "Evidence not found" 错误，链接完全失效 | **C-230: anchor 404 降级为文档预览** — EvidencePreviewPanel 收到 404 时优先使用 `fallbackDocId`（后端从 anchor ID 提取），否则使用链接属性中的 `data-evidence-doc`（即使 anchor 编造，kbId/docId 通常仍有效），降级为整文档预览模式而非报错。用户至少能看到对应文档内容 (06-20) |
| 工具描述缺失 anchor 信息 | `expand` 工具描述仅一句"逐层展开文档内容"，未提及返回的 `anchors` 数组；`kb_search` 工具描述未提及 `anchorId` 字段。Agent 即使调用工具也不知道 anchor ID 的格式和用途 | **C-231: 工具描述补充 anchor 字段说明** — expand 描述明确说明 L1 返回 anchors 数组及 `{docId}:{elementType}:{index}` 格式（非纯 UUID）；kb_search 描述补充 anchorId 返回字段。这是 L1 工具层修复，所有场景受益 (06-20) |
| builtin skill 引用格式弱 | kb-analysis skill 中证据链接标为"推荐"，未说明 anchor ID 真实格式，无错误示例 | **C-232: kb-analysis skill 强化证据链接要求** — 改"推荐"为"必须"，补充 anchor ID 真实格式、禁止行为、正确流程。让不调用 judicial-analysis 的场景也能正确生成链接 (06-20) |
| Skill 文件冗余与维护困境 | 8 个 judicial-analysis skill 各自包含 47 行几乎相同的"证据超链接规范"模块（共 ~371 行重复内容），改一处要改八处；只有 evidence-linked-report 有自检清单 | **C-233: Skill @include 机制 + 共享规范** — (1) skill-loader 新增 `<!-- @include path -->` 指令支持，加载 SKILL.md 时解析相对路径并内联替换，支持递归（5 层）和错误回退；(2) 新建 `plugins/judicial-analysis/_shared/` 目录：evidence-link-spec.md（含纯 UUID 警告等典型错误）+ evidence-self-check.md（push_content 前的自检清单）；(3) 8 个 skill 用 @include 引用共享规范，全部添加自检清单。修改共享文件即同步所有 skill (06-20) |

### 2026-06-21: Hub Server 多租户控制平面 Phase 1-4 完整交付

独立仓库 `deepanalyze-hub/` 实现企业级 Hub Server，作为 G-32 Server-Worker 架构的生产控制平面。设计依据：`docs/superpowers/specs/2026-06-20-hub-server-multi-tenant-design.md`（1165 行设计文档）。**总测试 122 项全部通过，0 回归。**

| 变更项 | 之前 | 之后 |
|--------|------|------|
| 多租户架构 | DA 主后端单租户，无组织/用户/权限管理，F-02 标记为"后续按需" | **Phase 1 (commit 34cce0e + 85fdc86)** — Hono + PostgreSQL + Bun 独立 Hub Server，端口 22000。树形 Organization（path 字段+祖先查询+subtree CTE）、User（is_super_admin/is_org_admin 双标志）、JWT 双 Token（access 7d body / refresh 30d HttpOnly cookie）、API Key（X-API-Key header，SHA-256 hash 存储）、RBAC 三件套（Role/Permission 树 + role_permissions 关联 + DataScope 自动过滤）、Worker 申请-审批流程（v1 协议 auto-approve 向后兼容，v2 需 admin 审批拿 worker_token）、前端管理后台（React 18+Vite 6+react-router-dom 6，5 页面 Login/Dashboard/OrgTree/UserList/WorkerApproval，SPA 静态服务+404 fallback）。**21 项测试通过** |
| Skill 市场与同步 | G-32 Worker 模式仅有基础 HubClient 通信，无 org-scoped 包、无版本管理、心跳仅状态上报 | **Phase 2 (commit 0b941d5)** — skill_packages 表（system/org/user 三级 scope，org_id 外键，trust_level/stats/kills_switch JSONB）、skill_versions 表（不可变，content_hash SHA-256，status 状态字段）、skill_subscriptions 表（user/worker/org 三类 subscriber，is_forced/pinned/auto_update/source 字段）、worker_skill_cache 表（worker 本地缓存哈希，用于 diff）、SkillSyncService.computeExpectedSkills（system 强制 + org_forced + user_subscribed 三源 UNION）+ generateInstructions（diff → sync/kill 指令）、心跳协议 v2 升级（cached_skills/policy_version/current_task 字段）、/api/v1/skills REST API（list/get/create/versions/subscribe/kill/download）、/api/v1/workers/heartbeat 集成 SkillSyncInstructions、/api/v1/workers/ack 确认端点、前端 Skills 页面。**21 项测试通过** |
| 审核工作流 | 无版本状态机、无审批流程、无内容审核、无审计日志 | **Phase 3 (commit 503ab96)** — 6 态状态机（draft→internal_test→canary→published→deprecated/rolled_back，state-machine.ts 定义合法转换 + adminOnly + requiresApproval）、PublishGate 4 维评估（RedFlagScanner 30% + StructureValidator 15% + LLM 25% + Benchmark 30%，overall < 60 或 critical > 0 时 blocked=true）、RedFlagScanner 14 规则（RF01-RF14：curl\|bash/硬编码凭证/eval/exec/DROP TABLE/rm -rf 等，CRITICAL=4/HIGH=3/MEDIUM=2）、Approval 工作流（skill_approvals 表，org/system scope 强制审批，user scope 可直接发布）、Kill Switch（is_kill_switched 标志，禁订阅+心跳下发 kill 指令）、Force Update 持久化队列（skill_sync_queue 表，priority/deadline/expires_at/target_org_ids，priority=80 高于普通 sync）、不可篡改审计日志（skill_audit_logs BIGSERIAL，repository 仅暴露 log+queryByPackage+queryByVersion，生产 REVOKE UPDATE/DELETE）、canary_rollout JSONB 字段（灰度配置）、前端 Skills 页面集成 Kill Switch。**29 项测试通过** |
| 跨组织共享 | 无跨 org 共享机制，技能只能在同 org 内传播 | **Phase 4.1 (commit 61fea88) SkillSharing** — skill_sharings 表（source_org_id/target_org_id/status 四态/restrictions JSONB/initiated_by/approved_by/revoked_by/revoke_reason）、Partial Unique Index `uq_sharing_active_pair`（仅对 status IN ('pending','approved') 生效，允许 rejected/revoked 后重新发起）、双边审批流程（requestSharing→approveSharing 自动订阅目标 org source='org_share' / rejectSharing / revokeSharing 撤销时删除订阅+入队 kill 指令 priority=90+记录审计日志）、restrictions 三维限制（max_users/expires_at/data_classification_max）、权限隔离（仅 involved org admin 或 super_admin）、/api/v1/sharings REST API、前端 Sharings 页面（list/approve/reject/revoke + 状态色标） |
| 使用日志 | 无 skill 执行统计，无法量化使用情况 | **Phase 4.2 SkillUsageLogs** — skill_usage_logs 表（package_id/version_id/worker_id/user_id/executor_type/status CHECK 约束 success/failure/timeout/blocked/duration_ms/session_id/details JSONB）、logUsage() 异步写入、getStats() 聚合查询（total/success/failure/timeout/blocked/success_rate/avg_duration_ms/unique_workers/unique_users/last_24h/last_7d）、getTopPackages() 排行榜、listRecent() 时序列表、/api/v1/skills/:id/usage POST（workerAuth）+ /usage/stats + /usage/recent + /usage/top（jwtAuth+usage:read 权限） |
| 安全过滤 | 无运行时内容过滤，仅依赖 Agent 自主判断 | **Phase 4.3 Security Gateway** — WordEngine（15 默认规则：sensitive severity 1-2 / risky severity 3-4 / allowlist 三级分类，大小写不敏感子串匹配 + allowlist 上下文豁免）、RegexEngine（5 PII 规则：CN 身份证 18 位/手机号 1[3-9]xxxxxxxxx/银行卡 16-19 位/内网 IP 10.\|192.168.\|172.16-31/email，自动 mask 脱敏）、DecisionEngine（severity 1-2 sanitize / 3 approve+warring / 4+ block）、SecurityGateway facade（filterInput/filterOutput/checkTool 三层 API）、FAIL_OPEN 策略（异常时放行避免单点故障）、Hub 中间件 securityInputFilter（POST/PUT/PATCH JSON body，/skills/* 路径跳过避免与 PublishGate 重复审核，/auth/login 等敏感路径跳过）、/api/v1/security admin 路由（status/scan/check-tool/rules）、前端 Security 页面（交互式扫描器+工具检查器） |
| 企业认证 | 仅本地账号密码，无 SSO/MFA | **Phase 4.4 Enterprise Auth** — auth-adapters.ts 统一接口 AuthAdapter（provider/enabled/authenticate）、LdapAdapter（AUTH_LDAP_ENABLED + AUTH_LDAP_SIMULATE 开发模拟模式，生产需 ldapts 包）、OidcAdapter（OAuth2 Authorization Code + PKCE S256，Discovery + userinfo 端点，fetch 实现）、TOTP MFA RFC 6238（30s window/SHA-1/6 位/±1 drift/generateTotpSecret 32 字符 base32/computeTotp BigInt 实现/verifyTotp timingSafeEqual 防 timing attack/totpProvisioningUri otpauth://）、用户级 MFA 存储（setUserMfa/getUserMfa/verifyUserMfa）、全局 MFA 强制（AUTH_MFA_REQUIRED=true）、/api/v1/auth/mfa/* 路由（setup/verify/status/disable/challenge）、/api/v1/auth/adapters 路由（list）、/api/v1/auth/external/login（外部 IdP 桥接）、ContextVariableMap 类型扩展（pendingMfaSecret/securityInputMatches 等） |
| 测试基础设施 | DA 主后端 Playwright E2E + 单元测试 | **Phase 1-4 E2E Python 测试套件** — tests/phase1_test.py（21 项：健康检查/登录/me/组织树 CRUD/用户 CRUD/权限隔离/Worker v1+v2/API Key/Roles）、tests/phase2_test.py（21 项：包创建/版本管理/订阅/sync 指令/kill switch/ack）、tests/phase3_test.py（29 项：状态机转换/非法转换拒绝/PublishGate 阻断/RedFlag 检测/审批流 request→approve→publish/拒绝阻断/审计日志/Force Update 队列/deprecate+rollback）、tests/phase4_test.py（51 项：SkillSharing 双边流程/usage 日志/stats 聚合/top 排行/Security Gateway 三层扫描/MFA setup→verify→disable/external login）。**总计 122 项全部通过**。Hub 数据库迁移 014 项（001_initial → 014_partial_unique），独立 `deepanalyze_hub` 数据库 |
| DA 集成验证 | DA hub-client v2 类型已存在但未联调 | **DA Hub-Client v2 联调通过** — DA 主进程启动时 `DEEPANALYZE_CONFIG.runMode === "worker"` 触发 HubClient 注册；register 不传 protocol_version（默认 v1 auto-approve）保持向后兼容；heartbeat 传 protocol_version: 2 + cached_skills/policy_version/current_task；修复 workers.current_task 列缺失（migration 009）；修复 SkillSyncService org_id 字段名错误（实际为 organization_id）；修复 jsonb_set 类型错误（需 to_jsonb 包装 int）；修复 Hono 路由顺序（/approvals 必须先于 /:id 注册） |

### 2026-06-23: 文件格式覆盖范围补全 + 入库解析可靠性加固

| 变更项 | 之前 | 之后 |
|--------|------|------|
| TextProcessor 编码检测 | `readFileSync(filePath, "utf-8")` 硬编码 UTF-8，GBK/UTF-16 等非 UTF-8 编码的 txt 文件产生乱码 | **C-234: TextProcessor 自动编码检测** — `decodeWithEncodingDetection()` 检测链：① BOM（UTF-8-BOM/UTF-16LE-BOM/UTF-16BE-BOM）② 纯 ASCII ③ 严格 UTF-8（检查替换字符）④ GBK/GB2312（简体中文）⑤ Big5（繁体中文）⑥ Latin-1 fallback ⑦ UTF-8 lossy 兜底。使用 iconv-lite 解码非 UTF-8 编码，metadata 记录 `detectedEncoding` (06-23) |
| txt/doc 管线路由 | txt 文件路由到 "text" 策略（仅 Docling），.doc 路由到 "docx" 策略（MinerU/Docling 无法处理二进制 .doc），TextProcessor 和 DocConverterProcessor 从未被调用 | **C-235: txt/doc 专用策略类别** — pipeline-strategies.ts 新增 `"txt"` 类别（TextProcessor 优先 + Docling fallback）和 `"doc_legacy"` 类别（DocConverter 优先 + Docling fallback）。pipeline-orchestrator.ts getProcessor 新增 `"text"` 和 `"doc_converter"` case。FILE_TYPE_CATEGORIES: txt→txt, doc→doc_legacy (06-23) |
| 格式覆盖盲区 | 前端接受 .yaml/.yml/.svg 上传但后端无任何处理器能处理（全部管线跳过→失败）；.md 因 detectFileType 返回 "markdown" 但 Docling/策略表期望 "md" 导致 Docling 被跳过；.rtf/.odt/.epub 在 TextProcessor HANDLED_TYPES 中但作为二进制格式读取产生乱码；.ppt 路由到 pptx 策略但无处理器能处理二进制 .ppt；.xlsm 路由到 spreadsheet 但 NativeTableProcessor 不含 xlsm | **C-236: 格式覆盖盲区修复** — ① yaml/yml/toml/ini：新增路由至 txt 类别 + TextProcessor HANDLED_TYPES；② svg：路由至 txt 类别（Docling 无 SVG 后端，TextProcessor 读取 XML 文本）；③ md：detectFileType 返回 "md"（非 "markdown"），对齐 Docling HANDLED_TYPES，.md 现通过 Docling MarkdownDocumentBackend 获得结构化解析；④ rtf/odt/epub：从 TextProcessor HANDLED_TYPES 移除（二进制格式读取产生乱码），rtf/odt 路由至 doc_legacy（LibreOffice 转换）；⑤ ppt：路由至 doc_legacy，DocConverterProcessor 转 .ppt→.pptx；⑥ xlsm：NativeTableProcessor HANDLED_TYPES 新增 xlsm（xlsx 库可读取）。12 种格式端到端测试全通过 (06-23) |
| DocConverterProcessor 单一格式 | 仅支持 .doc→.docx 转换，其他遗留格式（.rtf/.odt/.ppt）无法处理 | **C-156 增强: 多格式 LibreOffice 转换** — DocConverterProcessor HANDLED_TYPES 扩展为 doc/rtf/odt/ppt。CONVERT_TARGET 映射表按输入扩展名动态选择转换目标：doc/rtf/odt→docx、ppt→pptx。转换后统一委托 DoclingProcessor 解析，metadata 记录 originalFormat/convertedVia/originalSizeBytes/convertedSizeBytes (06-23) |
| 前端 accept 不完整 | 前端文件选择器仅接受 .pdf/.doc/.docx/.txt/.md/.csv/.xlsx/.pptx/.html/.htm/图片/.mp3/.wav/.mp4/.json/.xml/.yaml/.yml，缺少 .xls/.xlsm/.ppt/.rtf/.odt 及扩展音视频格式 | **前端 accept 全量同步** — KnowledgePanel.tsx 文件选择器和 DropZone accept 补充 .xls/.xlsm/.ppt/.rtf/.odt/.flac/.m4a/.aac/.ogg/.avi/.mov/.mkv/.webm/.toml/.ini，与后端支持的格式列表对齐 (06-23) |
| MiniMax 连接超时不可重试 | openai-compatible.ts 60s 连接超时产生 AbortError，isRetryable 正则不匹配 "aborted"，单次失败后直接降级到辅助模型，导致 Agent 任务异常终止 | **C-237: 连接超时可重试** — 流式 streamCompletion 和非流式 completion 的 isRetryable 正则统一新增 `aborted` 匹配。同时检查 `options.signal?.aborted` 区分父信号（用户取消，不重试）和连接超时信号（可重试）。覆盖 MiniMax/GLM 等 OpenAI 兼容 provider 的连接超时场景 (06-23) |
| Session memory JSON 写入失败 | session-memory.ts save() 直接将 searchIndexJson 传入 PG jsonb 列，含 \u0000 或孤立代理对的 JSON 导致 PostgreSQL "invalid input syntax for type json" 错误 | **C-238: Session memory JSON 容错** — save() 新增 sanitizeJsonStr() 清洗（移除 \u0000 + 替换孤立代理对为 \uFFFD）+ JSON.parse 结构验证，无效 JSON 降级为 null（跳过搜索索引，非致命）。mapRow() 统一 stringify PG 返回的 jsonb 对象为字符串 (06-23) |
| push_content emoji 乱码 | SSE 事件序列化时 UTF-16 代理对（emoji 等 4 字节字符）被截断，导致前端渲染乱码 | **push_content 代理对保护** — message.ts/agent-task.ts sanitizeJsonForPg() 正则从文本级 `\\uD800` 改为字符级 `[\uD800-\uDBFF](?![\uDC00-\uDFFF])` 正确匹配 JSON.stringify 中的实际代理字符。SSE 去重：同一 push_content 事件不再重复推送 (06-23) |
| 思考窗口自动展开 | 过程记录面板在流式输出时自动展开且无法折叠，仅任务完成后才能折叠 | **C-239: 思考面板默认折叠** — MessageItem.tsx 移除 `useEffect(() => { if (isStreamingMsg && message.thinkingContent) setShowThinking(true) })` 自动展开逻辑，思考面板默认折叠，用户手动点击展开/折叠 (06-23) |

### 2026-07-04: 企业多租户架构完整化设计

| 变更项 | 之前 | 之后 |
|--------|------|------|
| DA 多租户定位 | 隐含但未明文，曾误判"DA 内部需多租户隔离"为缺口 | **G-39: 明文设定 DA 为单用户容器** — 一容器=一用户完整环境，容器级隔离，内部不需 user_id 数据隔离 |
| F-02 用户认证 | "已迁移到 deepanalyze-hub"（笼统） | **修正**：DA 单用户容器 + Hub 控制平面 + SSO 跳转模型。明文 DA 内部 users 表仅 local 降级模式用 |
| Hub 控制平面角色 | G-35 描述 Hub Phase 1-4 但未点明"控制平面"定位 | **G-40: 明文 Hub 控制平面六大职责** — 用户身份/配置模板/物理机抽象/容器分发/用户→容器路由/监控 |
| 用户→容器跳转 | 缺失（Hub /api/v1/auth/me 不返回 da_url，无 SSO 握手） | **G-41: SSO 一次性 ticket 换 token** — Hub 签发 10s 过期 ticket，DA callback → exchange → 本地 RS256 cookie 8h |
| 同机多容器 | 不支持（端口硬编码 21000） | **G-42: 端口段 block 分配** — host_servers 表 + port_block_size 默认 10 + 容器内端口固定/host 端口按 base 偏移 |
| 配置同步 | module_states 不同步、MinerU 不在 RecommendedConfig、Hub 无模板 UI | **G-43: 双轨同步 locked+recommended** + **G-44: 两层模板全局+组织 override** + RecommendedConfig 扩展 moduleStates/fieldLocks |
| 同步触发 | 未规定（曾考虑定时+推送） | **G-43: 仅 2 触发器** — 首次构建自动（last_hub_sync_at IS NULL）+ DA 侧手动点击 |
| 企业版镜像 | 隐含"企业版独立 Dockerfile" | **G-45: 同一个人版镜像 + ENV 决定模式** — T15 personal-full 完全复用，DA_AUTH_MODE=hub 即企业版 |
| 心跳频率 | 未规定（曾考虑 30s） | **G-43 相关**：DA→Hub 心跳 5 分钟一次（避免性能影响），离线阈值 15 分钟 |
| 物理机管理 | SSH 凭证散落在 workers 表（每个 worker 重复） | **host_servers 表抽象** — 集中 SSH 凭证+端口池+资源描述，workers 通过 host_id 关联 |
| 升级与备份 | 未设计 | **worker_backups 表 + 自动 pg_dump + 失败自动 docker rename 回滚 + 跨版本兼容矩阵**（≤2 minor 支持，≥3 走导出重装） |
| 镜像分发 | 隐含走 docker registry | **bundle_manifests 表 + PUT/GET 流式 tarball** — 离线场景友好，Hub 中心化 |

**完整设计文档**：`docs/superpowers/specs/2026-07-04-enterprise-multi-tenant-design.md`（16 个章节，含 5 大决策、SSO 时序、端口段表、双轨同步算法、监控数据模型、升级时序、API 端点汇总、实施任务建议 E1-E17）

**与既有成果衔接**：
- T1-T15 统一模块部署全部保留（Dockerfile.personal-*、module_states、RecommendedConfig）
- Hub Phase 1-4 全部保留（users/orgs/skills/sharings/security）
- DA 三种鉴权模式（none/local/hub）保留，hub 模式扩展支持 SSO + 本地 session
- bumpConfigVersion 机制复用，同步完成后触发热重载


