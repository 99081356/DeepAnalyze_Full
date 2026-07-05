# DeepAnalyze Agent 系统综合测试计划

## 测试目标

验证42项优化原则的所有已实现功能，覆盖L1-L6全部6个层级，从单元测试到系统集成测试，最终模拟人类使用进行端到端验证。

## 测试范围

### Tier 1: 单元测试（代码级验证）

#### L1 工具层
| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| UT-L1-01 | T1.1 工具描述完整性 | 读取所有工具描述，验证包含usage/when-not-to-use | 每个工具有详细描述 |
| UT-L1-02 | T1.2 结果自适应裁剪 | 模拟不同contextFullnessRatio，验证裁剪策略 | 80%→60%, 95%→25% |
| UT-L1-03 | T1.3 输入验证(语义) | 传入空query、过多docIds、非SELECT SQL | validateSemantics返回错误 |
| UT-L1-04 | T1.4 工具调用元数据 | 执行工具后检查_meta字段 | 包含resultCount/rows/timing |
| UT-L1-05 | T1.5 并发安全三级 | 验证safe/concurrent/exclusive分区逻辑 | destructive工具独占执行 |
| UT-L1-06 | T1.6 延迟加载 | 验证DEFERRED_TOOLS列表和shouldDefer | 低频工具不加载 |
| UT-L1-07 | T1.7 工具链短路(如有) | kb_search返回0结果时的建议 | 模型收到替代建议 |

#### L2 Harness/提示词层
| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| UT-L2-01 | H2.1 静态/动态分层 | 验证SystemPromptBuilder输出含BOUNDARY标记 | static/dynamic正确分隔 |
| UT-L2-02 | H2.2 工具指南决策树 | 验证getToolGuidanceSection()包含所有决策路径 | 9步决策树完整 |
| UT-L2-03 | H2.3 反幻觉三级 | 验证basic/standard/strict三档内容差异 | strict包含所有basic规则 |
| UT-L2-04 | H2.4 思考标签引导 | 验证agent prompt含think使用要求 | 对比/反思引导存在 |
| UT-L2-05 | H2.5 语言规则统一 | 验证getLanguageRule()被所有agent使用 | 无重复内联语言规则 |
| UT-L2-06 | H2.6 策略切换信号 | 验证SearchSaturationDetector Jaccard计算 | 重叠>80%触发饱和 |
| UT-L2-07 | H2.7 输出格式约定 | 验证output-format.ts内容 | 含引用格式/推理标记/置信度 |

#### L3 上下文管理层
| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| UT-L3-01 | C3.1 压缩分级升级 | 验证CircuitBreaker normal→aggressive→deterministic | 三级升级正确 |
| UT-L3-02 | C3.2 搜索结果保护 | 验证MicroCompactor保护kb_search/expand | 搜索结果不被裁剪 |
| UT-L3-03 | C3.3 关键词去重 | 验证SearchResultIndex.getKeywordList() | 返回去重关键词列表 |
| UT-L3-04 | C3.5 搜索索引持久化 | 验证restoreEntries()/getEntries()序列化 | JSON正确恢复 |
| UT-L3-05 | C3.5 SessionMemory集成 | 验证save/load含searchIndexJson | DB持久化正确 |

#### L4 Agent Loop层
| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| UT-L4-01 | R4.1 流式推测执行 | 验证consumeStream含speculativeTools参数 | 中流执行逻辑 |
| UT-L4-02 | R4.2 maxTokens恢复 | 验证finishReason=length时4级提升 | 16K→32K→64K→131K |
| UT-L4-03 | R4.3 卡死检测 | 验证StuckDetector 4种模式 | 重复/停滞/交替检测 |
| UT-L4-04 | R4.4 模型降级 | 验证transient error重试3次 | 非transient正确降级 |
| UT-L4-05 | R4.5 搜索中间摘要 | 验证SearchResultIndex.getDetailedSummary() | 含snippet内容 |
| UT-L4-06 | R4.7 工具结果缓存 | 验证ToolResultCache get/set | 相同query命中缓存 |

#### L5 多Agent编排层
| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| UT-L5-01 | O5.1 协调器Prompt | 验证COORDINATOR_AGENT prompt长度和内容 | 含任务分解方法论 |
| UT-L5-02 | O5.2 子Agent上下文 | 验证runCoordinated传递结构化上下文 | parentFindings等字段 |
| UT-L5-03 | O5.3 LLM交叉验证 | 验证deepCrossVerify()调用modelRouter.chat | maxTokens/temp正确 |
| UT-L5-04 | O5.4 DAG编排 | 验证WorkflowEngine 5种模式 | 条件执行正确 |

#### L6 场景层
| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| UT-L6-01 | S6.1 Skill反幻觉等级 | 验证skill声明antiHallucinationLevel | DB字段存在 |
| UT-L6-02 | S6.4 Skill组合 | 验证executeChain()和BUILTIN_CHAINS | research-to-report链 |
| UT-L6-03 | S6.6 Skill测试运行器 | 验证SkillTestRunner.runScenario() | 验证3种检查类型 |
| UT-L6-04 | S6.7 语义分块 | 验证chunked-analysis skill和cluster-and-analyze链 | builtin注册正确 |

### Tier 2: 集成测试（跨模块验证）

| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| IT-01 | 流式推测执行端到端 | 启动系统，发送agent请求含多工具调用 | 工具在流中提前执行 |
| IT-02 | 上下文压缩+记忆恢复 | 模拟长对话触发压缩，验证记忆保留 | 关键信息不丢失 |
| IT-03 | 搜索索引跨轮次 | 多轮搜索后验证索引持久化和恢复 | 跨turn保持 |
| IT-04 | 多Agent编排 | 通过API触发coordinated run | 子Agent正确创建和综合 |
| IT-05 | Skill链执行 | 通过API触发skill chain | 输出正确传递 |
| IT-06 | 工具并发安全 | 发送mixed safe/unsafe工具调用 | 安全并发，不安全串行 |

### Tier 3: 系统应用测试（模拟人类使用）

| ID | 测试项 | 测试方法 | 验证目标 |
|----|--------|---------|---------|
| ST-01 | 系统启动验证 | python3 start.py启动 | 所有服务正常启动 |
| ST-02 | 前端页面加载 | 访问所有前端页面 | 无白屏、无报错 |
| ST-03 | 设置页面功能 | 检查所有设置选项 | Provider/Agent设置完整 |
| ST-04 | 知识库管理 | 创建KB、上传文档 | 文档处理正常 |
| ST-05 | Agent对话 | 发送各类查询 | 响应正常、工具调用正确 |
| ST-06 | Skill选择 | 选择不同skill执行 | skill正确加载和执行 |
| ST-07 | 多Agent工作流 | 创建和执行工作流 | 编排正确 |
| ST-08 | 错误处理 | 模拟各类错误场景 | 优雅降级、不崩溃 |
| ST-09 | 性能指标 | 测量响应时间、并发能力 | 符合设计目标 |
