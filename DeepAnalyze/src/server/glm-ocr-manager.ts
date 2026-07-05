// =============================================================================
// DeepAnalyze - GLM-OCR Container Lifecycle Manager
// Manages the glm-ocr Docker container for VLM inference via zai-org/GLM-OCR.
// Mirrors paddleocr-vl-manager.ts function-export pattern.
// =============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = path.join(PROJECT_ROOT, "docker-compose.dev.yml");

const SERVICE_NAME = "glm-ocr";
const HEALTH_URL = "http://localhost:8601/health";
const DEFAULT_PORT = 8601;

export type GlmOcrStatus = "running" | "stopped" | "unavailable" | "error";

export interface GlmOcrInfo {
  status: GlmOcrStatus;
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
 * Get the status of the glm-ocr container.
 */
export async function getGlmOcrStatus(): Promise<GlmOcrInfo> {
  if (!(await isDockerAvailable())) {
    return { status: "unavailable", port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: "Docker not available" };
  }

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "ps", "--format", "json", SERVICE_NAME],
      { timeout: 10000 },
    );

    if (!stdout.trim()) {
      return { status: "stopped", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
    }

    const line = stdout.trim().split("\n")[0];
    const info = JSON.parse(line);
    if (info.State === "running") {
      return { status: "running", containerId: info.Id, port: DEFAULT_PORT, healthUrl: HEALTH_URL };
    }
    return { status: "stopped", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
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
 * Start the glm-ocr container.
 * Uses docker compose with the "glm-ocr" profile.
 */
export async function startGlmOcrContainer(): Promise<GlmOcrInfo> {
  if (!(await isDockerAvailable())) {
    return { status: "unavailable", port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: "Docker not available" };
  }

  try {
    await execFileAsync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "--profile", "glm-ocr", "up", "-d", SERVICE_NAME],
      { timeout: 60000 },
    );
    return { status: "running", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
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
 * Stop the glm-ocr container.
 */
export async function stopGlmOcrContainer(): Promise<GlmOcrInfo> {
  if (!(await isDockerAvailable())) {
    return { status: "unavailable", port: DEFAULT_PORT, healthUrl: HEALTH_URL, error: "Docker not available" };
  }

  try {
    await execFileAsync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "stop", SERVICE_NAME],
      { timeout: 30000 },
    );
    return { status: "stopped", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err) {
    return {
      status: "error",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
