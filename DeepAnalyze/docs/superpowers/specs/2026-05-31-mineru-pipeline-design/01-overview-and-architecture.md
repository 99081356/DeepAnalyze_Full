# MinerU 管线集成设计 — 概述与架构

## 一、背景与目标

### 1.1 现状

DA 当前仅使用 Docling 作为文档解析管线，通过 Python 子进程（`docling-service/`）以 JSON-line 协议与 Node.js 后端通信。架构如下：

```
文件上传 → ProcessorFactory → DoclingProcessor → docling-service/main.py → parser.py → Docling SDK
```

Docling 的优势：格式覆盖广（16+ 种）、SDK 嵌入简单、CPU 可跑。但在以下场景效果不如 MinerU：
- 含表格的文档（特别是图片型表格）
- 印章文字提取
- 长文档（千页级）
- 印刷体图片的数据还原

### 1.2 目标

1. **新增 MinerU 管线**：不破坏现有 Docling 管线，增加 MinerU 作为独立解析通道
2. **智能管线选择**：根据文件类型和内容特征自动选择最优管线（Auto 模式）
3. **优雅降级**：主管线解析异常时自动尝试次级管线
4. **手动切换**：用户可在前端手动选择管线并重建解析
5. **增强图片表格还原**：利用 MinerU 的表格 OCR 能力增强深度预处理中的表格恢复
6. **前端预览对比**：支持查看不同管线的解析结果

### 1.3 设计原则

- **增量修改**：不重构现有代码，只增加新组件和新路径
- **管线对等**：MinerU 与 Docling 是平行的两条管线，地位对等
- **API 部署**：MinerU 以 API 服务形态运行（`mineru-api`），DA 后端作为 HTTP 客户端调用
- **配置驱动**：管线选择策略、MinerU API 地址、后端类型等全部可配置

---

## 二、架构总览

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        前端 (React)                              │
│  ┌───────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ PipelineConfig│  │ DocumentCard │  │ ParseResultPreview    │ │
│  │ (设置页面)     │  │ (管线选择器) │  │ (对比查看 L0/L1/L2)   │ │
│  └───────┬───────┘  └──────┬───────┘  └───────────┬───────────┘ │
└──────────┼─────────────────┼──────────────────────┼─────────────┘
           │                 │                      │
           ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     后端 (Node.js / Bun)                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  ProcessingQueue                          │   │
│  │   (parsing → compiling → indexing → quality_audit)       │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│  ┌──────────────────────▼───────────────────────────────────┐   │
│  │              PipelineOrchestrator (新增)                   │   │
│  │  • 解析 pipeline 策略配置                                  │   │
│  │  • 按文件类型选择优先管线                                   │   │
│  │  • 失败时自动降级到次级管线                                 │   │
│  │  • 记录使用的管线和解析质量                                 │   │
│  └──────┬─────────────────────┬───────────────────────────┘   │
│         │                     │                                │
│  ┌──────▼──────┐      ┌──────▼──────┐                         │
│  │ Docling     │      │ MinerU      │                         │
│  │ Processor   │      │ Processor   │                         │
│  │ (已有)      │      │ (新增)      │                         │
│  └──────┬──────┘      └──────┬──────┘                         │
│         │                     │                                │
│  ┌──────▼──────┐      ┌──────▼──────┐                         │
│  │ docling-    │      │ MinerU      │                         │
│  │ service/    │      │ API Client  │                         │
│  │ (子进程)    │      │ (HTTP)      │                         │
│  └──────┴──────┘      └──────┬──────┘                         │
│                              │                                 │
└──────────────────────────────┼─────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  mineru-api 服务     │
                    │  (独立 Python 进程)  │
                    │  端口: 8001 (可配)   │
                    └─────────────────────┘
```

### 2.2 核心概念

| 概念 | 说明 |
|------|------|
| **Pipeline（管线）** | 一个完整的文档解析方案（如 Docling、MinerU） |
| **Pipeline Backend** | 管线内部的后端实现（如 MinerU 的 pipeline/hybrid/vlm 三种后端） |
| **Pipeline Strategy** | 决定每种文件类型使用哪条管线、优先级和降级顺序的策略 |
| **Pipeline Result** | 管线解析结果，统一转换为 `ParsedContent` 格式 |

### 2.3 文件类型与管线优先级矩阵

基于分析报告的结论，Auto 模式下的管线优先级：

| 文件类型 | 优先管线 1 | 优先管线 2 | 优先管线 3 | 说明 |
|---------|-----------|-----------|-----------|------|
| **PDF** (含表格) | MinerU Hybrid | Docling Standard | Docling VLM | MinerU 表格精度 95+ |
| **PDF** (纯文字) | MinerU Pipeline | Docling Standard | — | MinerU 多语言优势 |
| **PDF** (含印章) | MinerU Pipeline | MinerU Hybrid | Docling VLM | 独立 seal OCR |
| **PDF** (扫描件/图片) | MinerU Hybrid | Docling VLM | — | MinerU 图片分析零配置 |
| **DOCX/PPTX** | MinerU Office | Docling Standard | — | MinerU 空间排序更准确 |
| **XLSX/CSV** | NativeTableProcessor | — | — | 不变，保持现有逻辑 |
| **图片** (PNG/JPG) | MinerU Hybrid | Docling VLM | Docling Standard | 印刷体表格图片走 MinerU |
| **音频/视频** | Docling (Whisper) | — | — | MinerU 不支持 |
| **Markdown/HTML/CSV** | Docling | — | — | MinerU 不支持 |
| **LaTeX/XML** | Docling | — | — | MinerU 不支持 |

> 注：实际选择策略可在设置页面配置，以上为默认推荐。

---

## 三、新增文件清单

| 文件路径 | 类型 | 说明 |
|---------|------|------|
| `src/services/document-processors/mineru-processor.ts` | 新增 | MinerU 处理器，实现 `DocumentProcessor` 接口 |
| `src/services/document-processors/mineru-client.ts` | 新增 | MinerU API HTTP 客户端 |
| `src/services/document-processors/pipeline-orchestrator.ts` | 新增 | 管线编排器，策略选择 + 降级 |
| `src/services/document-processors/pipeline-strategies.ts` | 新增 | 默认管线策略配置 |
| `src/server/routes/settings.ts` (扩展) | 修改 | 新增 MinerU 配置 API |
| `frontend/src/components/settings/MinerUConfig.tsx` | 新增 | MinerU 设置面板 |
| `frontend/src/components/settings/DoclingConfig.tsx` | 修改 | 改名为"文档处理 > Docling"子面板 |
| `frontend/src/components/settings/PipelineConfig.tsx` | 新增 | 管线策略配置面板 |
| `frontend/src/components/knowledge/DocumentCard.tsx` | 修改 | 扩展处理器选择下拉框 |

---

## 四、不修改的文件

以下文件**不需要修改**，保持现有行为：

| 文件 | 原因 |
|------|------|
| `docling-service/main.py` | Docling 管线保持不变 |
| `docling-service/parser.py` | Docling 管线保持不变 |
| `src/subprocess/docling-client.ts` | Docling 客户端保持不变 |
| `src/wiki/compiler.ts` | Wiki 编译器接口不变（接收 `ParsedContent`） |
| `src/services/processing-queue.ts` | 队列逻辑不变，只改内部的 `parseDocument` 调用方式 |
| `src/services/document-processors/quality-scorer.ts` | 质量评分逻辑通用 |
| `src/services/document-processors/quality-auditor.ts` | 质量审计逻辑通用 |
