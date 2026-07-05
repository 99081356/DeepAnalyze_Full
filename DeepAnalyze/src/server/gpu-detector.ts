import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GpuTier = 'none' | 'low' | 'high';

export interface GpuInfo {
  tier: GpuTier;
  hasNvidia: boolean;
  vramMB: number;
  deviceName?: string;
  cudaVersion?: string;
}

const HIGH_TIER_VRAM_MB = 8192; // 8 GB threshold

export function classifyGpuTier(vramMB: number, hasNvidia: boolean): GpuTier {
  if (!hasNvidia || vramMB <= 0) return 'none';
  return vramMB >= HIGH_TIER_VRAM_MB ? 'high' : 'low';
}

export function parseNvidiaSmi(output: string): {
  deviceName: string;
  vramMB: number;
  cudaVersion: string;
} | null {
  // Expected format: "NVIDIA GeForce RTX 4090, 24576 MiB, 12.4\n"
  const match = output.match(/^(.+?),\s*(\d+)\s*MiB,\s*([\d.]+)/);
  if (!match) return null;
  return {
    deviceName: match[1].trim(),
    vramMB: parseInt(match[2], 10),
    cudaVersion: match[3].trim(),
  };
}

export async function detectGpu(): Promise<GpuInfo> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    // nvidia-smi csv output: "NVIDIA GeForce RTX 4090, 24576 MiB, 12.4"
    const parsed = parseNvidiaSmi(stdout);
    if (!parsed) {
      return { tier: 'none', hasNvidia: false, vramMB: 0 };
    }
    return {
      tier: classifyGpuTier(parsed.vramMB, true),
      hasNvidia: true,
      vramMB: parsed.vramMB,
      deviceName: parsed.deviceName,
      cudaVersion: parsed.cudaVersion,
    };
  } catch {
    return { tier: 'none', hasNvidia: false, vramMB: 0 };
  }
}
