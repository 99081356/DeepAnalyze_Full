/**
 * Shared types for DeepAnalyze Hub.
 *
 * These types mirror the ones defined in the Worker's src/services/hub/types.ts
 * to ensure protocol compatibility.
 */

// ─── Worker Registration ─────────────────────────────────────────────────────

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

// ─── Config Sync ─────────────────────────────────────────────────────────────

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

// ─── Marketplace: Skills ─────────────────────────────────────────────────────

export interface MarketplaceSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  modelRole: string;
  antiHallucinationLevel?: string;
  tags: string[];
  version: string;
  authorId: string;
  submitterId: string;
  downloadCount: number;
  ratingAvg: number;
  reviewCount: number;
  reviewStatus: "pending" | "approved" | "rejected" | "deprecated";
  reviewerId?: string;
  reviewNotes?: string;
  publishedAt?: string;
  compatibility: {
    minVersion: string;
    requiredTools?: string[];
    requiredProviders?: string[];
  };
  createdAt: string;
  updatedAt: string;
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

// ─── Marketplace: Plugins ────────────────────────────────────────────────────

export interface MarketplacePlugin {
  id: string;
  slug: string;
  name: string;
  description: string;
  manifest: Record<string, unknown>;
  version: string;
  authorId: string;
  downloadCount: number;
  reviewStatus: "pending" | "approved" | "rejected" | "deprecated";
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── User ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  role: "admin" | "user";
  ssoId?: string;
  status: "active" | "suspended" | "deleted";
  assignedWorkerId?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Worker (Server-side model) ──────────────────────────────────────────────

export interface Worker {
  id: string;
  hostname: string;
  endpoint: string;
  version: string;
  capabilities?: WorkerCapabilities;
  status: "online" | "offline" | "draining";
  workerToken: string;
  lastHeartbeat?: string;
  activeSessions: number;
  activeTasks: number;
  resourceUsage?: Record<string, unknown>;
  registeredAt: string;
}

// ─── Config Version ──────────────────────────────────────────────────────────

export interface ConfigVersion {
  id: number;
  version: string;
  scope: string;
  configData: RecommendedConfig;
  description?: string;
  createdBy?: string;
  createdAt: string;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export interface AuditLog {
  id: number;
  userId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  createdAt: string;
}
