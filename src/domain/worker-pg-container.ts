// Worker 专属 PG 容器生命周期管理
// - 容器名: da-pg-<workerId>
// - volume:  da-pg-data-<workerId>
// - image:   ${HUB_DOCKER_REGISTRY}da-postgres:16-tuned
// - 网络:    da-net-<workerId>（外部创建，本模块只引用）

import type { SshExecutor } from "./ssh-executor.js";
import type { PgCredentials } from "./worker-pg-credentials.js";

export function pgContainerName(workerId: string): string {
  return `da-pg-${workerId}`;
}

export function pgVolumeName(workerId: string): string {
  return `da-pg-data-${workerId}`;
}

export function daPostgresImage(): string {
  const registry = process.env.HUB_DOCKER_REGISTRY ?? "";
  return `${registry}da-postgres:16-tuned`;
}

export async function pgContainerExists(ssh: SshExecutor, workerId: string): Promise<boolean> {
  const name = pgContainerName(workerId);
  const r = await ssh.exec(
    `docker ps -a --filter name=^/${name}$ --format '{{.Names}}'`,
  );
  return r.stdout.trim() === name;
}

export async function ensurePgContainer(
  ssh: SshExecutor,
  workerId: string,
  creds: PgCredentials,
  orgId?: string,
): Promise<void> {
  // 验证 workerId/creds 没有 shell 注入风险（保守白名单）
  if (!/^[a-zA-Z0-9_-]+$/.test(workerId)) {
    throw new Error(`invalid workerId: ${workerId}`);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(creds.database)) {
    throw new Error(`invalid database name: ${creds.database}`);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(creds.username)) {
    throw new Error(`invalid username: ${creds.username}`);
  }
  // password 不能含单引号（即使我们在 -e 里用 single quotes wrap）
  if (creds.password.includes("'")) {
    throw new Error("password contains single quote — refused for shell safety");
  }

  if (await pgContainerExists(ssh, workerId)) return;

  const name = pgContainerName(workerId);
  const volume = pgVolumeName(workerId);
  const network = `da-net-${workerId}`;
  const image = daPostgresImage();
  const labels = [
    `--label com.deepanalyze.workerId=${workerId}`,
    `--label com.deepanalyze.role=pg`,
  ];
  if (orgId) labels.push(`--label com.deepanalyze.orgId=${orgId}`);

  const cmd = `docker run -d \
    --name ${name} \
    --network ${network} \
    ${labels.join(" ")} \
    -v ${volume}:/var/lib/postgresql/data \
    -e POSTGRES_DB='${creds.database}' \
    -e POSTGRES_USER='${creds.username}' \
    -e POSTGRES_PASSWORD='${creds.password}' \
    --restart unless-stopped \
    ${image}`;

  const r = await ssh.exec(cmd);
  if (r.exitCode !== 0) {
    throw new Error(`failed to start pg container ${name}: ${r.stderr}`);
  }

  await waitForPgReady(ssh, workerId, 30);
}

export async function waitForPgReady(
  ssh: SshExecutor,
  workerId: string,
  timeoutSec = 30,
): Promise<void> {
  const name = pgContainerName(workerId);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = await ssh.exec(
      `docker exec ${name} pg_isready -U da 2>&1 || true`,
    );
    if (r.stdout.includes("accepting")) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`pg container ${name} not ready within ${timeoutSec}s (timeout)`);
}

export async function removePgContainer(
  ssh: SshExecutor,
  workerId: string,
  opts?: { removeVolume?: boolean },
): Promise<void> {
  const name = pgContainerName(workerId);
  // 强制删容器，idempotent
  await ssh.exec(`docker rm -f ${name} 2>/dev/null || true`);

  if (opts?.removeVolume) {
    const volume = pgVolumeName(workerId);
    await ssh.exec(`docker volume rm ${volume} 2>/dev/null || true`);
  }
}
