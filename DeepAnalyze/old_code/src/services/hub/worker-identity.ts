/**
 * Worker identity management.
 *
 * Generates and persists a unique Worker ID in the data directory,
 * and provides helpers for collecting Worker capabilities and status.
 */

import os from "os";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { WorkerCapabilities, WorkerLocalStatus } from "./types.js";

const WORKER_ID_FILE = ".worker-id";

/**
 * Read the persisted Worker ID from dataDir, or generate and save a new one.
 * The ID is a UUID v4 stored in `{dataDir}/.worker-id`.
 */
export function getOrCreateWorkerId(dataDir: string): string {
  const filePath = join(dataDir, WORKER_ID_FILE);
  if (existsSync(filePath)) {
    try {
      const id = readFileSync(filePath, "utf-8").trim();
      if (id.length > 0) return id;
    } catch {
      // fall through to generate new
    }
  }
  const id = randomUUID();
  try {
    writeFileSync(filePath, id, "utf-8");
  } catch (err) {
    console.warn(`[Hub] Failed to persist worker ID: ${err}`);
  }
  return id;
}

/**
 * Collect Worker hardware/software capabilities for registration.
 */
export function collectWorkerCapabilities(): WorkerCapabilities {
  const cpus = os.cpus();
  return {
    cpuCores: cpus.length,
    memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    gpuAvailable: false, // GPU detection not implemented yet
    os: `${os.type()} ${os.release()}`,
    daVersion: "", // filled by caller from DEEPANALYZE_CONFIG.version
    runMode: "standalone", // filled by caller based on environment
  };
}

/** Start time for uptime calculation. */
const startTime = Date.now();

/**
 * Collect Worker runtime status for heartbeat and status queries.
 */
export function collectWorkerStatus(
  workerId: string,
  version: string,
  hubConnected: boolean,
  lastHubContact: string | null,
  activeSessions: number,
  activeTasks: number,
): WorkerLocalStatus {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // CPU usage approximation (load average / cores, 0-100)
  const loadAvg = os.loadavg();
  const cpuCores = os.cpus().length;
  const cpuPercent = Math.min(100, Math.round((loadAvg[0] / cpuCores) * 100));

  return {
    workerId,
    version,
    uptime: Math.round((Date.now() - startTime) / 1000),
    status: activeTasks > 0 ? "busy" : "idle",
    activeSessions,
    activeTasks,
    resourceUsage: {
      cpuPercent,
      memoryUsedGB: Math.round((usedMem / 1024 / 1024 / 1024) * 10) / 10,
      memoryTotalGB: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
      diskUsedGB: 0,   // disk usage requires async call; filled lazily
      diskTotalGB: 0,
    },
    hubConnected,
    lastHubContact,
  };
}
