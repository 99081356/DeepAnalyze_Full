// =============================================================================
// src/setup/environment.ts
// =============================================================================

import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, cpus, totalmem, freemem } from "node:os";
import { join } from "node:path";
import { getModelsDir } from "../services/model-manifest.js";

export interface EnvironmentReport {
  cpu: { cores: number };
  memory: { totalGb: number; freeGb: number };
  disk: { availableGb: number };
  gpu: { available: boolean; name?: string; vramMb?: number };
  network: {
    huggingFace: boolean;
    hfMirror: boolean;
    hubUrl?: boolean;
    enterpriseRepo?: boolean;
  };
  existingModels: string[];
  hfCacheHits: string[];
}

export async function detectEnvironment(): Promise<EnvironmentReport> {
  return {
    cpu: detectCpu(),
    memory: detectMemory(),
    disk: detectDisk(),
    gpu: detectGpu(),
    network: await detectNetwork(),
    existingModels: detectExistingModels(),
    hfCacheHits: detectHfCache(),
  };
}

function detectCpu() {
  return { cores: cpus().length };
}

function detectMemory() {
  const m = totalmem();
  const f = freemem();
  return { totalGb: +(m / 1e9).toFixed(1), freeGb: +(f / 1e9).toFixed(1) };
}

function detectDisk() {
  try {
    const output = execSync("df -BG . | tail -1 | awk '{print $4}'", { encoding: "utf-8" }).trim();
    return { availableGb: parseInt(output, 10) };
  } catch {
    return { availableGb: 0 };
  }
}

function detectGpu() {
  try {
    const output = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", { encoding: "utf-8" }).trim();
    const [name, vramMb] = output.split(",").map(s => s.trim());
    return { available: true, name, vramMb: parseInt(vramMb, 10) };
  } catch {
    return { available: false };
  }
}

async function detectNetwork(): Promise<EnvironmentReport["network"]> {
  const result: EnvironmentReport["network"] = {
    huggingFace: false,
    hfMirror: false,
  };

  const targets: Array<[keyof EnvironmentReport["network"], string]> = [
    ["huggingFace", "https://huggingface.co"],
    ["hfMirror", "https://hf-mirror.com"],
  ];

  await Promise.all(targets.map(async ([key, url]) => {
    try {
      const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      result[key] = resp.ok;
    } catch { result[key] = false; }
  }));

  if (process.env.DA_HUB_URL) {
    try {
      const resp = await fetch(`${process.env.DA_HUB_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
      result.hubUrl = resp.ok;
    } catch { result.hubUrl = false; }
  }
  if (process.env.DA_ENTERPRISE_MODELS_URL) {
    try {
      const resp = await fetch(`${process.env.DA_ENTERPRISE_MODELS_URL}/health`, { signal: AbortSignal.timeout(5000) });
      result.enterpriseRepo = resp.ok;
    } catch { result.enterpriseRepo = false; }
  }

  return result;
}

function detectExistingModels(): string[] {
  const dir = getModelsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function detectHfCache(): string[] {
  const cacheDir = join(homedir(), ".cache/huggingface/hub");
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name.replace(/^models--/, "").replace(/--/g, "/"));
}
