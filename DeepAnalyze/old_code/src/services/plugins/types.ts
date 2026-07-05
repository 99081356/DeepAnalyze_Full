// =============================================================================
// DeepAnalyze - Plugin System Types
// =============================================================================
// Type definitions for the plugin system: manifests, tools, agents, skills.
// =============================================================================

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

/** A plugin that can extend the agent system with custom tools and agents. */
export interface PluginManifest {
  /** Unique identifier for the plugin. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semantic version (e.g. "1.0.0"). */
  version: string;
  /** Description of what the plugin does. */
  description: string;
  /** Author name or organization. */
  author?: string;
  /** Custom tools provided by this plugin. */
  tools?: PluginToolDefinition[];
  /** Custom agent definitions provided by this plugin. */
  agents?: PluginAgentDefinition[];
  /** Plugin-specific configuration schema. */
  configSchema?: Record<string, unknown>;
  /** Default configuration values. */
  defaultConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin tool
// ---------------------------------------------------------------------------

/** A tool contributed by a plugin. */
export interface PluginToolDefinition {
  /** Tool name (must be unique across all plugins). */
  name: string;
  /** Tool description for the LLM. */
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  /** The execute function. Receives input and plugin config. */
  execute: (input: Record<string, unknown>, config: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Plugin agent
// ---------------------------------------------------------------------------

/** An agent definition contributed by a plugin. */
export interface PluginAgentDefinition {
  /** Agent type name (must be unique). */
  agentType: string;
  /** Human-readable description. */
  description: string;
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Tool names this agent can use. ["*"] for all tools. */
  tools: string[];
  /** Model role to use (default: "main"). */
  modelRole?: string;
  /** Maximum turns (default: 20). */
  maxTurns?: number;
  /** Whether this agent only reads data. */
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Plugin runtime state
// ---------------------------------------------------------------------------

/** Runtime state of a loaded plugin. */
export interface PluginState {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  toolNames: string[];
  agentTypes: string[];
  loadedAt: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** A skill - reusable agent template. */
export interface SkillDefinition {
  id: string;
  name: string;
  pluginId: string | null;
  description: string;
  /** System prompt template. Supports {{variable}} placeholders. */
  systemPrompt: string;
  /** Tool names the skill uses. ["*"] for all. */
  tools: string[];
  /** Template variables that should be filled when using the skill. */
  variables?: SkillVariable[];
  /** Model role. */
  modelRole?: string;
  /** Max turns. */
  maxTurns?: number;
  /** Skill config as JSON. */
  config: Record<string, unknown>;
  /** Optional multi-agent scheduling configuration for team-based skills. */
  scheduling?: {
    mode: "pipeline" | "graph" | "council" | "parallel";
    teamName?: string;
    agents?: Array<{ role: string; task: string; tools: string[] }>;
  };
}

/** A variable placeholder in a skill template. */
export interface SkillVariable {
  name: string;
  description: string;
  required: boolean;
  defaultValue?: string;
}
