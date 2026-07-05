// =============================================================================
// DeepAnalyze - Enhanced Tool Descriptions
// =============================================================================
// Single source of truth for tool descriptions sent to the LLM.
// Each description includes: summary, key features, suitable/unsuitable usage.
//
// Design principles:
// - This file IS the complete description — nothing is lost from tool-setup.ts originals
// - tool-guidance.ts handles cross-tool decision trees (not individual tool descriptions)
// - tool-setup.ts originals are one-line placeholders (overridden by this file)
// =============================================================================

/**
 * Returns enhanced description for a given tool name.
 * Falls back to the original description if no enhanced version exists.
 */
export function getEnhancedDescription(toolName: string, originalDescription: string): string {
  const enhanced = ENHANCED_DESCRIPTIONS[toolName];
  return enhanced ?? originalDescription;
}

const ENHANCED_DESCRIPTIONS: Record<string, string> = {
  // ---------------------------------------------------------------------------
  // Core tools
  // ---------------------------------------------------------------------------

  think:
    "逐步推理工具。在复杂推理、分析决策、策略规划时使用。" +
    "\n\n• 将复杂问题分解为逐步推理链" +
    "\n• 在搜索前规划策略，在搜索后综合分析" +
    "\n• 当不确定下一步该做什么时，用它整理思路" +
    "\n\n不要用于：简单问题（直接回答即可）、反复调用不执行其他工具（避免纯思考循环）",

  finish:
    "完成任务并提交最终结果。当你认为已经充分回答了用户的问题时调用此工具。" +
    "\n\n• summary 参数应包含简洁的最终答案" +
    "\n• 如果问题是要求具体数值/名称，summary 只包含该值" +
    "\n• 不要在 summary 中包含推理过程" +
    "\n\n不要用于：任务还有未完成的工作时、搜索策略尚未穷尽时",

  // ---------------------------------------------------------------------------
  // Knowledge base tools
  // ---------------------------------------------------------------------------

  kb_search:
    "语义搜索知识库文档。返回按相关性排序的匹配页面列表（默认最多8-10条）。" +
    "\n\n• 底层使用向量相似度 + BM25 全文搜索" +
    "\n• 默认排除报告类页面" +
    "\n• 支持按页面类型过滤（abstract, overview, fulltext, structure_md 等）" +
    "\n\n适合：快速定位特定主题的文档、补充性语义查询" +
    "\n不适合：获取完整文档列表（用 wiki_browse listDocuments=true）、精确文本匹配（用 doc_grep）、阅读完整内容（用 expand）" +
    "\n\n使用建议：用多个不同关键词查询以提高召回率",

  wiki_browse:
    "浏览知识库中的文档和 Wiki 页面。" +
    "\n\n模式：" +
    "\n• listDocuments=true + kbId：返回该知识库所有文档的分类列表，含 docId、fileName、filePath、L0 摘要。如果存在预处理数据，返回中会包含 preprocessingData 字段（含还原的表格、概览、审计报告等文件列表）" +
    "\n• pageId：返回特定页面的完整内容（id, docId, pageType, title, tokenCount, content）" +
    "\n• kbId（可选 pageType）：列出该知识库所有页面" +
    "\n\n返回的 filePath 字段指向 original/ 目录中的原始上传文件（保留原始格式和完整数据精度），wikiPath 字段指向 wiki/ 中的处理后 Markdown 文件。对于 CSV/JSON 等结构化数据文件，原始文件包含完整且精确的数据；处理后的 Markdown 版本可能被截断或丢失格式细节" +
    "\n\n适合：了解知识库全貌、获取文档元数据（docId、filePath 映射）、查看页面结构、定位原始数据文件" +
    "\n不适合：语义搜索（用 kb_search）、精确文本匹配（用 doc_grep）",

  expand:
    "逐层展开文档内容。获取文档已编译的结构化内容。" +
    "\n\n三层结构：" +
    "\n• L0（摘要层，~125 tokens）：文档主题、核心要点、标签。适合快速分类和路由" +
    "\n• L1（主要内容层）：绝大部分可分析的数据都在这一层。日常分析默认用 L1" +
    "\n• L2（原始数据层）：各类型的原始格式化数据" +
    "\n\n**各文件类型的数据分布**：" +
    "\n• PDF/DOCX：L1 为 Markdown 格式的章节分块；L2 为 Docling JSON（含坐标、锚点、页码）。两者内容相同但格式不同" +
    "\n• 图片（JPG/PNG）：L1 含 VLM 视觉描述和 OCR 文本（入库时预编译）。如 VLM 未配置则 L1 为空，需看 L2" +
    "\n• 音频（MP3）：L1 含按说话者分组的转写文本" +
    "\n• 视频（MP4）：L1 含按场景分割的描述和对话转写" +
    "\n• Excel：小表格（≤1000行）L1 有完整内容；**大表格（>1000行）L1 为空**，用 run_sql 聚合分析或 read_file 读原始 CSV" +
    "\n\n**与 read_file 的关系**：expand 从数据库查询已编译的结构化内容（L0/L1/L2），read_file 从磁盘读取原始文件（parsed.md）。同一文档的 expand L1 ≈ read_file parsed.md，内容通常相同，选其一即可，无需重复获取" +
    "\n\n批量模式：docIds 数组 + kbId 一次获取多个文档。单文档模式：docId + targetLevel。" +
    "\n\n适合：阅读文档详情、获取结构化内容" +
    "\n不适合：快速概览（用 wiki_browse）、搜索文档（用 kb_search）",

  doc_grep:
    "正则搜索知识库中 wiki 页面的实际内容文本。返回匹配的页面列表及上下文。" +
    "\n\n• 支持精确匹配人名、日期、编号、金额、特定短语等" +
    "\n• 与 kb_search（语义搜索）互补：kb_search 找近似结果，doc_grep 找精确匹配" +
    "\n• 搜索数据库中的 wiki 页面；grep 工具搜索磁盘原始文件，两者互为补充" +
    "\n\n适合：精确匹配人名/日期/编号/金额、kb_search 找不到时用精确搜索补充" +
    "\n不适合：语义搜索（用 kb_search）、浏览文档结构（用 wiki_browse）",

  // ---------------------------------------------------------------------------
  // File tools
  // ---------------------------------------------------------------------------

  read_file:
    "读取数据目录中的文件内容。以文本形式返回，支持 offset/limit 分段读取，无截断。" +
    "\n\n• 支持 offset 和 limit 参数分页读取大文件" +
    "\n• 支持文本文件、Markdown、CSV、JSON 等格式" +
    "\n• **与 expand 的关系**：expand 从数据库查询已编译的结构化内容（L0/L1/L2），read_file 从磁盘读取原始文件（parsed.md）。" +
    "同一文档的 expand L1 ≈ read_file parsed.md，内容通常相同，选其一即可，无需重复获取" +
    "\n• 数据目录外的文件请使用 bash 工具" +
    "\n\n适合：读取配置/日志/manifest.json 等非文档文件、分页读取大文件、精确验证某一行内容" +
    "\n不适合：搜索文件（用 grep 或 glob）、需要层级选择时（用 expand）",

  write_file:
    "创建或覆盖文件。将内容写入数据目录中的指定文件，自动创建中间目录。" +
    "\n\n• 对于大段输出内容，优先用 write_file 保存再告知用户" +
    "\n• 防止上下文窗口被填满，也方便其他 Agent 读取合并" +
    "\n\n适合：生成报告文件、保存分析结果、创建临时文件" +
    "\n不适合：修改文件中的特定部分（用 edit_file）",

  edit_file:
    "编辑数据目录中的文件。通过精确匹配 old_string 并替换为 new_string 来修改文件内容。" +
    "\n\n• old_string 必须与文件中的内容完全匹配（包括缩进）" +
    "\n• 多次匹配时需提供更多上下文或设置 replace_all=true" +
    "\n\n适合：修改文件中的特定部分、小范围编辑" +
    "\n不适合：创建新文件（用 write_file）、大范围重写（用 write_file）",

  glob:
    "在数据目录中按模式查找文件。返回匹配的文件路径列表（最多200条）。" +
    "\n\n• 支持 glob 模式，如 *.pdf、**/*.md 等" +
    "\n• 用于快速定位文件而非读取内容" +
    "\n\n适合：查找特定类型的文件、了解目录结构" +
    "\n不适合：搜索文件内容（用 grep）、搜索知识库（用 kb_search）",

  grep:
    "在数据目录的文件中搜索文本模式。返回匹配的行及文件路径和行号。" +
    "\n\n• 支持基本文本搜索和正则表达式" +
    "\n• 搜索磁盘上的原始文件（parsed.md、json、csv 等）" +
    "\n• 与 doc_grep 互补：doc_grep 搜索数据库 wiki 页面，grep 搜索磁盘原始文件。同一内容用其中一个搜索即可" +
    "\n\n适合：搜索磁盘原始文件中的特定内容、验证关键词在原文中的位置" +
    "\n不适合：搜索数据库中的已编译页面（用 doc_grep）、语义搜索（用 kb_search）",

  // ---------------------------------------------------------------------------
  // Data & SQL tools
  // ---------------------------------------------------------------------------

  run_sql:
    "执行 SQL 查询（只读 SELECT）并返回结果。直接查询 PostgreSQL 数据库。" +
    "\n\n完整 SQL 能力：SELECT、JOIN、GROUP BY、HAVING、ORDER BY、LIMIT、子查询、CTE(WITH)、窗口函数、聚合函数、UNION、DISTINCT、CASE WHEN、类型转换、正则匹配等" +
    "\n\n核心表：" +
    "\n• documents: id, filename, file_path, file_type, file_size, kb_id, status, abstract, folder_path, created_at" +
    "\n• wiki_pages: id, kb_id, doc_id, page_type, title, content, token_count, file_path, metadata" +
    "\n\n发现更多表：SELECT table_name FROM information_schema.tables WHERE table_schema='public'" +
    "\n查看列定义：SELECT column_name, data_type FROM information_schema.columns WHERE table_name='documents'" +
    "\n\n适合：文档统计聚合、按文件类型/目录/状态分类、精确元数据查询、全量列表" +
    "\n不适合：语义搜索（用 kb_search）、修改数据（只读）" +
    "\n\n示例：SELECT file_type, count(*) FROM documents WHERE kb_id='...' GROUP BY file_type",

  // ---------------------------------------------------------------------------
  // Shell tool
  // ---------------------------------------------------------------------------

  bash:
    "执行 Shell 命令并返回输出。工作目录为项目数据目录，超时30秒。" +
    "\n\n• `grep -rl '关键词' wiki/` 可一次搜索全部文档内容" +
    "\n• `cat wiki/{kbId}/documents/{docId}/parsed.md` 可直接读取文档" +
    "\n• `cat original/{kbId}/filename.json` 可直接读取原始上传的结构化数据文件（完整精度，无截断）" +
    "\n• `python3` 可编程处理任意数据（pandas 处理 CSV/Excel、json.loads 处理 JSON、统计分析等）" +
    "\n• `find`/`ls`/`wc`/`sort`/`awk` 等全部 shell 工具可用" +
    "\n• 先用 `cat wiki/{kbId}/manifest.json` 查看文档名到路径的映射" +
    "\n• 涉及数学计算时：运行 python3 进行精确计算，不要心算" +
    "\n• 代码出错时先分析错误信息，不要盲目修改重试" +
    "\n• 对计算结果做常识性检查" +
    "\n\n适合：批量搜索文件内容、编程处理数据、执行计算脚本、系统命令" +
    "\n不适合：需要结构化分层输出时（用 expand）",

  // ---------------------------------------------------------------------------
  // Web tools
  // ---------------------------------------------------------------------------

  web_search:
    "搜索网络获取信息。返回包含标题、URL 和摘要的搜索结果。" +
    "\n\n• 每次搜索前先用 think 工具构思最优查询词" +
    "\n• 连续 2-3 次搜索无有用结果时切换到其他方法" +
    "\n• 搜索到有用链接后，应立即用 web_fetch 获取详细内容" +
    "\n• 对于 PDF 链接，使用 pdf_read 获取内容" +
    "\n• 对于 YouTube 视频，使用 youtube_transcript 获取转写" +
    "\n\n适合：查找知识库中没有的最新信息、补充外部背景" +
    "\n不适合：搜索本地知识库（用 kb_search）",

  web_fetch:
    "获取指定 URL 的网页内容。轻量级 HTTP 请求，返回页面文本。" +
    "\n\n• 适合获取 web_search 返回的有用链接的完整内容" +
    "\n• 支持 HTML 页面、JSON API、纯文本等" +
    "\n\n适合：获取网页详情、读取 API 响应" +
    "\n不适合：搜索信息（用 web_search）、交互式网页操作（用 browser）",

  // ---------------------------------------------------------------------------
  // Academic search
  // ---------------------------------------------------------------------------

  scholar_search:
    "搜索学术论文（Semantic Scholar API）。查找论文、作者、引用关系。" +
    "\n\n• action=search：按关键词搜索论文" +
    "\n• action=search_author：按作者名搜索" +
    "\n• action=get_details：获取论文详情（含引用和参考文献）" +
    "\n\n适合：查找学术论文、获取引用数据、论文综述" +
    "\n不适合：一般网络搜索（用 web_search）",

  // ---------------------------------------------------------------------------
  // Media input tools
  // ---------------------------------------------------------------------------

  pdf_read:
    "从 URL 读取 PDF 文件并提取文本内容。使用 Docling（支持 OCR、表格提取、版面分析）。" +
    "\n\n• 支持直接 URL 和 arXiv 链接（自动规范化）" +
    "\n• pdf-parse 作为降级后备" +
    "\n\n适合：读取网络上的 PDF 文件" +
    "\n不适合：知识库中已有的 PDF（用 expand）",

  wikipedia:
    "搜索和获取 Wikipedia 百科条目内容。支持中英文。" +
    "\n\n适合：补充背景知识、验证事实、获取通用百科信息" +
    "\n不适合：搜索知识库（用 kb_search）",

  youtube_transcript:
    "获取 YouTube 视频的字幕/转写文本。支持多语言。" +
    "\n\n适合：需要分析 YouTube 视频内容时" +
    "\n不适合：非 YouTube 视频",

  // ---------------------------------------------------------------------------
  // Timeline & graph tools
  // ---------------------------------------------------------------------------

  timeline_build:
    "从文档内容中提取时间线事件。按时间顺序整理关键事件和日期。" +
    "\n\n适合：需要时间维度的分析、事件序列梳理" +
    "\n不适合：一般内容搜索（用 kb_search）",

  graph_build:
    "从 Wiki 页面和链接中构建实体关系图。提取实体及其关系。" +
    "\n\n适合：需要关系维度的分析、知识图谱构建" +
    "\n不适合：一般内容搜索（用 kb_search）",

  push_content:
    "将结构化内容卡片推送到用户界面。支持推送任意长度的内容。" +
    "\n\n**推送方式（重要）**：" +
    "\n- **推送文件**：使用 filePath 参数指定文件路径，工具会直接读取并推送完整内容。这是推送长内容（报告、小说、分析文档等）的唯一正确方式。" +
    "\n- **推送短数据**：只有当内容较短（<2000字）且不是文件时，才用 data 参数直接传入。" +
    "\n- **禁止用 data 参数传入长内容**：你的输出 token 有限，无法在一次调用中传入大量文字。对于文件内容，始终用 filePath。" +
    "\n\n**使用场景**：" +
    "\n① 将已写入文件的完整内容推送给用户（filePath，最常见）" +
    "\n② 短表格数据（type=table，CSV/TSV 格式，<2000字）" +
    "\n③ 短代码片段或格式化内容（<2000字）" +
    "\n\n**示例**：push_content(type=\"markdown\", title=\"完整报告\", filePath=\"tmp/analysis_report.md\")" +
    "\n\n**注意**：不要用此工具推送普通分析文本——你的文字输出会自动流式显示给用户。此工具专用于推送需要结构化展示的大文件内容。" +
    "\n\n**适用范围**：此工具适合推送有实质深度的结构化内容。简短文本直接在对话中输出效果更佳。",

  // ---------------------------------------------------------------------------
  // Task management tools
  // ---------------------------------------------------------------------------

  agent_todo:
    "任务清单管理工具。用于规划和跟踪复杂任务的执行进度。" +
    "\n\n• action=create：创建任务（单条或批量 todos 数组）" +
    "\n• action=update：更新任务状态（pending/in_progress/completed）" +
    "\n• action=list：查看当前清单" +
    "\n\n建议：涉及 3 个以上子步骤的任务都应先创建清单",

  // ---------------------------------------------------------------------------
  // Interaction tools
  // ---------------------------------------------------------------------------

  ask_user:
    "向用户提出问题并等待回答。调用后暂停当前任务，等用户回复后继续。" +
    "\n\n• 用于任务范围确认、歧义消除、分析方向选择等场景" +
    "\n• 可提供预设选项（最多4个）供用户选择",

  send_message:
    "在工作流中向其他 Agent 发送消息。" +
    "\n\n• 支持定向发送（指定目标 Agent ID）和广播（target='all'）" +
    "\n• 仅在使用 workflow_run 的 graph 或 parallel 模式时可用",

  task_output:
    "获取后台任务的结果。查询任何已知任务 ID 的状态和输出。",

  // ---------------------------------------------------------------------------
  // Skill & discovery tools
  // ---------------------------------------------------------------------------

  skill_invoke:
    "调用已注册的自定义技能（Skill）。技能是针对特定场景优化的预定义工作流。" +
    "\n\n• 先用 list_skills 查看可用技能列表" +
    "\n• 技能会自动处理分块、并行、合成等复杂流程" +
    "\n• 🔴标记的高成本技能（如知识库预处理）需要用户明确要求才能调用" +
    "\n\n适合：有对应技能的场景（如深度研究、特定领域分析）" +
    "\n不适合：通用任务（直接使用工具即可）、用户未明确要求的高成本操作",

  list_skills:
    "列出所有可用的自定义技能。返回技能名称、描述和状态。",

  tool_discover:
    "搜索和发现可用工具。" +
    "\n\n• 当你需要某个能力但当前工具列表中没有时使用" +
    "\n• 支持关键词搜索或直接选择（格式：select:tool_name）" +
    "\n• 某些工具默认不加载以节省 token，需通过此工具激活",

  // ---------------------------------------------------------------------------
  // Multimedia tools
  // ---------------------------------------------------------------------------

  tts_generate:
    "从文本生成语音音频。支持中文和英文。返回音频文件路径。",

  image_generate:
    "根据文本描述生成图片。返回图片文件路径。",

  video_generate:
    "根据文本提示生成视频（可能需要几分钟）。返回视频文件 URL 或路径。",

  music_generate:
    "根据文本提示生成音乐。返回音频文件路径。",

  // ---------------------------------------------------------------------------
  // Browser tool
  // ---------------------------------------------------------------------------

  browser:
    "无头浏览器工具（Playwright）。导航、截图、提取文本、点击、表单填写。" +
    "\n\n适合：需要 JavaScript 渲染的网页、SPA 页面、页面交互、截图" +
    "\n不适合：简单的 HTTP 请求（用 web_fetch）",

  // ---------------------------------------------------------------------------
  // Notebook tool
  // ---------------------------------------------------------------------------

  notebook_read:
    "读取 Jupyter Notebook (.ipynb) 文件。返回所有单元格及其输出。",
};

/**
 * Get all enhanced description keys (tool names).
 */
export function getEnhancedToolNames(): string[] {
  return Object.keys(ENHANCED_DESCRIPTIONS);
}
