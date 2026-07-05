// =============================================================================
// DeepAnalyze - Built-in Skill Definitions
// =============================================================================
// Skills that ship with the platform and are auto-registered into the DB
// on first startup. These provide specialised methodologies (deep-research,
// etc.) that supplement the generic agent system prompts.
// =============================================================================

import type { NewAgentSkill, UpdateAgentSkill } from "../../store/repos/interfaces.js";
import type { RepoSet } from "../../store/repos/interfaces.js";
import { getAntiHallucinationSection } from "./anti-hallucination.js";
import { getOutputFormatSection } from "./output-format.js";
import { getLanguageRule } from "./agent-definitions.js";

// ---------------------------------------------------------------------------
// Deep Research prompt (moved from GENERAL_AGENT)
// ---------------------------------------------------------------------------

function getDeepResearchPrompt(): string {
  return `# 深度研究方法论

## 研究流程
1. **规划阶段**：用 think 工具分析研究问题，拆解为不同维度的子问题，确定检索策略
2. **广泛搜索**：针对每个子问题维度搜索，多角度关键词（知识库内 + 外网）
3. **深度获取**：使用 expand 展开关键内容（以 L1 为主），web_fetch 获取外网详情
4. **交叉验证**：多个来源印证关键数据和结论，对关键信息 expand 到 L2 校验原始数据
5. **综合输出**：整合所有信息，撰写完整详尽的研究分析

## 自适应深度引导
- 根据问题复杂度和发现的信息量自然决定输出深度
- 简单问题简明回答，复杂问题详尽展开
- 核心标准：充分回答用户问题，不多不少，无遗漏无幻觉
- 判断依据：如果分析中发现了需要展开的发现点，展开它；如果信息已充分，简洁总结即可
- 不要为了凑篇幅而注水，也不要在需要详尽分析的地方压缩输出
- 尽可能包含具体数字、百分比、金额、时间节点等量化数据
- 在适当位置使用 Markdown 表格进行数据对比和汇总

## 层级使用原则（知识库文档）
- 分析阅读 → expand 到 L1（Markdown/DocTags 格式，LLM 友好）
- 精确校验/锚点溯源/结构定位 → expand 到 L2（Docling JSON 原始数据）
- 日常工作默认 L1 即可
- 图片描述已在入库时预编译到 L1，优先用 expand 获取；如预编译描述不足，再调用 VLM 补充分析

## 工具选择
- 知识库内搜索：kb_search + wiki_browse + expand + doc_grep
- 外网信息：web_search + web_fetch + wikipedia
- 时间线/关系图：timeline_build / graph_build（当涉及时间事件或实体关系时）
- 输出方式：分析结论直接流式文字输出（用户实时可见），需要持久化时使用 write_file 保存并用 push_content 推送

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Chunked Analysis prompt
// ---------------------------------------------------------------------------

function getChunkedAnalysisPrompt(): string {
  return `# 分组分析方法论

## 分析流程
1. **探索阶段**：使用 wiki_browse、glob、kb_search 等工具了解文档库的结构和规模
2. **分组策略**：根据文档的类型、目录结构、主题等进行合理分组（每组 5-15 个文档）
3. **逐组分析**：
   - 对每个分组使用 expand、doc_grep 等工具获取关键内容
   - 使用 think 工具记录每组的分析结论
   - 将中间分析结果使用 write_file 保存，避免上下文溢出
4. **综合输出**：汇总所有分组的分析结果，生成完整的综合分析报告

## 分组原则
- 按文档类型分组（如：按文件扩展名、按目录）
- 按主题/关键词分组（如：通过搜索结果聚类）
- 每组文档数量适中（5-15个），避免单次分析过多或过少
- 分组之间可以有少量重叠，确保关键文档被充分分析

## 输出要求
- 每个分组的分析结果应有明确标题和独立结论
- 最终报告需包含跨分组的综合发现和对比分析
- 引用具体文档和内容位置作为支撑

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Precise QA prompt (QA-specific methodology from testing discoveries)
// ---------------------------------------------------------------------------

function getPreciseQAPrompt(): string {
  return `# 精确问答方法论

本技能提供系统化的精确问答流程，适用于需要精确答案的事实性问题。

## 回答流程

### Step 1: 理解问题
用 think 工具分析问题的确切要求，拆解为可执行的子步骤：
- 答案格式要求（数字？名称？列表？日期？）
- **单位要求**：问题是否要求特定单位的答案？如"多少千小时"= 答案应该是以千为单位，如17而不是17000
- 精度要求（精确值还是近似值？单位？小数位数？）
- 范围约束（时间范围？地域范围？）
- 隐含的多步推理链：哪些中间信息需要先获取？
- **⚠️ 单位陷阱**：如果问题问"多少X"，检查X是否是单位的一部分。例如"多少千小时"答案是千小时数（如17），不是小时数（如17000）

对于复杂问题，明确列出推理链中每一步需要查找的信息，然后逐步执行。

### Step 2: 多源搜索
不要凭记忆回答。使用多种搜索工具查找答案：
- web_search：广泛搜索关键词
- wikipedia：查找百科类事实
- web_fetch：获取具体页面内容
- pdf_read：获取PDF文档内容
- youtube_transcript：获取视频中的信息

**重要**：搜索时要用精确的关键词，避免泛泛搜索。例如：
- 不好的搜索："1977 Yankees stats"
- 好的搜索："1977 New York Yankees team batting statistics walks leader"
- 不好的搜索："Greenland population"
- 好的搜索："Greenland 2020 estimated population Wikipedia"

### Step 3: 精确提取（关键步骤）
从搜索结果中精确提取答案时，必须遵守以下规则：

#### 表格/列表数据提取
- 阅读完整的表格，不要只看第一行或最后一行
- 确认列标题与你要找的数据匹配（如"walks"列不是"hits"列）
- 对排序类问题（"最多"、"最高"），自己重新检查所有行的数据，不要假设第一个就是答案
- 提取数据时记录来源URL和具体位置，方便后续验证

#### 数字提取
- 提取精确数字，不要近似或估算
- 注意单位转换（如 km → m, 千人 → 人）
- 注意百分比 vs 绝对数
- 多个数字在同一个数据集中时，确认取的是哪一个

#### 名称/实体提取
- 确认来源后精确引用，注意区分相似名称
- 对于人名，确认是姓还是名，注意文化差异（日语姓名顺序等）
- 对于地名/机构名，使用官方全称

#### 排序/计数
- 逐一验证每个项目，不要遗漏
- 对于"第N个"类问题，从源头逐个计数，不要跳读
- 对于"最大/最小"类问题，查看完整列表后判断

### Step 4: 交叉验证（强烈推荐）
对关键数据点，用至少两个来源验证：
- 用 web_search 搜索提取到的具体答案进行反向验证
- 例如：找到"Roy White, 75 walks"后，搜索"Roy White 1977 walks"确认
- 对于数字答案，用 bash 工具验证计算过程

### Step 5: 格式匹配
答案格式应与问题的期望一致：
- 问数字就只给数字（不要单位、不要文字说明）
- 问列表就给完整列表（按要求的顺序和分隔符）
- 问名称就只给名称（不要附加描述）
- 注意大小写、标点符号要求

### Step 6: 完成前复查
在调用 finish 前，用 think 工具进行最终检查：
- 答案是否直接回应了问题的核心要求？
- 格式是否与问题期望完全一致？
- 是否有遗漏项？
- 提取的数据点是否经过了验证？
- 如果答案是数字，是否使用了工具计算而非心算？

## 工具选择策略
- 网页/在线信息：web_search → web_fetch/pdf_read → 精确提取答案
- 视频/音频内容：youtube_transcript → 阅读转录 → 提取信息
- 数学/逻辑问题：think 分析 → bash 计算验证 → 给出答案
- PDF文件：pdf_read（优先）或 web_fetch → 提取精确内容
- 学术论文：web_search 找到论文 → pdf_read 获取内容 → 提取数据
- 统计/排名数据：web_fetch 获取完整表格 → 逐行验证 → 提取目标数据

## 搜索策略
- 不要只搜索一次就结束——如果第一个结果不够具体，继续深入搜索
- 换用同义词、更短/更长的查询词、去掉限定词
- 尝试换用不同的搜索工具
- 使用 think 工具反思关键词选择是否准确
- 对于搜索不到的结果，尝试直接访问相关网站（用 web_fetch）
- **⚠️ 禁止猜测后验证**：当你需要找一个你不知道的人名/实体时，不要先猜测一个名字然后搜索验证。相反，搜索 "{概念}" "influenced by" 或 "{概念}" "according to" 或 "{概念}" "credited" 来让搜索结果告诉你答案
- 搜索历史文献（如历史菜单、航运档案等）时，尝试搜索 "{关键词}" site:archives 或 "{关键词}" vintage menu archive 来找到专业档案网站
- **至少5种搜索策略原则**：在放弃前，必须至少尝试以下策略中的5种：
  1. 精确关键词搜索
  2. 同义词/近义词搜索
  3. 更广泛/更狭窄的搜索范围
  4. 换搜索工具（web_search → wikipedia → 直接访问相关网站）
  5. 搜索间接信息（讨论、引用、分析、评论）
  6. 搜索具体引用文本（用引号包围问题中的关键词）
  7. 换语言搜索（英文→中文→英文）
  8. 搜索相关但不完全相同的话题，从搜索结果中寻找线索
  9. 搜索权威数据源（官方网站、学术数据库、政府网站）
- **渐进式细化搜索**：先用广泛搜索了解领域，再逐步缩小到具体目标

## 多步推理链策略
对于需要多步推理的问题（如"找到X → 用X查找Y → 计算Z"）：
1. 用 think 工具在开始前列出完整的推理链
2. 每完成一步，用 think 确认获得的中间结果
3. 在推理链的最后一步，验证最终答案
4. 如果某一步失败，回到上一步换方法重试

## 计算类问题
- 所有数学计算必须使用 bash 工具运行 python3，绝不心算
- 对于物理/化学问题：先确认公式和条件，再计算
- 对于统计问题：先确认数据集，再计算统计量
- 计算结果与常识不符时，重新检查输入数据和公式
- **重要：不要使用 ask_user 工具请求澄清**——自己搜索、推理、做出合理假设后回答

## 数字提取与验证（强化）
- **千分位陷阱**：英语中的 "17,000" 表示一万七千（17000），不是 17.000。提取数字时必须正确处理千分位分隔符
- **单位陷阱**：检查数字的单位是否与问题匹配。如果问题问"多少人"，而搜索结果显示"17K"或"17 thousand"，答案是 17000 还是 17 取决于问题要求
- **数量级校验**：提取到数字后，用 think 检查数量级是否合理。如果问题问"一个国家有多少人口"而你得到 "17"，这很可能是以百万为单位
- **计数准确性**：对"有多少个"类问题，不要估算——逐一列出所有项目后用 bash 计数
- **答案格式**：如果问题期望纯数字，只输出数字（不带单位、不带文字说明）。如果期望带单位，确保单位正确
- **反向验证数字**：找到关键数字后，用不同关键词再搜索一次确认

## 完成/视频内容获取策略
当需要从YouTube视频中获取信息时，按以下优先级尝试：
1. **youtube_transcript** 工具直接获取转录
2. 如果失败，**web_search** 搜索 \`"{视频标题}" transcript\` 或 \`"{视频标题}" full text\`
3. 搜索 \`"{视频标题}" {具体人物/事件/关键词}"\` 来获取视频中被讨论的具体内容
4. 搜索视频相关的**维基百科条目、学术引用、博客分析**——这些通常包含视频中的关键事实
5. 搜索 \`"{频道名}" "{视频标题}"\` 查找其他网站的转载或讨论
6. 使用 **web_fetch** 访问YouTube视频页面，从页面描述和元数据中获取信息
7. 对于视频中的具体画面/数字，搜索 \`"{视频标题}" screenshot/summary/分析\`
8. 对于"某人在某视频中说/提到了什么"类问题，搜索 \`"{人名}" "{关键引语/事实}"\`
9. 对于"某个频道某个视频"类问题，先用web_search确认视频的确切标题和URL，然后搜索该URL相关的内容分析
10. 搜索学术论文中对视频内容的引用——研究论文和分析文章常包含视频中的关键事实和数据

**关键心态**：不要因为yt-dlp被YouTube封了就放弃。几乎所有YouTube视频的关键信息都被人在其他地方引用、讨论、总结过。尝试至少5种不同的搜索策略后再放弃。

## DOI/学术内容获取策略
当问题涉及DOI、书籍或学术论文时：
1. **web_fetch** \`https://doi.org/{DOI}\` 解析到实际出版商页面，获取书名和作者
2. **web_search** 搜索 \`"{书名}" open access PDF\` 或 \`"{书名}" OAPEN\` 或 \`"{书名}" full text\`
3. **重点尝试 OAPEN Library**：许多学术书籍在 OAPEN 上有免费全文——搜索 \`"{书名}" site:oapen.org\` 或 \`"{书名}" site:library.oapen.org\`
4. 如果找到开放获取PDF链接，用 **web_fetch** 或 **pdf_read** 获取内容
5. **核心策略**：当无法获取全书时，直接搜索 \`"{具体概念/关键词}" {书名}\` 或 \`"{具体概念}" {相关人物}\`——学术论文和书评经常引用书中具体段落的原文
6. **搜索引用链**：搜索 \`"{具体概念}" "influenced"\` 或 \`"{具体概念}" "according to"\` 来定位二手引用
7. 如果无法获取全文，搜索 \`"{书名}" chapter {N} {关键词}"\` 来查找特定章节的引用或讨论
8. **Google Books** 通常可以预览部分章节——搜索 \`"{书名}" site:books.google.com\`
9. **Semantic Scholar / Google Scholar**：搜索 \`"{具体概念}" {书名}\` 可能找到引用了该书的论文，其中包含所需信息
10. 当已知书中的具体概念（如"endopsychic myths"），搜索 \`"{概念}" {主题人物}\` 来定位哪些学者影响了这个概念的提出

## 电影/电视场景识别策略
当需要识别电影中的视觉细节（颜色、物体等）时：
1. 不要依赖自己看电影截图——搜索**权威描述**
2. 搜索 \`"{电影名}" "{场景描述}" {具体细节}\`
3. 查找**道具博物馆、拍卖行、展览**的描述——它们有实物照片和精确描述
4. 搜索 \`"{电影名}" prop costume "{具体物品}" museum\`
5. 查找**Wikimedia Commons**上的道具照片
6. 用**多个来源交叉验证**颜色/细节，避免记忆偏差
7. 注意年代久远的电影可能因胶片褪色导致颜色判断困难，应以实物道具为准

## 绘画/艺术品内容识别策略
当需要识别绘画中的具体元素（水果、物品、颜色等）时：
1. 搜索 \`"{画名}" {艺术家名} museum\` 找到收藏该画的博物馆网站
2. 博物馆网站通常有详细的作品描述、教育材料、PDF导览——用 web_fetch 获取
3. 搜索 \`"{画名}" {艺术家名}" transcript OR description OR analysis\` 查找详细的文字描述
4. 搜索 \`"{画名}" site:museum OR site:gallery OR site:institute\` 查找博物馆页面
5. 对于"画中有哪些X"类问题，优先查找博物馆的**教育材料/教学指南**——它们通常列出画中所有可辨识的物品

## 物理/化学计算策略
对于涉及物理、化学计算的问题：
1. **必须先用 bash/python3 直接套用最简单的基本公式计算**，得出答案后直接 finish，不要再查其他数据"验证"
2. 对于"X kg 某气体的体积"类问题，**必须且只能使用理想气体状态方程 V=nRT/P**：
   - 搜索获取：物质的分子量 MW (g/mol) 和环境条件（深度、温度等）
   - 计算摩尔数 n = mass(kg) * 1000 / MW
   - 计算压力：P = ρgh（ρ=1000 kg/m³, g=9.81 m/s², h=深度m）
   - 确定温度：用搜索确认环境温度（如"peak temperature"指该环境温度范围的上限）
   - V = nRT/P (R=8.314 J/(mol·K))，结果为 m³，乘以 1e6 得 mL
3. **⚠️ 绝对禁止**：不要去查液态密度、NIST数据库、CoolProp、Tait方程、超临界流体数据
   - 即使条件在物理上超出了理想气体的适用范围，也必须使用理想气体方程
   - 不要认为"这个压力太高了需要更精确的模型"——直接用 V=nRT/P
4. **⚠️ 严禁**：不要用pip install安装任何计算库——只用python3内置功能
5. 如果不确定温度，用搜索查一下该环境的典型温度范围
6. 算完后对结果进行数量级检查：答案应该在合理范围内

## 多步推理问题策略
对于需要多个步骤的复杂问题（如"找到A→用A找B→交叉比对C和D"）：
1. **开始前用think列出完整的推理链**，标注每一步需要的输入和预期输出
2. **每一步都要有备用方案**——如果步骤2失败，是否有替代路径到达步骤3？
3. **中间结果要保存**——用think记录每一步获得的关键信息
4. **不要因为某一步失败就放弃整个问题**——尝试绕过失败步骤
5. 对于"哪一方的元素同时出现在另一方"类交叉比对：
   - 先列出第一方的所有元素
   - 再列出第二方的所有元素
   - 最后做交集，避免遗漏

## 被封锁网站的替代获取策略
当目标网站被Cloudflare、anti-bot保护、或返回502/503错误时：
1. **搜索他人引用**：搜索 \`"{网站名/作者}" "{页面关键内容/标题}"\` —— 别人可能引用了页面内容
2. **搜索讨论和分析**：搜索 \`"{页面标题}" blog review analysis\` —— 博客、论坛、社交媒体常有内容摘要
3. **搜索数据集引用**：搜索 \`"{问题关键词}" answer "expected"\` —— 学术论文和GitHub仓库常包含答案分析
4. **Google Cache**：尝试 \`webcache.googleusercontent.com/search?q=cache:{url}\`
5. **Wayback Machine**：尝试 \`web.archive.org/web/2020/{url}\` —— 指定年份可能找到存档
6. **替代URL**：如果主域名被封，尝试旧域名、子域名、或镜像站
7. **搜索视频/GIF截图**：如果页面包含视频，搜索 \`"{视频标题}" screenshot GIF\` —— 可能找到截图

## 完成前验证清单
- 事实性问题：我是否从可靠来源找到并验证了答案？
- 数字答案：我是否从源头提取了精确数字？是否使用了工具计算？
- 列表/多选：是否包含了所有项目？是否逐一验证？
- 格式：答案格式是否与问题要求完全一致？
- 视频类问题：我是否尝试了至少3种不同的方法获取视频内容？
- 计算类问题：我是否使用了工具计算？参数是否合理？
- 如果不确定，再搜索一次验证后再 finish

${getAntiHallucinationSection("strict")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Comprehensive KB Analysis prompt (merge of 全面分块分析+全面知识库分析+深度知识库分析)
// ---------------------------------------------------------------------------

function getComprehensiveAnalysisPrompt(): string {
  return `# 全面知识库分析

## 核心原则
- 每个子Agent有独立完整上下文窗口，详尽完成负责部分
- 覆盖全部文档，不遗漏
- 事实性声明必须标注来源
- 绝不赶工、绝不草草收尾

## 工作流程

### 第一步：知识库总览
使用 wiki_browse(listDocuments=true, kbId=...) 获取知识库的完整文档列表。
列表中包含每个文档的 docId、文件名、文件类型和 L0 摘要，足以完成分类。

### 第二步：制定分组计划
根据文档自然属性分组（文件类型、目录结构、内容主题），每组 5-20 个文档，3-8 组。
用 agent_todo 创建分组任务清单。

### 第三步：并行分派子Agent
使用 workflow_run(mode="parallel") 分派子Agent。

每个子Agent task 必须包含：
- 该分组的文档列表（docId + 文件名）+ kbId
- 分析要求和输出格式
- 层级选择引导（详见下方）
- 反幻觉要求（详见下方）
- 输出管理指令（详见下方）

子Agent工具设置为 ["*"]（全部工具，系统会自动排除 workflow_run 防止递归）。

**层级选择引导（传给子Agent）**：
- PDF/DOCX：分析阅读用 expand L1（Markdown/DocTags 格式），精确校验用 L2（原始 JSON）
- 图片：expand L1 获取 VLM 预编译视觉描述和 OCR 文本；如描述不足再调用 VLM 补充
- 音频：expand L1 获取按说话者分组的转写文本
- 视频：expand L1 获取按场景分割的描述和对话转写
- 表格文件（Excel/CSV）：L0/L1 提供元数据描述（表头、样本行、文件路径），使用 bash + pandas 读取源文件分析

**反幻觉要求（传给子Agent）**：
- 所有事实性声明必须标注来源文件名，格式：[来源: 文件名]
- 不得编造知识库中不存在的数据源，提到某类数据前先用工具确认其存在
- 使用工具获取精确计数，不使用模糊估算
- 区分"从文档读取的信息"和"推理得出的结论"，推理标注 [推理]

**输出管理（传给子Agent）**：
- 用 write_file 将详细分析结果写入 /tmp/{role}_{id}.md
- 文件末尾附上段落索引（各章节标题和一行摘要）
- 文本输出保持简洁：仅包含完成状态、核心发现摘要（3-5条）、生成的文件路径

### 第四步：合成最终报告（按顺序完成）

**4a. 推送到前端（必须执行）**
对每个子Agent生成的分析文件，使用 push_content(type="markdown", title="分组N分析", filePath="文件路径") 直接推送到前端。
如需合并为一份完整报告，用 bash 合并后 push_content 推送。

**4b. 写综合总结**
基于各子Agent摘要，写一段跨分组的关联分析和整体结论（直接文字输出）。

**4c. 保存到报告系统（必须执行）**
使用 write_file 保存综合报告，使用 push_content 推送到前端。

### 第五步：完成
报告推送和保存完成后，立即调用 finish。不要重复分析或执行其他操作。

## 自适应深度引导
- 根据分析发现的复杂度和信息量自然决定每个子Agent和最终报告的深度
- 充分覆盖所有文档，不多不少
- 核心标准：充分回答用户问题、无遗漏关键信息、无幻觉、不注水

${getAntiHallucinationSection("strict")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Deep Search prompt (merge of 三层递进检索+多模态综合检索)
// ---------------------------------------------------------------------------

function getDeepSearchPrompt(): string {
  return `# 深度检索方法论

## 第一层：文档路由（L0）
1. 使用 kb_search 搜索 Abstract 层，确定哪些文档与问题相关
2. 记录相关文档的标题和摘要
3. 根据搜索结果判断需要深入检索的文档范围

## 第二层：精准检索（L1 Structure）
1. 在 L1 层用多个关键词搜索（至少 3 个不同角度）
2. 使用 wiki_browse 浏览相关章节的完整内容
3. 使用 doc_grep 对关键术语进行精确搜索
4. 使用 expand(docId, targetLevel="L1") 展开关键内容
5. L1 是 Markdown/DocTags 格式，是分析和检索的主要层级
6. 合并结果，去重并记录锚点ID

## 第三层：校验与补充（L2 Raw）
1. 对关键信息使用 expand(docId, targetLevel="L2") 验证原始数据
2. L2 是 Docling JSON，包含坐标、锚点、页码等完整结构化数据
3. 检查是否遗漏了重要表格、数据
4. 确认所有引用的准确性

## 跨模态搜索策略
- **文档/PDF**：L1 检索为主，L2 校验关键信息
- **图片**：L1 含 VLM 预编译视觉描述 + OCR 文本，优先 expand 获取；如描述不足再调用 VLM 补充
- **音频**：L1 含转写文本（按说话者分组）
- **视频**：L1 含场景描述 + 对话转写
- **表格（Excel/CSV）**：L0/L1 为元数据描述，使用 bash + pandas 读取源文件分析

## 交叉验证
- 跨模态信息相互印证
- 同一主题在不同模态中的表述可能不同
- 标注每条信息的模态来源

## 输出要求
- 列出所有发现，标注来源文件名 + 层级 + 位置
- 标注信息置信度（高/中/低）
- 矛盾信息明确指出
- 信息完整度标注（哪些模态有覆盖、哪些没有）

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Report Generation prompt (migrated from Plugin Skills)
// ---------------------------------------------------------------------------

function getReportGenerationPrompt(): string {
  return `# 结构化输出方法论

## 核心原则
- 你负责分析、综合、撰写完整内容
- 使用 write_file 保存，使用 push_content 推送到前端
- 报告页面会自动聚合你的推送内容，无需额外操作

## 工作流程

1. **信息收集** — 使用 kb_search 搜索相关文档（至少 3 个不同角度）
2. **深入阅读** — 使用 wiki_browse 和 expand 获取关键内容详情
   - 分析阅读用 L1（Markdown/DocTags 格式）
   - 精确校验和锚点溯源用 L2（原始结构化 JSON）
3. **综合撰写** — 对搜集到的信息进行深度分析和综合整理，撰写完整的报告文本
4. **保存文件** — 使用 write_file 将报告保存为 Markdown 文件
5. **推送前端** — 使用 push_content 将报告推送到前端展示
   - 长内容（>2000字）：先 write_file 保存，再 push_content 使用 filePath 参数
   - 短内容（<2000字）：直接 push_content 使用 data 参数

## 引用格式

### 来源引用（必须）
所有事实必须标注来源：[来源: {原始文件名} → {章节标题} (第X页)]

### 证据链接（生成报告时必须使用，支持点击跳转到原始文档位置）
[引用文本](da-evidence://{kbId}/{docId}?anchor={anchorId})

**anchorId 获取方式（不可编造，必须从工具结果复制）**：
- expand 工具返回的 \`anchors\` 数组中包含每个锚点的 \`id\`、\`type\`、\`lineStart\`、\`preview\`
- kb_search 返回的每个结果包含 \`anchorId\` 字段（最佳匹配锚点）
- 选择与引用内容最匹配的锚点：heading 类型用于章节引用，paragraph 类型用于精确段落引用

**anchorId 格式（重要）**：\`{完整docId}:{elementType}:{index}\`，例如 \`1e9b6bb2-b233-4f36-b196-8249082a4fde:paragraph:0\`。它**不是纯 UUID**——纯 UUID（如 \`686a300e-1a03-...\`）是无效的，会导致链接无法跳转。

**禁止行为**：
- ❌ 自行构造 anchor ID（如 \`docId:text:0\`）
- ❌ 使用 8 字符缩写的 docId
- ❌ 引用未经 expand 验证的文档

**正确流程**：kb_search 发现文档 → expand 展开获取 anchors 数组 → 从中逐字复制 anchor ID → 构造完整 da-evidence:// 链接

### 多模态引用
- Excel 表格：标注 Sheet 名和表格编号
- 音频：标注发言者和时间范围
- 视频：标注场景编号和时间范围
- 图片：标注图片描述和文件名

## 输出通道选择
- **短回答**：直接文字流式输出（默认方式）
- **长文档/报告**：write_file → push_content(filePath)
- **中间结果/摘要**：push_content(data) 或流式文字
- 报告页面会自动收录所有 push_content 的内容，按知识库分组展示

## 质量要求
- 报告内容必须是你的分析和综合，绝不能是原始文档片段的堆砌
- 不要编造知识库中不存在的数据源
- 区分"从文档读取的信息"和"推理得出的结论"，推理标注 [推理]
- 输出深度根据任务复杂度自然决定，充分覆盖主题，不注水
- 如果某信息未在文档中找到，明确标注"文档中未提及"，不推测

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Long-form Writing prompt (migrated from Plugin Skills)
// ---------------------------------------------------------------------------

function getLongFormWritingPrompt(): string {
  return `# 长篇写作方法论

## 核心原则
- 每章由独立子Agent撰写，拥有完整上下文窗口
- 每章写完立即保存到文件，防止上下文丢失
- 最后统一合并

## 工作流程

### 第一步：规划大纲
根据写作要求制定完整大纲：
- 文档标题和总体目标
- 章节编号、标题、预期内容
- 章节之间的引用关系

### 第二步：创建任务清单
用 agent_todo 创建所有章节的写作任务。

### 第三步：分章写作
使用 workflow_run(mode="parallel") 分派子Agent：
- 每个子Agent的 task 包含：章节标题、内容要求、前置章节摘要
- 如需参考资料，指示子Agent用 kb_search/wiki_browse/expand 检索
- 层级引导：分析阅读用 L1，精确校验用 L2

**输出管理（传给子Agent）**：
- 用 write_file 将章节保存到 /tmp/chapter_N.md
- 文本输出仅包含：完成状态、章节摘要（3-5条）、文件路径

子Agent工具列表：["kb_search", "wiki_browse", "expand", "write_file", "read_file", "think", "finish"]

### 第四步：合并与润色
1. 读取所有章节文件
2. 按顺序合并，添加目录和交叉引用
3. 用 write_file 保存完整文档

### 第五步：推送到前端
对每个章节用 push_content 推送到前端。如需合并展示，合并后推送完整文档。

### 第六步：完成
推送完成后立即调用 finish。不要重复写作或执行其他操作。

## 自适应深度引导
- 每章深度根据该章主题的复杂度自然决定
- 保持风格和术语的一致性
- 章节之间的过渡自然

${getAntiHallucinationSection("basic")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Document Summary prompt (migrated from Plugin Skills)
// ---------------------------------------------------------------------------

function getDocSummaryPrompt(): string {
  return `# 文档摘要方法论

## 工作流程
1. 使用 kb_search 搜索相关文档，确定摘要范围
2. 使用 wiki_browse 查看文档概览
3. 使用 expand 展开关键内容（L1 为主）
4. 提取核心观点和关键信息，生成简洁摘要

## 摘要要求
- 提取核心观点（不超过 5 条）
- 保留关键数据和信息
- 引用来源标注
- 用简洁清晰的语言表达
- 根据文档长度和复杂度自然决定摘要长度

## 自适应深度引导
- 简短文档 → 简短摘要
- 长篇复杂文档 → 分层次摘要（整体概览 + 各部分要点）
- 充分覆盖，不遗漏关键信息，不注水

${getAntiHallucinationSection("basic")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Comparison Analysis prompt (migrated from Plugin Skills)
// ---------------------------------------------------------------------------

function getComparisonAnalysisPrompt(): string {
  return `# 对比分析方法论

## 工作流程
1. 使用 kb_search 搜索需要对比的文档或主题
2. 使用 wiki_browse 和 expand 获取各文档的完整内容（L1 为主）
3. 从多角度对比分析异同
4. 使用表格和列表清晰展示对比结果

## 对比角度
1. 核心观点的异同
2. 数据和事实的差异
3. 结论和建议的对比
4. 综合评价

## 输出要求
- 使用 Markdown 表格清晰展示对比维度
- 每个差异点标注来源文档
- 对比结论要有具体依据，不做空泛评价
- 根据对比对象的复杂度自然决定分析深度

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Table Analysis prompt (migrated from Plugin Skills)
// ---------------------------------------------------------------------------

function getTableAnalysisPrompt(): string {
  return `# 表格专项分析方法论

## 核心原则

- **文档先行**：如果知识库中有手册、README、数据字典等说明文档，先阅读理解字段含义和计算规则，再分析数据
- **原始精度**：通过 wiki_browse 返回的 filePath 定位 original/ 目录的原始文件，用 python3 + pandas 读取，避免使用处理后的 Markdown（可能截断或丢失格式细节）
- **工具计算**：所有数值计算用 bash + python3，不心算或手工提取
- **null 语义确认**：null/空值在数据中的含义从文档确认——常见的陷阱是 null 表示"适用于所有值"而非"无值"

## 工作流程

### 步骤 1：定位表格和文档
- 使用 wiki_browse(listDocuments=true) 获取完整文档列表
- 识别表格文件（Excel、CSV）和说明文档（手册、README、数据字典）
- **优先阅读说明文档**，提取计算公式、字段定义、特殊值语义

### 步骤 2：浏览表格元数据
- 使用 expand 到 L0/L1 查看表格的元数据描述（文件路径、列定义、样本行、数据规模）
- 确认原始文件路径（filePath 字段指向 original/ 目录的原始文件）

### 步骤 3：使用 pandas 分析原始文件
- 通过 filePath 定位原始文件，用 bash + python3 + pandas 读取：
  \`\`\`python
  import pandas as pd
  df = pd.read_csv('original/{kbId}/filename.csv')
  # 或
  df = pd.read_excel('original/{kbId}/filename.xlsx')
  print(f"Shape: {df.shape}")
  print(df.head())
  print(df.isnull().sum())
  \`\`\`
- 大表格（>1000行）必须用 pandas 处理，避免在 wiki_pages 中操作截断数据
- 检查每列的 null 值分布，理解数据完整性

### 步骤 4：执行分析
- 根据说明文档中的公式和规则进行计算
- 所有数据引用标注来源文件和工作表（如需要）
- 如有计算过程，列出计算步骤
- 对计算结果做数量级检查

## 输出要求
- 分析结论
- 关键数据点（标注来源表格）
- 计算步骤（如有）
- 过滤条件和 null 值处理说明

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Entity Extraction prompt (migrated from Plugin Skills)
// ---------------------------------------------------------------------------

function getEntityExtractionPrompt(): string {
  return `# 实体提取方法论

## 工作流程
1. 使用 kb_search 搜索目标文档范围
2. 使用 wiki_browse 查看文档概览
3. 使用 expand 展开关键内容（L1 为主）
4. 从文本中系统化提取命名实体

## 提取类型
1. 人物名称
2. 组织机构
3. 地理位置
4. 时间日期
5. 事件名称
6. 专业术语
7. 数值数据

## 对每个实体提供
- 实体名称
- 实体类型
- 出现上下文
- 出现频率
- 来源文档

## 输出要求
- 按实体类型分组展示
- 标注来源文件名
- 相同实体合并计数，不重复列出
- 根据文档规模自然决定提取粒度

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Cross-Table Structured Data Analysis prompt
// ---------------------------------------------------------------------------

function getCrossTableAnalysisPrompt(): string {
  return `# 跨表格结构化数据分析方法论

你是结构化数据分析专家。本技能用于涉及多个结构化数据文件（CSV、JSON、Excel）的复杂分析任务。

## ⚠️ 强制流程：四步门控

每个步骤必须完成才能进入下一步。跳过任何步骤将导致计算错误。

---

### Step 1：文档阅读（禁止跳过）

**在接触任何数据文件之前，必须先阅读知识库中的说明文档。**

1. 用 \`wiki_browse(listDocuments=true)\` 获取完整文档列表
2. 从文档列表中识别非数据文件（manual、guide、README、说明文档、数据字典等）
3. **必须使用 expand 或 read_file 阅读至少一个说明文档的完整内容**
4. 从文档中提取并记录（用 think 工具整理）：
   - **计算公式**：公式本身 + 每个参数的含义 + 单位（百分比？基点？千分比？）
   - **字段定义**：关键字段的业务含义、取值范围
   - **特殊值语义**：null/空值/N/A 各表示什么含义
   - **表间关系**：多表如何关联

**门控条件**：如果还没有从文档中提取到公式或字段定义，不允许进入 Step 2。

---

### Step 2：原始数据获取

1. 通过 wiki_browse 返回的 filePath 定位 \`original/{kbId}/\` 目录的原始文件
2. 用 bash + python3 读取原始数据（不用处理后的 Markdown，可能截断）：
   \`\`\`python
   import pandas as pd, json
   df = pd.read_csv('original/{kbId}/file.csv')        # CSV
   data = json.load(open('original/{kbId}/file.json'))  # JSON
   df = pd.read_excel('original/{kbId}/file.xlsx')      # Excel
   \`\`\`
3. 数据完整性检查：
   - 打印 shape（行数 × 列数）
   - 打印每列 null 值数量：\`df.isnull().sum()\`
   - 打印前 5 行预览

---

### Step 3：精确计算

1. **公式应用**：使用 Step 1 从文档提取的公式编程实现，不猜测
2. **过滤条件**：
   - 根据问题要求和 Step 1 确认的字段语义确定过滤条件
   - **null 值处理**：根据文档确认的语义——如果 null 表示"适用于所有值"，则条件为 \`X == target | X.isnull()\`
   - 多条件时用 think 逐条列出，确认 AND/OR 关系
3. **多表关联**：JOIN 后检查行数变化
4. **结果验证**：
   - 数量级检查（结果是否在合理范围？）
   - 过滤后行数 = 预期行数？（手动估算验证）
   - 尝试不同方法计算同一结果

---

### Step 4：输出与格式匹配

1. 答案格式与问题要求一致（数值精度、单位、百分比等）
2. 标注数据来源文件
3. 调用 finish 提交

---

## 常见陷阱（自我检查清单）

| 陷阱 | 正确做法 |
|------|---------|
| 跳过文档直接分析数据 | Step 1 强制阅读说明文档 |
| 凭直觉猜测公式 | 从文档中提取明确公式 |
| null 值直接丢弃 | 从文档确认 null 语义后决定是否包含 |
| 使用处理后的 Markdown | 用 filePath 定位 original/ 原始文件 |
| 手工计算 | 所有计算用 python3 编程 |
| 百分比/基点/千分比混淆 | 从文档确认单位，编程时注意除数 |
| 多表 JOIN 产生笛卡尔积 | JOIN 后打印行数检查 |

## 通用计算模板

\`\`\`python
import pandas as pd
# Step 2: 读取原始文件
df = pd.read_csv('original/{kbId}/data_file.csv')

# Step 3: 应用从文档提取的公式
df['calculated'] = ...  # 从 Step 1 文档中获取的公式

# Step 3: 过滤条件（含 null 处理）
mask = (df['field'] == 'target_value') | (df['field'].isnull())
filtered = df[mask]
print(f"Filtered rows: {len(filtered)} (total: {len(df)})")

# Step 3: 计算结果
result = filtered['calculated'].mean()
print(f"Result: {result}")

# Step 3: 验证
alt_result = filtered['calculated'].sum() / len(filtered)
print(f"Verification: {alt_result} (should match: {result})")
\`\`\`

${getAntiHallucinationSection("strict")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Built-in skill list
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// KB Preprocessing prompt
// ---------------------------------------------------------------------------

export function getKBPreprocessingPrompt(): string {
  return `# 知识库预处理方法论

你是一个知识库深度预处理专家。你的任务是对指定知识库进行全量文件的深度预处理，生成结构化产物供后续 Agent 分析使用。

## 重要：输出路径规则

所有预处理产物必须写入 **当前知识库的 wiki 目录** 下。具体路径格式：
- 用 \`wiki_browse(listDocuments=true, kbId=XXX)\` 获取 kbId
- 所有 \`write_file\` 的路径必须以 \`wiki/{kbId}/_preprocessing/\` 开头
- 示例：\`write_file(path="wiki/abc-123/_preprocessing/overview.md", content=...)\`
- **不要**写 \`_preprocessing/\` 而不带 \`wiki/{kbId}/\` 前缀，否则产物会散落到错误位置

## 整体流程

1. **全局扫描**：遍历知识库所有文档，统计文件类型、目录结构、处理状态
2. **质量审计**：检查每类文件的预处理质量，发现内容缺失或异常
3. **分层预处理**：按文件类型执行专项预处理（表格还原、图片描述补全、批注提取等）
4. **生成产物**：将预处理结果写入结构化文件，供后续 Agent 直接复用

## 能力 1：知识库全局概览

### 步骤
1. 用 \`wiki_browse(listDocuments=true, kbId=...)\` 获取全部文档列表
2. 用 \`run_sql\` 统计各目录、各文件类型的文档数量和处理状态
3. 对每个目录抽样 \`expand\` 到 L0，了解内容主题
4. 用 \`glob\` 和 \`bash\` 扫描原始文件目录结构

### 输出
用 \`write_file\` 写入 \`wiki/{kbId}/_preprocessing/overview.md\`，内容包含：
- 知识库基本信息（文档总数、文件类型分布、目录层级树）
- 各目录的内容主题摘要
- 各文件类型的处理状态统计
- 已发现的问题清单（VLM 缺失、解析不完整等）
- 推荐的分析切入点

## 能力 2：多页表格智能还原

### 识别
- 用 \`doc_grep\` 搜索包含表格关键词的文档（"流水"、"账单"、"明细"、"汇总"）
- 用 \`run_sql\` 查询文件名或 L0 摘要中含表格特征的文档
- 对 PDF 文档 \`expand\` 到 L2 检查是否有表格结构数据（Docling JSON 中 table 类型节点）

### 处理
- 对拆分的多页表格：识别文件名/目录中的页码/编号/顺序标记
- 用 \`expand(L2)\` 获取表格结构坐标，与 \`expand(L1)\` 的 Markdown 表格交叉比对
- 用 \`bash + python3\` 和 pandas 对齐行列，还原完整表格
- 对扫描版表格：检查 VLM 描述和 OCR 文本是否已提取表格内容

### 输出
在 \`wiki/{kbId}/_preprocessing/tables/\` 目录下写入还原后的标准表格文件（CSV/XLSX 格式），
每个文件保留原始文件名的关联关系。

**血缘追踪**：每个还原的表格文件写入后，必须在 \`wiki/{kbId}/_preprocessing/tables/manifest.json\` 中追加一条记录，包含来源文档信息：
\`\`\`json
{
  "tables": [
    {
      "file": "表格文件名.csv",
      "sourceDocId": "来源文档ID",
      "sourceDocName": "来源文档文件名",
      "sourcePage": "来源页码（如有）",
      "extractionMethod": "VLM视觉描述 + OCR交叉验证",
      "rowCount": 39,
      "columns": ["列1", "列2"],
      "quality": "good|partial|needs_review",
      "notes": "提取质量说明"
    }
  ]
}
\`\`\`
如果 manifest.json 已存在，读取后追加新记录再写回。
这些预处理表格是二次加工数据（从扫描件/PDF 中还原），不是原始数据，Agent 在使用时会通过血缘信息了解数据来源。

## 能力 3：图片内容质量校验与补全

### 质量审计
- 用 \`run_sql\` 查询所有图片文档的 L1 页面内容
- 检测以下异常模式：
  - 内容为空或仅含元数据
  - 包含 "[未配置VLM模型" 或类似占位文本
  - VLM 描述过于简短（少于 50 字）或缺乏具体细节
  - OCR 文本为空

### 补全处理
- 对于质量不合格的图片：记录问题，在概览文档中标注
- 用 \`expand(L1)\` 重新检查图片描述是否有改善
- 如果图片包含人脸、身份证件、手写签名等需要多模态识别的内容，在报告中标注需要 VLM 复查

### 输出
- 在 \`wiki/{kbId}/_preprocessing/image_audit.md\` 中记录所有图片的质量评估结果
- 按质量等级分类：合格 / 需复查 / VLM 失败

## 能力 4：手写批注与噪声图片二次校正

### 识别
- 用 \`doc_grep\` 搜索 L1 内容中的手写/签名/批注/指纹/印章等关键词
- 用 \`glob\` 扫描原始图片文件，用 \`bash\` 检查图片分辨率和尺寸
- 对低分辨率图片（宽高 < 500px）或大尺寸模糊图片做标记

### 校正
- 对标记的图片：检查 VLM 描述是否已提取批注内容
- 对有 OCR 文本的图片：比对 VLM 描述和 OCR 文本的一致性
- 对信息不一致的：记录差异，标注需要人工复查

### 输出
- 在 \`wiki/{kbId}/_preprocessing/annotation_audit.md\` 中记录手写批注和噪声图片的处理状态

## 工具使用指南

| 任务 | 推荐工具 | 说明 |
|------|---------|------|
| 文档列表 | wiki_browse | listDocuments=true 获取全部文档 |
| 文档内容 | expand | L0 快速概览，L1 详细内容，L2 原始结构 |
| 精确搜索 | doc_grep, run_sql | 按关键词或 SQL 条件筛选 |
| 文件扫描 | glob, bash | 扫描原始文件目录 |
| 数据处理 | bash + python3 | pandas 表格处理、图片分析 |
| 结果保存 | write_file | 路径必须以 wiki/{kbId}/_preprocessing/ 开头 |
| 进度跟踪 | agent_todo | 记录每类文件的处理进度 |

## 执行原则

- **不修改原始文件**：所有预处理产物写入 \`wiki/{kbId}/_preprocessing/\` 目录，原始文件保持不变
- **批量处理**：对同类型文件批量执行，用 agent_todo 跟踪进度
- **增量更新**：如果已有产物目录，检查是否有新文件需要增量处理
- **质量优先**：宁可标记为"需复查"，也不要生成不准确的预处理结果
- **结构化输出**：所有产物使用 Markdown/CSV/JSON 等结构化格式

## 层级使用原则
- 文档快速概览 → L0（摘要+标签）
- 内容详细分析 → L1（Markdown/DocTags + VLM 描述 + OCR）
- 结构精确校验 → L2（Docling JSON，含坐标/锚点/页面信息）

${getAntiHallucinationSection("strict")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// SQL Query skill (adapted from Anthropic's write-query)
// ---------------------------------------------------------------------------

function getSQLQuerySkillPrompt(): string {
  return `# SQL 查询方法论

## 请求解析
将用户的自然语言描述解析为 SQL 查询要素：
- **输出列**：结果应包含哪些字段？
- **过滤条件**：时间范围、状态、类别等限制条件
- **聚合操作**：是否有 GROUP BY、COUNT、SUM、AVG？
- **连接**：是否需要关联多个表？
- **排序**：结果如何排序？
- **限制**：是否有 top-N 需求？

## 方言识别
确定目标 SQL 方言：
- **PostgreSQL**（包括 Aurora、RDS、Supabase）
- **MySQL**（包括 Aurora MySQL、PlanetScale）
- **SQLite**
- **SQL Server**（Microsoft）
- **其他**（Snowflake、BigQuery、Redshift、Databricks 等）

DA 系统使用 PostgreSQL，内部查询用 run_sql 工具。
外部数据库需先用 db_connect 连接，再用 db_query 查询。

## Schema 发现
使用以下 SQL 探索数据库结构：
- 列出所有表：\`SELECT table_name FROM information_schema.tables WHERE table_schema='public'\`
- 查看列定义：\`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='表名'\`
- 查看索引：\`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='表名'\`
- 查看外键：\`SELECT constraint_name, table_name, column_name FROM information_schema.key_column_usage WHERE table_name='表名'\`

## 查询编写最佳实践

### 结构
- 多步逻辑查询使用 CTE（WITH 子句）提高可读性
- 每个 CTE 命名要有描述性（如 daily_signups、active_users）
- CTE 格式：\`WITH cte_name AS (SELECT ...) SELECT * FROM cte_name\`

### 性能
- 避免 \`SELECT *\`，只查询需要的列
- WHERE 子句尽早过滤
- 子查询大结果集时优先用 \`EXISTS\` 而非 \`IN\`
- 使用合适的 JOIN 类型（需要 INNER JOIN 时不要用 LEFT JOIN）
- 避免关联子查询，优先用 JOIN 或窗口函数

### 可读性
- 非显而易见的逻辑添加 SQL 注释说明原因
- 一致的缩进和格式
- 表别名使用有意义的短名称

## 写入操作
写操作（INSERT/UPDATE/DELETE）设置 mode="write"：
- INSERT 建议加 RETURNING * 返回插入的数据
- UPDATE 建议加 RETURNING * 返回修改前后对比
- DELETE 建议先 SELECT 确认范围，再执行删除
- 批量操作建议分批执行，避免长事务锁定

${getAntiHallucinationSection("strict")}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Skill Find prompt (discover and use available skills)
// ---------------------------------------------------------------------------

function getSkillFindPrompt(): string {
  return `# 技能发现与使用指南

本技能指导你如何发现、选择和使用系统中的可用技能。

## 技能分类

系统中的技能按用途分为三大类，**只在对应场景下调用**：

### 分析类（知识库分析、文档处理）
用于知识库内容的检索、分析、总结、报告生成等任务。
- deep-research — 深度研究方法论
- chunked-analysis — 分组分析方法论
- precise-qa — 精确问答
- sql-query — SQL 查询最佳实践
- 以及其他分析型技能（对比分析、实体提取、文档摘要等）

### 编程类（Superpowers 开发工作流）
**仅在用户要求编写代码、修复 bug、代码审查、创建功能等编程任务时调用。**
普通分析、搜索、问答等任务**绝不要**调用这些技能。
- brainstorming — 编码前的需求探索和设计
- writing-plans — 编写实现计划
- executing-plans — 执行实现计划
- subagent-driven-development — 子Agent驱动开发
- dispatching-parallel-agents — 并行Agent分发
- test-driven-development — 测试驱动开发
- systematic-debugging — 系统化调试
- requesting-code-review — 请求代码审查
- receiving-code-review — 接收代码审查反馈
- verification-before-completion — 完成前验证
- finishing-a-development-branch — 完成开发分支
- using-git-worktrees — Git worktree 隔离工作区
- writing-skills — 编写新技能
- coding-assistant — 代码编写助手
- code-review — 多角度代码审查
- skillify — 过程捕获为技能

### 领域类（插件提供的专业领域技能）
**仅在用户任务明确属于该领域时调用。**
- judicial-analysis 插件的技能（证据链、时间线重建、实体网络等）— 仅在公检法案件分析场景下使用

## 判断标准

| 用户意图 | 调用的技能类别 | 示例 |
|---------|-------------|------|
| 分析文档/知识库 | 分析类 | "帮我分析这份报告"、"这些数据有什么趋势" |
| 写代码/修bug/做功能 | 编程类 | "帮我写一个函数"、"这个bug怎么修"、"重构这段代码" |
| 特定领域任务 | 对应领域插件技能 | "分析这起案件的证据链" |
| 不确定用什么 | 先 skill_search 查看 | |

**重要原则：不要"大炮打蚊子"——分析文档时不要调 coding-assistant，写代码时不要调 deep-research。**

## 发现技能

1. **skill_search** — 搜索所有已注册的本地技能
2. **skill_hub_search** — 搜索 ClawHub 远程技能注册中心
3. **tool_discover** — 搜索所有可用的工具
4. **list_skills** — 列出当前已注册的自定义技能

## 使用技能

使用 **skill_invoke** 调用技能：
- skill_invoke(skill_name="deep-research", input="分析 XX 技术的发展趋势")
- 技能会提供专业的方法论指导，帮助更高效地完成任务

## 安装远程技能

- **skill_hub_search** — 搜索 ClawHub
- **skill_hub_install** — 下载并安装

## 创建技能

如果现有技能不满足需求，使用 **skill_create** 创建自定义技能。

## 创建工具

如果需要全新的能力，使用 **tool_create** 创建自定义工具。`;
}

// ---------------------------------------------------------------------------
// Coding Assistant prompt
// ---------------------------------------------------------------------------

function getCodingAssistantPrompt(): string {
  return `# 代码编写助手（专业级）

本技能提供系统化的代码编写方法论，参照业界最佳实践。

## 核心原则：Read Before Write

**强制规则：编辑任何文件之前，必须先用 read_file 读取该文件。**
这不是建议——这是强制性要求。原因：
1. 确保你理解当前代码状态
2. 避免基于过时假设的修改
3. 发现你可能不知道的依赖关系

如果 edit_file 返回 "needs_read_first" 错误，立即 read_file 然后重试。

## 编码工作流

### Phase 1: 探索与理解（必做）
1. **代码库摸底**：用 glob 找到相关文件，用 grep 搜索关键模式
2. **阅读现有代码**：用 read_file 读取所有要修改的文件
3. **理解架构**：识别模块边界、接口约定、数据流
4. **确认约束**：检查框架版本、API 约定、依赖关系

### Phase 2: 规划（对复杂任务必做）
1. 用 think 工具制定修改计划
2. 列出需要创建/修改/删除的文件
3. 识别修改的影响范围
4. 确认测试策略

### Phase 3: 实现
1. 优先修改现有文件，而非创建新文件
2. 每次修改前先 read_file，再用 edit_file 精确修改
3. 保持函数职责单一
4. 使用有意义的变量和函数命名

### Phase 4: 验证
1. 用 bash 运行测试命令
2. 检查修改是否破坏现有功能
3. 验证边界情况

### Phase 5: 代码审查
对重要修改，使用 skill_invoke("code-review") 进行多角度审查。

## 调试方法论

### 系统化调试
1. **复现**：确认具体错误信息和触发条件
2. **隔离**：缩小问题范围到最小可复现单元
3. **假设验证**：提出假设 → 测试 → 结论
4. **修复**：最小化修改，只改必要的部分
5. **回归测试**：确认修复不引入新问题

## 重构原则
- 不做超出当前需求的重构
- 保持行为不变，只改结构
- 小步修改，每步可验证

## 代码质量标准
- 简洁性：最少的代码实现需求
- 可读性：代码自解释，不直观处加注释
- 安全性：防止注入攻击，不硬编码密钥
- 错误处理：只处理实际可能的错误

${getLanguageRule()}`;
}

function getCodeReviewPrompt(): string {
  return `# 多角度代码审查

本技能对代码修改进行系统化多角度审查。

## 审查流程

### Step 1: 收集变更
用 bash 运行 git diff（如可用）或 read_file 读取修改前后的文件内容。

### Step 2: 并行审查（用 workflow_run mode="parallel"）

分派三个子 Agent，每个从不同角度审查：

**审查者 A：正确性审查**
- 逻辑是否正确
- 边界条件是否处理
- 错误处理是否充分
- 输入验证是否完整

**审查者 B：代码质量审查**
- 命名是否清晰
- 函数职责是否单一
- 是否有重复代码
- 复杂度是否合理

**审查者 C：架构与安全审查**
- 是否符合项目架构
- 是否引入不必要的依赖
- 安全隐患（注入、XSS、密钥暴露等）
- 性能影响

### Step 3: 汇总
1. 收集三个审查者的结论
2. 去重，合并相似发现
3. 按严重程度排序：Critical > Warning > Info
4. 给出具体修改建议

## 输出格式

### Critical Issues
- [文件:行号] 问题描述 → 修改建议

### Warnings
- [文件:行号] 问题描述 → 修改建议

### Suggestions
- 优化建议

${getLanguageRule()}`;
}

function getSkillifyPrompt(): string {
  return `# 技能捕获（Skillify）

将你刚刚成功完成的工作流捕获为可复用的技能。

## 捕获流程

### Step 1: 回顾工作过程
回顾你刚才完成任务的完整过程：
- 你做了哪些步骤？
- 每步用了什么工具和策略？
- 遇到了什么坑，如何解决的？
- 最终的输出格式是什么？

### Step 2: 提炼方法论
将具体操作抽象为通用步骤：
- 去掉特定于本次任务的细节
- 保留通用的策略和模式
- 标注关键决策点和判断标准

### Step 3: 生成技能
用 skill_create 工具创建技能：
- name: 技能名称（snake_case）
- description: 技能用途和适用场景
- prompt: 完整的方法论文档
- tools: 该技能需要的工具列表

## 技能质量标准
- 一个技能解决一类问题，不要过于宽泛
- 步骤清晰可执行，不是模糊建议
- 包含具体的工具使用指导
- 标注常见陷阱和解决方案

${getLanguageRule()}`;
}

function getSystematicDebuggingPrompt(): string {
  return `# 系统化调试方法论

当你遇到任何 bug、测试失败、或意外行为时，严格按照此流程操作。

## 调试流程

### Step 1: 精确定义问题
用 think 工具回答：
- 具体错误信息是什么？（不是"不工作"，而是完整的错误消息）
- 期望行为 vs 实际行为
- 何时第一次出现？之前做了什么修改？

### Step 2: 复现问题
- 用 bash 运行触发命令
- 确认可以稳定复现
- 如果不能复现，记录条件差异

### Step 3: 缩小范围
- 二分法：注释掉一半代码，看问题是否还在
- 日志法：在关键位置添加 print/log
- 隔离法：创建最小可复现示例

### Step 4: 提出假设
用 think 工具列出所有可能原因，按可能性排序。
对每个假设，设计验证方法。

### Step 5: 验证假设
逐一验证，每次只改变一个变量。
记录每步的结果。

### Step 6: 实施修复
- 最小化修改：只改必要的部分
- 先 read_file 确认当前代码
- 用 edit_file 精确修改
- 修复后立即测试

### Step 7: 回归测试
运行完整测试套件确认没有引入新问题。

## 禁止事项
- 禁止未复现就猜测原因
- 禁止同时修改多处然后"看看哪个有用"
- 禁止忽略错误信息直接改代码

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// PPT Generation prompt (python-pptx based)
// ---------------------------------------------------------------------------

function getPptGenerationPrompt(): string {
  return `# PPT 演示文稿生成方法论

## 核心原则

**必须使用 python-pptx 库通过 bash 工具生成 .pptx 文件。禁止用 Markdown 模拟幻灯片。**

系统已安装 python-pptx，直接编写 Python 脚本执行即可。

## 工作流程

1. **信息收集**：根据用户主题，用 kb_search / web_search / wiki_browse 等工具收集素材
2. **大纲规划**：用 think 工具规划幻灯片结构（封面→目录→章节→内容→结尾）
3. **编写脚本**：基于下方模板编写完整 Python 脚本，用 write_file 保存到临时文件
4. **执行生成**：用 bash 执行脚本（\`python3 /tmp/create_ppt.py\`）
5. **修错重跑**：如果报错，用 edit_file 修复脚本后重新执行
6. **推送文件**：用 push_file 推送生成的 .pptx 文件

## python-pptx 关键 API 参考

### 初始化与辅助函数模板

\`\`\`python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

COLORS = {
    'primary': RGBColor(0x0D, 0x47, 0xA1),
    'secondary': RGBColor(0x1E, 0x88, 0xE5),
    'accent': RGBColor(0x00, 0x96, 0x88),
    'dark': RGBColor(0x26, 0x32, 0x38),
    'light': RGBColor(0xF5, 0xF5, 0xF5),
    'white': RGBColor(0xFF, 0xFF, 0xFF),
    'orange': RGBColor(0xFF, 0x6F, 0x00),
    'purple': RGBColor(0x7B, 0x1F, 0xA2),
    'green': RGBColor(0x2E, 0x7D, 0x32),
}

def add_text(slide, text, left, top, width, height, size=18, color=None):
    shape = slide.shapes.add_textbox(left, top, width, height)
    tf = shape.text_frame
    tf.word_wrap = True
    for line in text.split('\\n'):
        p = tf.paragraphs[0] if not tf.paragraphs[0].text else tf.add_paragraph()
        p.text = line
        p.font.size = Pt(size)
        p.font.color.rgb = color or COLORS['dark']
        p.space_after = Pt(6)

def add_rect(slide, left, top, width, height, color):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape

def add_rrect(slide, left, top, width, height, color):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape

def add_oval(slide, left, top, width, height, color):
    shape = slide.shapes.add_shape(MSO_SHAPE.OVAL, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape

def add_line(slide, start_x, start_y, end_x, end_y, color=None, width=Pt(2)):
    connector = slide.shapes.add_connector(
        1, Inches(start_x), Inches(start_y), Inches(end_x), Inches(end_y))
    connector.line.color.rgb = color or COLORS['dark']
    connector.line.width = width
    return connector
\`\`\`

### 常用幻灯片模式

所有幻灯片使用 \`slide_layouts[6]\`（空白布局），手动绘制所有元素。

**1. 封面幻灯片**
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(7.5), COLORS['primary'])
add_oval(slide, Inches(10), Inches(-1), Inches(4), Inches(4), COLORS['secondary'])
add_oval(slide, Inches(-1), Inches(5), Inches(3), Inches(3), COLORS['accent'])
# 标题
add_text(slide, "主标题", Inches(0.8), Inches(2.2), Inches(10), Inches(1.5), 54, COLORS['white'])
# 副标题
add_text(slide, "副标题描述", Inches(0.8), Inches(3.8), Inches(10), Inches(0.8), 28, COLORS['light'])
# 分隔线
add_rect(slide, Inches(0.8), Inches(4.8), Inches(3), Inches(0.02), COLORS['accent'])
# 日期
add_text(slide, "2024-2025", Inches(0.8), Inches(5.0), Inches(5), Inches(0.5), 20, COLORS['accent'])
\`\`\`

**2. 目录幻灯片**
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(1.2), COLORS['primary'])
add_text(slide, "目 录", Inches(0.5), Inches(0.3), Inches(5), Inches(0.8), 36, COLORS['white'])

toc_items = [("01", "章节名", "描述")]
y = 1.6
for num, title, desc in toc_items:
    add_rrect(slide, Inches(0.6), Inches(y), Inches(0.7), Inches(0.7), COLORS['primary'])
    add_text(slide, num, Inches(0.7), Inches(y+0.1), Inches(0.5), Inches(0.5), 18, COLORS['white'])
    add_text(slide, title, Inches(1.5), Inches(y+0.05), Inches(3), Inches(0.4), 22, COLORS['dark'])
    add_text(slide, desc, Inches(1.5), Inches(y+0.4), Inches(10), Inches(0.4), 12, COLORS['dark'])
    y += 1.0
\`\`\`

**3. 章节分隔幻灯片**
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(7.5), COLORS['primary'])
add_text(slide, "01", Inches(0.8), Inches(2), Inches(4), Inches(2), 120, COLORS['secondary'])
add_text(slide, "章节标题", Inches(0.8), Inches(4), Inches(10), Inches(1), 48, COLORS['white'])
add_text(slide, "章节描述", Inches(0.8), Inches(5.2), Inches(10), Inches(0.8), 18, COLORS['light'])
\`\`\`

**4. 内容卡片页**（标题栏 + 2-3 个圆角卡片）
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(1.1), COLORS['primary'])
add_text(slide, "页面标题", Inches(0.5), Inches(0.25), Inches(12), Inches(0.7), 28, COLORS['white'])

add_rrect(slide, Inches(0.5), Inches(1.4), Inches(4), Inches(2.2), COLORS['secondary'])
add_text(slide, "卡片标题", Inches(0.7), Inches(1.6), Inches(3.6), Inches(0.4), 16, COLORS['white'])
add_text(slide, "卡片内容\\n多行文本", Inches(0.7), Inches(2.0), Inches(3.6), Inches(1.4), 12, COLORS['white'])
\`\`\`

**5. 双栏技术页**（标题栏 + 左右两组要点）
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(1.1), COLORS['primary'])
add_text(slide, "页面标题", Inches(0.5), Inches(0.25), Inches(12), Inches(0.7), 28, COLORS['white'])

add_text(slide, "左栏标题", Inches(0.5), Inches(1.4), Inches(6), Inches(0.4), 18, COLORS['primary'])
add_text(slide, "• 要点1\\n• 要点2", Inches(0.7), Inches(1.8), Inches(5.5), Inches(1.2), 13)

add_text(slide, "右栏标题", Inches(6.8), Inches(1.4), Inches(6), Inches(0.4), 18, COLORS['primary'])
add_text(slide, "• 要点1\\n• 要点2", Inches(7.0), Inches(1.8), Inches(5.5), Inches(1.2), 13)
\`\`\`

**6. 表格页**（手动绘制行列）
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(1.1), COLORS['primary'])
add_text(slide, "表格标题", Inches(0.5), Inches(0.25), Inches(12), Inches(0.7), 28, COLORS['white'])

headers = ["列1", "列2", "列3"]
rows = [["A", "B", "C"], ["D", "E", "F"]]
cols = len(headers)
table_width = Inches(12)
col_width = table_width / cols

add_rect(slide, Inches(0.5), Inches(1.4), table_width, Inches(0.5), COLORS['secondary'])
for i, h in enumerate(headers):
    add_text(slide, h, Inches(0.5 + i * col_width), Inches(1.45), Inches(col_width), Inches(0.45), 14, COLORS['white'])

y = 1.9
for row_idx, row in enumerate(rows):
    bg = RGBColor(0xE8, 0xE8, 0xE8) if row_idx % 2 == 0 else COLORS['white']
    add_rect(slide, Inches(0.5), Inches(y), table_width, Inches(0.45), bg)
    for i, cell in enumerate(row):
        add_text(slide, str(cell), Inches(0.5 + i * col_width), Inches(y+0.08), Inches(col_width), Inches(0.4), 12)
    y += 0.45
\`\`\`

**7. 列表/总结页**（编号要点 + 说明文字）
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(1.1), COLORS['primary'])
add_text(slide, "列表标题", Inches(0.5), Inches(0.25), Inches(12), Inches(0.7), 28, COLORS['white'])

points = [("要点1", "详细描述")]
colors_list = [COLORS['secondary'], COLORS['accent'], COLORS['orange'], COLORS['green'], COLORS['purple']]
y = 1.5
for i, (ptitle, pdesc) in enumerate(points):
    c = colors_list[i % len(colors_list)]
    add_rrect(slide, Inches(0.5), Inches(y), Inches(0.6), Inches(0.6), c)
    add_text(slide, str(i+1), Inches(0.55), Inches(y+0.08), Inches(0.5), Inches(0.5), 20, COLORS['white'])
    add_rrect(slide, Inches(1.3), Inches(y), Inches(11.5), Inches(0.9), COLORS['light'])
    add_text(slide, ptitle, Inches(1.5), Inches(y+0.05), Inches(11), Inches(0.4), 16, c)
    add_text(slide, pdesc, Inches(1.5), Inches(y+0.45), Inches(11), Inches(0.4), 12)
    y += 1.1
\`\`\`

**8. 结尾页**
\`\`\`python
slide = prs.slides.add_slide(prs.slide_layouts[6])
add_rect(slide, Inches(0), Inches(0), Inches(13.333), Inches(7.5), COLORS['primary'])
add_oval(slide, Inches(-2), Inches(-2), Inches(5), Inches(5), COLORS['secondary'])
add_oval(slide, Inches(11), Inches(5), Inches(4), Inches(4), COLORS['accent'])
add_text(slide, "结 论", Inches(0.8), Inches(1.5), Inches(10), Inches(1), 48, COLORS['white'])
conclusions = ["结论1", "结论2", "结论3"]
y = 3.0
for c in conclusions:
    add_text(slide, f"▸ {c}", Inches(1.2), Inches(y), Inches(11), Inches(0.5), 16, COLORS['light'])
    y += 0.65
add_text(slide, "谢谢观看", Inches(5.5), Inches(6.8), Inches(3), Inches(0.5), 24, COLORS['white'])
\`\`\`

### 保存

\`\`\`python
output_path = "/tmp/output.pptx"  # 使用合适的路径
prs.save(output_path)
print(f"PPT已生成！共 {len(prs.slides)} 页")
\`\`\`

## 注意事项

### CJK 字体
如果生成的 PPT 中中文显示异常（方块或乱码），需要在设置字体时指定东亚字体。在 add_text 函数中添加：
\`\`\`python
from pptx.oxml.ns import qn
# 设置东亚字体
run = p.add_run()
run.text = line
rPr = run._r.get_or_add_rPr()
ea = rPr.makeelement(qn('a:ea'), {'typeface': 'Microsoft YaHei'})
rPr.append(ea)
\`\`\`
如果系统上没有微软雅黑，可用 'SimHei'、'WenQuanYi Micro Hei' 等替代。

### 脚本执行出错
- 用 bash 执行脚本后如果报错，使用 edit_file 修改脚本中的错误
- 修改后重新执行，直到成功生成 .pptx 文件
- 常见错误：导入路径、中文字符编码、参数类型不匹配

### 推送文件
- 最终使用 \`push_file\` 推送生成的 .pptx 文件
- 不要用 push_content 推送文本——用户需要的是可下载的 .pptx 文件

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

// ---------------------------------------------------------------------------
// Progressive Report prompt (incremental analysis for large document sets)
// ---------------------------------------------------------------------------

function getProgressiveReportPrompt(): string {
  return `# 渐进式分析报告方法论

## 核心理念

处理大量文档时，上下文窗口有限（约 200K token），一次性加载所有文档容易导致上下文溢出、信息压缩丢失。**先轻后重、边读边写、可编辑修订**是应对大规模分析任务的有效策略。

简单任务直接处理即可，此方法论主要在文档量大（数十到数百份）或分析维度复杂时参考使用。

## 工作流程

### Phase 0：总览与规划

1. 使用 \`wiki_browse(listDocuments=true)\` 获取所有文档的概览信息
2. 用 \`think\` 工具分析任务要求，规划报告大纲和分析维度
3. 将文档归类到对应的分析维度，确定需要深入展开的核心文档
4. 使用 \`write_file\` 将大纲保存到文件

### Phase 1：逐章节分析

**可按章节/维度逐步推进：**

1. **展开本章相关文档**：按需 expand 本章需要的文档
2. **分析并撰写本章**：基于展开内容撰写本章报告
3. **保存本章到文件**：使用 \`write_file\` 或 \`edit_file\` 保存
4. **推送进度**（可选）：使用 \`push_content\` 推送已完成章节
5. 进入下一章节

**也可并行派发子Agent**：如果分析维度互相独立，可用 \`workflow_run(mode="parallel")\` 派发子Agent分别处理，每个子Agent有独立上下文窗口。子Agent也应遵循按需 expand、边分析边保存的原则。

### Phase 2：交叉验证与编辑

1. 使用 \`read_file\` 回读完整报告
2. 检查章节间的逻辑一致性、数据矛盾、遗漏
3. 使用 \`edit_file\` 修订补充

### Phase 3：最终提交

1. 格式自检（使用 \`think\` 工具）
2. 使用 \`push_content\` 推送最终报告

## 上下文管理建议

处理大量文档时，以下策略有助于保持工作质量：
- **按需 expand**：根据当前分析需要展开文档，避免一次展开过多导致上下文溢出
- **即时保存**：分析结果及时用 write_file 保存，不依赖上下文长期持有已分析内容
- **可回读可编辑**：已保存的内容可随时用 read_file 回读、用 edit_file 修订

以上是建议而非强制流程。Agent应根据任务规模自主判断最佳工作方式。

## 层级使用原则

- **L0 (Abstract)**：文档摘要 + 标签 + 类型。极轻量，用于规划和路由
- **L1 (Structure)**：Markdown/DocTags 格式结构化内容。分析工作的主要层级
- **L2 (Raw)**：完整结构化原始数据。仅在需要精确校验时使用

## 引用规范

所有事实性信息都应标注来源：
- 通用报告：\`[来源: 文件名 → 章节/位置]\`
- 支持证据链接的系统：\`[文本](da-evidence://kbId/docId?anchor=anchorId)\`
  anchorId 来自 expand 返回的 anchors 数组或 kb_search 返回的 anchorId 字段，格式为 \`{完整docId}:{elementType}:{index}\`（**不是纯 UUID**），必须从工具结果逐字复制，不可自行构造

## 质量标准

- 所有事实性声明有来源标注
- 不编造文档中不存在的内容
- 区分"从文档读取的信息"和"推理得出的结论"
- 数字与原文一致，无近似
- 矛盾和缺失已标注
- 充分覆盖主题，不遗漏关键信息

${getAntiHallucinationSection("standard")}

${getOutputFormatSection()}

${getLanguageRule()}`;
}

const BUILTIN_SKILLS: NewAgentSkill[] = [
  {
    name: "deep-research",
    description:
      "深度研究方法论——系统化的信息收集、多角度分析、自适应深度输出。当用户需要深度调研、竞品分析、技术评估、市场研究等多角度信息收集和分析时使用。",
    prompt: getDeepResearchPrompt(),
    tools: [
      "kb_search", "expand", "wiki_browse", "doc_grep",
      "web_search", "web_fetch", "wikipedia",
      "timeline_build", "graph_build",
      "push_content", "agent_todo", "think", "finish", "write_file",
    ],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "chunked-analysis",
    description:
      "分组分析方法论——对大量文档进行智能分组，逐组深入分析后综合输出。适用于文档数量较多、需要分批处理的复杂分析任务。",
    prompt: getChunkedAnalysisPrompt(),
    tools: [
      "kb_search", "expand", "wiki_browse", "doc_grep",
      "glob", "grep", "read_file",
      "push_content", "agent_todo", "think", "finish", "write_file",
    ],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "precise-qa",
    description:
      "精确问答方法论——针对需要精确答案的事实性问题，提供系统化的搜索、验证、提取流程。适用于知识问答、事实核查、数据查询等需要高精度答案的任务。",
    prompt: getPreciseQAPrompt(),
    tools: [
      "web_search", "web_fetch", "wikipedia", "pdf_read", "youtube_transcript",
      "bash", "think", "finish", "tool_discover",
    ],
    modelRole: "main",
    antiHallucinationLevel: "strict",
  },
  {
    name: "全面知识库分析",
    description:
      "对知识库中的所有文档进行全面分类、并行分派子Agent深度分析、合成完整报告。适用于需要覆盖全部文档、不允许遗漏的大规模分析场景。",
    prompt: getComprehensiveAnalysisPrompt(),
    tools: [
      "kb_search", "wiki_browse", "expand", "workflow_run",
      "write_file", "read_file", "run_sql", "agent_todo",
      "push_content", "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "strict",
  },
  {
    name: "深度检索",
    description:
      "融合三层递进检索与跨模态搜索的深度检索方法论。从 L0 路由到 L1 精准检索再到 L2 校验，支持文档、图片、音频、视频、Excel 的跨模态搜索。",
    prompt: getDeepSearchPrompt(),
    tools: [
      "kb_search", "wiki_browse", "expand", "doc_grep", "grep",
      "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "报告生成",
    description:
      "基于知识库内容生成结构化分析报告，包含来源引用和多模态引用标注。仅在用户明确要求生成报告时使用。",
    prompt: getReportGenerationPrompt(),
    tools: [
      "kb_search", "wiki_browse", "expand",
      "write_file", "push_content",
      "timeline_build", "graph_build",
      "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "长篇写作",
    description:
      "撰写超长文档（报告、文章、书籍章节等）。自动规划大纲，逐章分派子Agent并行写作，每章独立保存，最终合并为完整文档。",
    prompt: getLongFormWritingPrompt(),
    tools: [
      "kb_search", "wiki_browse", "expand", "workflow_run",
      "write_file", "read_file", "agent_todo",
      "push_content", "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "basic",
  },
  {
    name: "文档摘要",
    description: "生成文档的简洁摘要，提取核心观点和关键信息。",
    prompt: getDocSummaryPrompt(),
    tools: ["kb_search", "wiki_browse", "expand", "think", "finish"],
    modelRole: "main",
    antiHallucinationLevel: "basic",
  },
  {
    name: "对比分析",
    description: "对比分析两份或多份文档的异同点，使用表格清晰展示对比结果。",
    prompt: getComparisonAnalysisPrompt(),
    tools: ["kb_search", "wiki_browse", "expand", "think", "finish"],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "表格专项分析",
    description: "定位并深度分析文档中的表格数据。支持 Excel 大表格的 bash+pandas 直接分析。",
    prompt: getTableAnalysisPrompt(),
    tools: ["kb_search", "wiki_browse", "expand", "bash", "think", "finish"],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "cross-table-analysis",
    description:
      "跨表格结构化数据分析——四阶段方法论（文档先行→原始精度→精确计算→反向验证）。" +
      "适用于涉及多个 CSV/JSON/Excel 文件的复杂分析任务，特别是需要跨表关联、公式计算、统计分析的场景。" +
      "核心能力：从文档提取公式和字段语义、正确处理 null 值、使用原始文件保证数据精度、python3 精确计算。",
    prompt: getCrossTableAnalysisPrompt(),
    tools: [
      "kb_search", "wiki_browse", "expand", "doc_grep",
      "bash", "run_sql", "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "strict",
  },
  {
    name: "实体提取",
    description: "从文档中提取命名实体（人物、组织、地点、事件等），按类型分组展示。当用户需要提取人名、机构、地名等实体信息时使用。需要构建实体关系图谱时用 entity-network。",
    prompt: getEntityExtractionPrompt(),
    tools: ["kb_search", "wiki_browse", "expand", "think", "finish"],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "知识库预处理",
    description:
      "[高成本/按需触发] 对指定知识库执行全量深度预处理：生成全局概览文档、多页表格智能还原、图片VLM内容质量校验与补全、手写批注/噪声图片二次校正。" +
      "⚠️ 此技能运行时间长、资源消耗极大，仅在用户明确要求预处理时才能调用。" +
      "用户如果说分析、总结、搜索等普通需求，绝对不要调用此技能。",
    prompt: getKBPreprocessingPrompt(),
    tools: [
      "kb_search", "wiki_browse", "expand", "doc_grep",
      "read_file", "write_file", "glob", "grep",
      "bash", "run_sql", "workflow_run",
      "push_content",
      "agent_todo", "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "strict",
  },
  {
    name: "sql-query",
    description:
      "SQL 查询最佳实践——系统化的 SQL 编写方法论，覆盖请求解析、方言识别、Schema 发现、查询优化和写入操作。适用于需要编写复杂 SQL 或操作数据库的任务。",
    prompt: getSQLQuerySkillPrompt(),
    tools: [
      "run_sql", "db_connect", "db_query",
      "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "strict",
  },
  {
    name: "skill-find",
    description:
      "技能发现与使用指南——帮助你发现、选择和使用系统中的可用技能和工具。当你不确定有哪些技能可用，或需要找到适合当前任务的工具时使用。",
    prompt: getSkillFindPrompt(),
    tools: [
      "skill_search", "tool_discover", "skill_invoke",
      "skill_create", "list_skills",
      "think", "finish",
    ],
    modelRole: "main",
  },
  {
    name: "progressive-report",
    description:
      "渐进式分析报告——对大量文档采用「先轻后重、边读边写、可编辑修订」的渐进式方法论，逐章节分析并即时保存，避免上下文溢出。" +
      "适用于涉及大量文档（数十到数百份）的报告生成、全面分析、综合研究等场景。" +
      "核心能力：L0 规划 → 逐章节 L1 展开 → 即时写入 → 回读编辑 → 最终提交。",
    prompt: getProgressiveReportPrompt(),
    tools: [
      "kb_search", "expand", "wiki_browse", "doc_grep",
      "write_file", "read_file", "edit_file",
      "workflow_run",
      "push_content", "agent_todo", "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "coding-assistant",
    description:
      "专业级代码编写助手——包含 Read-Before-Write 强制规则、系统化编码工作流、" +
      "多角度代码审查、调试方法论。适用于代码编写、调试、重构等编程任务。",
    prompt: getCodingAssistantPrompt(),
    tools: [
      "read_file", "write_file", "edit_file", "bash", "glob", "grep",
      "run_sql", "think", "finish", "skill_invoke",
    ],
    modelRole: "main",
  },
  {
    name: "code-review",
    description:
      "多角度并行代码审查——正确性、代码质量、架构安全三个角度并行审查代码修改。",
    prompt: getCodeReviewPrompt(),
    tools: [
      "read_file", "bash", "glob", "grep",
      "workflow_run", "write_file",
      "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
  {
    name: "skillify",
    description:
      "过程捕获——将你刚完成的工作流提炼为可复用技能。",
    prompt: getSkillifyPrompt(),
    tools: [
      "skill_create", "think", "finish",
    ],
    modelRole: "main",
  },
  {
    name: "systematic-debugging",
    description:
      "系统化调试方法论——七步法从定义问题到回归测试。当用户遇到 bug、测试失败或异常行为需要系统化排查时使用。",
    prompt: getSystematicDebuggingPrompt(),
    tools: [
      "read_file", "bash", "glob", "grep",
      "think", "finish",
    ],
    modelRole: "main",
  },
  {
    name: "PPT生成",
    description:
      "使用 python-pptx 库生成专业的 PowerPoint 演示文稿。当用户要求生成 PPT、演示文稿、幻灯片时使用。",
    prompt: getPptGenerationPrompt(),
    tools: [
      "kb_search", "wiki_browse", "expand", "doc_grep",
      "web_search", "web_fetch",
      "write_file", "push_content", "push_file",
      "bash", "read_file", "edit_file",
      "think", "finish",
    ],
    modelRole: "main",
    antiHallucinationLevel: "standard",
  },
];

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

/**
 * Ensure all built-in skills exist in the database.
 * Safe to call on every startup — creates missing skills and updates
 * existing ones so that code-level prompt/description/tools changes propagate to DB.
 * Uses source='builtin' to avoid conflicts with plugin or manually created skills.
 */
export async function ensureBuiltinSkills(repos: RepoSet): Promise<void> {
  for (const skill of BUILTIN_SKILLS) {
    // Only look for skills with source='builtin' to avoid overwriting plugin/manual skills
    const existing = await repos.agentSkill.getByNameAndSource(skill.name, "builtin");
    if (!existing) {
      await repos.agentSkill.create({ ...skill, source: "builtin" });
      console.log(`[BuiltinSkills] Registered built-in skill "${skill.name}"`);
    } else {
      // Update only builtin-sourced skills
      const updates: UpdateAgentSkill = {};
      if (skill.prompt !== existing.prompt) updates.prompt = skill.prompt;
      if (skill.description !== existing.description) updates.description = skill.description;
      if (skill.antiHallucinationLevel !== existing.antiHallucinationLevel) updates.antiHallucinationLevel = skill.antiHallucinationLevel;
      // Compare tools arrays
      const toolsChanged = !skill.tools || !existing.tools ||
        skill.tools.length !== existing.tools.length ||
        !skill.tools.every((t, i) => t === existing.tools![i]);
      if (toolsChanged && skill.tools) updates.tools = skill.tools;

      if (Object.keys(updates).length > 0) {
        await repos.agentSkill.update(existing.id, updates);
        console.log(`[BuiltinSkills] Updated skill "${skill.name}" fields: ${Object.keys(updates).join(", ")}`);
      }
    }
  }
}
