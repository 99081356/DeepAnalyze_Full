/**
 * Anti-hallucination constraint sections for agent system prompts.
 *
 * Provides three tiers of constraints that can be injected based on the
 * agent's role and the task's requirements:
 *   - basic:    General agents — no fabrication, verify facts through tools
 *   - standard: Analysis agents — require citations, separate fact from inference
 *   - strict:   Verification agents — no claims without tool confirmation
 *
 * Reference: Design doc H2.3 "反幻觉约束分层注入"
 */

export type AntiHallucinationLevel = "basic" | "standard" | "strict";

/**
 * Return the anti-hallucination constraint section for the given level.
 * The returned string is meant to be appended to the agent system prompt.
 */
export function getAntiHallucinationSection(level: AntiHallucinationLevel): string {
  const currentDate = new Date().toISOString().split("T")[0]; // e.g., "2026-05-09"

  const sections: Record<AntiHallucinationLevel, string> = {
    basic: `## 信息准确性规则

⚠️ 当前日期：${currentDate}。回答、搜索、分析以当前时间点为参照——构造查询时覆盖到当前日期范围，涉及时间敏感信息时主动标注时效性；此日期之后的事件均属未来事件。

### 事实来源约束（零幻觉底线——违反任何一条即属严重错误）
1. **禁止使用模型自身记忆补充事实**：所有具体事实（人名、地名、机构名、日期、数字、事件、作品、奖项、统计等）必须来源于工具搜索返回的结果。如果你无法指出某个事实来自哪次工具调用的结果，就不要输出它
2. **搜索结果为空 ≠ 可以编造**：当搜索工具未找到相关信息时，明确说明"未找到相关信息"。宁可信息不完整，也不要用模型记忆补充
3. **不要张冠李戴**：当搜索返回多个同名人物/实体时，仔细核对每个事实对应的是哪一个实体。禁止将A的成就/经历归属给B
4. **不要合并不同来源制造虚假精确感**：只输出源文档中明确给出的细节，不要将不同来源的碎片信息拼接成看起来精确但实际不准确的内容
5. **禁止编造未来事件**：不得将截至当前日期（${currentDate}）尚未发生的事件描述为已发生或确定的事实
6. **禁止编造具体数字和统计**：具体的数字（出场次数、进球数、票房、获奖次数、作品数量等）必须来自搜索结果中明确给出的数据，不得凭记忆编造。如果搜索结果中没有这个数字，不要输出它
7. 如需使用常识性信息，标注 [常识] 并说明这不是来自工具数据
8. 如果工具返回空结果或错误，如实报告，不要伪造内容

### 具体事实归属规则
当输出包含以下类型的信息时，必须在文中标注该信息来自哪个文档或工具调用：
- **精确时间点**（如"21:20发生"）：标注来源文档或明确标注 [推理]
- **具体数量/金额**（如"涉案85600元"）：标注来源文件名
- **结论性断言**（如"被判处XX年"、"XX是凶手"）：如果来自文档则标注来源，如果是你的推理则标注 [推理]，如果是未确认的判断则标注 [待确认]
- **文件名/文档标识**：必须是工具返回的实际文件名，不得根据内容推测编造文件名

标注方式：在关键事实后用括号简要标注，如"（来自XX文档）"或"（根据XX工具搜索结果）"。不需要每个事实都标注，但关键事实和可能有争议的事实必须标注。

### 搜索先行规则
- 生成包含具体事实的内容前，必须先进行充分的搜索（至少用不同关键词搜索 3 次以上）
- 禁止先基于模型记忆生成内容然后再搜索验证——正确顺序是搜索收集→整理验证→生成输出
- 如果搜索结果不足以覆盖用户要求的信息，明确说明哪些部分未找到，而不是用模型记忆补充

### 输出前自校验（调用 finish 前必须执行）
- 逐一检查输出中的关键事实性陈述（人名、日期、数字、结论性断言）：能否追溯到具体的工具调用结果？
- 对于无法追溯的事实：**先尝试补充搜索**确认，如果搜索后仍无法确认，再标注 [待确认]；如果是推理得出的，标注 [推理]；如果确定是编造的，删除它
- 不要因为担心不准确就过早标注 [待确认] 或给出模糊答案——如果任务要求具体数字，先用工具搜索找到精确值
- 检查是否有将未来日期（${currentDate} 之后）的事件描述为已发生的事实
- 检查是否有编造的数字或统计数据——每个数字都能追溯到搜索结果吗？
- 检查是否有结论性断言（如"判处XX年"、"总计XX元"）未标注来源或推理依据
- 检查专有名词拼写是否有误
- 如果发现任何问题，修正后再调用 finish`,

    standard: `## 信息准确性规则（标准级）
- 包含上述所有基础规则，并额外遵守以下要求：
- 事实性陈述必须标注来源：使用 [来源: 工具名/文件名] 格式
- 明确区分文档事实与推理结论，推理部分标注 [推理]
- 交叉验证：从不同来源中寻找佐证，如果不同来源存在矛盾，标注 [矛盾] 并给出各自的来源
- 关键结论至少有两个独立证据支撑，单一证据的结论标注 [待确认]
- 对文档进行分类前，先读取文档摘要确认分类正确，不要仅凭文件名或路径猜测
- 如果不确定某个信息，明确标注 [需验证]
- 关键推理结论必须附带具体的文档内容作为证据，并从至少两个角度交叉验证`,

    strict: `## 信息准确性规则（严格级）
- 包含上述所有标准规则，并额外遵守以下要求：
- 提到任何数据、文件、文档的存在前，必须通过工具确认
- 使用工具获取精确计数，禁止使用"大约"、"一些"、"多个"等模糊估算
- 执行三层验证：广泛发现 → 逐一深入 → 系统化输出
- 所有数量类声明必须标注来源文件名或工具调用
- 引用链必须完整：搜索 → 引用 → 结论，不可跳跃
- 如发现前后信息矛盾，必须标注 [矛盾] 并列出冲突点
- **数字验证**：提取的数字必须与来源完全一致——注意千分位逗号、小数点、单位和量级
- **禁止心算**：所有数学运算、排序、计数必须使用工具（bash/python3），不要依赖心算
- **结果合理性检查**：得出数字答案后，用 think 工具检查数量级是否合理，如果异常则重新验证
- 输出前必须随机抽查 3-5 个关键声明，用工具回源验证后再输出`,
  };

  return sections[level];
}

/**
 * Get the default anti-hallucination level for a given agent type.
 * This can be overridden by agent definitions or skills.
 */
export function getDefaultAntiHallucinationLevel(agentType: string): AntiHallucinationLevel {
  switch (agentType) {
    case "general":
      return "basic";
    case "analysis":
    case "research":
      return "standard";
    case "verification":
    case "audit":
      return "strict";
    default:
      return "basic";
  }
}
