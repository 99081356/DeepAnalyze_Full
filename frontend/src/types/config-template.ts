// =============================================================================
// Hub 配置模板类型定义
// =============================================================================
// 这些类型驱动配置模板的「可视化表单」视图。它们必须与 Worker 端
// sync-from-hub.ts 的消费契约对齐——表单产出的 JSON 必须能被 DA 的
// syncConfigFromHub() 正确 apply。
//
// 权威契约来源（DeepAnalyze/src/services/hub/types.ts:93 RecommendedConfig），
// 此处是 Hub 前端用的更精确版本（Worker 端用 unknown/Record 松散类型）。
//
// 关键约束（来自 sync-from-hub.ts）：
//   1. SYNC_KEYS = [providers, agentSettings, doclingConfig, enhancedModels, hooks]
//      这 5 个顶层 key 是「整体块」——要么不出现，要么整体替换本地值。
//   2. moduleStates 独立路径，每个模块单独判定（前缀匹配锁定）。
//   3. fieldLocks.lockedPaths 控制强制覆盖 vs 仅填空。
//   4. 锁定粒度：5 个 SYNC_KEYS 锁顶层 key（精确匹配），moduleStates 锁到
//      "moduleStates.<moduleId>"（前缀匹配）。无法锁子字段。
// =============================================================================

// ─── providers ───────────────────────────────────────────────────────────────

/** 单个 LLM 提供商实例（对齐 DA ProviderConfig） */
export interface TemplateProvider {
  id: string;
  name: string;
  type?: "openai-compatible" | "anthropic" | "ollama";
  registryId?: string;
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  supportsToolUse?: boolean;
  enabled: boolean;
  contextWindow?: number;
  dimension?: number;
  temperature?: number;
  topP?: number;
}

/**
 * 常见 provider 快速预设（轻量，不复制完整 registry）。
 * 长期方案是 Hub 后端暴露 registry API；首批用这份静态列表降低手填负担。
 * 新增 provider 时此处补充即可（DA 端 provider-registry.ts 是权威源）。
 */
export const PROVIDER_PRESETS: Array<{
  registryId: string;
  name: string;
  endpoint: string;
  defaultModel: string;
  isLocal?: boolean;
}> = [
  { registryId: "zhipu", name: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6" },
  { registryId: "deepseek", name: "DeepSeek", endpoint: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
  { registryId: "qwen", name: "通义千问", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3.5-plus" },
  { registryId: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  { registryId: "anthropic", name: "Anthropic", endpoint: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514" },
  { registryId: "moonshot", name: "Moonshot (Kimi)", endpoint: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-32k" },
  { registryId: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", defaultModel: "anthropic/claude-4.5-sonnet" },
  { registryId: "ollama", name: "Ollama (本地)", endpoint: "http://localhost:11434/v1", defaultModel: "llama3.1", isLocal: true },
];

/**
 * 10 个模型角色。key 是角色 ID（契约，不能改名），value 是 provider.id。
 * 空字符串表示该角色未绑定。
 */
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

/** 角色元数据（label + 中文说明，用于表单渲染） */
export const PROVIDER_ROLES: Array<{ key: keyof ProviderDefaults; label: string }> = [
  { key: "main", label: "主对话模型" },
  { key: "summarizer", label: "摘要模型" },
  { key: "embedding", label: "向量化模型" },
  { key: "vlm", label: "视觉理解模型" },
  { key: "tts", label: "语音合成" },
  { key: "image_gen", label: "图像生成" },
  { key: "video_gen", label: "视频生成" },
  { key: "music_gen", label: "音乐生成" },
  { key: "audio_transcribe", label: "语音转写 (ASR)" },
  { key: "video_understand", label: "视频理解" },
];

export interface TemplateProviders {
  providers: TemplateProvider[];
  defaults: ProviderDefaults;
}

// ─── agentSettings ───────────────────────────────────────────────────────────
// 字段比 Worker 后端的 DEFAULT_AGENT_SETTINGS 少（表单只暴露常用项），
// 其余字段不写入模板（保持 undefined，sync 时跳过）。
// 选项集照搬 Worker SettingsPanel 的离散 select。

export interface TemplateAgentSettings {
  maxTurns?: number;
  contextWindow?: number;
  outputTokenBudget?: number;
  compactionBuffer?: number;
  toolResultMaxTokens?: number;
  subAgentMaxTurns?: number;
  consecutiveErrorThreshold?: number;
  stuckDetectionThreshold?: number;
}

// ─── doclingConfig ───────────────────────────────────────────────────────────

export interface TemplateDoclingConfig {
  layout_model?: string;
  ocr_engine?: "rapidocr" | "easyocr" | "tesseract";
  ocr_backend?: "torch" | "onnxruntime";
  table_mode?: "accurate" | "fast";
  use_vlm?: boolean;
  vlm_mode?: "inline" | "api";
  vlm_model?: string;
  parallelism?: number;
}

// ─── moduleStates ────────────────────────────────────────────────────────────

export interface ModuleStateTemplate {
  status?: "not_installed" | "installing" | "installed" | "running" | "error";
  mode?: "local" | "remote" | "disabled";
  endpoint?: string;
}

/** 4 个固定模块的元数据（用于表单渲染） */
export const TEMPLATE_MODULES: Array<{
  id: string;
  label: string;
}> = [
  { id: "embedding", label: "嵌入模型 (BGE-M3)" },
  { id: "asr", label: "语音识别 (Whisper)" },
  { id: "docling", label: "文档解析 (Docling)" },
  { id: "mineru", label: "MinerU 解析" },
];

// ─── enhancedModels / hooks（列表型区块） ─────────────────────────────────────

export type EnhancedModelType =
  | "image_gen"
  | "video_gen"
  | "music_gen"
  | "tts"
  | "audio_gen";

export interface TemplateEnhancedModel {
  id: string;
  modelType: EnhancedModelType;
  name: string;
  description?: string;
  providerId: string;
  model: string;
  enabled: boolean;
  capabilities?: string[];
  priority?: number;
  maxTokens?: number;
}

/** hook 的 27 个事件枚举（对齐 DA hook-types.ts HookType） */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "AgentStart",
  "AgentComplete",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Elicitation",
  "ElicitationResult",
  "Notification",
  "ConfigChange",
  "FileChanged",
  "CwdChanged",
  "TeammateIdle",
  "Setup",
  "InstructionsLoaded",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookKind = "command" | "http" | "callback";

export interface TemplateHook {
  id: string;
  event: HookEvent;
  type: HookKind;
  matcher?: string;
  config?: {
    command?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  enabled: boolean;
}

// ─── 顶层 RecommendedConfig（表单产出的完整对象） ────────────────────────────

export interface TemplateContent {
  providers?: TemplateProviders | null;
  agentSettings?: TemplateAgentSettings | null;
  doclingConfig?: TemplateDoclingConfig | null;
  moduleStates?: Record<string, ModuleStateTemplate> | null;
  enhancedModels?: TemplateEnhancedModel[] | null;
  hooks?: TemplateHook[] | null;
  fieldLocks?: { lockedPaths: string[] };
}

/** 5 个 SYNC_KEYS（锁定用精确匹配顶层 key） */
export const SYNC_KEYS = [
  "providers",
  "agentSettings",
  "doclingConfig",
  "enhancedModels",
  "hooks",
] as const;

export type SyncKey = (typeof SYNC_KEYS)[number];
