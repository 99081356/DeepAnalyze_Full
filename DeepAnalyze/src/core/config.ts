// =============================================================================
// DeepAnalyze - Central Configuration
// =============================================================================
//
// Single source of truth for all runtime configuration knobs.  Environment
// variables take precedence over the defaults below.
// =============================================================================

export const DEEPANALYZE_CONFIG = {
  /** Human-readable application name (used in logs, prompts, etc.) */
  appName: "DeepAnalyze",

  /** Semantic version of the application */
  version: "0.7.7",

  /** Name of the context / system-instructions template file.
   *  Replaces the upstream CLAUDE.md convention. */
  systemFile: "SYSTEM.md",

  /** Permission mode.  "bypassPermissions" means every tool call is
   *  auto-approved (see src/core/auto-approve.ts). */
  permissionMode: "bypassPermissions" as const,

  /** Whether to inject git context into the system prompt. */
  includeGitContext: false,

  /** Whether to load and inject CLAUDE.md files from the working tree. */
  includeClaudeMd: false,

  /** Root data directory (knowledge base, uploads, etc.). */
  dataDir: process.env.DATA_DIR || "data",

  /** HTTP server port for the API layer. */
  port: parseInt(process.env.PORT || "21000", 10),

  /** Path to the YAML model configuration file. */
  modelConfigPath: process.env.MODEL_CONFIG || "config/default.yaml",

  /** Run mode: "standalone" (default) or "worker". Activates when a Hub/Server
   *  URL is set — accepts either DA_SERVER_URL (worker-native) or DA_HUB_URL
   *  (the alias the Hub uses when it distributes a container). */
  runMode: ((process.env.DA_SERVER_URL || process.env.DA_HUB_URL)
    ? "worker"
    : "standalone") as "standalone" | "worker",

  /** Server URL for Worker mode. Empty in standalone mode. */
  serverUrl: process.env.DA_SERVER_URL || process.env.DA_HUB_URL || "",

  /** Worker ID. "auto" generates and persists a UUID in dataDir/.worker-id. */
  workerId: process.env.DA_WORKER_ID || "auto",

  /** Authentication token issued by the Server during registration.
   *  Falls back to DA_HUB_WORKER_TOKEN (the alias the Hub sets when it
   *  distributes a container). */
  workerToken: process.env.DA_WORKER_TOKEN || process.env.DA_HUB_WORKER_TOKEN || "",
} as const

/** Type helper: extracts the type of DEEPANALYZE_CONFIG for downstream consumers. */
export type DeepAnalyzeConfig = typeof DEEPANALYZE_CONFIG
