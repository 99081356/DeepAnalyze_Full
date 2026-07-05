// =============================================================================
// DeepAnalyze - PaddleOCR-VL Container Lifecycle Manager
// Manages the paddleocr-vl Docker container for high-concurrency VLM inference.
// =============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = "deepanalyze-paddleocr-vl";
const SERVICE_NAME = "paddleocr-vl";
const HEALTH_URL = "http://localhost:8600/health";
const DEFAULT_PORT = 8600;

export type VlmContainerStatus = "running" | "stopped" | "starting" | "unavailable" | "error";

export interface VlmContainerInfo {
  status: VlmContainerStatus;
  containerId?: string;
  port: number;
  healthUrl: string;
  error?: string;
}

/**
 * Check if Docker is available on the system.
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the status of the paddleocr-vl container.
 */
export async function getVlmContainerStatus(): Promise<VlmContainerInfo> {
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    return { status: "unavailable", port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: "Docker not available" };
  }

  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-a", "--filter", `name=${CONTAINER_NAME}`,
      "--format", "{{.ID}}\t{{.Status}}",
    ], { timeout: 10000 });

    if (!stdout.trim()) {
      return { status: "stopped", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
    }

    const [containerId, statusLine] = stdout.trim().split("\t");

    if (statusLine.toLowerCase().startsWith("up")) {
      // Container is running — check health endpoint
      try {
        const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json() as { status?: string };
          return {
            status: data.status === "ok" ? "running" : "starting",
            containerId,
            port: DEFAULT_PORT,
            healthUrl: HEALTH_URL,
          };
        }
      } catch {
        // Health check failed — container may still be starting
        return { status: "starting", containerId, port: DEFAULT_PORT, healthUrl: HEALTH_URL };
      }

      return { status: "running", containerId, port: DEFAULT_PORT, healthUrl: HEALTH_URL };
    }

    return { status: "stopped", containerId, port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err) {
    return {
      status: "error",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Start the paddleocr-vl container.
 * Uses docker compose with the "vlm" profile.
 */
export async function startVlmContainer(): Promise<VlmContainerInfo> {
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    return { status: "unavailable", port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: "Docker not available" };
  }

  try {
    // First check if already running
    const current = await getVlmContainerStatus();
    if (current.status === "running") {
      return current;
    }

    console.log("[PaddleOCR-VL] Starting container...");

    // Determine the compose file path relative to project root
    const composeArgs = [
      "-f", "docker-compose.dev.yml",
      "--profile", "vlm",
      "up", "-d", SERVICE_NAME,
    ];

    await execFileAsync("docker", ["compose", ...composeArgs], {
      timeout: 120000,
      cwd: process.cwd(),
    });

    console.log("[PaddleOCR-VL] Container started, waiting for health check...");

    // Wait for health check to pass (up to 90 seconds)
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const status = await getVlmContainerStatus();
      if (status.status === "running") {
        console.log("[PaddleOCR-VL] Service is healthy");
        return status;
      }
    }

    return { status: "starting", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err) {
    console.error("[PaddleOCR-VL] Failed to start container:", err);
    return {
      status: "error",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Stop the paddleocr-vl container.
 */
export async function stopVlmContainer(): Promise<VlmContainerInfo> {
  try {
    console.log("[PaddleOCR-VL] Stopping container...");

    const composeArgs = [
      "-f", "docker-compose.dev.yml",
      "--profile", "vlm",
      "stop", SERVICE_NAME,
    ];

    await execFileAsync("docker", ["compose", ...composeArgs], {
      timeout: 30000,
      cwd: process.cwd(),
    });

    console.log("[PaddleOCR-VL] Container stopped");
    return { status: "stopped", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err) {
    console.error("[PaddleOCR-VL] Failed to stop container:", err);
    return {
      status: "error",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
