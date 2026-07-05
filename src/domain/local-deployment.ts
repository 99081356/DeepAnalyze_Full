// =============================================================================
// DeepAnalyze Hub - Local Docker Deployment
// =============================================================================
// 在 Hub 所在机器上直接通过 docker CLI 创建/停止/删除 Worker 容器栈。
// 与 worker-deployment.ts 的 SSH 模式互补，适用于本地开发或单机部署场景。
//
// 容器栈结构（每个 Worker）:
//   网络:   da-net-<workerId>
//   PG容器:  da-pg-<workerId>   (pgvector/pgvector:pg16)
//   DA容器:  da-app-<workerId>  (deepanalyze/da:latest)
// =============================================================================

import { execSync, exec } from "node:child_process";

const DA_IMAGE = process.env.HUB_DA_IMAGE ?? "deepanalyze/da:latest";
const PG_IMAGE = process.env.HUB_DA_PG_IMAGE ?? "pgvector/pgvector:pg16";
const PORT_RANGE_START = 21000;
const PORT_RANGE_END = 21099;

/** 安全的容器名（把 workerId 中的下划线替换为连字符） */
function safeName(prefix: string, workerId: string): string {
  return `${prefix}-${workerId.replace(/_/g, "-")}`;
}

/** 执行 docker 命令，返回 stdout（同步） */
function dockerSync(args: string): string {
  return execSync(`docker ${args}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** 异步执行 docker 命令（fire-and-forget 场景） */
function dockerAsync(args: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`docker ${args}`, (err) => err ? reject(err) : resolve());
  });
}

/** 检查容器是否存在 */
function containerExists(name: string): boolean {
  try {
    dockerSync(`inspect -f '{{.Id}}' ${name}`);
    return true;
  } catch {
    return false;
  }
}

/** 检查网络是否存在 */
function networkExists(name: string): boolean {
  try {
    dockerSync(`network inspect -f '{{.Id}}' ${name}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描本机所有运行中/停止的容器，找出已占用的宿主机端口。
 * 返回已占用的端口号集合。
 */
function getUsedPorts(): Set<number> {
  const used = new Set<number>();
  try {
    // 输出格式: "0.0.0.0:21000" 或 "21000/tcp"
    const output = dockerSync(`ps -a --format '{{.Ports}}'`);
    for (const line of output.split("\n")) {
      // 匹配 0.0.0.0:XXXXX->21000/tcp 格式
      const matches = line.matchAll(/0\.0\.0\.0:(\d+)->/g);
      for (const m of matches) {
        used.add(parseInt(m[1], 10));
      }
    }
  } catch {
    // docker 命令失败时忽略，返回空集合
  }
  return used;
}

/**
 * 分配下一个可用端口（从 PORT_RANGE_START 开始扫描）
 */
export function allocateLocalPort(): number {
  const used = getUsedPorts();
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`no available port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

export interface LocalDeployOpts {
  workerId: string;
  port: number;
  imageTag?: string;
  envVars: Record<string, string>;
  pgCreds: { database: string; username: string; password: string };
}

export interface LocalDeployResult {
  containerName: string;
  pgContainerName: string;
  networkName: string;
  port: number;
  daUrl: string;
}

/**
 * 创建完整的 Worker 容器栈：网络 → PG → DA
 */
export async function deployLocalWorker(opts: LocalDeployOpts): Promise<LocalDeployResult> {
  const { workerId, port, envVars, pgCreds } = opts;
  const imageTag = opts.imageTag ?? DA_IMAGE;

  const netName = safeName("da-net", workerId);
  const pgName = safeName("da-pg", workerId);
  const appName = safeName("da-app", workerId);
  const pgDataVolume = safeName("da-pg-data", workerId);
  const appDataVolume = safeName("da-app-data", workerId);

  // ─── 1. 清理旧容器（如果存在）─────────────────────────────────────────
  for (const name of [appName, pgName]) {
    if (containerExists(name)) {
      try {
        dockerSync(`rm -f ${name}`);
      } catch {
        // 忽略清理失败
      }
    }
  }

  // ─── 2. 创建网络 ──────────────────────────────────────────────────────
  if (!networkExists(netName)) {
    dockerSync(`network create ${netName}`);
  }

  // ─── 3. 创建 PG 容器 ──────────────────────────────────────────────────
  const pgArgs = [
    "run -d",
    `--name ${pgName}`,
    `--network ${netName}`,
    `--network-alias pg`,
    `-v ${pgDataVolume}:/var/lib/postgresql/data`,
    `-e POSTGRES_DB=${pgCreds.database}`,
    `-e POSTGRES_USER=${pgCreds.username}`,
    `-e POSTGRES_PASSWORD=${pgCreds.password}`,
    `--health-cmd "pg_isready -U ${pgCreds.username} -d ${pgCreds.database}"`,
    `--health-interval 3s`,
    `--health-timeout 3s`,
    `--health-retries 10`,
    PG_IMAGE,
  ].join(" ");
  dockerSync(pgArgs);

  // 等待 PG 就绪（最多 30 秒）
  await waitForContainerHealthy(pgName, 30);

  // ─── 4. 创建 DA 容器 ──────────────────────────────────────────────────
  // 用网络别名 "pg" 作为 PG_HOST（比完整容器名更简洁，且与现有 worker 配置一致）
  //
  // 关键：Hub 部署的 Worker 默认使用「企业 Worker + 全云端模型」模式，
  //       通过预置 setup-complete.flag 跳过 SetupWizard，让用户登录后直接进入主界面。
  //       这样用户不需要手动配置认证、Join Token、模型策略等。
  const envFlags = Object.entries({
    ...envVars,
    PG_HOST: "pg",
    PG_PORT: "5432",
    PG_USER: pgCreds.username,
    PG_PASSWORD: pgCreds.password,
    PG_DATABASE: pgCreds.database,
    PORT: "21000",
    DATA_DIR: "/app/data",
  })
    .map(([k, v]) => `-e ${k}=${v}`)
    .join(" ");

  const appArgs = [
    "run -d",
    `--name ${appName}`,
    `--network ${netName}`,
    // 让 DA 容器内能解析 host.docker.internal → 宿主网关，用于 SSO 回调 Hub。
    // 与 DeepAnalyze/docker-compose.yml 的 extra_hosts 配置保持一致。
    // Linux Docker Engine < 20.10 不支持 host-gateway，但 Hub 部署要求 ≥ 20.10。
    `--add-host host.docker.internal:host-gateway`,
    `-p ${port}:21000`,
    `-v ${appDataVolume}:/app/data`,
    envFlags,
    imageTag,
  ].join(" ");
  dockerSync(appArgs);

  // 4b. 预置 setup-complete.flag + config.yaml（跳过 SetupWizard）
  //     在容器启动后立即写入，DA 后端就绪后 /api/setup/state 会返回 complete: true
  //     前端因此跳过 wizard，用户登录后直接进入主界面。
  const ts = new Date().toISOString();
  const configYaml = [
    "# DeepAnalyze configuration (auto-generated by Hub local-deployment)",
    `generated_at: ${ts}`,
    "",
    "models:",
    "  source: auto",
    "",
    "providers: {}",
    "",
  ].join("\n");
  // 用 base64 避免特殊字符转义问题
  const flagB64 = Buffer.from(ts).toString("base64");
  const configB64 = Buffer.from(configYaml).toString("base64");
  dockerSync(
    `exec ${appName} sh -c 'mkdir -p /app/data && echo "${flagB64}" | base64 -d > /app/data/setup-complete.flag && echo "${configB64}" | base64 -d > /app/data/config.yaml'`,
  );

  // 等待 DA 就绪（最多 30 秒）
  await waitForContainerHealthy(appName, 30);

  return {
    containerName: appName,
    pgContainerName: pgName,
    networkName: netName,
    port,
    daUrl: `http://localhost:${port}`,
  };
}

/** 轮询容器健康状态 */
async function waitForContainerHealthy(name: string, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const status = dockerSync(`inspect -f '{{.State.Health.Status}}' ${name} 2>/dev/null || echo "none"`);
      if (status === "healthy" || status === "none") {
        // "none" 表示没有定义 healthcheck，检查容器是否在运行即可
        if (status === "none") {
          const state = dockerSync(`inspect -f '{{.State.Running}}' ${name}`);
          if (state === "true") return;
        } else {
          return;
        }
      }
    } catch {
      // 容器可能还在启动
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`container ${name} not healthy within ${timeoutSec}s`);
}

/** 停止 Worker 容器栈 */
export async function stopLocalWorker(workerId: string): Promise<void> {
  const appName = safeName("da-app", workerId);
  const pgName = safeName("da-pg", workerId);
  for (const name of [appName, pgName]) {
    if (containerExists(name)) {
      await dockerAsync(`stop ${name}`);
    }
  }
}

/** 重启 Worker 容器栈 */
export async function restartLocalWorker(workerId: string): Promise<void> {
  const appName = safeName("da-app", workerId);
  const pgName = safeName("da-pg", workerId);
  for (const name of [appName, pgName]) {
    if (containerExists(name)) {
      await dockerAsync(`restart ${name}`);
    }
  }
}

/** 彻底删除 Worker 容器栈（容器 + 网络 + 卷）*/
export async function deleteLocalWorker(workerId: string): Promise<void> {
  const appName = safeName("da-app", workerId);
  const pgName = safeName("da-pg", workerId);
  const netName = safeName("da-net", workerId);
  const pgDataVolume = safeName("da-pg-data", workerId);
  const appDataVolume = safeName("da-app-data", workerId);

  // 删除容器
  for (const name of [appName, pgName]) {
    if (containerExists(name)) {
      try {
        dockerSync(`rm -f ${name}`);
      } catch {
        // 忽略
      }
    }
  }

  // 删除网络
  if (networkExists(netName)) {
    try {
      dockerSync(`network rm ${netName}`);
    } catch {
      // 忽略
    }
  }

  // 删除卷
  for (const vol of [pgDataVolume, appDataVolume]) {
    try {
      dockerSync(`volume rm ${vol}`);
    } catch {
      // 忽略（卷可能被其他容器使用）
    }
  }
}
