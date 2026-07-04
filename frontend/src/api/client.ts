/**
 * Minimal API client for Hub admin panel.
 * Stores JWT access token in localStorage; refresh token travels via HttpOnly cookie.
 */

const API_BASE = "/api/v1";

function getToken(): string | null {
  return localStorage.getItem("hub_access_token");
}

function setToken(token: string | null): void {
  if (token) {
    localStorage.setItem("hub_access_token", token);
  } else {
    localStorage.removeItem("hub_access_token");
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include", // send HttpOnly refresh-token cookie
  });
  if (resp.status === 401 && !path.includes("/auth/login")) {
    setToken(null);
    window.location.href = "/login";
    throw new Error("Session expired");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return null as T;
  return (await resp.json()) as T;
}

/** Lower-level GET without auto-redirect on 401 (used by Skills page). */
async function getRaw<T>(method: string, path: string): Promise<T> {
  return request<T>(method, path);
}

export interface MeResponse {
  id: string;
  username: string;
  display_name: string | null;
  is_super_admin: boolean;
  is_org_admin: boolean;
  organization_id: string | null;
  roles: Array<{ id: string; name: string }>;
  permissions: string[];
}

export interface LoginResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  user: MeResponse;
}

export interface OrgNode {
  id: string;
  name: string;
  code: string;
  type: string;
  parent_id: string | null;
  level: number;
  user_count?: number;
  children?: OrgNode[];
}

export interface UserListResponse {
  users: Array<{
    id: string;
    username: string;
    display_name: string | null;
    is_super_admin: boolean;
    is_org_admin: boolean;
    organization_id: string | null;
    last_login_at: string | null;
  }>;
  total: number;
}

export interface PendingWorker {
  id: string;
  name: string;
  hostname: string;
  protocol_version: number;
  status: string;
  applied_at: string | null;
  capabilities?: Record<string, unknown>;
}

export interface DeployJob {
  id: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  worker_id: string | null;
  organization_id: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  image_tag: string;
  source: "hub_stream" | "docker_pull";
  assigned_user_id: string | null;
  dry_run: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<LoginResponse>("POST", "/auth/login", { username, password }),
  me: () => request<MeResponse>("GET", "/auth/me"),
  logout: () => {
    setToken(null);
    return request<void>("POST", "/auth/logout");
  },

  // Orgs
  getOrgTree: () => request<{ tree: OrgNode }>("GET", "/orgs/tree"),
  getOrgs: () => request<{ organizations: OrgNode[] }>("GET", "/orgs"),
  createOrg: (data: {
    name: string;
    code: string;
    type: string;
    parent_id?: string | null;
  }) => request<{ organization: OrgNode }>("POST", "/orgs", data),
  updateOrg: (id: string, data: Partial<{ name: string; code: string }>) =>
    request<{ organization: OrgNode }>("PATCH", `/orgs/${id}`, data),
  deleteOrg: (id: string) => request<void>("DELETE", `/orgs/${id}`),

  // Users
  getUsers: (params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    const qs = q.toString();
    return request<UserListResponse>("GET", `/users${qs ? `?${qs}` : ""}`);
  },
  createUser: (data: {
    username: string;
    password: string;
    display_name?: string;
    organization_id?: string | null;
    is_org_admin?: boolean;
  }) => request<{ user: { id: string } }>("POST", "/users", data),

  // Workers
  getPendingWorkers: () =>
    request<{ workers: PendingWorker[] }>("GET", "/workers/pending"),
  getAllWorkers: () =>
    request<{ workers: PendingWorker[] }>("GET", "/workers"),
  approveWorker: (id: string) =>
    request<{ worker_id: string; worker_token: string }>(
      "POST",
      `/workers/${id}/approve`,
    ),
  rejectWorker: (id: string, reason?: string) =>
    request<{ worker_id: string; status: string }>(
      "POST",
      `/workers/${id}/reject`,
      { reason },
    ),

  // ─── Phase 5: Worker remote deployment (F4 endpoints) ──────────────
  deploy: {
    /** Create a new deploy job. If dry_run=true the backend will validate
     *  SSH connectivity and Docker availability without persisting the job. */
    create: async (params: {
      organization_id: string;
      ssh_host: string;
      ssh_port?: number;
      ssh_user: string;
      ssh_private_key: string;
      image_tag: string;
      source?: "hub_stream" | "docker_pull";
      assigned_user_id?: string;
      skill_package_ids?: string[];
      dry_run?: boolean;
    }): Promise<{ job_id: string; status: string }> => {
      return request("POST", "/workers/deploy", params);
    },

    /** Query the status of a deploy job. */
    status: async (jobId: string): Promise<DeployJob> => {
      return request<DeployJob>("GET", `/workers/deploy-jobs/${jobId}`);
    },

    /** Upgrade an existing worker to a new image tag. */
    upgrade: async (
      workerId: string,
      imageTag: string,
    ): Promise<{ success: boolean; error?: string }> => {
      return request("POST", `/workers/${workerId}/upgrade`, {
        image_tag: imageTag,
      });
    },

    /** Stop a running worker (does not delete the container). */
    stop: async (workerId: string): Promise<{ success: boolean }> => {
      return request("POST", `/workers/${workerId}/stop`);
    },

    /** Restart a stopped worker. */
    restart: async (workerId: string): Promise<{ success: boolean }> => {
      return request("POST", `/workers/${workerId}/restart`);
    },

    /** Rollback a worker to its previously deployed image tag. */
    rollback: async (workerId: string): Promise<{ success: boolean }> => {
      return request("POST", `/workers/${workerId}/rollback`);
    },
  },

  // Skills marketplace (Phase 2)
  getRaw,
  createPackage: (data: { name: string; description?: string; scope: "system" | "org" | "user"; tags?: string[] }) =>
    request<{ package: SkillPackageV2 }>("POST", "/skills", data),
  createVersionRaw: (pkgId: string, data: { version: string; content: string; when_to_use?: string; allowed_tools?: string[] }) =>
    request<{ version: SkillVersionV2 }>("POST", `/skills/${pkgId}/versions`, data),
  subscribeSkill: (pkgId: string) =>
    request<{ subscription: unknown }>("POST", `/skills/${pkgId}/subscribe`),
  unsubscribeSkill: (pkgId: string) =>
    request<{ success: boolean }>("DELETE", `/skills/${pkgId}/subscribe`),
  killSwitchSkill: (pkgId: string, reason: string) =>
    request<{ success: boolean }>("POST", `/skills/${pkgId}/kill`, { reason }),

  // ─── Phase 4: SkillSharing ──────────────────────────────────────────
  listSharings: (params?: { status?: string; package_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.package_id) q.set("package_id", params.package_id);
    const qs = q.toString();
    return request<{ sharings: SkillSharing[] }>(
      "GET",
      `/sharings${qs ? `?${qs}` : ""}`,
    );
  },
  createSharing: (data: {
    package_id: string;
    source_org_id?: string;
    target_org_id: string;
    restrictions?: Record<string, unknown>;
  }) => request<{ sharing: SkillSharing }>("POST", "/sharings", data),
  approveSharing: (id: string) =>
    request<{ sharing: SkillSharing }>("POST", `/sharings/${id}/approve`),
  rejectSharing: (id: string, reason: string) =>
    request<{ sharing: SkillSharing }>("POST", `/sharings/${id}/reject`, { reason }),
  revokeSharing: (id: string, reason: string) =>
    request<{ sharing: SkillSharing; killed_workers: number }>(
      "DELETE",
      `/sharings/${id}`,
      { reason },
    ),

  // ─── Phase 4: Skill usage ───────────────────────────────────────────
  getUsageStats: (pkgId: string) =>
    request<{ stats: UsageStats }>("GET", `/skills/${pkgId}/usage/stats`),
  getUsageTop: (limit = 20) =>
    request<{ top: Array<{ package_id: string; package_name: string; calls: number; success_rate: number }> }>(
      "GET",
      `/skills/usage/top?limit=${limit}`,
    ),

  // ─── Phase 4: Security Gateway ──────────────────────────────────────
  getSecurityStatus: () =>
    request<{ enabled: boolean; fail_open: boolean; timeout_ms: number }>(
      "GET",
      "/security/status",
    ),
  scanText: (text: string, direction?: "input" | "output") =>
    request<{ result: ScanResult }>("POST", "/security/scan", { text, direction }),
  checkTool: (toolName: string, args: unknown) =>
    request<{ result: ScanResult }>("POST", "/security/check-tool", {
      tool_name: toolName,
      args,
    }),

  // ─── Phase 4: MFA ───────────────────────────────────────────────────
  getMfaStatus: () =>
    request<{ configured: boolean; required: boolean; globally_required: boolean }>(
      "GET",
      "/auth/mfa/status",
    ),
  setupMfa: () =>
    request<{ secret: string; provisioning_uri: string }>("POST", "/auth/mfa/setup"),
  verifyMfa: (secret: string, code: string) =>
    request<{ enabled: boolean }>("POST", "/auth/mfa/verify", { secret, code }),
  disableMfa: (code: string) =>
    request<{ disabled: boolean }>("POST", "/auth/mfa/disable", { code }),

  // ─── Phase 4: Auth adapters ─────────────────────────────────────────
  getAuthAdapters: () =>
    request<{ adapters: Array<{ provider: string; enabled: boolean }>; mfa_required: boolean }>(
      "GET",
      "/auth/adapters",
    ),

  // ─── Phase 1 Marketplace admin (Worker 技能市场管理) ───────────────────
  listMarketplaceAdminSkills: (params: {
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.search) qs.set("search", params.search);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return request<AdminSkillListResponse>(
      "GET",
      `/marketplace/admin/skills${query ? `?${query}` : ""}`,
    );
  },

  approveMarketplaceSkill: (id: string) =>
    request<AdminSkillMutationResponse>(
      "POST",
      `/marketplace/admin/skills/${id}/approve`,
    ),

  rejectMarketplaceSkill: (id: string, reason: string) =>
    request<AdminSkillMutationResponse>(
      "POST",
      `/marketplace/admin/skills/${id}/reject`,
      { reason },
    ),

  deprecateMarketplaceSkill: (id: string, reason: string) =>
    request<AdminSkillMutationResponse>(
      "POST",
      `/marketplace/admin/skills/${id}/deprecate`,
      { reason },
    ),

  removeMarketplaceSkill: (id: string) =>
    request<AdminSkillMutationResponse>(
      "DELETE",
      `/marketplace/admin/skills/${id}`,
    ),

  promotePackageToMarketplace: (packageId: string) =>
    request<PromoteResponse>(
      "POST",
      `/marketplace/admin/promote`,
      { packageId },
    ),

  // ─── Phase 1 Marketplace: submission queries & withdraw ───────────────
  getSubmission: (id: string) =>
    request<{
      id: string;
      review_status: string;
      review_notes: string | null;
      published_at: string | null;
      name: string;
      slug: string;
      version: string;
    }>("GET", `/marketplace/submissions/${id}`),

  withdrawSkill: (slug: string) =>
    request<{ ok: boolean; slug: string }>(
      "DELETE",
      `/marketplace/skills/${encodeURIComponent(slug)}`,
    ),

  // ─── Phase 5 G3: Model repository management ──────────────────────────
  models: {
    /** List all model artifacts (admin view). */
    list: async (): Promise<ModelArtifact[]> => {
      const res = await request<{ models: ModelArtifact[] }>("GET", "/models");
      return res.models;
    },

    /** Fetch the latest manifest for a named model (public). */
    manifest: async (name: string): Promise<ModelManifest> =>
      request<ModelManifest>(
        "GET",
        `/models/manifests/${encodeURIComponent(name)}`,
      ),

    /** Delete a specific model version (admin). */
    delete: async (name: string, version: string): Promise<{ ok: boolean }> =>
      request<{ ok: boolean }>(
        "DELETE",
        `/models/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      ),

    /** Upload a new model artifact via multipart form-data.
     *  Uses raw fetch (not the `request` helper) because the helper forces
     *  Content-Type: application/json and JSON.stringify(body). FormData must
     *  let the browser set the multipart boundary automatically. */
    upload: async (
      formData: FormData,
    ): Promise<{
      id: string;
      files: Array<{ originalName: string; sha256: string; sizeBytes: number }>;
    }> => {
      const token = getToken();
      const resp = await fetch(`${API_BASE}/models/upload`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData, // NO Content-Type — browser sets multipart boundary
        credentials: "include",
      });
      if (resp.status === 401) {
        setToken(null);
        window.location.href = "/login";
        throw new Error("Session expired");
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      return (await resp.json()) as {
        id: string;
        files: Array<{ originalName: string; sha256: string; sizeBytes: number }>;
      };
    },
  },

  // ─── Phase 2 T06: Host servers (物理机管理) ───────────────────────────
  getHostServers: () =>
    request<{ items: HostServer[] }>("GET", "/host-servers"),
  getHostServer: (id: string) =>
    request<HostServer>("GET", `/host-servers/${id}`),
  createHostServer: (input: CreateHostServerInput) =>
    request<HostServer>("POST", "/host-servers", input),
  updateHostServer: (id: string, patch: Partial<CreateHostServerInput>) =>
    request<HostServer>("PATCH", `/host-servers/${id}`, patch),
  deleteHostServer: (id: string) =>
    request<void>("DELETE", `/host-servers/${id}`),
  getHostServerPortUsage: (id: string) =>
    request<PortUsageResponse>("GET", `/host-servers/${id}/port-usage`),
};

export interface ModelArtifact {
  id: string;
  name: string;
  version: string;
  category: string;
  sha256: string;
  /** pg BIGINT may arrive as string; coerce with Number() at render time. */
  size_bytes: number | string | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface ModelManifest {
  name: string;
  version: string;
  category: string;
  files: Array<{
    originalName: string;
    sha256: string;
    sizeBytes: number;
  }>;
}

export interface SkillPackageV2 {
  id: string;
  name: string;
  slug: string;
  display_name: string;
  scope: "system" | "org" | "user";
  description: string;
  category: string;
  tags: string[];
  icon: string;
  trust_level: string;
  author_name?: string;
  active_version?: string;
  active_version_id?: string | null;
  stats: { downloads: number; subscriptions: number; rating_avg: number };
  is_kill_switched: boolean;
  created_at: string;
}

export interface SkillVersionV2 {
  id: string;
  version: string;
  content_hash: string;
  status: string;
  created_at: string;
}

export interface SkillSharing {
  id: string;
  package_id: string;
  source_org_id: string;
  target_org_id: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  initiated_by: string;
  approved_by: string | null;
  restrictions: Record<string, unknown>;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface UsageStats {
  package_id: string;
  total: number;
  success: number;
  failure: number;
  timeout: number;
  blocked: number;
  success_rate: number;
  avg_duration_ms: number | null;
  unique_workers: number;
  unique_users: number;
  last_24h: number;
  last_7d: number;
}

export interface ScanResult {
  action: "approve" | "sanitize" | "block";
  reason?: string;
  sanitized?: string;
  matches: Array<{
    engine: string;
    rule_id: string;
    matched_text: string;
    severity: number;
    category: string;
  }>;
  severity: number;
  duration_ms: number;
}

// ─── Phase 1 Marketplace admin (Worker 技能市场管理) ─────────────────────

export interface AdminSkill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  tools: string[] | null;
  model_role: string | null;
  tags: string[] | null;
  version: string;
  review_status: "pending" | "approved" | "rejected" | "deprecated";
  reviewer_id: string | null;
  review_notes: string | null;
  submitter_id: string;
  download_count: number;
  rating_avg: string | number; // pg NUMERIC 返回 string，前端用 Number() 转
  review_count: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  source_package_id: string | null;
  source_version_id: string | null;
}

export interface AdminSkillListResponse {
  skills: AdminSkill[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminSkillMutationResponse {
  success: true;
  skill: { id: string; slug: string; name: string };
}

export interface PromoteResponse {
  success: true;
  skill: { id: string; slug: string; name: string; version: string };
}

// ─── Phase 2 T06: Host servers (物理机管理) ───────────────────────────────

export interface HostServer {
  id: string;
  hostname: string;
  ssh_target_host: string;
  ssh_target_port: number;
  ssh_user: string;
  port_range_start: number;
  port_range_end: number;
  port_block_size: number;
  cpu_cores: number | null;
  memory_gb: number | null;
  gpu_count: number;
  gpu_vram_mb: number | null;
  gpu_model: string | null;
  status: "active" | "maintenance" | "retired";
  labels: Record<string, unknown>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateHostServerInput {
  hostname: string;
  ssh_target_host: string;
  ssh_target_port?: number;
  ssh_user?: string;
  port_range_start?: number;
  port_range_end?: number;
  port_block_size?: number;
  cpu_cores?: number;
  memory_gb?: number;
  gpu_count?: number;
  gpu_vram_mb?: number;
  gpu_model?: string;
  notes?: string;
}

export interface PortUsageEntry {
  base_port: number;
  worker_id: string | null;
  status: string | null;
}

export interface PortUsageResponse {
  host_server_id: string;
  range: [number, number];
  block_size: number;
  allocated: PortUsageEntry[];
}
