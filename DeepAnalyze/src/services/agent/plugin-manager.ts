import type { AgentDefinition } from "./types.js";
import type { SkillManifest } from "./skill-loader.js";
import { loadSkillsFromDir } from "./skill-loader.js";
import type { HookManager } from "./hooks.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { HookType, HookContext, HookResult } from "./hook-types.js";

// ---------------------------------------------------------------------------
// Plugin manifest (file-based)
// Compatible with both DA and Claude Code (CC) / OpenClaw formats.
// ---------------------------------------------------------------------------

/**
 * Plugin manifest supporting both DA and CC/OpenClaw formats.
 *
 * DA format (plugin.json at root):
 * {
 *   "name": "my-plugin",
 *   "version": "1.0.0",
 *   "capabilities": ["skills", "agents"],
 *   "skills": ["skills/my-skill"],
 *   "agents": ["agents/my-agent.md"]
 * }
 *
 * CC format (.claude-plugin/plugin.json):
 * {
 *   "name": "my-plugin",
 *   "version": "1.0.0",
 *   "description": "...",
 *   "skills": "skills/",
 *   "agents": ["agents/a.md"],
 *   "author": { "name": "..." },
 *   "mcpServers": { ... },
 *   ...
 * }
 *
 * Both formats are accepted. CC-specific fields are ignored silently.
 */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  capabilities?: Array<"skills" | "agents" | "hooks" | "tools">;
  skills?: Array<string | { dir: string }>;
  agents?: Array<string | { file: string }>;
  /** Hook definitions: event name -> module file that exports a default handler function */
  hooks?: Record<string, string>;
  /** Tool definitions: each with a file path to the tool module */
  tools?: Array<{ file: string }>;
  // CC/OpenClaw extra fields (accepted but not processed)
  author?: unknown;
  homepage?: unknown;
  repository?: unknown;
  license?: unknown;
  keywords?: unknown;
  dependencies?: unknown;
  commands?: unknown;
  outputStyles?: unknown;
  channels?: unknown;
  mcpServers?: unknown;
  lspServers?: unknown;
  userConfig?: unknown;
  settings?: unknown;
  /** Allow any other fields from CC/OpenClaw manifests */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Loaded plugin
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  manifest: PluginManifest;
  rootDir: string;
  skills: SkillManifest[];
  agents: AgentDefinition[];
  /** Hook IDs registered by this plugin (for cleanup on unload). */
  loadedHookIds: string[];
  /** Tool names registered by this plugin (for cleanup on unload). */
  loadedToolNames: string[];
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const { stat } = await import("fs/promises");
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Normalize a manifest field to an array of strings.
 * CC uses string or string[]; DA uses Array<string | {dir/file: string}>.
 */
function normalizeToStringArray(value: unknown): Array<string | Record<string, string>> {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

// ---------------------------------------------------------------------------
// Plugin Manager (file-based)
// ---------------------------------------------------------------------------

/**
 * Manages plugin lifecycle for file-system-based plugins.
 * Loads plugins from directories containing plugin.json manifests.
 * Supports loading skills, agents, hooks, and tools from plugin directories.
 *
 * Compatible with both DA and CC/OpenClaw plugin directory structures:
 * - DA:  `<plugin-dir>/plugin.json`
 * - CC:  `<plugin-dir>/.claude-plugin/plugin.json`
 */
export class AgentPluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private hookManager: HookManager | null = null;
  private toolRegistry: ToolRegistry | null = null;

  /** Set the hook manager for plugin hook registration. */
  setHookManager(hookManager: HookManager): void {
    this.hookManager = hookManager;
  }

  /** Set the tool registry for plugin tool registration. */
  setToolRegistry(toolRegistry: ToolRegistry): void {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Load a plugin from a directory.
   * Searches for manifest at:
   *   1. `<dir>/plugin.json` (DA format, preferred)
   *   2. `<dir>/.claude-plugin/plugin.json` (CC/OpenClaw format)
   * If no manifest specifies skills/agents, auto-discovers from standard directories.
   */
  async loadPlugin(dirPath: string): Promise<LoadedPlugin> {
    const { readFile } = await import("fs/promises");
    const path = await import("path");

    // Find manifest: DA format first, then CC format
    const daManifest = path.join(dirPath, "plugin.json");
    const ccManifest = path.join(dirPath, ".claude-plugin", "plugin.json");

    let manifestPath: string;
    if (await fileExists(daManifest)) {
      manifestPath = daManifest;
    } else if (await fileExists(ccManifest)) {
      manifestPath = ccManifest;
    } else {
      throw new Error(
        `No plugin.json found in ${dirPath} or ${dirPath}/.claude-plugin/`,
      );
    }

    const manifestContent = await readFile(manifestPath, "utf-8");
    const manifest: PluginManifest = JSON.parse(manifestContent);

    const plugin: LoadedPlugin = {
      manifest,
      rootDir: dirPath,
      skills: [],
      agents: [],
      loadedHookIds: [],
      loadedToolNames: [],
      enabled: true,
    };

    // --- Load skills ---
    const skillRefs = normalizeToStringArray(manifest.skills);
    if (skillRefs.length > 0) {
      // Explicit skill paths in manifest
      for (const skillRef of skillRefs) {
        const dir = typeof skillRef === "string" ? skillRef : (skillRef as { dir: string }).dir;
        const skillDir = path.join(dirPath, dir);
        try {
          const skills = await loadSkillsFromDir(skillDir);
          plugin.skills.push(...skills);
        } catch (err) {
          console.warn(`[AgentPluginManager] Failed to load skills from ${skillDir}:`, err);
        }
      }
    } else {
      // Auto-discover: scan skills/ subdirectory for SKILL.md files
      const skillsDir = path.join(dirPath, "skills");
      try {
        const autoSkills = await loadSkillsFromDir(skillsDir);
        if (autoSkills.length > 0) {
          plugin.skills.push(...autoSkills);
          console.log(
            `[AgentPluginManager] Auto-discovered ${autoSkills.length} skills from ${skillsDir}`,
          );
        }
      } catch {
        // No skills/ directory — that's fine
      }
    }

    // --- Load agents ---
    const agentRefs = normalizeToStringArray(manifest.agents);
    if (agentRefs.length > 0) {
      for (const agentRef of agentRefs) {
        const file =
          typeof agentRef === "string"
            ? agentRef
            : (agentRef as { file: string }).file;
        const agentFile = path.join(dirPath, file);
        try {
          const content = await readFile(agentFile, "utf-8");
          const agentDef = parseAgentMd(content, path.basename(agentFile));
          plugin.agents.push(agentDef);
        } catch (err) {
          console.warn(
            `[AgentPluginManager] Failed to load agent from ${agentFile}:`,
            err,
          );
        }
      }
    } else {
      // Auto-discover: scan agents/ subdirectory for .md files
      const agentsDir = path.join(dirPath, "agents");
      try {
        const { readdir } = await import("fs/promises");
        const agentFiles = await readdir(agentsDir);
        for (const af of agentFiles) {
          if (af.endsWith(".md")) {
            const agentFile = path.join(agentsDir, af);
            try {
              const content = await readFile(agentFile, "utf-8");
              const agentDef = parseAgentMd(content, af);
              plugin.agents.push(agentDef);
            } catch (err) {
              console.warn(
                `[AgentPluginManager] Failed to load agent from ${agentFile}:`,
                err,
              );
            }
          }
        }
        if (plugin.agents.length > 0) {
          console.log(
            `[AgentPluginManager] Auto-discovered ${plugin.agents.length} agents from ${agentsDir}`,
          );
        }
      } catch {
        // No agents/ directory — that's fine
      }
    }

    // --- Load hooks ---
    if (manifest.hooks && this.hookManager) {
      for (const [eventName, moduleFile] of Object.entries(manifest.hooks)) {
        if (typeof moduleFile !== "string") continue;
        try {
          const hookModulePath = path.join(dirPath, moduleFile);
          const hookModule = await import(hookModulePath);
          const handler = hookModule.default ?? hookModule.handler;
          if (typeof handler === "function") {
            const hookType = eventName as HookType;
            const hookId = `plugin-${manifest.name}-${eventName}`;
            this.hookManager.registerCallbackHook(
              hookType,
              hookId,
              handler as (ctx: HookContext) => Promise<HookResult>,
            );
            plugin.loadedHookIds.push(hookId);
            console.log(
              `[AgentPluginManager] Registered hook "${hookId}" for event "${eventName}" from plugin "${manifest.name}"`,
            );
          } else {
            console.warn(
              `[AgentPluginManager] Hook module ${moduleFile} does not export a default function or handler`,
            );
          }
        } catch (err) {
          console.warn(
            `[AgentPluginManager] Failed to load hook "${eventName}" from ${moduleFile}:`,
            err,
          );
        }
      }
    }

    // --- Load tools ---
    if (manifest.tools && this.toolRegistry) {
      for (const toolDef of manifest.tools) {
        try {
          const toolModulePath = path.join(dirPath, toolDef.file);
          const toolModule = await import(toolModulePath);
          const tool = toolModule.default ?? toolModule.tool;
          if (
            tool &&
            typeof tool === "object" &&
            tool.name &&
            typeof tool.execute === "function"
          ) {
            this.toolRegistry.register(tool);
            plugin.loadedToolNames.push(tool.name);
            console.log(
              `[AgentPluginManager] Registered tool "${tool.name}" from plugin "${manifest.name}"`,
            );
          } else {
            console.warn(
              `[AgentPluginManager] Tool module ${toolDef.file} does not export a valid tool object`,
            );
          }
        } catch (err) {
          console.warn(
            `[AgentPluginManager] Failed to load tool from ${toolDef.file}:`,
            err,
          );
        }
      }
    }

    this.plugins.set(manifest.name, plugin);
    return plugin;
  }

  /**
   * Discover plugins by scanning directories for plugin.json files.
   * Supports both DA format (plugin.json at root) and CC format (.claude-plugin/plugin.json).
   * @param searchPaths Directories to scan for plugin subdirectories
   * @returns Array of loaded plugins
   */
  async discoverPlugins(searchPaths: string[]): Promise<LoadedPlugin[]> {
    const { readdir } = await import("fs/promises");
    const path = await import("path");
    const loaded: LoadedPlugin[] = [];

    for (const searchPath of searchPaths) {
      try {
        const entries = await readdir(searchPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const pluginDir = path.join(searchPath, entry.name);

          // Check DA format (plugin.json) or CC format (.claude-plugin/plugin.json)
          const hasDAManifest = await fileExists(
            path.join(pluginDir, "plugin.json"),
          );
          const hasCCManifest = await fileExists(
            path.join(pluginDir, ".claude-plugin", "plugin.json"),
          );

          if (hasDAManifest || hasCCManifest) {
            try {
              const plugin = await this.loadPlugin(pluginDir);
              loaded.push(plugin);
              console.log(
                `[AgentPluginManager] Discovered and loaded plugin: ${plugin.manifest.name} from ${pluginDir}`,
              );
            } catch (err) {
              console.warn(
                `[AgentPluginManager] Failed to load plugin from ${pluginDir}:`,
                err,
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          `[AgentPluginManager] Failed to scan plugin directory ${searchPath}:`,
          err,
        );
      }
    }

    return loaded;
  }

  /** Get all skills from all enabled plugins */
  getAllSkills(): SkillManifest[] {
    const skills: SkillManifest[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled) skills.push(...plugin.skills);
    }
    return skills;
  }

  /** Get all agents from all enabled plugins */
  getAllAgents(): AgentDefinition[] {
    const agents: AgentDefinition[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled) agents.push(...plugin.agents);
    }
    return agents;
  }

  /** Enable or disable a plugin */
  setEnabled(name: string, enabled: boolean): void {
    const plugin = this.plugins.get(name);
    if (plugin) plugin.enabled = enabled;
  }

  /** Unload a plugin (removes hooks and tools) */
  unload(name: string): boolean {
    return this.plugins.delete(name);
  }

  /** Get a loaded plugin by name */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /** List all loaded plugins */
  list(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }
}

// ---------------------------------------------------------------------------
// Agent MD parser
// ---------------------------------------------------------------------------

/**
 * Parse an agent definition from a Markdown file.
 * Uses YAML frontmatter for metadata, body for system prompt.
 */
function parseAgentMd(content: string, fileName: string): AgentDefinition {
  const frontmatterMatch = content.match(
    /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
  );

  if (!frontmatterMatch) {
    // No frontmatter — use entire content as system prompt
    return {
      agentType: fileName.replace(/\.md$/, ""),
      description: "",
      systemPrompt: content.trim(),
      tools: ["*"],
    };
  }

  const yaml = frontmatterMatch[1]!;
  const body = frontmatterMatch[2]!.trim();
  const meta = parseSimpleFrontmatter(yaml);

  // Tools: accept both DA "tools" and CC "allowed-tools"
  const rawTools = meta.tools ?? meta["allowed-tools"];
  const tools =
    typeof rawTools === "string"
      ? [rawTools]
      : Array.isArray(rawTools)
        ? (rawTools as string[])
        : ["*"];

  return {
    agentType:
      (meta.agentType as string) ?? fileName.replace(/\.md$/, ""),
    description: (meta.description as string) ?? "",
    systemPrompt: body,
    tools,
    modelRole: meta["model-role"] as AgentDefinition["modelRole"],
    maxTurns: meta.maxTurns as number | undefined,
    readOnly: meta.readOnly as boolean | undefined,
  };
}

function parseSimpleFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const match = line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      const key = match[1]!;
      const value = match[2]!.trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        result[key] = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim());
      } else if (value === "true") {
        result[key] = true;
      } else if (value === "false") {
        result[key] = false;
      } else if (!isNaN(Number(value))) {
        result[key] = Number(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}
