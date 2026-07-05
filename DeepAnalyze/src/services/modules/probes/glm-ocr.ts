// src/services/modules/probes/glm-ocr.ts
// VLM sidecar probe — calls existing container manager.
//
// Verified actual return shape of getGlmOcrStatus() at
// src/server/glm-ocr-manager.ts:47 — GlmOcrInfo:
//   {
//     status: "running" | "stopped" | "unavailable" | "error";
//     containerId?: string;
//     port: number;            // ALWAYS present (not optional)
//     healthUrl: string;       // ALWAYS present
//     error?: string;          // present on unavailable/error
//   }
// NOTE: glm-ocr manager has NO "starting" state (unlike paddleocr-vl).
import { getGlmOcrStatus } from "../../../server/glm-ocr-manager.js";
import type { ModuleHealth } from "../health-probe.js";

export async function probeGlmOcr(): Promise<ModuleHealth> {
  const last_check_at = new Date().toISOString();
  try {
    const containerStatus = await getGlmOcrStatus();
    // Map container status → HealthStatus.
    // - running    → healthy
    // - stopped    → down
    // - unavailable → down (Docker not available)
    // - error      → down
    const status =
      containerStatus.status === "running" ? "healthy" as const :
      "down" as const;
    return {
      status,
      mode: "local",
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
