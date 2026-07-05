/**
 * openai-compatible.ts - OpenAI-compatible protocol adapter
 *
 * Implements the ModelProvider interface for any backend that exposes an
 * OpenAI-compatible chat completions endpoint (Ollama, LM Studio, vLLM,
 * LiteLLM, etc.).
 *
 * Uses the standard `fetch` API so it works in both Bun and Node (>=18).
 */

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ContentPart,
  ModelProvider,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from "./provider";
import { withRetry } from "../utils/retry.js";

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface OpenAICompatibleOptions {
  /** Human-readable name for this provider instance. */
  name: string;

  /** Base endpoint URL (e.g. "http://localhost:11434/v1"). */
  endpoint: string;

  /** API key - sent as Bearer token. Optional for local backends. */
  apiKey?: string;

  /** Default model to use when ChatOptions.model is not provided. */
  model: string;

  /** Default maximum tokens for responses. When omitted or 0, the API provider decides. */
  maxTokens?: number;

  /** Default sampling temperature (0-2). */
  temperature?: number;

  /** Default nucleus sampling threshold (0-1). */
  topP?: number;

  /** Default top-k sampling. */
  topK?: number;

  /** Default frequency penalty. */
  frequencyPenalty?: number;

  /** Default presence penalty. */
  presencePenalty?: number;

  /** Whether thinking/reasoning mode is enabled by default. */
  thinkingEnabled?: boolean;

  /** Configuration for passing thinking/reasoning parameters. */
  thinkingConfig?: {
    type: 'extra_body' | 'top_level';
    field: string;
    values: { enabled: unknown; disabled: unknown };
  };
}

// ---------------------------------------------------------------------------
// Internal types for the OpenAI API wire format
// ---------------------------------------------------------------------------

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  /** Reasoning details from thinking models (e.g. MiniMax M2.7). Must be preserved in history. */
  reasoning_details?: unknown[];
}

interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }[];
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  id: string;
  object: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number | undefined;
  private readonly defaultTemperature: number | undefined;
  private readonly defaultTopP: number | undefined;
  private readonly defaultTopK: number | undefined;
  private readonly defaultFrequencyPenalty: number | undefined;
  private readonly defaultPresencePenalty: number | undefined;
  private readonly defaultThinkingEnabled: boolean | undefined;
  private readonly thinkingConfig: OpenAICompatibleOptions['thinkingConfig'];

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    // Trim trailing slash so we can safely append paths
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.defaultMaxTokens = options.maxTokens;
    this.defaultTemperature = options.temperature;
    this.defaultTopP = options.topP;
    this.defaultTopK = options.topK;
    this.defaultFrequencyPenalty = options.frequencyPenalty;
    this.defaultPresencePenalty = options.presencePenalty;
    this.defaultThinkingEnabled = options.thinkingEnabled;
    this.thinkingConfig = options.thinkingConfig;
  }

  // -----------------------------------------------------------------------
  // chat() - non-streaming completion
  // -----------------------------------------------------------------------

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    const url = `${this.endpoint}/chat/completions`;
    const body = this.buildRequestBody(messages, options, false);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await withRetry(
      async () => {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        });

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "unknown error");
          throw new Error(
            `OpenAI-compatible provider "${this.name}" returned HTTP ${resp.status}: ${errorText}`,
          );
        }

        return resp;
      },
      {
        maxRetries: 2,
        baseDelayMs: 500,
        signal: options.signal,
        isRetryable: (err) => {
          // Never retry if the parent signal (user cancellation / workflow abort) fired.
          if (options.signal?.aborted) return false;
          if (err instanceof Error) {
            const msg = err.message;
            return /HTTP (429|500|502|503|504)/.test(msg) ||
                   /timeout|ECONNREFUSED|ECONNRESET|fetch failed|rate.?limit|too many requests|aborted/i.test(msg);
          }
          return false;
        },
      },
    );

    let data: OpenAIResponse;
    try {
      data = (await response.json()) as OpenAIResponse;
    } catch (err) {
      throw new Error(
        `OpenAI-compatible provider "${this.name}" returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!data.choices || data.choices.length === 0) {
      throw new Error(
        `OpenAI-compatible provider "${this.name}" returned no choices`,
      );
    }

    const choice = data.choices[0];
    const content = choice.message?.content ?? "";
    const toolCalls = this.parseToolCalls(choice);

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            cachedTokens: (data.usage as Record<string, unknown>).prompt_tokens_details
              ? ((data.usage as Record<string, unknown>).prompt_tokens_details as Record<string, unknown>)?.cached_tokens as number | undefined
              : undefined,
          }
        : undefined,
      finishReason: choice.finish_reason ?? undefined,
      reasoningDetails: (choice.message as Record<string, unknown>)?.reasoning_details as unknown[] | undefined,
    };
  }

  // -----------------------------------------------------------------------
  // chatStream() - SSE streaming completion
  // -----------------------------------------------------------------------

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const url = `${this.endpoint}/chat/completions`;
    const body = this.buildRequestBody(messages, options, true);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    // L1: Connection timeout — abort if the HTTP connection itself takes too long.
    // This prevents indefinite hangs when the model API is unreachable or the model
    // enters an infinite reasoning loop without producing any output.
    // IMPORTANT: AbortSignal.timeout() applies to the ENTIRE fetch lifecycle including
    // response body reading. We use a separate AbortController so the connection timeout
    // can be cleared once the response headers arrive, preventing it from aborting the
    // body stream during long-running model outputs (e.g., generating novel text).
    const CONNECTION_TIMEOUT_MS = 60_000; // 60s to establish connection
    const STREAM_IDLE_TIMEOUT_MS = 600_000; // 600s (10 min) max idle time between stream chunks — models like MiniMax M3 may pause for extended thinking during large tool call generation

    let response: Response;
    try {
      response = await withRetry(
        async () => {
          // Separate AbortController for connection timeout — cleared after headers arrive
          const connCtrl = new AbortController();
          const connTimer = setTimeout(() => connCtrl.abort(), CONNECTION_TIMEOUT_MS);
          const connectSignal = options.signal
            ? AbortSignal.any([options.signal, connCtrl.signal])
            : connCtrl.signal;
          try {
            const resp = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: connectSignal,
            });

            if (!resp.ok) {
              const errorText = await resp.text().catch(() => "unknown error");
              throw new Error(
                `OpenAI-compatible provider "${this.name}" returned HTTP ${resp.status}: ${errorText}`,
              );
            }

            return resp;
          } finally {
            // Connection established — clear timeout so it won't abort body stream
            clearTimeout(connTimer);
          }
        },
        {
          maxRetries: 2,
          baseDelayMs: 500,
          signal: options.signal,
          isRetryable: (err) => {
            // Never retry if the parent signal (user cancellation / workflow abort) fired.
            // Only retry connection-level aborts (our own connCtrl timeout).
            if (options.signal?.aborted) return false;
            if (err instanceof Error) {
              const msg = err.message;
              return /HTTP (429|500|502|503|504)/.test(msg) ||
                     /timeout|ECONNREFUSED|ECONNRESET|fetch failed|rate.?limit|too many requests|aborted/i.test(msg);
            }
            return false;
          },
        },
      );
    } catch (err) {
      yield {
        type: "error",
        error: `Network error from provider "${this.name}": ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      yield {
        type: "error",
        error: `Provider "${this.name}" returned HTTP ${response.status}: ${errorText}`,
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: `Provider "${this.name}" returned no response body for streaming request`,
      };
      return;
    }

    // Accumulator for tool calls that arrive across multiple SSE chunks
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    // Track usage from the final streaming chunk
    let streamUsage: { inputTokens: number; outputTokens: number; cachedTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number } | undefined;

    // Track reasoning_details from thinking models (e.g. MiniMax M2.7)
    let streamReasoningDetails: unknown[] | undefined;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // L1: Stream idle timeout — if no data arrives for STREAM_IDLE_TIMEOUT_MS,
    // abort the stream. This handles cases where the model enters extended
    // thinking and never produces output, or the connection silently drops.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const agentSignal = options.signal;
    const idleAbort = new AbortController();

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.warn(`[OpenAI-Compatible] Stream idle timeout (${STREAM_IDLE_TIMEOUT_MS}ms) reached for provider "${this.name}", aborting stream`);
        idleAbort.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    // Clean up timer when agent signal fires
    if (agentSignal) {
      agentSignal.addEventListener("abort", () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleAbort.abort();
      }, { once: true });
    }

    try {
      resetIdleTimer(); // Start idle timer for first chunk
      while (true) {
        // Race between reading next chunk and idle timeout
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idleAbort.signal.addEventListener("abort", () => {
              reject(new Error(`Stream idle timeout: no data received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s from provider "${this.name}"`));
            }, { once: true });
          }),
        ]);
        resetIdleTimer(); // Got data, reset idle timer

        const { done, value } = readResult;
        if (done) {
          // SSE stream closed without [DONE] sentinel — some providers (e.g. MiniMax)
          // close the connection when hitting max_tokens without sending [DONE].
          // Yield a done chunk with whatever finishReason was accumulated so the
          // caller knows the stream ended (rather than leaving finishReason undefined).
          yield { type: "done", finishReason: this.lastFinishReason, usage: streamUsage, reasoningDetails: streamReasoningDetails };
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // SSE lines are separated by double newlines
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "" || trimmed === ":") continue;

          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              // Emit final done chunk with accumulated usage and reasoning_details
              const finishReason = this.lastFinishReason;
              yield { type: "done", finishReason, usage: streamUsage, reasoningDetails: streamReasoningDetails };
              return;
            }

            try {
              const parsed = JSON.parse(data);
              this.processStreamChunk(parsed, toolCallAccumulator);

              // Capture usage from the final chunk (OpenAI sends usage in last chunk)
              if (parsed.usage) {
                const details = (parsed.usage as Record<string, unknown>).prompt_tokens_details as Record<string, unknown> | undefined;
                const cached = details?.cached_tokens;
                streamUsage = {
                  inputTokens: parsed.usage.prompt_tokens,
                  outputTokens: parsed.usage.completion_tokens,
                  cachedTokens: typeof cached === "number" ? cached : undefined,
                  cacheCreationTokens: undefined, // OpenAI doesn't expose cache creation tokens
                  cacheReadTokens: typeof cached === "number" ? cached : undefined,
                };
              }

              // Capture reasoning_details from thinking models (e.g. MiniMax M2.7)
              const msgReasoning = parsed.choices?.[0]?.message?.reasoning_details ?? parsed.choices?.[0]?.delta?.reasoning_details;
              if (Array.isArray(msgReasoning)) {
                streamReasoningDetails = msgReasoning;
              }
            } catch {
              // Skip malformed JSON lines silently
              continue;
            }

            // Yield chunks based on what was parsed
            yield* this.yieldStreamChunks(
              JSON.parse(data),
              toolCallAccumulator,
            );
          }
        }
      }
    } catch (err) {
      if (idleTimer) clearTimeout(idleTimer);
      if (options.signal?.aborted) {
        yield { type: "done", finishReason: "cancelled" };
      } else {
        yield {
          type: "error",
          error: `Stream error from provider "${this.name}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.releaseLock();
    }
  }

  // Track the last finish reason across stream chunks
  private lastFinishReason: string | undefined;

  // -----------------------------------------------------------------------
  // estimateTokens() - CJK-aware token estimation
  // -----------------------------------------------------------------------

  getApiKey(): string {
    return this.apiKey ?? "";
  }

  estimateTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;

      if (code > 0xffff) {
        // Supplementary plane: emoji and other 4-byte unicode
        tokens += 2;
      } else if (
        // CJK Unified Ideographs
        (code >= 0x4e00 && code <= 0x9fff) ||
        // CJK Extension A
        (code >= 0x3400 && code <= 0x4dbf) ||
        // CJK Compatibility Ideographs
        (code >= 0xf900 && code <= 0xfaff) ||
        // Hiragana
        (code >= 0x3040 && code <= 0x309f) ||
        // Katakana
        (code >= 0x30a0 && code <= 0x30ff) ||
        // Hangul Syllables
        (code >= 0xac00 && code <= 0xd7a3)
      ) {
        tokens += 1.5;
      } else if (code <= 0x7f) {
        // ASCII
        tokens += 0.25;
      } else {
        // Other non-ASCII in BMP (e.g. accented Latin, Cyrillic, etc.)
        tokens += 0.5;
      }
    }
    return Math.ceil(tokens);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const openaiMessages: OpenAIMessage[] = messages.map((msg) => {
      const oai: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.toolCallId) {
        oai.tool_call_id = msg.toolCallId;
      }
      if (msg.toolCalls) {
        oai.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }
      // Preserve reasoning_details for thinking models (e.g. MiniMax M2.7)
      if (msg.reasoningDetails) {
        oai.reasoning_details = msg.reasoningDetails;
      }
      // Translate __cache_control marker to cache_control field for
      // Anthropic-compatible proxies (harmless for pure OpenAI endpoints)
      if ((msg as unknown as Record<string, unknown>).__cache_control) {
        (oai as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" };
      }
      return oai;
    });

    // Prompt cache: mark system message with cache_control for Anthropic API
    // (harmless for non-Anthropic providers — they ignore unknown fields)
    if (openaiMessages.length > 0 && openaiMessages[0].role === "system") {
      (openaiMessages[0] as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }

    const body: Record<string, unknown> = {
      model: options.model ?? this.defaultModel,
      messages: openaiMessages,
      stream,
    };

    // Request usage stats in streaming mode (OpenAI-compatible API)
    if (stream) {
      body.stream_options = { include_usage: true };
    }

    // Only send max_tokens when explicitly configured.
    // When omitted, the API provider uses its own model-specific default,
    // which avoids mismatched limits across different providers.
    // Per-request overrides take precedence over provider defaults.
    const maxTokens = options.maxTokens ?? this.defaultMaxTokens;
    if (maxTokens > 0) {
      body.max_tokens = maxTokens;
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    } else if (this.defaultTemperature !== undefined) {
      body.temperature = this.defaultTemperature;
    }

    if (this.defaultTopP !== undefined) {
      body.top_p = this.defaultTopP;
    }

    if (options.tools && options.tools.length > 0) {
      const formatted = this.formatTools(options.tools);
      // Prompt cache: mark last tool with cache_control for Anthropic API
      if (formatted.length > 0) {
        (formatted[formatted.length - 1] as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" };
      }
      body.tools = formatted;
    }

    // Thinking/reasoning parameter injection
    if (this.defaultThinkingEnabled && this.thinkingConfig) {
      const value = this.defaultThinkingEnabled
        ? this.thinkingConfig.values.enabled
        : this.thinkingConfig.values.disabled;
      body[this.thinkingConfig.field] = value;
    }

    // Optional sampling parameters
    if (this.defaultTopK !== undefined) {
      body.top_k = this.defaultTopK;
    }
    if (this.defaultFrequencyPenalty !== undefined) {
      body.frequency_penalty = this.defaultFrequencyPenalty;
    }
    if (this.defaultPresencePenalty !== undefined) {
      body.presence_penalty = this.defaultPresencePenalty;
    }
    // Per-request overrides take precedence over provider defaults
    if (options.frequencyPenalty !== undefined) {
      body.frequency_penalty = options.frequencyPenalty;
    }

    return body;
  }

  private formatTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private parseToolCalls(
    choice: OpenAIChoice,
  ): ToolCall[] | undefined {
    const raw = choice.message?.tool_calls;
    if (!raw || raw.length === 0) return undefined;

    return raw.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }

  /**
   * Process a single SSE chunk to track tool call state.
   * We accumulate tool call fragments across stream chunks.
   */
  private processStreamChunk(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsed: any,
    accumulator: Map<number, { id: string; name: string; arguments: string }>,
  ): void {
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    // Track finish reason
    const finishReason = parsed.choices?.[0]?.finish_reason;
    if (finishReason) {
      this.lastFinishReason = finishReason;
    }

    // Handle tool call deltas
    const toolCalls = delta.tool_calls;
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const idx: number = tc.index ?? 0;
        const existing = accumulator.get(idx);

        if (tc.id) {
          // New tool call starting
          accumulator.set(idx, {
            id: tc.id,
            name: tc.function?.name ?? existing?.name ?? "",
            arguments: tc.function?.arguments ?? existing?.arguments ?? "",
          });
        } else if (existing) {
          // Continuation of existing tool call
          if (tc.function?.name) {
            existing.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            existing.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  /**
   * Yield StreamChunk instances from a parsed SSE JSON object.
   */
  private *yieldStreamChunks(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsed: any,
    accumulator: Map<number, { id: string; name: string; arguments: string }>,
  ): Generator<StreamChunk> {
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    // Text content delta
    if (typeof delta.content === "string" && delta.content !== "") {
      yield { type: "text", content: delta.content };
    }

    // Reasoning/thinking content (e.g., Qwen3.6-27B reasoning_content)
    const reasoningContent = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoningContent === "string" && reasoningContent !== "") {
      yield { type: "thinking", content: reasoningContent };
    }

    // Tool call deltas
    const toolCalls = delta.tool_calls;
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const idx: number = tc.index ?? 0;
        const accumulated = accumulator.get(idx);

        if (tc.id && accumulated) {
          // New tool call beginning - yield the complete tool call
          yield {
            type: "tool_call",
            toolCall: {
              id: accumulated.id,
              type: "function",
              function: {
                name: accumulated.name,
                arguments: accumulated.arguments,
              },
            },
            toolCallIndex: idx,
          };
        } else {
          // Delta for an ongoing tool call
          yield {
            type: "tool_call_delta",
            toolCall: {
              id: tc.id,
              type: "function",
              function: {
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              },
            },
            toolCallIndex: idx,
          };
        }
      }
    }
  }
}
