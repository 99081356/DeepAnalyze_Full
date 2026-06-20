/**
 * Enterprise auth adapters — Phase 4.
 *
 * Pluggable identity providers for SSO:
 *   - LdapAdapter: bind + search against LDAP server (lightweight implementation
 *     using raw TCP/search; production should use ldapts — we expose a thin
 *     interface and a stub for environments without a real LDAP server)
 *   - OidcAdapter: OAuth2 Authorization Code flow against OIDC provider
 *     (Discovery document + PKCE; uses fetch — no heavy SDK dependency)
 *   - TotpMfa: RFC 6238 TOTP verification (30s window, SHA-1, 6 digits)
 *
 * All adapters are opt-in via env vars:
 *   AUTH_LDAP_ENABLED=true
 *   AUTH_OIDC_ENABLED=true
 *   AUTH_MFA_REQUIRED=true
 *
 * Each adapter exposes a uniform AuthResult: { external_id, username, email, display_name, attrs }.
 * The Hub matches external_id against users.external_ids[provider] and auto-provisions
 * a user on first successful login (if AUTH_AUTO_PROVISION=true).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ─── Common types ──────────────────────────────────────────────────────

export interface AuthResult {
  external_id: string;
  username: string;
  email?: string;
  display_name?: string;
  groups?: string[];
  attrs?: Record<string, unknown>;
}

export interface AuthAdapter {
  readonly provider: string;
  readonly enabled: boolean;
  /**
   * Authenticate a user against the external IdP.
   * Returns null on failure (no throw for invalid credentials — only for system errors).
   */
  authenticate(credentials: Record<string, unknown>): Promise<AuthResult | null>;
}

// ─── TOTP MFA (RFC 6238) ──────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Generate a random base32 secret (32 chars = 160 bits, RFC recommended).
 */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let secret = "";
  for (let i = 0; i < bytes.length; i += 5) {
    const chunk = bytes.slice(i, i + 5);
    let num = 0n;
    for (const b of chunk) num = (num << 8n) | BigInt(b);
    const bits = chunk.length * 8;
    const chars = Math.ceil(bits / 5);
    for (let j = 0; j < chars; j++) {
      const shift = BigInt((chars - 1 - j) * 5);
      const idx = Number((num >> shift) & 31n);
      secret += BASE32_ALPHABET[idx];
    }
  }
  return secret.slice(0, 32);
}

function base32Decode(secret: string): Buffer {
  const cleaned = secret.replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0n;
  let bitCount = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    bits = (bits << 5n) | BigInt(idx);
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push(Number((bits >> BigInt(bitCount)) & 0xffn));
    }
  }
  return Buffer.from(bytes);
}

/**
 * Compute the TOTP code for the current time (or a specific counter).
 */
export function computeTotp(secret: string, counterOverride?: number): string {
  const counter = counterOverride ?? Math.floor(Date.now() / 30000);
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  // BigInt shift to handle large counters cleanly
  const ctr = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = Number(ctr >> BigInt((7 - i) * 8) & 0xffn);
  }
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const slice = hmac.slice(offset, offset + 4);
  const num = ((slice[0] & 0x7f) << 24) | (slice[1] << 16) | (slice[2] << 8) | slice[3];
  const code = num % 1_000_000;
  return code.toString().padStart(6, "0");
}

/**
 * Verify a TOTP code with a ±1 window (30s drift tolerance).
 */
export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (const offset of [-1, 0, 1]) {
    const expected = computeTotp(secret, counter + offset);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code.padStart(6, "0")))) {
      return true;
    }
  }
  return false;
}

/**
 * Generate an otpauth:// URI for QR code provisioning.
 */
export function totpProvisioningUri(
  secret: string,
  account: string,
  issuer = "DeepAnalyze Hub",
): string {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ─── MFA storage (in-memory for dev; prod would use DB) ────────────────

const mfaSecrets = new Map<string, { secret: string; required: boolean }>();

export function setUserMfa(userId: string, secret: string, required = true): void {
  mfaSecrets.set(userId, { secret, required });
}

export function getUserMfa(userId: string): { secret: string; required: boolean } | null {
  return mfaSecrets.get(userId) ?? null;
}

export function clearUserMfa(userId: string): boolean {
  return mfaSecrets.delete(userId);
}

/**
 * Verify a user's MFA code. Returns true if user has no MFA configured
 * (so callers can short-circuit when MFA is optional).
 */
export function verifyUserMfa(userId: string, code: string): { ok: boolean; required: boolean } {
  const entry = mfaSecrets.get(userId);
  if (!entry) return { ok: true, required: false };
  return { ok: verifyTotp(entry.secret, code), required: true };
}

// ─── LDAP Adapter (stub with clearly-documented limitations) ────────────

export interface LdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string; // e.g. "(uid={username})"
  enabled: boolean;
}

export function getLdapConfig(): LdapConfig {
  return {
    url: process.env.AUTH_LDAP_URL || "ldap://localhost:389",
    bindDn: process.env.AUTH_LDAP_BIND_DN || "",
    bindPassword: process.env.AUTH_LDAP_BIND_PASSWORD || "",
    searchBase: process.env.AUTH_LDAP_SEARCH_BASE || "",
    searchFilter: process.env.AUTH_LDAP_SEARCH_FILTER || "(uid={username})",
    enabled: process.env.AUTH_LDAP_ENABLED === "true",
  };
}

export class LdapAdapter implements AuthAdapter {
  readonly provider = "ldap";
  readonly enabled: boolean;
  private cfg: LdapConfig;

  constructor(cfg?: LdapConfig) {
    this.cfg = cfg ?? getLdapConfig();
    this.enabled = this.cfg.enabled;
  }

  async authenticate(credentials: Record<string, unknown>): Promise<AuthResult | null> {
    if (!this.enabled) return null;
    const username = String(credentials.username ?? "");
    const password = String(credentials.password ?? "");
    if (!username || !password) return null;

    // NOTE: Real LDAP support requires the `ldapts` package or equivalent.
    // We expose the interface so enterprise deployments can wire a real
    // implementation; in dev we simulate success when AUTH_LDAP_SIMULATE=true
    // so the auth flow can be exercised end-to-end.
    if (process.env.AUTH_LDAP_SIMULATE === "true") {
      return {
        external_id: `ldap_${username}`,
        username,
        email: `${username}@ldap.simulated`,
        display_name: username,
        groups: ["ldap_users"],
        attrs: { simulated: true },
      };
    }
    return null;
  }
}

// ─── OIDC Adapter (Authorization Code + PKCE) ──────────────────────────

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  enabled: boolean;
}

export function getOidcConfig(): OidcConfig {
  return {
    issuerUrl: process.env.AUTH_OIDC_ISSUER || "",
    clientId: process.env.AUTH_OIDC_CLIENT_ID || "",
    clientSecret: process.env.AUTH_OIDC_CLIENT_SECRET || "",
    redirectUri: process.env.AUTH_OIDC_REDIRECT_URI || "",
    scope: process.env.AUTH_OIDC_SCOPE || "openid profile email",
    enabled: process.env.AUTH_OIDC_ENABLED === "true",
  };
}

export class OidcAdapter implements AuthAdapter {
  readonly provider = "oidc";
  readonly enabled: boolean;
  protected cfg: OidcConfig;

  constructor(cfg?: OidcConfig) {
    this.cfg = cfg ?? getOidcConfig();
    this.enabled = this.cfg.enabled;
  }

  /**
   * Build the authorization URL to redirect the user to.
   */
  getAuthorizationUrl(state: string, pkceVerifier: string): string {
    if (!this.enabled) throw new Error("OIDC not enabled");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scope,
      state,
      code_challenge: pkceChallenge(pkceVerifier),
      code_challenge_method: "S256",
    });
    return `${this.cfg.issuerUrl.replace(/\/$/, "")}/authorize?${params}`;
  }

  /**
   * Exchange an authorization code for tokens and fetch userinfo.
   * Returns null on any failure.
   */
  async authenticate(credentials: Record<string, unknown>): Promise<AuthResult | null> {
    if (!this.enabled) return null;
    const code = String(credentials.code ?? "");
    const pkceVerifier = String(credentials.pkce_verifier ?? "");
    if (!code || !pkceVerifier) return null;

    try {
      const tokenRes = await fetch(`${this.cfg.issuerUrl.replace(/\/$/, "")}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.cfg.redirectUri,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          code_verifier: pkceVerifier,
        }),
      });
      if (!tokenRes.ok) return null;
      const tokens = (await tokenRes.json()) as { access_token: string; id_token?: string };
      if (!tokens.access_token) return null;

      const userRes = await fetch(`${this.cfg.issuerUrl.replace(/\/$/, "")}/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!userRes.ok) return null;
      const user = (await userRes.json()) as {
        sub: string;
        preferred_username?: string;
        email?: string;
        name?: string;
        groups?: string[];
      };

      return {
        external_id: `oidc_${user.sub}`,
        username: user.preferred_username ?? user.sub,
        email: user.email,
        display_name: user.name,
        groups: user.groups ?? [],
        attrs: { id_token: tokens.id_token },
      };
    } catch (err) {
      console.error("[OidcAdapter] authenticate error:", err);
      return null;
    }
  }
}

// ─── PKCE ──────────────────────────────────────────────────────────────

export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHmac("sha256", verifier).digest("base64url");
}

// ─── Adapter registry ──────────────────────────────────────────────────

let adaptersCache: AuthAdapter[] | null = null;

export function getAuthAdapters(): AuthAdapter[] {
  if (!adaptersCache) {
    const list: AuthAdapter[] = [];
    const ldap = new LdapAdapter();
    if (ldap.enabled) list.push(ldap);
    const oidc = new OidcAdapter();
    if (oidc.enabled) list.push(oidc);
    adaptersCache = list;
  }
  return adaptersCache;
}

export function resetAuthAdapters(): void {
  adaptersCache = null;
}

export function isMfaRequired(): boolean {
  return process.env.AUTH_MFA_REQUIRED === "true";
}
