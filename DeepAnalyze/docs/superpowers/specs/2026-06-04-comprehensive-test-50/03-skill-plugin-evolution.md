# 第3组：Skill/Plugin系统与自动化进化（8项）

---

## T21: 内置Skill自动激活与执行

### 测试设计
**知识库**：bigtest
**提示词**：
> 请对知识库进行全面的知识库分析，生成分析报告。

### 观察目标
1. **Skill自动识别**：Agent识别出"全面知识库分析"场景，主动调用`全面知识库分析` skill
2. **skill_invoke调用**：观察到 `skill_invoke(skill_name="全面知识库分析")` 工具调用
3. **Skill执行模式**：使用正确的invocation mode（inline/fork/sub_agent）
4. **Skill内容注入**：Skill的prompt被注入到Agent上下文中，引导分析行为
5. **输出符合Skill引导**：分析报告的结构和深度符合skill的指导（多级阅读、并行子Agent等）
6. **工具使用符合Skill**：Agent使用的工具在skill允许的工具列表内

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 未识别场景 | 检查skill triggers关键词匹配和agent prompt中的skill引导 |
| 未调用skill | 改进skill推荐机制，增加可用skill的系统提示 |
| 执行模式错误 | 检查skill_invoke的mode默认值和选择逻辑 |
| 输出偏离skill | 检查skill prompt注入位置和优先级 |

---

## T22: Skill创建→验证→调用全链路

### 测试设计
**知识库**：无（通用模式）
**提示词**（多轮对话）：
> 第1轮：请帮我创建一个新skill，名字叫"市场分析助手"，用途是分析市场数据和竞争格局。要求：1）先搜索相关市场数据 2）制作竞争对比表格 3）输出SWOT分析。保存到数据库。
> 第2轮：验证刚才创建的skill，用list_skills查看是否在列表中。
> 第3轮：请用这个skill分析中国新能源汽车市场现状。

### 观察目标
1. **skill_create成功**：工具调用 `skill_create` 成功返回创建确认
2. **数据库持久化**：`list_skills` 返回的结果中包含"市场分析助手"
3. **Skill质量**：创建的skill内容完整（name/description/prompt/tools）
4. **skill_invoke成功**：第三轮成功调用新创建的skill
5. **Skill执行效果**：执行结果符合skill定义的分析流程（搜索→表格→SWOT）
6. **前端可见**：设置页面的Skill Browser中能看到新创建的skill

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 创建失败 | 检查skill_create工具的schema验证和DB写入 |
| 不持久 | 检查skill_create的save_path=db逻辑 |
| 调用失败 | 检查新skill的注册到可用的延迟和缓存刷新 |
| 前端不显示 | 检查Skill Browser的数据刷新机制 |

---

## T23: Skill修改→效果对比

### 测试设计
**知识库**：bigtest
**提示词**（多轮对话）：
> 第1轮：使用"报告生成"skill对知识库中的论文生成分析报告。
> 第2轮：修改"报告生成"skill，添加要求"每个分析点必须有数据支撑，禁止无数据的主观判断"。
> 第3轮：再次使用修改后的"报告生成"skill生成分析报告。
> 第4轮：对比两次报告，分析修改效果。

### 观察目标
1. **skill_update成功**：工具调用成功更新skill内容
2. **版本记录**：skill_versions表记录了变更历史
3. **效果可观测**：修改后的报告确实更加数据驱动，减少主观判断
4. **版本对比**：可通过API查看skill的修改前版本
5. **修改即时生效**：修改后的skill在下次调用时使用新prompt

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 更新失败 | 检查skill_update的schema和DB更新逻辑 |
| 不生效 | 检查skill缓存机制，确保更新后清除缓存 |
| 无版本记录 | 检查skill-version repo的触发逻辑 |
| 效果不可对比 | 添加skill执行结果的自动对比功能 |

---

## T24: 司法Plugin——证据链Skill完整执行

### 测试设计
**知识库**：lbctest
**提示词**：
> 请使用"evidence-chain" skill分析这个案件的证据链完整性。要求：
> 1. 搜集所有证据材料
> 2. 构建证据链关系图（时序关系、因果关系、印证关系、矛盾关系）
> 3. 评估证据链完整性（标记缺失环节为[待补充]，矛盾点为[矛盾]）
> 4. 生成带有原始文档引用链接的证据链报告

### 观察目标
1. **skill_invoke触发**：明确调用 `skill_invoke(skill_name="evidence-chain")`
2. **5步工作流**：完整执行 skill 定义的5步流程（搜索→展开→构建→分析→报告）
3. **证据覆盖**：所有证据文档都被纳入分析
4. **关系类型完整**：证据间关系包含时序/因果/印证/矛盾四种类型
5. **完整性标注**：缺失环节标注[待补充]，矛盾点标注[矛盾]
6. **原始引用**：每条证据有`da-evidence://`链接，点击可跳转到原文
7. **前端渲染**：证据链接在消息中显示为蓝色可点击链接
8. **无幻觉**：所有证据描述与原文一致，不编造证据

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| Skill未调用 | 检查judicial-analysis plugin是否正确加载 |
| 步骤不完整 | 检查skill prompt注入后Agent是否遵循步骤 |
| 引用链接无效 | 检查da-evidence://协议的前端解析和后端路由 |
| 前端不渲染链接 | 检查EntityLink/TraceabilityLink组件 |

---

## T25: 司法Plugin——时间线重建+实体网络

### 测试设计
**知识库**：lbctest
**提示词**：
> 请分别使用"timeline-reconstruction"和"entity-network"两个skill分析案件。先用时间线重建skill构建完整案件时间线，再用实体网络skill梳理所有人物关系和组织关系。最后综合两个skill的结果输出案件全景分析。

### 观察目标
1. **两个skill顺序调用**：先调用timeline-reconstruction，再调用entity-network
2. **时间线完整**：覆盖案件全过程，每个节点有文档证据
3. **实体网络**：所有人物、机构、地点的关联关系清晰
4. **综合质量**：综合分析利用了两个skill的结果，不是简单拼接
5. **工具使用**：观察到timeline_build和graph_build工具的调用
6. **可视化**：时间线和实体网络在前端有可视化展示

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| Skill不调用 | 检查skill的trigger关键词和推荐逻辑 |
| 工具未使用 | 检查timeline_build/graph_build工具是否正确注册 |
| 无可视化 | 检查KnowledgeGraph组件和Timeline组件 |

---

## T26: Skill Hub搜索+安装+执行

### 测试设计
**知识库**：无
**提示词**：
> 请在Skill Hub中搜索与"数据分析"相关的skill，选择最合适的一个安装，然后使用它分析一组虚构的电商销售数据。

### 观察目标
1. **skill_hub_search调用**：搜索skill hub，返回结果列表
2. **搜索结果质量**：返回的skill与"数据分析"相关
3. **skill_hub_install调用**：选择并安装一个skill
4. **安装持久化**：安装后list_skills包含新skill
5. **skill执行**：成功调用新安装的skill执行分析任务
6. **来源标记**：新skill的source标记为"hub"
7. **前端显示**：Skill Browser中显示hub来源的skill，带安装来源标记

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| Hub不可达 | 检查ClawHub API连通性和fallback（HTML scraping） |
| 安装失败 | 检查hub skill的SKILL.md解析和DB写入 |
| 来源不标记 | 检查install时source='hub'的设置 |

---

## T27: 自动化进化——skill自我优化效果可观测

### 测试设计
**知识库**：bigtest
**前置条件**：在设置面板开启Self-Evolution（persistentMemory + skillEvolution + memoryAccumulation）
**提示词**（分3个session执行）：
> Session 1：请分析知识库中所有PDF论文的技术演进关系。
> Session 2：请对同样的论文进行技术演进分析，这次要求更详细。
> Session 3：请再次分析论文技术演进，对比前两次，观察是否有优化。

### 观察目标
1. **Evolution配置生效**：开启后session_memory开始记录
2. **经验积累**：session 1完成后，memory中有分析经验记录
3. **经验注入**：session 2开始时，系统提示词中注入了session 1的经验
4. **行为改进**：session 2的分析效率或质量比session 1有可观测的提升（如工具调用更有针对性）
5. **Skill进化**：如果触发了skillEvolution，能看到skill被patch
6. **进化记录**：skill_usage和skill_versions表有记录
7. **效果可量化**：能通过use_count/patch_count/state等指标量化进化效果

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 配置不生效 | 检查evolution-config的DB读写和agent prompt注入 |
| 无经验记录 | 检查memoryAccumulation的后台触发条件 |
| 无注入 | 检查persistentMemory在系统提示词中的注入位置 |
| 进化不触发 | 检查nudgeInterval和curator调度 |

---

## T28: Plugin启用/禁用/卸载影响

### 测试设计
**知识库**：lbctest
**提示词**（多轮操作）：
> 1. 先使用evidence-chain skill分析案件（judicial-analysis plugin启用状态）
> 2. 在设置面板禁用judicial-analysis plugin
> 3. 再次尝试使用evidence-chain skill
> 4. 重新启用plugin
> 5. 再次使用evidence-chain skill

### 观察目标
1. **启用状态正常**：第1步evidence-chain skill正常工作
2. **禁用生效**：禁用后，skill不再出现在list_skills中
3. **调用失败处理**：第3步调用失败时，Agent优雅降级（不用skill也能继续分析）
4. **重新启用恢复**：第5步skill恢复正常工作
5. **工具移除**：禁用plugin后，plugin提供的自定义工具也被移除
6. **前端同步**：Plugin Manager面板实时反映plugin状态

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 禁用不生效 | 检查plugin enabled状态的读取时机 |
| 工具残留 | 检查plugin disable时的ToolRegistry清理 |
| 崩溃/异常 | 添加skill_invoke失败时的graceful degradation |
| 前端不同步 | 检查Plugin Manager的状态轮询机制 |
