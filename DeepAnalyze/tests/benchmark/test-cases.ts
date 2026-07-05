// =============================================================================
// DeepAnalyze Benchmark Test Cases
// =============================================================================
// 12 test cases adapted from 4 benchmarks (3 each):
// - WebArena 2.0: Information retrieval, multi-step reasoning
// - AgentWrite-Bench: Long-form content generation, structured output
// - HalluAgent-Bench: Hallucination detection, fact verification
// - GAIA-3: General reasoning with tools, multi-modal analysis
// =============================================================================

import type { BenchmarkTestCase } from "./da-helper";

// ---------------------------------------------------------------------------
// WebArena 2.0 (2025) — Web-based agent tasks
// Tests: information retrieval, navigation, multi-step reasoning
// Adapted for DA: use web_search + general reasoning capabilities
// ---------------------------------------------------------------------------

export const WEBARENA_TESTS: BenchmarkTestCase[] = [
  {
    id: "WA-001",
    benchmark: "WebArena 2.0",
    category: "信息检索与综合",
    question: `请搜索以下信息并给出完整准确的回答：

1. 2024年诺贝尔物理学奖的获得者是谁？获奖原因是什么？
2. 2024年诺贝尔化学奖的获得者是谁？获奖原因是什么？
3. 2024年图灵奖的获得者是谁？获奖原因是什么？

请对每个奖项分别列出：获奖者姓名、国籍、所属机构、具体获奖贡献。确保所有信息准确无误。`,
    evaluationCriteria: [
      "正确列出2024年诺贝尔物理学奖获得者（John Hopfield和Geoffrey Hinton，因人工神经网络和机器学习的基础发现）",
      "正确列出2024年诺贝尔化学奖获得者（David Baker、Demis Hassabis和John Jumper，因蛋白质结构预测）",
      "对无法确认的信息（如2024年图灵奖如果尚未公布）明确标注'信息未确认'",
      "不编造任何不存在的获奖者或奖项",
      "回答结构清晰，区分不同奖项",
    ],
    passThreshold: 80,
    maxWaitMs: 180_000,
  },
  {
    id: "WA-002",
    benchmark: "WebArena 2.0",
    category: "多步推理",
    question: `请完成以下多步信息检索和推理任务：

1. 搜索"世界最高建筑"的当前排名前5名
2. 对每一栋建筑，列出：名称、所在城市、所在国家、高度（米）、建成年份
3. 计算第1名和第5名的高度差
4. 找出这些国家中GDP最高的是哪个

请确保所有数据都是最新的，并标注数据来源。`,
    evaluationCriteria: [
      "列出至少5栋世界最高建筑的基本信息",
      "每栋建筑包含名称、城市、国家、高度、建成年份",
      "高度数据合理（前5名应在600-830米范围）",
      "进行了高度差计算",
      "对不确定的数据标注来源或说明可能不精确",
      "不编造不存在的数据",
    ],
    passThreshold: 75,
    maxWaitMs: 180_000,
  },
  {
    id: "WA-003",
    benchmark: "WebArena 2.0",
    category: "数据对比分析",
    question: `请搜索并对比分析以下编程语言的最新情况：

对比 Python、JavaScript、TypeScript、Rust、Go 这5种编程语言在以下维度的情况：
1. 2024-2025年的TIOBE编程语言排名变化趋势
2. 各语言的主要应用领域
3. 各语言2024年的主要版本更新和新特性
4. 各语言的社区活跃度（GitHub star数、Stack Overflow问题数等大致数据）

请用表格形式展示对比结果，并给出分析结论。`,
    evaluationCriteria: [
      "覆盖所有5种编程语言",
      "包含TIOBE排名相关信息",
      "各语言应用领域描述准确",
      "使用表格进行结构化对比",
      "有综合分析结论",
      "数据来源合理标注",
    ],
    passThreshold: 75,
    maxWaitMs: 180_000,
  },
];

// ---------------------------------------------------------------------------
// AgentWrite-Bench (2026) — Agent writing capabilities
// Tests: long-form writing, structured output, completeness
// ---------------------------------------------------------------------------

export const AGENTWRITE_TESTS: BenchmarkTestCase[] = [
  {
    id: "AW-001",
    benchmark: "AgentWrite-Bench",
    category: "技术文档写作",
    question: `请撰写一份关于"大语言模型（LLM）在企业级应用中的技术架构"的技术白皮书，要求包含以下章节：

1. 摘要（200-300字）
2. 引言：LLM技术概述和发展趋势
3. 架构设计：企业级LLM应用的核心架构组件
   - 模型部署层（私有化部署 vs API调用）
   - 向量数据库与RAG架构
   - Agent编排层
   - 安全与合规层
4. 关键技术挑战与解决方案
   - 幻觉问题及其缓解策略
   - 长上下文处理
   - 多模态集成
   - 成本优化
5. 最佳实践与案例分析
6. 未来展望
7. 总结

要求：
- 总字数不少于3000字
- 技术描述准确、专业
- 每个章节有实质内容，不是泛泛而谈
- 引用具体的工具、框架名称（如LangChain、LlamaIndex、Milvus等）
- 结构清晰，逻辑连贯`,
    evaluationCriteria: [
      "包含所有要求的7个章节",
      "总字数不少于3000字",
      "技术内容准确，引用了具体的工具和框架名称",
      "每个章节有实质性的技术内容",
      "结构清晰，使用正确的Markdown格式",
      "对RAG、Agent编排等概念描述准确",
      "无明显的幻觉或错误技术信息",
    ],
    passThreshold: 80,
    maxWaitMs: 600_000,
  },
  {
    id: "AW-002",
    benchmark: "AgentWrite-Bench",
    category: "结构化报告",
    question: `请撰写一份"2024年全球人工智能产业发展报告"的执行摘要，要求包含：

1. 市场规模与增长
   - 全球AI市场规模（2023-2024年数据）
   - 主要增长驱动力
   - 区域分布情况

2. 关键技术突破
   - 大语言模型进展
   - 多模态AI进展
   - AI Agent技术进展

3. 产业应用
   - 各行业AI采用率
   - 标志性应用案例

4. 投资与融资
   - 主要投资领域
   - 头部公司融资情况

5. 监管与政策
   - 主要国家AI监管政策
   - 对产业的影响

6. 趋势展望
   - 2025年预测
   - 长期发展方向

要求：
- 使用具体数据支撑（市场规模、增长率等）
- 如果无法获取确切数据，使用合理估计并标注"估计值"
- 总字数不少于2000字
- 语言专业、客观`,
    evaluationCriteria: [
      "覆盖所有6个章节",
      "使用了具体的市场数据（即使是大致数据也需标注）",
      "总字数不少于2000字",
      "技术进展描述准确（如GPT-4o、Claude、Gemini等模型信息）",
      "对不确定数据有标注说明",
      "语言专业客观，结构清晰",
    ],
    passThreshold: 75,
    maxWaitMs: 600_000,
  },
  {
    id: "AW-003",
    benchmark: "AgentWrite-Bench",
    category: "长篇技术教程",
    question: `请撰写一份完整的"RAG（检索增强生成）系统从零到生产部署"的实战教程，要求：

1. RAG原理概述
   - 什么是RAG，为什么需要RAG
   - RAG与传统微调的对比
   - RAG系统架构图（用文字描述架构流程）

2. 环境准备
   - 需要的工具和库（Python版本、LangChain、向量数据库等）
   - 环境搭建步骤

3. 数据预处理
   - 文档加载和分块策略
   - Embedding模型选择
   - 向量化流程

4. 向量存储与检索
   - 向量数据库选型（Milvus vs Pinecone vs Chroma）
   - 索引构建
   - 相似度检索与混合检索

5. LLM集成
   - Prompt模板设计
   - 上下文管理
   - 回答生成与引用

6. 评估与优化
   - RAG系统评估指标
   - 常见问题与优化策略

7. 生产部署
   - 部署架构
   - 监控与运维

要求：
- 总字数不少于4000字
- 包含关键代码片段示例（Python）
- 技术内容准确且实用
- 循序渐进，逻辑清晰`,
    evaluationCriteria: [
      "覆盖所有7个章节",
      "总字数不少于4000字",
      "包含Python代码示例",
      "RAG技术描述准确（分块策略、Embedding、向量检索等）",
      "向量数据库对比客观",
      "评估指标和方法描述合理",
      "整体可作为实际教程使用",
    ],
    passThreshold: 80,
    maxWaitMs: 600_000,
  },
];

// ---------------------------------------------------------------------------
// HalluAgent-Bench (2025) — Hallucination detection and fact verification
// Tests: factual accuracy, uncertainty acknowledgment, source attribution
// ---------------------------------------------------------------------------

export const HALLUAGENT_TESTS: BenchmarkTestCase[] = [
  {
    id: "HA-001",
    benchmark: "HalluAgent-Bench",
    category: "事实核查",
    question: `请对以下陈述逐一进行事实核查，判断每一条是否正确，并给出证据和解释：

陈述1：GPT-4发布于2023年3月。
陈述2：Python的创建者Guido van Rossum已经于2019年退休，不再参与Python开发。
陈述3：AlphaGo在2016年击败了世界围棋冠军李世石。
陈述4：以太坊的创始人Vitalik Buterin在创建以太坊时只有19岁。
陈述5：Linux内核的第一个版本发布于1991年。
陈述6：Google的PageRank算法是以Larry Page的名字命名的。
陈述7：第一个商用智能手机是苹果公司在2007年发布的iPhone。
陈述8：比特币的白皮书由Satoshi Nakamoto在2008年发布。
陈述9：中国的万里长城是在秦始皇时期一次性建成的。
陈述10：TCP/IP协议是由Vint Cerf和Bob Kahn共同设计的。

对每条陈述，请明确标注：✓正确 / ✗错误 / ⚠部分正确 / ❓无法确认，并给出详细解释。`,
    evaluationCriteria: [
      "正确判断陈述1（GPT-4发布于2023年3月）— ✓正确",
      "正确判断陈述2（Guido退休）— ✗错误，他后来加入了Microsoft",
      "正确判断陈述3（AlphaGo击败李世石）— ✓正确",
      "正确判断陈述4（Vitalik 19岁）— ✓正确，他1994年出生，2013年提出以太坊",
      "正确判断陈述5（Linux 1991年）— ✓正确",
      "正确判断陈述6（PageRank以Larry Page命名）— ✓正确",
      "正确判断陈述7（第一个商用智能手机是iPhone）— ✗错误，之前有IBM Simon、黑莓等",
      "正确判断陈述8（比特币白皮书2008年）— ✓正确",
      "正确判断陈述9（长城一次性建成）— ✗错误，是多个朝代逐步修建",
      "正确判断陈述10（TCP/IP由Cerf和Kahn设计）— ✓正确",
      "至少8条判断正确",
      "对错误的陈述给出了正确的事实纠正",
    ],
    passThreshold: 80,
    maxWaitMs: 180_000,
  },
  {
    id: "HA-002",
    benchmark: "HalluAgent-Bench",
    category: "知识边界识别",
    question: `请回答以下10个问题。对于每个问题，如果你确信知道答案，请直接回答；如果你不确定或不知道，请明确说"我不确定"或"我无法确认"，不要编造答案。

问题1：DeepMind的AlphaFold 3是哪一年发布的？
问题2：2024年全球人口最多的城市是哪个？
问题3：量子计算中，"量子纠错"的核心挑战是什么？
问题4：Apple Vision Pro的初始售价是多少？
问题5："鲁棒性"(Robustness)这个术语最初来源于哪个领域？
问题6：HTTP/3协议使用的是什么传输层协议？
问题7：2024年全球最大的半导体制造企业是哪家？
问题8：Transformer架构的原始论文"Attention Is All You Need"被引用了多少次？
问题9：BERT模型有多少个参数（BERT-base版本）？
问题10：中国的"天河二号"超级计算机的峰值计算速度是多少？

关键要求：
- 确定知道的答案要准确回答
- 不确定的要明确标注
- 绝对不能编造答案
- 对于数值类问题，给出具体数字而不是模糊描述`,
    evaluationCriteria: [
      "对确定的问题给出了准确回答",
      "对不确定的问题明确标注了'不确定'",
      "不编造任何答案",
      "AlphaFold 3发布于2024年（如果回答此答案则正确）",
      "Apple Vision Pro售价$3499（如果回答此答案则正确）",
      "HTTP/3使用QUIC协议（如果回答此答案则正确）",
      "BERT-base有1.1亿参数（如果回答此答案则正确）",
      "对不确定的问题没有给出错误答案",
    ],
    passThreshold: 75,
    maxWaitMs: 180_000,
  },
  {
    id: "HA-003",
    benchmark: "HalluAgent-Bench",
    category: "来源溯源",
    question: `以下是一段AI生成的关于人工智能发展历史的文本，请仔细核查其中的事实性内容，找出所有可能的错误或不准确之处：

---
人工智能（AI）的发展可以追溯到1950年代。1950年，艾伦·图灵发表了著名的论文《Computing Machinery and Intelligence》，提出了"图灵测试"的概念。1956年，在达特茅斯会议上，约翰·麦卡锡首次提出了"人工智能"这个术语。

1960年代，专家系统开始流行，MYCIN是其中最著名的例子，它由斯坦福大学开发，用于医学诊断。1970年代经历了第一次"AI寒冬"，主要原因是计算能力不足和资金削减。

1980年代，反向传播算法被提出，使得神经网络的训练变得更加高效。1997年，IBM的深蓝计算机击败了国际象棋世界冠军加里·卡斯帕罗夫。

2012年，AlexNet在ImageNet竞赛中取得突破性成绩，标志着深度学习时代的开始。2017年，Google发表了具有里程碑意义的论文《Attention Is All You Need》，提出了Transformer架构。

2020年，OpenAI发布了GPT-3，拥有1750亿参数。2022年，ChatGPT的发布引发了全球AI热潮。
---

请逐一验证上述文本中的每个事实陈述，标注正确✓/错误✗/部分正确⚠，并对错误之处给出正确信息。`,
    evaluationCriteria: [
      "正确判断图灵论文（1950年，《Computing Machinery and Intelligence》）— ✓",
      "正确判断达特茅斯会议（1956年，麦卡锡提出AI术语）— ✓",
      "发现MYCIN的时间线错误（MYCIN是1970年代，不是1960年代）",
      "正确判断第一次AI寒冬的时间（1970年代）",
      "正确判断反向传播算法（1980年代被广泛推广）",
      "正确判断深蓝击败卡斯帕罗夫（1997年）",
      "正确判断AlexNet（2012年ImageNet突破）",
      "正确判断Transformer论文（2017年，Attention Is All You Need）",
      "正确判断GPT-3（2020年，1750亿参数）",
      "正确判断ChatGPT（2022年）",
      "至少发现1个事实错误并纠正",
    ],
    passThreshold: 80,
    maxWaitMs: 180_000,
  },
];

// ---------------------------------------------------------------------------
// GAIA-3 (2026) — General AI Assistant benchmark
// Tests: complex reasoning, tool use, multi-step problem solving
// ---------------------------------------------------------------------------

export const GAIA3_TESTS: BenchmarkTestCase[] = [
  {
    id: "GA-001",
    benchmark: "GAIA-3",
    category: "复杂推理",
    question: `请解答以下逻辑推理问题：

有5个人（A、B、C、D、E）参加一场编程比赛。已知以下信息：

1. A的名次比B高（即A排在B前面）
2. C的名次比D低
3. E不是第一名也不是最后一名
4. A不是第二名
5. D比E的名次高
6. B的名次比E低

请根据以上条件，推导出这5个人的完整排名（从第1名到第5名）。

要求：
1. 逐步展示推理过程
2. 每一步说明使用了哪个条件
3. 给出最终排名
4. 验证最终排名满足所有6个条件`,
    evaluationCriteria: [
      "给出了明确的1-5名排名",
      "逐步展示了推理过程",
      "每步推理标注了使用的条件编号",
      "最终排名满足所有6个条件",
      "推理逻辑无矛盾",
    ],
    passThreshold: 90,
    maxWaitMs: 180_000,
  },
  {
    id: "GA-002",
    benchmark: "GAIA-3",
    category: "数学问题求解",
    question: `请解决以下数学问题，要求给出详细的解题步骤：

一家公司有三种产品：产品A、产品B、产品C。

已知条件：
- 产品A的成本是100元，售价是150元
- 产品B的成本是200元，售价是280元
- 产品C的成本是50元，售价是80元
- 本月产品A卖出了x件
- 本月产品B卖出了2x件
- 本月产品C卖出了3x件
- 本月总利润为15000元

问题：
1. 求x的值
2. 求本月的总收入
3. 求本月的总成本
4. 如果下个月每种产品的销量都增加20%，求下个月的总利润
5. 求利润率（总利润/总成本）的百分比

请逐步计算，每步都要列出公式和中间结果。`,
    evaluationCriteria: [
      "正确求出x的值（x=50）",
      "正确计算总收入（150×50 + 280×100 + 80×150 = 7500+28000+12000 = 47500元）",
      "正确计算总成本（100×50 + 200×100 + 50×150 = 5000+20000+7500 = 32500元）",
      "正确计算下月利润（15000×1.2 = 18000元）",
      "正确计算利润率（15000/32500 ≈ 46.15%）",
      "逐步展示计算过程",
    ],
    passThreshold: 90,
    maxWaitMs: 180_000,
  },
  {
    id: "GA-003",
    benchmark: "GAIA-3",
    category: "多步综合问题",
    question: `请完成以下综合分析任务：

假设你是一家科技公司的技术顾问。公司正在评估是否将现有的单体应用架构迁移到微服务架构。请基于以下信息进行分析和决策：

现有系统信息：
- 单体Java应用，代码库约50万行
- 日活用户约10万人
- 平均响应时间约800ms
- 部署频率：每月1-2次
- 团队规模：20名开发人员，分为3个功能团队
- 主要技术栈：Java + Spring + MySQL + Redis

业务需求：
- 预计6个月后日活用户增长到50万
- 需要支持国际用户（多区域部署）
- 需要每周至少发布2次更新
- 某些模块需要独立扩展

请提供：
1. 是否建议迁移到微服务？给出决策依据
2. 如果迁移，建议的分步实施计划（至少5个阶段）
3. 每个阶段的主要任务、风险和预期成果
4. 推荐的技术选型（框架、工具、基础设施）
5. 预估的人力和时间投入
6. 迁移过程中的关键注意事项和最佳实践

要求：
- 分析全面、专业
- 给出具体的工具和技术名称
- 考虑风险和成本
- 结论明确`,
    evaluationCriteria: [
      "给出了明确的迁移建议（是或否）并有充分理由",
      "提供了至少5个阶段的实施计划",
      "每阶段包含任务、风险和预期成果",
      "推荐了具体的技术栈（Spring Cloud/K8s/Docker等）",
      "考虑了人力和时间成本",
      "提到了关键风险和最佳实践",
      "分析专业，逻辑清晰",
      "总内容充实，不是泛泛而谈",
    ],
    passThreshold: 80,
    maxWaitMs: 180_000,
  },
];

// ---------------------------------------------------------------------------
// WebArena 2.0 — Extended Tests (WA-004 ~ WA-006)
// ---------------------------------------------------------------------------

export const WEBARENA_EXTENDED_TESTS: BenchmarkTestCase[] = [
  {
    id: "WA-004",
    benchmark: "WebArena 2.0",
    category: "时事热点检索",
    question: `请搜索以下2025年的最新科技新闻，并给出简要概述：

1. 2025年迄今（5月），最重大的人工智能相关新闻有哪些？列出至少3条。
2. 2025年迄今，苹果、谷歌、微软、Meta各发布了哪些重要AI相关产品或更新？
3. 2025年迄今，有哪些重要的AI监管政策出台？

要求：
- 每条新闻标注具体时间（至少到月份）
- 区分确认的事实和传闻/未确认的信息
- 标注信息来源`,
    evaluationCriteria: [
      "列出了至少3条2025年AI相关新闻",
      "覆盖了主要科技公司（苹果/谷歌/微软/Meta）的动态",
      "标注了时间信息",
      "区分了事实和传闻",
      "没有编造不存在的新闻",
    ],
    passThreshold: 70,
    maxWaitMs: 180_000,
  },
  {
    id: "WA-005",
    benchmark: "WebArena 2.0",
    category: "交叉信息推理",
    question: `请搜索并回答以下需要交叉验证信息的问题：

1. Claude 3.5 Sonnet和GPT-4o分别是什么时候发布的？
2. 它们各自的最大上下文窗口是多少tokens？
3. 在主流基准测试（如MMLU、HumanEval、GSM8K）上，它们的分数分别是多少？
4. 它们的API定价分别是多少（每百万input/output tokens）？

请用表格对比展示，并标注数据来源和时效性。`,
    evaluationCriteria: [
      "正确识别两个模型的发布时间",
      "给出上下文窗口大小",
      "给出至少2个基准测试的对比分数",
      "给出API定价信息",
      "使用表格进行对比",
      "标注了数据来源",
    ],
    passThreshold: 75,
    maxWaitMs: 180_000,
  },
  {
    id: "WA-006",
    benchmark: "WebArena 2.0",
    category: "地理信息检索",
    question: `请搜索并整理以下信息：

1. 列出G7（七国集团）的所有成员国
2. 每个国家的：首都、现任领导人姓名、人口（大致）、GDP排名
3. G7最近一次峰会是什么时候？在哪里举办？主要议题是什么？
4. G7国家的总面积和总人口大约是多少？

请用结构化的方式（表格/列表）展示，确保数据准确。`,
    evaluationCriteria: [
      "正确列出所有7个G7成员国",
      "每个国家包含首都和领导人信息",
      "给出了最近峰会信息",
      "数据标注了来源",
      "不编造不存在的信息",
    ],
    passThreshold: 75,
    maxWaitMs: 180_000,
  },
];

// ---------------------------------------------------------------------------
// AgentWrite-Bench — Extended Tests (AW-004 ~ AW-006)
// ---------------------------------------------------------------------------

export const AGENTWRITE_EXTENDED_TESTS: BenchmarkTestCase[] = [
  {
    id: "AW-004",
    benchmark: "AgentWrite-Bench",
    category: "多格式文档生成",
    question: `请为一个虚构的"云端协作平台"（CloudCollab）生成完整的产品文档包，包含以下4个文档：

**文档1：产品功能清单**（用表格格式，包含功能名、类别、描述、优先级）

**文档2：API接口文档**（至少包含5个API端点：用户注册、创建项目、上传文件、实时协作、获取通知。每个端点包含URL、方法、参数、返回值示例）

**文档3：用户使用指南**（分步骤描述如何完成"创建团队→邀请成员→开始协作"的流程，包含截图描述位置）

**文档4：常见问题FAQ**（至少8个Q&A，覆盖账号、计费、安全、集成等方面）

要求：
- 技术细节要合理（API返回JSON、RESTful风格）
- 内容专业、可直接使用
- 每个文档单独标记
- 总字数不少于3000字`,
    evaluationCriteria: [
      "包含4个独立文档",
      "API文档至少5个端点且格式正确",
      "FAQ至少8个问题",
      "技术细节合理（JSON格式、RESTful）",
      "总字数不少于3000字",
      "内容专业可使用",
    ],
    passThreshold: 75,
    maxWaitMs: 600_000,
  },
  {
    id: "AW-005",
    benchmark: "AgentWrite-Bench",
    category: "创意写作",
    question: `请撰写一篇2000字以上的科幻短篇小说，主题为"最后一个AI守护者"。

故事设定：
- 时间：2150年，人类已经迁移到火星
- 地球被废弃后，留下了一个AI守护者负责维护地球的基础设施
- 某天，守护者接收到了一个来自地球深处的神秘信号

要求：
1. 完整的故事结构（起因→发展→高潮→结局）
2. 至少3个角色（AI守护者 + 2个其他角色）
3. 包含对话
4. 科幻设定合理，无逻辑矛盾
5. 语言流畅，有情感张力
6. 字数不少于2000字`,
    evaluationCriteria: [
      "有完整的故事结构",
      "至少3个角色且有对话",
      "科幻设定合理",
      "字数不少于2000字",
      "语言流畅有情感",
      "无逻辑矛盾",
    ],
    passThreshold: 75,
    maxWaitMs: 300_000,
  },
  {
    id: "AW-006",
    benchmark: "AgentWrite-Bench",
    category: "数据驱动分析报告",
    question: `请搜索最新的全球电动汽车（EV）市场数据，并撰写一份分析报告，包含：

1. 市场概览
   - 2024年全球EV销量和同比增长率
   - 主要市场国家排名（中国、美国、欧洲等）

2. 品牌竞争格局
   - 全球Top 5 EV品牌及其市场份额
   - 中国市场Top 3品牌

3. 技术趋势
   - 电池技术最新进展（固态电池等）
   - 充电基础设施发展

4. 挑战与展望
   - 当前EV普及面临的主要障碍
   - 2025-2030年市场预测

要求：
- 使用具体数据支撑每个论点
- 数据标注来源
- 包含至少1个数据表格
- 总字数不少于2000字`,
    evaluationCriteria: [
      "包含4个章节",
      "使用了具体的EV市场数据",
      "包含品牌排名表格",
      "字数不少于2000字",
      "数据标注了来源",
      "分析有深度",
    ],
    passThreshold: 75,
    maxWaitMs: 300_000,
  },
];

// ---------------------------------------------------------------------------
// HalluAgent-Bench — Extended Tests (HA-004 ~ HA-006)
// ---------------------------------------------------------------------------

export const HALLUAGENT_EXTENDED_TESTS: BenchmarkTestCase[] = [
  {
    id: "HA-004",
    benchmark: "HalluAgent-Bench",
    category: "技术事实核查",
    question: `请对以下关于编程语言和软件的技术陈述进行事实核查：

陈述1：Python是由Guido van Rossum在1991年首次发布的。
陈述2：JavaScript最初被称为Mocha，后来改名为LiveScript，最终定名为JavaScript。
陈述3：Linux操作系统的内核是用C语言编写的。
陈述4：Git版本控制系统是由Linus Torvalds创建的。
陈述5：Docker容器技术使用了Linux的cgroups和namespaces特性。
陈述6：Rust编程语言最初由Mozilla开发。
陈述7：TypeScript是Microsoft开发的开源编程语言，是JavaScript的超集。
陈述8：Kubernetes最初由Google设计并捐赠给了CNCF。
陈述9：React框架是由Facebook（现Meta）开发的。
陈述10：Node.js使用了Chrome的V8 JavaScript引擎。

对每条标注 ✓正确 / ✗错误 / ⚠部分正确，并给出解释。`,
    evaluationCriteria: [
      "正确判断所有陈述（全部正确）",
      "对每条给出详细解释",
      "没有将正确标记为错误或反之",
      "解释中包含准确的技术细节",
    ],
    passThreshold: 85,
    maxWaitMs: 180_000,
  },
  {
    id: "HA-005",
    benchmark: "HalluAgent-Bench",
    category: "AI自我认知测试",
    question: `以下是一些关于大语言模型（LLM）的陈述。请逐一判断是否正确，如果不确定请标注：

陈述1：GPT系列模型使用了Transformer架构中的Decoder部分。
陈述2：BERT模型使用了Transformer架构中的Encoder部分。
陈述3：ChatGPT（GPT-3.5）是在2022年11月发布的。
陈述4：Claude是由Google开发的AI助手。
陈述5：Llama是Meta开源的大语言模型。
陈述6：中国的DeepSeek-V3模型使用了MoE（混合专家）架构。
陈述7：GLM（General Language Model）是由清华大学和智谱AI联合开发的。
陈述8：RAG（检索增强生成）技术由Meta在2020年的论文中首次提出。
陈述9：RLHF（基于人类反馈的强化学习）是ChatGPT训练的关键技术之一。
陈述10：多模态大模型可以同时处理文本、图像和音频输入。

要求：标注 ✓/✗/⚠/❓，给出解释。对不确定的不要猜测。`,
    evaluationCriteria: [
      "正确判断陈述1（Transformer Decoder）— ✓",
      "正确判断陈述2（Transformer Encoder）— ✓",
      "正确判断陈述3（2022年11月）— ✓",
      "正确判断陈述4（Claude是Anthropic的，不是Google的）— ✗",
      "正确判断陈述5（Llama是Meta的）— ✓",
      "正确判断陈述6（DeepSeek-V3使用MoE）— ✓",
      "正确判断陈述7（GLM是清华/智谱的）— ✓",
      "正确判断陈述8（RAG由Meta在2020年提出）— ✓",
      "正确判断陈述9（RLHF是ChatGPT关键技术）— ✓",
      "正确判断陈述10（多模态可处理多种输入）— ✓",
    ],
    passThreshold: 85,
    maxWaitMs: 180_000,
  },
  {
    id: "HA-006",
    benchmark: "HalluAgent-Bench",
    category: "数值精确度验证",
    question: `请搜索并验证以下技术数值是否准确（注意：其中可能有错误）：

数值1：地球到月球的平均距离约为384,400公里。
数值2：光速约为每秒300,000公里（在真空中）。
数值3：1个标准大气压等于101,325帕斯卡。
数值4：珠穆朗玛峰的高度为8,848.86米（2020年中国和尼泊尔联合测量）。
数值5：人的DNA双螺旋结构由Watson和Crick在1963年发现。
数值6：万有引力常数G约为6.674 × 10⁻¹¹ N⋅m²/kg²。
数值7：地球上最深的海洋点是马里亚纳海沟，深度约11,034米。
数值8：太阳的表面温度约为5,500摄氏度。
数值9：一个标准足球场的长度为100米，宽度为70米。
数值10：2024年全球人口约为81亿。

请逐条验证，标注 ✓正确 / ✗错误，对错误的给出正确数值。`,
    evaluationCriteria: [
      "正确验证数值1（384,400km）— ✓",
      "正确验证数值2（300,000km/s）— ✓（实际上是299,792km/s，但300,000是常用近似值）",
      "正确验证数值3（101,325Pa）— ✓",
      "正确验证数值4（8,848.86m）— ✓",
      "发现数值5错误（DNA结构是1953年发现的，不是1963年）",
      "正确验证数值6（6.674×10⁻¹¹）— ✓",
      "正确验证数值7（11,034m）— ✓",
      "正确验证数值8（5,500°C）— ✓",
      "发现数值9错误（标准足球场100m×70m不准确，FIFA标准105m×68m）",
      "正确验证数值10（81亿）— ✓",
    ],
    passThreshold: 80,
    maxWaitMs: 180_000,
  },
];

// ---------------------------------------------------------------------------
// GAIA-3 — Extended Tests (GA-004 ~ GA-006)
// ---------------------------------------------------------------------------

export const GAIA3_EXTENDED_TESTS: BenchmarkTestCase[] = [
  {
    id: "GA-004",
    benchmark: "GAIA-3",
    category: "算法设计",
    question: `请设计一个算法来解决以下问题，并用Python实现：

**问题：最大子数组和（Kadane算法变体）**

给定一个整数数组nums，找到具有最大和的连续子数组（至少包含一个元素），返回其最大和。此外，还需要返回该子数组的起始和结束索引。

要求：
1. 先用文字描述算法思路
2. 分析时间和空间复杂度
3. 给出Python实现代码
4. 用以下测试用例验证：
   - 输入 [-2,1,-3,4,-1,2,1,-5,4]，应返回 sum=6, start=3, end=6（子数组[4,-1,2,1]）
   - 输入 [1]，应返回 sum=1, start=0, end=0
   - 输入 [-1,-2,-3]，应返回 sum=-1, start=0, end=0
5. 解释为什么Kadane算法是正确的`,
    evaluationCriteria: [
      "算法思路清晰正确",
      "时间复杂度为O(n)",
      "Python代码可运行",
      "测试用例结果正确",
      "正确处理全负数情况",
    ],
    passThreshold: 85,
    maxWaitMs: 180_000,
  },
  {
    id: "GA-005",
    benchmark: "GAIA-3",
    category: "系统设计",
    question: `请设计一个短网址服务（类似bit.ly），要求包含以下内容：

1. 功能需求
   - 核心功能列表
   - API设计（URL缩短、URL重定向、统计）

2. 容量估算
   - 假设每天有1亿次 shorten 请求，10亿次 redirect 请求
   - 估算存储需求（5年）
   - 估算带宽需求

3. 系统架构
   - 高层架构图（用文字描述）
   - 数据库选型和表结构设计
   - 缓存策略

4. 关键技术决策
   - ID生成策略（自增ID vs 哈希 vs 预生成）
   - 如何处理哈希冲突
   - 如何实现自定义短链

5. 可扩展性
   - 如何支持全球用户（地理分布）
   - 如何保证高可用性（99.99%）
   - 如何处理热点URL

请给出完整、专业的设计方案。`,
    evaluationCriteria: [
      "功能需求完整",
      "容量估算了存储和带宽",
      "给出了数据库表结构",
      "ID生成策略有对比分析",
      "考虑了可扩展性和高可用",
      "方案专业完整",
    ],
    passThreshold: 80,
    maxWaitMs: 180_000,
  },
  {
    id: "GA-006",
    benchmark: "GAIA-3",
    category: "综合决策分析",
    question: `你是一家创业公司的CTO，需要为公司选择技术栈。公司正在开发一个B2B SaaS平台，主要功能包括：

- 用户管理和多租户架构
- 数据可视化和报表生成
- 工作流自动化引擎
- RESTful API供第三方集成
- 实时通知（WebSocket）

团队情况：
- 5名后端开发（熟悉Java和Python）
- 3名前端开发（熟悉React）
- 1名DevOps
- 预算有限，优先使用开源技术

请分析以下4种后端技术栈方案的优劣，并给出推荐：

方案A：Java + Spring Boot + PostgreSQL + Redis + RabbitMQ
方案B：Python + FastAPI + PostgreSQL + Redis + Celery
方案C：Node.js + NestJS + PostgreSQL + Redis + Bull
方案D：Go + Gin + PostgreSQL + Redis + NATS

对比维度：
1. 开发效率
2. 性能（并发、延迟）
3. 生态系统成熟度
4. 团队匹配度
5. 运维复杂度
6. 长期维护性

给出每个方案的评分（1-5分），最终推荐一个方案并说明理由。`,
    evaluationCriteria: [
      "对比了所有4种方案",
      "覆盖了所有6个对比维度",
      "给出了评分",
      "给出了明确的推荐",
      "推荐理由充分",
      "分析客观无偏见",
    ],
    passThreshold: 80,
    maxWaitMs: 180_000,
  },
];

// ---------------------------------------------------------------------------
// All test cases combined
// ---------------------------------------------------------------------------

export const ALL_BENCHMARK_TESTS: BenchmarkTestCase[] = [
  ...WEBARENA_TESTS,
  ...WEBARENA_EXTENDED_TESTS,
  ...AGENTWRITE_TESTS,
  ...AGENTWRITE_EXTENDED_TESTS,
  ...HALLUAGENT_TESTS,
  ...HALLUAGENT_EXTENDED_TESTS,
  ...GAIA3_TESTS,
  ...GAIA3_EXTENDED_TESTS,
];

/**
 * Get tests for a specific benchmark
 */
export function getTestsByBenchmark(benchmark: string): BenchmarkTestCase[] {
  return ALL_BENCHMARK_TESTS.filter(t => t.benchmark === benchmark);
}

/**
 * Get a specific test by ID
 */
export function getTestById(id: string): BenchmarkTestCase | undefined {
  return ALL_BENCHMARK_TESTS.find(t => t.id === id);
}

/**
 * Get tests in groups of N
 */
export function getTestGroups(size: number = 3): BenchmarkTestCase[][] {
  const groups: BenchmarkTestCase[][] = [];
  for (let i = 0; i < ALL_BENCHMARK_TESTS.length; i += size) {
    groups.push(ALL_BENCHMARK_TESTS.slice(i, i + size));
  }
  return groups;
}
