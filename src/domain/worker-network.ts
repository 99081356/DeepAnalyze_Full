// Worker 专属 docker network 管理
// 命名: da-net-<workerId>
// 用途: 隔离 da-app 和 da-pg 容器，PG 不暴露 host 端口

import type { SshExecutor } from "./ssh-executor.js";

/**
 * Conservative allowlist for the workerId segment we interpolate into shell
 * commands (network / volume / container names). Mirrors the check already
 * enforced in worker-pg-container.ts and guards against shell injection when
 * workerId flows in from API/DB.
 */
function assertSafeWorkerId(workerId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(workerId)) {
    throw new Error(`invalid workerId: ${workerId}`);
  }
}

export function workerNetworkName(workerId: string): string {
  return `da-net-${workerId}`;
}

export async function networkExists(ssh: SshExecutor, workerId: string): Promise<boolean> {
  assertSafeWorkerId(workerId);
  const name = workerNetworkName(workerId);
  const r = await ssh.exec(`docker network inspect ${name}`);
  return r.exitCode === 0;
}

export async function ensureWorkerNetwork(ssh: SshExecutor, workerId: string): Promise<void> {
  assertSafeWorkerId(workerId);
  if (await networkExists(ssh, workerId)) return;
  const name = workerNetworkName(workerId);
  const r = await ssh.exec(`docker network create ${name}`);
  if (r.exitCode !== 0) {
    throw new Error(`failed to create network ${name}: ${r.stderr}`);
  }
}

export async function removeWorkerNetwork(ssh: SshExecutor, workerId: string): Promise<void> {
  assertSafeWorkerId(workerId);
  const name = workerNetworkName(workerId);
  const r = await ssh.exec(`docker network rm ${name} 2>/dev/null || true`);
  // exitCode 不为 0 也不抛（network 可能已经被删了），idempotent
}
