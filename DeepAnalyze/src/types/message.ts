// Stub: message.ts - Generated message types
export interface BaseMessage {
  uuid: string
  type: string
  timestamp: number
  [key: string]: unknown
}

export interface UserMessage extends BaseMessage {
  type: 'user'
  message: { role: 'user'; content: unknown }
}

export interface AssistantMessage extends BaseMessage {
  type: 'assistant'
  message: { role: 'assistant'; content: unknown[] }
  apiError?: string | null
  [key: string]: unknown
}

export interface SystemMessage extends BaseMessage {
  type: 'system'
  message: { role: 'system'; content: string }
}

export interface SystemLocalCommandMessage extends BaseMessage {
  type: 'system_local_command'
}

export interface ProgressMessage extends BaseMessage {
  type: 'progress'
}

export interface AttachmentMessage extends BaseMessage {
  type: 'attachment'
}

export interface ToolUseSummaryMessage extends BaseMessage {
  type: 'tool_use_summary'
}

export interface TombstoneMessage extends BaseMessage {
  type: 'tombstone'
}

export type Message = UserMessage | AssistantMessage | SystemMessage | SystemLocalCommandMessage | ProgressMessage | AttachmentMessage | ToolUseSummaryMessage | TombstoneMessage

export interface RequestStartEvent {
  type: 'request_start'
  [key: string]: unknown
}

export interface StreamEvent {
  type: string
  [key: string]: unknown
}
