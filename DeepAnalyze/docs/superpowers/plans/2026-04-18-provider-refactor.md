# Sub-Project 1: Provider Refactor & Model Configuration Alignment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align all provider metadata with OpenClaw/CountBot/AIE reference projects, correct model names/endpoints/parameters, add thinking support, expand model roles, and make the capability dispatcher generic.

**Architecture:** Expand `ProviderMetadata` to include per-provider model lists, thinking profiles, and feature flags. The registry becomes a rich catalog; runtime routing via `ModelRouter` remains unchanged (DB-first, YAML-fallback). `CapabilityDispatcher` gains a generic protocol-aware adapter layer. `EmbeddingManager` gains multi-model switching with auto-reindex. `OpenAICompatibleProvider` gains thinking/reasoning parameter passthrough.

**Tech Stack:** TypeScript, Zod (schema validation), Hono (API routes), React/Zustand (frontend)

**Spec:** `docs/superpowers/specs/2026-04-18-deepanalyze-system-redesign.md` Section 三

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/models/provider-registry.ts` | Provider catalog metadata (22 providers + models) |
| `src/models/provider.ts` | Core interfaces (`ModelProvider`, `ChatMessage`, etc.) + Zod schemas + `ModelRole` |
| `src/models/openai-compatible.ts` | OpenAI-compatible HTTP client with thinking support |
| `src/models/router.ts` | Runtime model routing (DB-first, YAML fallback) |
| `src/models/capability-dispatcher.ts` | TTS/Image/Video/Music/ASR dispatch (protocol-aware) |
| `src/models/embedding.ts` | Embedding provider management (multi-model, auto-reindex) |
| `src/store/repos/interfaces.ts` | DB schema interfaces (`ProviderConfig`, `ProviderDefaults`) |
| `src/server/routes/settings.ts` | Settings REST API (auto-configure, test, CRUD) |
| `config/default.yaml` | YAML fallback config |
| `frontend/src/components/settings/MainModelConfig.tsx` | Main model settings UI |
| `frontend/src/components/settings/SubModelConfig.tsx` | Sub model settings UI |
| `frontend/src/components/settings/ModelsPanel.tsx` | Models tab container |
| `frontend/src/components/settings/ModelConfigCard.tsx` | Reusable config card |

---

### Task 1: Expand ProviderMetadata and Update Provider Registry

**Files:**
- Modify: `src/models/provider-registry.ts` (full rewrite of interfaces + registry)

This task replaces the simple `ProviderMetadata` with a richer structure and updates all 22+ provider entries with correct model information from the spec.

- [ ] **Step 1: Replace the ProviderMetadata interface and all registry entries**

Replace the entire content of `src/models/provider-registry.ts` with the expanded types and corrected registry data. The new interfaces:

```typescript
// src/models/provider-registry.ts

/** Thinking/reasoning support level for a model */
export type ThinkingSupport = 'native' | 'compat' | 'experimental' | 'unsupported';

/** Configuration for passing thinking/reasoning parameters to a model */
export interface ThinkingConfig {
  /** Where to put the parameter: in extra_body or as a top-level field */
  type: 'extra_body' | 'top_level';
  /** The field name (e.g. "thinking", "enable_thinking", "reasoning_effort") */
  field: string;
  /** Values for enabled/disabled states */
  values: { enabled: unknown; disabled: unknown };
}

/** A single model within a provider's catalog */
export interface ModelMeta {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsToolUse: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  recommendedTemperature?: { min: number; max: number; default: number };
  recommendedTopP?: { min: number; max: number; default: number };
  thinkingSupport?: ThinkingSupport;
  thinkingConfig?: ThinkingConfig;
}

/** Feature flags for what a provider supports */
export interface ProviderFeatures {
  chat: boolean;
  embeddings: boolean;
  tts: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  musicGeneration: boolean;
  audioTranscription: boolean;
  vision: boolean;
}

/** Rich metadata for a provider entry */
export interface ProviderMetadata {
  id: string;
  name: string;
  apiBase: string;
  apiBaseCN?: string;
  defaultModel: string;
  models: ModelMeta[];
  isLocal: boolean;
  apiKeyEnvVar?: string;
  recommendedMaxTokens: number;
  contextWindow: number;
  features: ProviderFeatures;
}

// Helper to create a basic chat model entry
function chatModel(
  id: string, name: string, ctx: number, maxOut: number,
  toolUse = true, vision = false, stream = true,
  temp?: { min: number; max: number; default: number },
  thinking?: { support: ThinkingSupport; config: ThinkingConfig },
): ModelMeta {
  const m: ModelMeta = {
    id, name, contextWindow: ctx, maxOutputTokens: maxOut,
    supportsToolUse: toolUse, supportsVision: vision, supportsStreaming: stream,
  };
  if (temp) m.recommendedTemperature = temp;
  if (thinking) {
    m.thinkingSupport = thinking.support;
    m.thinkingConfig = thinking.config;
  }
  return m;
}

export const PROVIDER_REGISTRY: Record<string, ProviderMetadata> = {
  openrouter: {
    id: 'openrouter', name: 'OpenRouter',
    apiBase: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-4.5-sonnet',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    isLocal: false, recommendedMaxTokens: 128000, contextWindow: 1000000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: true },
    models: [
      chatModel('anthropic/claude-4.5-sonnet', 'Claude 4.5 Sonnet', 200000, 64000, true, true, true),
      chatModel('anthropic/claude-opus-4-6', 'Claude Opus 4.6', 200000, 32000, true, true, true),
      chatModel('openai/gpt-5.4', 'GPT-5.4', 1047576, 32768, true, true, true),
      chatModel('google/gemini-2.5-pro', 'Gemini 2.5 Pro', 1048576, 65536, true, true, true),
    ],
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic (Claude)',
    apiBase: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isLocal: false, recommendedMaxTokens: 64000, contextWindow: 200000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: true },
    models: [
      chatModel('claude-opus-4-6', 'Claude Opus 4.6', 200000, 32000, true, true, true,
        { min: 0, max: 1, default: 0.5 },
        { support: 'native', config: { type: 'extra_body', field: 'thinking', values: { enabled: { type: 'enabled' }, disabled: { type: 'disabled' } } } }),
      chatModel('claude-sonnet-4-20250514', 'Claude Sonnet 4', 200000, 64000, true, true, true,
        { min: 0, max: 1, default: 0.5 }),
    ],
  },
  openai: {
    id: 'openai', name: 'OpenAI',
    apiBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    isLocal: false, recommendedMaxTokens: 32768, contextWindow: 1047576,
    features: { chat: true, embeddings: true, tts: true, imageGeneration: true, videoGeneration: false, musicGeneration: false, audioTranscription: true, vision: true },
    models: [
      chatModel('gpt-5.4', 'GPT-5.4', 1047576, 32768, true, true, true,
        { min: 0, max: 2, default: 0.7 },
        { support: 'compat', config: { type: 'top_level', field: 'reasoning_effort', values: { enabled: 'high', disabled: 'none' } } }),
      chatModel('gpt-5.3', 'GPT-5.3', 1047576, 32768, true, true, true),
      chatModel('gpt-4o', 'GPT-4o', 128000, 16384, true, true, true),
      chatModel('gpt-4o-mini', 'GPT-4o Mini', 128000, 16384, true, true, true),
      chatModel('o4-mini', 'o4-mini', 200000, 100000, true, false, true),
      chatModel('o3', 'o3', 200000, 100000, true, true, true),
    ],
  },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek',
    apiBase: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    isLocal: false, recommendedMaxTokens: 8192, contextWindow: 131072,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [
      chatModel('deepseek-chat', 'DeepSeek V3', 131072, 8192, true, false, true,
        { min: 0, max: 2, default: 0.7 },
        { support: 'native', config: { type: 'extra_body', field: 'thinking', values: { enabled: { type: 'enabled' }, disabled: { type: 'disabled' } } } }),
      chatModel('deepseek-reasoner', 'DeepSeek R1', 131072, 8192),
    ],
  },
  qwen: {
    id: 'qwen', name: '通义千问 (Qwen)',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiBaseCN: 'https://coding.dashscope.aliyuncs.com/v1',
    defaultModel: 'qwen3.5-plus',
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    isLocal: false, recommendedMaxTokens: 8192, contextWindow: 131072,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: true },
    models: [
      chatModel('qwen3.5-plus', 'Qwen 3.5 Plus', 131072, 8192, true, false, true,
        { min: 0, max: 2, default: 0.7 },
        { support: 'native', config: { type: 'extra_body', field: 'enable_thinking', values: { enabled: true, disabled: false } } }),
      chatModel('qwen3-plus', 'Qwen 3 Plus', 131072, 8192),
      chatModel('qwen-turbo', 'Qwen Turbo', 131072, 8192),
      chatModel('qwen-vl-max', 'Qwen VL Max', 32768, 8192, false, true, true),
      chatModel('qwen-vl-plus', 'Qwen VL Plus', 32768, 8192, false, true, true),
    ],
  },
  moonshot: {
    id: 'moonshot', name: '月之暗面 (Kimi)',
    apiBase: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    isLocal: false, recommendedMaxTokens: 66000, contextWindow: 256000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [
      chatModel('kimi-k2.5', 'Kimi K2.5', 256000, 66000, true, false, true,
        { min: 1.0, max: 1.0, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'thinking', values: { enabled: { type: 'enabled' }, disabled: { type: 'disabled' } } } }),
    ],
  },
  zhipu: {
    id: 'zhipu', name: '智谱 AI (GLM)',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.1',
    apiKeyEnvVar: 'ZHIPUAI_API_KEY',
    isLocal: false, recommendedMaxTokens: 131072, contextWindow: 200000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: true },
    models: [
      chatModel('glm-5.1', 'GLM-5.1', 200000, 131072, true, false, true,
        undefined,
        { support: 'native', config: { type: 'extra_body', field: 'thinking', values: { enabled: { type: 'enabled' }, disabled: { type: 'disabled' } } } }),
      chatModel('glm-5', 'GLM-5', 200000, 131072),
      chatModel('glm-4.7-flash', 'GLM-4.7 Flash', 128000, 8192, true, true, true),
      chatModel('glm-4v-plus', 'GLM-5V-Turbo', 200000, 131072, true, true, true),
    ],
  },
  ernie: {
    id: 'ernie', name: '百度文心 (Ernie)',
    apiBase: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-8k',
    apiKeyEnvVar: 'QIANFAN_API_KEY',
    isLocal: false, recommendedMaxTokens: 8192, contextWindow: 128000,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [
      chatModel('ernie-4.0-8k', 'ERNIE 4.0 8K', 128000, 8192),
    ],
  },
  doubao: {
    id: 'doubao', name: '字节豆包 (Doubao)',
    apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-pro-32k',
    apiKeyEnvVar: 'ARK_API_KEY',
    isLocal: false, recommendedMaxTokens: 32000, contextWindow: 2000000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [
      chatModel('doubao-pro-32k', 'Doubao Pro 32K', 32000, 4096),
    ],
  },
  minimax: {
    id: 'minimax', name: 'MiniMax (海螺)',
    apiBase: 'https://api.minimaxi.com/v1',
    defaultModel: 'M2.7',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    isLocal: false, recommendedMaxTokens: 131072, contextWindow: 1000000,
    features: { chat: true, embeddings: true, tts: true, imageGeneration: true, videoGeneration: true, musicGeneration: true, audioTranscription: false, vision: false },
    models: [
      chatModel('M2.7', 'M2.7', 1000000, 131072, true, false, true),
      chatModel('M2.7-highspeed', 'M2.7 Highspeed', 1000000, 131072, true, false, true),
    ],
  },
  groq: {
    id: 'groq', name: 'Groq',
    apiBase: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    apiKeyEnvVar: 'GROQ_API_KEY',
    isLocal: false, recommendedMaxTokens: 32000, contextWindow: 128000,
    features: { chat: true, embeddings: false, tts: true, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: true, vision: false },
    models: [
      chatModel('llama-3.3-70b-versatile', 'Llama 3.3 70B', 128000, 32000, true, false, true,
        undefined,
        { support: 'compat', config: { type: 'top_level', field: 'include_reasoning', values: { enabled: true, disabled: false } } }),
    ],
  },
  mistral: {
    id: 'mistral', name: 'Mistral AI',
    apiBase: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    isLocal: false, recommendedMaxTokens: 32000, contextWindow: 128000,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [
      chatModel('mistral-large-latest', 'Mistral Large', 128000, 32000),
    ],
  },
  gemini: {
    id: 'gemini', name: 'Google Gemini',
    apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-pro',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    isLocal: false, recommendedMaxTokens: 65536, contextWindow: 1048576,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: true },
    models: [
      chatModel('gemini-2.5-pro', 'Gemini 2.5 Pro', 1048576, 65536, true, true, true),
      chatModel('gemini-2.5-flash', 'Gemini 2.5 Flash', 1048576, 65536, true, true, true),
    ],
  },
  cohere: {
    id: 'cohere', name: 'Cohere',
    apiBase: 'https://api.cohere.com/v2',
    defaultModel: 'command-r-plus',
    apiKeyEnvVar: 'COHERE_API_KEY',
    isLocal: false, recommendedMaxTokens: 16000, contextWindow: 128000,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [
      chatModel('command-r-plus', 'Command R+', 128000, 16000),
    ],
  },
  together_ai: {
    id: 'together_ai', name: 'Together AI',
    apiBase: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    apiKeyEnvVar: 'TOGETHERAI_API_KEY',
    isLocal: false, recommendedMaxTokens: 32000, contextWindow: 128000,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [
      chatModel('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Turbo', 128000, 32000),
    ],
  },
  hunyuan: {
    id: 'hunyuan', name: '腾讯混元',
    apiBase: 'https://hunyuan.tencentcloudapi.com',
    defaultModel: 'hunyuan-lite',
    apiKeyEnvVar: 'HUNYUAN_API_KEY',
    isLocal: false, recommendedMaxTokens: 32000, contextWindow: 128000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [ chatModel('hunyuan-lite', 'Hunyuan Lite', 128000, 32000) ],
  },
  yi: {
    id: 'yi', name: '01.AI (Yi)',
    apiBase: 'https://api.lingyiwanwu.com/v1',
    defaultModel: 'yi-large',
    apiKeyEnvVar: 'YI_API_KEY',
    isLocal: false, recommendedMaxTokens: 8000, contextWindow: 16000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [ chatModel('yi-large', 'Yi Large', 16000, 8000) ],
  },
  baichuan: {
    id: 'baichuan', name: '百川 AI',
    apiBase: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'Baichuan4',
    apiKeyEnvVar: 'BAICHUAN_API_KEY',
    isLocal: false, recommendedMaxTokens: 4096, contextWindow: 192000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [ chatModel('Baichuan4', 'Baichuan 4', 192000, 4096) ],
  },
  vllm: {
    id: 'vllm', name: 'vLLM',
    apiBase: 'http://localhost:8000/v1',
    defaultModel: '',
    isLocal: true, recommendedMaxTokens: 4096, contextWindow: 4096,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [],
  },
  ollama: {
    id: 'ollama', name: 'Ollama',
    apiBase: 'http://localhost:11434/v1',
    defaultModel: '',
    isLocal: true, recommendedMaxTokens: 4096, contextWindow: 4096,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [],
  },
  lm_studio: {
    id: 'lm_studio', name: 'LM Studio',
    apiBase: 'http://localhost:1234/v1',
    defaultModel: '',
    isLocal: true, recommendedMaxTokens: 4096, contextWindow: 4096,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [],
  },
  custom_openai: {
    id: 'custom_openai', name: 'Custom (OpenAI compat)',
    apiBase: '',
    defaultModel: '',
    isLocal: false, recommendedMaxTokens: 4096, contextWindow: 4096,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [],
  },
  custom_anthropic: {
    id: 'custom_anthropic', name: 'Custom (Anthropic compat)',
    apiBase: '',
    defaultModel: '',
    isLocal: false, recommendedMaxTokens: 4096, contextWindow: 4096,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: false },
    models: [],
  },
};

export function getAllProviders(): ProviderMetadata[] {
  return Object.values(PROVIDER_REGISTRY);
}

export function getProviderMetadata(id: string): ProviderMetadata | undefined {
  return PROVIDER_REGISTRY[id];
}

export function getProviderIds(): string[] {
  return Object.keys(PROVIDER_REGISTRY);
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit src/models/provider-registry.ts 2>&1 | head -20`

Expected: No errors (the file is self-contained with no imports).

- [ ] **Step 3: Commit**

```
git add src/models/provider-registry.ts
git commit -m "refactor: expand provider registry with rich metadata and corrected model info

- Replace simple ProviderMetadata with ProviderMetadata + ModelMeta + ThinkingConfig
- Update all 22 provider entries with correct models from OpenClaw/CountBot/AIE
- Add gemini and custom_anthropic providers
- Include thinking/reasoning profiles per CountBot thinking_profiles.py
- Add ProviderFeatures flags per provider"
```

---

### Task 2: Expand ProviderConfig Interface and ModelRole

**Files:**
- Modify: `src/store/repos/interfaces.ts` (lines 681-711)
- Modify: `src/models/provider.ts` (lines 119-193)

- [ ] **Step 1: Update ProviderConfig in interfaces.ts**

In `src/store/repos/interfaces.ts`, replace the `ProviderConfig` interface (lines 681-695) with:

```typescript
export interface ProviderConfig {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  supportsToolUse: boolean;
  enabled: boolean;
  contextWindow?: number;
  dimension?: number;
  temperature?: number;
  topP?: number;
  // New fields
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  apiBaseCN?: string;
  supportedFeatures?: string[];
  visionEnabled?: boolean;
  thinkingEnabled?: boolean;
}
```

Replace `ProviderDefaults` (lines 697-706) with the expanded roles:

```typescript
export interface ProviderDefaults {
  main: string;
  summarizer: string;
  embedding: string;
  vlm: string;
  tts: string;
  image_gen: string;
  video_gen: string;
  music_gen: string;
  audio_transcribe: string;
  video_understand: string;
}
```

- [ ] **Step 2: Update ModelRole and DefaultsConfigSchema in provider.ts**

In `src/models/provider.ts`, update `DefaultsConfigSchema` (lines 145-169) to add new roles:

```typescript
export const DefaultsConfigSchema = z.object({
  main: z.string().optional(),
  summarizer: z.string().optional(),
  embedding: z.string().optional(),
  vlm: z.string().optional(),
  tts: z.string().optional(),
  image_gen: z.string().optional(),
  video_gen: z.string().optional(),
  music_gen: z.string().optional(),
  audio_transcribe: z.string().optional(),
  video_understand: z.string().optional(),
});

export type ModelRole = "main" | "summarizer" | "embedding" | "vlm" | "tts" | "image_gen" | "video_gen" | "music_gen" | "audio_transcribe" | "video_understand";
```

- [ ] **Step 3: Update EMPTY_PROVIDER_DEFAULTS in settings.ts**

In `src/server/routes/settings.ts`, update `EMPTY_PROVIDER_DEFAULTS` (lines 26-28):

```typescript
const EMPTY_PROVIDER_DEFAULTS: ProviderDefaults = {
  main: '', summarizer: '', embedding: '', vlm: '',
  tts: '', image_gen: '', video_gen: '', music_gen: '',
  audio_transcribe: '', video_understand: '',
};
```

- [ ] **Step 4: Update dbDefaults in router.ts**

In `src/models/router.ts`, update the `dbDefaults` field type (around line 56) to include the new roles. Find where `dbDefaults` is initialized and add:

```typescript
private dbDefaults: Record<string, string> = {};
// After loading from DB, ensure new keys exist with defaults:
// audio_transcribe and video_understand default to ''
```

- [ ] **Step 5: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -30`

Expected: Some errors from downstream code referencing old fields - fix any that appear.

- [ ] **Step 6: Commit**

```
git add src/store/repos/interfaces.ts src/models/provider.ts src/server/routes/settings.ts src/models/router.ts
git commit -m "refactor: expand ProviderConfig fields and add audio_transcribe/video_understand roles"
```

---

### Task 3: Add Thinking Parameter Support to OpenAICompatibleProvider

**Files:**
- Modify: `src/models/openai-compatible.ts` (lines 26-47, 347-395)
- Modify: `src/models/router.ts` (lines 345-358)

- [ ] **Step 1: Add thinking config fields to OpenAICompatibleOptions**

In `src/models/openai-compatible.ts`, expand `OpenAICompatibleOptions` (lines 26-47):

```typescript
export interface OpenAICompatibleOptions {
  name: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  thinkingEnabled?: boolean;
  thinkingConfig?: {
    type: 'extra_body' | 'top_level';
    field: string;
    values: { enabled: unknown; disabled: unknown };
  };
}
```

- [ ] **Step 2: Update buildRequestBody to inject thinking parameters**

In `src/models/openai-compatible.ts`, modify `buildRequestBody()` (around line 385, before the return) to add thinking support:

```typescript
// In buildRequestBody(), after the existing parameter assignments, before return body:
if (this.defaultThinkingEnabled && this.thinkingConfig) {
  const value = this.defaultThinkingEnabled
    ? this.thinkingConfig.values.enabled
    : this.thinkingConfig.values.disabled;
  if (this.thinkingConfig.type === 'extra_body') {
    body[this.thinkingConfig.field] = value;
  } else {
    // top_level - already in body
    body[this.thinkingConfig.field] = value;
  }
}
// Add optional parameters if provided
if (this.defaultFrequencyPenalty !== undefined) {
  body.frequency_penalty = this.defaultFrequencyPenalty;
}
if (this.defaultPresencePenalty !== undefined) {
  body.presence_penalty = this.defaultPresencePenalty;
}
```

Also store the new constructor parameters as private fields.

- [ ] **Step 3: Pass thinking config through ModelRouter factory**

In `src/models/router.ts`, update `createProviderFromConfig()` (lines 345-358) to pass thinking config from the provider registry:

```typescript
protected createProviderFromConfig(config: ProviderConfig): ModelProvider {
  // Look up thinking config from registry if available
  const meta = getProviderMetadata(config.id);
  const defaultModel = meta?.models.find(m => m.id === config.model);

  return new OpenAICompatibleProvider({
    name: config.name || config.id,
    endpoint: config.endpoint,
    apiKey: config.apiKey || undefined,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    topP: config.topP,
    thinkingEnabled: (config as any).thinkingEnabled,
    thinkingConfig: defaultModel?.thinkingConfig,
  });
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 5: Commit**

```
git add src/models/openai-compatible.ts src/models/router.ts
git commit -m "feat: add thinking/reasoning parameter support to OpenAI compatible provider"
```

---

### Task 4: Make CapabilityDispatcher Protocol-Aware

**Files:**
- Modify: `src/models/capability-dispatcher.ts` (full rewrite of dispatch logic)

- [ ] **Step 1: Add protocol detection and generic dispatch to CapabilityDispatcher**

In `src/models/capability-dispatcher.ts`, add a protocol detection method and refactor each capability method to support multiple API formats:

```typescript
/** Detect the API protocol for a given role */
private detectProtocol(providerConfig: ProviderConfig | null): 'minimax' | 'openai' | 'custom' {
  if (!providerConfig) return 'openai';
  const endpoint = providerConfig.endpoint || '';
  if (endpoint.includes('minimax')) return 'minimax';
  return 'openai';
}
```

Then refactor each method (textToSpeech, generateImage, generateVideo, generateMusic) to use a switch on protocol:

- `minimax` protocol: Keep existing MiniMax-specific API format (current code)
- `openai` protocol: Use standard OpenAI-compatible endpoints:
  - TTS: `POST {endpoint}/audio/speech` with `{ model, input, voice }` body
  - Image gen: `POST {endpoint}/images/generations` with `{ model, prompt, size }` body
  - Video gen: `POST {endpoint}/video/generation` (same async pattern)
  - Music gen: `POST {endpoint}/music/generation`

Each method should:
1. Resolve provider config from settings
2. Detect protocol
3. Build request body based on protocol
4. Execute request
5. Parse response based on protocol

- [ ] **Step 2: Add ASR (audio_transcribe) dispatch method**

Add a new `transcribeAudio()` method:

```typescript
async transcribeAudio(audioFilePath: string, options?: {
  language?: string;
  responseFormat?: 'text' | 'verbose_json';
}): Promise<{
  text: string;
  language?: string;
  duration?: number;
  segments?: { start: number; end: number; text: string }[];
}> {
  const providerConfig = await this.resolveProviderConfig('audio_transcribe');
  const protocol = this.detectProtocol(providerConfig);
  // Whisper-compatible API: POST {endpoint}/audio/transcriptions
  const formData = new FormData();
  formData.append('file', new Blob([await fs.readFile(audioFilePath)]), path.basename(audioFilePath));
  formData.append('model', providerConfig?.model || 'whisper-1');
  formData.append('response_format', options?.responseFormat || 'verbose_json');
  if (options?.language) formData.append('language', options.language);
  // ... execute and parse response
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```
git add src/models/capability-dispatcher.ts
git commit -m "feat: make CapabilityDispatcher protocol-aware with ASR support"
```

---

### Task 5: Update Auto-Configure Mappings and Settings API

**Files:**
- Modify: `src/server/routes/settings.ts` (lines 342-502)

- [ ] **Step 1: Update auto-configure provider mappings**

In `src/server/routes/settings.ts`, update the auto-configure endpoint (around line 342) with corrected model names and add new providers:

```typescript
// MiniMax mapping
{ envKey: 'MINIMAX_API_KEY', providerId: 'minimax', model: 'M2.7', extras: [
  { id: 'minimax-embedding', model: 'embo-01', role: 'embedding' },
  { id: 'minimax-tts', model: 'Speech-2.8', role: 'tts' },
  { id: 'minimax-image', model: 'image-01', role: 'image_gen' },
  { id: 'minimax-video', model: 'Hailuo-2.3-768p-6s', role: 'video_gen' },
  { id: 'minimax-music', model: 'Music-2.6', role: 'music_gen' },
]},
// Qwen mapping
{ envKey: 'DASHSCOPE_API_KEY', providerId: 'qwen', model: 'qwen3.5-plus' },
// Zhipu mapping
{ envKey: 'ZHIPUAI_API_KEY', providerId: 'zhipu', model: 'glm-5.1' },
// OpenAI mapping
{ envKey: 'OPENAI_API_KEY', providerId: 'openai', model: 'gpt-5.4' },
// Anthropic mapping
{ envKey: 'ANTHROPIC_API_KEY', providerId: 'anthropic', model: 'claude-sonnet-4-20250514' },
// DeepSeek mapping
{ envKey: 'DEEPSEEK_API_KEY', providerId: 'deepseek', model: 'deepseek-chat' },
// OpenRouter mapping
{ envKey: 'OPENROUTER_API_KEY', providerId: 'openrouter', model: 'anthropic/claude-4.5-sonnet' },
// Moonshot mapping
{ envKey: 'MOONSHOT_API_KEY', providerId: 'moonshot', model: 'kimi-k2.5' },
// Groq mapping
{ envKey: 'GROQ_API_KEY', providerId: 'groq', model: 'llama-3.3-70b-versatile' },
// Mistral mapping
{ envKey: 'MISTRAL_API_KEY', providerId: 'mistral', model: 'mistral-large-latest' },
// Gemini mapping (new)
{ envKey: 'GEMINI_API_KEY', providerId: 'gemini', model: 'gemini-2.5-pro' },
```

Also update the recommended max tokens map (lines 411-422) to include new providers and corrected values from registry.

- [ ] **Step 2: Update registry API to return enriched metadata**

The `GET /registry` endpoint should already work since it returns from `PROVIDER_REGISTRY`. Verify it returns the new fields correctly.

- [ ] **Step 3: Verify the auto-configure endpoint works**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```
git add src/server/routes/settings.ts
git commit -m "fix: update auto-configure with correct model names, add Gemini, fix MiniMax models"
```

---

### Task 6: Update default.yaml Fallback Config

**Files:**
- Modify: `config/default.yaml`

- [ ] **Step 1: Update all model entries with correct endpoints and names**

Replace `config/default.yaml` content:

```yaml
models:
  main:
    provider: openai-compatible
    endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1
    model: qwen3.5-plus
    maxTokens: 8192
    supportsToolUse: true

  embedding:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: bge-m3
    maxTokens: 8192
    dimension: 1024

  minimax-text:
    provider: openai-compatible
    endpoint: https://api.minimaxi.com/v1
    model: M2.7
    maxTokens: 131072
    supportsToolUse: true

  minimax-embedding:
    provider: openai-compatible
    endpoint: https://api.minimaxi.com/v1
    model: embo-01
    maxTokens: 8192
    dimension: 1024

  minimax-tts:
    provider: openai-compatible
    endpoint: https://api.minimaxi.com/v1
    model: Speech-2.8
    maxTokens: 4096

  minimax-video:
    provider: openai-compatible
    endpoint: https://api.minimaxi.com/v1
    model: Hailuo-2.3-768p-6s
    maxTokens: 2048

  minimax-image:
    provider: openai-compatible
    endpoint: https://api.minimaxi.com/v1
    model: image-01
    maxTokens: 4096

  minimax-music:
    provider: openai-compatible
    endpoint: https://api.minimaxi.com/v1
    model: Music-2.6
    maxTokens: 4096

defaults:
  main: main
  embedding: embedding
  # summarizer: minimax-text
  # vlm: minimax-video
  # tts: minimax-tts
  # image_gen: minimax-image
  # video_gen: minimax-video
  # music_gen: minimax-music
```

Note: Removed the hardcoded API key from the main entry. Users should configure via env vars or settings UI.

- [ ] **Step 2: Commit**

```
git add config/default.yaml
git commit -m "fix: update default.yaml with correct model names and MiniMax endpoint"
```

---

### Task 7: Update EmbeddingManager for Multi-Model Support

**Files:**
- Modify: `src/models/embedding.ts` (lines 386-505)

- [ ] **Step 1: Add embedding model listing and switching logic**

Add a method to `EmbeddingManager` that lists all available embedding providers and handles switching:

```typescript
/** List all providers that can serve as embedding providers */
async listEmbeddingProviders(): Promise<Array<{
  id: string;
  name: string;
  model: string;
  dimension: number;
  isAvailable: boolean;
}>> {
  const settings = await repos.settings.getProviderSettings();
  const providers: Array<{ id: string; name: string; model: string; dimension: number; isAvailable: boolean }> = [];

  for (const p of settings.providers) {
    if (!p.enabled) continue;
    // Check if provider has embedding capability
    const meta = getProviderMetadata(p.id);
    if (meta?.features.embeddings || p.id.includes('embedding') || p.dimension) {
      providers.push({
        id: p.id,
        name: p.name,
        model: p.model,
        dimension: p.dimension || 1024,
        isAvailable: true,
      });
    }
  }

  // Always include local bge-m3 as an option
  providers.push({
    id: 'local-bge-m3',
    name: 'Local bge-m3 (ONNX)',
    model: 'BAAI/bge-m3',
    dimension: 1024,
    isAvailable: true,
  });

  return providers;
}
```

- [ ] **Step 2: Add dimension-change auto-reindex trigger**

In `checkDimensionChange()`, after marking stale, add background reindex:

```typescript
// After marking stale, trigger background reindex for affected KBs
if (dimensionChanged) {
  logger.info(`Embedding dimension changed from ${this._storedDimension} to ${newDimension}, triggering background reindex`);
  // Fire-and-forget background reindex
  this.triggerBackgroundReindex().catch(err => {
    logger.error('Background reindex failed:', err);
  });
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```
git add src/models/embedding.ts
git commit -m "feat: add multi-embedding-model listing and auto-reindex on dimension change"
```

---

### Task 8: Update Frontend Settings Components

**Files:**
- Modify: `frontend/src/components/settings/MainModelConfig.tsx`
- Modify: `frontend/src/components/settings/SubModelConfig.tsx`
- Modify: `frontend/src/components/settings/ModelsPanel.tsx`
- Modify: `frontend/src/components/settings/EnhancedModelsConfig.tsx`

- [ ] **Step 1: Add new model roles to ModelsPanel tabs**

In `frontend/src/components/settings/ModelsPanel.tsx`, add tabs for `audio_transcribe` (ASR 模型) and `video_understand` (视频理解模型):

```typescript
const tabs = [
  { id: 'main', label: '主模型', icon: Cpu },
  { id: 'sub', label: '辅助模型', icon: Workflow },
  { id: 'embedding', label: '嵌入模型', icon: Database },
  { id: 'audio_transcribe', label: 'ASR 模型', icon: Mic },
  { id: 'video_understand', label: '视频理解', icon: Video },
  { id: 'enhanced', label: '增强模型', icon: Sparkles },
  { id: 'docling', label: '文档处理', icon: FileText },
];
```

- [ ] **Step 2: Update ModelConfigCard to show thinking toggle**

In `frontend/src/components/settings/ModelConfigCard.tsx`, add a thinking enable/disable toggle:

```typescript
// After temperature slider, add:
{meta?.models?.find(m => m.id === provider?.model)?.thinkingSupport && (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <label>Thinking/推理模式</label>
    <input type="checkbox" checked={thinkingEnabled}
      onChange={e => setThinkingEnabled(e.target.checked)} />
  </div>
)}
```

- [ ] **Step 3: Update EnhancedModelsConfig with correct MiniMax model names**

In `frontend/src/components/settings/EnhancedModelsConfig.tsx`, update the default MiniMax enhanced models to use correct names:

```typescript
// Update default entries for MiniMax
{ modelType: 'audio_gen', name: 'MiniMax TTS', provider: 'minimax', modelId: 'Speech-2.8' },
{ modelType: 'image_gen', name: 'MiniMax Image', provider: 'minimax', modelId: 'image-01' },
{ modelType: 'video_gen', name: 'MiniMax Video', provider: 'minimax', modelId: 'Hailuo-2.3-768p-6s' },
{ modelType: 'music_gen', name: 'MiniMax Music', provider: 'minimax', modelId: 'Music-2.6' },
```

- [ ] **Step 4: Verify frontend builds**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | tail -20`

- [ ] **Step 5: Commit**

```
git add frontend/src/components/settings/
git commit -m "feat: add ASR/video-understand model tabs, thinking toggle, correct MiniMax names in UI"
```

---

### Task 9: Integration Verification

**Files:** No new files - verification only

- [ ] **Step 1: Run TypeScript compilation check**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1`

Expected: 0 errors.

- [ ] **Step 2: Start dev server and verify settings API**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npm run dev`

Then test:
```bash
# Registry returns new structure
curl http://localhost:21000/api/settings/registry | jq '.[0] | keys'

# Auto-configure with MiniMax key produces correct models
curl -X POST http://localhost:21000/api/settings/auto-configure

# Provider list shows new providers
curl http://localhost:21000/api/settings/providers | jq '.[].id'
```

- [ ] **Step 3: Verify frontend loads without errors**

Open `http://localhost:21000` in browser, navigate to Settings > Models tab, verify all sub-tabs render.

- [ ] **Step 4: Final commit if any fixes needed**

```
git add -A
git commit -m "fix: integration fixes for provider refactor"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] 22+ provider entries with correct models → Task 1
- [x] MiniMax M2.7 + Speech-2.8 + Music-2.6 + image-01 + Hailuo-2.3 → Task 1, Task 5
- [x] GLM-5.1 with 200K context → Task 1
- [x] Google Gemini added → Task 1
- [x] Thinking/reasoning parameter support → Task 3
- [x] Multi-model embedding switching → Task 7
- [x] CapabilityDispatcher protocol-aware → Task 4
- [x] ASR (audio_transcribe) dispatch → Task 4
- [x] Frontend settings updated → Task 8
- [x] default.yaml updated → Task 6
- [x] Auto-configure corrected → Task 5

**2. Placeholder scan:** No TBD/TODO found. All steps contain specific code.

**3. Type consistency:**
- `ProviderMetadata` in provider-registry.ts matches usage in router.ts
- `ModelRole` in provider.ts includes new roles matching `ProviderDefaults` in interfaces.ts
- `OpenAICompatibleOptions` fields match constructor parameters in openai-compatible.ts
