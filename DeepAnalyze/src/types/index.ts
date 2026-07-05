// =============================================================================
// DeepAnalyze - Core Type Definitions
// =============================================================================

/** Knowledge base visibility levels */
export type Visibility = 'private' | 'team' | 'public';

/** Document processing status */
export type DocumentStatus = 'uploaded' | 'parsing' | 'compiling' | 'ready' | 'error';

/** Wiki page types */
export type PageType = 'abstract' | 'overview' | 'fulltext' | 'structure' | 'entity' | 'concept' | 'report';

/** Wiki link types */
export type LinkType = 'forward' | 'backward' | 'entity_ref' | 'concept_ref';

/** Chat message roles */
export type MessageRole = 'user' | 'assistant' | 'tool';

/** User roles */
export type UserRole = 'admin' | 'user';

/** Agent task status */
export type AgentTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

// -----------------------------------------------------------------------------
// Interfaces
// -----------------------------------------------------------------------------

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  kbId: string;
  filename: string;
  filePath: string;
  fileHash: string;
  fileSize: number;
  fileType: string;
  status: DocumentStatus;
  metadata: string | null; // JSON string
  createdAt: string;
  processingStep: string | null;
  processingProgress: number;
  processingError: string | null;
}

export interface WikiPage {
  id: string;
  kbId: string;
  docId: string | null;
  pageType: PageType;
  title: string;
  filePath: string;
  contentHash: string;
  tokenCount: number;
  metadata: string | null; // JSON string
  createdAt: string;
  updatedAt: string;
}

export interface WikiLink {
  id: string;
  sourcePageId: string;
  targetPageId: string;
  linkType: LinkType;
  entityName: string | null;
  context: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  title: string | null;
  kbScope: string | null; // JSON array of kb IDs
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  metadata: string | null; // JSON string
  createdAt: string;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

export interface AgentTask {
  id: string;
  parentTaskId: string | null;
  sessionId: string | null;
  agentType: string;
  status: AgentTaskStatus;
  input: string | null; // JSON string
  output: string | null; // JSON string
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
