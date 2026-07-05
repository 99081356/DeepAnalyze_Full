// src/services/modules/health-probe.ts
import net from "node:net";
import type { ModuleMode } from "../../store/repos/module-states.js";

// NOTE: HealthStatus is RENAMED from the plan's ModuleStatus to avoid collision
// with the existing lifecycle ModuleStatus at src/store/repos/module-states.ts:6.
export type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

export interface ModuleHealth {
  status: HealthStatus;
  mode: ModuleMode;            // 'local' | 'remote' | 'disabled' (NO 'docker')
  endpoint?: string | null;
  latency_ms?: number;
  last_error?: string;
  last_check_at: string;
}

export interface ModuleHealthMap {
  embedding?: ModuleHealth;
  asr?: ModuleHealth;
  docling?: ModuleHealth;
  mineru?: ModuleHealth;
  paddleocrVl?: ModuleHealth;   // VLM sidecar (NOT a top-level module)
  glmOcr?: ModuleHealth;        // VLM sidecar (NOT a top-level module)
  pg?: ModuleHealth;
}

/**
 * HTTP /health probe with timeout. Returns healthy on 2xx, degraded on !ok, down on network error.
 */
export async function probeHttp(input: {
  url: string;
  mode: ModuleMode;
  endpoint?: string | null;
  timeoutMs?: number;
}): Promise<ModuleHealth> {
  const start = Date.now();
  const last_check_at = new Date().toISOString();
  try {
    const res = await fetch(input.url, {
      signal: AbortSignal.timeout(input.timeoutMs ?? 3000),
    });
    return {
      status: res.ok ? "healthy" : "degraded",
      mode: input.mode,
      endpoint: input.endpoint,
      latency_ms: Date.now() - start,
      last_check_at,
    };
  } catch (e) {
    return {
      status: "down",
      mode: input.mode,
      endpoint: input.endpoint,
      last_error: e instanceof Error ? e.message : String(e),
      last_check_at,
    };
  }
}

/**
 * TCP port probe with timeout. Used for docker-sidecar modules without HTTP /health.
 */
export async function probeTcp(input: {
  host: string;
  port: number;
  mode: ModuleMode;
  timeoutMs?: number;
}): Promise<ModuleHealth> {
  const start = Date.now();
  const last_check_at = new Date().toISOString();
  const endpoint = `${input.host}:${input.port}`;
  return new Promise<ModuleHealth>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(input.timeoutMs ?? 2000);
    socket.on("connect", () => {
      socket.destroy();
      resolve({
        status: "healthy",
        mode: input.mode,
        endpoint,
        latency_ms: Date.now() - start,
        last_check_at,
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({
        status: "down",
        mode: input.mode,
        endpoint,
        last_error: "timeout",
        last_check_at,
      });
    });
    socket.on("error", (err) => {
      socket.destroy();
      resolve({
        status: "down",
        mode: input.mode,
        endpoint,
        last_error: err.message,
        last_check_at,
      });
    });
    socket.connect(input.port, input.host);
  });
}

// Re-export aggregator from probes/index
export { probeAllModules } from "./probes/index.js";
