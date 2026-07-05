// src/services/modules/probes/paddleocr-vl.ts
// VLM sidecar probe — calls existing container manager.
//
// Verified actual return shape of getVlmContainerStatus() at
// src/services/paddleocr-vl-manager.ts:41 — VlmContainerInfo:
//   {
//     status: "running" | "stopped" | "starting" | "unavailable" | "error";
//     containerId?: string;
//     port: number;            // ALWAYS present (not optional)
//     healthUrl: string;       // ALWAYS present
//     error?: string;          // present on unavailable/error
//   }
import { getVlmContainerStatus } from "../../../services/paddleocr-vl-manager.js";
import type { ModuleHealth } from "../health-probe.js";

export async function probePaddleocrVl(): Promise<ModuleHealth> {
  const last_check_at = new Date().toISOString();
  try {
    const containerStatus = await getVlmContainerStatus();
    // Map container status → HealthStatus.
    // - running  → healthy (Docker says up + HTTP /health returned ok)
    // - starting → degraded (container is up but health endpoint not yet ok)
    // - stopped  → down (container exists but not running)
    // - unavailable → down (Docker itself not available)
    // - error    → down (docker ps failed)
    const status =
      containerStatus.status === "running" ? "healthy" as const :
      containerStatus.status === "starting" ? "degraded" as const :
      "down" as const;
    return {
      status,
      mode: "local",  // VLM sidecars are always local docker containers
      endpoint: `http://127.0.0.1:${containerStatus.port}`,
      last_error: containerStatus.error,
      last_check_at,
    };
  } catch (e) {
    return {
      status: "down",
      mode: "local",
      last_error: e instanceof Error ? e.message : String(e),
      last_check_at,
    };
  }
}
