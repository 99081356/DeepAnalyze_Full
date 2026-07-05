# DeepAnalyze 系统重构设计文档

> 日期: 2026-04-18
> 版本: v3 (修订 - MiniMax M2.7 系列更新、GLM-5.1、视频理解模型完整分析)
> 范围: Provider 重构、文档流水线、知识库 UI、Agent 体系、系统健壮性

---

## 一、背景与目标

DeepAnalyze 是一个大模型知识库 + 自动化 Agent 系统，支持多模态文档上传、结构化抽取、分层抽象、统一检索，以及基于 TAOR 循环的多 Agent 协作。

经过多轮迭代，系统在以下方面偏离了设计预期：

1. **模型 Provider 配置**与各厂商最新规范不一致，参数配置有误
2. **知识库 UI** 的文档/Wiki/搜索分离，层级交互未实现
3. **文档处理流水线**存在并发锁 bug、多媒体处理不完整（无语音发言人分离、视频无音频转写、无前端预览播放）
4. **Agent Teams** UI 不完善、无主辅模型分离、WorkflowEngine 缺少取消和结果持久化
5. **系统健壮性**缺少自动降级和故障切换机制

本设计将这些问题拆解为 5 个独立子项目，按自底向上顺序实施。

---

## 二、子项目分解与依赖关系

```
子项目 1: Provider 重构与模型配置对齐
    ↓
子项目 2: 文档处理流水线修复与多媒体完善
    ↓
子项目 3: 知识库 UI 统一重写（含多媒体预览播放）
    ↓
子项目 4: Agent 体系优化
    ↓
子项目 5: 系统健壮性与自动降级
```

每个子项目独立完成 spec -> plan -> 实施 -> 验证，子项目间通过接口隔离。

---

## 三、子项目 1：Provider 重构与模型配置对齐

### 3.1 目标

对齐 OpenClaw / CountBot / AIE 参考项目的 Provider 配置规范，修正各厂商模型名称、接口地址、参数配置，支持多模型可切换（含嵌入模型），确保所有增强模型接口稳定可用。

### 3.2 信息来源

本节模型信息来自以下参考项目（已在 refcode/ 中验证）：
- **OpenClaw** (`refcode/openclaw/src/plugins/provider-model-defaults.ts`) - 最新默认模型
- **CountBot** (`refcode/CountBot-main/backend/modules/providers/registry.py`) - 22 个 Provider 完整注册表
- **AIE** (`refcode/AIE/backend/modules/providers/registry.py`) - 增强/多模态模型详细配置
- **OpenViking** (`refcode/OpenViking/bot/vikingbot/providers/registry.py`) - VLM 和嵌入模型配置

### 3.3 影响文件

| 文件 | 改动类型 |
|------|---------|
| `src/models/provider-registry.ts` | 重写 - 扩展 Provider 元数据结构，更新全部模型信息 |
| `src/models/router.ts` | 修改 - 增加健康检查和模型发现 |
| `src/models/openai-compatible.ts` | 修改 - 支持 thinking/reasoning 参数 |
| `src/models/embedding.ts` | 修改 - 多模型切换和自动重索引 |
| `src/models/capability-dispatcher.ts` | 重写 - 通用适配层 |
| `src/models/provider.ts` | 修改 - 扩展配置 Schema |
| `src/store/repos/interfaces.ts` | 修改 - ProviderConfig 增加字段 |
| `config/default.yaml` | 更新 - 最新模型和参数 |
| `frontend/src/components/settings/` | 修改 - 配置 UI 适配新字段 |

### 3.4 设计细节

#### 3.4.1 Provider 元数据扩展

在 `provider-registry.ts` 中，将每个厂商的条目从简单默认值扩展为完整的元数据。参照 CountBot 的 `registry.py` 和 AIE 的 `registry.py` 结构：

```typescript
interface ModelMeta {
  id: string;                    // 模型 ID（如 "qwen3.5-plus"）
  name: string;                  // 显示名称
  contextWindow: number;         // 最大上下文 token 数
  maxOutputTokens: number;       // 最大输出 token 数
  supportsToolUse: boolean;      // 是否支持 function calling
  supportsVision: boolean;       // 是否支持图片理解
  supportsStreaming: boolean;    // 是否支持流式输出
  inputPrice?: number;           // 输入单价 (per million tokens)
  outputPrice?: number;          // 输出单价
  recommendedTemperature?: { min: number; max: number; default: number };
  recommendedTopP?: { min: number; max: number; default: number };
  thinkingSupport?: 'native' | 'compat' | 'experimental' | 'unsupported';
  thinkingConfig?: {             // 参照 CountBot thinking_profiles.py
    type: 'extra_body' | 'top_level';
    field: string;               // 如 "thinking", "enable_thinking", "reasoning_effort"
    values: { enabled: any; disabled: any };
  };
}

interface ProviderMeta {
  id: string;                    // 唯一标识（如 "qwen"）
  name: string;                  // 显示名称（如 "通义千问"）
  apiBase: string;               // 国际接口地址
  apiBaseCN?: string;            // 国内接口地址
  defaultModel: string;          // 默认模型 ID
  models: ModelMeta[];           // 该厂商所有可用模型
  isLocal: boolean;              // 是否本地部署
  apiKeyEnvVar?: string;         // 对应环境变量名
  apiProtocol: 'openai-compatible' | 'anthropic' | 'ollama';
  features: {
    chat: boolean;
    embeddings: boolean;
    tts: boolean;
    imageGeneration: boolean;
    videoGeneration: boolean;
    musicGeneration: boolean;
    audioTranscription: boolean;
    vision: boolean;
  };
}
```

#### 3.4.2 完整 Provider 注册表（基于 CountBot + AIE + OpenClaw 核对）

以下信息已从 refcode 中的参考项目交叉验证：

##### 1. OpenAI

| 字段 | 值 |
|------|-----|
| id | `openai` |
| apiBase | `https://api.openai.com/v1` |
| apiKeyEnvVar | `OPENAI_API_KEY` |
| 默认模型 | `gpt-5.4` (OpenClaw 最新) |
| thinking | `top_level`, field: `reasoning_effort`, values: `high/medium/none/minimal/low` |

| 模型 ID | 名称 | 上下文 | 最大输出 | 工具 | 视觉 | 流式 |
|---------|------|--------|---------|------|------|------|
| `gpt-5.4` | GPT-5.4 | 1,047,576 | 32,768 | ✓ | ✓ | ✓ |
| `gpt-5.3` | GPT-5.3 | 1,047,576 | 32,768 | ✓ | ✓ | ✓ |
| `gpt-4o` | GPT-4o | 128,000 | 16,384 | ✓ | ✓ | ✓ |
| `gpt-4o-mini` | GPT-4o Mini | 128,000 | 16,384 | ✓ | ✓ | ✓ |
| `o4-mini` | o4-mini | 200,000 | 100,000 | ✓ | ✗ | ✓ |
| `o3` | o3 | 200,000 | 100,000 | ✓ | ✓ | ✓ |

##### 2. Anthropic

| 字段 | 值 |
|------|-----|
| id | `anthropic` |
| apiBase | `https://api.anthropic.com` |
| apiKeyEnvVar | `ANTHROPIC_API_KEY` |
| 默认模型 | `claude-sonnet-4-20250514` (CountBot 最新) |
| thinking | `native`, field: `thinking`, values: `{type: "enabled"/"disabled"}` |

| 模型 ID | 名称 | 上下文 | 最大输出 | 工具 | 视觉 |
|---------|------|--------|---------|------|------|
| `claude-opus-4-6` | Claude Opus 4.6 | 200,000 | 32,000 | ✓ | ✓ |
| `claude-sonnet-4-20250514` | Claude Sonnet 4 | 200,000 | 64,000 | ✓ | ✓ |
| `claude-4.5-sonnet` | Claude 4.5 Sonnet (via OpenRouter) | 200,000 | 64,000 | ✓ | ✓ |

##### 3. OpenRouter

| 字段 | 值 |
|------|-----|
| id | `openrouter` |
| apiBase | `https://openrouter.ai/api/v1` |
| apiKeyEnvVar | `OPENROUTER_API_KEY` |
| 默认模型 | `anthropic/claude-4.5-sonnet` (CountBot) |
| thinking | `experimental`, field: `reasoning`, values: `{exclude: bool, effort: "medium"/"none"}` |

说明：OpenRouter 是网关型 Provider，可通过 `provider/model` 格式访问所有厂商模型。

##### 4. DeepSeek

| 字段 | 值 |
|------|-----|
| id | `deepseek` |
| apiBase | `https://api.deepseek.com/v1` |
| apiKeyEnvVar | `DEEPSEEK_API_KEY` |
| 默认模型 | `deepseek-chat` (V3) |
| thinking | `native`, field: `thinking`, values: `{type: "enabled"/"disabled"}` |

| 模型 ID | 名称 | 上下文 | 最大输出 | 工具 | 视觉 |
|---------|------|--------|---------|------|------|
| `deepseek-chat` | DeepSeek V3 | 131,072 | 8,192 | ✓ | ✗ |
| `deepseek-reasoner` | DeepSeek R1 | 131,072 | 8,192 | ✓ | ✗ |

##### 5. 通义千问 (Qwen / Alibaba Cloud)

| 字段 | 值 |
|------|-----|
| id | `qwen` |
| apiBase (通用) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| apiBaseCN (编码) | `https://coding.dashscope.aliyuncs.com/v1` |
| apiKeyEnvVar | `DASHSCOPE_API_KEY` |
| 默认模型 | `qwen3.5-plus` (AIE/CountBot 最新) |
| thinking | `native`, field: `enable_thinking`, values: `true/false` |

| 模型 ID | 名称 | 上下文 | 最大输出 | 工具 | 视觉 |
|---------|------|--------|---------|------|------|
| `qwen3.5-plus` | Qwen 3.5 Plus | 131,072 | 8,192 | ✓ | ✗ |
| `qwen3-plus` | Qwen 3 Plus | 131,072 | 8,192 | ✓ | ✗ |
| `qwen-turbo` | Qwen Turbo | 131,072 | 8,192 | ✓ | ✗ |
| `qwen-vl-max` | Qwen VL Max | 32,768 | 8,192 | ✗ | ✓ |
| `qwen-vl-plus` | Qwen VL Plus | 32,768 | 8,192 | ✗ | ✓ |
| `text-embedding-v3` | Text Embedding V3 | 8,192 | - | - | - |

##### 6. 月之暗面 (Moonshot / Kimi)

| 字段 | 值 |
|------|-----|
| id | `moonshot` |
| apiBase | `https://api.moonshot.cn/v1` |
| apiKeyEnvVar | `MOONSHOT_API_KEY` |
| 默认模型 | `kimi-k2.5` |
| thinking | `native`, field: `thinking`, values: `{type: "enabled"/"disabled"}` |
| 特殊 | `kimi-k2.5` 强制 temperature = 1.0 (CountBot 已确认) |

##### 7. 智谱 AI (Zhipu / GLM)

| 字段 | 值 |
|------|-----|
| id | `zhipu` |
| apiBase | `https://open.bigmodel.cn/api/paas/v4` |
| apiKeyEnvVar | `ZHIPUAI_API_KEY` |
| 默认模型 | `glm-5.1` (官网最新) |
| thinking | `native`, field: `thinking`, values: `{type: "enabled"/"disabled"}` |

| 模型 ID | 名称 | 上下文 | 最大输出 | 工具 | 视觉 |
|---------|------|--------|---------|------|------|
| `glm-5.1` | GLM-5.1 | 200,000 | 131,072 | ✓ | ✗ |
| `glm-5` | GLM-5 | 200,000 | 131,072 | ✓ | ✗ |
| `glm-4.7-flash` | GLM-4.7 Flash | 128,000 | 8,192 | ✓ | ✓ |
| `glm-4v-plus` | GLM-5V-Turbo | 200,000 | 131,072 | ✓ | ✓ |

##### 8. 百度文心 (Ernie / Qianfan)

| 字段 | 值 |
|------|-----|
| id | `ernie` |
| apiBase | `https://qianfan.baidubce.com/v2` |
| apiKeyEnvVar | `QIANFAN_API_KEY` |
| 默认模型 | `ernie-4.0-8k` (CountBot) |

##### 9. 字节豆包 (Doubao / Volcengine)

| 字段 | 值 |
|------|-----|
| id | `doubao` |
| apiBase | `https://ark.cn-beijing.volces.com/api/v3` |
| apiKeyEnvVar | `ARK_API_KEY` |
| 默认模型 | `doubao-pro-32k` (CountBot/AIE) |
| 特殊 | 模型 ID 格式为 endpoint ID，需要用户在火山引擎控制台创建 |

##### 10. MiniMax (海螺 AI)

| 字段 | 值 |
|------|-----|
| id | `minimax` |
| apiBase | `https://api.minimaxi.com/v1` |
| apiKeyEnvVar | `MINIMAX_API_KEY` |
| 默认模型 | `M2.7` |
| thinking | `experimental` |
| 订阅 | Token Plan (按请求额度每 5 小时滚动重置，非文本模型每日配额) |

MiniMax 当前全模态模型列表（以官网最新为准）：

| 模型 ID | 用途 | API 路径 | 说明 |
|---------|------|---------|------|
| `M2.7` | 标准对话 | `/chat/completions` | 最新旗舰模型，456B MoE，百万级上下文 |
| `M2.7-highspeed` | 高速对话 | `/chat/completions` | M2.7 极速版，适合高频调用 |
| `image-01` | 图片生成 | `/image_generation` | 文生图 |
| `Hailuo-2.3-Fast-768p-6s` | 视频生成 (快速) | `/video_generation` | 6 秒 768P 快速生成 |
| `Hailuo-2.3-768p-6s` | 视频生成 (标准) | `/video_generation` | 6 秒 768P 标准生成 |
| `Music-2.6` | 音乐生成 | `/music/generation` | 文生音乐，≤5 分钟 |
| `Speech-2.8` | 语音合成 (TTS) | `/t2a_async_v2` | 异步语音合成 |
| `embo-01` | 文本嵌入 | `/embeddings` | 向量嵌入 |

##### 11. Groq

| 字段 | 值 |
|------|-----|
| id | `groq` |
| apiBase | `https://api.groq.com/openai/v1` |
| apiKeyEnvVar | `GROQ_API_KEY` |
| 默认模型 | `llama-3.3-70b-versatile` |
| thinking | `response_only`, field: `include_reasoning`, values: `true/false` |

##### 12. Mistral

| 字段 | 值 |
|------|-----|
| id | `mistral` |
| apiBase | `https://api.mistral.ai/v1` |
| apiKeyEnvVar | `MISTRAL_API_KEY` |
| 默认模型 | `mistral-large-latest` |
| thinking | `unsupported` |

##### 13. Google Gemini (新增)

| 字段 | 值 |
|------|-----|
| id | `gemini` |
| apiBase | `https://generativelanguage.googleapis.com/v1beta/openai` |
| apiKeyEnvVar | `GEMINI_API_KEY` |
| 默认模型 | `gemini-2.5-pro` (OpenClaw 最新引用) |

| 模型 ID | 名称 | 上下文 | 最大输出 | 工具 | 视觉 |
|---------|------|--------|---------|------|------|
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1,048,576 | 65,536 | ✓ | ✓ |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 1,048,576 | 65,536 | ✓ | ✓ |

##### 14. Cohere

| 字段 | 值 |
|------|-----|
| id | `cohere` |
| apiBase | `https://api.cohere.com/v2` |
| apiKeyEnvVar | `COHERE_API_KEY` |
| 默认模型 | `command-r-plus` |

##### 15. Together AI

| 字段 | 值 |
|------|-----|
| id | `together_ai` |
| apiBase | `https://api.together.xyz/v1` |
| apiKeyEnvVar | `TOGETHERAI_API_KEY` |
| 默认模型 | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |

##### 16. 腾讯混元

| 字段 | 值 |
|------|-----|
| id | `hunyuan` |
| apiBase | `https://hunyuan.tencentcloudapi.com` |
| apiKeyEnvVar | `HUNYUAN_API_KEY` |
| 默认模型 | `hunyuan-lite` |

##### 17. 01.AI (Yi)

| 字段 | 值 |
|------|-----|
| id | `yi` |
| apiBase | `https://api.lingyiwanwu.com/v1` |
| apiKeyEnvVar | `YI_API_KEY` |
| 默认模型 | `yi-large` |

##### 18. 百川 (Baichuan)

| 字段 | 值 |
|------|-----|
| id | `baichuan` |
| apiBase | `https://api.baichuan-ai.com/v1` |
| apiKeyEnvVar | `BAICHUAN_API_KEY` |
| 默认模型 | `Baichuan4` |

##### 19. Ollama (本地)

| 字段 | 值 |
|------|-----|
| id | `ollama` |
| apiBase | `http://localhost:11434/v1` |
| apiKeyEnvVar | (无需) |
| 默认模型 | (用户自定义) |
| thinking | `compat` |
| 特殊 | 支持 `/api/tags` 模型发现 API |

##### 20. vLLM (本地)

| 字段 | 值 |
|------|-----|
| id | `vllm` |
| apiBase | `http://localhost:8000/v1` |
| 默认模型 | (用户自定义) |
| thinking | `compat` |
| 特殊 | 支持 `/v1/models` 模型发现 API |

##### 21. LM Studio (本地)

| 字段 | 值 |
|------|-----|
| id | `lm_studio` |
| apiBase | `http://localhost:1234/v1` |
| 默认模型 | (用户自定义) |

##### 22. Custom OpenAI 兼容

| 字段 | 值 |
|------|-----|
| id | `custom_openai` |
| apiBase | (用户自定义) |
| 默认模型 | (用户自定义) |

#### 3.4.3 增强模型完整配置

参照 AIE 的增强模型体系，统一 9 种增强能力类型：

| 能力类型 | 推荐模型 | API 格式 | 备注 |
|---------|---------|---------|------|
| `multimodal` (VLM) | `qwen-vl-max` / `gpt-4o` / `glm-4v-plus` | OpenAI Vision | 图片理解 + 视频理解 |
| `audio_transcribe` (ASR) | `whisper-1` / `gpt-4o-mini-transcribe` | `/audio/transcriptions` | 语音转文字，需支持发言人分离 |
| `audio_gen` (TTS) | `Speech-2.8` (MiniMax) / `tts-1` (OpenAI) | `/t2a_async_v2` 或 `/audio/speech` | 文字转语音 |
| `image_gen` | `image-01` (MiniMax) / `gpt-image-1` (OpenAI) | `/image_generation` 或 `/images/generations` | 文生图 |
| `video_gen` | `Hailuo-2.3-768p-6s` (MiniMax 海螺) | `/video_generation` | 文生视频 |
| `video_understand` | `gpt-4o` / `gemini-2.5-pro` / `qwen-vl-max` | OpenAI Vision (视频帧) | 视频内容理解分析 |
| `music_gen` | `Music-2.6` (MiniMax) | `/music/generation` | 文生音乐 |
| `3d_gen` | (预留) | - | 后续按需实现 |
| `code_gen` | (复用主模型) | - | 代码生成 |
| `custom` | (用户自定义) | - | 自定义能力 |

#### 3.4.4 嵌入模型多模型支持

参照 AIE 和 OpenViking 的嵌入配置：

| 模型 | 维度 | 部署方式 | 来源 |
|------|------|---------|------|
| `BAAI/bge-m3` | 1024 | 本地 ONNX Runtime | AIE 默认，CPU 推理 |
| `text-embedding-3-small` | 1536 | OpenAI API | OpenClaw 默认 |
| `text-embedding-3-large` | 3072 | OpenAI API | OpenViking |
| `text-embedding-v3` | 1024 | 通义千问 API | AIE API fallback |
| `embo-01` | 1024 | MiniMax API | 当前已有 |

切换逻辑：
- dimension 相同 → 仅标记旧嵌入为 stale，新查询使用新模型
- dimension 不同 → 后台异步重索引，不阻塞 UI，可取消

#### 3.4.5 Thinking/Reasoning 参数支持

参照 CountBot 的 `thinking_profiles.py`，为支持推理的模型增加 thinking 参数传递：

```typescript
// 在 OpenAICompatibleProvider.chatStream() 中
if (modelMeta.thinkingSupport === 'native') {
  // DeepSeek/Zhipu/Moonshot/Qwen: extra_body.thinking 或 enable_thinking
  body[modelMeta.thinkingConfig.field] = modelMeta.thinkingConfig.values.enabled;
}
if (modelMeta.thinkingSupport === 'experimental') {
  // OpenRouter: extra_body.reasoning
  body.reasoning = { exclude: false, effort: "medium" };
}
if (modelMeta.thinkingSupport === 'response_only') {
  // Groq: top-level include_reasoning
  body.include_reasoning = true;
}
```

#### 3.4.6 ProviderConfig 接口扩展

```typescript
interface ProviderConfig {
  // ... 现有字段 ...
  // 新增
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  apiBaseCN?: string;
  supportedFeatures?: string[];
  visionEnabled?: boolean;
  thinkingEnabled?: boolean;
}
```

### 3.5 验证标准

- [ ] 所有 22 个 Provider 的模型名称、接口地址与 CountBot/AIE/OpenClaw 参考一致
- [ ] 嵌入模型可自由切换，dimension 变化时自动触发重索引
- [ ] 增强模型（TTS/Image/Video/Music/ASR）通过正确的 API 格式调用
- [ ] Thinking 参数按厂商规范正确传递
- [ ] 设置页面支持所有新增字段的配置
- [ ] 配置保存后实时生效，无需重启

---

## 四、子项目 2：文档处理流水线修复与多媒体完善

### 4.1 目标

修复文档处理管道的关键 bug，**完整实现多媒体文件（图片/音频/视频）的处理流水线**，确保所有文件类型从上传到 L0 ready 的完整链路可靠运行。

### 4.2 影响文件

| 文件 | 改动类型 |
|------|---------|
| `src/services/processing-queue.ts` | 修改 - 并发控制重写 |
| `src/wiki/expander.ts` | 修改 - L1 映射修复 |
| `src/server/routes/knowledge.ts` | 修改 - 删除级联、状态追踪、路由清理 |
| `src/wiki/compiler.ts` | 修改 - 状态更新时序 |
| `src/wiki/retriever.ts` | 修改 - structure 页面搜索支持 |
| `src/services/document-processors/processor-factory.ts` | 修改 - MIME 类型修正 |
| `src/services/document-processors/image-processor.ts` | 重写 - 完整图像处理 |
| `src/services/document-processors/audio-processor.ts` | 重写 - ASR + 发言人分离 |
| `src/services/document-processors/video-processor.ts` | 重写 - 音频轨提取 + ASR + 缩略图 |
| `src/wiki/modality-compilers/` | 修改 - 多媒体编译增强 |
| `src/server/routes/knowledge.ts` | 修改 - 原文件下载/流式接口 |

### 4.3 通用 Bug 修复

#### 4.3.1 ProcessingQueue 并发控制重写

**问题**：`processing` 布尔标志导致 `concurrency > 1` 无效。

**方案**：

```typescript
class ProcessingQueue {
  private active: Map<string, AbortController> = new Map();
  private queue: string[] = [];

  async enqueue(docId: string): Promise<void> {
    if (this.active.has(docId) || this.queue.includes(docId)) return;
    this.queue.push(docId);
    this.scheduleNext();
  }

  private scheduleNext(): void {
    while (this.queue.length > 0 && this.active.size < this.concurrency) {
      const docId = this.queue.shift()!;
      const controller = new AbortController();
      this.active.set(docId, controller);
      this.processJob(docId, controller.signal)
        .finally(() => {
          this.active.delete(docId);
          this.scheduleNext();
        });
    }
  }
}
```

#### 4.3.2 L1 structure 页面映射修复

**问题**：Docling 处理的文档产生 `structure` 类型页面，但层级映射只识别 `overview`。

修改点：
1. `PAGE_TYPE_TO_LEVEL`: 增加 `structure → L1`
2. `Expander.pageTypeToLevel()`: `structure` 返回 `'L1'`
3. `Retriever`: L1 搜索同时覆盖 `overview` 和 `structure`
4. `availableLevels` 查询增加 `structure` 页面检测

#### 4.3.3 文档删除级联清理

```
1. 删除 embeddings (by page_id, 关联 wiki_pages.doc_id)
2. 删除 anchors (by doc_id)
3. 删除 wiki_links (source/target 关联 wiki_pages)
4. 删除 wiki_pages (by doc_id)
5. 删除磁盘文件:
   - {wikiDir}/{kbId}/documents/{docId}/ (递归)
   - {dataDir}/original/{kbId}/{docId}/ (递归)
6. 删除 documents 记录
```

#### 4.3.4 状态追踪精细化

| 阶段 | 进度范围 | 子进度来源 |
|------|---------|-----------|
| 上传中 | 0-5% | HTTP 上传进度 |
| 排队 | 5% | 固定 |
| 解析 | 10-40% | 页数/帧数/音频时长进度 |
| 编译 | 40-60% | L2→L1→L0 逐步完成，按钮逐步变绿 |
| 索引 | 60-80% | 已索引页数/总页数 |
| 链接 | 80-95% | 已处理文档数/总文档数 |
| 就绪 | 100% | 完成 |

**关键**：编译阶段中 L2/L1/L0 每完成一层，立即通过 WebSocket 通知前端，对应按钮立即变绿，无需等全部完成。

#### 4.3.5 路由清理和 Reindex 优化

- 废弃 `GET /:kbId/search`（LIKE 搜索），重定向到统一搜索
- 新增 `POST /kbs/:kbId/reindex-embeddings` 仅重新生成嵌入
- `ProcessorFactory` 对不支持的文件类型抛出明确错误
- MIME 类型映射补全：`flac/aac/ogg/m4a/wma` → `audio/*`，`avi/mov/mkv/webm/flv/wmv` → `video/*`

### 4.4 图片处理完整设计

#### 4.4.1 当前差距

- 无图片尺寸提取 (`width`/`height` 未填充)
- 无 EXIF 元数据提取
- 无缩略图生成
- 前端无图片查看器
- VLM 描述依赖 `vlm` 角色配置，配置缺失时仅输出占位文字

#### 4.4.2 改进方案

**ImageProcessor.parse()** 增强流程：

```
1. 读取图片文件
2. 提取基础信息: 宽度/高度/格式/文件大小 (使用 Sharp)
3. 提取 EXIF 元数据 (使用 Sharp 的 metadata())
4. 生成缩略图 (Sharp resize 到 400px 宽, 保存到 {docId}/thumb.webp)
5. VLM 图片理解 (调用已配置的 VLM 模型)
6. OCR 文字提取 (通过 Docling)
7. 组合输出 ParsedContent
```

**ImageRawData 输出**：

```typescript
{
  description: string,       // VLM 详细描述
  ocrText?: string,          // OCR 提取的文字
  format: string,            // 图片格式
  width: number,             // 图片宽度
  height: number,            // 图片高度
  exif?: {                   // EXIF 元数据
    make?: string,           // 相机制造商
    model?: string,          // 相机型号
    dateTime?: string,       // 拍摄时间
    gps?: { lat: number; lng: number }, // GPS 坐标
    orientation?: number,
  },
  thumbnailPath?: string,    // 缩略图相对路径
}
```

**DocTags 输出增强**：

```
[img](size=1920x1080;format=jpeg) 视觉描述: {description}
[ocr] 文本内容: {ocrText}
[meta] 拍摄时间: {dateTime}, 相机: {make} {model}, GPS: {lat},{lng}
```

### 4.5 音频处理完整设计

#### 4.5.1 当前差距

- **无发言人分离 (Speaker Diarization)**：所有语音标记为单一说话者 `'S'`
- ASR 语言硬编码为中文 (`"zh"`)
- 无语言自动检测
- 音频时长获取依赖 `ffprobe`，不可用时静默返回 0
- 前端无音频播放器

#### 4.5.2 改进方案

**AudioProcessor.parse()** 增强流程：

```
1. 读取音频文件
2. 提取基础信息: 时长/格式/采样率/声道数 (ffprobe, 不可用时标记警告)
3. 语言自动检测:
   - 优先使用 ASR API 的语言检测能力 (whisper: language=null 自动检测)
   - 备选: 前 30 秒音频片段送 ASR 获取语言
4. ASR 转写 (带时间戳):
   - 调用 /audio/transcriptions，请求 response_format="verbose_json"
   - 获取 word-level 或 segment-level 时间戳
5. 发言人分离 (Speaker Diarization):
   方案 A (推荐): 使用支持 diarization 的 ASR API
     - 如 pyannote/speaker-diarization 本地服务
     - 或 API 支持 speaker_labels=true 参数
   方案 B (备选): 基于停顿的简单分割
     - 检测 ≥1.5 秒的静默间隔作为发言切换点
     - 标记为 S1, S2, S3...
   方案 C (降级): 单一说话者
     - 保持当前行为，标记为 "未知说话者"
6. 组合输出: 转写文本 + 时间戳 + 发言人标签
```

**AudioRawData 输出增强**：

```typescript
{
  duration: number,                  // 总时长（秒）
  language?: string,                 // 检测到的语言 ("zh", "en", "ja" 等)
  sampleRate?: number,               // 采样率
  channels?: number,                 // 声道数
  speakers: [{
    id: string,                      // "S1", "S2" 等
    label: string,                   // "发言人 1", "发言人 2" 等
    totalDuration?: number,          // 该发言人总发言时长
  }],
  turns: [{
    speaker: string,                 // "S1", "S2" 等
    startTime: number,               // 开始时间（秒）
    endTime: number,                 // 结束时间（秒）
    text: string,                    // 转写文本
  }],
  diarizationMethod: 'api' | 'silence' | 'none',  // 使用的分离方法
}
```

**DocTags 输出**：

```
[p](speaker=S1;time=00:00-00:15) 第一位发言人的内容...
[p](speaker=S2;time=00:16-00:32) 第二位发言人的内容...
[p](speaker=S1;time=00:33-00:48) 第一位发言人再次发言...
```

**L1 Structure 页面**：按发言人分组，每位发言人的连续段落合并为一个页面：

```
页面标题: "发言人 1 (00:00-02:35)"
页面内容: 该发言人在此时段的所有转写文本
```

**L0 摘要**：LLM 基于转写内容生成，包含：
- 主题摘要 (~200 字)
- 参与发言人数
- 关键观点列表
- 时间节点
- 5-10 个标签

### 4.6 视频处理完整设计

#### 4.6.1 当前差距

- **无音频轨提取和转写**：`VideoRawData.transcript.turns` 始终为空
- 无发言人分离
- 当前仅做关键帧采样 + 逐帧 VLM 描述，不是完整的视频理解
- 提取的关键帧处理后删除，无缩略图保留
- 前端无视频播放器

#### 4.6.2 改进方案：视频理解模型 + 音频轨转写

**核心思路**：不再仅做"关键帧采样 + 逐帧 VLM"，而是使用**视频理解模型**对完整视频内容进行深度理解，输出结构化的视频内容描述。同时提取音频轨做 ASR 转写。

**VideoProcessor.parse()** 增强流程：

```
1. 读取视频文件
2. 提取基础信息: 时长/分辨率/FPS/编码 (ffprobe)
3. 生成视频缩略图（用于前端时间线展示）:
   - 每 30 秒提取 1 帧, 最多 120 帧
   - 缩略图保存到 {docId}/frames/ 目录 (JPEG, 320px宽)
4. 视频理解（核心）:
   方案 A（推荐）: 调用支持视频输入的 VLM
     - 如 GPT-4o / Gemini 2.5 / Qwen-VL-Max 等支持视频理解的模型
     - 将视频文件（或视频的多个均匀采样帧 + 时间戳）发送给 VLM
     - Prompt: "请详细分析这个视频的完整内容，按时间线描述每个场景的变化，
       包括画面内容、人物动作、文字信息、场景转换、关键事件。输出结构化描述。"
     - VLM 返回完整的视频内容分析报告（按场景/时段分段描述）
   方案 B（备选）: 帧采样 + 逐帧 VLM（当前方案增强版）
     - 对于不支持直接视频输入的 VLM
     - 均匀采样关键帧（每 10-30 秒 1 帧）
     - 逐帧发送 VLM 获取描述
     - 前后帧描述差异大的标注为"场景转换"
5. 音频轨提取和转写:
   - ffmpeg 提取音频轨为临时 WAV 文件
   - 复用 AudioProcessor 的 ASR + 发言人分离逻辑
   - 获取带时间戳和发言人标签的完整转写
   - 删除临时音频文件
6. 时间对齐与合并:
   - 视频理解模型输出的场景描述（含时间段标注）
   - ASR 转写的对话内容（含时间戳和发言人）
   - 在时间轴上对齐，形成 "场景 = 画面 + 对话" 的完整结构
```

**VideoRawData 输出增强**：

```typescript
{
  duration: number,
  resolution?: string,              // "1920x1080"
  fps?: number,
  codec?: string,
  // 视频理解模型输出的完整场景描述
  scenes: [{
    index: number,                  // 场景序号
    startTime: number,              // 开始时间（秒）
    endTime: number,                // 结束时间（秒）
    description: string,            // 视频理解模型的场景描述
    keyEvents?: string[],           // 该场景内的关键事件
    textOnScreen?: string,          // 画面中的文字信息
    sceneTransition?: boolean,      // 是否为场景转换点
    thumbnailPath?: string,         // 缩略图相对路径
  }],
  // 音频轨转写
  transcript: {
    duration: number,
    language?: string,
    speakers: [{ id: string; label: string }],
    turns: [{
      speaker: string,
      startTime: number,
      endTime: number,
      text: string,
    }],
    diarizationMethod: 'api' | 'silence' | 'none',
  },
  videoUnderstandingMethod: 'vlm_video' | 'vlm_frames',  // 使用的理解方法
}
```

**L1 Structure 页面**：按时段分场景页面：

```
页面标题: "场景 3 (01:30-02:00)"
页面内容:
  ## 画面描述
  办公室内，三人在会议桌前讨论。桌上放着笔记本电脑和投影屏幕，
  屏幕上显示的是Q3销售数据图表。右侧白板上写有"重点讨论事项"。

  ## 画面文字
  Q3 销售数据报告 / 重点讨论事项

  ## 对话内容
  [S1]: 我认为这个方案需要调整，特别是华东区的数据...
  [S2]: 同意，第三点的增长率计算有误差...
```

**DocTags 输出**：

```
[scene](time=01:30-02:00) 办公室会议讨论，桌上有笔记本电脑和投影屏幕显示Q3销售数据
[text_on_screen] Q3 销售数据报告 / 重点讨论事项
[dialog](speaker=S1;time=01:32-01:38) 我认为这个方案需要调整
[dialog](speaker=S2;time=01:39-01:45) 同意，第三点的增长率计算有误差
```

### 4.7 原文件服务接口

为前端预览播放提供后端接口：

```
GET /api/knowledge/kbs/:kbId/documents/:docId/original
  → 返回原始文件 (Content-Type 根据文件类型设置)
  → 支持 Range 请求 (视频/音频 seek)

GET /api/knowledge/kbs/:kbId/documents/:docId/thumbnail
  → 返回图片缩略图

GET /api/knowledge/kbs/:kbId/documents/:docId/frames/:index
  → 返回视频关键帧缩略图
```

### 4.8 验证标准

- [ ] `concurrency` 设置为 2+ 时可同时处理多个文档
- [ ] Docling 处理的文档 L1 按钮正确显示和可点击
- [ ] 删除文档后无残留数据
- [ ] 图片上传后提取宽高、EXIF、缩略图，VLM 描述完整
- [ ] 音频上传后 ASR 转写带时间戳，支持发言人分离 (多位发言人)
- [ ] 视频上传后通过视频理解模型输出完整场景描述，提取音频轨转写+发言人分离，时间对齐
- [ ] 所有多媒体文件可通过 API 获取原始文件用于预览播放
- [ ] Range 请求支持视频/音频 seek

---

## 五、子项目 3：知识库 UI 统一重写

### 5.1 目标

将文档、Wiki、搜索三个独立 Tab 合并为统一知识库管理页面，实现 L0/L1/L2 层级按钮交互，**多媒体文件（图片/音频/视频）的原文件预览播放**，顶部统一搜索栏。

### 5.2 影响文件

| 文件 | 改动类型 |
|------|---------|
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | 重写 → `KnowledgeView.tsx` |
| `frontend/src/components/knowledge/DocumentManager.tsx` | 重写 → `DocumentCard.tsx` |
| `frontend/src/components/preview/LayerPreview.tsx` | 修改 - 层级按钮 + 多媒体预览 |
| `frontend/src/components/search/UnifiedSearch.tsx` | 修改 - 集成到顶部搜索栏 |
| `frontend/src/components/knowledge/MediaPlayer.tsx` | 新增 - 音视频播放器组件 |
| `frontend/src/components/knowledge/ImagePreview.tsx` | 新增 - 图片预览组件 |
| `frontend/src/hooks/useDocProcessing.ts` | 修改 - 细粒度状态 + 多媒体状态 |
| `frontend/src/api/client.ts` | 修改 - 原文件/缩略图 API |

### 5.3 页面布局

```
+------------------------------------------------------------------+
| [KB选择器 ▼]  [🔍 搜索...        ] [语义▼] [召回数▼] [层级▼]  |
|                                [上传文件] [上传文件夹] [+新建KB] |
+------------------------------------------------------------------+
|  文档列表 (DropZone - 支持所有文件类型)                            |
|                                                                    |
|  ┌── PDF/DOCX 文档卡片 ────────────────────────────────────────┐  |
|  │ 📄 合同文件.pdf          2024-01-15  2.3MB    [删除] [更多] │  |
|  │ [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓                      │  |
|  │   ┌── L0 摘要 ─────────────────────────────────────────┐   │  |
|  │   │ 本合同为XX公司与YY公司签署的技术服务协议...         │   │  |
|  │   └────────────────────────────────────────────────────┘   │  |
|  └────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌── 图片文件卡片 ────────────────────────────────────────────┐  |
|  │ 🖼️ 现场照片.jpg          2024-01-15  1.8MB  1920x1080     │  |
|  │ [缩略图预览 ▼] [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓     │  |
|  │   ┌── 缩略图 + EXIF ─────────────────────────────────┐    │  |
|  │   │ [缩略图]  拍摄时间: 2024-01-15 14:32             │    │  |
|  │   │           相机: Canon EOS R5  GPS: 31.2,121.4    │    │  |
|  │   └──────────────────────────────────────────────────┘    │  |
|  │   ┌── L2 完整描述 ─────────────────────────────────┐      │  |
|  │   │ VLM: 照片中显示一个会议室场景，桌上有...        │      │  |
|  │   │ OCR: 提取到的文字内容: 会议纪要 2024-01-15...   │      │  |
|  │   └──────────────────────────────────────────────────┘    │  |
|  └────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌── 音频文件卡片 ────────────────────────────────────────────┐  |
|  │ 🎙️ 录音记录.mp3          2024-01-15  12.4MB  03:25        │  |
|  │ [▶ 播放原录音] [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓     │  |
|  │   ┌── 音频播放器 ────────────────────────────────────┐    │  |
|  │   │ ▶ ━━━━━●━━━━━━━━━━━━━━━━━━━ 01:15 / 03:25      │    │  |
|  │   │ [S1] 我们需要讨论一下这个方案...                  │    │  |
|  │   └──────────────────────────────────────────────────┘    │  |
|  │   ┌── L1 发言人分段 ────────────────────────────────┐     │  |
|  │   │ 发言人 1 (00:00-01:32): 我们需要讨论...         │     │  |
|  │   │ 发言人 2 (01:33-02:15): 我同意前面的观点...     │     │  |
|  │   └──────────────────────────────────────────────────┘    │  |
|  └────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌── 视频文件卡片 ────────────────────────────────────────────┐  |
|  │ 🎬 监控录像.mp4          2024-01-15  245MB  1920x1080 15:30│ |
|  │ [▶ 播放原视频] [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓     │  |
|  │   ┌── 视频播放器 + 场景同步 ──────────────────────────┐    │  |
|  │   │ ▶ [视频画面] ━━━━━●━━━━━━━ 03:25 / 15:30        │    │  |
|  │   │ 当前场景 (01:30-02:00): 办公室讨论                │    │  |
|  │   │ 画面: 三人在会议桌前，投影显示Q3数据...            │    │  |
|  │   │ 对话: [S1] 我认为这个方案... [S2] 同意...          │    │  |
|  │   └──────────────────────────────────────────────────┘    │  |
|  │   ┌── 关键帧时间线 ─────────────────────────────────┐     │  |
|  │   │ [00:00] [00:30] [01:00] [01:30] [02:00] ...     │     │  |
|  │   │  缩略图  缩略图  缩略图  缩略图  缩略图         │     │  |
|  │   └──────────────────────────────────────────────────┘    │  |
|  └────────────────────────────────────────────────────────────┘  |
+------------------------------------------------------------------+
```

### 5.4 核心组件设计

#### 5.4.1 DocumentCard (统一文档卡片)

根据文件类型自动选择渲染模式：

```typescript
interface DocumentCardProps {
  document: Document;
  levels: {
    L0: { ready: boolean; pageId?: string };
    L1: { ready: boolean; pageId?: string };
    L2: { ready: boolean; pageId?: string };
  };
  expandedLevel?: 'L0' | 'L1' | 'L2' | 'media';
  fileType: 'document' | 'image' | 'audio' | 'video';
  thumbnailUrl?: string;              // 图片/视频缩略图
  originalFileUrl?: string;           // 原文件播放/下载
  mediaDuration?: string;             // 音视频时长
  mediaResolution?: string;           // 视频分辨率 / 图片尺寸
}
```

文件类型识别规则：
- `document`: pdf, docx, doc, xlsx, xls, pptx, ppt, txt, md, csv, json, html
- `image`: png, jpg, jpeg, gif, bmp, tiff, webp, svg
- `audio`: mp3, wav, flac, aac, ogg, m4a, wma
- `video`: mp4, avi, mov, mkv, webm, flv, wmv

每种类型显示不同的图标和元信息行。

#### 5.4.2 ImagePreview (图片预览组件)

- 缩略图展示（点击放大到全屏查看器）
- EXIF 信息面板（拍摄时间、相机、GPS 等）
- 原图下载按钮

#### 5.4.3 AudioPlayer (音频播放组件)

- 标准 HTML5 `<audio>` 播放器
- 时间轴 + 进度条 + 音量控制
- 同步显示当前时段的转写文本（高亮当前播放位置对应的发言人段落）
- 发言人标签颜色区分（S1=蓝色, S2=绿色, S3=橙色...）

```typescript
interface AudioPlayerProps {
  src: string;                       // 原文件 URL
  duration: number;
  speakers: { id: string; label: string }[];
  turns: { speaker: string; startTime: number; endTime: number; text: string }[];
}
```

播放时同步逻辑：
- `timeupdate` 事件获取当前播放时间
- 查找当前时间对应的 turn
- 高亮显示该 turn 文本并自动滚动

#### 5.4.4 VideoPlayer (视频播放组件)

- 标准 HTML5 `<video>` 播放器（支持 `controls`、`preload="metadata"`）
- 视频播放器旁同步显示：
  - 当前场景的视频理解描述（自动跟随播放进度切换场景）
  - 当前时段的对话转写文本（带发言人标签）
- 关键帧时间线（缩略图条，点击跳转到对应位置）
- 场景切换指示器（场景转换点高亮标记）
- 发言人标签同音频播放器

```typescript
interface VideoPlayerProps {
  src: string;                       // 原文件 URL (支持 Range)
  duration: number;
  resolution: string;
  scenes: {                          // 视频理解模型输出的场景
    startTime: number;
    endTime: number;
    description: string;
    thumbnailUrl?: string;
  }[];
  transcript: {
    speakers: { id: string; label: string }[];
    turns: { speaker: string; startTime: number; endTime: number; text: string }[];
  };
}
```

#### 5.4.5 LayerPreview (层级预览 - 所有类型通用)

展开后的内容根据文件类型和层级不同而不同：

| 文件类型 | L0 | L1 | L2 |
|---------|-----|-----|-----|
| 文档 | 精简摘要 | DocTags/Markdown 结构内容 | 原始完整文本 |
| 图片 | 主题摘要 | VLM 描述 + OCR 文字 | 完整描述 + OCR + EXIF 元数据 |
| 音频 | 主题摘要 + 发言人数 | 按发言人分段的转写文本 | 完整转写（含时间戳和发言人标签） |
| 视频 | 主题摘要 + 场景数 | 按场景/时段分段（画面+对话） | 完整场景描述 + 完整转写 |

#### 5.4.6 UnifiedSearchBar (统一搜索栏)

- 搜索输入框（防抖 300ms）
- 检索模式选择：语义检索 / 向量检索 / 混合检索
- 召回数量控制：5/10/20/50
- 检索层级多选：L0/L1/L2，默认勾选 L1
- 搜索结果替换文档列表，清空搜索恢复文档列表

### 5.5 文档处理状态交互（多媒体增强）

```
上传中 (进度条 0-5%)
  → 上传完成
    → 解析中 (10-40%)
      ├─ 文档: Docling 解析
      ├─ 图片: Sharp 元数据 + 缩略图 + VLM 描述 + OCR
      ├─ 音频: ffprobe 信息 + ASR 转写 + 发言人分离
      └─ 视频: ffprobe 信息 + 音频轨提取 + ASR + 发言人分离 + 视频理解模型完整分析 + 缩略图
    → 编译中 (40-60%)
      → L2 raw JSON 就绪 → L2 按钮变绿 🟢
      → L1 structure 页面就绪 → L1 按钮变绿 🟢
      → L0 摘要就绪 → L0 按钮变绿 🟢
    → 索引中 (60-80%)
    → 链接中 (80-95%)
    → 就绪 ✓ (100%)
```

对于多媒体文件，编译完成后额外触发：
- 图片：缩略图可供前端加载
- 音频：转写文本 + 发言人信息可供播放器同步
- 视频：关键帧缩略图 + 转写文本 + 时间对齐

### 5.6 聊天页文档上传

1. `MessageInput` 的文件上传逻辑连通
2. 支持选择所有文件类型（文档 + 图片 + 音频 + 视频）
3. 上传时检查当前 session 是否有关联的知识库：
   - 无 → 自动创建以 session ID 命名的临时知识库
   - 有 → 上传到关联的知识库
4. 上传完成后自动更新 `AnalysisScope` 包含该知识库
5. 知识库为永久性的，可在知识库页面中重命名

### 5.7 跨知识库检索

- 浮动按钮点击展开多知识库选择器
- 搜索时支持跨库检索，结果标注来源 KB
- Agent 工具 `kb_search` 支持传入多个 kbId

### 5.8 验证标准

- [ ] 文档、Wiki、搜索合并为单一页面，无 Tab 切换
- [ ] L0/L1/L2 按钮状态正确（灰色未就绪/绿色可预览）
- [ ] 层级按钮点击展开预览，再次点击折叠
- [ ] 图片：显示缩略图，点击放大查看原图，显示 EXIF 信息
- [ ] 音频：HTML5 播放器可播放原录音，同步显示转写文本和发言人标签
- [ ] 视频：HTML5 播放器可播放原视频，场景描述同步切换，关键帧时间线可点击跳转，叠加字幕
- [ ] 搜索栏支持语义/向量/混合模式、召回数、层级选择
- [ ] 聊天页上传文档自动创建临时知识库

---

## 六、子项目 4：Agent 体系优化

### 6.1 目标

完善 Agent Teams 功能，实现主/辅模型分离，修复 WorkflowEngine 缺陷，将 Teams 从知识库迁移到对话页 Header。

### 6.2 影响文件

| 文件 | 改动类型 |
|------|---------|
| `src/services/agent/agent-runner.ts` | 修改 - 主/辅模型路由 |
| `src/services/agent/agent-system.ts` | 修改 - 初始化顺序调整 |
| `src/services/agent/workflow-engine.ts` | 修改 - 取消/进度/结果持久化 |
| `src/services/agent/orchestrator.ts` | 修改 - task ID 修复 |
| `src/services/agent/tool-setup.ts` | 修改 - web_search 实现 |
| `src/server/routes/agents.ts` | 修改 - 协调启动修复 |
| `src/server/routes/agent-teams.ts` | 修改 - 结果持久化 |
| `frontend/src/components/layout/Header.tsx` | 修改 - 新增 Teams 按钮 |
| `frontend/src/components/layout/RightPanel.tsx` | 修改 - Teams 面板 |
| `frontend/src/components/teams/TeamEditor.tsx` | 修改 - 增加字段 UI |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | 修改 - 移除 Teams Tab |
| `src/store/repos/interfaces.ts` | 修改 - AgentTeamMember 增加字段 |

### 6.3 设计细节

#### 6.3.1 Teams 位置迁移

- Header 右侧新增 Teams 按钮（Users 图标）
- 点击打开右侧面板（560px），展示 TeamManager
- KnowledgePanel 移除 Teams Tab

#### 6.3.2 主/辅模型分离

```typescript
const mainModel = await this.getModelForRole('main');
const subModel = await this.getModelForRole('summarizer');
const effectiveModel = this.useSubModel(agentType) ? subModel : mainModel;
```

- 主 Agent（general、report）→ 主模型
- 子 Agent（explore、compile、verify、coordinator）→ 辅助模型
- 故障时自动切换到另一个模型

#### 6.3.3 WorkflowEngine 修复

- 增加 `AbortController` 支持取消
- Council 模式 Round 2 改为并行 (`Promise.allSettled`)
- 结果持久化到 `agent_tasks` 表
- 进度估算基于已完成/总 Agent 数

#### 6.3.4 Orchestrator task ID 修复

`AgentTaskRepo.create()` 接受可选 `id` 参数。

#### 6.3.5 Teams UI 完善

增加 tools（多选）、dependsOn（Graph 模式）、perspective（Council 模式）、systemPrompt（可选）字段配置。

#### 6.3.6 web_search 实现

支持 SearXNG（自部署）和 Serper API（云端）两种模式。

### 6.4 验证标准

- [ ] Teams 按钮出现在 Header 右侧
- [ ] 主 Agent 使用主模型，子 Agent 使用辅助模型
- [ ] 模型故障时自动切换
- [ ] WorkflowEngine 支持取消操作
- [ ] Council 模式 Round 2 并行执行
- [ ] 工作流结果持久化
- [ ] TeamEditor 支持完整字段配置
- [ ] web_search 可执行实际搜索

---

## 七、子项目 5：系统健壮性与自动降级

### 7.1 目标

实现多模态能力自动感知调度，模型故障自动切换，跨知识库检索聚合。

### 7.2 影响文件

| 文件 | 改动类型 |
|------|---------|
| `src/models/router.ts` | 修改 - 健康检查和熔断 |
| `src/models/capability-dispatcher.ts` | 修改 - 能力感知 |
| `src/wiki/retriever.ts` | 修改 - 跨库检索聚合 |
| `src/services/agent/tool-setup.ts` | 修改 - kb_search 跨库 |
| `src/server/routes/agents.ts` | 修改 - 双重 compounding 修复 |

### 7.3 设计细节

#### 7.3.1 能力感知调度

```typescript
interface SystemCapabilities {
  text: boolean;
  vision: boolean;
  tts: boolean;
  audioTranscription: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  musicGeneration: boolean;
  embedding: boolean;
  webSearch: boolean;
}
```

降级链：增强模型 → 询问用户 → Skill 获取 → 明确告知不可用

#### 7.3.2 模型故障自动切换（熔断机制）

```typescript
interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
  resetTimeout: number;  // 默认 60s
}
```

- 连续 3 次失败 → 熔断 → 切换到辅助模型
- 超时后 half-open → 尝试恢复

#### 7.3.3 跨知识库检索聚合

`kb_search` 工具支持多个 kbId，RRF 合并去重。

#### 7.3.4 双重 Compounding 修复

移除 `agents.ts` 路由中的 compounding，仅在 `AgentRunner.run()` 中执行。

### 7.4 验证标准

- [ ] 移除 Provider 后对应能力自动标记为不可用
- [ ] 新增 Provider 后能力自动恢复
- [ ] 主模型连续失败后自动切换到辅助模型
- [ ] 跨知识库搜索返回聚合去重结果
- [ ] Agent 输出不会重复写入知识库

---

## 八、数据库变更汇总

本设计不需要新建数据表。涉及的 schema 变更：

| 子项目 | 变更 |
|--------|------|
| 子项目 1 | `settings` 表 `providers` JSON 增加新字段；`enhanced_models` 增加 `audio_transcribe` 配置 |
| 子项目 2 | 多媒体处理产生的 `ImageRawData`/`AudioRawData`/`VideoRawData` 存储在现有 raw JSON 文件中 |
| 子项目 4 | `agent_team_members` 的 `tools` JSON 增加 UI 配置项 |

无需新的 migration，所有变更在 JSONB 字段或文件系统内。

---

## 九、不在本次范围内的事项

1. **知识图谱与关系抽取**：保留现有代码和入口，暂不启用
2. **3D 生成能力**：保留增强模型配置入口，暂不实现具体接口
3. **用户认证系统**：`users` 表已存在但无实际使用，后续按需实现
4. **全文搜索缓存**：`search_cache` 表已存在但无实现，后续按需实现
5. **消息分页加载**：后续大对话场景下再优化
6. **移动端响应式**：完整移动适配不在本次范围

---

## 十、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Provider 配置变更导致现有功能不可用 | 高 | 保留 YAML fallback，配置错误时自动回退 |
| 发言人分离依赖额外服务/API | 中 | 三级降级：API diarization → 静默检测 → 单一说话者 |
| 视频理解模型不支持直接视频输入 | 中 | 降级到帧采样+逐帧VLM，自动检测模型能力选择方案 |
| 视频音频轨提取依赖 ffmpeg | 中 | ffmpeg 不可用时跳过音频转写，仅做视频理解 |
| 知识库 UI 重写影响现有工作流 | 中 | 新旧组件共存过渡期 |
| 嵌入模型切换触发全量重索引 | 中 | 后台异步执行，不阻塞 UI，可取消 |
| web_search API 依赖外部服务 | 低 | 降级为"搜索不可用"提示 |

---

## 十一、后续演进方向

1. **用户认证与权限**：启用 users 表，实现登录、角色、知识库权限
2. **知识图谱启用**：设计实体关系抽取场景，启用 graph 功能
3. **移动端适配**：完整响应式布局
4. **性能优化**：消息分页、搜索缓存、文档列表分页
5. **多语言支持**：i18n 国际化框架
6. **插件市场**：在线插件和 Skill 的安装/管理
7. **实时协作 ASR**：流式音频转写，边录边转
