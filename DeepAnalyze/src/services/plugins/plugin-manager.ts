// =============================================================================
// DeepAnalyze - Plugin Manager
// =============================================================================
// Manages plugin lifecycle: registration, enable/disable, persistence to DB,
// tool/agent wiring, and skill CRUD.
// =============================================================================

import { randomUUID } from "node:crypto";
import { getRepos } from "../../store/repos/index.js";
import { ToolRegistry } from "../agent/tool-registry.js";
import type { AgentRunner } from "../agent/agent-runner.js";
import type {
  PluginManifest,
  PluginToolDefinition,
  PluginState,
  SkillDefinition,
  SkillVariable,
} from "./types.js";
import type { AgentTool } from "../agent/types.js";

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

/**
 * Manages the full plugin lifecycle: registration, persistence, tool/agent
 * wiring, enable/disable toggling, and skill CRUD operations.
 */
export class PluginManager {
  private loadedPlugins = new Map<string, PluginState>();
  private manifests = new Map<string, PluginManifest>();
  /** Tracks which plugin owns which agent types (for unregister). */
  private pluginAgentTypes = new Map<string, string[]>();
  private toolRegistry: ToolRegistry;
  private agentRunner: AgentRunner | null = null;
  private teamManager: any = null;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  // -----------------------------------------------------------------------
  // Agent runner setup
  // -----------------------------------------------------------------------

  /** Set the agent runner (called after initialization). */
  setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
  }

  /** Set the team manager for multi-agent workflow support. */
  setTeamManager(tm: any): void {
    this.teamManager = tm;
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  /**
   * Register a plugin from its manifest.
   *
   * Stores the manifest in memory, wraps plugin tools as AgentTool instances
   * and registers them with the ToolRegistry, registers plugin agents with
   * the AgentRunner, and persists the plugin to the database.
   *
   * Returns the runtime PluginState.
   */
  async registerPlugin(manifest: PluginManifest): Promise<PluginState> {
    const now = new Date().toISOString();

    // Merge default config with any stored config
    const storedConfig = await this.loadStoredConfig(manifest.id);
    const config = {
      ...(manifest.defaultConfig ?? {}),
      ...storedConfig,
    };

    // Store manifest in memory
    this.manifests.set(manifest.id, manifest);

    // Register tools and agents
    let toolNames: string[] = [];
    let agentTypes: string[] = [];
    let error: string | undefined;

    try {
      toolNames = this.registerTools(manifest);
      agentTypes = this.registerAgents(manifest);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.error(
        `[PluginManager] Error registering plugin ${manifest.id}: ${error}`,
      );
    }

    // Track agent types for this plugin
    if (agentTypes.length > 0) {
      this.pluginAgentTypes.set(manifest.id, agentTypes);
    }

    // Build the state
    const state: PluginState = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      enabled: true,
      config,
      toolNames,
      agentTypes,
      loadedAt: now,
      error,
    };

    this.loadedPlugins.set(manifest.id, state);

    // Persist to database
    await this.persistPlugin(manifest, true);

    console.log(
      `[PluginManager] Registered plugin "${manifest.name}" (${manifest.id}) ` +
        `with ${toolNames.length} tools and ${agentTypes.length} agents`,
    );

    return state;
  }

  /**
   * Load all persisted plugins from the database and register their tools/agents.
   *
   * Note: Plugin manifests are stored in the config JSON column. Tool and agent
   * execute functions cannot be serialized, so only metadata is restored.
   * Plugins that were persisted but whose manifests cannot be fully loaded
   * (missing execute functions) are loaded in a metadata-only state.
   */
  async loadFromDatabase(): Promise<void> {
    const repos = await getRepos();
    const rows = await repos.plugin.list();

    console.log(`[PluginManager] Loading ${rows.length} plugins from database...`);

    for (const row of rows) {
      const config = row.config as Record<string, unknown> ?? {};
      const manifest = this.loadManifestFromPlugin(row);
      if (!manifest) {
        console.warn(
          `[PluginManager] Could not load manifest for plugin row: ${row.id}`,
        );
        // Still track the plugin as disabled/metadata-only
        const state: PluginState = {
          id: row.id,
          name: row.name,
          version: row.version ?? "0.0.1",
          description: "",
          enabled: false,
          config: {},
          toolNames: [],
          agentTypes: [],
          loadedAt: new Date().toISOString(),
          error: "Manifest could not be loaded from database (tools/agents require re-registration at runtime)",
        };
        this.loadedPlugins.set(row.id, state);
        continue;
      }

      const enabled = Boolean(row.enabled);

      if (enabled) {
        // Re-register tools and agents
        let toolNames: string[] = [];
        let agentTypes: string[] = [];
        let error: string | undefined;

        try {
          toolNames = this.registerTools(manifest);
          agentTypes = this.registerAgents(manifest);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        if (agentTypes.length > 0) {
          this.pluginAgentTypes.set(manifest.id, agentTypes);
        }

        this.manifests.set(manifest.id, manifest);

        const state: PluginState = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author,
          enabled: true,
          config: typeof config === "object" ? config : {},
          toolNames,
          agentTypes,
          loadedAt: new Date().toISOString(),
          error,
        };
        this.loadedPlugins.set(manifest.id, state);
      } else {
        // Plugin is disabled - just track metadata
        this.manifests.set(manifest.id, manifest);

        const state: PluginState = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author,
          enabled: false,
          config: typeof config === "object" ? config : {},
          toolNames: [],
          agentTypes: [],
          loadedAt: new Date().toISOString(),
        };
        this.loadedPlugins.set(manifest.id, state);
      }
    }

    console.log(
      `[PluginManager] Loaded ${this.loadedPlugins.size} plugins ` +
        `(${Array.from(this.loadedPlugins.values()).filter((p) => p.enabled).length} enabled)`,
    );
  }

  // -----------------------------------------------------------------------
  // Enable / Disable
  // -----------------------------------------------------------------------

  /** Enable a plugin by ID. Re-registers its tools and agents. */
  async enablePlugin(pluginId: string): Promise<void> {
    const state = this.loadedPlugins.get(pluginId);
    const manifest = this.manifests.get(pluginId);

    if (!state || !manifest) {
      throw new Error(`Plugin "${pluginId}" not found.`);
    }

    if (state.enabled) {
      return; // Already enabled
    }

    // Re-register tools and agents
    const toolNames = this.registerTools(manifest);
    const agentTypes = this.registerAgents(manifest);

    if (agentTypes.length > 0) {
      this.pluginAgentTypes.set(pluginId, agentTypes);
    }

    // Update state
    state.enabled = true;
    state.toolNames = toolNames;
    state.agentTypes = agentTypes;
    state.error = undefined;

    // Update database
    const repos = await getRepos();
    await repos.plugin.updateEnabled(pluginId, true);

    console.log(`[PluginManager] Enabled plugin "${pluginId}"`);
  }

  /** Disable a plugin by ID. Removes its tools and agents. */
  async disablePlugin(pluginId: string): Promise<void> {
    const state = this.loadedPlugins.get(pluginId);

    if (!state) {
      throw new Error(`Plugin "${pluginId}" not found.`);
    }

    if (!state.enabled) {
      return; // Already disabled
    }

    // Unregister tools and agents
    this.unregisterTools(state.toolNames);
    this.unregisterAgents(state.agentTypes);

    // Update state
    state.enabled = false;
    state.toolNames = [];
    state.agentTypes = [];

    // Update database
    const repos = await getRepos();
    await repos.plugin.updateEnabled(pluginId, false);

    console.log(`[PluginManager] Disabled plugin "${pluginId}"`);
  }

  // -----------------------------------------------------------------------
  // Unregister
  // -----------------------------------------------------------------------

  /** Unregister a plugin completely (DB + runtime). */
  async unregisterPlugin(pluginId: string): Promise<void> {
    const state = this.loadedPlugins.get(pluginId);

    if (!state) {
      throw new Error(`Plugin "${pluginId}" not found.`);
    }

    // Unregister tools and agents if enabled
    if (state.enabled) {
      this.unregisterTools(state.toolNames);
      this.unregisterAgents(state.agentTypes);
    }

    // Remove from runtime maps
    this.loadedPlugins.delete(pluginId);
    this.manifests.delete(pluginId);
    this.pluginAgentTypes.delete(pluginId);

    // Remove from database (CASCADE will delete associated skills)
    const repos = await getRepos();
    await repos.plugin.delete(pluginId);

    console.log(`[PluginManager] Unregistered plugin "${pluginId}"`);
  }

  // -----------------------------------------------------------------------
  // Plugin queries
  // -----------------------------------------------------------------------

  /** Get the runtime state of a plugin. */
  getPluginState(pluginId: string): PluginState | undefined {
    return this.loadedPlugins.get(pluginId);
  }

  /** List all loaded plugins. */
  listPlugins(): PluginState[] {
    return Array.from(this.loadedPlugins.values());
  }

  /** Update plugin configuration. */
  async updatePluginConfig(
    pluginId: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const state = this.loadedPlugins.get(pluginId);
    if (!state) {
      throw new Error(`Plugin "${pluginId}" not found.`);
    }

    // Merge new config into existing
    state.config = { ...state.config, ...config };

    // Persist to database
    const repos = await getRepos();
    await repos.plugin.updateConfig(pluginId, state.config);

    // If enabled and has tools, re-register tools with updated config
    if (state.enabled) {
      const manifest = this.manifests.get(pluginId);
      if (manifest?.tools?.length) {
        this.unregisterTools(state.toolNames);
        const toolNames = this.registerTools(manifest);
        state.toolNames = toolNames;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Skills
  // -----------------------------------------------------------------------

  /** Create a new skill. */
  async createSkill(skill: Omit<SkillDefinition, "id">): Promise<SkillDefinition> {
    const id = randomUUID();
    const fullSkill: SkillDefinition = { id, ...skill };

    const repos = await getRepos();
    await repos.skill.create({
      id,
      name: skill.name,
      pluginId: skill.pluginId ?? null,
      description: skill.description,
      config: {
        systemPrompt: skill.systemPrompt,
        tools: skill.tools,
        variables: skill.variables,
        modelRole: skill.modelRole,
        maxTurns: skill.maxTurns,
        config: skill.config,
      },
    });

    console.log(`[PluginManager] Created skill "${skill.name}" (${id})`);
    return fullSkill;
  }

  /** Get a skill by ID. */
  async getSkill(skillId: string): Promise<SkillDefinition | undefined> {
    const repos = await getRepos();
    const row = await repos.skill.get(skillId);

    if (!row) return undefined;
    return this.repoSkillToDefinition(row);
  }

  /** List all skills, optionally filtered by plugin. */
  async listSkills(pluginId?: string): Promise<SkillDefinition[]> {
    const repos = await getRepos();
    const rows = await repos.skill.list(pluginId);
    return rows.map((row) => this.repoSkillToDefinition(row));
  }

  /** Delete a skill by ID. */
  async deleteSkill(skillId: string): Promise<void> {
    const repos = await getRepos();
    const deleted = await repos.skill.delete(skillId);

    if (!deleted) {
      throw new Error(`Skill "${skillId}" not found.`);
    }

    console.log(`[PluginManager] Deleted skill ${skillId}`);
  }

  /**
   * Resolve a skill's system prompt by filling in variable values.
   * Replaces {{variableName}} placeholders with provided values.
   */
  async resolveSkillPrompt(
    skillId: string,
    variables: Record<string, string>,
  ): Promise<string> {
    const skill = await this.getSkill(skillId);
    if (!skill) {
      throw new Error(`Skill "${skillId}" not found.`);
    }

    let prompt = skill.systemPrompt;

    // Fill in provided variables
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // Fill in default values for unset variables
    if (skill.variables) {
      for (const variable of skill.variables) {
        if (variable.defaultValue) {
          prompt = prompt.replace(
            new RegExp(`\\{\\{${variable.name}\\}\\}`, "g"),
            variable.defaultValue,
          );
        }
      }
    }

    // Check for required but unset variables
    if (skill.variables) {
      for (const variable of skill.variables) {
        if (variable.required && !variables[variable.name] && !variable.defaultValue) {
          if (prompt.includes(`{{${variable.name}}}`)) {
            throw new Error(
              `Required variable "${variable.name}" not provided for skill "${skill.name}".`,
            );
          }
        }
      }
    }

    return prompt;
  }

  // -----------------------------------------------------------------------
  // Private helpers - Tool registration
  // -----------------------------------------------------------------------

  /**
   * Register a plugin's tools into the ToolRegistry.
   * Wraps each PluginToolDefinition as an AgentTool, binding the plugin config.
   */
  private registerTools(manifest: PluginManifest): string[] {
    if (!manifest.tools || manifest.tools.length === 0) {
      return [];
    }

    const pluginConfig = this.getPluginConfig(manifest.id);
    const toolNames: string[] = [];

    for (const toolDef of manifest.tools) {
      // Wrap the plugin tool as an AgentTool, binding the config
      const wrappedTool: AgentTool = {
        name: toolDef.name,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        execute: (input: Record<string, unknown>) =>
          toolDef.execute(input, pluginConfig),
      };

      this.toolRegistry.register(wrappedTool);
      toolNames.push(toolDef.name);
    }

    return toolNames;
  }

  /** Unregister a plugin's tools from the ToolRegistry. */
  private unregisterTools(toolNames: string[]): void {
    for (const name of toolNames) {
      this.toolRegistry.unregister(name);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers - Agent registration
  // -----------------------------------------------------------------------

  /**
   * Register a plugin's agent definitions into the AgentRunner.
   * Converts PluginAgentDefinition to AgentDefinition format.
   */
  private registerAgents(manifest: PluginManifest): string[] {
    if (!manifest.agents || manifest.agents.length === 0 || !this.agentRunner) {
      return [];
    }

    const agentTypes: string[] = [];

    for (const agentDef of manifest.agents) {
      this.agentRunner.registerAgent({
        agentType: agentDef.agentType,
        description: agentDef.description,
        systemPrompt: agentDef.systemPrompt,
        tools: agentDef.tools,
        modelRole: agentDef.modelRole as "main" | "summarizer" | "embedding" | "vlm" | undefined,
        maxTurns: agentDef.maxTurns,
        readOnly: agentDef.readOnly,
      });

      agentTypes.push(agentDef.agentType);
    }

    return agentTypes;
  }

  /**
   * Unregister agent definitions.
   * Since AgentRunner does not expose an unregister method, we remove
   * them from our tracking map. Agents will remain in the AgentRunner
   * but can be overwritten by re-registration.
   */
  private unregisterAgents(agentTypes: string[]): void {
    // Remove from our tracking. AgentRunner doesn't have unregister,
    // but plugin agents can be overwritten.
    this.pluginAgentTypes.delete(
      // Find the plugin ID that owns these agent types
      Array.from(this.pluginAgentTypes.entries()).find(
        ([, types]) => types.some((t) => agentTypes.includes(t)),
      )?.[0] ?? "",
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers - Database persistence
  // -----------------------------------------------------------------------

  /** Persist a plugin to the database. */
  private async persistPlugin(manifest: PluginManifest, enabled: boolean): Promise<void> {
    const repos = await getRepos();

    // Serialize the full manifest into the config JSON so we can restore it.
    // Note: The execute functions cannot be serialized; they are lost and
    // must be re-registered at runtime.
    const configJson: Record<string, unknown> = {
      description: manifest.description,
      author: manifest.author,
      tools: (manifest.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      agents: (manifest.agents ?? []).map((a) => ({
        agentType: a.agentType,
        description: a.description,
        systemPrompt: a.systemPrompt,
        tools: a.tools,
        modelRole: a.modelRole,
        maxTurns: a.maxTurns,
        readOnly: a.readOnly,
      })),
      configSchema: manifest.configSchema,
      defaultConfig: manifest.defaultConfig,
    };

    await repos.plugin.upsert({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      enabled,
      config: configJson,
    });
  }

  /**
   * Load a plugin's manifest from a plugin repo row.
   * Note: Tool execute functions are NOT restored (cannot be serialized).
   * The manifest returned will have tools without execute functions.
   */
  private loadManifestFromPlugin(
    row: { id: string; name: string; version: string; config: Record<string, unknown> | null },
  ): PluginManifest | null {
    try {
      const config = row.config;
      if (!config) return null;

      return {
        id: row.id,
        name: row.name,
        version: row.version,
        description: (config.description as string) ?? "",
        author: config.author as string | undefined,
        tools: Array.isArray(config.tools)
          ? (config.tools as Array<Record<string, unknown>>).map((t) => ({
              name: t.name as string,
              description: t.description as string,
              inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
              // Execute cannot be restored from DB - use a no-op stub
              execute: async () => ({
                error: "Plugin tool execute function not available after database reload. Re-register the plugin at runtime.",
              }),
            }))
          : undefined,
        agents: Array.isArray(config.agents)
          ? (config.agents as Array<Record<string, unknown>>).map((a) => ({
              agentType: a.agentType as string,
              description: a.description as string,
              systemPrompt: a.systemPrompt as string,
              tools: a.tools as string[],
              modelRole: a.modelRole as string | undefined,
              maxTurns: a.maxTurns as number | undefined,
              readOnly: a.readOnly as boolean | undefined,
            }))
          : undefined,
        configSchema: config.configSchema as Record<string, unknown> | undefined,
        defaultConfig: config.defaultConfig as Record<string, unknown> | undefined,
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers - Utilities
  // -----------------------------------------------------------------------

  /** Get the current config for a plugin. */
  private getPluginConfig(pluginId: string): Record<string, unknown> {
    const state = this.loadedPlugins.get(pluginId);
    return state?.config ?? {};
  }

  /** Load stored config for a plugin from the database. */
  private async loadStoredConfig(pluginId: string): Promise<Record<string, unknown> | null> {
    try {
      const repos = await getRepos();
      const row = await repos.plugin.get(pluginId);

      if (!row?.config) return null;

      // The stored config JSON contains manifest metadata too.
      // We only want the plugin-specific config values, not the manifest.
      // For now, return the full config and let callers decide.
      return row.config;
    } catch {
      return null;
    }
  }

  /** Convert a repo Skill row to a SkillDefinition. */
  private repoSkillToDefinition(row: { id: string; name: string; pluginId: string; description?: string; config: Record<string, unknown> | null }): SkillDefinition {
    const config = row.config ?? {};

    return {
      id: row.id,
      name: row.name,
      pluginId: row.pluginId ?? null,
      description: row.description ?? "",
      systemPrompt: (config.systemPrompt as string) ?? "",
      tools: (config.tools as string[]) ?? ["*"],
      variables: config.variables as SkillVariable[] | undefined,
      modelRole: config.modelRole as string | undefined,
      maxTurns: config.maxTurns as number | undefined,
      config: (config.config as Record<string, unknown>) ?? {},
    };
  }
}
