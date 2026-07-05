/**
 * anthropic-compatible.ts - Anthropic Messages API protocol adapter
 *
 * Implements the ModelProvider interface for any backend that exposes an
 * Anthropic-compatible Messages API endpoint (z.ai proxy, Anthropic direct, etc.).
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
import { splitSystemPromptForCache } from "../services/agent/prompt-cache.js";
import { getMaxOutputTokensForModel } from "./provider-registry.js";
import { withRetry } from "../utils/retry.js";

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface AnthropicCompatibleOptions {
  /** Human-readable name for this provider instance. */
  name: string;

  /** Base endpoint URL (e.g. "https://api.z.ai/api/anthropic/v1"). */
  endpoint: string;

  /** API key - sent as x-api-key header. */
  apiKey?: string;

  /** Default model to use when ChatOptions.model is not provided. */
  model: string;

  /** Default maximum tokens for responses. 0 = use model's max output from registry. */
  maxTokens?: number;

  /** Default sampling temperature (0-2). */
  temperature?: number;

  /** Default nucleus sampling threshold (0-1). */
  topP?: number;

  /** Default top-k sampling. */
  topK?: number;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class AnthropicCompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number | undefined;
  private readonly defaultTopP: number | undefined;
  private readonly defaultTopK: number | undefined;

  private readonly enablePromptCaching: boolean;

  constructor(options: AnthropicCompatibleOptions) {
    this.name = options.name;
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.defaultMaxTokens = options.maxTokens ?? 0;
    // Prompt caching: enabled for Anthropic direct + Zhipu GLM Anthropic-compatible endpoint.
    // GLM's /api/anthropic path follows Anthropic's cache_control spec and reports
    // cache_read_input_tokens in usage. Even on /paas/v4 (OpenAI-compat path that
    // tolerates Anthropic-format bodies), sending cache_control is harmless.
    // See `splitSystemPromptForCache` and prompt-cache.ts for the write side.
    this.enablePromptCaching =
      options.endpoint.includes("anthropic.com") ||
      options.endpoint.includes("bigmodel.cn");
    this.defaultTemperature = options.temperature;
    this.defaultTopP = options.topP;
    this.defaultTopK = options.topK;
  }

  // -----------------------------------------------------------------------
  // chat() - non-streaming completion
  // -----------------------------------------------------------------------

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    const url = `${this.endpoint}/messages`;
    const body = this.buildRequestBody(messages, options, false);

    const response = await withRetry(
      async () => {
        const resp = await fetch(url, {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: options.signal,
        });

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "unknown error");
          throw new Error(
            `Anthropic-compatible provider "${this.name}" returned HTTP ${resp.status}: ${errorText}`,
          );
        }

        return resp;
      },
      {
        maxRetries: 2,
        baseDelayMs: 500,
        signal: options.signal,
        isRetryable: (err) => {
          if (err instanceof Error) {
            const msg = err.message;
            return /HTTP (429|500|502|503|504)/.test(msg) ||
                   /timeout|ECONNREFUSED|ECONNRESET|fetch failed|rate.?limit|too many requests/i.test(msg);
          }
          return false;
        },
      },
    );

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Anthropic-compatible provider "${this.name}" returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.parseResponse(data);
  }

  // -----------------------------------------------------------------------
  // chatStream() - SSE streaming completion
  // -----------------------------------------------------------------------

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const url = `${this.endpoint}/messages`;
    const body = this.buildRequestBody(messages, options, true);

    let response: Response;
    try {
      response = await withRetry(
        async () => {
          const resp = await fetch(url, {
            method: "POST",
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: options.signal,
          });

          if (!resp.ok) {
            const errorText = await resp.text().catch(() => "unknown error");
            throw new Error(
              `Anthropic-compatible provider "${this.name}" returned HTTP ${resp.status}: ${errorText}`,
            );
          }

          return resp;
        },
        {
          maxRetries: 2,
          baseDelayMs: 500,
          signal: options.signal,
          isRetryable: (err) => {
            if (err instanceof Error) {
              const msg = err.message;
              return /HTTP (429|500|502|503|504)/.test(msg) ||
                     /timeout|ECONNREFUSED|ECONNRESET|fetch failed|rate.?limit|too many requests/i.test(msg);
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

    // Anthropic SSE: event types are message_start, content_block_start,
    // content_block_delta, content_block_stop, message_delta, message_stop
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    let streamUsage: { inputTokens: number; outputTokens: number; cachedTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number } | undefined;
    let finishReason: string | undefined;
    let hasContent = false;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventType = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "" || trimmed.startsWith(":")) continue;

          if (trimmed.startsWith("event: ")) {
            currentEventType = trimmed.slice(7).trim();
            continue;
          }

          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(dataStr);

              // event: error — SSE-level error from the provider (e.g. invalid
              // parameters). MUST be surfaced, otherwise the stream silently ends
              // with no content (the bug that masked GLM-5.2's max_tokens=1M
              // rejection: HTTP 200 + event:error, swallowed by the parser).
              if (currentEventType === "error" || parsed.type === "error") {
                const errObj = (parsed.error as Record<string, unknown> | undefined) ?? parsed;
                const errMsg = String(
                  (errObj as Record<string, unknown>).message ??
                  (errObj as Record<string, unknown>).error ??
                  JSON.stringify(parsed),
                );
                console.error(`[AnthropicCompat/${this.name}] Stream event:error — ${errMsg}`);
                yield { type: "error", error: `Provider "${this.name}" stream error: ${errMsg}` };
                return;
              }

              // message_start: capture initial usage.
              // Per Anthropic spec, message_start.usage contains input_tokens + output_tokens.
              // Some compatible providers (e.g. GLM on /paas/v4) may omit usage here and
              // only send it in message_delta — we merge both below.
              if (currentEventType === "message_start") {
                const msg = parsed.message as Record<string, unknown> | undefined;
                const usageSrc = (msg?.usage ?? parsed.usage) as Record<string, number> | undefined;
                if (usageSrc) {
                  streamUsage = {
                    inputTokens: usageSrc.input_tokens ?? 0,
                    outputTokens: usageSrc.output_tokens ?? 0,
                    cachedTokens: usageSrc.cache_read_input_tokens ?? 0,
                    cacheCreationTokens: usageSrc.cache_creation_input_tokens ?? undefined,
                    cacheReadTokens: usageSrc.cache_read_input_tokens ?? undefined,
                  };
                }
              }

              // content_block_start: new text or tool_use block
              if (currentEventType === "content_block_start") {
                const block = parsed.content_block as Record<string, unknown> | undefined;
                if (block?.type === "tool_use") {
                  const idx = parsed.index as number ?? 0;
                  toolCallAccumulator.set(idx, {
                    id: block.id as string ?? "",
                    name: block.name as string ?? "",
                    arguments: "",
                  });
                }
              }

              // content_block_delta: text or tool input streaming
              if (currentEventType === "content_block_delta") {
                const delta = parsed.delta as Record<string, unknown> | undefined;
                const idx = (parsed.index as number) ?? 0;

                if (delta?.type === "text_delta" && typeof delta.text === "string") {
                  hasContent = true;
                  yield { type: "text", content: delta.text };
                } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                  const acc = toolCallAccumulator.get(idx);
                  if (acc) {
                    acc.arguments += delta.partial_json;
                    yield {
                      type: "tool_call_delta",
                      toolCall: {
                        id: acc.id,
                        type: "function",
                        function: { name: acc.name, arguments: delta.partial_json },
                      },
                      toolCallIndex: idx,
                    };
                  }
                }
              }

              // content_block_stop: finalize tool call
              if (currentEventType === "content_block_stop") {
                const idx = (parsed.index as number) ?? 0;
                const acc = toolCallAccumulator.get(idx);
                if (acc) {
                  // Try to parse arguments as JSON to ensure valid format
                  try {
                    JSON.parse(acc.arguments);
                  } catch {
                    // If not valid JSON, try to fix common issues
                    if (!acc.arguments.startsWith("{")) {
                      acc.arguments = "{}";
                    }
                  }
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: acc.id,
                      type: "function",
                      function: { name: acc.name, arguments: acc.arguments },
                    },
                    toolCallIndex: idx,
                  };
                }
              }

              // message_delta: stop_reason and final usage.
              // Anthropic spec: message_delta.usage carries the FINAL full usage including
              // cache fields. GLM and other compat endpoints may also send input_tokens
              // here (not in message_start). Merge defensively.
              if (currentEventType === "message_delta") {
                const delta = parsed.delta as Record<string, unknown> | undefined;
                if (delta?.stop_reason) {
                  finishReason = this.mapStopReason(delta.stop_reason as string);
                }
                if (parsed.usage) {
                  const u = parsed.usage as Record<string, number>;
                  if (!streamUsage) {
                    streamUsage = { inputTokens: 0, outputTokens: 0 };
                  }
                  // message_delta carries the authoritative final usage — overwrite
                  // any placeholder values from message_start when present.
                  if (typeof u.input_tokens === "number") {
                    streamUsage.inputTokens = u.input_tokens;
                  }
                  if (typeof u.output_tokens === "number") {
                    streamUsage.outputTokens = u.output_tokens;
                  }
                  if (typeof u.cache_read_input_tokens === "number") {
                    streamUsage.cachedTokens = u.cache_read_input_tokens;
                    streamUsage.cacheReadTokens = u.cache_read_input_tokens;
                  }
                  if (typeof u.cache_creation_input_tokens === "number") {
                    streamUsage.cacheCreationTokens = u.cache_creation_input_tokens;
                  }
                }
              }

              // message_stop: stream complete
              if (currentEventType === "message_stop") {
                if (!hasContent && toolCallAccumulator.size === 0) {
                  console.warn(`[AnthropicCompat/${this.name}] Stream completed with no content. finishReason=${finishReason}, toolCount=${options.tools?.length ?? 0}`);
                }
                // Diagnostic: warn when usage is missing or shows zero input tokens.
                // This is the symptom of GLM/paas-v4 not returning Anthropic-format usage:
                // if observed, the provider is silently underreporting consumption.
                if (!streamUsage || streamUsage.inputTokens === 0) {
                  console.warn(
                    `[AnthropicCompat/${this.name}] message_stop with inputTokens=${streamUsage?.inputTokens ?? "undefined"}. ` +
                    `If provider is GLM-on-/paas/v4, switch endpoint to /api/anthropic for proper usage reporting.`,
                  );
                }
                yield { type: "done", finishReason, usage: streamUsage };
                return;
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch (err) {
      if (options.signal?.aborted) {
        yield { type: "done", finishReason: "cancelled" };
      } else {
        console.error(`[AnthropicCompat/${this.name}] Stream error: ${err instanceof Error ? err.message : String(err)}`);
        yield {
          type: "error",
          error: `Stream error from provider "${this.name}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } finally {
      reader.releaseLock();
    }
  }

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
        tokens += 2;
      } else if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3040 && code <= 0x309f) ||
        (code >= 0x30a0 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7a3)
      ) {
        tokens += 1.5;
      } else if (code <= 0x7f) {
        tokens += 0.25;
      } else {
        tokens += 0.5;
      }
    }
    return Math.ceil(tokens);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    // Enable prompt caching beta only for official Anthropic API
    if (this.enablePromptCaching) {
      headers["anthropic-beta"] = "prompt-caching-2024-07-31";
    }
    return headers;
  }

  private buildRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    // Extract system messages separately (Anthropic uses top-level system field)
    const systemParts: string[] = [];
    const anthropicMessages: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string"
          ? msg.content
          : msg.content.filter((p): p is ContentPart & { type: "text" } => "text" in p).map(p => p.text).join("\n");
        if (text) systemParts.push(text);
      } else if (msg.role === "tool") {
        // Convert tool result to Anthropic's tool_result content block
        const resultContent = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
        anthropicMessages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: resultContent,
          }],
        });
      } else if (msg.role === "assistant") {
        // Convert assistant message with potential tool_calls
        const content: Record<string, unknown>[] = [];

        // Add text content
        const text = typeof msg.content === "string"
          ? msg.content
          : msg.content.filter((p): p is ContentPart & { type: "text" } => "text" in p).map(p => p.text).join("\n");
        if (text) {
          content.push({ type: "text", text });
        }

        // Add tool_use blocks
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            let input: Record<string, unknown>;
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              input = {};
            }
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }

        anthropicMessages.push({ role: "assistant", content });
      } else {
        // user message — translate __cache_control marker if present
        const cacheControl = (msg as unknown as Record<string, unknown>).__cache_control as { type: string } | undefined;
        const content = msg.content;

        // Anthropic-format image block (distinct from internal OpenAI-style ContentPart).
        // The conversion below rewrites OpenAI image_url blocks into this shape.
        type AnthropicImageBlock = {
          type: "image";
          source:
            | { type: "base64"; media_type: string; data: string }
            | { type: "url"; url: string };
        };

        // Convert OpenAI-style image_url blocks to Anthropic image blocks
        let convertedContent: string | Array<ContentPart | AnthropicImageBlock> = content;
        if (Array.isArray(content)) {
          convertedContent = content.map((p: ContentPart) => {
            if ("image_url" in p && p.image_url) {
              const url: string = typeof p.image_url === "object" ? (p.image_url as { url: string }).url : String(p.image_url);
              if (url.startsWith("data:")) {
                // Parse data URI: data:image/jpeg;base64,/9j/4AAQ...
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  return {
                    type: "image",
                    source: { type: "base64", media_type: match[1], data: match[2] },
                  };
                }
              }
              // Non-data URL: keep as-is (Anthropic supports URL-based images too)
              return { type: "image", source: { type: "url", url } };
            }
            return p;
          });
        }

        if (cacheControl) {
          // Convert to content blocks with cache_control on the last block
          const contentBlocks: Record<string, unknown>[] =
            typeof convertedContent === "string"
              ? [{ type: "text", text: convertedContent }]
              : Array.isArray(convertedContent)
                ? convertedContent.map((p: ContentPart) => ({ type: "text", text: "text" in p ? p.text : "" }))
                : [{ type: "text", text: String(convertedContent) }];
          if (contentBlocks.length > 0) {
            contentBlocks[contentBlocks.length - 1].cache_control = { type: "ephemeral" };
          }
          anthropicMessages.push({ role: "user", content: contentBlocks });
        } else {
          anthropicMessages.push({ role: msg.role, content: convertedContent });
        }
      }
    }

    const body: Record<string, unknown> = {
      model: options.model ?? this.defaultModel,
      messages: anthropicMessages,
      stream,
    };

    // Anthropic-compatible APIs (including Anthropic direct) require max_tokens.
    // When maxTokens is 0 (meaning "use default"), look up the model's max output
    // from the registry; if not found, use a generous fallback.
    const requestedMaxTokens = options.maxTokens ?? this.defaultMaxTokens;
    const modelId = (options.model ?? this.defaultModel) as string;
    let maxTokens = requestedMaxTokens > 0
      ? requestedMaxTokens
      : (getMaxOutputTokensForModel(modelId) ?? 16_384);
    // Defensive clamp: some providers (e.g. GLM-5.2) reject max_tokens values
    // that exceed their actual output limit with a silent event:error in
    // streaming mode. Clamp to the registry's maxOutputTokens when known.
    const registryMax = getMaxOutputTokensForModel(modelId);
    if (registryMax && maxTokens > registryMax) {
      console.warn(`[AnthropicCompat/${this.name}] Clamping max_tokens ${maxTokens} → ${registryMax} (registry limit for ${modelId})`);
      maxTokens = registryMax;
    }
    body.max_tokens = maxTokens;

    // System prompt: use TextBlockParam[] with cache_control for prompt caching.
    // Only enable for official Anthropic API — third-party endpoints may not support it.
    if (systemParts.length > 0) {
      const fullSystem = systemParts.join("\n\n");
      if (this.enablePromptCaching) {
        body.system = splitSystemPromptForCache(fullSystem);
      } else {
        body.system = fullSystem;
      }
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    } else if (this.defaultTemperature !== undefined) {
      body.temperature = this.defaultTemperature;
    }

    if (this.defaultTopP !== undefined) {
      body.top_p = this.defaultTopP;
    }
    if (this.defaultTopK !== undefined) {
      body.top_k = this.defaultTopK;
    }

    if (options.tools && options.tools.length > 0) {
      const tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      // Mark last tool with cache_control for prompt caching (Anthropic only)
      if (this.enablePromptCaching && tools.length > 0) {
        (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
      }
      body.tools = tools;
    }

    return body;
  }

  private parseResponse(data: Record<string, unknown>): ChatResponse {
    const contentBlocks = (data.content as Record<string, unknown>[]) ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];

    for (const block of contentBlocks) {
      if (block.type === "text") {
        text += block.text as string ?? "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id as string,
          type: "function",
          function: {
            name: block.name as string,
            arguments: typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const stopReason = data.stop_reason as string | undefined;

    return {
      content: text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage
        ? {
            inputTokens: (data.usage as Record<string, number>).input_tokens ?? 0,
            outputTokens: (data.usage as Record<string, number>).output_tokens ?? 0,
          }
        : undefined,
      finishReason: stopReason ? this.mapStopReason(stopReason) : undefined,
    };
  }

  private mapStopReason(reason: string): string {
    switch (reason) {
      case "end_turn": return "stop";
      case "tool_use": return "tool_calls";
      case "max_tokens": return "length";
      case "stop_sequence": return "stop";
      default: return reason;
    }
  }
}
