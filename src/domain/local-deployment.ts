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
// Worker 容器对外可达的宿主机地址（用于跨容器/跨机访问 worker，如 nanobot SSO 回跳）。
// 留空则 fallback 到 localhost（仅适合浏览器同机场景）。
const DA_HOST = process.env.HUB_DA_HOST ?? "localhost";
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

/** 检查容器是否处于运行状态（容器存在但已停止时返回 false） */
function containerRunning(name: string): boolean {
  try {
    return dockerSync(`inspect -f '{{.State.Running}}' ${name}`) === "true";
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

  // ─── 1. 如果 PG 容器已存在且健康，保留它不动（避免密码丢失问题）─────
  //    PostgreSQL 首次初始化后 POSTGRES_PASSWORD 被忽略，重建容器用新密码
  //    会导致 app 连不上旧数据。因此 PG 容器一旦创建就不再删除/重建。
  const pgAlreadyRunning = containerExists(pgName);

  // ─── 1b. 从旧 app 容器读 PG_PASSWORD（必须在删 app 容器之前）─────────
  //    如果 PG 容器已存在，必须用旧 app 容器里的密码（那个密码是实际能连上的）
  let effectivePgPassword = pgCreds.password;
  if (pgAlreadyRunning && containerExists(appName)) {
    try {
      const oldCreds = readOldPgCreds(workerId);
      if (oldCreds?.password) {
        effectivePgPassword = oldCreds.password;
      }
    } catch {
      // 读不到就用传入的密码（首次部署场景）
    }
  }

  // ─── 1c. 清理旧 app 容器（PG 容器如果存在则保留）──────────────────────
  if (containerExists(appName)) {
    try {
      dockerSync(`rm -f ${appName}`);
    } catch {
      // 忽略
    }
  }
  if (!pgAlreadyRunning) {
    // 仅首次部署时创建 PG 容器
  }

  // ─── 2. 创建网络 ──────────────────────────────────────────────────────
  if (!networkExists(netName)) {
    dockerSync(`network create ${netName}`);
  }

  // ─── 3. PG 容器：已存在则保留，不存在才创建 ──────────────────────────
  //    机器重启后，老 worker 的 PG 容器可能「存在但已停止」（旧容器没有
  //    restart 策略）。重新部署时必须先把它 start 起来，否则 app 容器起来
  //    也连不上 PG，导致部署卡在健康检查。新部署的容器已带 --restart
  //    unless-stopped，重启后会自启，此分支是给存量老容器的兜底。
  if (pgAlreadyRunning && !containerRunning(pgName)) {
    dockerSync(`start ${pgName}`);
    await waitForContainerHealthy(pgName, 30);
  }
  if (!pgAlreadyRunning) {
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
      // 机器重启后自动拉起，避免 Hub 起来但 worker 的 PG 没起导致 app 连不上。
      // 与 SSH 模式 (worker-pg-container.ts) 保持一致。
      `--restart unless-stopped`,
      PG_IMAGE,
    ].join(" ");
    dockerSync(pgArgs);

    // 等待 PG 就绪（最多 30 秒）
    await waitForContainerHealthy(pgName, 30);
  }

  // ─── 4. 创建 DA 容器（用 effectivePgPassword 保证能连上旧 PG）─────────
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
    PG_PASSWORD: effectivePgPassword,
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
    // 机器重启后自动拉起，与 SSH 模式 (worker-deployment.ts) 保持一致。
    `--restart unless-stopped`,
    imageTag,
  ].join(" ");
  dockerSync(appArgs);

  // 4b. 预置 setup-complete.flag + config.yaml（仅首次部署）
  //     重新部署时 PG 容器已存在，说明用户已有配置，不能覆盖 config.yaml！
  if (!pgAlreadyRunning) {
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
  }

  // 等待 DA 就绪（最多 30 秒）
  await waitForContainerHealthy(appName, 30);

  return {
    containerName: appName,
    pgContainerName: pgName,
    networkName: netName,
    port,
    daUrl: `http://${DA_HOST}:${port}`,
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

/**
 * 从旧 DA app 容器读取 PG 连接凭据（PG_PASSWORD 环境变量）。
 *
 * 注意：不从 PG 容器读 POSTGRES_PASSWORD，因为 PostgreSQL 首次初始化后
 * 忽略该环境变量——容器里设的可能和卷里实际密码不一致。
 * DA app 容器的 PG_PASSWORD 才是实际能连上 PG 的正确密码。
 *
 * 如果容器不存在，返回 null。
 */
export function readOldPgCreds(workerId: string): {
  database: string; username: string; password: string;
} | null {
  const appName = safeName("da-app", workerId);
  if (!containerExists(appName)) return null;
  try {
    const envJson = dockerSync(
      `inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${appName}`,
    );
    const get = (key: string): string | undefined =>
      envJson
        .split("\n")
        .find((l) => l.startsWith(`${key}=`))
        ?.slice(key.length + 1);
    const password = get("PG_PASSWORD");
    const username = get("PG_USER") ?? "deepanalyze";
    const database = get("PG_DATABASE") ?? "deepanalyze";
    if (!password) return null;
    return { database, username, password };
  } catch {
    return null;
  }
}

/**
 * 从旧 DA app 容器读取宿主机端口映射。
 */
function readPortFromContainer(workerId: string): number | null {
  const appName = safeName("da-app", workerId);
  if (!containerExists(appName)) return null;
  try {
    // 输出形如 0.0.0.0:21001->21000/tcp
    const portStr = dockerSync(
      `inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostPort}}{{end}}{{end}}' ${appName}`,
    );
    const port = parseInt(portStr.split("\n")[0], 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/**
 * 升级 local worker — 用新镜像重建容器栈，保留所有数据。
 *
 * 关键：deployLocalWorker 会 docker rm -f 旧容器，但 PG 数据卷和 app 数据卷
 * 不受影响（只删容器不删卷）。只要 PG 容器重建时挂同一个卷，数据完整保留。
 *
 * PG 密码从旧容器环境变量读回（PostgreSQL 首次初始化后 POSTGRES_PASSWORD
 * 被忽略，但 DA app 需要正确密码才能连接）。
 *
 * 端口从旧容器读回，保持对外端口不变。
 */
export async function upgradeLocalWorker(
  workerId: string,
  imageTag: string,
  envVars: Record<string, string>,
): Promise<LocalDeployResult> {
  // 1. 从旧 PG 容器读回凭据
  const oldCreds = readOldPgCreds(workerId);
  const pgCreds = oldCreds ?? {
    database: "deepanalyze",
    username: "deepanalyze",
    // 容器不存在或读不到密码时无法安全升级（密码不对会连不上旧数据）
    password: "",
  };
  if (!oldCreds) {
    throw new Error(
      `cannot read PG credentials from old container for ${workerId}; ` +
      `manual migration required`,
    );
  }

  // 2. 从旧 app 容器读回端口（保持端口不变）
  const oldPort = readPortFromContainer(workerId);
  const port = oldPort ?? allocateLocalPort();

  // 3. 复用 deployLocalWorker（它会先 docker rm -f 旧容器再重建）
  //    卷名由 safeName 生成，与初始部署完全一致 → 数据保留
  return deployLocalWorker({ workerId, port, imageTag, envVars, pgCreds });
}
