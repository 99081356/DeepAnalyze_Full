/**
 * Server ↔ Worker communication types.
 *
 * All types used by the HubClient to communicate with the Server (deepanalyze-hub).
 * The Server exposes a REST API at /api/v1/*; the Worker calls these endpoints
 * in a pull-based model (the Server never pushes to the Worker).
 */

// ─── Run mode ───────────────────────────────────────────────────────────────

/** Worker run mode, determined by whether DA_SERVER_URL is set. */
export type DaRunMode = "standalone" | "worker";

/** Worker-side configuration derived from environment variables. */
export interface WorkerConfig {
  runMode: DaRunMode;
  serverUrl: string;
  workerId: string;
  workerToken: string;
}

// ─── Worker registration ────────────────────────────────────────────────────

export interface WorkerRegisterRequest {
  workerId: string;
  hostname: string;
  version: string;
  endpoint: string;
  capabilities: WorkerCapabilities;
}

export interface WorkerCapabilities {
  cpuCores: number;
  memoryGB: number;
  gpuAvailable: boolean;
  os: string;
  daVersion: string;
  runMode: "standalone" | "docker" | "vm";
}

export interface WorkerRegisterResponse {
  workerId: string;
  workerToken: string;
  serverPublicKey: string;
  serverVersion: string;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

export interface HeartbeatRequest {
  workerId: string;
  status: "online" | "busy" | "idle";
  activeSessions: number;
  activeTasks: number;
  resourceUsage: {
    cpuPercent: number;
    memoryUsedGB: number;
    memoryTotalGB: number;
    diskUsedGB: number;
    diskTotalGB: number;
  };
  uptime: number;
}

export interface HeartbeatResponse {
  acknowledged: boolean;
  serverTime: string;
  pendingNotifications?: WorkerNotification[];
}

export interface WorkerNotification {
  type: "config_updated" | "skill_approved" | "skill_rejected" | "system_notice";
  message: string;
  timestamp: string;
}

// ─── Config sync ─────────────────────────────────────────────────────────────

/**
 * Recommended configuration snapshot from the Server.
 * The structure mirrors the Worker's own settings keys so that applyRecommendedConfig()
 * can directly write them into the local settings table.
 */
export interface RecommendedConfig {
  version: string;
  updatedAt: string;
  providers: {
    providers: unknown[];
    defaults: Record<string, string>;
  };
  agentSettings?: Record<string, unknown>;
  doclingConfig?: Record<string, unknown>;
  enhancedModels?: unknown[];
  hooks?: unknown[];
}

export interface ConfigVersionInfo {
  latestVersion: string;
  updatedAt: string;
  description?: string;
}

// ─── Marketplace: skills ────────────────────────────────────────────────────

export interface MarketplaceSkill {
  slug: string;
  name: string;
  description: string;
  author: { userId: string; name: string };
  version: string;
  tags: string[];
  downloadCount: number;
  ratingAvg: number;
  reviewCount: number;
  publishedAt: string;
  compatibility: {
    minVersion: string;
    requiredTools?: string[];
    requiredProviders?: string[];
  };
}

export interface MarketplaceSkillDetail extends MarketplaceSkill {
  prompt: string;
  tools: string[];
  modelRole: string;
  antiHallucinationLevel?: string;
  testScenarios?: Record<string, unknown>[];
  versions: SkillVersion[];
}

export interface SkillPackage {
  slug: string;
  name: string;
  version: string;
  description: string;
  prompt: string;
  tools: string[];
  modelRole: string;
  antiHallucinationLevel?: string;
  tags: string[];
  compatibility: {
    minVersion: string;
    requiredTools?: string[];
    requiredProviders?: string[];
  };
}

export interface SkillVersion {
  version: string;
  changeType: "create" | "update" | "patch";
  changeSummary?: string;
  createdAt: string;
}

export interface SkillSubmitRequest {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  modelRole: string;
  tags: string[];
  submitterNotes?: string;
}

export interface SkillSubmitResponse {
  submissionId: string;
  status: "submitted";
  message: string;
}

// ─── Marketplace: plugins ────────────────────────────────────────────────────

export interface MarketplacePlugin {
  slug: string;
  name: string;
  description: string;
  author: { userId: string; name: string };
  version: string;
  downloadCount: number;
  publishedAt: string;
}

export interface PluginPackage {
  slug: string;
  name: string;
  version: string;
  description: string;
  manifest: Record<string, unknown>;
}

export interface PluginSubmitRequest {
  name: string;
  description: string;
  manifest: Record<string, unknown>;
  submitterNotes?: string;
}

// ─── Sync state ──────────────────────────────────────────────────────────────

/** Current sync state exposed to the frontend via GET /api/hub/sync-state. */
export interface HubSyncState {
  lastHeartbeat: string | null;
  lastConfigSync: string | null;
  configVersionCached: string | null;
  serverReachable: boolean;
  pendingNotifications: WorkerNotification[];
  registeredWorkerId: string | null;
}

// ─── Worker status (read-only, exposed to Server) ────────────────────────────

export interface WorkerLocalStatus {
  workerId: string;
  version: string;
  uptime: number;
  status: "online" | "busy" | "idle";
  activeSessions: number;
  activeTasks: number;
  resourceUsage: {
    cpuPercent: number;
    memoryUsedGB: number;
    memoryTotalGB: number;
    diskUsedGB: number;
    diskTotalGB: number;
  };
  hubConnected: boolean;
  lastHubContact: string | null;
}
