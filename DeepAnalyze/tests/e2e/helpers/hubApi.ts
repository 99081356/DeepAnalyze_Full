/**
 * Hub Server Playwright API client + helpers.
 *
 * Targets the deepanalyze-hub control plane at http://localhost:22000.
 * Used by the T61-T80 E2E suite (tests/e2e/hub/*.spec.ts).
 *
 * Design:
 *  - Low-level `raw()` returns { status, body } for negative tests (403/400/401).
 *  - Convenience methods throw on non-2xx and return parsed body.
 *  - Auth is per-call: JWT bearer (token), Worker bearer (workerToken), or X-API-Key.
 *  - `computeTotp()` implements RFC 6238 for MFA tests.
 *  - `shot()` captures screenshots for visual analysis.
 */
import { APIRequestContext, Page } from "@playwright/test";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HUB_BASE = "http://localhost:22000";
const API = `${HUB_BASE}/api/v1`;

// ---------------------------------------------------------------------------
// Low-level HTTP
// ---------------------------------------------------------------------------

export interface RawOpts {
  token?: string;
  workerToken?: string;
  apiKey?: string;
  data?: unknown;
  headers?: Record<string, string>;
  /** Query params merged into the URL. */
  query?: Record<string, string | number | boolean | undefined>;
}

export interface RawResult<T = any> {
  status: number;
  ok: boolean;
  body: T;
  headers: Record<string, string>;
}

function buildUrl(path: string, query?: RawOpts["query"]): string {
  if (!query) return `${API}${path}`;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${API}${path}?${qs}` : `${API}${path}`;
}

/**
 * Raw request — always resolves with { status, ok, body, headers }.
 * Use for negative tests where you expect non-2xx. Convenience methods
 * wrap this and throw on failure.
 */
export async function hubRaw(
  request: APIRequestContext,
  method: string,
  path: string,
  opts: RawOpts = {},
): Promise<RawResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  const auth = opts.token ?? opts.workerToken;
  if (auth) headers["Authorization"] = `Bearer ${auth}`;
  if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;

  const resp = await request.fetch(buildUrl(path, opts.query), {
    method,
    headers,
    data: opts.data !== undefined ? JSON.stringify(opts.data) : undefined,
    maxRedirects: 0,
  });
  const status = resp.status();
  const text = await resp.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const respHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(resp.headers())) respHeaders[k.toLowerCase()] = v;
  return { status, ok: status >= 200 && status < 300, body, headers: respHeaders };
}

/** Throw on non-2xx, return parsed body. */
function unwrap<T>(r: RawResult<T>): T {
  if (!r.ok) {
    const snippet = typeof r.body === "string" ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200);
    throw new Error(`Hub ${r.status} ${JSON.stringify(snippet)}`);
  }
  return r.body;
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — mirrors the Hub's auth-adapters implementation
// ---------------------------------------------------------------------------

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/g, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** Compute a 6-digit TOTP code. Counter defaults to current 30s window. */
export function computeTotp(secret: string, counter?: number): string {
  const key = base32Decode(secret);
  const c = counter ?? Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  // BigInt counter packing (handles large epoch counters)
  const big = BigInt(c);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number((big >> BigInt((7 - i) * 8)) & 0xffn);
  }
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const slice = hmac.slice(offset, offset + 4);
  const num = ((slice[0] & 0x7f) << 24) | (slice[1] << 16) | (slice[2] << 8) | slice[3];
  const code = num % 1_000_000;
  return String(code).padStart(6, "0");
}

/** Verify with ±1 window drift, matching the Hub's verifyTotp. */
export function verifyTotpDrift(secret: string, code: string, baseCounter?: number): boolean {
  const c = baseCounter ?? Math.floor(Date.now() / 1000 / 30);
  for (const drift of [0, -1, 1]) {
    const candidate = computeTotp(secret, c + drift);
    const a = Buffer.from(candidate);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Generate a random base32 secret (for reference; Hub generates its own). */
export function generateTotpSecret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

export const HUB_SHOT_DIR = "tests/e2e/screenshots/hub";

/**
 * Capture a screenshot for visual analysis. Saves as PNG under
 * tests/e2e/screenshots/hub/. Returns the path so tests can log it.
 */
export async function shot(page: Page, name: string, fullPage = true): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = `${HUB_SHOT_DIR}/${name}.png`;
  await fs.mkdir(HUB_SHOT_DIR, { recursive: true });
  await page.screenshot({ path, fullPage });
  return path;
}

// ---------------------------------------------------------------------------
// HubApi client
// ---------------------------------------------------------------------------

export class HubApi {
  /** Current JWT bearer token (user session). */
  token?: string;
  /** Current Worker token (wkt_ ...). */
  workerToken?: string;

  constructor(private request: APIRequestContext) {}

  /** Raw call with this client's default auth (overridable per-call). */
  raw(method: string, path: string, opts: RawOpts = {}): Promise<RawResult> {
    // When a workerToken is explicitly passed, don't also merge the user JWT —
    // hubRaw prefers `token` over `workerToken`, so leaving both set would
    // send the wrong credential type to worker-scoped endpoints.
    const hasWorkerToken = opts.workerToken !== undefined;
    const merged: RawOpts = {
      token: hasWorkerToken ? undefined : opts.token ?? this.token,
      workerToken: opts.workerToken ?? this.workerToken,
      apiKey: opts.apiKey,
      data: opts.data,
      headers: opts.headers,
      query: opts.query,
    };
    return hubRaw(this.request, method, path, merged);
  }

  /** Create a fresh client sharing the same request context but different creds. */
  as(token?: string, workerToken?: string): HubApi {
    const c = new HubApi(this.request);
    c.token = token;
    c.workerToken = workerToken;
    return c;
  }

  // ---- Auth -------------------------------------------------------------
  async login(username: string, password: string): Promise<{ access_token: string; user: any }> {
    const r = await this.raw("POST", "/auth/login", { data: { username, password } });
    const body = unwrap<any>(r);
    this.token = body.access_token;
    return body;
  }

  async me(token?: string): Promise<any> {
    return unwrap(await this.raw("GET", "/auth/me", { token }));
  }

  async refresh(): Promise<any> {
    return unwrap(await this.raw("POST", "/auth/refresh"));
  }

  async createApiKey(name: string, scope: string): Promise<any> {
    return unwrap(await this.raw("POST", "/auth/apikey", { data: { name, scope } }));
  }

  async revokeApiKey(id: string): Promise<any> {
    return unwrap(await this.raw("DELETE", `/auth/apikey/${id}`));
  }

  async listApiKeys(): Promise<any> {
    return unwrap(await this.raw("GET", "/auth/apikey"));
  }

  // ---- Orgs -------------------------------------------------------------
  async listOrgs(): Promise<any> {
    return unwrap(await this.raw("GET", "/orgs"));
  }

  async createOrg(input: { name: string; code: string; type: string; parent_id?: string }): Promise<any> {
    return unwrap(await this.raw("POST", "/orgs", { data: input }));
  }

  async getOrg(id: string): Promise<any> {
    return unwrap(await this.raw("GET", `/orgs/${id}`));
  }

  async getOrgTree(): Promise<any> {
    return unwrap(await this.raw("GET", "/orgs/tree"));
  }

  async getOrgSubtree(id: string): Promise<any> {
    return unwrap(await this.raw("GET", `/orgs/${id}/tree`));
  }

  async deleteOrg(id: string): Promise<any> {
    return unwrap(await this.raw("DELETE", `/orgs/${id}`));
  }

  // ---- Users ------------------------------------------------------------
  async listUsers(): Promise<any> {
    return unwrap(await this.raw("GET", "/users"));
  }

  async createUser(input: {
    username: string;
    password: string;
    display_name?: string;
    org_id?: string;
    is_org_admin?: boolean;
    is_super_admin?: boolean;
  }): Promise<any> {
    // users endpoint expects `organization_id` (frontend convention); translate from org_id.
    const { org_id, ...rest } = input;
    return unwrap(await this.raw("POST", "/users", { data: { ...rest, organization_id: org_id } }));
  }

  async getUser(id: string): Promise<any> {
    return unwrap(await this.raw("GET", `/users/${id}`));
  }

  async assignRole(userId: string, roleId: string): Promise<any> {
    return unwrap(await this.raw("POST", `/users/${userId}/roles`, { data: { role_id: roleId } }));
  }

  async removeRole(userId: string, roleId: string): Promise<any> {
    return unwrap(await this.raw("DELETE", `/users/${userId}/roles/${roleId}`));
  }

  async getUserPermissions(userId: string): Promise<any> {
    return unwrap(await this.raw("GET", `/users/${userId}/permissions`));
  }

  async deleteUser(userId: string): Promise<any> {
    return unwrap(await this.raw("DELETE", `/users/${userId}`));
  }

  // ---- Workers ----------------------------------------------------------
  async registerWorker(input: {
    name: string;
    hostname?: string;
    protocol_version?: number;
    org_id?: string;
  }): Promise<any> {
    return unwrap(await this.raw("POST", "/workers/register", { data: input }));
  }

  async approveWorker(id: string): Promise<any> {
    return unwrap(await this.raw("POST", `/workers/${id}/approve`));
  }

  async rejectWorker(id: string, reason?: string): Promise<any> {
    return unwrap(await this.raw("POST", `/workers/${id}/reject`, { data: { reason } }));
  }

  async listWorkers(): Promise<any> {
    return unwrap(await this.raw("GET", "/workers"));
  }

  async listPendingWorkers(): Promise<any> {
    return unwrap(await this.raw("GET", "/workers/pending"));
  }

  async getWorker(id: string): Promise<any> {
    return unwrap(await this.raw("GET", `/workers/${id}`));
  }

  /** Heartbeat with an explicit worker token (does not mutate this.workerToken). */
  async heartbeat(workerToken: string, cachedSkills: any[] = [], extra: Record<string, unknown> = {}): Promise<any> {
    return unwrap(
      await this.raw("POST", "/workers/heartbeat", {
        workerToken,
        data: { cached_skills: cachedSkills, ...extra },
      }),
    );
  }

  async ack(workerToken: string, payload: Record<string, unknown>): Promise<any> {
    return unwrap(await this.raw("POST", "/workers/ack", { workerToken, data: payload }));
  }

  // ---- Skill packages ---------------------------------------------------
  async listSkills(): Promise<any> {
    return unwrap(await this.raw("GET", "/skills"));
  }

  async getSkill(id: string): Promise<any> {
    return unwrap(await this.raw("GET", `/skills/${id}`));
  }

  async createSkill(input: {
    name: string;
    description?: string;
    scope: "user" | "org" | "system";
    org_id?: string;
    category?: string;
    tags?: string[];
    icon?: string;
  }): Promise<any> {
    // Provide defaults to satisfy validation (description >= 10 chars)
    const data = {
      description: `${input.name} — e2e fixture description`,
      category: "general",
      tags: ["e2e"],
      icon: "🧪",
      ...input,
    };
    return unwrap(await this.raw("POST", "/skills", { data }));
  }

  async listVersions(pkgId: string): Promise<any> {
    return unwrap(await this.raw("GET", `/skills/${pkgId}/versions`));
  }

  async createVersion(pkgId: string, input: {
    version: string;
    content: string;
    autoPublish?: boolean;
    change_summary?: string;
    when_to_use?: string;
    allowed_tools?: string[];
  }): Promise<any> {
    const data = {
      change_summary: `e2e version ${input.version}`,
      ...input,
    };
    return unwrap(await this.raw("POST", `/skills/${pkgId}/versions`, { data }));
  }

  // ---- Workflow transitions (skill-workflow router) --------------------
  async startTest(pkgId: string, vid: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/versions/${vid}/start-test`));
  }

  async canary(pkgId: string, vid: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/versions/${vid}/canary`));
  }

  async deprecate(pkgId: string, vid: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/versions/${vid}/deprecate`));
  }

  async rollback(pkgId: string, vid: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/versions/${vid}/rollback`));
  }

  async requestPublish(pkgId: string, vid: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/versions/${vid}/request-publish`));
  }

  async publish(pkgId: string, vid: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/versions/${vid}/publish`));
  }

  async listApprovals(): Promise<any> {
    return unwrap(await this.raw("GET", "/skills/approvals"));
  }

  async approveVersion(approvalId: string, notes?: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/approvals/${approvalId}/approve`, { data: { notes } }));
  }

  async rejectVersion(approvalId: string, reason?: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/approvals/${approvalId}/reject`, { data: { reason } }));
  }

  async forceUpdate(pkgId: string, input: { reason?: string; deadline_hours?: number }): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/force-update`, { data: input }));
  }

  async getAudit(pkgId: string): Promise<any> {
    return unwrap(await this.raw("GET", `/skills/${pkgId}/audit`));
  }

  // ---- Subscribe / kill (skills marketplace) ---------------------------
  async subscribe(pkgId: string, input: { subscriber_type?: string; is_forced?: boolean } = {}): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/subscribe`, { data: input }));
  }

  async unsubscribe(pkgId: string): Promise<any> {
    return unwrap(await this.raw("DELETE", `/skills/${pkgId}/subscribe`));
  }

  async listSubscriptions(): Promise<any> {
    return unwrap(await this.raw("GET", "/skills/subscriptions/list"));
  }

  async killSwitch(pkgId: string, reason?: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/kill`, { data: { reason } }));
  }

  async unkill(pkgId: string): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/unkill`));
  }

  async listAllSkillsAdmin(): Promise<any> {
    return unwrap(await this.raw("GET", "/skills/admin/all"));
  }

  // ---- Cross-org sharing ------------------------------------------------
  async createSharing(input: {
    package_id: string;
    source_org_id: string;
    target_org_id: string;
    restrictions?: Record<string, unknown>;
    usage_intent?: string;
    business_justification?: string;
  }): Promise<any> {
    const data = {
      usage_intent: "E2E fixture: validate cross-org sharing workflow",
      ...input,
    };
    return unwrap(await this.raw("POST", "/sharings", { data }));
  }

  async listSharings(query?: { status?: string; package_id?: string }): Promise<any> {
    return unwrap(await this.raw("GET", "/sharings", { query }));
  }

  async getSharing(id: string): Promise<any> {
    return unwrap(await this.raw("GET", `/sharings/${id}`));
  }

  async approveSharing(id: string): Promise<any> {
    return unwrap(await this.raw("POST", `/sharings/${id}/approve`));
  }

  async rejectSharing(id: string, reason?: string): Promise<any> {
    return unwrap(await this.raw("POST", `/sharings/${id}/reject`, { data: { reason } }));
  }

  async revokeSharing(id: string, reason?: string): Promise<any> {
    return unwrap(await this.raw("DELETE", `/sharings/${id}`, { data: { reason } }));
  }

  // ---- Usage logs -------------------------------------------------------
  async logUsage(workerToken: string, pkgId: string, payload: Record<string, unknown>): Promise<any> {
    return unwrap(await this.raw("POST", `/skills/${pkgId}/usage`, { workerToken, data: payload }));
  }

  async getUsageStats(pkgId: string): Promise<any> {
    return unwrap(await this.raw("GET", `/skills/${pkgId}/usage/stats`));
  }

  async getTopUsage(windowHours?: number): Promise<any> {
    return unwrap(await this.raw("GET", "/skills/usage/top", { query: { window_hours: windowHours } }));
  }

  async getRecentUsage(pkgId: string, limit = 10): Promise<any> {
    return unwrap(await this.raw("GET", `/skills/${pkgId}/usage/recent`, { query: { limit } }));
  }

  // ---- Security Gateway -------------------------------------------------
  async getSecurityStatus(): Promise<any> {
    return unwrap(await this.raw("GET", "/security/status"));
  }

  async scanText(text: string): Promise<any> {
    return unwrap(await this.raw("POST", "/security/scan", { data: { text } }));
  }

  async checkTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    return unwrap(await this.raw("POST", "/security/check-tool", { data: { tool_name: toolName, args } }));
  }

  async getSecurityRules(): Promise<any> {
    return unwrap(await this.raw("GET", "/security/rules"));
  }

  // ---- MFA / Auth adapters ----------------------------------------------
  async mfaSetup(): Promise<any> {
    return unwrap(await this.raw("POST", "/auth/mfa/setup"));
  }

  async mfaVerify(secret: string, code: string): Promise<any> {
    return unwrap(await this.raw("POST", "/auth/mfa/verify", { data: { secret, code } }));
  }

  async mfaStatus(): Promise<any> {
    return unwrap(await this.raw("GET", "/auth/mfa/status"));
  }

  async mfaDisable(code: string): Promise<any> {
    return unwrap(await this.raw("POST", "/auth/mfa/disable", { data: { code } }));
  }

  async listAdapters(): Promise<any> {
    return unwrap(await this.raw("GET", "/auth/adapters"));
  }

  async externalLogin(provider: string, credentials: Record<string, unknown>): Promise<any> {
    return unwrap(await this.raw("POST", "/auth/external/login", { data: { provider, credentials } }));
  }

  // ---- RBAC -------------------------------------------------------------
  async listRoles(): Promise<any> {
    return unwrap(await this.raw("GET", "/rbac/roles"));
  }

  async listPermissions(): Promise<any> {
    return unwrap(await this.raw("GET", "/rbac/permissions"));
  }

  async getRolePermissions(roleId: string): Promise<any> {
    return unwrap(await this.raw("GET", `/rbac/roles/${roleId}/permissions`));
  }
}

// ---------------------------------------------------------------------------
// High-level convenience flows (reduce boilerplate across tests)
// ---------------------------------------------------------------------------

export interface PublishedSkill {
  packageId: string;
  versionId: string;
  orgId?: string;
}

/**
 * Full publish flow for an org/system-scope package:
 *   create package → create version → request-publish → admin approve → publish.
 * Returns { packageId, versionId }.
 */
export async function publishOrgSkill(
  admin: HubApi,
  opts: { name: string; scope?: "org" | "system"; orgId?: string; content?: string; version?: string },
): Promise<PublishedSkill> {
  const scope = opts.scope ?? "org";
  const r1 = await admin.createSkill({
    name: opts.name,
    description: `${opts.name} — e2e fixture`,
    scope,
    org_id: opts.orgId,
  });
  const packageId = r1.package?.id ?? r1.id;
  const r2 = await admin.createVersion(packageId, {
    version: opts.version ?? "1.0.0",
    content: opts.content ?? `# ${opts.name}\n\nLegitimate skill content for e2e testing.\n## Instructions\nBe helpful and accurate.`,
    autoPublish: false,
  });
  const versionId = r2.version?.id ?? r2.id;
  await admin.requestPublish(packageId, versionId);
  const approvals = await admin.listApprovals();
  const appr = (approvals.approvals ?? []).find((a: any) => a.version_id === versionId);
  if (appr) await admin.approveVersion(appr.id, "e2e auto-approve");
  await admin.publish(packageId, versionId);
  return { packageId, versionId, orgId: opts.orgId };
}

/** Register + approve a worker; returns { workerId, workerToken }. */
export async function provisionWorker(
  admin: HubApi,
  opts: { name: string; hostname?: string; orgId?: string; protocolVersion?: number },
): Promise<{ workerId: string; workerToken: string }> {
  const r = await admin.registerWorker({
    name: opts.name,
    hostname: opts.hostname ?? "e2e-host",
    protocol_version: opts.protocolVersion ?? 2,
    org_id: opts.orgId,
  });
  const workerId = r.worker_id;
  const a = await admin.approveWorker(workerId);
  return { workerId, workerToken: a.worker_token };
}

/** Admin login helper. */
export async function adminLogin(request: APIRequestContext): Promise<HubApi> {
  const api = new HubApi(request);
  await api.login("admin", "admin123");
  return api;
}

/** Unique suffix generator to avoid collisions across runs. */
export function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
