// =============================================================================
// DeepAnalyze - TypeScript Type Definitions
// =============================================================================

// --- Session & Messages ---

export interface SessionInfo {
  id: string;
  title: string | null;
  kbScope?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface ChatReportData {
  id: string;
  title: string;
  content: string;
  summary?: string;
  references?: ChatReference[];
  entities?: ChatEntity[];
  createdAt: string;
}

export interface ChatReference {
  index: number;
  sourceDocId: string;
  sourceTitle: string;
  level?: string;
  snippet?: string;
}

export interface ChatEntity {
  name: string;
  type: string;
  occurrenceCount: number;
}

export interface PushedContent {
  type: string;
  title: string;
  data: string;
  format?: string;
  timestamp?: string;
  // File push fields (from push_file tool)
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  downloadUrl?: string;
}

export interface MessageInfo {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  report?: ChatReportData;
  pushedContents?: PushedContent[];
  /** Thinking/reasoning content from JSONL (not truncated) */
  thinkingContent?: string;
  media?: MediaAttachment[];
  /** Raw metadata from server (includes taskId for stream-to-server matching) */
  metadata?: Record<string, unknown>;
}

export interface MediaAttachment {
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ToolCallInfo {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  status: "running" | "completed" | "error";
  startedAt?: string;
  completedAt?: string;
  /** Full input from JSONL (complete, not truncated) */
  fullInput?: unknown;
  /** Full output from JSONL (complete, not truncated) */
  fullOutput?: string;
  /** Whether full output is available from JSONL */
  hasFullOutput?: boolean;
}

// --- JSONL Transcript Types ---

export interface TranscriptEntry {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export interface TranscriptTurn {
  turn: number;
  taskId: string;
  assistantContent: string;
  thinkingContent: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    output: string;
    persistedFilePath?: string;
    error?: boolean;
  }>;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface SessionTranscript {
  sessionId: string;
  meta?: Record<string, unknown>;
  userInput?: string;
  turns: TranscriptTurn[];
  compactBoundaries: Array<Record<string, unknown>>;
  subAgents: Array<Record<string, unknown>>;
  allEntries: TranscriptEntry[];
}

// --- Agent Todo Items ---

export interface TodoItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
}

// --- Agent Tasks ---

export interface AgentTaskInfo {
  id: string;
  agentType: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  input: string;
  output: string | null;
  error: string | null;
  parentId: string | null;
  sessionId: string | null;
  createdAt: string;
  completedAt: string | null;
  progress?: number;
}

export interface RunAgentResponse {
  taskId: string;
  status: string;
  output?: string;
  error?: string;
  turnsUsed?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface RunCoordinatedResponse {
  taskId: string;
  status: string;
}

// --- Provider / Settings ---

export interface ProviderConfig {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic" | "ollama";
  /** Registry provider type ID (e.g., "zhipu") for looking up defaults/metadata */
  registryId?: string;
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  supportsToolUse: boolean;
  enabled: boolean;
  temperature?: number;
  topP?: number;
  contextWindow?: number;
  dimension?: number;
}

export interface ProviderDefaults {
  main: string;
  summarizer: string;
  embedding: string;
  vlm: string;
  tts: string;
  image_gen: string;
  video_gen: string;
  music_gen: string;
  audio_transcribe?: string;
  video_understand?: string;
}

export interface ProviderSettings {
  providers: ProviderConfig[];
  defaults: ProviderDefaults;
}

// --- Enhanced Models ---

export type EnhancedModelType =
  | "image_gen"
  | "video_gen"
  | "music_gen"
  | "tts";

export interface EnhancedModelEntry {
  id: string;
  modelType: EnhancedModelType;
  name: string;
  description: string;
  providerId: string;
  model: string;
  enabled: boolean;
  capabilities: string[];
  priority: number;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderTestResult {
  success: boolean;
  status?: number;
  models?: string[];
  error?: string;
}

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
  thinkingSupport?: 'native' | 'compat' | 'experimental' | 'unsupported';
  thinkingConfig?: ThinkingConfig;
}

export interface ThinkingConfig {
  type: 'extra_body' | 'top_level';
  field: string;
  values: { enabled: unknown; disabled: unknown };
}

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

// --- Knowledge Base ---

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  documentCount?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface DocumentInfo {
  id: string;
  kbId: string;
  filename: string;
  folderPath: string;
  fileType: string;
  fileSize: number;
  status: "uploaded" | "parsing" | "compiling" | "indexing" | "quality_audit" | "linking" | "ready" | "error";
  createdAt: string;
  l1Preview?: string | null;
}

// --- Analysis Scope ---

export interface AnalysisScope {
  knowledgeBases: Array<{
    kbId: string;
    /** Legacy alias for kbId (some clients still send {id, type}). */
    id?: string;
    mode: "all" | "selected";
    /** Legacy alias for mode. */
    type?: "all" | "selected" | "full";
    documentIds?: string[];
  }>;
  webSearch: boolean;
}

// --- Wiki ---

export interface WikiPage {
  id: string;
  kbId: string;
  docId?: string;
  pageType: "abstract" | "overview" | "fulltext" | "entity" | "concept" | "report";
  title: string;
  content: string;
  tokenCount?: number;
  links?: WikiLink[];
  metadata?: Record<string, unknown>;
}

export interface WikiLink {
  sourcePageId: string;
  targetPageId: string;
  linkType: "forward" | "backward" | "entity_ref" | "concept_ref";
  entityName?: string;
}

// --- Reports ---

export interface ReportInfo {
  id: string;
  kbId: string;
  title: string;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PushedContentGroup {
  kbId: string;
  kbName: string;
  items: PushedContentItem[];
}

export interface PushedContentItem {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  pushedContent: {
    type: string;
    title: string;
    dataLength?: number;
    format?: string;
    timestamp?: string;
  };
  createdAt: string;
}

export interface ReportDetail extends ReportInfo {
  content: string;
}

export interface TimelineEvent {
  date: string;
  title: string;
  description: string;
  sourcePageId: string;
  sourceTitle: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  group?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  type: string;
}

// --- Plugins / Skills ---

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  toolNames: string[];
  agentTypes: string[];
  loadedAt: string;
  error?: string;
}

export interface AgentSkillInfo {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  modelRole: string;
  isActive: boolean;
  antiHallucinationLevel?: string;
  createdAt: string;
  updatedAt: string;
}

// --- WebSocket Events ---

export type WsEventType =
  | "message_chunk"
  | "message_complete"
  | "tool_call"
  | "tool_result"
  | "subtask_start"
  | "subtask_progress"
  | "subtask_complete"
  | "task_created"
  | "task_progress"
  | "task_complete"
  | "task_failed"
  | "error"
  | "pong";

export interface WsEvent {
  type: WsEventType;
  [key: string]: unknown;
}

export interface WsMessageChunk {
  type: "message_chunk";
  sessionId: string;
  messageId: string;
  content: string;
}

export interface WsMessageComplete {
  type: "message_complete";
  sessionId: string;
  messageId: string;
  content: string;
  toolCalls?: ToolCallInfo[];
}

export interface WsToolCall {
  type: "tool_call";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface WsToolResult {
  type: "tool_result";
  id: string;
  output: string;
  status: "completed" | "error";
}

export interface WsSubtaskStart {
  type: "subtask_start";
  taskId: string;
  agent: string;
  parentTaskId?: string;
}

export interface WsSubtaskProgress {
  type: "subtask_progress";
  taskId: string;
  progress: number;
  message?: string;
}

export interface WsSubtaskComplete {
  type: "subtask_complete";
  taskId: string;
  result: unknown;
}

export interface WsTaskEvent {
  type: "task_created" | "task_progress" | "task_complete" | "task_failed";
  taskId: string;
  [key: string]: unknown;
}

export interface WsError {
  type: "error";
  error: string;
  code?: string;
}

// --- Agent Settings ---

export interface AgentSettings {
  maxTurns: number;
  contextWindow: number;
  compactionBuffer: number;
  sessionMemoryInitThreshold: number;
  sessionMemoryUpdateInterval: number;
  microcompactKeepTurns: number;
  autoDreamIntervalHours: number;
  autoDreamSessionThreshold: number;
  subAgentMaxTurns: number;
  consecutiveErrorThreshold: number;
  stuckDetectionThreshold: number;
  outputTokenBudget: number;
  toolResultMaxTokens: number;
  proactiveCompactLowerRatio: number;
  proactiveCompactUpperRatio: number;
  reservedOutputTokens: number;
}

// --- Cron Jobs ---

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  message: string;
  action: string | null;
  enabled: boolean;
  channel: string | null;
  chatId: string | null;
  deliverResponse: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCronJobRequest {
  name: string;
  schedule: string;
  message?: string;
  action?: string | null;
  enabled?: boolean;
  channel?: string | null;
  chatId?: string | null;
  deliverResponse?: boolean;
}

export interface UpdateCronJobRequest extends Partial<CreateCronJobRequest> {}

export interface CronValidateResult {
  valid: boolean;
  description: string;
  nextRun: string | null;
}

// --- MCP Servers ---

export interface MCPServerConfig {
  id: string;
  name: string;
  type: "stdio" | "sse" | "streamable-http" | "websocket";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

export interface MCPServerStatus {
  id: string;
  name: string;
  status: "pending" | "connected" | "failed";
  toolCount: number;
  error?: string;
}

// --- Communication Channels ---

export type ChannelId = "feishu" | "dingtalk" | "wechat" | "qq" | "telegram" | "discord";

export interface ChannelInfo {
  id: ChannelId;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
}

export interface FeishuConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  encrypt_key?: string;
  verification_token?: string;
  allow_from: string[];
}

export interface DingTalkConfig {
  enabled: boolean;
  client_id: string;
  client_secret: string;
  allow_from: string[];
}

export interface WeChatConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  token: string;
  encoding_aes_key?: string;
  allow_from: string[];
}

export interface QQConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  allow_from: string[];
  markdown_enabled: boolean;
  group_markdown_enabled: boolean;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  proxy?: string;
  allow_from: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  application_id?: string;
  guild_id?: string;
  allow_from: string[];
}

export interface ChannelsConfig {
  feishu: FeishuConfig;
  dingtalk: DingTalkConfig;
  wechat: WeChatConfig;
  qq: QQConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
}

export interface ChannelTestResult {
  success: boolean;
  message: string;
}

export interface ChannelStatus {
  enabled: boolean;
  running: boolean;
  displayName: string;
}

// --- MinerU Document Processing Config ---

export interface MinerUConfig {
  apiUrl: string;
  defaultBackend: "hybrid-auto-engine" | "pipeline" | "vlm-auto-engine" | string;
  defaultLang: "ch" | "en" | "japan" | "korean" | string;
  formulaEnable: boolean;
  tableEnable: boolean;
  imageAnalysis: boolean;
  timeout: number;
  enabled: boolean;
}

// --- Docling Document Processing Config ---

export interface DoclingConfig {
  layout_model: string;
  ocr_engine: "rapidocr" | "easyocr" | "tesseract";
  ocr_backend: "torch" | "onnxruntime";
  table_mode: "accurate" | "fast";
  use_vlm: boolean;
  vlm_model: string;
  vlm_mode: "inline" | "api";
  parallelism?: number;
}

export interface DoclingModelEntry {
  id: string;
  name: string;
  path: string;
}

export interface DoclingModels {
  layout: DoclingModelEntry[];
  table: DoclingModelEntry[];
  vlm: DoclingModelEntry[];
  ocr: DoclingModelEntry[];
}

export type VlmContainerStatus = "running" | "stopped" | "starting" | "unavailable" | "error";

export interface VlmContainerInfo {
  status: VlmContainerStatus;
  containerId?: string;
  port: number;
  healthUrl: string;
  error?: string;
}

// --- UI State ---

export type TabId = "chat" | "knowledge" | "reports" | "tasks";

// ─── Hub (Worker ↔ Server) ──────────────────────────────

export interface HubSyncState {
  lastHeartbeat: string | null;
  lastConfigSync: string | null;
  configVersionCached: string | null;
  serverReachable: boolean;
  pendingNotifications: { type: string; message: string; timestamp: string }[];
  registeredWorkerId: string | null;
}

export interface MarketplaceSkillItem {
  slug: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  downloadCount: number;
  ratingAvg: number;
  reviewCount: number;
  publishedAt: string;
  compatibility: { minVersion: string; requiredTools?: string[]; requiredProviders?: string[] };
}

export interface MarketplaceSkillDetail extends MarketplaceSkillItem {
  prompt: string;
  tools: string[];
  modelRole: string;
  antiHallucinationLevel?: string;
}
