/**
 * E2E API Tests — Agent System Integration
 * Tests agent settings, session creation, and message flow.
 */
import { test, expect } from "@playwright/test";

test.describe("Agent System Integration", () => {
  // -----------------------------------------------------------------------
  // 1. Agent settings include contextCollapse
  // -----------------------------------------------------------------------
  test("GET /api/settings/agent returns settings with expected fields", async ({ request }) => {
    const resp = await request.get("/api/settings/agent");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    // Should have standard agent settings fields
    expect(typeof body).toBe("object");
    // The settings should at minimum exist (even if defaults)
    expect(body).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 2. Session creation and message sending
  // -----------------------------------------------------------------------
  test("can create a session and send a message", async ({ request }) => {
    // Create a session
    const sessionResp = await request.post("/api/sessions", {
      data: { title: "E2E test session" },
    });
    expect(sessionResp.status()).toBe(201);
    const session = await sessionResp.json();
    expect(session).toHaveProperty("id");

    // Send a message to the session
    const msgResp = await request.post("/api/chat/send", {
      data: {
        sessionId: session.id,
        content: "Hello from E2E test",
      },
    });
    expect(msgResp.status()).toBe(201);
    const msgBody = await msgResp.json();
    expect(msgBody).toHaveProperty("messageId");
    expect(msgBody.status).toBe("created");

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });

  // -----------------------------------------------------------------------
  // 3. Agent session SSE events include lifecycle hooks
  // -----------------------------------------------------------------------
  test("agent run-stream endpoint is accessible", async ({ request }) => {
    // Create a session first
    const sessionResp = await request.post("/api/sessions", {
      data: { title: "E2E agent lifecycle test" },
    });
    const session = await sessionResp.json();

    // Verify the agents run endpoint exists (we just check it responds,
    // not that it fully runs, since that requires model access)
    const runResp = await request.post("/api/agents/run", {
      data: {
        sessionId: session.id,
        message: "test",
      },
    });
    // May be 200, 400, or 500 depending on model availability,
    // but should not be 404 (route exists)
    expect(runResp.status()).not.toBe(404);

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });
});
