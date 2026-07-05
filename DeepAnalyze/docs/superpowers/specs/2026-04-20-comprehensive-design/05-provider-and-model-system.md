# 第 5 册：Provider 与模型系统

> **文档日期**: 2026-04-20
> **来源**: 综合 04-12 AIE 迁移（模型角色）、04-18 子项目 1（Provider 重构）
> **最新状态**: 以 04-18 子项目 1 为准

---

## 1. Provider 注册表

### 1.1 Provider 元数据结构

```typescript
interface ModelMeta {
  id: string;                    // 模型 ID
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
  thinkingConfig?: {
    type: 'extra_body' | 'top_level';
    field: string;
    values: { enabled: any; disabled: any };
  };
}

interface ProviderMeta {
  id: string;                    // 唯一标识
  name: string;                  // 显示名称
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

### 1.2 完整 Provider 列表（22 个）

信息来源：OpenClaw / CountBot / AIE / OpenViking 交叉验证。

| # | ID | 名称 | 默认模型 | Thinking 支持 |
|---|-----|------|---------|--------------|
| 1 | `openai` | OpenAI | `gpt-5.4` | top_level, reasoning_effort |
| 2 | `anthropic` | Anthropic | `claude-sonnet-4-20250514` | native, thinking type |
| 3 | `openrouter` | OpenRouter | `anthropic/claude-4.5-sonnet` | experimental, reasoning |
| 4 | `deepseek` | DeepSeek | `deepseek-chat` (V3) | native, thinking type |
| 5 | `qwen` | 通义千问 | `qwen3.5-plus` | native, enable_thinking |
| 6 | `moonshot` | 月之暗面 | `kimi-k2.5` | native (force temp=1.0) |
| 7 | `zhipu` | 智谱 AI | `glm-5.1` | native, thinking type |
| 8 | `ernie` | 百度文心 | `ernie-4.0-8k` | - |
| 9 | `doubao` | 字节豆包 | `doubao-pro-32k` | - (endpoint ID 格式) |
| 10 | `minimax` | MiniMax 海螺 | `M2.7` | experimental |
| 11 | `groq` | Groq | `llama-3.3-70b-versatile` | response_only, include_reasoning |
| 12 | `mistral` | Mistral | `mistral-large-latest` | unsupported |
| 13 | `gemini` | Google Gemini | `gemini-2.5-pro` | - |
| 14 | `cohere` | Cohere | `command-r-plus` | - |
| 15 | `together_ai` | Together AI | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | - |
| 16 | `hunyuan` | 腾讯混元 | `hunyuan-lite` | - |
| 17 | `yi` | 01.AI (Yi) | `yi-large` | - |
| 18 | `baichuan` | 百川 | `Baichuan4` | - |
| 19 | `ollama` | Ollama (本地) | 用户自定义 | compat |
| 20 | `vllm` | vLLM (本地) | 用户自定义 | compat |
| 21 | `lm_studio` | LM Studio (本地) | 用户自定义 | - |
| 22 | `custom_openai` | 自定义 OpenAI 兼容 | 用户自定义 | - |

### 1.3 Thinking/Reasoning 参数传递

```typescript
// 在 OpenAICompatibleProvider.chatStream() 中
switch (modelMeta.thinkingSupport) {
  case 'native':
    // DeepSeek/Zhipu/Moonshot/Qwen: extra_body 字段
    body[modelMeta.thinkingConfig.field] = modelMeta.thinkingConfig.values.enabled;
    break;
  case 'experimental':
    // OpenRouter: extra_body.reasoning
    body.reasoning = { exclude: false, effort: "medium" };
    break;
  case 'response_only':
    // Groq: top-level include_reasoning
    body.include_reasoning = true;
    break;
  case 'compat':
    // Ollama/vLLM: 思考标签解析
    break;
}
```

---

## 2. 模型角色体系

### 2.1 角色定义 (04-12 提出，04-18 完善)

| 角色 | 用途 | 配置位置 |
|------|------|---------|
| `main` | 主模型 — 通用对话、深度分析、报告生成 | Settings → 主模型 |
| `summarizer` | 辅助模型 — 摘要、编译、子 Agent | Settings → 辅助模型 |
| `embedding` | 嵌入模型 — 文档向量化 | Settings → 嵌入模型 |
| `enhanced` | 增强模型 — TTS/Image/Video/Music/ASR | Settings → 增强模型 |

### 2.2 路由策略

```
ModelRouter
  ├── DB-first: 从 settings 表读取 Provider 配置
  └── YAML-fallback: config/default.yaml 作为默认值
```

### 2.3 ProviderConfig 扩展

```typescript
interface ProviderConfig {
  // 基础字段
  id: string;
  name: string;
  apiBase: string;
  apiKey?: string;
  model: string;

  // 新增字段 (04-18)
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  apiBaseCN?: string;
  supportedFeatures?: string[];
  visionEnabled?: boolean;
  thinkingEnabled?: boolean;
}
```

---

## 3. 增强模型体系

### 3.1 9 种增强能力类型

| 能力类型 | 推荐模型 | API 格式 | 备注 |
|---------|---------|---------|------|
| `multimodal` (VLM) | `qwen-vl-max` / `gpt-4o` / `glm-4v-plus` | OpenAI Vision | 图片+视频理解 |
| `audio_transcribe` (ASR) | `whisper-1` / `gpt-4o-mini-transcribe` | `/audio/transcriptions` | 语音转文字+发言人分离 |
| `audio_gen` (TTS) | `Speech-2.8` (MiniMax) / `tts-1` (OpenAI) | `/t2a_async_v2` 或 `/audio/speech` | 文字转语音 |
| `image_gen` | `image-01` (MiniMax) / `gpt-image-1` (OpenAI) | `/image_generation` 或 `/images/generations` | 文生图 |
| `video_gen` | `Hailuo-2.3-768p-6s` (MiniMax) | `/video_generation` | 文生视频 |
| `video_understand` | `gpt-4o` / `gemini-2.5-pro` / `qwen-vl-max` | OpenAI Vision (视频帧) | 视频内容理解 |
| `music_gen` | `Music-2.6` (MiniMax) | `/music/generation` | 文生音乐 |
| `3d_gen` | (预留) | - | 后续按需实现 |
| `code_gen` | (复用主模型) | - | 代码生成 |

### 3.2 CapabilityDispatcher

通用适配层，根据能力类型路由到正确的 Provider 和 API 格式：

```typescript
class CapabilityDispatcher {
  // 根据能力类型和配置的增强模型，调用对应的 API
  async dispatch(capability: string, input: any): Promise<any>;

  // 运行时能力感知
  getSystemCapabilities(): SystemCapabilities;
}
```

---

## 4. 嵌入模型系统

### 4.1 支持的嵌入模型

| 模型 | 维度 | 部署方式 | 来源 |
|------|------|---------|------|
| `BAAI/bge-m3` | 1024 | 本地 ONNX Runtime | 默认，CPU推理 |
| `text-embedding-3-small` | 1536 | OpenAI API | OpenClaw 默认 |
| `text-embedding-3-large` | 3072 | OpenAI API | OpenViking |
| `text-embedding-v3` | 1024 | 通义千问 API | API fallback |
| `embo-01` | 1024 | MiniMax API | 当前已有 |

### 4.2 多模型切换逻辑

- **dimension 相同** → 仅标记旧嵌入为 stale，新查询使用新模型
- **dimension 不同** → 后台异步重索引，不阻塞 UI，可取消

```typescript
// 新增 EmbeddingRepo 方法
markAllStale(): Promise<void>;      // UPDATE embeddings SET stale = true
getStaleCount(): Promise<number>;   // SELECT COUNT(*) WHERE stale = true
```

### 4.3 向量索引

使用 pgvector HNSW 索引：
- 索引参数：`m = 16, ef_construction = 64`
- 查询参数：`ef_search = 40`
- 距离度量：余弦相似度 `<=>` 操作符

---

## 5. 系统能力感知与降级 (04-18 子项目 5)

### 5.1 系统能力检测

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

从当前配置的 Provider 的 `features` 元数据自动推导。

### 5.2 熔断机制

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
- 移除 Provider 后对应能力自动标记为不可用
- 新增 Provider 后能力自动恢复

### 5.3 降级链

```
增强模型 (API)
  ↓ 不可用
询问用户
  ↓ 无响应
Skill 获取 (替代方案)
  ↓ 无可用 Skill
明确告知不可用
```
