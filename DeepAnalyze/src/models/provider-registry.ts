// =============================================================================
// DeepAnalyze - Provider Registry
// =============================================================================
// Rich provider catalog with model metadata, thinking profiles, and feature flags.
// Aligned with OpenClaw/CountBot/AIE reference implementations.
// Updated April 2026.
// =============================================================================

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
    isLocal: false, recommendedMaxTokens: 16384, contextWindow: 131072,
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
    isLocal: false, recommendedMaxTokens: 16384, contextWindow: 131072,
    features: { chat: true, embeddings: true, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: true },
    models: [
      chatModel('qwen3.6-plus', 'Qwen 3.6 Plus', 131072, 16384, true, true, true,
        { min: 0, max: 2, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'enable_thinking', values: { enabled: true, disabled: false } } }),
      chatModel('qwen3.5-plus', 'Qwen 3.5 Plus', 131072, 16384, true, false, true,
        { min: 0, max: 2, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'enable_thinking', values: { enabled: true, disabled: false } } }),
      chatModel('qwen3-plus', 'Qwen 3 Plus', 131072, 16384, true, false, true,
        { min: 0, max: 2, default: 1.0 }),
      chatModel('qwen-turbo', 'Qwen Turbo', 131072, 8192, true, false, true,
        { min: 0, max: 2, default: 1.0 }),
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
    // GLM exposes two distinct protocols:
    //  - /api/paas/v4    → OpenAI Chat Completions format
    //  - /api/anthropic  → Anthropic Messages format (cache_control + usage)
    // DeepAnalyze instantiates Zhipu via AnthropicCompatibleProvider, so the
    // endpoint MUST be the Anthropic path. Using /paas/v4 silently accepts the
    // request body but returns incomplete usage (input_tokens=0) and ignores
    // cache_control markers. See provider-endpoint-migration.ts for the
    // one-shot rewrite of legacy DB configs.
    apiBase: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-5.2',
    apiKeyEnvVar: 'ZHIPUAI_API_KEY',
    isLocal: false, recommendedMaxTokens: 131072, contextWindow: 1000000,
    features: { chat: true, embeddings: false, tts: false, imageGeneration: false, videoGeneration: false, musicGeneration: false, audioTranscription: false, vision: true },
    models: [
      chatModel('glm-5.2', 'GLM-5.2', 1000000, 131072, true, false, true,
        { min: 0, max: 1, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'thinking', values: { enabled: { type: 'enabled' }, disabled: { type: 'disabled' } } } }),
      chatModel('glm-5.1', 'GLM-5.1', 1000000, 131072, true, false, true,
        { min: 0, max: 1, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'thinking', values: { enabled: { type: 'enabled' }, disabled: { type: 'disabled' } } } }),
      chatModel('glm-5', 'GLM-5', 1000000, 131072, true, false, true,
        { min: 0, max: 1, default: 1.0 }),
      chatModel('glm-4.7-flash', 'GLM-4.7 Flash', 128000, 8192, true, true, true),
      chatModel('glm-4v-plus', 'GLM-5V-Turbo', 1000000, 131072, true, true, true),
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
    defaultModel: 'MiniMax-M3',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    isLocal: false, recommendedMaxTokens: 131072, contextWindow: 1000000,
    features: { chat: true, embeddings: true, tts: true, imageGeneration: true, videoGeneration: true, musicGeneration: true, audioTranscription: false, vision: true },
    models: [
      chatModel('MiniMax-M3', 'MiniMax M3', 1000000, 131072, true, true, true,
        { min: 0, max: 1, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'reasoning_split', values: { enabled: true, disabled: false } } }),
      chatModel('MiniMax-M2.7', 'MiniMax M2.7', 1000000, 131072, true, false, true,
        { min: 0, max: 1, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'reasoning_split', values: { enabled: true, disabled: false } } }),
      chatModel('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 1000000, 131072, true, false, true,
        { min: 0, max: 1, default: 1.0 },
        { support: 'native', config: { type: 'extra_body', field: 'reasoning_split', values: { enabled: true, disabled: false } } }),
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

/**
 * Resolve the PROVIDER_REGISTRY key for a given ProviderConfig.
 *
 * The config's `id` is typically an instance identifier like "minimax-highspeed",
 * while registry keys are provider types like "minimax".  This function bridges
 * the gap by trying three strategies in order:
 *
 * 1. config.registryId  – explicitly set by the settings UI
 * 2. config.id          – directly matches a registry key
 * 3. endpoint matching  – config.endpoint starts with a registry entry's apiBase
 */
export function resolveRegistryKey(config: { id?: string; registryId?: string; endpoint?: string }): string | undefined {
  // Strategy 1: explicit registryId
  if (config.registryId && PROVIDER_REGISTRY[config.registryId]) {
    return config.registryId;
  }

  // Strategy 2: id is already a registry key
  if (config.id && PROVIDER_REGISTRY[config.id]) {
    return config.id;
  }

  // Strategy 3: match by endpoint prefix
  const endpoint = (config.endpoint || '').replace(/\/+$/, '').toLowerCase();
  if (endpoint) {
    for (const [key, meta] of Object.entries(PROVIDER_REGISTRY)) {
      const base = (meta.apiBase || '').replace(/\/+$/, '').toLowerCase();
      if (base && endpoint.startsWith(base)) {
        return key;
      }
    }
  }

  return undefined;
}

/**
 * Look up the context window for a specific model ID from the registry.
 * Searches across all providers for a matching model.
 * Returns undefined if the model is not found.
 */
export function getContextWindowForModel(modelId: string): number | undefined {
  for (const provider of Object.values(PROVIDER_REGISTRY)) {
    const model = provider.models.find(m => m.id === modelId);
    if (model) return model.contextWindow;
  }
  return undefined;
}

/**
 * Get the maximum output tokens for a specific model ID from the registry.
 */
export function getMaxOutputTokensForModel(modelId: string): number | undefined {
  for (const provider of Object.values(PROVIDER_REGISTRY)) {
    const model = provider.models.find(m => m.id === modelId);
    if (model) return model.maxOutputTokens;
  }
  return undefined;
}

/**
 * Check whether a specific model ID supports vision (image input).
 * Searches across all providers for a matching model.
 * Returns false if the model is not found or does not support vision.
 */
export function getSupportsVision(modelId: string): boolean {
  for (const provider of Object.values(PROVIDER_REGISTRY)) {
    const model = provider.models.find(m => m.id === modelId);
    if (model) return model.supportsVision;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Model Deprecation
// ---------------------------------------------------------------------------

export interface ModelDeprecation {
  deprecatedId: string;
  replacementId: string;
  message: string;
  sunsetDate?: string;
}

/**
 * Known model deprecations. Add entries as providers retire models.
 */
export const MODEL_DEPRECATIONS: ModelDeprecation[] = [
  // Example:
  // { deprecatedId: "gpt-4", replacementId: "gpt-4o", message: "GPT-4 已被 GPT-4o 替代，建议尽快切换。" },
];

export function getDeprecationForModel(modelId: string): ModelDeprecation | undefined {
  return MODEL_DEPRECATIONS.find(d => d.deprecatedId === modelId);
}

// ---------------------------------------------------------------------------
// Model Pricing
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** Cost per million input tokens (USD) */
  inputPerMillion: number;
  /** Cost per million output tokens (USD) */
  outputPerMillion: number;
  /** Cost per million cache write tokens (USD). Undefined = same as input. */
  cacheWritePerMillion?: number;
  /** Cost per million cache read tokens (USD). Undefined = not billed separately. */
  cacheReadPerMillion?: number;
}

/**
 * Known model pricing data (USD per million tokens).
 * Sources: Anthropic, OpenAI, DeepSeek, Google public pricing pages (May 2026).
 * For models not listed here, cost tracking returns 0.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-opus-4-6": { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50 },
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30 },
  "anthropic/claude-4.5-sonnet": { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30 },
  "anthropic/claude-opus-4-6": { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50 },
  // OpenAI
  "gpt-5.4": { inputPerMillion: 10, outputPerMillion: 30 },
  "gpt-5.3": { inputPerMillion: 5, outputPerMillion: 15 },
  "gpt-4o": { inputPerMillion: 2.50, outputPerMillion: 10, cacheReadPerMillion: 1.25 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.60, cacheReadPerMillion: 0.075 },
  "o4-mini": { inputPerMillion: 1.10, outputPerMillion: 4.40, cacheReadPerMillion: 0.55 },
  "o3": { inputPerMillion: 10, outputPerMillion: 40, cacheReadPerMillion: 2.50 },
  "openai/gpt-5.4": { inputPerMillion: 10, outputPerMillion: 30 },
  // Google Gemini
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.315 },
  "gemini-2.5-flash": { inputPerMillion: 0.15, outputPerMillion: 0.60, cacheReadPerMillion: 0.0375 },
  "google/gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.315 },
  // DeepSeek
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.10, cacheReadPerMillion: 0.07 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19, cacheReadPerMillion: 0.14 },
  // Qwen (Alibaba Cloud)
  "qwen3.6-plus": { inputPerMillion: 0.80, outputPerMillion: 2.40 },
  "qwen3.5-plus": { inputPerMillion: 0.80, outputPerMillion: 2.40 },
  "qwen3-plus": { inputPerMillion: 0.80, outputPerMillion: 2.00 },
  "qwen-turbo": { inputPerMillion: 0.30, outputPerMillion: 0.60 },
  // Moonshot / Kimi
  "kimi-k2.5": { inputPerMillion: 4, outputPerMillion: 16 },
  // Zhipu / GLM
  "glm-5.2": { inputPerMillion: 5, outputPerMillion: 15 },
  "glm-5.1": { inputPerMillion: 5, outputPerMillion: 15 },
  "glm-5": { inputPerMillion: 5, outputPerMillion: 15 },
  // MiniMax
  "MiniMax-M2.7": { inputPerMillion: 1, outputPerMillion: 4 },
  "MiniMax-M2.7-highspeed": { inputPerMillion: 0.40, outputPerMillion: 1.60 },
};

/**
 * Look up pricing for a model ID.
 * Returns undefined if the model has no pricing data.
 */
export function getPricingForModel(modelId: string): ModelPricing | undefined {
  return MODEL_PRICING[modelId];
}
