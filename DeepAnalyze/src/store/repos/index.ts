// =============================================================================
// DeepAnalyze - Repository Factory (PG-only)
// Creates and caches a singleton RepoSet backed by PostgreSQL.
// =============================================================================

import type { RepoSet } from './interfaces';
import { getPool } from '../pg';

import { PgVectorSearchRepo } from './vector-search';
import { PgFTSSearchRepo } from './fts-search';
import { PgAnchorRepo } from './anchor';
import { PgWikiPageRepo } from './wiki-page';
import { PgDocumentRepo } from './document';
import { PgEmbeddingRepo } from './embedding';
import { PgSessionRepo } from './session';
import { PgMessageRepo } from './message';
import { PgKnowledgeBaseRepo } from './knowledge-base';
import { PgWikiLinkRepo } from './wiki-link';
import { PgSettingsRepo } from './settings';
import { PgReportRepo } from './report';
import { PgAgentTeamRepo } from './agent-team';
import { PgCronJobRepo } from './cron-job';
import { PgPluginRepo } from './plugin';
import { PgSkillRepo } from './skill';
import { PgSessionMemoryRepo } from './session-memory';
import { PgAgentTaskRepo } from './agent-task';
import { PgAgentSkillRepo } from './agent-skill';
import { PgWorkflowLogRepo } from './workflow-log';
import { PgWorkflowRepo } from './workflow';
import { PgAgentMemoryRepo } from './agent-memory';
import { PgSkillUsageRepo } from './skill-usage';
import { PgSkillVersionRepo } from './skill-version';

let cachedRepos: RepoSet | null = null;
let initPromise: Promise<RepoSet> | null = null;

/**
 * Get the singleton RepoSet. Initializes PG pool and creates all repos on first call.
 */
export async function getRepos(): Promise<RepoSet> {
  if (cachedRepos) return cachedRepos;
  if (!initPromise) {
    initPromise = (async () => {
      const pool = await getPool();
      cachedRepos = {
        vectorSearch: new PgVectorSearchRepo(pool),
        ftsSearch: new PgFTSSearchRepo(pool),
        anchor: new PgAnchorRepo(pool),
        wikiPage: new PgWikiPageRepo(pool),
        document: new PgDocumentRepo(pool),
        embedding: new PgEmbeddingRepo(pool),
        session: new PgSessionRepo(pool),
        message: new PgMessageRepo(pool),
        knowledgeBase: new PgKnowledgeBaseRepo(pool),
        wikiLink: new PgWikiLinkRepo(pool),
        settings: new PgSettingsRepo(pool),
        report: new PgReportRepo(pool),
        agentTeam: new PgAgentTeamRepo(pool),
        cronJob: new PgCronJobRepo(pool),
        plugin: new PgPluginRepo(pool),
        skill: new PgSkillRepo(pool),
        sessionMemory: new PgSessionMemoryRepo(pool),
        agentTask: new PgAgentTaskRepo(pool),
        agentSkill: new PgAgentSkillRepo(pool),
        workflowLog: new PgWorkflowLogRepo(pool),
        workflow: new PgWorkflowRepo(pool),
        agentMemory: new PgAgentMemoryRepo(),
        skillUsage: new PgSkillUsageRepo(),
        skillVersion: new PgSkillVersionRepo(),
      };
      return cachedRepos;
    })();
  }
  return initPromise;
}

export const createReposAsync = getRepos;

export function resetRepos(): void {
  cachedRepos = null;
  initPromise = null;
}

export type {
  RepoSet,
  AnchorDef,
  WikiPage,
  WikiPageCreate,
  Document,
  EmbeddingRow,
  EmbeddingCreate,
  VectorSearchResult,
  FTSSearchResult,
  VectorSearchRepo,
  FTSSearchRepo,
  AnchorRepo,
  WikiPageRepo,
  DocumentRepo,
  EmbeddingRepo,
  SessionRepo,
  MessageRepo,
  KnowledgeBaseRepo,
  WikiLinkRepo,
  SettingsRepo,
  ReportRepo,
  AgentTeamRepo,
  CronJobRepo,
  PluginRepo,
  SkillRepo,
  SessionMemoryRepo,
  AgentTaskRepo,
  Session,
  Message,
  KnowledgeBase,
  WikiLink,
  WikiPageSummary,
  SettingEntry,
  Report,
  ReportReference,
  ReportWithReferences,
  CreateReportData,
  AgentTeam,
  AgentTeamMember,
  AgentTeamWithMembers,
  CreateTeamData,
  UpdateTeamData,
  TeamMode,
  CronJob,
  NewCronJob,
  Plugin,
  NewPlugin,
  Skill,
  NewSkill,
  SessionMemory,
  AgentTask,
  NewAgentTask,
  AgentSkill,
  NewAgentSkill,
  UpdateAgentSkill,
  AgentSkillRepo,
  WorkflowLogRepo,
  WorkflowLog,
  NewWorkflowLog,
  WorkflowRepo,
  Workflow,
  NewWorkflow,
  WorkflowStatus,
  ProviderConfig,
  ProviderDefaults,
  ProviderSettings,
  DoclingConfig,
} from './interfaces';

export { DEFAULT_DOCLING_CONFIG } from './interfaces';
