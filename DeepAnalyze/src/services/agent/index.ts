// =============================================================================
// DeepAnalyze - Agent Module
// =============================================================================
// Public API for the standalone agent execution system.
// =============================================================================

export { AgentRunner } from "./agent-runner.js";
export { ToolRegistry } from "./tool-registry.js";
export { Orchestrator } from "./orchestrator.js";
export { createConfiguredToolRegistry } from "./tool-setup.js";
export type { ToolSetupDeps } from "./tool-setup.js";
export {
  BUILT_IN_AGENTS,
  GENERAL_AGENT,
  EXPLORE_AGENT,
  COMPILE_AGENT,
  VERIFY_AGENT,
  COORDINATOR_AGENT,
} from "./agent-definitions.js";
export type {
  AgentDefinition,
  AgentTool,
  AgentStatus,
  AgentTask,
  AgentProgressEntry,
  AgentEvent,
  AgentResult,
  AgentRunOptions,
  SessionMemoryNote,
  AgentSettings,
} from "./types.js";
export { DEFAULT_AGENT_SETTINGS } from "./types.js";
export type { SubTask, OrchestratorResult } from "./orchestrator.js";
export { getOrchestrator, getCompounder, getPluginManager, resetOrchestrator, isOrchestratorReady } from "./agent-system.js";
export { ContextManager } from "./context-manager.js";
export { CompactionEngine } from "./compaction.js";
export { MicroCompactor } from "./micro-compact.js";
export { SessionMemoryManager, replaceSessionMemoryInjection } from "./session-memory.js";
export { AutoDreamManager } from "./auto-dream.js";
export { validateMessageSequence, repairMessageSequence } from "./message-utils.js";
export { WorkflowEngine } from "./workflow-engine.js";
export type {
  WorkflowMode,
  WorkflowAgent,
  WorkflowInput,
  WorkflowAgentResult,
  WorkflowResult,
  WorkflowEvent,
  WorkflowStartEvent,
  WorkflowCompleteEvent,
  WorkflowAgentStartEvent,
  WorkflowAgentCompleteEvent,
  WorkflowAgentChunkEvent,
  WorkflowAgentToolCallEvent,
  WorkflowAgentToolResultEvent,
} from "./workflow-engine.js";
