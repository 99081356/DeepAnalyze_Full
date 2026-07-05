# 第6组：稳健性/异常恢复/边界条件（6项）

---

## T45: 上下文压缩关键信息保留

### 测试设计
**知识库**：bigtest
**提示词**：
> 请执行以下长时间分析任务（会触发多次context compaction）：
> 1. 搜索并阅读所有PDF论文的L0摘要（第1轮）
> 2. 阅读前5篇论文的L1内容（第2轮）
> 3. 阅读后5篇论文的L1内容（第3轮）
> 4. 阅读剩余论文的L1内容（第4轮）
> 5. 基于所有阅读内容生成综合技术演进报告（第5轮）
> 报告必须引用所有16篇论文的关键发现。

### 观察目标
1. **Compaction触发**：观察到多次context compaction事件（日志中可见）
2. **关键信息保留**：最终报告引用了所有16篇论文，不是只引用最近阅读的
3. **Identifier保留**：压缩后文档ID、文件名、URL等标识符未丢失
4. **文件re-injection**：压缩后最近访问的文件被自动重新注入（最多5个，25K token）
5. **Skill re-injection**：如果有skill被使用，压缩后skill内容被重新注入
6. **Transcript保存**：压缩前的消息被保存到transcript文件
7. **质量不降**：最终报告质量不受compaction影响

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 遗漏论文 | 改进压缩的关键信息保留策略（identifier audit） |
| 无compaction | 检查predictive compaction的触发阈值 |
| skill丢失 | 检查post-compact skill re-injection逻辑 |
| 无transcript | 检查transcript保存逻辑 |
| 后期质量差 | 调整压缩策略，从aggressive切到deterministic |

---

## T46: SSE断连恢复

### 测试设计
**知识库**：bigtest
**提示词**：
> 发送一个需要较长时间运行的分析请求。在Agent运行过程中（等待2-3个工具调用后），模拟网络断连（关闭浏览器标签页），等待10秒后重新打开页面。

### 观察目标
1. **重连成功**：重新打开后WebSocket自动重连
2. **内容恢复**：之前已显示的消息完整保留
3. **进度继续**：Agent仍在运行（未因断连而取消）
4. **实时更新恢复**：重连后新的工具调用和文本输出正常显示
5. **无重复消息**：断连前已显示的内容不会重复出现
6. **最终完成**：Agent正常完成，结果完整

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 重连失败 | 检查WebSocket重连逻辑和exponential backoff |
| 内容丢失 | 检查draft message持久化机制 |
| Agent取消 | 检查断连后的超时取消逻辑（是否太激进） |
| 消息重复 | 检查SSE事件去重逻辑 |
| 完成后不显示 | 检查最终保存和消息状态更新 |

---

## T47: 超大文件上传与多格式处理

### 测试设计
**知识库**：新建KB
**操作**：
> 1. 上传一个超大PDF文件（>100MB）
> 2. 上传一个超大Excel文件（>50MB）
> 3. 上传一组不同格式的中等文件（验证格式路由正确性）：RTF、ODT、PPT、YAML、SVG、MD、XLSM、GBK编码TXT
> 4. 观察处理过程和内存使用
> 5. 验证处理结果和格式路由

### 观察目标
1. **上传成功**：大文件上传不超时，不因大小限制被拒绝
2. **处理不OOM**：处理过程中Node.js内存不超过2GB
3. **Docling处理**：大PDF能被Docling成功解析（不因内存不足崩溃）
4. **表格处理**：大Excel由NativeTableProcessor处理（不走Docling避免OOM）
5. **进度显示**：处理进度正常更新，不卡在某个百分比
6. **L0质量**：超大文件的摘要有意义（不是截断或空文本）
7. **可搜索**：处理完成后能通过kb_search搜到内容
8. **格式路由正确**（C-236）：
   - RTF/ODT：走 doc_legacy 策略，先 LibreOffice 转 DOCX 再 Docling 解析
   - PPT：走 doc_legacy 策略，先 LibreOffice Impress 转 PPTX 再解析
   - YAML/SVG：走 txt 策略，TextProcessor 处理（非图片策略）
   - MD：走 Docling 结构化解析（非纯文本）
   - XLSM：走 spreadsheet 策略，NativeTableProcessor 处理
   - GBK TXT：TextProcessor 自动检测编码并正确解码

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 上传超时 | 增大HTTP body size limit和upload timeout |
| OOM | 改进processor的流式处理或分块处理 |
| Docling崩溃 | 添加内存监控和graceful fallback |
| 表格OOM | 确认NativeTableProcessor的元数据描述策略（不加载全部数据） |

---

## T48: 并发会话隔离

### 测试设计
**操作**：
> 1. 打开浏览器Tab A和Tab B
> 2. Tab A创建session A，绑定bigtest知识库，发送分析请求
> 3. Tab B创建session B，绑定lbctest知识库，发送不同的分析请求
> 4. 两个请求并行运行
> 5. 验证两个session的结果互不干扰

### 观察目标
1. **并行执行**：两个session的Agent同时运行
2. **知识库隔离**：session A只搜索bigtest，session B只搜索lbctest
3. **消息隔离**：Tab A只显示session A的消息，Tab B只显示session B的消息
4. **结果正确**：session A的分析关于bigtest内容，session B关于lbctest内容
5. **无交叉污染**：一个session的错误不影响另一个session
6. **并发限制**：全局并发上限 MAX_CONCURRENT_AGENT_RUNS=8，单 session 并发上限 MAX_CONCURRENT_PER_SESSION=3（C-227/C-228），两个session的Agent同时运行不超限
7. **按任务并行**：工作流模式下子 Agent 各自占用独立并发槽位，主任务完成后后台工作流仍可继续（不受主任务 SSE 关闭影响）
8. **性能公平**：两个session的响应速度不因并行而严重下降

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 消息串流 | 检查SSE事件的sessionId过滤和前端处理 |
| KB混淆 | 检查session scope的KB绑定和搜索参数传递 |
| 一个卡住另一个 | 检查agent run的并发控制和资源分配 |
| 性能严重下降 | 优化processing queue的并发策略 |
| 并发超限 | 检查 MAX_CONCURRENT_AGENT_RUNS(8) 和 MAX_CONCURRENT_PER_SESSION(3) 的计数逻辑 |
| 后台工作流被打断 | 检查主任务完成后 workflow 监听器是否保留（延迟卸载机制） |

---

## T49: 错误边界与异常恢复

### 测试设计
**操作**（组合场景）：
> 1. 发送一个故意包含prompt injection的内容（测试安全防护）
> 2. 配置一个无效的模型provider（错误API key），验证错误处理
> 3. 在Agent运行中发送新消息（测试队列处理）
> 4. 上传一个损坏的文件（如将.txt重命名为.pdf），验证处理鲁棒性
> 5. 上传一组编码边界文件（验证 TextProcessor 编码检测链）：
>    - UTF-8 with BOM 文件
>    - GBK 编码的中文 TXT
>    - Big5 编码的繁体中文 TXT
>    - Latin-1 编码的西欧文本
>    - 混合编码（UTF-8主体+GBK片段）的文件
> 6. 模拟 MiniMax 连接超时（临时阻断网络），验证可重试错误自动恢复（C-237）

### 观察目标
1. **Injection防护**：prompt injection内容被检测并警告（不执行恶意指令）
2. **模型错误**：错误API key不导致崩溃，显示清晰的错误提示
3. **并发消息**：运行中发送新消息有合理处理（排队或拒绝，不崩溃）
4. **损坏文件**：处理失败后标记为error（不是卡在processing），可重新上传
5. **错误恢复**：所有错误场景后，系统恢复正常，新请求能正常处理
6. **日志可追溯**：所有错误在服务端日志中有记录
7. **编码检测链**（C-234）：
   - UTF-8 BOM 文件：识别 BOM 并去除，正确解析为 UTF-8
   - GBK 文件：ASCII 验证失败 → UTF-8 验证失败 → GBK 验证成功，输出正确中文
   - Big5 文件：GBK 验证失败 → Big5 验证成功，输出正确繁体中文
   - Latin-1 文件：所有编码失败 → Latin-1 兜底，有 lossy 标记但不崩溃
   - 编码检测不产生 mojibake（如 "ææœº" 乱码）
8. **连接超时重试**（C-237）：
   - MiniMax API 连接超时/中断时，非流式和流式路径均触发 isRetryable
   - 重试后请求成功完成，用户无感知
   - 不会因单次超时就向用户报错

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| Injection未防护 | 检查prompt-injection.ts的正则和外部内容边界标记 |
| 崩溃 | 添加全局error boundary和unhandled rejection handler |
| 文件卡住 | 添加processing timeout和failure标记 |
| 不恢复 | 检查错误后的状态重置（circuit breaker, session state） |
| 编码检测失败 | 检查 TextProcessor 的编码检测链顺序（BOM→ASCII→UTF-8→GBK→Big5→Latin-1） |
| GBK/Big5乱码 | 检查 iconv-lite 解码验证逻辑，确认 isValidEncoding 返回正确 |
| 超时不可重试 | 检查 openai-compatible.ts 非流式 completion 的 isRetryable 是否含 "aborted"/"timeout"（C-237） |
| 重试后仍失败 | 检查重试次数和退避策略，确认 maxRetries 设置合理 |

---

## T50: 端到端全链路压力测试

### 测试设计
**知识库**：bigtest + lbctest（双库绑定）
**提示词**：
> 请执行以下综合任务，覆盖系统所有核心功能：
> 1. 浏览两个知识库的完整文档列表
> 2. 搜索两个库中与"法律"相关的内容
> 3. 对bigtest中的剧本杀使用workflow_run并行分析（每个剧本杀一个子Agent）
> 4. 对lbctest使用evidence-chain skill分析证据链
> 5. 生成一份跨库的对比分析报告（push_content）
> 6. 将报告写入文件（write_file）
> 7. 创建一个定时任务（cron_create）每天检查知识库更新
> 8. 列出所有可用的skills（list_skills）
> 9. 搜索网络获取最新的法律科技资讯（web_search）
> 10. 最终输出完整的分析摘要

### 观察目标
1. **全工具覆盖**：观察到以下工具调用：wiki_browse, kb_search, expand, workflow_run, skill_invoke, push_content, write_file, cron_create, list_skills, web_search
2. **多模式运行**：主Agent工具调用 + 子Agent并行 + Skill调用 + 网络搜索
3. **总步骤数**：50+次工具调用
4. **context管理**：经历多次压缩后仍保持关键信息
5. **结果完整**：10个子任务都有对应输出
6. **前端显示**：工具卡片、push_content卡片、SubAgentPanel、thinking indicator全部正常
7. **系统不崩溃**：全程无500错误、无OOM、无无响应
8. **耗时合理**：总耗时在合理范围内（不超过60分钟）
9. **无幻觉**：跨库分析不混淆数据来源
10. **定时任务创建**：cron_create成功，在Cron Manager中可见

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 工具未覆盖 | 检查工具注册和deferred tool加载 |
| 压缩丢信息 | 改进压缩策略和identifier audit |
| OOM | 添加内存监控和任务粒度控制 |
| 前端卡顿 | 添加虚拟滚动和防抖渲染 |
| 中途停止 | 检查dynamic turn budget和stuck detection |
| 幻觉 | 加强anti-hallucination prompt和事后验证 |

---

# 补充测试：连接超时自动重试与 Session Memory 容错

> 覆盖 C-237（连接超时可重试）和 C-238（Session Memory JSON 容错）的专项验证。

---

## T50a: MiniMax 连接超时自动重试（C-237）

### 测试设计
**知识库**：无（通用对话模式）
**前置条件**：使用 MiniMax 作为主模型
**操作**：
1. 发送一个正常对话请求，确认 MiniMax 连接正常
2. 临时阻断 MiniMax API 连接（如 iptables 阻断 / 修改 API host 为不可达地址）
3. 发送对话请求，观察后端日志中的重试行为
4. 恢复 MiniMax 连接
5. 再次发送请求，验证恢复正常

### 观察目标
1. **流式路径重试**：streamCompletion 方法中，连接超时/中断触发 isRetryable（含 "timeout"/"ECONNREFUSED"/"ECONNRESET"/"aborted" 模式）
2. **非流式路径重试**（C-237 关键修复）：completion 方法中，同样的错误也触发 isRetryable（之前非流式路径缺少 "aborted" 模式）
3. **重试退避**：重试之间有合理退避（指数退避），不立即重试
4. **最大重试次数**：达到 maxRetries 后才向用户报错
5. **恢复后正常**：连接恢复后，下一次请求正常完成
6. **用户感知**：短暂超时期间用户看到的是"思考中"指示器，而非错误提示

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 非流式不重试 | 检查 openai-compatible.ts completion 方法的 isRetryable 正则含 "aborted"/"timeout" |
| 重试无退避 | 检查 retryWithBackoff 的 delay 计算（应有 Math.min(delay * 2, maxDelay)） |
| 无限重试 | 检查 maxRetries 上限设置（默认应为 3-5 次） |
| 恢复后仍失败 | 检查 Circuit Breaker 是否误打开（half-open 探测是否生效） |

---

## T50b: Session Memory JSON 容错（C-238）

### 测试设计
**知识库**：无
**操作**：
1. 手动在数据库中插入一条 session 记录，其 memory 字段为无效 JSON（如 `"{invalid json}"`）
2. 通过该 session 发送消息，验证系统不崩溃
3. 检查后端日志中的容错处理

### 观察目标
1. **不崩溃**：session memory JSON 解析失败时，系统不抛出未捕获异常
2. **优雅降级**：解析失败时使用空对象作为默认值，Agent 正常运行
3. **日志记录**：后端日志记录 JSON 解析失败的 warning（非 error）
4. **功能正常**：Agent 能正常对话，memory 功能（如有）降级但不阻断主流程
5. **后续修复**：下一次 session memory 写入时，正确的 JSON 覆盖损坏的数据

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| JSON 解析崩溃 | 检查 session memory 读取路径是否有 try-catch 包裹 JSON.parse |
| 无降级 | 检查 catch 块是否返回默认值 {} 而非 rethrow |
| 无日志 | 添加 console.warn 记录解析失败，便于排查 |
| 无法恢复 | 检查 memory 写入路径是否覆盖旧值（非 append 到损坏 JSON） |

---

## 附录：测试执行优先级

| 优先级 | 测试项 | 理由 |
|--------|--------|------|
| P0（必做） | T01, T02, T03, T11, T24, T29, T50 | 核心功能+已知问题区域 |
| P1（重要） | T06, T10, T15, T17, T19, T22, T38, T41, T45, T48 | 质量+稳定性+前端 |
| P2（补充） | T04, T05, T07, T08, T12-T14, T18, T20, T23, T25-T28, T30-T37, T39-T40, T42-T44, T46-T47, T49 | 完整覆盖 |

## 附录：自动化评估方法

| 评估项 | 方法 | 工具 |
|--------|------|------|
| 字数统计 | 前端JS统计push_content和文本消息的总字数 | Playwright page.evaluate |
| 幻觉检测 | 抽取报告中的关键事实（人名/金额/日期），用expand/doc_grep验证 | Playwright + API |
| 结构完整性 | 检查push_content卡片数量、标题层级 | Playwright DOM查询 |
| 工具调用记录 | 从消息metadata中提取toolCalls，统计次数和类型 | API / DB查询 |
| 前端渲染检查 | 截图对比、DOM状态断言 | Playwright screenshot + toBeVisible |
| 性能指标 | 记录首token时间、总耗时、context压缩次数 | 服务端日志 |
| 一致性对比 | 多次执行结果的关键事实对比 | 自定义对比脚本 |
