// =============================================================================
// DeepAnalyze - Agent System Singleton
// =============================================================================
// Lazily-initialized singleton that wires up the full agent pipeline:
// ModelRouter -> EmbeddingManager -> Indexer/Linker/Retriever/Expander ->
// ToolRegistry -> AgentRunner -> Orchestrator.
//
// This avoids circular dependencies and initialization order issues by
// deferring all heavy imports until the first request that needs the agent
// system.
// =============================================================================

import type { Orchestrator } from "./orchestrator.js";
import type { KnowledgeCompounder } from "../../wiki/knowledge-compound.js";
import type { PluginManager } from "../plugins/plugin-manager.js";
import type { Retriever } from "../../wiki/retriever.js";
import type { AgentTeamManager } from "./agent-team-manager.js";
import type { AgentRunner } from "./agent-runner.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { MCPClientManager } from "./mcp-client.js";
import { getRepos } from "../../store/repos/index.js";

/** Singleton orchestrator instance. */
let orchestratorInstance: Orchestrator | null = null;

/** Singleton compounder instance. */
let compounderInstance: KnowledgeCompounder | null = null;

/** Singleton plugin manager instance. */
let pluginManagerInstance: PluginManager | null = null;

/** Singleton retriever instance. */
let retrieverInstance: Retriever | null = null;

/** Singleton agent team manager instance. */
let teamManagerInstance: AgentTeamManager | null = null;

/** Singleton agent runner instance. */
let runnerInstance: AgentRunner | null = null;

/** Singleton tool registry instance. */
let toolRegistryInstance: ToolRegistry | null = null;

/** Singleton MCP client manager instance. */
let mcpManagerInstance: MCPClientManager | null = null;

/** Initialization promise so concurrent callers don't duplicate work. */
let initPromise: Promise<Orchestrator> | null = null;

/**
 * Get (or lazily initialize) the singleton Orchestrator instance.
 *
 * The first call triggers the full initialization pipeline:
 *   1. ModelRouter (reads YAML config, sets up providers)
 *   2. EmbeddingManager (uses ModelRouter for embeddings or hash fallback)
 *   3. Indexer, Linker, Retriever, Expander (wiki subsystem)
 *   4. ToolRegistry (via createConfiguredToolRegistry)
 *   5. AgentRunner (registers all built-in agents)
 *   6. KnowledgeCompounder
 *   7. Orchestrator (with auto-dream support)
 *
 * Subsequent calls return the same cached instance.
 */
export async function getOrchestrator(): Promise<Orchestrator> {
  if (orchestratorInstance) {
    return orchestratorInstance;
  }

  // If initialization is already in progress, await it rather than starting
  // a second initialization.
  if (initPromise) {
    return initPromise;
  }

  initPromise = initializeOrchestrator();

  try {
    orchestratorInstance = await initPromise;
    return orchestratorInstance;
  } catch (err) {
    // Reset so a future call can retry
    initPromise = null;
    throw err;
  }
}

/**
 * Check if the orchestrator has been initialized.
 */
export function isOrchestratorReady(): boolean {
  return orchestratorInstance !== null;
}

/**
 * Reset the singleton (useful for tests or reconfiguration).
 */
export function resetOrchestrator(): void {
  orchestratorInstance = null;
  compounderInstance = null;
  pluginManagerInstance = null;
  retrieverInstance = null;
  teamManagerInstance = null;
  runnerInstance = null;
  toolRegistryInstance = null;
  mcpManagerInstance = null;
  initPromise = null;
}

// ---------------------------------------------------------------------------
// Knowledge Compounder
// ---------------------------------------------------------------------------

/**
 * Get (or lazily initialize) the singleton KnowledgeCompounder instance.
 *
 * The compounder is initialized alongside the Orchestrator during the first
 * call to `getOrchestrator()`. If the orchestrator has not been initialized
 * yet, this will trigger the full initialization pipeline.
 */
export async function getCompounder(): Promise<KnowledgeCompounder> {
  if (!compounderInstance) {
    await getOrchestrator();
  }
  if (!compounderInstance) throw new Error("Compounder not initialized after orchestrator init");
  return compounderInstance;
}

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

/**
 * Get (or lazily initialize) the singleton Retriever instance.
 *
 * The Retriever is initialized alongside the Orchestrator during the first
 * call to `getOrchestrator()`. If the orchestrator has not been initialized
 * yet, this will trigger the full initialization pipeline.
 */
export async function getRetriever(): Promise<Retriever> {
  if (!retrieverInstance) {
    await getOrchestrator();
  }
  if (!retrieverInstance) throw new Error("Retriever not initialized after orchestrator init");
  return retrieverInstance;
}

// ---------------------------------------------------------------------------
// Plugin Manager
// ---------------------------------------------------------------------------

/**
 * Get (or lazily initialize) the singleton PluginManager instance.
 *
 * The PluginManager is initialized alongside the Orchestrator during the first
 * call to `getOrchestrator()`. If the orchestrator has not been initialized
 * yet, this will trigger the full initialization pipeline.
 */
export async function getPluginManager(): Promise<PluginManager> {
  if (!pluginManagerInstance) {
    await getOrchestrator();
  }
  if (!pluginManagerInstance) throw new Error("PluginManager not initialized after orchestrator init");
  return pluginManagerInstance;
}

// ---------------------------------------------------------------------------
// Agent Team Manager
// ---------------------------------------------------------------------------

/**
 * Get (or lazily initialize) the singleton AgentTeamManager instance.
 *
 * The AgentTeamManager is initialized alongside the Orchestrator during the first
 * call to `getOrchestrator()`. If the orchestrator has not been initialized
 * yet, this will trigger the full initialization pipeline.
 */
export async function getTeamManager(): Promise<AgentTeamManager> {
  if (!teamManagerInstance) {
    await getOrchestrator();
  }
  if (!teamManagerInstance) throw new Error("TeamManager not initialized after orchestrator init");
  return teamManagerInstance;
}

export async function getRunner(): Promise<AgentRunner> {
  if (!runnerInstance) {
    await getOrchestrator();
  }
  if (!runnerInstance) throw new Error("Runner not initialized after orchestrator init");
  return runnerInstance;
}

export async function getToolRegistry(): Promise<ToolRegistry> {
  if (!toolRegistryInstance) {
    await getOrchestrator();
  }
  if (!toolRegistryInstance) throw new Error("ToolRegistry not initialized after orchestrator init");
  return toolRegistryInstance;
}

// ---------------------------------------------------------------------------
// MCP Client Manager
// ---------------------------------------------------------------------------

export async function getMCPManager(): Promise<MCPClientManager> {
  if (!mcpManagerInstance) {
    await getOrchestrator();
  }
  if (!mcpManagerInstance) throw new Error("MCPManager not initialized after orchestrator init");
  return mcpManagerInstance;
}

// ---------------------------------------------------------------------------
// Internal initialization
// ---------------------------------------------------------------------------

async function initializeOrchestrator(): Promise<Orchestrator> {
  const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
  const { ModelRouter } = await import("../../models/router.js");
  const { EmbeddingManager } = await import("../../models/embedding.js");
  const { Indexer } = await import("../../wiki/indexer.js");
  const { Linker } = await import("../../wiki/linker.js");
  const { Retriever } = await import("../../wiki/retriever.js");
  const { Expander } = await import("../../wiki/expander.js");
  const { AgentRunner } = await import("./agent-runner.js");
  const { createConfiguredToolRegistry } = await import("./tool-setup.js");
  const { BUILT_IN_AGENTS } = await import("./agent-definitions.js");
  const { Orchestrator } = await import("./orchestrator.js");

  console.log("[AgentSystem] Initializing agent pipeline...");

  // Step 1: ModelRouter
  const modelRouter = new ModelRouter();
  await modelRouter.initialize();
  console.log("[AgentSystem] ModelRouter initialized");

  // Step 2: EmbeddingManager
  const embeddingManager = new EmbeddingManager(modelRouter);
  await embeddingManager.initialize();
  console.log("[AgentSystem] EmbeddingManager initialized");

  // Step 3: Wiki subsystem
  const linker = new Linker();
  const indexer = new Indexer(embeddingManager);
  const retriever = new Retriever(indexer, linker, embeddingManager);
  retrieverInstance = retriever;
  const expander = new Expander(DEEPANALYZE_CONFIG.dataDir);
  console.log("[AgentSystem] Wiki subsystem initialized");

  // Step 4: Tool registry with all custom tools
  const toolRegistry = await createConfiguredToolRegistry({
    retriever,
    linker,
    expander,
    embeddingManager,
    indexer,
    modelRouter,
    dataDir: DEEPANALYZE_CONFIG.dataDir,
  });
  toolRegistryInstance = toolRegistry;
  console.log("[AgentSystem] ToolRegistry configured");

  // Step 5: Agent runner with built-in agents + hook manager
  const { HookManager } = await import("./hooks.js");
  const hookManager = new HookManager();
  await hookManager.loadFromSettings();

  const runner = new AgentRunner(modelRouter, toolRegistry, hookManager);
  runner.registerAgents(BUILT_IN_AGENTS);
  runnerInstance = runner;
  console.log("[AgentSystem] AgentRunner initialized with built-in agents");

  // Step 6: Knowledge Compounder (for write-back of agent results and auto-dream)
  const { KnowledgeCompounder } = await import("../../wiki/knowledge-compound.js");
  compounderInstance = new KnowledgeCompounder(DEEPANALYZE_CONFIG.dataDir);
  console.log("[AgentSystem] KnowledgeCompounder initialized");

  // Step 7: Orchestrator (with auto-dream support)
  const orchestrator = new Orchestrator(runner, modelRouter, compounderInstance, linker);
  console.log("[AgentSystem] Orchestrator ready");

  // Step 8: Plugin Manager
  const { PluginManager } = await import("../plugins/plugin-manager.js");
  const pluginManager = new PluginManager(toolRegistry);
  pluginManager.setAgentRunner(runner);
  await pluginManager.loadFromDatabase();
  pluginManagerInstance = pluginManager;
  console.log("[AgentSystem] PluginManager initialized");

  // Step 9: Register built-in skills (delete-and-recreate to keep prompts fresh)
  // NOTE: Generic skills have been migrated to agent_skills table via ensureBuiltinSkills().
  // This step now only handles Plugin-specific built-in skills (currently none).
  const { BUILT_IN_SKILLS } = await import("../skills/built-in-skills.js");
  if (BUILT_IN_SKILLS.length > 0) {
    let skillsRegistered = 0;
    for (const skill of BUILT_IN_SKILLS) {
      try {
        const existing = await pluginManager.listSkills();
        const match = existing.find(s => s.name === skill.name);
        if (match) {
          await pluginManager.deleteSkill(match.id);
        }
        await pluginManager.createSkill(skill);
        skillsRegistered++;
      } catch (err) {
        console.error(`[AgentSystem] Failed to register built-in skill "${skill.name}":`, err);
      }
    }
    console.log(`[AgentSystem] Built-in skills registered (${skillsRegistered}/${BUILT_IN_SKILLS.length})`);
  } else {
    console.log("[AgentSystem] Built-in skills: all migrated to agent_skills table (via ensureBuiltinSkills)");
  }

  // Step 10: Agent Team Manager + workflow_run tool
  const { AgentTeamManager } = await import("./agent-team-manager.js");
  const { registerWorkflowRunTool, registerDelegateTaskTool, registerWorkflowStatusTool, registerCronTools } = await import("./tool-setup.js");
  const { getWorkflowManager } = await import("./workflow-manager.js");
  const teamManager = new AgentTeamManager();
  teamManagerInstance = teamManager;

  // Inject WorkflowRepo into WorkflowManager so workflows persist across restarts
  try {
    const repos = await getRepos();
    getWorkflowManager().setWorkflowRepo(repos.workflow);
    console.log("[AgentSystem] WorkflowManager DB persistence enabled");
  } catch (err) {
    console.warn("[AgentSystem] WorkflowManager DB persistence unavailable:", err instanceof Error ? err.message : String(err));
  }

  // Register the workflow_run tool with deps
  const workflowDeps = {
    runner,
    toolRegistry,
    getTeamManager: async () => teamManagerInstance!,
    emitWs: (event: any) => {
      if (globalThis.__workflowEvents) {
        globalThis.__workflowEvents.emit("workflow", event);
      }
    },
    dataDir: DEEPANALYZE_CONFIG.dataDir,
  };
  await registerWorkflowRunTool(toolRegistry, workflowDeps);
  await registerDelegateTaskTool(toolRegistry, workflowDeps);
  registerWorkflowStatusTool(toolRegistry);
  registerCronTools(toolRegistry);
  console.log("[AgentSystem] AgentTeamManager initialized, workflow_run + delegate_task + workflow_status + cron tools registered");

  // Step 11: MCP Client Manager
  const { MCPClientManager } = await import("./mcp-client.js");
  const mcpManager = new MCPClientManager();
  mcpManager.setToolRegistry(toolRegistry);

  // Load persisted MCP server configs and auto-connect enabled ones
  try {
    const repos = await getRepos();
    const raw = await repos.settings.get("mcp_servers");
    if (raw) {
      const configs = JSON.parse(raw) as Array<import("./mcp-client.js").MCPServerConfig>;
      for (const config of configs) {
        mcpManager.addServer(config);
      }
      await mcpManager.connectAll();
    }
  } catch (err) {
    console.warn("[AgentSystem] MCP initialization skipped:", err instanceof Error ? err.message : String(err));
  }
  mcpManagerInstance = mcpManager;
  console.log("[AgentSystem] MCPClientManager initialized");

  // Step 12: Register builtin MCP adapters (VLM image analysis, web search)
  const { registerBuiltinMCPTools } = await import("./mcp-builtin-adapters.js");
  registerBuiltinMCPTools(toolRegistry);
  console.log("[AgentSystem] Builtin MCP adapters registered (VLM + web search)");

  return orchestrator;
}
