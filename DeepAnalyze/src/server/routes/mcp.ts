// =============================================================================
// DeepAnalyze - MCP Server Configuration API Routes
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";

export const mcpRoutes = new Hono();

// GET / - List MCP server configurations
mcpRoutes.get("/", async (c) => {
  const repos = await getRepos();
  const raw = await repos.settings.get("mcp_servers");
  const servers = raw ? JSON.parse(raw) : [];
  return c.json(servers);
});

// POST / - Add or update an MCP server configuration
mcpRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    id: string;
    name: string;
    type: "stdio" | "sse" | "streamable-http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    enabled?: boolean;
  }>();

  if (!body.id || !body.name || !body.type) {
    return c.json({ error: "id, name, and type are required" }, 400);
  }

  const repos = await getRepos();
  const raw = await repos.settings.get("mcp_servers");
  const servers: Record<string, unknown>[] = raw ? JSON.parse(raw) : [];

  const serverConfig = {
    id: body.id,
    name: body.name,
    type: body.type,
    command: body.command,
    args: body.args,
    env: body.env,
    url: body.url,
    enabled: body.enabled !== false,
  };

  // Update existing or add new
  const idx = servers.findIndex((s) => (s as { id: string }).id === body.id);
  if (idx >= 0) {
    servers[idx] = serverConfig;
  } else {
    servers.push(serverConfig);
  }

  await repos.settings.set("mcp_servers", JSON.stringify(servers));
  return c.json(serverConfig);
});

// DELETE /:id - Remove an MCP server configuration
mcpRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const raw = await repos.settings.get("mcp_servers");
  const servers: Record<string, unknown>[] = raw ? JSON.parse(raw) : [];
  const filtered = servers.filter((s) => (s as { id: string }).id !== id);

  if (filtered.length === servers.length) {
    return c.json({ error: "Server not found" }, 404);
  }

  await repos.settings.set("mcp_servers", JSON.stringify(filtered));
  return c.json({ success: true });
});

// POST /connect/:id - Connect to an MCP server and discover tools
mcpRoutes.post("/connect/:id", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const raw = await repos.settings.get("mcp_servers");
  const servers: Array<Record<string, unknown>> = raw ? JSON.parse(raw) : [];
  const server = servers.find((s) => s.id === id);

  if (!server) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const { getMCPManager } = await import("../../services/agent/agent-system.js");
    const manager = await getMCPManager();
    const config = {
      id: server.id as string,
      name: server.name as string,
      type: server.type as "stdio" | "sse" | "streamable-http",
      command: server.command as string | undefined,
      args: server.args as string[] | undefined,
      env: server.env as Record<string, string> | undefined,
      url: server.url as string | undefined,
      enabled: server.enabled as boolean !== false,
    };

    manager.addServer(config);
    await manager.connect(id);

    const status = manager.getStatus().find(s => s.id === id);
    return c.json({ success: true, status });
  } catch (err) {
    return c.json({
      error: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    }, 500);
  }
});

// GET /status - Get connection status for all servers
mcpRoutes.get("/status", async (c) => {
  try {
    const { getMCPManager } = await import("../../services/agent/agent-system.js");
    const manager = await getMCPManager();
    return c.json(manager.getStatus());
  } catch {
    return c.json([]);
  }
});
