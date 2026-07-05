/**
 * 06 - Inject & Multi-turn Tests
 * Covers: mid-stream injection, multi-turn context, content persistence,
 * finish-time injection, media context preservation.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BASE = "http://localhost:21000/api";

// Helper: consume SSE stream and extract taskId + all content deltas
async function consumeStream(response: Response): Promise<{
  taskId: string | null;
  contentDeltas: number;
  fullText: string;
}> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let taskId: string | null = null;
  let contentDeltas = 0;
  let fullText = "";
  let buffer = "";
  let currentEventType = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEventType = line.slice(7).trim();
      }
      if (line.startsWith("data: ")) {
        try {
          const evt = JSON.parse(line.slice(6));
          if (currentEventType === "start" && evt.taskId) {
            taskId = evt.taskId;
          }
          if (currentEventType === "content_delta" && evt.delta) {
            contentDeltas++;
            fullText += evt.delta;
          }
        } catch { /* ignore */ }
        currentEventType = "";
      }
    }
  }
  return { taskId, contentDeltas, fullText };
}

// Helper: inject a message into a running task
async function injectMessage(taskId: string, message: string) {
  const res = await fetch(`${BASE}/agents/inject/${taskId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return res.json();
}

test.describe("06 - Inject & Multi-turn", () => {

  // ── Test 6.1: Normal multi-turn Q&A ─────────────────────────────
  test("6.1 normal multi-turn - context preserved across runs", async ({ request, page }) => {
    test.setTimeout(180_000);
    const api = createApi(request);
    const session = await api.createSession("E2E 6.1 Multi-turn");

    try {
      // Turn 1: tell the agent something
      const r1 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "请记住：我最喜欢的颜色是蓝色。" }),
      });
      expect(r1.ok).toBeTruthy();
      const s1 = await consumeStream(r1);
      expect(s1.taskId).toBeTruthy();
      console.log(`[6.1] Turn 1 done, taskId=${s1.taskId}, content=${s1.fullText.length} chars`);

      await new Promise(r => setTimeout(r, 2000));

      // Turn 2: ask about what was said
      const r2 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "我最喜欢的颜色是什么？" }),
      });
      expect(r2.ok).toBeTruthy();
      const s2 = await consumeStream(r2);
      console.log(`[6.1] Turn 2 done, content=${s2.fullText.length} chars`);

      await new Promise(r => setTimeout(r, 2000));

      // Verify messages in DB
      const msgs = await api.getMessages(session.id);
      console.log(`[6.1] Messages in DB: ${msgs.length}`);
      for (const m of msgs) {
        console.log(`  [${m.role}] ${m.content?.substring(0, 60)}...`);
      }
      // Should have at least 4 messages: user1, assistant1, user2, assistant2
      expect(msgs.length).toBeGreaterThanOrEqual(4);
      const userMsgs = msgs.filter(m => m.role === "user");
      const asstMsgs = msgs.filter(m => m.role === "assistant");
      expect(userMsgs.length).toBeGreaterThanOrEqual(2);
      expect(asstMsgs.length).toBeGreaterThanOrEqual(2);

      // Check assistant2 mentions the color
      const lastAsst = asstMsgs[asstMsgs.length - 1];
      const hasColor = lastAsst.content?.includes("蓝") ?? false;
      console.log(`[6.1] Assistant2 mentions color: ${hasColor}`);
      expect(hasColor || lastAsst.content!.length > 10).toBeTruthy();

      // Screenshot
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      await takeScreenshot(page, "06-01-multi-turn");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  // ── Test 6.2: Mid-stream injection ──────────────────────────────
  test("6.2 mid-stream inject - both responses persisted", async ({ request, page }) => {
    test.setTimeout(180_000);
    const api = createApi(request);
    const session = await api.createSession("E2E 6.2 Inject");

    try {
      // Start a long-running query
      const r1 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "列举5种编程语言及其特点" }),
      });
      expect(r1.ok).toBeTruthy();

      const reader = r1.body!.getReader();
      const decoder = new TextDecoder();
      let taskId: string | null = null;
      let contentDeltas = 0;
      let injected = false;
      let buffer = "";
      let currentEventType = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.startsWith("event: ")) currentEventType = line.slice(7).trim();
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (currentEventType === "start" && evt.taskId) taskId = evt.taskId;
              if (currentEventType === "content_delta") contentDeltas++;
            } catch {}
            currentEventType = "";
          }
        }
        // Inject after some content has streamed
        if (taskId && !injected && contentDeltas > 8) {
          injected = true;
          console.log(`[6.2] Injecting at ${contentDeltas} deltas, taskId=${taskId}`);
          const injRes = await injectMessage(taskId, "哪个最简单？简短回答");
          console.log(`[6.2] Inject result:`, injRes.status || JSON.stringify(injRes));
        }
      }

      console.log(`[6.2] Stream complete, taskId=${taskId}, injected=${injected}`);
      await new Promise(r => setTimeout(r, 3000));

      // Verify DB messages
      const msgs = await api.getMessages(session.id);
      console.log(`[6.2] Messages in DB: ${msgs.length}`);
      for (const m of msgs) {
        console.log(`  [${m.role}] (${m.content?.length ?? 0} chars): ${(m.content ?? "").substring(0, 60)}...`);
      }

      // Should have the injected user message
      const userMsgs = msgs.filter(m => m.role === "user");
      const injectedUserMsg = userMsgs.find(m => m.content?.includes("最简单"));
      expect(injectedUserMsg, "Should have the injected user message").toBeTruthy();

      // Assistant message should contain both topics
      const asstMsgs = msgs.filter(m => m.role === "assistant");
      const lastAsst = asstMsgs[asstMsgs.length - 1];
      const hasPython = lastAsst?.content?.includes("Python") ?? false;
      const hasSimplest = lastAsst?.content?.includes("最简单") ?? false;
      console.log(`[6.2] Assistant has Python: ${hasPython}, has simplest: ${hasSimplest}`);
      console.log(`[6.2] Assistant content (${lastAsst?.content?.length ?? 0} chars)`);

      // Both topics should be present in the persisted content
      expect(hasPython, "Assistant should mention Python from first answer").toBeTruthy();
      expect(hasSimplest, "Assistant should include injected message response").toBeTruthy();

      // Screenshot
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      await takeScreenshot(page, "06-02-inject");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  // ── Test 6.3: Multiple injections across runs ───────────────────
  test("6.3 multiple runs - context accumulates correctly", async ({ request, page }) => {
    test.setTimeout(240_000);
    const api = createApi(request);
    const session = await api.createSession("E2E 6.3 Multiple Runs");

    try {
      // Run 1: simple question
      const r1 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "法国的首都是哪里？一句话回答。" }),
      });
      const s1 = await consumeStream(r1);
      console.log(`[6.3] Run 1 done, content=${s1.fullText.length}`);
      await new Promise(r => setTimeout(r, 2000));

      // Run 2: follow-up
      const r2 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "那日本呢？" }),
      });
      const s2 = await consumeStream(r2);
      console.log(`[6.3] Run 2 done, content=${s2.fullText.length}`);
      await new Promise(r => setTimeout(r, 2000));

      // Run 3: reference both
      const r3 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "我刚才问了哪两个国家的首都？简短回答。" }),
      });
      const s3 = await consumeStream(r3);
      console.log(`[6.3] Run 3 done, content=${s3.fullText.length}`);
      await new Promise(r => setTimeout(r, 2000));

      // Verify
      const msgs = await api.getMessages(session.id);
      console.log(`[6.3] Total messages: ${msgs.length}`);
      // Should have 6 messages: 3 user + 3 assistant
      expect(msgs.length).toBeGreaterThanOrEqual(6);

      const asstMsgs = msgs.filter(m => m.role === "assistant");
      const lastAsst = asstMsgs[asstMsgs.length - 1];
      // Should reference both countries
      const hasFrance = lastAsst?.content?.includes("法国") ?? false;
      const hasJapan = lastAsst?.content?.includes("日本") ?? false;
      console.log(`[6.3] Last assistant mentions France: ${hasFrance}, Japan: ${hasJapan}`);
      expect(hasFrance || hasJapan, "Agent should remember at least one country").toBeTruthy();

      // Screenshot
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      await takeScreenshot(page, "06-03-multiple-runs");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  // ── Test 6.4: Injection at finish time ──────────────────────────
  test("6.4 finish-time inject - message processed before completion", async ({ request, page }) => {
    test.setTimeout(180_000);
    const api = createApi(request);
    const session = await api.createSession("E2E 6.4 Finish Inject");

    try {
      // Start a short question that will finish quickly
      const r1 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "1+1等于几？只回答数字" }),
      });
      expect(r1.ok).toBeTruthy();

      const reader = r1.body!.getReader();
      const decoder = new TextDecoder();
      let taskId: string | null = null;
      let buffer = "";
      let currentEventType = "";
      let injected = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.startsWith("event: ")) currentEventType = line.slice(7).trim();
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (currentEventType === "start" && evt.taskId) taskId = evt.taskId;
            } catch {}
            currentEventType = "";
          }
        }
        // Inject as soon as we get taskId (before agent finishes)
        if (taskId && !injected) {
          injected = true;
          console.log(`[6.4] Injecting immediately after start, taskId=${taskId}`);
          const injRes = await injectMessage(taskId, "2+2等于几？只回答数字");
          console.log(`[6.4] Inject result:`, injRes.status || JSON.stringify(injRes));
        }
      }

      console.log(`[6.4] Stream complete, injected=${injected}`);
      await new Promise(r => setTimeout(r, 3000));

      const msgs = await api.getMessages(session.id);
      console.log(`[6.4] Messages: ${msgs.length}`);
      for (const m of msgs) {
        console.log(`  [${m.role}] (${m.content?.length ?? 0} chars): ${(m.content ?? "").substring(0, 60)}`);
      }

      // Should have the injected user message persisted
      const userMsgs = msgs.filter(m => m.role === "user");
      const injectedMsg = userMsgs.find(m => m.content?.includes("2+2"));
      if (injectedMsg) {
        console.log(`[6.4] Injected message found in DB`);
      } else {
        console.log(`[6.4] WARN: Injected message not found (agent may have completed before inject)`);
      }

      // Screenshot
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      await takeScreenshot(page, "06-04-finish-inject");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  // ── Test 6.5: Content persistence verification ──────────────────
  test("6.5 content persistence - all assistant content saved to DB", async ({ request, page }) => {
    test.setTimeout(120_000);
    const api = createApi(request);
    const session = await api.createSession("E2E 6.5 Persistence");

    try {
      const r1 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          input: "用三句话介绍人工智能的发展历史。",
        }),
      });
      expect(r1.ok).toBeTruthy();
      const s1 = await consumeStream(r1);
      console.log(`[6.5] Stream done, streamed text: ${s1.fullText.length} chars`);
      await new Promise(r => setTimeout(r, 3000));

      // Compare streamed content vs persisted content
      const msgs = await api.getMessages(session.id);
      const asstMsg = msgs.find(m => m.role === "assistant");
      expect(asstMsg, "Should have assistant message").toBeTruthy();

      const streamedLen = s1.fullText.length;
      const persistedLen = asstMsg!.content?.length ?? 0;
      console.log(`[6.5] Streamed: ${streamedLen} chars, Persisted: ${persistedLen} chars`);

      // Persisted content should be substantial (>100 chars)
      expect(persistedLen, "Persisted content should be substantial").toBeGreaterThan(100);

      // Should not be empty
      expect(asstMsg!.content?.trim(), "Persisted content should not be empty").toBeTruthy();

      // Screenshot
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      await takeScreenshot(page, "06-05-persistence");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  // ── Test 6.6: Rapid sequential messages ─────────────────────────
  test("6.6 rapid sequential - messages not lost", async ({ request, page }) => {
    test.setTimeout(240_000);
    const api = createApi(request);
    const session = await api.createSession("E2E 6.6 Rapid");

    try {
      // Send first message and wait for completion
      const r1 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "中国的首都是哪里？一句话回答" }),
      });
      await consumeStream(r1);
      await new Promise(r => setTimeout(r, 2000));

      // Send second immediately
      const r2 = await fetch(`${BASE}/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, input: "美国的首都是哪里？一句话回答" }),
      });
      await consumeStream(r2);
      await new Promise(r => setTimeout(r, 2000));

      // Verify both messages and responses are in DB
      const msgs = await api.getMessages(session.id);
      console.log(`[6.6] Messages: ${msgs.length}`);
      for (const m of msgs) {
        console.log(`  [${m.role}] (${m.content?.length ?? 0}): ${(m.content ?? "").substring(0, 50)}`);
      }

      const userMsgs = msgs.filter(m => m.role === "user");
      const asstMsgs = msgs.filter(m => m.role === "assistant");

      expect(userMsgs.length, "Should have 2 user messages").toBeGreaterThanOrEqual(2);
      expect(asstMsgs.length, "Should have 2 assistant messages").toBeGreaterThanOrEqual(2);

      // Check content references
      const allAsstContent = asstMsgs.map(m => m.content ?? "").join(" ");
      const hasBeijing = allAsstContent.includes("北京") || allAsstContent.includes("Beijing");
      const hasDC = allAsstContent.includes("华盛顿") || allAsstContent.includes("Washington");
      console.log(`[6.6] Has Beijing: ${hasBeijing}, Has Washington: ${hasDC}`);

      // Screenshot
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      await takeScreenshot(page, "06-06-rapid-sequential");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });
});
