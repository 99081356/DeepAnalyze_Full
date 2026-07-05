import { writerRegistry } from "../../src/services/session/jsonl-writer.js";
import { existsSync } from "fs";
import { readFile, rm, mkdir } from "fs/promises";
import { join } from "path";

const TEST_SESSION = "test-isolation-001";
const TEST_TASK = "test-task-001";

async function main() {
  console.log("1. Creating writer...");
  const w = await writerRegistry.getOrCreate(TEST_SESSION, TEST_TASK);
  console.log("   Writer created:", w.constructor.name);

  console.log("2. Appending entries...");
  await w.append({ type: "session_meta", sessionId: TEST_SESSION });
  await w.append({ type: "user", content: "hello", sessionId: TEST_SESSION });
  await w.append({ type: "assistant", content: "world", turn: 1, taskId: TEST_TASK });
  await w.append({ type: "tool_use", toolCallId: "tc-1", toolName: "test_tool", input: { q: "hello" }, turn: 1, taskId: TEST_TASK });
  await w.append({ type: "tool_result", toolCallId: "tc-1", toolName: "test_tool", output: "result data here", turn: 1, taskId: TEST_TASK });

  console.log("3. Closing writer...");
  await writerRegistry.close(TEST_SESSION, TEST_TASK);

  console.log("4. Checking file...");
  const fp = join(process.cwd(), "data/sessions", TEST_SESSION, "transcripts", `${TEST_TASK}.jsonl`);
  console.log("   Path:", fp);
  console.log("   Exists:", existsSync(fp));

  if (existsSync(fp)) {
    const content = await readFile(fp, "utf-8");
    const lines = content.trim().split("\n");
    console.log(`   Lines: ${lines.length}`);
    for (const line of lines) {
      const entry = JSON.parse(line);
      console.log(`   - ${entry.type} (uuid: ${entry.uuid?.slice(0, 8)}..., parent: ${entry.parentUuid?.slice(0, 8) || "null"})`);
    }
  } else {
    console.log("   FILE NOT FOUND!");
  }

  // Cleanup
  try {
    await rm(join(process.cwd(), "data/sessions", TEST_SESSION), { recursive: true, force: true });
  } catch {}
}

main().catch(console.error);
