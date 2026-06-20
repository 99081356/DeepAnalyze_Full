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
};
