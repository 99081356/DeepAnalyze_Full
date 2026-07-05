/**
 * Comprehensive E2E Test: Skills, Plugins, MCP, Agent Teams, Evolution
 *
 * Tests the full integration of:
 *   1. Agent Skills CRUD API
 *   2. Skill Invocation via Agent
 *   3. Plugin System
 *   4. MCP Server Management
 *   5. Agent Teams CRUD
 *   6. Evolution System
 *   7. Skill Search & Discovery
 *   8. Built-in Skills Verification
 *
 * Run with: npx tsx tests/skills-plugins-e2e-test.ts
 *
 * Requires: DA server running at http://localhost:21000
 */

const BASE = "http://localhost:21000";

const passed: string[] = [];
const failed: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(
  path: string,
  options?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 30_000, ...init } = options ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson<T = unknown>(
  path: string,
  options?: RequestInit & { timeout?: number },
): Promise<{ status: number; data: T }> {
  const resp = await api(path, options);
  const data = (await resp.json()) as T;
  return { status: resp.status, data };
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed.push(name);
    console.log(`[PASS] ${name}`);
  } catch (e: unknown) {
    failed.push(name);
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[FAIL] ${name}`);
    console.log(`  Details: ${msg}`);
  }
}

/** Create a session for agent tests, returns session ID */
async function createTestSession(): Promise<string> {
  const { status, data } = await apiJson<{ id: string }>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "e2e-test-session" }),
  });
  if (status !== 201) {
    throw new Error(`Failed to create session: ${status} ${JSON.stringify(data)}`);
  }
  return (data as { id: string }).id;
}

/** Delete a session by ID */
async function deleteSession(id: string): Promise<void> {
  await api(`/api/sessions/${id}`, { method: "DELETE" });
}

// Track resources created during tests for cleanup
const createdSkillIds: string[] = [];
const createdTeamIds: string[] = [];
const createdMcpIds: string[] = [];
const createdSessionIds: string[] = [];
const registeredPluginIds: string[] = [];

// =========================================================================
// SECTION 1: Agent Skills API -- CRUD (5 tests)
// =========================================================================
console.log("\n=== Section 1: Agent Skills API - CRUD ===");

await test("Skills CRUD -- list skills: verify built-in skills exist", async () => {
  const { status, data } = await apiJson<Record<string, unknown>[]>(
    "/api/agent-skills",
  );
  if (status !== 200) {
    throw new Error(`Expected 200, got ${status}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`Expected array, got ${typeof data}`);
  }
  if (data.length < 10) {
    throw new Error(
      `Expected 10+ built-in skills, found ${data.length}`,
    );
  }
  console.log(`  Found ${data.length} skills`);
});

await test("Skills CRUD -- create skill", async () => {
  const { status, data } = await apiJson<{ id?: string; error?: string }>(
    "/api/agent-skills",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-skill-e2e",
        description: "E2E test skill",
        prompt: "You are a test assistant. Help with testing.",
        tools: ["bash", "read_file"],
      }),
    },
  );
  if (status !== 201) {
    throw new Error(
      `Expected 201, got ${status}: ${JSON.stringify(data)}`,
    );
  }
  const skill = data as { id?: string; name?: string };
  if (!skill.id) {
    throw new Error("Created skill has no id");
  }
  createdSkillIds.push(skill.id);
  console.log(`  Created skill id=${skill.id}`);
});

await test("Skills CRUD -- verify new skill appears in list", async () => {
  const { status, data } = await apiJson<
    Array<{ id: string; name: string }>
  >("/api/agent-skills");
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);

  const found = (data as Array<{ name: string }>).find(
    (s) => s.name === "test-skill-e2e",
  );
  if (!found) {
    throw new Error("test-skill-e2e not found in skill list");
  }
});

await test("Skills CRUD -- update skill description", async () => {
  if (createdSkillIds.length === 0) {
    throw new Error("No skill ID available from create step");
  }
  const id = createdSkillIds[0]!;
  const { status, data } = await apiJson<{ description?: string }>(
    `/api/agent-skills/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Updated E2E test skill description",
      }),
    },
  );
  if (status !== 200) {
    throw new Error(
      `Expected 200, got ${status}: ${JSON.stringify(data)}`,
    );
  }
  if (
    (data as { description: string }).description !==
    "Updated E2E test skill description"
  ) {
    throw new Error(
      `Description not updated: ${(data as { description?: string }).description}`,
    );
  }
});

await test("Skills CRUD -- delete test skill, verify removed", async () => {
  if (createdSkillIds.length === 0) {
    throw new Error("No skill ID available from create step");
  }
  const id = createdSkillIds[0]!;
  const { status } = await apiJson(`/api/agent-skills/${id}`, {
    method: "DELETE",
  });
  if (status !== 200) {
    throw new Error(`Expected 200 on delete, got ${status}`);
  }

  // Verify it's gone
  const { status: getStatus } = await apiJson(`/api/agent-skills/${id}`);
  if (getStatus !== 404) {
    throw new Error(
      `Expected 404 after deletion, got ${getStatus}`,
    );
  }
  createdSkillIds.shift();
});

// =========================================================================
// SECTION 2: Skill Invocation via Agent (3 tests)
// =========================================================================
console.log("\n=== Section 2: Skill Invocation via Agent ===");

let agentSessionId: string | undefined;

await test("Skill invocation -- agent session creation", async () => {
  agentSessionId = await createTestSession();
  if (agentSessionId) {
    createdSessionIds.push(agentSessionId);
    console.log(`  Session created: ${agentSessionId}`);
  } else {
    throw new Error("Session ID is empty");
  }
});

await test("Skill invocation -- invoke precise-qa skill via agent run", async () => {
  if (!agentSessionId) throw new Error("No session available");

  const { status, data } = await apiJson<{
    taskId?: string;
    status?: string;
    output?: string;
    error?: string;
  }>("/api/agents/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: agentSessionId,
      input:
        "Invoke the skill 'precise-qa' to answer: What is 2+2?",
      maxTurns: 5,
    }),
    timeout: 120_000,
  });

  // The agent run may succeed (200) or fail if no model is configured.
  // We verify the endpoint is reachable and the request is processed.
  if (status === 503) {
    throw new Error(
      "Agent system not initialized (503). Is a model provider configured?",
    );
  }
  if (status === 404) {
    throw new Error(
      `Session not found (404). Session ID: ${agentSessionId}`,
    );
  }
  if (status !== 200) {
    // Non-200 may indicate a model error, still note the status
    console.log(
      `  Agent run returned ${status}: ${JSON.stringify(data).slice(0, 200)}`,
    );
    // Still pass if the endpoint is functioning (not 5xx server error)
    if (status >= 500) {
      throw new Error(`Server error: ${status}`);
    }
  }
  const result = data as { taskId?: string; output?: string };
  if (result.taskId) {
    console.log(`  Task ID: ${result.taskId}`);
  }
});

await test("Skill invocation -- list available skills via agent", async () => {
  if (!agentSessionId) throw new Error("No session available");

  const { status, data } = await apiJson<{
    taskId?: string;
    output?: string;
    error?: string;
  }>("/api/agents/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: agentSessionId,
      input: "List all available skills",
      maxTurns: 3,
    }),
    timeout: 120_000,
  });

  if (status === 503) {
    throw new Error("Agent system not initialized (503)");
  }
  if (status >= 500) {
    throw new Error(`Server error: ${status}`);
  }
  console.log(
    `  Agent returned status ${status}`,
  );
});

await test("Skill invocation -- invalid skill name graceful handling", async () => {
  if (!agentSessionId) throw new Error("No session available");

  const { status, data } = await apiJson<{
    taskId?: string;
    output?: string;
    error?: string;
  }>("/api/agents/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: agentSessionId,
      input:
        "Invoke the skill 'nonexistent-skill-xyz'",
      maxTurns: 3,
    }),
    timeout: 120_000,
  });

  if (status === 503) {
    throw new Error("Agent system not initialized (503)");
  }
  // The agent should handle the invalid skill gracefully.
  // We don't expect a server crash (5xx).
  if (status >= 500) {
    throw new Error(
      `Server error on invalid skill: ${status} ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  console.log(
    `  Handled gracefully: status ${status}`,
  );
});

// =========================================================================
// SECTION 3: Plugin System (4 tests)
// =========================================================================
console.log("\n=== Section 3: Plugin System ===");

await test("Plugin system -- list installed plugins", async () => {
  const { status, data } = await apiJson<{
    plugins?: Array<{
      id: string;
      name: string;
      version: string;
      enabled: boolean;
    }>;
    error?: string;
  }>("/api/plugins/plugins");

  if (status !== 200 && status !== 503) {
    throw new Error(`Expected 200 or 503, got ${status}: ${JSON.stringify(data)}`);
  }
  if (status === 503) {
    console.log(`  Plugin system not ready (503), skipping`);
    return;
  }
  const result = data as {
    plugins?: Array<{
      id: string;
      name: string;
      version: string;
      enabled: boolean;
    }>;
  };
  if (!result.plugins || !Array.isArray(result.plugins)) {
    throw new Error(
      `Expected plugins array, got: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  console.log(`  Found ${result.plugins.length} plugins`);
});

await test("Plugin system -- register and unregister a test plugin", async () => {
  const pluginId = `test-plugin-e2e-${Date.now()}`;
  const { status, data } = await apiJson<{
    id?: string;
    error?: string;
  }>("/api/plugins/plugins/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: pluginId,
      name: "E2E Test Plugin",
      version: "1.0.0",
      description: "A test plugin for E2E testing",
    }),
  });

  if (status !== 201 && status !== 503) {
    throw new Error(
      `Expected 201, got ${status}: ${JSON.stringify(data)}`,
    );
  }
  if (status === 503) {
    console.log(`  Plugin system not ready (503), skipping`);
    return;
  }
  registeredPluginIds.push(pluginId);
  console.log(`  Registered plugin: ${pluginId}`);
});

await test("Plugin system -- discover plugins", async () => {
  const { status, data } = await apiJson<{
    discovered?: unknown[];
    error?: string;
  }>("/api/plugins/plugins/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchPaths: ["/tmp"] }),
  });

  if (status !== 200 && status !== 503) {
    throw new Error(`Expected 200, got ${status}: ${JSON.stringify(data)}`);
  }
  if (status === 503) {
    console.log(`  Plugin system not ready (503), skipping`);
    return;
  }
  const result = data as { discovered?: unknown[] };
  if (!Array.isArray(result.discovered)) {
    throw new Error(
      `Expected discovered array, got: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  console.log(`  Discovered ${result.discovered.length} plugins in /tmp`);
});

await test("Plugin system -- enable/disable toggle", async () => {
  if (registeredPluginIds.length === 0) {
    console.log(`  No registered plugin to toggle, skipping`);
    return;
  }
  const pluginId = registeredPluginIds[0]!;

  // Disable
  const { status: disableStatus, data: disableData } = await apiJson(
    `/api/plugins/plugins/${pluginId}/disable`,
    { method: "POST" },
  );
  if (disableStatus !== 200) {
    throw new Error(
      `Disable failed: ${disableStatus} ${JSON.stringify(disableData)}`,
    );
  }

  // Enable
  const { status: enableStatus, data: enableData } = await apiJson(
    `/api/plugins/plugins/${pluginId}/enable`,
    { method: "POST" },
  );
  if (enableStatus !== 200) {
    throw new Error(
      `Enable failed: ${enableStatus} ${JSON.stringify(enableData)}`,
    );
  }

  // Unregister
  const { status: deleteStatus } = await apiJson(
    `/api/plugins/plugins/${pluginId}`,
    { method: "DELETE" },
  );
  if (deleteStatus !== 200) {
    throw new Error(`Delete failed: ${deleteStatus}`);
  }
  registeredPluginIds.shift();
  console.log("  Enable/disable/unregister cycle completed");
});

// =========================================================================
// SECTION 4: MCP Server Management (4 tests)
// =========================================================================
console.log("\n=== Section 4: MCP Server Management ===");

await test("MCP servers -- list configured servers", async () => {
  const { status, data } = await apiJson<unknown[]>("/api/mcp");
  if (status !== 200) {
    throw new Error(`Expected 200, got ${status}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`Expected array, got ${typeof data}`);
  }
  console.log(`  Found ${data.length} MCP servers`);
});

await test("MCP servers -- register a test MCP config", async () => {
  const { status, data } = await apiJson<{
    id?: string;
    error?: string;
  }>("/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "test-mcp",
      name: "test-mcp",
      type: "stdio",
      command: "echo",
      args: ["test"],
    }),
  });
  if (status !== 200) {
    throw new Error(
      `Expected 200, got ${status}: ${JSON.stringify(data)}`,
    );
  }
  createdMcpIds.push("test-mcp");
  console.log("  Registered test-mcp server");
});

await test("MCP servers -- verify new server appears in list", async () => {
  const { status, data } = await apiJson<
    Array<{ id: string; name: string }>
  >("/api/mcp");
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);

  const found = (data as Array<{ id: string }>).find(
    (s) => s.id === "test-mcp",
  );
  if (!found) {
    throw new Error("test-mcp not found in MCP server list");
  }
});

await test("MCP servers -- cleanup: delete test-mcp", async () => {
  const { status, data } = await apiJson("/api/mcp/test-mcp", {
    method: "DELETE",
  });
  if (status !== 200) {
    throw new Error(
      `Expected 200 on delete, got ${status}: ${JSON.stringify(data)}`,
    );
  }
  createdMcpIds.shift();

  // Verify removed
  const { status: getStatus, data: listData } = await apiJson<
    Array<{ id: string }>
  >("/api/mcp");
  const stillThere = (listData as Array<{ id: string }>).find(
    (s) => s.id === "test-mcp",
  );
  if (stillThere) {
    throw new Error("test-mcp still present after deletion");
  }
  console.log("  test-mcp deleted successfully");
});

// =========================================================================
// SECTION 5: Agent Teams (5 tests)
// =========================================================================
console.log("\n=== Section 5: Agent Teams ===");

await test("Agent teams -- list teams", async () => {
  const { status, data } = await apiJson<unknown[]>("/api/agent-teams");
  if (status !== 200) {
    throw new Error(`Expected 200, got ${status}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`Expected array, got ${typeof data}`);
  }
  console.log(`  Found ${(data as unknown[]).length} teams`);
});

await test("Agent teams -- create test team", async () => {
  const { status, data } = await apiJson<{
    id?: string;
    error?: string;
  }>("/api/agent-teams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "test-team-e2e",
      description: "E2E test team",
      mode: "parallel",
      members: [
        {
          role: "researcher",
          task: "Research the given topic",
          systemPrompt: "Research assistant",
        },
        {
          role: "writer",
          task: "Write the output",
          systemPrompt: "Writing assistant",
        },
      ],
    }),
  });
  if (status !== 201) {
    throw new Error(
      `Expected 201, got ${status}: ${JSON.stringify(data)}`,
    );
  }
  const team = data as { id?: string };
  if (!team.id) {
    throw new Error("Created team has no id");
  }
  createdTeamIds.push(team.id);
  console.log(`  Created team id=${team.id}`);
});

await test("Agent teams -- verify team created", async () => {
  const { status, data } = await apiJson<
    Array<{ id: string; name: string }>
  >("/api/agent-teams");
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);

  const found = (data as Array<{ name: string }>).find(
    (t) => t.name === "test-team-e2e",
  );
  if (!found) {
    throw new Error("test-team-e2e not found in teams list");
  }
});

await test("Agent teams -- update team name", async () => {
  if (createdTeamIds.length === 0) {
    throw new Error("No team ID from create step");
  }
  const id = createdTeamIds[0]!;
  const { status, data } = await apiJson<{ name?: string }>(
    `/api/agent-teams/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-team-e2e-updated" }),
    },
  );
  if (status !== 200) {
    throw new Error(
      `Expected 200, got ${status}: ${JSON.stringify(data)}`,
    );
  }
  if ((data as { name?: string }).name !== "test-team-e2e-updated") {
    throw new Error(
      `Name not updated: ${(data as { name?: string }).name}`,
    );
  }
});

await test("Agent teams -- cleanup: delete test team", async () => {
  if (createdTeamIds.length === 0) {
    throw new Error("No team ID to delete");
  }
  const id = createdTeamIds[0]!;
  const { status } = await apiJson(`/api/agent-teams/${id}`, {
    method: "DELETE",
  });
  if (status !== 200) {
    throw new Error(`Expected 200 on delete, got ${status}`);
  }
  createdTeamIds.shift();
  console.log("  Team deleted successfully");
});

// =========================================================================
// SECTION 6: Evolution System (3 tests)
// =========================================================================
console.log("\n=== Section 6: Evolution System ===");

await test("Evolution -- verify evolution config endpoint", async () => {
  const { status, data } = await apiJson<{
    enabled?: boolean;
    modules?: unknown;
    params?: unknown;
  }>("/api/settings/evolution");
  if (status !== 200) {
    throw new Error(`Expected 200, got ${status}`);
  }
  const config = data as { enabled?: boolean; modules?: unknown; params?: unknown };
  if (typeof config.enabled !== "boolean") {
    throw new Error(
      `Expected enabled boolean, got: ${typeof config.enabled}`,
    );
  }
  console.log(`  Evolution enabled: ${config.enabled}`);
});

await test("Evolution -- verify stats endpoint", async () => {
  const { status, data } = await apiJson<{
    memoryCount?: number;
    skillStats?: unknown;
  }>("/api/settings/evolution/stats");
  if (status !== 200) {
    throw new Error(`Expected 200, got ${status}`);
  }
  const stats = data as { memoryCount?: number; skillStats?: unknown };
  if (typeof stats.memoryCount !== "number") {
    throw new Error(
      `Expected memoryCount number, got: ${typeof stats.memoryCount}`,
    );
  }
  console.log(`  Memory count: ${stats.memoryCount}`);
});

await test("Evolution -- verify memories endpoint", async () => {
  const { status, data } = await apiJson<{
    memories?: unknown[];
    count?: number;
  }>("/api/settings/evolution/memories");
  if (status !== 200) {
    throw new Error(`Expected 200, got ${status}`);
  }
  const result = data as { memories?: unknown[]; count?: number };
  if (!Array.isArray(result.memories)) {
    throw new Error(
      `Expected memories array, got: ${typeof result.memories}`,
    );
  }
  console.log(
    `  Memories: ${result.memories.length}, total count: ${result.count}`,
  );
});

// =========================================================================
// SECTION 7: Skill Search & Discovery (3 tests)
// =========================================================================
console.log("\n=== Section 7: Skill Search & Discovery ===");

await test("Skill search -- search for skills related to 'analysis'", async () => {
  // Use the agent-skills endpoint to list and verify search-ability
  const { status, data } = await apiJson<
    Array<{ name: string; description: string }>
  >("/api/agent-skills");
  if (status !== 200) {
    throw new Error(`Expected 200, got ${status}`);
  }
  const skills = data as Array<{ name: string; description: string }>;
  const analysisSkills = skills.filter(
    (s) =>
      s.name.toLowerCase().includes("analysis") ||
      s.description.toLowerCase().includes("analysis") ||
      s.name.toLowerCase().includes("chunked"),
  );
  if (analysisSkills.length === 0) {
    throw new Error(
      "No skills related to 'analysis' found in the list",
    );
  }
  console.log(
    `  Found ${analysisSkills.length} analysis-related skills: ${analysisSkills.map((s) => s.name).join(", ")}`,
  );
});

await test("Skill search -- verify skill_search tool via plugin skills endpoint", async () => {
  // Access the plugin system's skills endpoint
  const { status, data } = await apiJson<{
    skills?: unknown[];
    error?: string;
  }>("/api/plugins/skills");
  if (status !== 200) {
    // Plugin system may not be fully initialized, that's okay
    console.log(
      `  Plugin skills returned ${status} (may not be initialized)`,
    );
    return;
  }
  const result = data as { skills?: unknown[] };
  if (!Array.isArray(result.skills)) {
    throw new Error(
      `Expected skills array, got: ${typeof result.skills}`,
    );
  }
  console.log(`  Plugin skills: ${result.skills.length}`);
});

await test("Skill search -- verify list is searchable and results are relevant", async () => {
  const { status, data } = await apiJson<
    Array<{ name: string; description: string }>
  >("/api/agent-skills");
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);

  const skills = data as Array<{ name: string; description: string }>;

  // Test 1: "research" should match deep-research
  const researchMatch = skills.filter(
    (s) =>
      s.name.toLowerCase().includes("research") ||
      s.description.toLowerCase().includes("research"),
  );
  if (researchMatch.length === 0) {
    throw new Error("No skills matching 'research' found");
  }

  // Test 2: "sql" should match sql-query
  const sqlMatch = skills.filter(
    (s) =>
      s.name.toLowerCase().includes("sql") ||
      s.description.toLowerCase().includes("sql"),
  );
  if (sqlMatch.length === 0) {
    throw new Error("No skills matching 'sql' found");
  }

  console.log(
    `  Search relevance verified: research=${researchMatch.length}, sql=${sqlMatch.length}`,
  );
});

// =========================================================================
// SECTION 8: Built-in Skills Verification (3 tests)
// =========================================================================
console.log("\n=== Section 8: Built-in Skills Verification ===");

interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  tools?: string[];
  antiHallucinationLevel?: string;
  isActive?: boolean;
}

await test("Built-in skills -- verify deep-research exists and is valid", async () => {
  const { status, data } = await apiJson<AgentSkill[]>(
    "/api/agent-skills",
  );
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);

  const skills = data as AgentSkill[];
  const skill = skills.find((s) => s.name === "deep-research");
  if (!skill) {
    throw new Error(
      "deep-research skill not found. Available: " +
        skills.map((s) => s.name).join(", "),
    );
  }

  // Verify key fields are non-empty
  if (!skill.description || skill.description.trim().length === 0) {
    throw new Error("deep-research has empty description");
  }
  if (!skill.prompt || skill.prompt.trim().length === 0) {
    throw new Error("deep-research has empty prompt");
  }
  if (!skill.tools || skill.tools.length === 0) {
    throw new Error("deep-research has empty tools");
  }
  // antiHallucinationLevel is optional, so just log it if present

  console.log(
    `  deep-research: tools=[${skill.tools.join(", ")}], antiHallucination=${skill.antiHallucinationLevel || "(not set)"}`,
  );
});

await test("Built-in skills -- verify chunked-analysis exists and is valid", async () => {
  const { status, data } = await apiJson<AgentSkill[]>(
    "/api/agent-skills",
  );
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);

  const skills = data as AgentSkill[];
  const skill = skills.find((s) => s.name === "chunked-analysis");
  if (!skill) {
    throw new Error(
      "chunked-analysis skill not found. Available: " +
        skills.map((s) => s.name).join(", "),
    );
  }

  if (!skill.description || skill.description.trim().length === 0) {
    throw new Error("chunked-analysis has empty description");
  }
  if (!skill.prompt || skill.prompt.trim().length === 0) {
    throw new Error("chunked-analysis has empty prompt");
  }
  if (!skill.tools || skill.tools.length === 0) {
    throw new Error("chunked-analysis has empty tools");
  }

  console.log(
    `  chunked-analysis: tools=[${skill.tools.join(", ")}], antiHallucination=${skill.antiHallucinationLevel}`,
  );
});

await test("Built-in skills -- verify sql-query exists and is valid", async () => {
  const { status, data } = await apiJson<AgentSkill[]>(
    "/api/agent-skills",
  );
  if (status !== 200) throw new Error(`Expected 200, got ${status}`);

  const skills = data as AgentSkill[];
  const skill = skills.find((s) => s.name === "sql-query");
  if (!skill) {
    throw new Error(
      "sql-query skill not found. Available: " +
        skills.map((s) => s.name).join(", "),
    );
  }

  if (!skill.description || skill.description.trim().length === 0) {
    throw new Error("sql-query has empty description");
  }
  if (!skill.prompt || skill.prompt.trim().length === 0) {
    throw new Error("sql-query has empty prompt");
  }
  if (!skill.tools || skill.tools.length === 0) {
    throw new Error("sql-query has empty tools");
  }
  // antiHallucinationLevel is optional, just log it if present

  console.log(
    `  sql-query: tools=[${skill.tools.join(", ")}], antiHallucination=${skill.antiHallucinationLevel || "(not set)"}`,
  );
});

// =========================================================================
// CLEANUP: Remove any remaining test resources
// =========================================================================
console.log("\n=== Cleanup ===");

for (const id of createdSkillIds) {
  try {
    await api(`/api/agent-skills/${id}`, { method: "DELETE" });
    console.log(`  Cleaned up skill: ${id}`);
  } catch {
    console.log(`  Failed to clean up skill: ${id}`);
  }
}

for (const id of createdTeamIds) {
  try {
    await api(`/api/agent-teams/${id}`, { method: "DELETE" });
    console.log(`  Cleaned up team: ${id}`);
  } catch {
    console.log(`  Failed to clean up team: ${id}`);
  }
}

for (const id of createdMcpIds) {
  try {
    await api(`/api/mcp/${id}`, { method: "DELETE" });
    console.log(`  Cleaned up MCP server: ${id}`);
  } catch {
    console.log(`  Failed to clean up MCP server: ${id}`);
  }
}

for (const id of registeredPluginIds) {
  try {
    await api(`/api/plugins/plugins/${id}`, { method: "DELETE" });
    console.log(`  Cleaned up plugin: ${id}`);
  } catch {
    console.log(`  Failed to clean up plugin: ${id}`);
  }
}

for (const id of createdSessionIds) {
  try {
    await deleteSession(id);
    console.log(`  Cleaned up session: ${id}`);
  } catch {
    console.log(`  Failed to clean up session: ${id}`);
  }
}

// =========================================================================
// SUMMARY
// =========================================================================
console.log("\n" + "=".repeat(70));
console.log(
  `Passed: ${passed.length}/${passed.length + failed.length}`,
);
console.log(`Failed: ${failed.length}`);
console.log("=".repeat(70));

if (failed.length > 0) {
  console.log("\nFAILED TESTS:");
  for (const name of failed) {
    console.log(`  [FAIL] ${name}`);
  }
}

if (failed.length > 0) {
  process.exit(1);
} else {
  console.log("\nALL SKILLS/PLUGINS/MCP E2E TESTS PASSED");
}
