# 第7组：新特性与双轨附件上传（10项）

> 覆盖 2026-06-04 ~ 06-10 新增功能的系统性测试：双轨附件上传(C-222)、附件发起对话(C-221)、过早完成检测(C-223)、工具调用截断恢复(C-224)、Wikipedia增强(C-225)、Markdown流式预处理(C-226)、二进制文件保护(C-218)、证据链全链路验证、跨会话状态隔离增强、通用Agent综合能力。

---

## T51: 双轨附件上传——PDF内联解析与后台KB验证

### 测试设计
**知识库**：无（新建session，不关联任何KB）
**附件**：上传一个 10+ 页的 PDF 文件（如一篇技术论文或法律文书）
**提示词**：先上传PDF附件，然后输入：
> 请详细分析我上传的这份文件的全部内容，逐章逐节进行深入解读，提取所有关键信息、数据、结论。

### 观察目标
1. **Track 1 即时内联**：Agent 首次回复中应包含文件实际内容（而非"文件已保存到 session media"的占位文字），能看到文档中的具体段落、数据、标题
2. **Agent 理解质量**：基于内联文本的分析准确、具体，引用了文档中的实际数据/名称/结论，无幻觉
3. **Track 2 后台 KB**：等待 2-3 分钟后，检查 session 是否自动创建了 `session-{sessionId}` 知识库，文档是否处理完成（status=ready）
4. **kbScope 更新**：session 的 kbScope 自动包含新建的 session KB
5. **追问能力**：追问"请搜索文档中关于XXX的内容"时，Agent 能通过 kb_search 搜索到（说明 Track 2 已生效）
6. **前端显示**：上传文件后显示缩略图/附件标记，发送后 Agent 流式输出分析内容

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| Agent 只看到占位文字 | 检查 agent-runner 的 MediaStore.getOriginalPath + ProcessorFactory.parse 调用链 |
| 内联解析超时 | 调整 PARSE_TIMEOUT_MS（当前15s），或检查 ProcessorFactory 对大 PDF 的处理速度 |
| 后台 KB 未创建 | 检查 ensureSessionKbForDocuments 是否被调用，repos.knowledgeBase.create 是否成功 |
| kbScope 未更新 | 检查 repos.session.updateKbScope 调用时机和参数 |
| 追问时无法搜索 | 检查 kbScope 传递到工具执行的路径，确认 Agent 能发现 session KB |

---

## T52: 多文件混合附件上传——不同类型文件联合分析

### 测试设计
**知识库**：lbctest（110个文档）
**附件**：同时上传 5 个不同类型文件，覆盖新增格式支持：
- 1 个 CSV 表格（包含案件相关的统计数据）
- 1 个 YAML 配置文件（案件相关配置/元数据）
- 1 个 PDF 文件（法律条文摘要）
- 1 个 RTF 文档（补充证据材料，验证 LibreOffice 转换链路）
- 1 个 MD 文本文件（案件分析备忘录，验证 Docling 结构化解析）
**提示词**：
> 我上传了五份补充材料，请你结合知识库中的案件信息，完成以下分析：
> 1. 总结上传的每个文件各自的核心内容
> 2. 将上传材料中的数据与知识库中对应文档进行交叉验证
> 3. 如有不一致之处，明确指出并分析原因
> 4. 给出基于所有材料的综合分析结论

### 观察目标
1. **每个文件都被识别**：Agent 在回复中明确提及五个文件，分别引用各自的内容
2. **CSV 处理**：能读取 CSV 中的表格数据并正确引用（行数/列名/具体数值）
3. **YAML 处理**（C-236）：YAML 键值结构被正确解析，非当作二进制乱码
4. **RTF 处理**（C-156增强）：RTF 经 LibreOffice 转 DOCX 后正确解析，中文不乱码
5. **MD 处理**：Markdown 结构（标题/列表/代码块）被正确识别
6. **PDF 处理**：PDF 内容被正确解析（非乱码）
7. **交叉验证**：Agent 实际使用 kb_search/expand 工具搜索知识库进行对比，而非凭空编造
8. **无幻觉**：引用的具体数据、文件名、内容描述与实际文件一致
9. **后台处理**：所有文件均出现在 session KB 中，L0/L1/L2 处理完成

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 某个文件未被解析 | 检查对应类型的 ProcessorFactory parse 支持 |
| CSV 数据引用错误 | 检查纯文本类型是否直接读取（无需 ProcessorFactory） |
| 交叉验证不充分 | 改进提示词中的交叉验证引导 |
| 多文件上传有文件丢失 | 检查 mediaIds 数组传递完整性 |
| YAML 被当二进制 | 检查 detectFileType 对 yaml/yml 返回 "yaml"，TextProcessor.HANDLED_TYPES 含 "yaml" |
| RTF 解析乱码 | 检查 DocConverterProcessor 是否调用 LibreOffice 将 RTF 转为 DOCX |
| MD 无结构化 | 检查 detectFileType 对 md 返回 "md"（非 "markdown"） |

---

## T53: 附件发起对话——仅上传文件不输入文字

### 测试设计
**知识库**：无
**操作**：在新建 session 中，仅通过回形针按钮上传一张图片和一个 PDF 文件，不输入任何文字，直接点击发送
**预期行为**：Agent 应自动分析上传的文件内容并给出描述/分析

### 观察目标
1. **发送成功**：仅附件无文字时消息成功发送（不被前端拦截）
2. **Agent 响应**：Agent 自动开始分析两个文件，给出图片描述和 PDF 内容分析
3. **图片理解**：图片被正确识别和分析（通过主模型视觉能力或 VLM fallback）
4. **PDF 内容**：PDF 内容被内联解析并分析
5. **无报错**：后端不报 400/500 错误，前端不显示异常
6. **消息显示**：用户消息区域显示附件预览（图片缩略图+文件名）

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 前端拦截空消息 | 检查 MessageInput 的发送守卫——当有 mediaIds 时允许空 text |
| Agent 无响应 | 检查 agents.ts run-stream 路由——允许 body.content 为空但 mediaIds 非空 |
| 图片未分析 | 检查 mediaIds 中图片走 base64 内联的路径 |
| PDF 未分析 | 检查非媒体文件 Track 1 内联解析路径 |

---

## T54: 长文写作——过早完成检测与自动续写验证

### 测试设计
**知识库**：bigtest（242个文档）
**提示词**：
> 请基于知识库中的所有论文内容，撰写一份完整的《人工智能技术发展白皮书》，要求：
> 1. 涵盖 AI 发展的 10 个主要技术方向（NLP、CV、多模态、强化学习、联邦学习、知识图谱、大语言模型、AI安全、AI伦理、AGI展望）
> 2. 每个技术方向需要 3000 字以上的详细论述，包括发展历程、关键里程碑、当前挑战、未来方向
> 3. 包含详细的技术对比表格
> 4. 总字数不低于 5 万字
> 5. 每个论述都要引用知识库中对应论文的具体内容作为支撑

### 观察目标
1. **输出体量**：最终输出不少于 4 万字（允许 20% 容差）
2. **过早完成检测**：观察 Agent 是否出现"规划完就 finish"的情况；如果出现，系统应自动检测并注入续写
3. **续写衔接**：自动续写后内容自然衔接，不出现断裂或重复
4. **内容质量**：10 个技术方向都有覆盖，每个方向有具体论文引用
5. **工具调用**：Agent 使用 kb_search/expand/wiki_browse 等工具获取论文信息
6. **push_content 持久化**：大型报告通过 push_content 推送，刷新页面后仍可见
7. **前端流式**：流式输出逐字显示，无大段空白或突然截断

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| Agent 提前 finish（仅输出规划） | 检查 C-223 过早完成检测逻辑—isThinkingContent 模式是否匹配中文规划文本 |
| 续写不自然 | 调整续写注入消息，引导 Agent 从断点继续而非重头开始 |
| 输出远低于目标 | 检查 max_output_tokens 分级恢复 + 长输出续写是否正常触发 |
| 内容无论文引用 | 改进 Agent 引导——要求分析任务必须引用具体文档 |

---

## T55: 工具调用截断恢复极限场景

### 测试设计
**知识库**：bigtest（242个文档）
**提示词**：
> 请完成以下复杂多步分析任务：
> 1. 使用 wiki_browse(listDocuments) 获取知识库全部文档清单
> 2. 按类型（论文/剧本杀/图片/音视频/表格/代码）分类
> 3. 对每类文档，使用 expand 批量展开获取 L1 内容（每次最多 10 个文档，分批处理）
> 4. 对展开的内容进行深度分析，每类给出 5000 字以上的详细分析报告
> 5. 最后使用 push_content 推送每类的分析报告（6个独立卡片）
> 6. 给出总体的知识库全貌总结（不少于 3000 字）
> 要求：所有 expand 和 kb_search 调用必须完成，不允许跳过任何类别。

### 观察目标
1. **工具调用数量**：总工具调用次数应 >50 次（wiki_browse + 多批 expand + 多次 kb_search + push_content）
2. **截断恢复**：观察是否有工具调用被截断（finish_reason=length 导致参数不完整），系统是否自动重试
3. **批处理完整**：242 个文档分批 expand，每批完成后继续下一批，无跳批
4. **6 个报告卡片**：最终推送 6 个独立 push_content 卡片（每类一个），无遗漏
5. **无重复分析**：同一个文档不出现在两个类别的分析中
6. **流式空闲超时**：大工具调用期间无超时断连（180s 空闲超时保护）
7. **上下文管理**：50+ 轮工具调用后上下文不溢出，压缩正常触发

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 工具调用被截断未恢复 | 检查 C-224 截断检测模式——workflow_run 仅 mode 键、write_file 无 content 等 |
| 批处理中断 | 检查 expand 批量模式错误处理——部分失败不应中断整体流程 |
| 上下文溢出 | 检查 context compaction 触发时机和压缩质量 |
| 流式超时 | 检查 STREAM_IDLE_TIMEOUT 是否生效（应为 180s） |
| 报告卡片遗漏 | 改进 Agent 输出完整性检查，确保 push_content 全部推送 |

---

## T56: 网络搜索综合研究——Wikipedia增强+YouTube+深度报告

### 测试设计
**知识库**：无（纯网络搜索模式）
**提示词**：
> 请完成一份《2026年全球AI芯片竞争格局深度研究报告》，要求：
> 1. 使用 web_search 搜索 NVIDIA、AMD、Intel、华为昇腾、寒武纪等公司的最新AI芯片产品信息
> 2. 使用 wikipedia 获取 AI chip / GPU / TPU 等相关词条的详细内容和修订历史（获取最近一年的修订记录，了解技术更新动态）
> 3. 如果有相关 YouTube 视频链接，使用 youtube_transcript 获取字幕内容
> 4. 整理每家公司的主要AI芯片产品线、技术参数、市场定位
> 5. 分析竞争格局、市场份额趋势、技术路线差异
> 6. 预测未来 2-3 年的竞争态势演变
> 7. 输出不少于 15000 字的完整报告

### 观察目标
1. **Wikipedia 修订历史**：Agent 使用 wikipedia 工具的 get_revisions 功能，获取指定日期范围的修订记录（验证 C-225 增强功能）
2. **youtube_transcript 自动可用**：非 KB session 中 youtube_transcript 工具自动可用（无需 tool_discover）
3. **多源信息整合**：报告内容来源多样（web_search + wikipedia + youtube），有明确引用
4. **日期范围过滤**：Wikipedia 修订历史查询使用了 start/end 日期参数
5. **搜索摘要统一**：所有搜索结果的摘要截断长度一致（1500 字符），无过短截断
6. **报告质量**：竞争格局分析有数据支撑（性能对比表、市场份额估算），非泛泛而谈
7. **无幻觉**：芯片型号、参数、发布日期等事实性信息可追溯到搜索结果

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| youtube_transcript 不可用 | 检查 GENERAL_PURPOSE_DEFERRED_TOOLS 是否包含 youtube_transcript |
| Wikipedia 修订历史参数无效 | 检查 wikipedia tool get_revisions 的 start/end/dir 参数解析 |
| 搜索结果摘要过短 | 检查 MCP 适配器 snippet 截断是否已统一至 1500 字符 |
| 报告内容泛泛 | 改进 Agent 的 web research 搜索策略引导 |
| 事实错误 | 加强 web_search 结果交叉验证引导 |

---

## T57: 通用Agent编码与数据分析综合能力

### 测试设计
**知识库**：无（纯通用Agent模式，不关联任何KB）
**提示词**：
> 请完成以下综合任务（不使用任何知识库工具）：
> 1. 用 python3 编写一个股票数据分析脚本：生成模拟的 30 天股价数据（3只股票），计算移动平均线(MA5/MA10/MA20)、RSI、MACD，输出分析结果
> 2. 运行脚本，验证输出正确性
> 3. 将分析结果用 ECharts 图表可视化（push_content type=chart）
> 4. 基于分析结果写一份投资建议报告（不少于 2000 字）
> 5. 将报告保存为 Markdown 文件（write_file）
> 6. 将报告推送为 push_content 卡片（type=markdown）
> 7. 最后用 finish 工具总结完成情况

### 观察目标
1. **python3 编码**：生成的脚本语法正确、可直接运行，包含 MA/RSI/MACD 计算
2. **bash 执行**：脚本运行成功，输出分析结果
3. **ECharts 图表**：push_content type=chart 正确渲染交互式图表（可缩放/悬停显示数据）
4. **write_file**：文件成功保存到磁盘
5. **Markdown 推送**：push_content type=markdown 卡片正确渲染，Markdown 格式正常（标题/表格/列表）
6. **finish 工具**：finish summary 包含完整总结（非仅"任务完成"）
7. **工具调用截断保护**：若 python3 代码生成时被截断，系统应检测并自动重试
8. **二进制文件保护**：若 Agent 尝试用 read_file 读取 xlsx/xlsm/docx/pptx/zip 等二进制文件，应返回友好错误提示（引导使用 expand 或专用工具）
9. **Markdown 预处理**：Agent 输出的 Markdown 格式正确（标题有空格、列表有换行），验证 normalizeMarkdown 预处理效果

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| python3 脚本语法错误 | 改进 Agent 编码能力——检查 coding-assistant skill 引导 |
| ECharts 不渲染 | 检查 ChartRenderer 组件和 push_content type=chart 的前端处理 |
| write_file 失败 | 检查文件写入权限和路径 |
| finish 短摘要 | 检查 C-117 finish 工具描述是否要求包含完整总结 |
| Markdown 格式错乱 | 检查 normalizeMarkdown 预处理正则 |
| 截断未恢复 | 检查 C-224 工具调用截断检测和重试逻辑 |

---

## T58: 前端Markdown渲染质量与流式显示效果验证

### 测试设计
**知识库**：lbctest（110个文档）
**提示词**：
> 请完成以下分析任务，确保输出中包含多种 Markdown 元素：
> 1. 使用 kb_search 搜索"逮捕"、"搜查"、"起诉"等关键词
> 2. 对搜索结果进行深度分析
> 3. 输出分析报告时，确保包含：
>    - 多级标题（#、##、###、####）
>    - 有序和无序列表
>    - 多列表格（含中文内容）
>    - 加粗和斜体文字
>    - 代码块（如果涉及法规条文编号）
>    - 引用块（blockquote）
>    - 嵌套列表
> 4. 使用 push_content 推送一份包含以上所有元素的综合报告卡片
> 5. 同时在流式输出中也使用这些 Markdown 元素

### 观察目标
1. **流式 Markdown**：流式输出过程中 Markdown 实时渲染正确——标题层级、列表缩进、表格对齐、加粗/斜体均正确显示
2. **push_content 卡片 Markdown**：展开卡片后 Markdown 渲染效果与流式输出一致
3. **normalizeMarkdown 效果**：无 `##标题`（缺空格）导致的格式错误，无列表项粘连
4. **长表格渲染**：表格列数 >5 时不溢出，可横向滚动
5. **中文排版**：中文标题/列表/表格间距合理，无密集堆叠
6. **卡片展开/折叠**：长内容卡片默认折叠，点击展开后完整渲染，底部有收起按钮
7. **证据链接**：报告中引用的文档使用 da-evidence:// 链接，可点击打开预览面板
8. **Thinking 显示**（C-239）：思考面板默认折叠（`useState(false)`），仅显示一行摘要提示和展开箭头；展开后思考内容与正文颜色有区分（slate-400 vs 正文色）；颜色对比清晰，不干扰正文阅读

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 标题后缺空格 | 检查 normalizeMarkdown 中 `##标题` → `## 标题` 正则 |
| 列表项粘连 | 检查 normalizeMarkdown 中列表前换行正则 |
| 表格溢出 | 检查 markdown.css 中表格 overflow-x 样式 |
| 证据链接不可点击 | 检查 processEvidenceLinks + evidencePurifyConfig 配置 |
| 卡片展开后无收起按钮 | 检查 PushContentCard 底部折叠按钮显示条件（dataLen >= 500） |
| Thinking 与正文颜色相同 | 检查 thinking pre 样式是否使用 #94a3b8 |
| 思考面板默认展开占空间 | 检查 MessageItem.tsx 的 showThinking 初始值是否为 false（C-239） |

---

## T59: 跨Session状态隔离与KB作用域切换压力测试

### 测试设计
**操作**：创建 3 个不同 session，快速切换操作，验证状态不串台
**知识库**：Session A 关联 lbctest，Session B 关联 bigtest，Session C 无 KB

**详细步骤**：
1. 创建 Session A，关联 lbctest，发送"列出知识库中所有与'逮捕'相关的文档"等待开始流式输出
2. 在 A 流式输出过程中，立即切换到 Session B（关联 bigtest），发送"列出知识库中所有论文标题"
3. 在 B 流式输出过程中，切换到 Session C（无KB），发送"请解释量子计算的基本原理"
4. 切回 Session A，验证 A 的回复内容仅涉及 lbctest 的法律文档（无 bigtest 内容混入）
5. 切回 Session B，验证 B 的回复内容仅涉及 bigtest 的论文（无 lbctest 内容混入）
6. 在 Session C 中追问"请详细展开"，验证通用对话继续（无 KB 搜索）
7. 切回 Session A，发送"请继续分析逮捕证的内容"，验证 KB 作用域仍正确
8. 在 Session A 中上传一个 PDF 附件并发送"分析这个文件"，验证 Track 1 内联解析正确
9. 快速来回切换 A/B/C 三次，验证每次切换消息列表、滚动位置、流式状态正确

### 观察目标
1. **KB 隔离**：每个 session 的 kb_search/expand 仅搜索自己关联的 KB，无跨 KB 污染
2. **消息不串台**：Session A 的消息不出现在 Session B 的消息列表中
3. **流式状态**：切走再切回时，正在流式的消息正确恢复显示（不丢失/不重复）
4. **ScopeSelector 状态**：切换 session 时知识库作用域正确更新，无残留
5. **附件隔离**：Session A 上传的附件不出现或影响 Session B/C
6. **异步操作守卫**：各 session 的异步 API 回调更新正确的 session（不因竞态更新错误 session）
7. **localStorage 路由**：刷新页面后恢复到正确的 session 和路由
8. **Session KB 正确**：Session A 上传附件后创建的 session KB 仅关联到 Session A

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| KB 搜索跨域 | 检查 tool-registry AsyncLocalStorage 上下文隔离——kbIds 是否从正确的 session scope 读取 |
| 消息串台 | 检查 chat store 的 currentSessionId 守卫——异步 set({messages}) 前是否验证 session |
| 流式恢复失败 | 检查 SSE 重连逻辑和 streaming state 恢复 |
| ScopeSelector 残留 | 检查 scopeReadyRef 逻辑——切换 session 时重置 scope ready 状态 |
| 路由恢复错误 | 检查 localStorage ROUTE_STORAGE_KEY 的保存和恢复逻辑 |
| 附件 KB 串台 | 检查 ensureSessionKbForDocuments 使用的 sessionId 是否正确 |

---

## T60: 端到端全链路——KB创建→上传→预处理→深度分析→证据链→报告→下载

### 测试设计
**知识库**：新建空 KB，动态上传 lbctest 知识库的部分文档（10-20个）
**操作步骤**：
1. 前端创建新知识库"e2e-test-kb"
2. 从 lbctest 的 original 目录选取 15 个代表性文档（含 PDF/DOCX/图片）上传到新 KB
3. 等待所有文档处理完成（L0/L1/L2 全部 ready）
4. 创建新 session，关联该 KB
5. 触发 KB 深度预处理（前端"深度预处理"按钮）
6. 等待预处理完成
7. 发送分析请求：
> 请对知识库中的所有文档进行完整的司法证据链分析，要求：
> 1. 列出所有文档并分类（诉讼文书/证据材料/笔录/其他）
> 2. 构建完整的时间线
> 3. 梳理人物关系和实体网络
> 4. 使用 evidence-chain skill 生成包含 da-evidence:// 链接的证据链报告
> 5. 给出综合案件分析结论
8. 验证证据链接可点击并打开预览面板
9. 验证报告可通过"下载"按钮下载为 Markdown 文件
10. 删除 session，验证 session KB 被正确清理
11. 删除知识库，验证磁盘文件和数据库记录完全清除

### 观察目标
1. **KB 创建**：新建知识库成功，前端显示空 KB 页面
2. **文件上传**：15 个文件并行上传，进度条正确显示
3. **处理完成**：所有文档 status=ready，L1 预览内容有意义（非空/非乱码）
4. **深度预处理**：预处理按钮触发成功，`_preprocessing/` 目录生成概览/表格还原等产物
5. **分析完整性**：Agent 分析覆盖全部 15 个文档，无遗漏
6. **证据链报告**：使用 evidence-chain skill 后，生成包含 da-evidence:// 链接的报告
7. **证据链接可交互**：点击链接打开预览面板，显示原始文档内容（非"Document not found"）
8. **Markdown 下载**：push_content 卡片的下载按钮生成 .md 文件，中文文件名不乱码
9. **Session KB 清理**：删除 session 后，`session-{sessionId}` 知识库被删除
10. **KB 完整清理**：删除知识库后，磁盘 original/wiki 目录、数据库 records、向量索引全部清除
11. **系统日志**：全程后端无 ERROR 日志，无未捕获异常

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 文档处理失败 | 检查 Docling/ProcessorFactory 日志，确认处理通道选择正确 |
| 预处理按钮无效 | 检查 POST /kbs/:kbId/preprocess 端点和 skill 查找逻辑 |
| 证据链接 404 | 检查 da-evidence:// 协议到前端 data-evidence-doc 的完整链路 |
| 下载文件名乱码 | 检查 RFC 5987 contentDispositionValue 函数 |
| Session KB 未清理 | 检查 session 删除时的 `session-{sid}` KB 查找和删除逻辑 |
| KB 删除不彻底 | 检查 G-05 级联清理——嵌入→锚点→链接→页面→文件→记录 |
| 预处理产物未发现 | 检查 wiki_browse preprocessingData 附加逻辑 |
