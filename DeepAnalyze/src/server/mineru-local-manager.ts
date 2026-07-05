// =============================================================================
// DeepAnalyze - MinerU Local Container Lifecycle Manager
// Manages the MinerU Docker container for local PDF parsing via magic-pdf.
// Mirrors paddleocr-vl-manager / glm-ocr-manager function-export pattern.
// =============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = path.join(PROJECT_ROOT, "docker-compose.dev.yml");

const SERVICE_NAME = "mineru";
const HEALTH_URL = "http://localhost:8001/health";
const DEFAULT_PORT = 8001;

export type MinerULocalStatus = "running" | "stopped" | "unavailable" | "error";

export interface MinerULocalInfo {
  status: MinerULocalStatus;
  containerId?: string;
  port: number;
  healthUrl: string;
  device?: "cpu" | "cuda";
  error?: string;
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function getMinerULocalStatus(): Promise<MinerULocalInfo> {
  if (!(await isDockerAvailable())) {
    return {
      status: "unavailable",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: "Docker not available",
    };
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
      return {
        status: "running",
        containerId: info.Id,
        port: DEFAULT_PORT,
        healthUrl: HEALTH_URL,
        device: process.env.MINERU_DEVICE === "cuda" ? "cuda" : "cpu",
      };
    }
    return { status: "stopped", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err: any) {
    return {
      status: "error",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: err?.message,
    };
  }
}

export async function startMinerULocalContainer(
  gpuRequired = false,
): Promise<MinerULocalInfo> {
  if (!(await isDockerAvailable())) {
    return {
      status: "unavailable",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: "Docker not available",
    };
  }
  try {
    // Set device arg via env so docker compose picks up the build arg
    const env = {
      ...process.env,
      MINERU_DEVICE: gpuRequired ? "cuda" : "cpu",
    };
    await execFileAsync(
      "docker",
      [
        "compose",
        "-f",
        COMPOSE_FILE,
        "--profile",
        "mineru",
        "up",
        "-d",
        "--build",
        SERVICE_NAME,
      ],
      { timeout: 300000, env }, // 5min — image build on first run
    );
    return {
      status: "running",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      device: gpuRequired ? "cuda" : "cpu",
    };
  } catch (err: any) {
    return {
      status: "error",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: err?.message,
    };
  }
}

export async function stopMinerULocalContainer(): Promise<MinerULocalInfo> {
  if (!(await isDockerAvailable())) {
    return {
      status: "unavailable",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: "Docker not available",
    };
  }
  try {
    await execFileAsync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "stop", SERVICE_NAME],
      { timeout: 30000 },
    );
    return { status: "stopped", port: DEFAULT_PORT, healthUrl: HEALTH_URL };
  } catch (err: any) {
    return {
      status: "error",
      port: DEFAULT_PORT,
      healthUrl: HEALTH_URL,
      error: err?.message,
    };
  }
}
