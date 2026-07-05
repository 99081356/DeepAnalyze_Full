import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import os from "os";
import { createTranscriptTool } from "../tools/transcript-tool.js";

const TMP = join(os.tmpdir(), "da-transcript-test-" + Date.now());
const TRANSCRIPT_DIR = join(TMP, "tmp", "transcripts");

const SAMPLE_TRANSCRIPT = {
  taskId: "task-abc-123",
  recordedAt: "2025-01-01T00:00:00Z",
  turnsUsed: 5,
  usage: { inputTokens: 1000, outputTokens: 500 },
  messageCount: 10,
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ],
};

beforeAll(async () => {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });
  // Write a valid transcript file
  await writeFile(
    join(TRANSCRIPT_DIR, "task-abc-123.json"),
    JSON.stringify(SAMPLE_TRANSCRIPT),
  );
  // Write a separate transcript file for path-based reading
  await writeFile(
    join(TMP, "custom-transcript.json"),
    JSON.stringify({ ...SAMPLE_TRANSCRIPT, taskId: "custom-task" }),
  );
  // Write an invalid JSON file
  await writeFile(
    join(TMP, "bad-transcript.json"),
    "this is not valid json {{{",
  );
});

afterAll(async () => {
  await rm(TMP, { recursive: true });
});

describe("subagent_transcript tool", () => {
  const tool = createTranscriptTool(TMP);

  // -----------------------------------------------------------------------
  // 1. No parameters returns error
  // -----------------------------------------------------------------------
  it("returns error when no task_id or path provided", async () => {
    const result = await tool.execute({});
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Either task_id or path");
  });

  // -----------------------------------------------------------------------
  // 2. Read by task_id
  // -----------------------------------------------------------------------
  it("reads transcript by task_id", async () => {
    const result = await tool.execute({ task_id: "task-abc-123" }) as Record<string, unknown>;
    expect(result.taskId).toBe("task-abc-123");
    expect(result.recordedAt).toBe("2025-01-01T00:00:00Z");
    expect(result.turnsUsed).toBe(5);
    expect(result.messageCount).toBe(10);
  });

  // -----------------------------------------------------------------------
  // 3. Read by path
  // -----------------------------------------------------------------------
  it("reads transcript by path", async () => {
    const result = await tool.execute({ path: join(TMP, "custom-transcript.json") }) as Record<string, unknown>;
    expect(result.taskId).toBe("custom-task");
  });

  // -----------------------------------------------------------------------
  // 4. Path takes priority over task_id
  // -----------------------------------------------------------------------
  it("path takes priority over task_id when both provided", async () => {
    const result = await tool.execute({
      task_id: "task-abc-123",
      path: join(TMP, "custom-transcript.json"),
    }) as Record<string, unknown>;
    // Should return the path-based content, not the task_id content
    expect(result.taskId).toBe("custom-task");
  });

  // -----------------------------------------------------------------------
  // 5. File not found
  // -----------------------------------------------------------------------
  it("returns error for non-existent task_id", async () => {
    const result = await tool.execute({ task_id: "nonexistent-task" });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  // -----------------------------------------------------------------------
  // 6. Invalid JSON file
  // -----------------------------------------------------------------------
  it("returns error for invalid JSON file", async () => {
    const result = await tool.execute({ path: join(TMP, "bad-transcript.json") });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Failed to read");
  });

  // -----------------------------------------------------------------------
  // 7. Transcript content format validation
  // -----------------------------------------------------------------------
  it("returns transcript with expected fields", async () => {
    const result = await tool.execute({ task_id: "task-abc-123" }) as Record<string, unknown>;

    expect(result).toHaveProperty("taskId");
    expect(result).toHaveProperty("recordedAt");
    expect(result).toHaveProperty("turnsUsed");
    expect(result).toHaveProperty("usage");
    expect(result).toHaveProperty("messageCount");
    expect(result).toHaveProperty("messages");

    // Types are correct
    expect(typeof result.taskId).toBe("string");
    expect(typeof result.turnsUsed).toBe("number");
    expect(typeof result.messageCount).toBe("number");
    expect(Array.isArray(result.messages)).toBe(true);
  });
});
