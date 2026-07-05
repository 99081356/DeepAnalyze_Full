// =============================================================================
// DeepAnalyze - Sub-Agent Transcript Tool
// =============================================================================
// Allows the main agent to read transcript files from sub-agent executions
// for debugging and recovery purposes.
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Create the subagent_transcript tool.
 *
 * @param dataDir Root data directory for transcript storage
 */
export function createTranscriptTool(dataDir: string): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "subagent_transcript",
    description:
      "Read the execution transcript of a sub-agent run. " +
      "Transcripts contain the full message history (user prompts, assistant responses, tool calls, tool results) " +
      "for debugging sub-agent behavior or recovering from interrupted executions. " +
      "Provide either a task_id or a file path to the transcript.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID of the sub-agent whose transcript to read.",
        },
        path: {
          type: "string",
          description: "Direct file path to a transcript JSON file (alternative to task_id).",
        },
      },
    },
    async execute(input: Record<string, unknown>) {
      const taskId = input.task_id as string | undefined;
      const directPath = input.path as string | undefined;

      if (!taskId && !directPath) {
        return { error: "Either task_id or path must be provided." };
      }

      const transcriptPath = directPath ?? join(dataDir, "tmp", "transcripts", `${taskId}.json`);

      try {
        const content = await readFile(transcriptPath, "utf-8");
        const transcript = JSON.parse(content);

        // Return a condensed view for the agent
        return {
          taskId: transcript.taskId,
          recordedAt: transcript.recordedAt,
          turnsUsed: transcript.turnsUsed,
          usage: transcript.usage,
          messageCount: transcript.messageCount,
          messages: transcript.messages,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT")) {
          return { error: `Transcript not found at ${transcriptPath}. The sub-agent may not have recorded a transcript.` };
        }
        return { error: `Failed to read transcript: ${msg}` };
      }
    },
  };
}
