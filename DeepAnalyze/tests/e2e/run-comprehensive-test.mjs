/**
 * Comprehensive test runner for T11-T80.
 * Usage: node tests/e2e/run-comprehensive-test.mjs <testId> <prompt> [--kb <kbId>] [--timeout <ms>]
 *
 * Uses POST /api/agents/run-stream (SSE) to run the agent.
 * Captures tool calls, push_contents, workflow events, text output, errors.
 * Uses Playwright for frontend screenshots.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = "http://localhost:21000";
const SCREENSHOT_DIR = join(__dirname, "screenshots");
const LOG_DIR = join(__dirname, "logs");

mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

// Parse args
const args = process.argv.slice(2);
const testId = args[0];
const prompt = args[1];
let kbScope = null;
let timeoutMs = 600000;

for (let i = 2; i < args.length; i++) {
  if (args[i] === "--kb" && args[i + 1]) { kbScope = args[++i]; }
  if (args[i] === "--timeout" && args[i + 1]) { timeoutMs = parseInt(args[++i]); }
}

if (!testId || !prompt) {
  console.error("Usage: node run-comprehensive-test.mjs <testId> <prompt> [--kb <kbId>] [--timeout <ms>]");
  process.exit(1);
}

const logFile = join(LOG_DIR, `${testId}.log`);
const resultFile = join(LOG_DIR, `${testId}.result.json`);

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  appendFileSync(logFile, line + "\n");
}

async function createSession(title, kbId) {
  const body = { title };
  if (kbId) {
    body.kbScope = { knowledgeBases: [{ kbId, mode: "all" }], webSearch: false };
  }
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.id;
}

async function runTest() {
  const startTime = Date.now();
  log(`=== Starting ${testId} ===`);
  log(`Prompt: ${prompt.substring(0, 200)}...`);
  log(`KB Scope: ${kbScope || "none"}`);
  log(`Timeout: ${timeoutMs}ms`);

  // Step 1: Create session with KB scope
  const sessionTitle = `${testId} - ${new Date().toISOString()}`;
  const sessionId = await createSession(sessionTitle, kbScope);
  log(`Session created: ${sessionId}`);

  // Step 2: Launch Playwright for screenshots
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${testId}-01-initial.png`) });
  log("Screenshot 01: initial state");

  // Step 3: Send the message via run-stream API and monitor SSE
  const toolCalls = [];
  const pushContents = [];
  const errors = [];
  const workflowEvents = [];
  const turnEvents = [];
  let fullText = "";
  let thinkingText = "";
  let messageDone = false;
  let currentEvent = null;
  let lastScreenshotTime = 0;

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    log(`TIMEOUT after ${timeoutMs}ms`);
    abortController.abort();
  }, timeoutMs);

  try {
    const sendRes = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: prompt,
      }),
      signal: abortController.signal,
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      log(`API Error ${sendRes.status}: ${errText.substring(0, 300)}`);
      errors.push(`API ${sendRes.status}: ${errText.substring(0, 200)}`);
    } else {
      const reader = sendRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newlines (SSE event boundaries)
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const evtBlock of events) {
          const lines = evtBlock.split("\n");
          let eventName = null;
          let eventData = null;

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventName = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              try {
                eventData = JSON.parse(line.slice(6));
              } catch (e) {
                // Non-JSON data
              }
            }
          }

          if (eventName && eventData) {
            handleSSEEvent(eventName, eventData);
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      log("Test aborted due to timeout");
    } else {
      log(`ERROR: ${err.message}`);
      errors.push(err.message);
    }
  }

  clearTimeout(timeoutHandle);

  function handleSSEEvent(eventName, data) {
    switch (eventName) {
      case "start":
        log(`Agent started: taskId=${data.taskId}, agentType=${data.agentType}`);
        break;

      case "content_delta":
        fullText += data.delta || "";
        // Take periodic screenshots during text output
        if (Date.now() - lastScreenshotTime > 30000) {
          const shotNum = Math.floor(toolCalls.length / 5) + 2;
          page.screenshot({ path: join(SCREENSHOT_DIR, `${testId}-${String(shotNum).padStart(2,"0")}-progress.png`) })
            .catch(() => {});
          lastScreenshotTime = Date.now();
        }
        break;

      case "thinking_delta":
        thinkingText += data.delta || "";
        break;

      case "content_reset":
        log(`Content reset: turn=${data.turn}, reason=${data.reason}`);
        fullText = "";
        break;

      case "turn":
        turnEvents.push({ turn: data.turn, time: Date.now() - startTime });
        log(`Turn ${data.turn} at ${(Date.now() - startTime) / 1000}s`);
        break;

      case "tool_call":
        toolCalls.push({
          name: data.toolName,
          input: typeof data.input === "string" ? data.input.substring(0, 300) : JSON.stringify(data.input).substring(0, 300),
          time: Date.now() - startTime,
        });
        log(`Tool: ${data.toolName} (${toolCalls.length} total) [turn ${data.turn || "?"}]`);
        break;

      case "tool_result":
        if (data.toolName === "push_content") {
          // Already handled via push_content event
        }
        break;

      case "push_content":
        pushContents.push({
          title: data.title,
          type: data.type,
          dataLength: data.dataLength,
          time: Date.now() - startTime,
        });
        log(`Push: "${data.title}" (${pushContents.length} total, ${data.dataLength} chars)`);
        break;

      case "workflow_event":
      case "workflow":
        workflowEvents.push({ ...data, time: Date.now() - startTime });
        log(`Workflow: ${data.event || data.mode || JSON.stringify(data).substring(0, 100)}`);
        // Take screenshot on workflow events
        const wfShotNum = 10 + workflowEvents.length;
        page.screenshot({ path: join(SCREENSHOT_DIR, `${testId}-wf-${workflowEvents.length}.png`) })
          .catch(() => {});
        break;

      case "error":
        log(`SSE Error: ${JSON.stringify(data).substring(0, 200)}`);
        errors.push(JSON.stringify(data));
        break;

      case "done":
      case "complete":
      case "message_end":
        messageDone = true;
        log(`Message completed at ${(Date.now() - startTime) / 1000}s`);
        break;

      default:
        // Log unknown events at debug level
        if (eventName !== "turn_usage" && eventName !== "reconnect_done") {
          log(`Event [${eventName}]: ${JSON.stringify(data).substring(0, 150)}`);
        }
        break;
    }
  }

  // Step 4: Capture final screenshots
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${testId}-02-final.png`) });
  log("Screenshot 02: final state");

  // Full page screenshot
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${testId}-03-fullpage.png`), fullPage: true });
  log("Screenshot 03: full page");

  await browser.close();

  // Step 5: Compile results
  const duration = Date.now() - startTime;
  const result = {
    testId,
    sessionId,
    duration,
    prompt: prompt.substring(0, 500),
    kbScope,
    toolCallCount: toolCalls.length,
    toolCalls,
    pushContentCount: pushContents.length,
    pushContents,
    workflowEventCount: workflowEvents.length,
    workflowEvents,
    turnCount: turnEvents.length,
    turns: turnEvents,
    errorCount: errors.length,
    errors,
    outputLength: fullText.length,
    outputPreview: fullText.substring(0, 5000),
    outputFull: fullText,
    thinkingLength: thinkingText.length,
    completed: messageDone,
  };

  writeFileSync(resultFile, JSON.stringify(result, null, 2));

  log(`=== ${testId} Complete ===`);
  log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  log(`Turns: ${turnEvents.length}`);
  log(`Tool calls: ${toolCalls.length}`);
  log(`Push contents: ${pushContents.length}`);
  log(`Workflow events: ${workflowEvents.length}`);
  log(`Errors: ${errors.length}`);
  log(`Output length: ${fullText.length} chars`);
  log(`Thinking length: ${thinkingText.length} chars`);
  log(`Completed: ${messageDone}`);

  console.log(`\n---TEST_SUMMARY---`);
  console.log(JSON.stringify({
    testId,
    duration: (duration / 1000).toFixed(1),
    turns: turnEvents.length,
    toolCalls: toolCalls.length,
    pushContents: pushContents.length,
    workflowEvents: workflowEvents.length,
    errors: errors.length,
    outputLength: fullText.length,
    completed: messageDone,
  }));
}

runTest().catch(err => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
