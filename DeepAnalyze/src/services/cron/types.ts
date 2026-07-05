// =============================================================================
// DeepAnalyze - Cron Types
// Type definitions for the cron job system
// =============================================================================

/** Supported system-level actions for cron jobs */
export type CronAction = "reindex" | "cleanup" | "health_check";

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  message: string;
  /** System action to execute. If set, overrides agent prompt execution. */
  action: CronAction | null;
  enabled: boolean;
  channel: string | null;
  chatId: string | null;
  deliverResponse: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
  /** Knowledge base ID to scope the agent session to. */
  kbId: string | null;
  /** Agent type to use for execution (default: "general"). */
  agentType: string | null;
}

export interface CreateCronJobRequest {
  name: string;
  schedule: string;
  /** Agent prompt message. Required when action is null. */
  message?: string;
  /** System action. When set, the scheduler executes this action directly. */
  action?: CronAction | null;
  enabled?: boolean;
  channel?: string | null;
  chatId?: string | null;
  deliverResponse?: boolean;
  /** Knowledge base ID to scope agent execution. */
  kbId?: string | null;
  /** Agent type for execution (default: "general"). */
  agentType?: string | null;
}

export interface UpdateCronJobRequest extends Partial<CreateCronJobRequest> {}

export interface CronJobDetail extends CronJob {
  lastResponse: string | null;
}

// Database row type (snake_case)
export interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  message: string;
  action: string | null;
  enabled: number;
  channel: string | null;
  chat_id: string | null;
  deliver_response: number;
  last_run: string | null;
  next_run: string | null;
  last_status: string | null;
  last_error: string | null;
  run_count: number;
  error_count: number;
  created_at: string;
  updated_at: string;
  kb_id: string | null;
  agent_type: string | null;
}

/** Convert a database row to a CronJob object */
export function rowToJob(row: CronJobRow): CronJob {
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    message: row.message,
    action: (row.action as CronAction) ?? null,
    enabled: row.enabled === 1,
    channel: row.channel,
    chatId: row.chat_id,
    deliverResponse: row.deliver_response === 1,
    lastRun: row.last_run,
    nextRun: row.next_run,
    lastStatus: row.last_status,
    lastError: row.last_error,
    runCount: row.run_count,
    errorCount: row.error_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kbId: row.kb_id ?? null,
    agentType: row.agent_type ?? null,
  };
}
