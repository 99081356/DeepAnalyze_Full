/**
 * HubClient — Server communication client for Worker mode.
 *
 * All communication is Worker-initiated (pull model). The Server never pushes.
 * Every method handles failures gracefully — a Server outage must never prevent
 * the Worker from operating normally.
 */

import os from "os";
import type {
  WorkerConfig,
  HubSyncState,
  WorkerRegisterRequest,
  WorkerRegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  RecommendedConfig,
  ConfigVersionInfo,
  MarketplaceSkill,
  MarketplaceSkillDetail,
  SkillPackage,
  SkillSubmitRequest,
  SkillSubmitResponse,
  MarketplacePlugin,
  PluginPackage,
  PluginSubmitRequest,
  WorkerNotification,
} from "./types.js";
import { collectWorkerStatus, collectWorkerCapabilities } from "./worker-identity.js";

/** Global reference set in main.ts so routes can access the client. */
declare global {
  // eslint-disable-next-line no-var
  var __hubClient: HubClient | undefined;
}

export class HubClient {
  private config: WorkerConfig;
  private syncState: HubSyncState;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();

  constructor(config: WorkerConfig) {
    this.config = config;
    this.syncState = {
      lastHeartbeat: null,
      lastConfigSync: null,
      configVersionCached: null,
      serverReachable: false,
      pendingNotifications: [],
      registeredWorkerId: null,
    };
  }

  // ─── Connection management ───────────────────────────────────────────

  /**
   * Register this Worker with the Server.
   * Returns null on failure (Server unreachable, auth rejected, etc.).
   */
  async register(): Promise<WorkerRegisterResponse | null> {
    try {
      const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
      const caps = collectWorkerCapabilities();
      caps.daVersion = DEEPANALYZE_CONFIG.version;
      caps.runMode = "standalone"; // DA deployment mode: standalone / docker / vm
      const resp = await this.httpPost<WorkerRegisterResponse>(
        "/api/v1/workers/register",
        {
          workerId: this.config.workerId,
          hostname: os.hostname(),
          version: DEEPANALYZE_CONFIG.version,
          endpoint: "", // Worker's externally-reachable address, filled by admin
          capabilities: caps,
        },
      );
      if (resp) {
        this.syncState.registeredWorkerId = resp.workerId;
        this.syncState.serverReachable = true;
        // Store the token if Server returned a new one
        if (resp.workerToken) {
          this.config.workerToken = resp.workerToken;
        }
      }
      return resp;
    } catch (err) {
      console.warn(`[Hub] Registration failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Start periodic heartbeat to the Server.
   * Failures are silently swallowed — they only update syncState.
   */
  startHeartbeat(intervalMs = 30_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try {
        const resp = await this.heartbeat();
        if (resp) {
          this.syncState.serverReachable = true;
          this.syncState.lastHeartbeat = new Date().toISOString();
          if (resp.pendingNotifications?.length) {
            this.syncState.pendingNotifications = resp.pendingNotifications;
          }
        } else {
          this.syncState.serverReachable = false;
        }
      } catch {
        this.syncState.serverReachable = false;
      }
    }, intervalMs);
    // Don't prevent process exit
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Return current sync state (for frontend polling). */
  getSyncState(): HubSyncState {
    return { ...this.syncState };
  }

  /** Whether the Worker is connected to a Server. */
  isConnected(): boolean {
    return this.syncState.serverReachable;
  }

  // ─── Config sync ─────────────────────────────────────────────────────

  /**
   * Fetch the recommended configuration from the Server.
   * Returns null if the Server is unreachable or has no config.
   */
  async fetchRecommendedConfig(): Promise<RecommendedConfig | null> {
    try {
      return await this.httpGet<RecommendedConfig>("/api/v1/config/recommended");
    } catch {
      return null;
    }
  }

  /**
   * Lightweight check for config updates (version only, no full payload).
   */
  async fetchConfigVersion(): Promise<ConfigVersionInfo | null> {
    try {
      return await this.httpGet<ConfigVersionInfo>("/api/v1/config/versions");
    } catch {
      return null;
    }
  }

  /**
   * Apply a recommended config snapshot to the local settings table.
   * Writes each settings key and then bumps the ModelRouter config version
   * so the changes take effect without a restart.
   */
  async applyRecommendedConfig(config: RecommendedConfig): Promise<void> {
    const { getRepos } = await import("../../store/repos/index.js");
    const repos = await getRepos();

    // Provider settings
    if (config.providers) {
      await repos.settings.saveProviderSettings(config.providers);
    }

    // Agent settings
    if (config.agentSettings) {
      await repos.settings.set("agent_settings", JSON.stringify(config.agentSettings));
    }

    // Docling config
    if (config.doclingConfig) {
      await repos.settings.set("docling_config", JSON.stringify(config.doclingConfig));
    }

    // Enhanced models
    if (config.enhancedModels) {
      await repos.settings.set("enhanced_models", JSON.stringify(config.enhancedModels));
    }

    // Hooks
    if (config.hooks) {
      await repos.settings.set("agent_hooks", JSON.stringify(config.hooks));
    }

    // Trigger ModelRouter hot-reload
    const { bumpConfigVersion } = await import("../../models/router.js");
    bumpConfigVersion();

    // Update sync state
    this.syncState.lastConfigSync = new Date().toISOString();
    this.syncState.configVersionCached = config.version;
  }

  // ─── Marketplace: skills ─────────────────────────────────────────────

  async listMarketplaceSkills(
    page = 1,
    pageSize = 20,
    search?: string,
  ): Promise<{ items: MarketplaceSkill[]; total: number } | null> {
    try {
      let url = `/api/v1/marketplace/skills?page=${page}&pageSize=${pageSize}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      return await this.httpGet<{ items: MarketplaceSkill[]; total: number }>(url);
    } catch {
      return null;
    }
  }

  async getMarketplaceSkill(slug: string): Promise<MarketplaceSkillDetail | null> {
    try {
      return await this.httpGet<MarketplaceSkillDetail>(
        `/api/v1/marketplace/skills/${encodeURIComponent(slug)}`,
      );
    } catch {
      return null;
    }
  }

  /**
   * Download a skill from the marketplace and install it into the local
   * agent_skills table with source="hub".
   */
  async downloadMarketplaceSkill(
    slug: string,
  ): Promise<{ installed: boolean; skillId: string } | null> {
    try {
      const skill = await this.httpGet<SkillPackage>(
        `/api/v1/marketplace/skills/${encodeURIComponent(slug)}/download`,
      );
      if (!skill) return null;

      // Check compatibility (basic version check)
      if (skill.compatibility?.minVersion) {
        const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
        if (compareVersions(DEEPANALYZE_CONFIG.version, skill.compatibility.minVersion) < 0) {
          console.warn(
            `[Hub] Skill "${skill.name}" requires DA >= ${skill.compatibility.minVersion}, current: ${DEEPANALYZE_CONFIG.version}`,
          );
          return { installed: false, skillId: "" };
        }
      }

      // Install into local agent_skills
      const { getRepos } = await import("../../store/repos/index.js");
      const repos = await getRepos();

      const created = await repos.agentSkill.create({
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
        tools: skill.tools,
        modelRole: skill.modelRole,
        antiHallucinationLevel: skill.antiHallucinationLevel,
        source: "hub",
        hubSlug: skill.slug,
        hubUrl: `${this.config.serverUrl}/api/v1/marketplace/skills/${skill.slug}`,
      });

      console.log(`[Hub] Installed marketplace skill "${skill.name}" (id: ${created.id})`);
      return { installed: true, skillId: created.id };
    } catch (err) {
      console.warn(`[Hub] Failed to install skill "${slug}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Publish a local skill to the marketplace.
   * Reads the skill from agent_skills, packages it, and submits to Server.
   */
  async submitSkillToMarket(skillId: string): Promise<SkillSubmitResponse | null> {
    try {
      const { getRepos } = await import("../../store/repos/index.js");
      const repos = await getRepos();

      const skill = await repos.agentSkill.get(skillId);
      if (!skill) {
        console.warn(`[Hub] Skill ${skillId} not found`);
        return null;
      }

      const payload: SkillSubmitRequest = {
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
        tools: skill.tools,
        modelRole: skill.modelRole,
        tags: [],
      };

      const result = await this.httpPost<SkillSubmitResponse>(
        "/api/v1/marketplace/skills/submit",
        payload,
      );
      if (result) {
        console.log(`[Hub] Skill "${skill.name}" submitted to marketplace (submission: ${result.submissionId})`);
      }
      return result;
    } catch (err) {
      console.warn(`[Hub] Failed to submit skill: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // ─── Marketplace: plugins ────────────────────────────────────────────

  async listMarketplacePlugins(
    page = 1,
    pageSize = 20,
  ): Promise<{ items: MarketplacePlugin[]; total: number } | null> {
    try {
      return await this.httpGet<{ items: MarketplacePlugin[]; total: number }>(
        `/api/v1/marketplace/plugins?page=${page}&pageSize=${pageSize}`,
      );
    } catch {
      return null;
    }
  }

  async downloadMarketplacePlugin(
    slug: string,
  ): Promise<{ installed: boolean } | null> {
    try {
      const plugin = await this.httpGet<PluginPackage>(
        `/api/v1/marketplace/plugins/${encodeURIComponent(slug)}/download`,
      );
      if (!plugin) return null;

      // TODO: install plugin into local plugins table
      console.log(`[Hub] Plugin "${plugin.name}" downloaded (installation pending)`);
      return { installed: true };
    } catch {
      return null;
    }
  }

  async submitPluginToMarket(
    _pluginId: string,
  ): Promise<SkillSubmitResponse | null> {
    // TODO: implement plugin packaging and submission
    console.warn("[Hub] Plugin submission not yet implemented");
    return null;
  }

  // ─── Worker status ───────────────────────────────────────────────────

  async getLocalStatus(
    activeSessions: number,
    activeTasks: number,
  ) {
    const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
    return collectWorkerStatus(
      this.config.workerId,
      DEEPANALYZE_CONFIG.version,
      this.syncState.serverReachable,
      this.syncState.lastHeartbeat,
      activeSessions,
      activeTasks,
    );
  }

  // ─── Internal HTTP helpers ───────────────────────────────────────────

  private get baseUrl(): string {
    return this.config.serverUrl.replace(/\/+$/, "");
  }

  private get authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.workerToken) {
      headers["Authorization"] = `Bearer ${this.config.workerToken}`;
    }
    return headers;
  }

  private async httpGet<T>(path: string): Promise<T | null> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.authHeaders,
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 204) return null;
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    return resp.json() as Promise<T>;
  }

  private async httpPost<T>(path: string, body: unknown): Promise<T | null> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 204) return null;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${resp.statusText} ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  private async heartbeat(): Promise<HeartbeatResponse | null> {
    const status = await this.getLocalStatus(0, 0);
    const payload: HeartbeatRequest = {
      workerId: this.config.workerId,
      status: status.status,
      activeSessions: status.activeSessions,
      activeTasks: status.activeTasks,
      resourceUsage: status.resourceUsage,
      uptime: status.uptime,
    };
    try {
      return await this.httpPost<HeartbeatResponse>("/api/v1/workers/heartbeat", payload);
    } catch {
      return null;
    }
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Compare two semver-like version strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
