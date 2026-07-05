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
  CachedSkill,
  SkillSyncInstruction,
} from "./types.js";
import { SyncHandler } from "./sync-handler.js";
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

  // ─── Interactive Hub connection (join_token workflow) ────────────────

  /**
   * Connect to a Hub server using a join_token (interactive setup).
   * Called by the setup wizard or settings panel when a user manually
   * enters Hub URL + join token. Posts to the register endpoint with
   * protocol_version 2 (join_token auth, not worker_token auth).
   * On success: updates config, starts heartbeat, persists connection state.
   */
  async connectToHub(
    hubUrl: string,
    joinToken: string,
  ): Promise<{ workerToken: string; workerId: string }> {
    const resp = await fetch(`${hubUrl.replace(/\/+$/, "")}/api/v1/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        join_token: joinToken,
        hostname: os.hostname(),
        protocol_version: 2,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Hub registration failed: ${(err as { error?: string }).error || resp.status}`);
    }
    const data = await resp.json() as { worker_id: string; worker_token: string };

    // Update in-memory config
    this.config.serverUrl = hubUrl;
    this.config.workerToken = data.worker_token;
    this.config.workerId = data.worker_id;

    // Update sync state so existing isConnected() returns true
    this.syncState.serverReachable = true;
    this.syncState.registeredWorkerId = data.worker_id;
    this.syncState.lastHeartbeat = new Date().toISOString();

    // Start periodic heartbeat
    this.startHeartbeat(30_000);

    // Persist connection details so they survive restart
    const { getRepos } = await import("../../store/repos/index.js");
    const repo = (await getRepos()).settings;
    await repo.set("hub_connection", JSON.stringify({
      connected: true,
      hubUrl,
      workerId: data.worker_id,
      workerToken: data.worker_token,
    }));

    return { workerToken: data.worker_token, workerId: data.worker_id };
  }

  /**
   * Disconnect from the Hub server. Deactivates the worker on the server
   * side, stops heartbeat, and clears local config. Idempotent — safe to
   * call when already disconnected.
   */
  async disconnectFromHub(): Promise<void> {
    if (this.config.serverUrl && this.config.workerToken) {
      try {
        await fetch(`${this.config.serverUrl.replace(/\/+$/, "")}/api/v1/workers/me/deactivate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.workerToken}` },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Best-effort — server may be unreachable, but we still clean up locally
      }
    }

    this.stopHeartbeat();

    // Clear config (use empty strings — WorkerConfig fields are typed as string)
    this.config.workerToken = "";
    this.config.serverUrl = "";

    // Update sync state so existing isConnected() returns false
    this.syncState.serverReachable = false;
    this.syncState.registeredWorkerId = null;

    // Persist disconnected state
    const { getRepos } = await import("../../store/repos/index.js");
    const repo = (await getRepos()).settings;
    await repo.set("hub_connection", JSON.stringify({ connected: false }));
  }

  // ─── Model manifest/blob fetching (enterprise model source) ──────────

  /**
   * Fetch a model manifest from the Hub (metadata, not the binary).
   * Returns null if Hub is unreachable or the model isn't found.
   */
  async fetchModelManifest(modelName: string): Promise<Record<string, unknown> | null> {
    if (!this.config.serverUrl || !this.config.workerToken) return null;
    try {
      const resp = await fetch(
        `${this.config.serverUrl.replace(/\/+$/, "")}/api/v1/models/manifests/${encodeURIComponent(modelName)}`,
        {
          headers: { Authorization: `Bearer ${this.config.workerToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!resp.ok) return null;
      return await resp.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a model blob (binary content) by its sha256 hash.
   * Used by the model downloader as an enterprise source.
   * Returns null if Hub is unreachable or the blob isn't found.
   */
  async fetchModelBlob(sha256: string): Promise<Buffer | null> {
    if (!this.config.serverUrl || !this.config.workerToken) return null;
    try {
      const resp = await fetch(
        `${this.config.serverUrl.replace(/\/+$/, "")}/api/v1/models/blobs/${encodeURIComponent(sha256)}`,
        {
          headers: { Authorization: `Bearer ${this.config.workerToken}` },
          signal: AbortSignal.timeout(300_000), // 5 min for large blobs
        },
      );
      if (!resp.ok) return null;
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    } catch {
      return null;
    }
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
   * Fetch the merged (global ∪ org) config template from the Server.
   * Uses workerAuth (Bearer token); Hub derives workerId from token.
   * Returns null if the Server is unreachable or has no template.
   *
   * T13's `/by-worker/merged` endpoint returns `{ content: unknown }` —
   * the merged template blob. We coerce to RecommendedConfig shape; DA's
   * sync logic decides what to apply.
   */
  async fetchMergedTemplate(): Promise<RecommendedConfig | null> {
    try {
      const data = await this.httpGet<{ content: unknown }>(
        "/api/v1/config-templates/by-worker/merged",
      );
      return (data?.content ?? null) as RecommendedConfig | null;
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

    // v2: 获取本地缓存的 skill 清单和 policy_version
    const cachedSkills = await this.getLocalSkillCache();
    const policyVersion = await this.getStoredPolicyVersion();

    // T18: 探测模块健康（动态 import 避免循环依赖，探测模块可能 import hub 代码）
    let moduleHealth: Record<string, unknown> | undefined;
    try {
      const { probeAllModules } = await import("../modules/health-probe.js");
      // ModuleHealthMap 是已知 key 的 interface（无 index signature），
      // 这里用 spread 转为宽松的 Record<string, unknown> 用于 JSON 上行
      const map = await probeAllModules();
      moduleHealth = { ...map };
    } catch (e) {
      // 探测失败不阻断心跳 — 仅省略 moduleHealth 字段
      console.warn("[heartbeat] probeAllModules failed:", e);
    }

    // T18: 读取 DA 版本（DEEPANALYZE_CONFIG.version），lazy import 避免顶层依赖
    let daVersion: string | undefined;
    try {
      const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
      daVersion = DEEPANALYZE_CONFIG.version;
    } catch {
      // 配置加载失败时省略 daVersion 字段
    }

    const payload: HeartbeatRequest & {
      cached_skills?: CachedSkill[];
      policy_version?: number;
      protocol_version?: number;
      current_task?: string;
    } = {
      workerId: this.config.workerId,
      status: status.status,
      activeSessions: status.activeSessions,
      activeTasks: status.activeTasks,
      resourceUsage: status.resourceUsage,
      uptime: status.uptime,
      // v2 扩展字段
      cached_skills: cachedSkills,
      policy_version: policyVersion,
      protocol_version: 2,
      current_task: status.activeTasks > 0 ? "busy" : "idle",
      // T18 扩展字段：模块健康快照 + DA 版本
      moduleHealth,
      daVersion,
    };
    try {
      const resp = await this.httpPost<HeartbeatResponse>(
        "/api/v1/workers/heartbeat",
        payload,
      );
      if (resp) {
        // v2: 处理 SkillSync 指令
        if (resp.instructions && resp.instructions.length > 0) {
          await this.applyInstructions(resp.instructions);
        }
        // v2: 更新 policy_version
        if (resp.policy_version && resp.policy_version > policyVersion) {
          await this.storePolicyVersion(resp.policy_version);
        }
      }
      return resp;
    } catch {
      return null;
    }
  }

  /** 获取本地缓存的 skill 清单（content_hash = SHA-256[:32]） */
  private async getLocalSkillCache(): Promise<CachedSkill[]> {
    try {
      const { createHash } = await import("node:crypto");
      const { query } = await import("../../store/pg.js");
      const result = await query(
        `SELECT id, content FROM skills WHERE source = 'hub' AND is_active = TRUE`,
      );
      const rows = result.rows as { id: string; content: string }[];
      return rows.map((row) => ({
        package_id: row.id,
        version: "1.0.0",
        content_hash: createHash("sha256")
          .update(row.content ?? "")
          .digest("hex")
          .slice(0, 32),
      }));
    } catch {
      return [];
    }
  }

  /** 读取本地存储的 policy_version */
  private async getStoredPolicyVersion(): Promise<number> {
    try {
      const { query } = await import("../../store/pg.js");
      const result = await query(
        `SELECT value FROM settings WHERE key = 'hub_policy_version'`,
      );
      const rows = result.rows as { value: string }[];
      return parseInt(rows[0]?.value ?? "0", 10);
    } catch {
      return 0;
    }
  }

  /** 存储新的 policy_version */
  private async storePolicyVersion(version: number): Promise<void> {
    try {
      const { query } = await import("../../store/pg.js");
      await query(
        `INSERT INTO settings (key, value) VALUES ('hub_policy_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(version)],
      );
    } catch {
      // ignore—if settings table doesn't exist, skip
    }
  }

  /** 应用 SkillSync 指令 */
  private async applyInstructions(
    instructions: SkillSyncInstruction[],
  ): Promise<void> {
    try {
      const { getRepos } = await import("../../store/repos/index.js");
      const repos = await getRepos();
      const handler = new SyncHandler(repos);
      for (const inst of instructions) {
        await handler.handle(inst);
        await this.ackInstruction(inst.instruction_id);
      }
    } catch (err) {
      console.error("[HubClient] applyInstructions error:", err);
    }
  }

  /** 确认指令已执行 */
  private async ackInstruction(instructionId: string): Promise<void> {
    await this.httpPost("/api/v1/workers/ack", {
      instruction_id: instructionId,
    }).catch(() => null);
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
