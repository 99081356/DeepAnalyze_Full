// Stub: tools.ts - Tool progress types
export type ToolProgressData = Record<string, unknown>

export interface BashProgress extends ToolProgressData {
  command?: string
  exitCode?: number
}

export interface MCPProgress extends ToolProgressData {
  serverName?: string
  toolName?: string
}

export interface AgentToolProgress extends ToolProgressData {
  agentId?: string
}

export interface REPLToolProgress extends ToolProgressData {
  language?: string
}

export interface SkillToolProgress extends ToolProgressData {
  skillName?: string
}

export interface TaskOutputProgress extends ToolProgressData {
  taskId?: string
}

export interface WebSearchProgress extends ToolProgressData {
  query?: string
}
