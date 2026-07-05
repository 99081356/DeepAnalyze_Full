/**
 * provider.ts - Unified Model Provider interfaces and configuration schemas
 *
 * Defines the core abstraction layer for all LLM backends in DeepAnalyze.
 * Every provider must implement the ModelProvider interface.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Core message types
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ---------------------------------------------------------------------------
// Multimodal content types (OpenAI vision format)
// ---------------------------------------------------------------------------

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: {
    url: string;  // URL or data:image/...;base64,...
    detail?: "auto" | "low" | "high";
  };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** Optional message ID used for grouping assistant tool call rounds in compaction. */
  id?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Reasoning details from thinking models (e.g. MiniMax M2.7 reasoning_split). Must be preserved in history for model continuity. */
  reasoningDetails?: unknown[];
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Chat options & response types
// ---------------------------------------------------------------------------

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Enable prompt caching (adds cache_control to appropriate messages) */
  enableCaching?: boolean;
  /** Per-request frequency penalty override (0-2). Reduces repetition of identical tokens. */
  frequencyPenalty?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    /** Cache creation tokens (prompt cache write) */
    cacheCreationTokens?: number;
    /** Cache read tokens (prompt cache hit) */
    cacheReadTokens?: number;
  };
  finishReason?: string;
  /** Reasoning details from thinking models (e.g. MiniMax M2.7). Must be preserved in history. */
  reasoningDetails?: unknown[];
}

// ---------------------------------------------------------------------------
// Streaming types
// ---------------------------------------------------------------------------

export interface StreamChunk {
  type: "text" | "tool_call" | "tool_call_delta" | "done" | "error" | "thinking";
  content?: string;
  toolCall?: Partial<ToolCall>;
  /** Index of the tool call in the parallel tool call array. Used to route deltas correctly. */
  toolCallIndex?: number;
  finishReason?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  /** Reasoning details from thinking models (e.g. MiniMax M2.7). Included in the done chunk. */
  reasoningDetails?: unknown[];
}

// ---------------------------------------------------------------------------
// ModelProvider - the contract every backend adapter must satisfy
// ---------------------------------------------------------------------------

export interface ModelProvider {
  /** Human-readable name for this provider (e.g. "ollama-local") */
  readonly name: string;

  /** Send a chat completion request and return the full response. */
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse>;

  /** Stream a chat completion, yielding chunks as they arrive. */
  chatStream(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk>;

  /** Estimate the number of tokens for a given text string. */
  estimateTokens(text: string): number;

  /** Get the current API key (for auth profile tracking). Optional. */
  getApiKey?(): string;
}

// ---------------------------------------------------------------------------
// Zod schemas for YAML config validation
// ---------------------------------------------------------------------------

/** Schema for a single model entry in the config file. */
export const ModelConfigSchema = z.object({
  /** Provider type. */
  provider: z.enum(["openai-compatible", "anthropic-compatible"]),

  /** Base endpoint URL (e.g. "http://localhost:11434/v1"). */
  endpoint: z.string().url(),

  /** API key - optional for local providers like Ollama. */
  apiKey: z.string().optional(),

  /** Model identifier (e.g. "qwen2.5-14b"). */
  model: z.string(),

  /** Maximum tokens the model can generate in a single response. 0 = let API decide. */
  maxTokens: z.number().min(0).default(0),

  /** Whether the model supports tool/function calling. */
  supportsToolUse: z.boolean().default(false),

  /** Dimension of embedding vectors (only for embedding models). */
  dimension: z.number().positive().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** Schema for the defaults section. */
export const DefaultsConfigSchema = z.object({
  /** Name of the default main model. */
  main: z.string().default("main"),

  /** Name of the default summarizer model (optional). */
  summarizer: z.string().optional(),

  /** Name of the default embedding model (optional). */
  embedding: z.string().optional(),

  /** Name of the default vision-language model (optional). */
  vlm: z.string().optional(),

  /** Name of the default TTS model (optional). */
  tts: z.string().optional(),

  /** Name of the default image generation model (optional). */
  image_gen: z.string().optional(),

  /** Name of the default video generation model (optional). */
  video_gen: z.string().optional(),

  /** Name of the default music generation model (optional). */
  music_gen: z.string().optional(),

  /** Name of the default audio transcription model (optional). */
  audio_transcribe: z.string().optional(),

  /** Name of the default video understanding model (optional). */
  video_understand: z.string().optional(),
});

export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

/** Top-level configuration file schema. */
export const AppConfigSchema = z.object({
  /** Named model configurations. */
  models: z.record(z.string(), ModelConfigSchema),

  /** Default model assignments by role. */
  defaults: DefaultsConfigSchema.default({ main: "main" }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Role types for model selection. */
export type ModelRole =
  | "main"
  | "summarizer"
  | "embedding"
  | "vlm"
  | "tts"
  | "image_gen"
  | "video_gen"
  | "music_gen"
  | "audio_transcribe"
  | "video_understand";
