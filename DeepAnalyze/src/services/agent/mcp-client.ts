// =============================================================================
// DeepAnalyze - MCP Client Manager
// =============================================================================
// Manages connections to Model Context Protocol (MCP) servers.
// Dynamically loads tools from MCP servers and registers them in the ToolRegistry.
// =============================================================================

import type { AgentTool } from "./types.js";
import type { ToolRegistry } from "./tool-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for an MCP server connection. */
export interface MCPServerConfig {
  /** Unique identifier for this server. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Connection type. */
  type: "stdio" | "sse" | "streamable-http" | "websocket";
  /** Command to run (stdio type). */
  command?: string;
  /** Arguments for the command (stdio type). */
  args?: string[];
  /** Environment variables (stdio type). */
  env?: Record<string, string>;
  /** Server URL (sse/streamable-http/websocket type). */
  url?: string;
  /** Whether this server is enabled. */
  enabled: boolean;
}

/** A tool discovered from an MCP server. */
interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** State of an MCP server connection. */
interface MCPServerState {
  config: MCPServerConfig;
  status: "pending" | "connected" | "failed";
  tools: MCPToolDef[];
  error?: string;
}

// ---------------------------------------------------------------------------
// MCP Client Manager
// ---------------------------------------------------------------------------

export class MCPClientManager {
  private servers = new Map<string, MCPServerState>();
  private toolRegistry: ToolRegistry | null = null;

  /** Register the tool registry for dynamic tool registration. */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** Add an MCP server configuration. */
  addServer(config: MCPServerConfig): void {
    this.servers.set(config.id, {
      config,
      status: "pending",
      tools: [],
    });
  }

  /** Remove an MCP server. */
  removeServer(id: string): void {
    const state = this.servers.get(id);
    if (state) {
      // Unregister tools from the registry
      if (this.toolRegistry) {
        for (const tool of state.tools) {
          this.toolRegistry.unregister(tool.name);
        }
      }
      this.servers.delete(id);
    }
  }

  /** Get all configured servers. */
  getServers(): MCPServerConfig[] {
    return Array.from(this.servers.values()).map(s => s.config);
  }

  /** Get the status of all servers. */
  getStatus(): Array<{ id: string; name: string; status: string; toolCount: number; error?: string }> {
    return Array.from(this.servers.values()).map(s => ({
      id: s.config.id,
      name: s.config.name,
      status: s.status,
      toolCount: s.tools.length,
      error: s.error,
    }));
  }

  /**
   * Connect to a specific MCP server and discover its tools.
   * For stdio: spawns the process and sends initialize/list_tools.
   * For sse/http: connects to the endpoint.
   */
  async connect(serverId: string): Promise<void> {
    const state = this.servers.get(serverId);
    if (!state) throw new Error(`MCP server ${serverId} not configured`);

    if (state.config.type === "stdio") {
      await this.connectStdio(state);
    } else if (state.config.type === "sse") {
      await this.connectRealSSE(state);
    } else if (state.config.type === "websocket") {
      await this.connectWebSocket(state);
    } else if (state.config.type === "streamable-http") {
      await this.connectHttp(state);
    } else {
      state.status = "failed";
      state.error = `Unsupported type: ${state.config.type}`;
    }
  }

  /** Connect to all enabled servers. */
  async connectAll(): Promise<void> {
    const enabled = Array.from(this.servers.values())
      .filter(s => s.config.enabled && s.status === "pending");

    await Promise.allSettled(
      enabled.map(s => this.connect(s.config.id)),
    );
  }

  // -----------------------------------------------------------------------
  // Private: stdio connection
  // -----------------------------------------------------------------------

  private async connectStdio(state: MCPServerState): Promise<void> {
    const { command, args = [], env = {} } = state.config;
    if (!command) {
      state.status = "failed";
      state.error = "No command specified for stdio MCP server";
      return;
    }

    try {
      const { spawn } = await import("node:child_process");

      const mergedEnv = { ...process.env, ...env };
      // On Windows, spawning ".cmd"/".bat" wrappers (e.g. npx.cmd) requires
      // shell:true to avoid EINVAL. Linux/macOS pass through unchanged.
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: mergedEnv as Record<string, string>,
        shell: process.platform === "win32",
      });

      // Send initialize request
      const initResponse = await this.sendStdioRequest(child, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "DeepAnalyze", version: "0.7.7" },
      });

      if (!initResponse) {
        throw new Error("No response from MCP server initialization");
      }

      // Send initialized notification
      this.sendStdioNotification(child, "notifications/initialized", {});

      // List available tools
      const toolsResponse = await this.sendStdioRequest(child, "tools/list", {});
      const tools = (toolsResponse?.tools as MCPToolDef[]) ?? [];

      state.tools = tools;
      state.status = "connected";

      // Register tools in the tool registry
      this.registerTools(state);

      // Clean up child process
      child.kill();
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  private sendStdioRequest(
    child: import("node:child_process").ChildProcess,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const requestId = Date.now();
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      });

      const timeout = setTimeout(() => {
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30000);

      const handler = (data: Buffer) => {
        try {
          const lines = data.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.id === requestId) {
              clearTimeout(timeout);
              child.stdout?.off("data", handler);
              resolve(parsed.result ?? parsed.error ?? null);
              return;
            }
          }
        } catch {
          // Not valid JSON, ignore
        }
      };

      child.stdout?.on("data", handler);
      child.stdin?.write(message + "\n");
    });
  }

  private sendStdioNotification(
    child: import("node:child_process").ChildProcess,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    child.stdin?.write(message + "\n");
  }

  // -----------------------------------------------------------------------
  // Private: Real SSE connection (event-source based)
  // -----------------------------------------------------------------------

  /**
   * Connect to an MCP server using Server-Sent Events transport.
   * The SSE endpoint typically exposes a /sse path that streams events.
   * We first GET /sse to establish the connection, then POST to the
   * endpoint URL provided by the server for JSON-RPC requests.
   */
  private async connectRealSSE(state: MCPServerState): Promise<void> {
    const { url } = state.config;
    if (!url) {
      state.status = "failed";
      state.error = "No URL specified for SSE MCP server";
      return;
    }

    try {
      // Step 1: POST initialize request to the MCP endpoint
      const initResponse = await this.jsonRpcPost(url, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "DeepAnalyze", version: "0.7.7" },
      });

      if (!initResponse) {
        throw new Error("No response from MCP server initialization");
      }

      // Step 2: List tools via JSON-RPC POST
      const toolsResponse = await this.jsonRpcPost(url, "tools/list", {});
      const tools = ((toolsResponse as { tools?: MCPToolDef[] })?.tools) ?? [];

      state.tools = tools;
      state.status = "connected";
      this.registerTools(state);
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  // -----------------------------------------------------------------------
  // Private: WebSocket connection
  // -----------------------------------------------------------------------

  /**
   * Connect to an MCP server using WebSocket transport.
   * Sends JSON-RPC messages over a persistent WebSocket connection.
   */
  private async connectWebSocket(state: MCPServerState): Promise<void> {
    const { url } = state.config;
    if (!url) {
      state.status = "failed";
      state.error = "No URL specified for WebSocket MCP server";
      return;
    }

    try {
      const wsUrl = url.replace(/^http/, "ws");
      const { WebSocket } = await import("ws");

      const tools = await new Promise<MCPToolDef[]>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("WebSocket connection timeout"));
        }, 15000);

        let initialized = false;

        ws.on("open", () => {
          // Send initialize
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "DeepAnalyze", version: "0.7.7" },
            },
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());

            if (msg.id === 1 && !initialized) {
              initialized = true;
              // Send initialized notification
              ws.send(JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
                params: {},
              }));
              // List tools
              ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
                params: {},
              }));
            }

            if (msg.id === 2) {
              clearTimeout(timeout);
              ws.close();
              resolve((msg.result?.tools as MCPToolDef[]) ?? []);
            }
          } catch {
            // Ignore non-JSON messages
          }
        });

        ws.on("error", (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });

        ws.on("close", () => {
          clearTimeout(timeout);
        });
      });

      state.tools = tools;
      state.status = "connected";
      this.registerTools(state);
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  // -----------------------------------------------------------------------
  // Private: HTTP/SSE connection (simple POST-based)
  // -----------------------------------------------------------------------

  private async connectHttp(state: MCPServerState): Promise<void> {
    const { url } = state.config;
    if (!url) {
      state.status = "failed";
      state.error = "No URL specified for HTTP MCP server";
      return;
    }

    try {
      // Try to list tools via HTTP POST
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as { result?: { tools?: MCPToolDef[] } };
      const tools = data.result?.tools ?? [];

      state.tools = tools;
      state.status = "connected";

      this.registerTools(state);
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  // -----------------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------------

  private registerTools(state: MCPServerState): void {
    if (!this.toolRegistry) return;

    const serverName = state.config.name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();

    for (const toolDef of state.tools) {
      const mcpToolName = `mcp__${serverName}__${toolDef.name}`;

      const tool: AgentTool = {
        name: mcpToolName,
        description: toolDef.description ?? `MCP tool: ${toolDef.name} (from ${state.config.name})`,
        inputSchema: toolDef.inputSchema ?? {
          type: "object",
          properties: {},
        },
        execute: async (input: Record<string, unknown>) => {
          return this.callTool(state.config, toolDef.name, input);
        },
      };

      this.toolRegistry.register(tool);
    }
  }

  /**
   * Call a tool on an MCP server.
   */
  private async callTool(
    config: MCPServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (config.type === "stdio") {
      return this.callStdioTool(config, toolName, args);
    } else if (config.type === "websocket") {
      return this.callWebSocketTool(config, toolName, args);
    } else {
      return this.callHttpTool(config, toolName, args);
    }
  }

  /** Send a JSON-RPC POST to an MCP endpoint and return the result. */
  private async jsonRpcPost(
    url: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { result?: unknown; error?: { message: string } };
    if (data.error) {
      throw new Error(data.error.message);
    }
    return data.result;
  }

  /** Call a tool via WebSocket transport. */
  private async callWebSocketTool(
    config: MCPServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const wsUrl = (config.url ?? "").replace(/^http/, "ws");
    const { WebSocket } = await import("ws");

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket tool call timeout"));
      }, 60000);

      let initialized = false;
      const callId = Date.now();

      ws.on("open", () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "DeepAnalyze", version: "0.7.7" },
          },
        }));
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1 && !initialized) {
            initialized = true;
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {},
            }));
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              id: callId,
              method: "tools/call",
              params: { name: toolName, arguments: args },
            }));
          }
          if (msg.id === callId) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.result);
          }
        } catch {
          // Ignore
        }
      });

      ws.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async callStdioTool(
    config: MCPServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { spawn } = await import("node:child_process");
    const child = spawn(config.command!, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env } as Record<string, string>,
      shell: process.platform === "win32",
    });

    try {
      // Initialize first
      await this.sendStdioRequest(child, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "DeepAnalyze", version: "0.7.7" },
      });
      this.sendStdioNotification(child, "notifications/initialized", {});

      // Call the tool
      const result = await this.sendStdioRequest(child, "tools/call", {
        name: toolName,
        arguments: args,
      });

      return result;
    } finally {
      child.kill();
    }
  }

  private async callHttpTool(
    config: MCPServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(config.url!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      return { error: `MCP tool call failed: HTTP ${response.status}` };
    }

    const data = await response.json() as { result?: unknown; error?: { message: string } };
    if (data.error) {
      return { error: data.error.message };
    }
    return data.result;
  }
}
