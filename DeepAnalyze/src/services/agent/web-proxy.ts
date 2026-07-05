// =============================================================================
// DeepAnalyze - Lightweight Web Proxy Helper
// =============================================================================
// Self-contained proxy support for web_search and other HTTP tools.
// Reads standard proxy environment variables (HTTPS_PROXY, HTTP_PROXY, etc.)
// and returns fetch options compatible with both Bun and Node.js runtimes.
//
// Supports:
//   - HTTPS_PROXY / HTTP_PROXY / https_proxy / http_proxy env vars
//   - DEEPANALYZE_WEB_PROXY env var (DeepAnalyze-specific override)
//   - NO_PROXY / no_proxy env var for bypassing proxy for specific hosts
//   - Bun runtime: uses native `proxy` fetch option
//   - Node.js runtime: uses HttpsProxyAgent via `dispatcher` option
// =============================================================================

import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent } from "http";

// ---------------------------------------------------------------------------
// Proxy URL detection
// ---------------------------------------------------------------------------

/**
 * Get the active proxy URL from environment variables.
 * Priority: https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY > DEEPANALYZE_WEB_PROXY
 */
export function getProxyUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.DEEPANALYZE_WEB_PROXY;
}

/**
 * Get the NO_PROXY value from environment variables.
 */
function getNoProxy(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.no_proxy || env.NO_PROXY;
}

// ---------------------------------------------------------------------------
// NO_PROXY matching
// ---------------------------------------------------------------------------

/**
 * Check if a URL should bypass the proxy based on NO_PROXY.
 * Supports:
 *   - Wildcard "*" to bypass all
 *   - Exact hostname matches (e.g., "localhost")
 *   - Domain suffix matches (e.g., ".example.com" matches "sub.example.com")
 *   - Port-specific matches (e.g., "example.com:8080")
 */
export function shouldBypassProxy(
  urlString: string,
  noProxy?: string,
): boolean {
  const np = noProxy ?? getNoProxy();
  if (!np) return false;
  if (np === "*") return true;

  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const hostWithPort = `${hostname}:${port}`;

    const patterns = np.split(/[,\s]+/).filter(Boolean);

    return patterns.some((raw) => {
      const pattern = raw.toLowerCase().trim();

      // Port-specific: "example.com:8080"
      if (pattern.includes(":")) {
        return hostWithPort === pattern;
      }

      // Domain suffix: ".example.com" matches "sub.example.com" and "example.com"
      if (pattern.startsWith(".")) {
        return hostname === pattern.substring(1) || hostname.endsWith(pattern);
      }

      // Exact hostname
      return hostname === pattern;
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fetch options
// ---------------------------------------------------------------------------

/** Return type for getWebProxyFetchOptions. */
export interface ProxyFetchOptions {
  /** Bun: native proxy URL support. */
  proxy?: string;
  /** Node.js: undici dispatcher for proxying. */
  dispatcher?: Agent;
}

/**
 * Build fetch options for proxy support.
 *
 * - On Bun: returns `{ proxy: proxyUrl }` for native fetch proxy support.
 * - On Node.js: returns `{ dispatcher: HttpsProxyAgent }` for undici-based proxy.
 * - If no proxy is configured, returns `{}`.
 * - Respects NO_PROXY for bypassing specific hosts.
 *
 * @param targetUrl The URL being fetched (used for NO_PROXY check).
 */
export function getWebProxyFetchOptions(targetUrl?: string): ProxyFetchOptions {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return {};

  // Check NO_PROXY bypass
  if (targetUrl && shouldBypassProxy(targetUrl)) {
    return {};
  }

  const isBun = typeof Bun !== "undefined";

  if (isBun) {
    // Bun has native proxy support in fetch()
    return { proxy: proxyUrl };
  } else {
    // Node.js: use HttpsProxyAgent as undici dispatcher
    try {
      const agent = new HttpsProxyAgent(proxyUrl);
      return { dispatcher: agent as unknown as Agent };
    } catch (err) {
      console.warn("[WebProxy] Failed to create proxy agent:", err);
      return {};
    }
  }
}
