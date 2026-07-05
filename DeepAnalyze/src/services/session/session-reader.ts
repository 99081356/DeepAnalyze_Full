/**
 * Session Reader — reconstruct full sessions from JSONL transcripts.
 *
 * Capabilities:
 *   - readSession: full session with all tasks
 *   - readTaskTranscript: single task JSONL
 *   - readActiveChain: from last compact_boundary to end (crash recovery)
 *   - buildContextFromTranscript: rebuild ChatMessage[] for agent context
 */

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type {
  TranscriptEntry,
  ReconstructedSession,
  TurnReconstructed,
  ToolCallReconstructed,
  CompactBoundaryEntry,
  AssistantEntry,
  ThinkingEntry,
  ToolUseEntry,
  ToolResultEntry,
  TurnUsageEntry,
  SubAgentEntry,
  UserEntry,
  SessionMetaEntry,
} from "./entry-types.js";
import { getTranscriptPath as getTranscriptPathFromPaths } from "./session-paths.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Parse a JSONL file into an array of entries. */
async function parseJsonlFile(filePath: string): Promise<TranscriptEntry[]> {
  if (!existsSync(filePath)) return [];
  try {
    const content = await readFile(filePath, "utf-8");
    const entries: TranscriptEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ── SessionReader ───────────────────────────────────────────────────

export class SessionReader {
  /**
   * Read all JSONL transcripts for a session and reconstruct the full history.
   * Reads all {taskId}.jsonl files under data/sessions/{sessionId}/transcripts/
   */
  async readSession(dataDir: string, sessionId: string): Promise<ReconstructedSession> {
    const dir = join(dataDir, "sessions", sessionId, "transcripts");
    const allEntries: TranscriptEntry[] = [];
    const userContentByTaskId = new Map<string, string>();

    if (existsSync(dir)) {
      const files = await readdir(dir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      // Read all task transcripts in parallel
      const reads = jsonlFiles.map(async (file) => {
        const taskId = file.replace(".jsonl", "");
        const entries = await this.readTaskTranscript(dataDir, sessionId, taskId);
        // Extract user content for this task
        for (const entry of entries) {
          if (entry.type === "user") {
            userContentByTaskId.set(taskId, (entry as UserEntry).content);
            break;
          }
        }
        return entries;
      });
      const transcripts = await Promise.all(reads);
      for (const entries of transcripts) {
        allEntries.push(...entries);
      }

      // Sort by timestamp
      allEntries.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    }

    return this.reconstruct(allEntries, sessionId, userContentByTaskId);
  }

  /** Read a single task's JSONL transcript. */
  async readTaskTranscript(
    dataDir: string,
    sessionId: string,
    taskId: string,
  ): Promise<TranscriptEntry[]> {
    const filePath = getTranscriptPathFromPaths(dataDir, sessionId, taskId);
    return parseJsonlFile(filePath);
  }

  /**
   * Read the "active chain" — entries from the last compact_boundary to the end.
   * Used for crash recovery: we only need the context after the last compaction.
   */
  async readActiveChain(
    dataDir: string,
    sessionId: string,
    taskId: string,
  ): Promise<TranscriptEntry[]> {
    const entries = await this.readTaskTranscript(dataDir, sessionId, taskId);

    // Find the last compact boundary
    let lastBoundaryIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact_boundary") {
        lastBoundaryIdx = i;
        break;
      }
    }

    // Return everything from the boundary onward
    if (lastBoundaryIdx >= 0) {
      return entries.slice(lastBoundaryIdx);
    }
    return entries;
  }

  /**
   * Build ChatMessage[] from JSONL for agent context recovery.
   * Returns messages suitable for the LLM API format.
   */
  async buildContextFromTranscript(
    dataDir: string,
    sessionId: string,
    taskId: string,
    _maxTokens?: number,
  ): Promise<ChatMessageForContext[]> {
    const entries = await this.readActiveChain(dataDir, sessionId, taskId);
    return this.entriesToContextMessages(entries);
  }

  // ── Reconstruction ───────────────────────────────────────────────

  private reconstruct(
    allEntries: TranscriptEntry[],
    sessionId: string,
    userContentByTaskId?: Map<string, string>,
  ): ReconstructedSession {
    let meta: SessionMetaEntry | undefined;
    let userInput: string | undefined;
    const turns: TurnReconstructed[] = [];
    const compactBoundaries: CompactBoundaryEntry[] = [];
    const subAgents: SubAgentEntry[] = [];

    // Group entries by turn+taskId
    const turnMap = new Map<string, TurnReconstructed>();

    for (const entry of allEntries) {
      switch (entry.type) {
        case "session_meta":
          meta = entry as SessionMetaEntry;
          break;
        case "user":
          userInput = (entry as UserEntry).content;
          break;
        case "compact_boundary":
          compactBoundaries.push(entry as CompactBoundaryEntry);
          break;
        case "sub_agent":
          subAgents.push(entry as SubAgentEntry);
          break;
        case "assistant": {
          const e = entry as AssistantEntry;
          const key = `${e.taskId}:${e.turn}`;
          let turn = turnMap.get(key);
          if (!turn) {
            turn = { turn: e.turn, taskId: e.taskId, firstTimestamp: e.timestamp, userContent: "", assistantContent: "", thinkingContent: "", toolCalls: [] };
            turnMap.set(key, turn);
          }
          turn.assistantContent += e.content;
          break;
        }
        case "thinking": {
          const e = entry as ThinkingEntry;
          const key = `${e.taskId}:${e.turn}`;
          let turn = turnMap.get(key);
          if (!turn) {
            turn = { turn: e.turn, taskId: e.taskId, firstTimestamp: e.timestamp, userContent: "", assistantContent: "", thinkingContent: "", toolCalls: [] };
            turnMap.set(key, turn);
          }
          turn.thinkingContent += e.content;
          break;
        }
        case "tool_use": {
          const e = entry as ToolUseEntry;
          const key = `${e.taskId}:${e.turn}`;
          let turn = turnMap.get(key);
          if (!turn) {
            turn = { turn: e.turn, taskId: e.taskId, firstTimestamp: e.timestamp, userContent: "", assistantContent: "", thinkingContent: "", toolCalls: [] };
            turnMap.set(key, turn);
          }
          turn.toolCalls.push({
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            input: e.input,
            output: "", // Will be filled by matching tool_result
          });
          break;
        }
        case "tool_result": {
          const e = entry as ToolResultEntry;
          // Find the matching tool_use in the same turn
          const key = `${e.taskId}:${e.turn}`;
          const turn = turnMap.get(key);
          if (turn) {
            const tc = turn.toolCalls.find(
              (tc) => tc.toolCallId === e.toolCallId,
            );
            if (tc) {
              tc.output = e.output;
              tc.persistedFilePath = e.persistedFilePath;
              tc.error = e.error;
            }
          }
          break;
        }
        case "turn_usage": {
          const e = entry as TurnUsageEntry;
          const key = `${e.taskId}:${e.turn}`;
          const turn = turnMap.get(key);
          if (turn) {
            turn.usage = e.usage;
          }
          break;
        }
      }
    }

    // Sort turns by firstTimestamp (chronological) instead of by turn number
    const sortedTurns = Array.from(turnMap.values()).sort(
      (a, b) => new Date(a.firstTimestamp).getTime() - new Date(b.firstTimestamp).getTime(),
    );

    // Associate user content to the first turn of each taskId
    if (userContentByTaskId) {
      for (const [taskId, userContent] of userContentByTaskId) {
        const firstTurn = sortedTurns.find(t => t.taskId === taskId);
        if (firstTurn && !firstTurn.userContent) {
          firstTurn.userContent = userContent;
        }
      }
    }

    return {
      sessionId,
      meta,
      userInput,
      turns: sortedTurns,
      compactBoundaries,
      subAgents,
      allEntries,
    };
  }

  /** Convert entries to a format suitable for LLM context. */
  private entriesToContextMessages(
    entries: TranscriptEntry[],
  ): ChatMessageForContext[] {
    const messages: ChatMessageForContext[] = [];

    // Collect tool_use and tool_result pairs by toolCallId
    const toolUses = new Map<string, { name: string; input: unknown }>();
    const toolResults = new Map<string, { output: string; error?: boolean }>();

    // First pass: collect tool data
    for (const entry of entries) {
      if (entry.type === "tool_use") {
        const e = entry as ToolUseEntry;
        toolUses.set(e.toolCallId, { name: e.toolName, input: e.input });
      } else if (entry.type === "tool_result") {
        const e = entry as ToolResultEntry;
        toolResults.set(e.toolCallId, {
          output: e.output,
          error: e.error,
        });
      }
    }

    // Second pass: build messages
    let currentAssistantContent = "";
    let currentThinkingContent = "";

    const flushAssistant = () => {
      if (currentAssistantContent || currentThinkingContent) {
        const msg: ChatMessageForContext = {
          role: "assistant",
          content: currentAssistantContent,
        };
        if (currentThinkingContent) {
          msg.thinking = currentThinkingContent;
        }
        messages.push(msg);
        currentAssistantContent = "";
        currentThinkingContent = "";
      }
    };

    for (const entry of entries) {
      switch (entry.type) {
        case "user": {
          flushAssistant();
          messages.push({
            role: "user",
            content: (entry as UserEntry).content,
          });
          break;
        }
        case "assistant": {
          currentAssistantContent += (entry as AssistantEntry).content;
          break;
        }
        case "thinking": {
          currentThinkingContent += (entry as ThinkingEntry).content;
          break;
        }
        case "tool_use": {
          flushAssistant();
          const e = entry as ToolUseEntry;
          messages.push({
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: e.toolCallId,
                name: e.toolName,
                input: e.input,
              },
            ],
          });
          break;
        }
        case "tool_result": {
          const e = entry as ToolResultEntry;
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: e.toolCallId,
                content: e.output,
                is_error: e.error,
              },
            ],
          });
          break;
        }
        case "compact_boundary": {
          // Compact boundary marks context compression
          // The summary content becomes the new context start
          const e = entry as CompactBoundaryEntry;
          if (e.summaryContent) {
            flushAssistant();
            messages.push({
              role: "system",
              content: `[Context Summary]\n${e.summaryContent}`,
            });
          }
          break;
        }
      }
    }

    flushAssistant();
    return messages;
  }
}

// ── Context message types ───────────────────────────────────────────

export interface ChatMessageForContext {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  thinking?: string;
}

export type ContentBlock =
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };
