// =============================================================================
// DeepAnalyze - Chat Message API Routes
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";

export const chatRoutes = new Hono();

// POST /send - Send a message to a session
chatRoutes.post("/send", async (c) => {
  const body = await c.req.json<{ sessionId: string; content: string }>();

  if (!body.sessionId || !body.content) {
    return c.json({ error: "sessionId and content are required" }, 400);
  }

  // Verify session exists
  const repos = await getRepos();
  const session = await repos.session.get(body.sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const message = await repos.message.create(body.sessionId, "user", body.content);

  return c.json({ messageId: message.id, status: "created" }, 201);
});
