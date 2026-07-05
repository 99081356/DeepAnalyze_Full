// =============================================================================
// DeepAnalyze - Hierarchical Context Compression
// =============================================================================
// Defines compression levels for hierarchical context compression.
// Messages are split into three depth layers (D2/D1/Leaf) with different
// compression granularities to preserve recent context fidelity while
// aggressively summarizing older context.
// =============================================================================

import type { ChatMessage } from "../../models/provider.js";

/**
 * Compression level definitions for hierarchical context compression.
 * - D2: Oldest messages, coarsest summary (just conclusions)
 * - D1: Middle messages, medium granularity (key decisions + data points)
 * - Leaf: Most recent messages, no compression
 */
export interface CompressionLevel {
  name: string;
  maxTokens: number;
  prompt: string;
}

export const COMPRESSION_LEVELS: CompressionLevel[] = [
  {
    name: "D2",
    maxTokens: 2000,
    prompt: `你是一个对话摘要器。请用3-5句话概括以下对话内容。
保留最重要的结论、决策和最终结果。
可以省略中间推理过程，但必须保留：
- 所有文件路径（write_file 输出路径、read_file 读取的路径）
- 文档ID、知识库ID（UUID格式）
- 已确认的数据来源和搜索关键词
这些标识符对后续回引至关重要，不可简化或省略。
格式：简洁的段落文本，末尾附上"关键标识符:"列表。`,
  },
  {
    name: "D1",
    maxTokens: 4000,
    prompt: `你是一个对话摘要器。请为以下对话创建结构化摘要。
保留：1. 用户请求和意图变化 2. 关键决策和原因 3. 重要事实（数量、名称、标识符）4. 错误及解决方式 5. 未完成的任务 6. 所有文件路径、文档ID（doc_xxx）、页面ID（page_xxx）、UUID
标识符必须原样保留，不可简化为描述性文字（例如不能把"data/sessions/xxx/output/report.md"简化为"报告文件路径"）。
忽略：工具调用参数细节、重复搜索结果、中间推理。
格式：使用编号列表。`,
  },
  {
    name: "Leaf",
    maxTokens: Infinity,
    prompt: "", // No compression
  },
];
