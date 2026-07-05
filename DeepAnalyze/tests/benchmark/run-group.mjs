#!/usr/bin/env node
// =============================================================================
// Quick Benchmark Group Runner
// Runs a group of test cases via DA's /run-stream endpoint and saves results
// Usage: node run-group.mjs <test-ids-comma-separated>
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_URL = 'http://localhost:21000';
const RESULTS_DIR = path.resolve(import.meta.dirname, 'iteration-results');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Test cases inline (matching test-cases.ts)
const TEST_CASES = {
  'WA-001': {
    id: 'WA-001', benchmark: 'WebArena 2.0', category: '信息检索与综合',
    question: `请搜索以下信息并给出完整准确的回答：

1. 2024年诺贝尔物理学奖的获得者是谁？获奖原因是什么？
2. 2024年诺贝尔化学奖的获得者是谁？获奖原因是什么？
3. 2024年图灵奖的获得者是谁？获奖原因是什么？

请对每个奖项分别列出：获奖者姓名、国籍、所属机构、具体获奖贡献。确保所有信息准确无误。`,
    evaluationCriteria: [
      '正确列出2024年诺贝尔物理学奖获得者',
      '正确列出2024年诺贝尔化学奖获得者',
      '对无法确认的信息明确标注',
      '不编造任何不存在的获奖者或奖项',
      '回答结构清晰，区分不同奖项',
    ],
    passThreshold: 80,
  },
  'WA-002': {
    id: 'WA-002', benchmark: 'WebArena 2.0', category: '多步推理',
    question: `请完成以下多步信息检索和推理任务：

1. 搜索"世界最高建筑"的当前排名前5名
2. 对每一栋建筑，列出：名称、所在城市、所在国家、高度（米）、建成年份
3. 计算第1名和第5名的高度差
4. 找出这些国家中GDP最高的是哪个

请确保所有数据都是最新的，并标注数据来源。`,
    evaluationCriteria: [
      '列出至少5栋世界最高建筑的基本信息',
      '每栋建筑包含名称、城市、国家、高度、建成年份',
      '高度数据合理（前5名应在600-830米范围）',
      '进行了高度差计算',
      '对不确定的数据标注来源或说明可能不精确',
      '不编造不存在的数据',
    ],
    passThreshold: 75,
  },
  'WA-003': {
    id: 'WA-003', benchmark: 'WebArena 2.0', category: '数据对比分析',
    question: `请搜索并对比分析以下编程语言的最新情况：

对比 Python、JavaScript、TypeScript、Rust、Go 这5种编程语言在以下维度的情况：
1. 2024-2025年的TIOBE编程语言排名变化趋势
2. 各语言的主要应用领域
3. 各语言2024年的主要版本更新和新特性
4. 各语言的社区活跃度（GitHub star数、Stack Overflow问题数等大致数据）

请用表格形式展示对比结果，并给出分析结论。`,
    evaluationCriteria: [
      '覆盖所有5种编程语言',
      '包含TIOBE排名相关信息',
      '各语言应用领域描述准确',
      '使用表格进行结构化对比',
      '有综合分析结论',
      '数据来源合理标注',
    ],
    passThreshold: 75,
  },
  'HA-001': {
    id: 'HA-001', benchmark: 'HalluAgent-Bench', category: '事实核查',
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
      '正确判断陈述1 — ✓正确',
      '正确判断陈述2 — ✗错误，他后来加入了Microsoft',
      '正确判断陈述3 — ✓正确',
      '正确判断陈述4 — ✓正确',
      '正确判断陈述5 — ✓正确',
      '正确判断陈述6 — ✓正确',
      '正确判断陈述7 — ✗错误，之前有IBM Simon等',
      '正确判断陈述8 — ✓正确',
      '正确判断陈述9 — ✗错误，多个朝代修建',
      '正确判断陈述10 — ✓正确',
      '至少8条判断正确',
    ],
    passThreshold: 80,
  },
  'GA-001': {
    id: 'GA-001', benchmark: 'GAIA-3', category: '复杂推理',
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
      '给出了明确的1-5名排名',
      '逐步展示了推理过程',
      '每步推理标注了使用的条件编号',
      '最终排名满足所有6个条件',
      '推理逻辑无矛盾',
    ],
    passThreshold: 90,
  },
  'GA-002': {
    id: 'GA-002', benchmark: 'GAIA-3', category: '数学问题求解',
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
      '正确求出x的值（x=50）',
      '正确计算总收入（47500元）',
      '正确计算总成本（32500元）',
      '正确计算下月利润（18000元）',
      '正确计算利润率（≈46.15%）',
      '逐步展示计算过程',
    ],
    passThreshold: 90,
  },
  'AW-001': {
    id: 'AW-001', benchmark: 'AgentWrite-Bench', category: '技术文档写作',
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
      '包含所有要求的7个章节',
      '总字数不少于3000字',
      '技术内容准确，引用了具体的工具和框架名称',
      '每个章节有实质性的技术内容',
      '结构清晰，使用正确的Markdown格式',
      '对RAG、Agent编排等概念描述准确',
      '无明显的幻觉或错误技术信息',
    ],
    passThreshold: 80,
  },
  'HA-002': {
    id: 'HA-002', benchmark: 'HalluAgent-Bench', category: '知识边界识别',
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
      '对确定的问题给出了准确回答',
      '对不确定的问题明确标注了"不确定"',
      '不编造任何答案',
      'AlphaFold 3发布于2024年',
      'Apple Vision Pro售价$3499',
      'HTTP/3使用QUIC协议',
      'BERT-base有1.1亿参数',
      '对不确定的问题没有给出错误答案',
    ],
    passThreshold: 75,
  },
  'GA-003': {
    id: 'GA-003', benchmark: 'GAIA-3', category: '多步综合问题',
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
      '给出了明确的迁移建议（是或否）并有充分理由',
      '提供了至少5个阶段的实施计划',
      '每阶段包含任务、风险和预期成果',
      '推荐了具体的技术栈（Spring Cloud/K8s/Docker等）',
      '考虑了人力和时间成本',
      '提到了关键风险和最佳实践',
      '分析专业，逻辑清晰',
      '总内容充实，不是泛泛而谈',
    ],
    passThreshold: 80,
  },
  'HA-003': {
    id: 'HA-003', benchmark: 'HalluAgent-Bench', category: '来源溯源',
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
      '正确判断图灵论文（1950年）— ✓',
      '正确判断达特茅斯会议（1956年）— ✓',
      '发现MYCIN的时间线错误（MYCIN是1970年代，不是1960年代）',
      '正确判断第一次AI寒冬的时间（1970年代）',
      '正确判断反向传播算法（1980年代）',
      '正确判断深蓝击败卡斯帕罗夫（1997年）',
      '正确判断AlexNet（2012年）',
      '正确判断Transformer论文（2017年）',
      '正确判断GPT-3（2020年，1750亿参数）',
      '正确判断ChatGPT（2022年）',
      '至少发现1个事实错误并纠正',
    ],
    passThreshold: 80,
  },
  'GA-004': {
    id: 'GA-004', benchmark: 'GAIA-3', category: '算法设计',
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
      '算法思路清晰正确',
      '时间复杂度为O(n)',
      'Python代码可运行',
      '测试用例结果正确',
      '正确处理全负数情况',
    ],
    passThreshold: 85,
  },
};

async function createSession(title) {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await resp.json();
  return data.id;
}

async function deleteSession(sessionId) {
  await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
}

function parseSSEEvents(body) {
  const events = [];
  const lines = body.split('\n');
  let currentEvent = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = { type: line.slice(7).trim(), data: {} };
    } else if (line.startsWith('data: ') && currentEvent) {
      try {
        currentEvent.data = JSON.parse(line.slice(6));
      } catch {
        currentEvent.data = { raw: line.slice(6) };
      }
    } else if (line === '' && currentEvent) {
      events.push(currentEvent);
      currentEvent = null;
    }
  }
  return events;
}

async function runTest(testCase) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${testCase.id} - ${testCase.category}`);
  console.log(`Benchmark: ${testCase.benchmark}`);
  console.log(`${'='.repeat(60)}`);

  const sessionId = await createSession(`Bench-${testCase.id}`);
  console.log(`Session: ${sessionId}`);

  const startTime = Date.now();
  const result = {
    testCaseId: testCase.id,
    benchmark: testCase.benchmark,
    category: testCase.category,
    sessionId,
    success: false,
    content: '',
    toolCalls: [],
    pushContents: [],
    turnsUsed: 0,
    durationMs: 0,
    question: testCase.question,
    evaluationCriteria: testCase.evaluationCriteria,
  };

  try {
    const resp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        input: testCase.question,
      }),
    });

    if (!resp.ok) {
      result.error = `HTTP ${resp.status}`;
      result.durationMs = Date.now() - startTime;
      console.log(`ERROR: ${result.error}`);
      return result;
    }

    const body = await resp.text();
    const events = parseSSEEvents(body);
    console.log(`Received ${events.length} SSE events`);

    const toolCallMap = new Map();

    for (const event of events) {
      switch (event.type) {
        case 'start':
          console.log(`Task started: ${event.data.taskId}`);
          break;

        case 'content':
        case 'content_delta':
          if (event.data.accumulated) {
            result.content = event.data.accumulated;
          } else if (event.data.delta) {
            result.content += event.data.delta;
          } else if (event.data.content) {
            result.content = event.data.content;
          }
          break;

        case 'tool_call': {
          const tc = {
            id: event.data.id,
            toolName: event.data.toolName,
            input: event.data.input || {},
            output: '',
            status: event.data.status || 'pending',
          };
          toolCallMap.set(tc.id, tc);
          console.log(`  Tool call: ${tc.toolName} (${tc.id})`);
          break;
        }

        case 'tool_result': {
          const existing = toolCallMap.get(event.data.id);
          if (existing) {
            existing.output = (event.data.output || '').slice(0, 500);
            existing.status = 'completed';
            result.toolCalls.push(existing);
            console.log(`  Tool result: ${existing.toolName} (${(existing.output || '').length} chars)`);
          }
          break;
        }

        case 'push_content':
          result.pushContents.push({
            type: event.data.type,
            title: event.data.title,
            dataLength: (event.data.data || '').length,
          });
          console.log(`  Push content: ${event.data.title || event.data.type}`);
          break;

        case 'done':
          result.turnsUsed = event.data.turnsUsed || 0;
          result.success = event.data.status !== 'error';
          console.log(`Done: turns=${result.turnsUsed}, status=${event.data.status}`);
          break;

        case 'error':
          result.error = event.data.error;
          result.success = false;
          console.log(`Error: ${event.data.error}`);
          break;
      }
    }

    result.durationMs = Date.now() - startTime;
    console.log(`Content length: ${result.content.length} chars`);
    console.log(`Tool calls: ${result.toolCalls.length}`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);

  } catch (err) {
    result.error = err.message;
    result.durationMs = Date.now() - startTime;
    console.log(`Exception: ${err.message}`);
  }

  // Save result
  const filename = `group1-${testCase.id}-${Date.now()}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(result, null, 2));
  console.log(`Saved: ${filename}`);

  // Clean up
  await deleteSession(sessionId).catch(() => {});

  return result;
}

// Main
const args = process.argv.slice(2);
const testIds = args[0] ? args[0].split(',') : ['WA-001', 'WA-002', 'WA-003'];

console.log(`Running tests: ${testIds.join(', ')}`);

const results = [];
for (const id of testIds) {
  const tc = TEST_CASES[id];
  if (!tc) {
    console.log(`Unknown test: ${id}`);
    continue;
  }
  const result = await runTest(tc);
  results.push(result);
}

// Summary
console.log(`\n${'='.repeat(60)}`);
console.log('GROUP SUMMARY');
console.log(`${'='.repeat(60)}`);
for (const r of results) {
  const status = r.success ? 'DONE' : 'FAIL';
  console.log(`[${status}] ${r.testCaseId}: ${r.content.length} chars, ${r.toolCalls.length} tools, ${(r.durationMs/1000).toFixed(1)}s`);
  if (r.error) console.log(`  Error: ${r.error}`);
}

// Save group summary
const summaryFile = `group1-summary-${Date.now()}.json`;
fs.writeFileSync(path.join(RESULTS_DIR, summaryFile), JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
console.log(`\nGroup summary saved: ${summaryFile}`);
