// =============================================================================
// DeepAnalyze - Long Output Continuation Support
// =============================================================================
// When model output is truncated (finish_reason === "length"):
// 1. Inject continuation message: "Please continue from where you left off."
// 2. Model continues generating the rest
// 3. Concatenate multiple outputs into the full result
//
// Reference: Claude Code's max_output_tokens recovery
// =============================================================================

export interface ContinuationConfig {
  /** Maximum number of continuation rounds */
  maxContinuations: number;
  /** Prompt to inject for continuation */
  continuationPrompt: string;
}

export const DEFAULT_CONTINUATION_CONFIG: ContinuationConfig = {
  maxContinuations: 5,
  continuationPrompt: "请继续输出，从上次中断的地方开始。不要重复已经输出的内容。",
};

/**
 * Check if the model output was truncated and needs continuation.
 * Handles both token-limit truncation ("length") and stream errors ("stream_error").
 *
 * NOTE: A previous version also triggered continuation on finishReason === "stop"
 * when the output did not end with sentence-ending punctuation. This heuristic
 * caused false positives — many legitimate outputs (code blocks, tables, bullet
 * lists, markdown headers) don't end with punctuation, and triggering continuation
 * on them produced duplicated/concatenated content. It has been removed.
 * Providers that report "stop" instead of "length" when truncating are now handled
 * by the max_output_tokens recovery tiers in agent-runner (which retries with
 * larger maxTokens) rather than by continuation injection.
 */
export function needsContinuation(finishReason?: string, _content?: string): boolean {
  if (finishReason === "length" || finishReason === "stream_error") return true;
  return false;
}

/**
 * Build a continuation message to inject.
 */
export function buildContinuationMessage(config?: Partial<ContinuationConfig>): {
  role: "user";
  content: string;
} {
  const prompt = config?.continuationPrompt ?? DEFAULT_CONTINUATION_CONFIG.continuationPrompt;
  return { role: "user" as const, content: prompt };
}

/**
 * Build a continuation message specifically for stream error recovery.
 * Tells the agent that the previous output was interrupted and it should continue.
 */
export function buildStreamErrorContinuationMessage(): {
  role: "user";
  content: string;
} {
  return {
    role: "user" as const,
    content: "[System-Notice] The previous response was interrupted by a stream error. " +
      "Please continue outputting from where you left off. Do not repeat already-output content. " +
      "If you were in the middle of generating content, pick up exactly at the point of interruption. " +
      "如果你之前的回复因流错误而中断，请从上次中断的地方继续输出，不要重复已输出的内容。",
  };
}

/**
 * Check if output is likely to be very long and should be segmented.
 */
export function shouldSegmentOutput(estimatedChars: number): boolean {
  return estimatedChars > 50_000;
}

/**
 * Get a suggestion message for segmented output.
 */
export function getSegmentationSuggestion(): string {
  return (
    "注意：预计输出内容较长。建议将结果分段写入文件（使用 write_file 工具），" +
    "每段不超过 20000 字符。最后提供完整的文件路径列表。"
  );
}
