# MinerU 管线集成设计 — 实施计划与风险

## 一、实施阶段

### Phase 1：MinerU 基础集成（后端核心）

**目标**：MinerU 能跑通，能解析，能降级。

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1.1 | `mineru-client.ts` (新建) | 实现 MinerU HTTP 客户端，支持同步/异步解析 |
| 1.2 | `mineru-processor.ts` (新建) | 实现 `MinerUProcessor`，`parse()` 返回 `ParsedContent` |
| 1.3 | `processor-factory.ts` (修改) | 注册 MinerUProcessor，扩展 `parseWithChannel` |
| 1.4 | `pipeline-strategies.ts` (新建) | 定义默认管线策略 |
| 1.5 | `pipeline-orchestrator.ts` (新建) | 实现管线编排器，策略选择 + 降级 |
| 1.6 | `settings` 路由 (修改) | 新增 MinerU 配置和管线策略 API |
| 1.7 | 测试 | 单元测试：MinerU 客户端、处理器、编排器 |

**验证标准**：
- `curl -X POST http://localhost:8001/file_parse -F "files=@test.pdf"` 能返回 Markdown
- DA 后端启动时 MinerU 健康检查正常
- 上传 PDF → 自动走 MinerU → 解析成功 → L0/L1/L2 正确生成
- MinerU 不可用时自动降级到 Docling

### Phase 2：前端配置界面

**目标**：用户能配置 MinerU、选择管线策略。

| 步骤 | 文件 | 内容 |
|------|------|------|
| 2.1 | `MinerUConfig.tsx` (新建) | MinerU 配置面板 |
| 2.2 | `PipelineConfig.tsx` (新建) | 管线策略配置面板 |
| 2.3 | `DoclingConfig.tsx` (修改) | 微调标题/说明文字 |
| 2.4 | `ModelsPanel.tsx` (修改) | 添加 "MinerU" 和 "管线策略" 子标签 |
| 2.5 | `types/index.ts` (修改) | 新增 MinerUConfig、PipelineStrategy 类型 |
| 2.6 | `api/client.ts` (修改) | 新增 MinerU/管线 API 函数 |

**验证标准**：
- 设置页面能看到 "MinerU 配置" 和 "管线策略" 标签
- 配置保存后重启不丢失
- MinerU 连通性检测正常

### Phase 3：文档卡片与重建增强

**目标**：用户能手动选择管线、看到管线信息。

| 步骤 | 文件 | 内容 |
|------|------|------|
| 3.1 | `DocumentCard.tsx` (修改) | 扩展处理器选择器，增加管线选项 |
| 3.2 | `DocumentCard.tsx` (修改) | 显示当前使用的管线名称 |
| 3.3 | `processor-factory.ts` (修改) | 扩展 `parseWithChannel` 支持新通道名 |
| 3.4 | 端到端测试 | 手动选择管线 → 重建 → 验证结果 |

**验证标准**：
- DocumentCard 下拉框显示所有管线选项
- 选择 "MinerU Hybrid" → 重建 → 解析成功
- 选择 "Auto" → 重建 → 按策略自动选择管线

### Phase 4：深度预处理增强

**目标**：利用 MinerU 提升预处理能力。

| 步骤 | 文件 | 内容 |
|------|------|------|
| 4.1 | `builtin-skills.ts` (修改) | 扩展预处理技能提示词 |
| 4.2 | `tool-setup.ts` (修改) | 扩展 `scanPreprocessingDir` |
| 4.3 | 测试 | 上传含印刷体表格的图片 → 预处理 → 验证提取结果 |

**验证标准**：
- 含印刷体表格的图片经过预处理后能还原为 CSV
- 表格 manifest.json 血缘信息正确

### Phase 5：生产化与 Docker 集成

**目标**：MinerU 可在 Docker 环境中运行。

| 步骤 | 文件 | 内容 |
|------|------|------|
| 5.1 | `docker-compose.dev.yml` (修改) | 新增 MinerU 服务定义 |
| 5.2 | `docker-compose.yml` (修改) | 生产环境 MinerU 配置 |
| 5.3 | `start.py` (修改) | 增加 MinerU 服务启动/停止逻辑 |
| 5.4 | `.env.example` (修改) | 新增 MinerU 相关环境变量 |

---

## 二、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| MinerU API 不稳定或崩溃 | 降级到 Docling | 编排器自动检测连通性，失败时跳过 MinerU |
| MinerU 解析结果格式变化 | 解析转换失败 | 版本锁定 MinerU，转换层做防御性解析 |
| 大文件超时 | 用户等待过长 | 异步解析 + 超时配置 + 自动降级 |
| GPU 资源不足 | MinerU 无法启动 | Pipeline 后端支持 CPU 模式（慢但可用） |
| MinerU 和 Docling 模型冲突 | GPU 显存不够 | 两者分时复用，MinerU API 作为独立进程 |
| 前端改动影响现有功能 | 用户操作异常 | 新增组件不修改现有组件，增量添加 |

---

## 三、关键决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| MinerU 部署方式 | SDK 嵌入 vs API 服务 | API 服务 | MinerU 原生支持 API 模式，避免 Python 依赖冲突 |
| 管线选择位置 | 前端决定 vs 后端决定 | 后端决定（前端可选） | 前端只传 pipeline 参数，后端编排器做实际选择和降级 |
| L2 数据格式 | 统一 vs 按管线分别存储 | 按管线分别存储 | 避免数据转换损失，保留原始结构 |
| XLSX 处理 | MinerU vs NativeTable | NativeTable | 现有处理器已经足够好，MinerU 无额外优势 |
| 预处理中的 MinerU 使用 | 新增工具 vs bash curl | bash curl | 预处理是 Agent 驱动的，Agent 已有 bash 工具 |

---

## 四、不做的内容（明确排除）

1. **不做管线结果历史对比**：不存储多管线解析结果的历史版本（过于复杂），用户只能看到当前管线的结果
2. **不做自动内容特征检测**：不在上传时自动判断"含表格"、"含印章"等内容特征来选择管线（需要解析后才知道内容）
3. **不做 MinerU 模型下载管理**：MinerU 的模型由 MinerU 自己管理，DA 不负责下载
4. **不做 MinerU 容器自动管理**：不像 Docling VLM 那样管理 MinerU Docker 容器（MinerU 是独立服务）
5. **不做表格+印章双遍处理**：分析报告中提到的 "MinerU 两遍处理" 方案暂不实现，留作未来优化

---

## 五、兼容性说明

### 5.1 已有数据兼容

- 所有已处理的文档 `metadata.sourceType === "docling"` 保持不变
- `wiki_pages` 表结构不变（page_type 仍然是 abstract/structure_dt/structure_md/fulltext/overview）
- Wiki 编译器接口不变（接收 `ParsedContent`，不关心管线来源）

### 5.2 配置兼容

- `docling_config` 设置不变
- 新增 `mineru_config` 和 `pipeline_strategies` 设置
- `mineru_config.enabled` 默认为 `false`，不影响现有行为
- 升级后如果不启用 MinerU，系统行为与升级前完全一致

### 5.3 API 兼容

- 所有现有 API 端点和参数不变
- `reprocessDocument` 的 `processor` 参数向后兼容（新增可选值，旧值行为不变）
- WebSocket 事件格式不变
