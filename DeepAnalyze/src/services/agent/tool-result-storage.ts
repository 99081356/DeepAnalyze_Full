import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { safeTruncateJSON } from "./json-truncate.js";
import { getSessionToolResultsDir } from "../session/session-paths.js";

/** Default max result size before persisting to disk */
const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Max chars in the preview when result is persisted */
const PREVIEW_MAX_CHARS = 2_000;

/**
 * Resolve the base directory for session-scoped tool result persistence.
 * Delegates to the centralized session-paths module.
 */
function getSessionToolResultDir(dataDir: string, sessionId: string): string {
  return getSessionToolResultsDir(dataDir, sessionId);
}

/**
 * Clean up all persisted tool results for a session.
 * No-op: session deletion now removes the entire session directory tree,
 * so tool-results are cleaned up automatically.
 */
export async function cleanupSessionToolResults(
  _dataDir: string,
  _sessionId: string,
): Promise<void> {
  // Intentionally empty — session directory removal handles this.
}

export interface PersistedResult {
  /** Whether the result was persisted to disk */
  persisted: boolean;
  /** The content to return to the model */
  content: string;
  /** File path where full result was saved (only if persisted=true) */
  filePath?: string;
}

/**
 * Check if a tool result is large enough to persist to disk.
 * If so, write it and return a preview + file path.
 * If not, return the result as-is.
 *
 * Reference: refcode/claude-code/src/utils/toolResultStorage.ts
 */
export async function maybePersistToolResult(
  dataDir: string,
  toolName: string,
  result: string,
  sessionId: string,
  toolCallId: string,
  maxChars: number = DEFAULT_MAX_RESULT_SIZE_CHARS,
): Promise<PersistedResult> {
  if (result.length <= maxChars) {
    return { persisted: false, content: result };
  }

  const baseDir = getSessionToolResultDir(dataDir, sessionId);
  const filePath = path.join(baseDir, `${toolCallId}.txt`);

  try {
    if (!existsSync(baseDir)) {
      await mkdir(baseDir, { recursive: true });
    }

    await writeFile(filePath, result, { flag: "wx" });

    const preview = result.slice(0, PREVIEW_MAX_CHARS);
    const sizeKB = Math.round(result.length / 1024);
    const content =
      `<persisted-output>\n` +
      `Tool "${toolName}" produced a large result (${sizeKB}KB).\n` +
      `Full output saved to: ${filePath}\n` +
      `Preview (first ${PREVIEW_MAX_CHARS} chars):\n` +
      `${preview}\n` +
      `... [truncated, ${sizeKB}KB total]\n` +
      `</persisted-output>`;

    return { persisted: true, content, filePath };
  } catch {
    // Fallback: try to truncate valid JSON, otherwise plain truncation
    let truncated: string;
    try {
      JSON.parse(result);
      // Result was valid JSON — truncate it safely
      truncated = safeTruncateJSON(result, maxChars) + "\n... [truncated due to size]";
    } catch {
      truncated = result.slice(0, maxChars) + "\n... [truncated due to size]";
    }
    return { persisted: false, content: truncated };
  }
}
