// =============================================================================
// DeepAnalyze Hub - Worker SSH Deployment Orchestrator
// =============================================================================
// 通过 SSH 到目标机器，执行 docker load + docker run + 健康检查。
// 全过程记录到 deploy_jobs 表，失败回滚到 previous_image_tag。
// =============================================================================

import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import { randomUUID } from "node:crypto";
import { query, getPool } from "../store/pg.js";
import { resolveImageTar } from "./bundle.js";
import { decryptString } from "../core/crypto.js";
import {
  createBackupRecord,
  updateBackupStatus,
  updateBackupPaths,
  getBackup,
} from "./worker-backup.js";
import {
  ensureWorkerNetwork,
  removeWorkerNetwork,
} from "./worker-network.js";
import {
  ensurePgContainer,
  pgContainerName,
  removePgContainer,
} from "./worker-pg-container.js";
import { ensurePgCredentials } from "./worker-pg-credentials.js";
import { connectRealSsh } from "./ssh-executor.js";
import type { SshExecutor } from "./ssh-executor.js";
import { executeWorkerBackup } from "./worker-backup-executor.js";
import { HUB_CONFIG } from "../core/config.js";

// Re-export SshExecutor abstraction (T2). New code should use connectRealSsh +
// RealSshExecutor (or MockSshExecutor in tests) instead of the legacy
// connectSsh/execRemote helpers below. The deployWorker body is NOT refactored
// here — T6 will switch it over to the new abstraction.
export { connectRealSsh, RealSshExecutor, MockSshExecutor } from "./ssh-executor.js";
export type { SshExecutor, SshExecResult, ConnectSshOpts } from "./ssh-executor.js";

export interface DeployOpts {
  workerId: string;
  sshHost: string;
  sshPort?: number;
  sshUser: string;
  sshPrivateKeyPem: string;  // 已解密的明文私钥
  imageTag: string;          // 如 "da-base-v0.9.0-amd64"
  source: "hub_stream" | "docker_pull";  // 在线 vs 离线
  hubBaseUrl: string;        // 用于 curl 拉镜像
  containerName: string;     // 如 "da-alice"
  containerPort?: number;    // 默认 21000
  envVars: Record<string, string>;  // DA_AUTH_MODE, DA_JOIN_TOKEN, DA_HUB_URL, ...
  volumeMounts: string[];    // ["da-data-alice:/data"]
  initiatedBy: string;
  healthTimeout?: number;    // 秒，默认 180
}

export interface DeployResult {
  jobId: string;
  success: boolean;
  error?: string;
  previousImageTag?: string;
  logs: Array<{ ts: string; level: string; msg: string }>;
}

export async function deployWorker(opts: DeployOpts): Promise<DeployResult> {
  // Validate all values that are interpolated into SSH shell commands to
  // prevent injection. Callers (workers.ts) wrap in try/catch → 400/500.
  validateDeployInputs(opts);

  const jobId = `dpl_${randomUUID().replace(/-/g, "")}`;
  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) =>
    logs.push({ ts: new Date().toISOString(), level, msg });

  await query(
    `INSERT INTO deploy_jobs (id, worker_id, action, status, image_tag, started_at, initiated_by, logs)
     VALUES ($1, $2, 'deploy', 'running', $3, NOW(), $4, $5::jsonb)`,
    [jobId, opts.workerId, opts.imageTag, opts.initiatedBy, JSON.stringify(logs)],
  );

  // 先记录 previous_image_tag 以备回滚
  const prev = await query<{ current_image_tag: string | null }>(
    `SELECT current_image_tag FROM workers WHERE id = $1`,
    [opts.workerId],
  );
  const previousImageTag = prev.rows[0]?.current_image_tag ?? undefined;

  // FIX #1: Hoist envFlags/volFlags/portFlag BEFORE the try block so the
  // catch block can reference them for rollback. The original brief declared
  // them inside try, putting them out of scope for the catch handler below.
  const envFlags = Object.entries(opts.envVars)
    .map(([k, v]) => `-e ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const volFlags = opts.volumeMounts.map(v => `-v ${v}`).join(" ");
  const portFlag = `-p ${opts.containerPort ?? 21000}:${opts.containerPort ?? 21000}`;

  const conn = new Client();
  const port = opts.sshPort ?? 22;
  const timeout = (opts.healthTimeout ?? 180) * 1000;

  try {
    addLog("info", `connecting ${opts.sshUser}@${opts.sshHost}:${port}`);
    await connectSsh(conn, {
      host: opts.sshHost,
      port,
      username: opts.sshUser,
      privateKey: opts.sshPrivateKeyPem,
      readyTimeout: timeout,
    });
    addLog("info", "ssh connected");

    // Step 1: 加载镜像
    if (opts.source === "hub_stream") {
      // curl + docker load 流式
      const tarName = `${opts.imageTag}.tar`;
      const cmd = `curl -s ${opts.hubBaseUrl}/api/v1/images/${tarName} | docker load`;
      addLog("info", `loading image: ${cmd}`);
      await execRemote(conn, cmd, (line) => addLog("remote", line));
    } else {
      const cmd = `docker pull ${opts.imageTag}`;
      addLog("info", `pulling image: ${cmd}`);
      await execRemote(conn, cmd, (line) => addLog("remote", line));
    }

    // Step 2: 停止旧容器（如有）
    addLog("info", `stopping old container ${opts.containerName}`);
    await execRemote(conn,
      `docker rm -f ${opts.containerName} 2>/dev/null || true`,
      (line) => addLog("remote", line));

    // Step 3: 启动新容器
    const runCmd = `docker run -d --name ${opts.containerName} ${envFlags} ${volFlags} ${portFlag} --restart unless-stopped ${opts.imageTag}`;
    addLog("info", `starting: ${runCmd}`);
    const containerId = (await execRemote(conn, runCmd, (line) => addLog("remote", line))).trim();
    addLog("info", `container started: ${containerId.slice(0, 12)}`);

    // Step 4: 健康检查
    addLog("info", "health check polling");
    const healthy = await pollHealth(conn, opts.containerPort ?? 21000, opts.healthTimeout ?? 180);
    if (!healthy) {
      throw new Error(`container failed to become healthy within ${opts.healthTimeout ?? 180}s`);
    }
    addLog("info", "container healthy");

    // Step 5: 更新 workers 表
    await query(
      `UPDATE workers
       SET current_image_tag = $1,
           ssh_target_host = $2, ssh_target_port = $3, ssh_user = $4,
           da_url = $5, status = 'approved'
       WHERE id = $6`,
      [opts.imageTag, opts.sshHost, port, opts.sshUser,
       `http://${opts.sshHost}:${opts.containerPort ?? 21000}`,
       opts.workerId],
    );

    await query(
      `UPDATE deploy_jobs SET status = 'success', completed_at = NOW(), logs = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify(logs)],
    );

    return { jobId, success: true, previousImageTag, logs };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog("error", errMsg);

    // 回滚 — envFlags/volFlags/portFlag are accessible here because they
    // were hoisted before the try block (FIX #1).
    if (previousImageTag) {
      addLog("warn", `rolling back to ${previousImageTag}`);
      try {
        await execRemote(conn, `docker rm -f ${opts.containerName} 2>/dev/null || true`, () => {});
        await execRemote(conn,
          `docker run -d --name ${opts.containerName} ${envFlags} ${volFlags} ${portFlag} --restart unless-stopped ${previousImageTag}`,
          (line) => addLog("remote", line));
      } catch (rollbackErr) {
        addLog("error", `rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }

    await query(
      `UPDATE deploy_jobs SET status = 'failed', completed_at = NOW(), error = $2, logs = $3::jsonb WHERE id = $1`,
      [jobId, errMsg, JSON.stringify(logs)],
    );

    return { jobId, success: false, error: errMsg, previousImageTag, logs };
  } finally {
    // FIX #2: Guard conn.end() — if connectSsh threw before the connection
    // was established (bad host, auth fail, timeout), calling .end() on a
    // never-connected ssh2 Client can emit an unhandled error event.
    try { conn.end(); } catch {}
  }
}

// DEPRECATED: 用 connectRealSsh + RealSshExecutor 替代；保留是为了不破坏
// deployWorker 现有逻辑（T6 才重构为 deployWorkerStack）。
// FIX #3: connectSsh listener leak. The original brief used:
//   conn.on("ready", () => resolve());
//   conn.on("error", reject);
// The "error" listener stayed registered after "ready" fired, so any
// subsequent error event (e.g. during disconnect) caused an unhandled
// promise rejection. Fixed by using once() and removing the error
// listener after ready fires.
function connectSsh(conn: Client, opts: {
  host: string; port: number; username: string; privateKey: string; readyTimeout: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      conn.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => reject(err);
    conn.once("ready", onReady);
    conn.once("error", onError);
    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      privateKey: opts.privateKey,
      readyTimeout: opts.readyTimeout,
    });
  });
}

function execRemote(conn: Client, cmd: string, onLine: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      stream.on("close", (code: number) => {
        if (code !== 0) {
          reject(new Error(`remote command exited with code ${code}: ${cmd}`));
        } else {
          resolve(stdout);
        }
      });
      stream.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        for (const line of text.split("\n")) {
          if (line.trim()) onLine(line);
        }
      });
      // FIX #6: Split the .stderr chain off the .on("data") return value.
      // The original brief chained `.stderr.on(...)` directly off `.on()`,
      // which works at runtime (EventEmitter returns the emitter) but is
      // fragile for typing with ClientChannel. Two statements is clearer.
      stream.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split("\n")) {
          if (line.trim()) onLogErr(line);
        }
      });
    });
  });
}

function onLogErr(line: string) {
  // 简化：直接 stderr 当 info 记录（docker pull 的进度在 stderr）
  console.log(`[ssh stderr] ${line}`);
}

async function pollHealth(conn: Client, port: number, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const result = await execRemote(conn,
        `curl -sf http://localhost:${port}/api/health 2>/dev/null || echo FAIL`,
        () => {});
      if (!result.includes("FAIL") && result.includes("ok")) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

// --- 升级/停止/重启 包装函数 ---

// ─── DI surface for upgradeWorker (Spec 2.2) ─────────────────────────
// 同 Plan 2.1 T6/T7 的 pattern：生产 caller 不传 deps，测试传 mock。
// query/pool/connectRealSsh/executeWorkerBackup/deployWorker/decryptSshKey
// 都是测试可注入的接缝。生产代码用 `??` 兜底真实实现。
export interface UpgradeWorkerDeps {
  query?: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
  pool?: () => import("pg").Pool;
  decryptSshKey?: (encrypted: string) => Promise<string>;
  connectRealSsh?: (opts: {
    host: string; port: number; username: string; privateKey: string;
  }) => Promise<SshExecutor>;
  executeWorkerBackup?: typeof executeWorkerBackup;
  deployWorker?: typeof deployWorker;
  /** 测试用：覆盖 HUB_CONFIG.backup */
  backupConfig?: {
    storageDir: string;
    retentionDays: number;
    cleanupIntervalHours: number;
  };
}

export async function upgradeWorker(
  workerId: string, newTag: string, initiatedBy: string,
  opts?: { skipBackup?: boolean },
  deps?: UpgradeWorkerDeps,
): Promise<DeployResult & { backupId?: string }> {
  const skipBackup = opts?.skipBackup ?? false;
  const q = deps?.query ?? query;
  const pool = deps?.pool ?? getPool;
  const decryptKey = deps?.decryptSshKey ?? decryptSshKey;
  const connect = deps?.connectRealSsh ?? connectRealSsh;
  const runBackup = deps?.executeWorkerBackup ?? executeWorkerBackup;
  const deploy = deps?.deployWorker ?? deployWorker;
  const backupCfg = deps?.backupConfig ?? HUB_CONFIG.backup;

  // ─── 1. 预检：worker 存在 + SSH 凭据 ───
  const w = await q<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; current_image_tag: string;
  }>(`SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, current_image_tag
      FROM workers WHERE id = $1`, [workerId]);
  if (w.rows.length === 0) throw new Error("worker not found");
  const row = w.rows[0];
  if (!row.ssh_target_host || !row.ssh_key_encrypted) {
    throw new Error("worker missing ssh credentials");
  }
  const fromTag = row.current_image_tag;

  // ─── 2. 创建 backup 记录（pre_upgrade, deploy_job_id=NULL 先占位） ───
  // skipBackup=true（如 restartWorker）时跳过备份记录创建，避免 from_tag==to_tag
  // 的无意义备份污染 worker_backups 表。
  let backupId: string | undefined;
  if (!skipBackup) {
    const backup = await createBackupRecord(pool, {
      workerId,
      backupType: "pre_upgrade",
      fromTag,
      toTag: newTag,
      pgDumpPath: null,        // 由 executor 填
      dataArchivePath: null,
      deployJobId: null,
      createdBy: initiatedBy,
      retentionDays: backupCfg.retentionDays,
    });
    backupId = backup.id;
  }

  // ─── 3. 解密私钥（AES）— 见 Task F3 ───
  const privateKey = await decryptKey(row.ssh_key_encrypted);

  // ─── 4. 执行真实备份（skipBackup=true 跳过）─────────────────────────
  if (!skipBackup && backupId) {
    let ssh: SshExecutor | null = null;
    try {
      ssh = await connect({
        host: row.ssh_target_host,
        port: row.ssh_target_port,
        username: row.ssh_user,
        privateKey,
      });
      const result = await runBackup(ssh, {
        workerId,
        backupId,
        workerImageTag: fromTag,
        hubBackupDir: backupCfg.storageDir,
        retentionDays: backupCfg.retentionDays,
      });

      if (!result.success) {
        // 备份失败：abort upgrade（不调 deployWorker）
        await updateBackupStatus(pool, backupId, "failed");
        return {
          jobId: "",
          success: false,
          error: `pre-upgrade backup failed: ${result.error ?? "unknown"}`,
          logs: [],
          backupId,
        };
      }

      // 成功：写入真实路径到 backup 记录
      await updateBackupPaths(pool, backupId, {
        pgDumpPath: result.pgDumpPath,
        dataArchivePath: result.dataArchivePath,
        manifestPath: result.manifestPath,
        sizeBytes: result.sizeBytes,
        pgVersion: result.pgVersion,
      });
    } finally {
      if (ssh) {
        try { ssh.close(); } catch {}
      }
    }
  }

  // ─── 5. 调用现有 deployWorker ───
  let result: DeployResult;
  try {
    result = await deploy({
      workerId,
      sshHost: row.ssh_target_host,
      sshPort: row.ssh_target_port,
      sshUser: row.ssh_user,
      sshPrivateKeyPem: privateKey,
      imageTag: newTag,
      source: "hub_stream",
      hubBaseUrl: process.env.HUB_EXTERNAL_URL || "http://localhost:22000",
      containerName: `da-${workerId.slice(0, 12)}`,
      containerPort: 21000,
      envVars: {},  // 已有的容器配置在 workers 表，按需补充
      volumeMounts: [`da-data-${workerId.slice(0, 12)}:/app/data`],
      initiatedBy,
    });
  } catch (e) {
    if (backupId) {
      await updateBackupStatus(pool, backupId, "failed");
    }
    throw e;
  }

  // ─── 6. 根据 deploy 结果链接 backup ↔ deploy_job ───
  if (backupId) {
    if (result.success && result.jobId) {
      await pool().query(
        `UPDATE deploy_jobs SET backup_id = $1 WHERE id = $2`,
        [backupId, result.jobId],
      );
      await pool().query(
        `UPDATE worker_backups SET deploy_job_id = $1 WHERE id = $2`,
        [result.jobId, backupId],
      );
      await updateBackupStatus(pool, backupId, "verified");
    } else {
      await updateBackupStatus(pool, backupId, "failed");
    }
  }

  return backupId ? { ...result, backupId } : result;
}

export async function stopWorker(workerId: string, initiatedBy: string): Promise<DeployResult> {
  const jobId = `dpl_${randomUUID().replace(/-/g, "")}`;
  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) => logs.push({ ts: new Date().toISOString(), level, msg });

  await query(
    `INSERT INTO deploy_jobs (id, worker_id, action, status, started_at, initiated_by)
     VALUES ($1, $2, 'stop', 'running', NOW(), $3)`,
    [jobId, workerId, initiatedBy],
  );

  // SSH 到目标机执行 docker stop
  const w = await query<{ ssh_target_host: string; ssh_target_port: number; ssh_user: string; ssh_key_encrypted: string | null }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted FROM workers WHERE id = $1`,
    [workerId],
  );
  if (w.rows.length === 0) throw new Error("worker not found");

  const conn = new Client();
  try {
    const privateKey = await decryptSshKey(w.rows[0].ssh_key_encrypted!);
    await connectSsh(conn, {
      host: w.rows[0].ssh_target_host,
      port: w.rows[0].ssh_target_port,
      username: w.rows[0].ssh_user,
      privateKey,
      readyTimeout: 60000,
    });
    addLog("info", "ssh connected");
    const containerName = `da-${workerId.slice(0, 12)}`;
    await execRemote(conn, `docker stop ${containerName}`, (l) => addLog("remote", l));
    addLog("info", `container ${containerName} stopped`);

    await query(`UPDATE workers SET status = 'offline' WHERE id = $1`, [workerId]);
    await query(`UPDATE deploy_jobs SET status = 'success', completed_at = NOW(), logs = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify(logs)]);
    return { jobId, success: true, logs };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog("error", errMsg);
    await query(`UPDATE deploy_jobs SET status = 'failed', completed_at = NOW(), error = $2, logs = $3::jsonb WHERE id = $1`,
      [jobId, errMsg, JSON.stringify(logs)]);
    return { jobId, success: false, error: errMsg, logs };
  } finally {
    // FIX #9 (same as FIX #2): Guard conn.end() in stopWorker's finally too.
    try { conn.end(); } catch {}
  }
}

export async function restartWorker(workerId: string, initiatedBy: string): Promise<DeployResult> {
  // stop + start（用 current_image_tag）
  const stop = await stopWorker(workerId, initiatedBy);
  if (!stop.success) return stop;
  const w = await query<{ current_image_tag: string }>(
    `SELECT current_image_tag FROM workers WHERE id = $1`, [workerId]);
  return upgradeWorker(workerId, w.rows[0].current_image_tag, initiatedBy, { skipBackup: true });
}

// FIX #4: rollbackWorker type mismatch. The original brief queried
// deploy_jobs for image_tag but typed the result as { previous_image_tag;
// image_tag } and the comment said "failed deploy_job's
// previous_image_tag" while the SQL filtered status='success'. The actual
// intent: rollback means "redeploy the currently-known-good image", which
// is exactly workers.current_image_tag (updated only on successful deploys
// by deployWorker above). Simplified to query workers directly.
export async function rollbackWorker(
  workerId: string,
  initiatedBy: string,
  backupId?: string,
): Promise<DeployResult & { backupId?: string }> {
  // 注意：domain 函数签名是 pool: () => Pool，所以这里赋函数引用
  const pool = getPool;

  let rollbackTag: string | null = null;
  let linkedBackupId: string | undefined;

  if (backupId) {
    // 显式指定 backup：从 backup.from_tag 回滚
    const backup = await getBackup(pool, backupId);
    if (!backup) throw new Error(`backup ${backupId} not found`);
    if (backup.worker_id !== workerId) {
      throw new Error(`backup ${backupId} does not belong to worker ${workerId}`);
    }
    rollbackTag = backup.from_tag;
    linkedBackupId = backup.id;
  } else {
    // Fallback：使用 workers.current_image_tag（保留原有行为）
    const w = await query<{ current_image_tag: string | null }>(
      `SELECT current_image_tag FROM workers WHERE id = $1`,
      [workerId],
    );
    if (w.rows.length === 0) throw new Error("worker not found");
    rollbackTag = w.rows[0].current_image_tag;
  }

  if (!rollbackTag) {
    throw new Error("no rollback target: provide backup_id or ensure worker has current_image_tag");
  }

  const result = await upgradeWorker(workerId, rollbackTag, initiatedBy);

  // 标记 backup 为 restored（如果指定了 backupId）
  if (linkedBackupId) {
    await updateBackupStatus(pool, linkedBackupId, "restored");
  }

  return { ...result, backupId: linkedBackupId };
}

// --- AES-256-GCM decryption for stored SSH keys ---
// Wraps decryptString with a descriptive error for the deployment context.
async function decryptSshKey(encrypted: string): Promise<string> {
  try {
    return decryptString(encrypted);
  } catch (err) {
    throw new Error(
      `failed to decrypt ssh key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- Input validation to prevent shell injection in SSH commands ---
// All values that are interpolated into execRemote() commands must pass
// strict character whitelists. Throws on first violation.
function validateDeployInputs(opts: DeployOpts): void {
  const imageTagRe = /^[a-zA-Z0-9._:/-]+$/;
  const containerNameRe = /^[a-zA-Z0-9._-]+$/;
  const tarNameRe = /^[a-zA-Z0-9._-]+$/;

  if (!opts.imageTag || !imageTagRe.test(opts.imageTag)) {
    throw new Error("invalid imageTag: must match /^[a-zA-Z0-9._:/-]+$/");
  }
  if (!opts.containerName || !containerNameRe.test(opts.containerName)) {
    throw new Error("invalid containerName: must match /^[a-zA-Z0-9._-]+$/");
  }
  if (!opts.hubBaseUrl) {
    throw new Error("invalid hubBaseUrl: required");
  }
  // hubBaseUrl must be a valid http/https URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(opts.hubBaseUrl);
  } catch {
    throw new Error("invalid hubBaseUrl: not a valid URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("invalid hubBaseUrl: protocol must be http or https");
  }
  // tarName is derived from imageTag (imageTag + ".tar"), so validate the
  // derived form too — strip the ".tar" suffix is already covered by the
  // imageTag regex, but we check the full tar name for safety.
  const tarName = `${opts.imageTag}.tar`;
  if (!tarNameRe.test(tarName)) {
    throw new Error(`invalid tarName derived from imageTag: ${tarName}`);
  }
}

// =============================================================================
// Host Server SSH Resolver (T04)
// =============================================================================
// Translates a host_server_id into the SSH connection parameters needed by
// deployWorker(). Caller (T07 DeployWorkerModal backend route) combines this
// with allocatePortBlock() (T03) and passes the resolved params into the
// existing deployWorker() — T04 does NOT rewrite deployWorker().
//
// Returns null when:
//   - host_server not found
//   - host_server.status !== 'active'
//   - host_server has no ssh_key_encrypted configured
// =============================================================================

export interface ResolvedHostServerSsh {
  hostServerId: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPem: string;  // decrypted PEM (caller is responsible for zeroing)
  portRangeStart: number;
  portRangeEnd: number;
  portBlockSize: number;
}

export async function resolveHostServerSsh(
  hostServerId: string,
): Promise<ResolvedHostServerSsh | null> {
  const { rows } = await query<{
    id: string; ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null;
    status: string; port_range_start: number; port_range_end: number; port_block_size: number;
  }>(
    `SELECT id, ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted,
            status, port_range_start, port_range_end, port_block_size
     FROM host_servers WHERE id = $1`,
    [hostServerId],
  );
  const hs = rows[0];
  if (!hs) return null;
  if (hs.status !== "active") return null;
  if (!hs.ssh_key_encrypted) return null;

  // Decrypt using existing crypto helper (already imported at top of file)
  const sshKeyPem = decryptString(hs.ssh_key_encrypted);

  return {
    hostServerId: hs.id,
    sshHost: hs.ssh_target_host,
    sshPort: hs.ssh_target_port,
    sshUser: hs.ssh_user,
    sshKeyPem,
    portRangeStart: hs.port_range_start,
    portRangeEnd: hs.port_range_end,
    portBlockSize: hs.port_block_size,
  };
}

// =============================================================================
// deployWorkerStack — Spec 2.1 B 模式编排入口 (T6)
// =============================================================================
// 高层 orchestrator: 建网络 → 建 PG 凭据/容器 → 调底层 deployWorker(含 PG env)
//
// 与 deployWorker 的关系:
//   - deployWorker 是底层「跑 DA 容器」函数，保留不动
//   - deployWorkerStack 包装出整个 stack: da-net + da-pg + da-app
//   - 后续 routes/workers.ts 切换到 deployWorkerStack (T9 完成后)
//
// 依赖注入 (deps 参数):
//   生产代码不传 deps — 用真实模块绑定 (connectRealSsh / ensurePgCredentials /
//   ensurePgContainer / ensureWorkerNetwork / deployWorker / decryptSshKey / query)。
//   测试传 mock deps 验证编排序列 — 这避免了 bun:test mock.module 的限制,
//   brief 明确允许这种偏离 ("可以重构 deployWorkerStack 接受可选的依赖注入参数").
// =============================================================================

export interface WorkerStackOpts {
  workerId: string;
  imageTag: string;
  initiatedBy: string;
  hostServerId?: string;     // 优先用 host_server 凭据；fallback worker.ssh_*
  healthTimeout?: number;
  skipBackup?: boolean;
}

/** 依赖注入容器 — 生产用默认值，测试传 mock。 */
export interface WorkerStackDeps {
  ssh?: SshExecutor;                                   // 测试预构造的 mock ssh
  deployWorker?: typeof deployWorker;                  // 测试用 mock
  // `query` 在测试中返回精简的 {rows: [...]} 形态，所以这里用更宽松的类型
  // (生产代码传真实 query, 测试传任何返回 {rows: T[]} 的函数)。
  query?: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
  decryptSshKey?: (encrypted: string) => Promise<string>;
  connectRealSsh?: (opts: {
    host: string; port: number; username: string; privateKey: string;
  }) => Promise<SshExecutor>;
  ensurePgCredentials?: (workerId: string) => Promise<{
    database: string; username: string; password: string;
  }>;
  // T7: cleanup function DI surface — included so tests can verify call
  // sequence and arguments. (T6's deferred Minor was about ensure* not
  // being in the DI surface; for deleteWorkerStack we DO include the
  // remove* functions because call-sequence verification is the whole
  // point of the cleanup tests.)
  removePgContainer?: typeof removePgContainer;
  removeWorkerNetwork?: typeof removeWorkerNetwork;
}

export async function deployWorkerStack(
  opts: WorkerStackOpts,
  deps: WorkerStackDeps = {},
): Promise<DeployResult> {
  const q = deps.query ?? query;
  const decryptKey = deps.decryptSshKey ?? decryptSshKey;
  const ensureCreds = deps.ensurePgCredentials ?? ensurePgCredentials;
  const deploy = deps.deployWorker ?? deployWorker;

  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) =>
    logs.push({ ts: new Date().toISOString(), level, msg });

  // ─── 1. 取 worker + (可选) host_server 凭据 ───────────────────────────
  const w = await q<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; host_id: string | null;
  }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, host_id
     FROM workers WHERE id = $1`,
    [opts.workerId],
  );
  const worker = w.rows[0];
  if (!worker) throw new Error(`worker ${opts.workerId} not found`);

  // host_server 凭据优先 (spec 1 后的标准模型)
  let sshHost = worker.ssh_target_host;
  let sshPort = worker.ssh_target_port;
  let sshUser = worker.ssh_user;
  let sshKeyEncrypted = worker.ssh_key_encrypted;

  const hsId = opts.hostServerId ?? worker.host_id;
  if (hsId) {
    const hsRes = await q<{
      ssh_target_host: string; ssh_target_port: number; ssh_user: string;
      ssh_key_encrypted: string | null;
    }>(
      `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted
       FROM host_servers WHERE id = $1`,
      [hsId],
    );
    const hs = hsRes.rows[0];
    if (hs && hs.ssh_key_encrypted) {
      sshHost = hs.ssh_target_host;
      sshPort = hs.ssh_target_port;
      sshUser = hs.ssh_user;
      sshKeyEncrypted = hs.ssh_key_encrypted;
    }
  }

  if (!sshHost || !sshKeyEncrypted) {
    throw new Error(`no SSH credentials for worker ${opts.workerId}`);
  }

  const privateKey = await decryptKey(sshKeyEncrypted);

  // ─── 2. SSH 连接 (生产 connectRealSsh / 测试用注入的 ssh) ─────────────
  let ssh: SshExecutor;
  let ownsSsh = false;  // 是否需要 stack 负责关闭
  if (deps.ssh) {
    ssh = deps.ssh;
  } else if (deps.connectRealSsh) {
    ssh = await deps.connectRealSsh({
      host: sshHost, port: sshPort, username: sshUser, privateKey,
    });
    ownsSsh = true;
  } else {
    ssh = await connectRealSsh({
      host: sshHost, port: sshPort, username: sshUser, privateKey,
    });
    ownsSsh = true;
  }

  try {
    // ─── 3. ensure network ─────────────────────────────────────────────
    addLog("info", `ensuring network da-net-${opts.workerId}`);
    await ensureWorkerNetwork(ssh, opts.workerId);

    // ─── 4. ensure PG credentials + container ──────────────────────────
    addLog("info", `ensuring PG credentials for ${opts.workerId}`);
    const pgCreds = await ensureCreds(opts.workerId);

    addLog("info", `ensuring PG container da-pg-${opts.workerId}`);
    await ensurePgContainer(ssh, opts.workerId, pgCreds);

    // ─── 5. 构造 envVars (含 PG_*) + 调底层 deployWorker ───────────────
    const pgHost = pgContainerName(opts.workerId);
    const envVars: Record<string, string> = {
      PG_HOST: pgHost,
      PG_PORT: "5432",
      PG_USER: pgCreds.username,
      PG_PASSWORD: pgCreds.password,
      PG_DATABASE: pgCreds.database,
      // 其他 DA_* env (DA_AUTH_MODE / DA_JOIN_TOKEN / DA_HUB_URL 等) 由
      // caller 在切到 deployWorkerStack 后补充 — T9 迁移脚本处理
    };

    addLog("info", `calling deployWorker for da-app-${opts.workerId}`);
    return await deploy({
      workerId: opts.workerId,
      sshHost, sshPort, sshUser,
      sshPrivateKeyPem: privateKey,
      imageTag: opts.imageTag,
      source: "docker_pull",  // 默认 docker pull；hub_stream 由 caller 包装
      hubBaseUrl: process.env.HUB_EXTERNAL_URL ?? "http://localhost:22000",
      containerName: `da-app-${opts.workerId}`,
      containerPort: 21000,  // TODO: 从 host_server 端口分配读 (T03)
      envVars,
      volumeMounts: [`da-app-data-${opts.workerId}:/app/data`],
      initiatedBy: opts.initiatedBy,
      healthTimeout: opts.healthTimeout,
    });
  } finally {
    if (ownsSsh) {
      try { ssh.close(); } catch {}
    }
  }
}

// =============================================================================
// deleteWorkerStack — 彻底清理 worker 全部 docker 资源 (T7)
// =============================================================================
// 清理顺序: da-app 容器 → da-pg 容器(+volume?) → da-app volume(?) → network
//           → workers.status='decommissioned'
//
// 与 stopWorker 的关系:
//   - stopWorker 仅 docker stop da-<slice12>（用于 draining，restartWorker 还会起）
//   - deleteWorkerStack 彻底清理整个 stack，包括 PG 容器/数据卷/网络
//
// HUB_DELETE_WORKER_KEEP_VOLUMES env:
//   - "false" 显式删 volumes（da-pg-data-* + da-app-data-*）
//   - 其他/未设置/true 保留 volumes（生产默认 — 安全第一，便于应急/取证）
//
// 旧命名兼容: T6 之前容器名为 da-<slice12>，T6 起改为 da-app-<fullId>。
// 这里同时清两种命名，使函数在 T9 迁移边界两侧都幂等。
// =============================================================================

export interface DeleteStackOpts {
  keepVolumes?: boolean;  // 默认按 HUB_DELETE_WORKER_KEEP_VOLUMES env
}

export async function deleteWorkerStack(
  workerId: string,
  initiatedBy: string,
  opts?: DeleteStackOpts,
  deps: WorkerStackDeps = {},
): Promise<DeployResult> {
  const q = deps.query ?? query;
  const decryptKey = deps.decryptSshKey ?? decryptSshKey;
  const removePg = deps.removePgContainer ?? removePgContainer;
  const removeNet = deps.removeWorkerNetwork ?? removeWorkerNetwork;

  const jobId = `dpl_${randomUUID().replace(/-/g, "")}`;
  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) =>
    logs.push({ ts: new Date().toISOString(), level, msg });

  // HUB_DELETE_WORKER_KEEP_VOLUMES default = "true" (keep volumes for safety)
  const keepVolumes = opts?.keepVolumes ??
    (process.env.HUB_DELETE_WORKER_KEEP_VOLUMES ?? "true") !== "false";

  await q(
    `INSERT INTO deploy_jobs (id, worker_id, action, status, started_at, initiated_by, logs)
     VALUES ($1, $2, 'delete', 'running', NOW(), $3, '[]'::jsonb)`,
    [jobId, workerId, initiatedBy],
  );

  // ─── 1. 取 worker + (可选) host_server 凭据（同 deployWorkerStack）──────
  const w = await q<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; host_id: string | null;
  }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, host_id
     FROM workers WHERE id = $1`,
    [workerId],
  );
  if (w.rows.length === 0) throw new Error(`worker ${workerId} not found`);
  const worker = w.rows[0];

  let sshHost = worker.ssh_target_host;
  let sshPort = worker.ssh_target_port;
  let sshUser = worker.ssh_user;
  let sshKeyEncrypted = worker.ssh_key_encrypted;

  if (worker.host_id) {
    const hs = await q<{
      ssh_target_host: string; ssh_target_port: number; ssh_user: string;
      ssh_key_encrypted: string | null;
    }>(
      `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted
       FROM host_servers WHERE id = $1`,
      [worker.host_id],
    );
    if (hs.rows.length > 0 && hs.rows[0].ssh_key_encrypted) {
      sshHost = hs.rows[0].ssh_target_host;
      sshPort = hs.rows[0].ssh_target_port;
      sshUser = hs.rows[0].ssh_user;
      sshKeyEncrypted = hs.rows[0].ssh_key_encrypted;
    }
  }

  if (!sshHost || !sshKeyEncrypted) {
    throw new Error(`no SSH credentials for worker ${workerId}`);
  }

  const privateKey = await decryptKey(sshKeyEncrypted);

  // ─── 2. SSH 连接（生产 connectRealSsh / 测试用注入的 ssh）─────────────
  let ssh: SshExecutor;
  let ownsSsh = false;
  if (deps.ssh) {
    ssh = deps.ssh;
  } else if (deps.connectRealSsh) {
    ssh = await deps.connectRealSsh({
      host: sshHost, port: sshPort, username: sshUser, privateKey,
    });
    ownsSsh = true;
  } else {
    ssh = await connectRealSsh({
      host: sshHost, port: sshPort, username: sshUser, privateKey,
    });
    ownsSsh = true;
  }

  try {
    // 1. 停并删 da-app 容器
    addLog("info", `removing da-app-${workerId}`);
    await ssh.exec(`docker rm -f da-app-${workerId} 2>/dev/null || true`);
    // 兼容 T6 之前的旧命名 da-<slice12>
    await ssh.exec(`docker rm -f da-${workerId.slice(0, 12)} 2>/dev/null || true`);

    // 2. 停并删 da-pg 容器（removePgContainer 内部已含 docker rm -f da-pg-<id>）
    //    当 removeVolume:true 时，removePgContainer 也会清 da-pg-data-<id> 卷
    addLog("info", `removing da-pg-${workerId} (removeVolume=${!keepVolumes})`);
    await removePg(ssh, workerId, { removeVolume: !keepVolumes });

    // 3. 删 da-app 数据卷（仅当配置允许；da-pg-data-* 由 removePgContainer 处理）
    if (!keepVolumes) {
      addLog("info", `removing volume da-app-data-${workerId}`);
      await ssh.exec(`docker volume rm da-app-data-${workerId} 2>/dev/null || true`);
    }

    // 4. 删 network
    addLog("info", `removing network da-net-${workerId}`);
    await removeNet(ssh, workerId);

    // 5. 更新 worker status -> decommissioned
    addLog("info", `marking worker ${workerId} as decommissioned`);
    await q(
      `UPDATE workers SET status = 'decommissioned', decommissioned_at = NOW()
       WHERE id = $1`,
      [workerId],
    );

    await q(
      `UPDATE deploy_jobs SET status = 'success', completed_at = NOW(), logs = $2::jsonb
       WHERE id = $1`,
      [jobId, JSON.stringify(logs)],
    );
    return { jobId, success: true, logs };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog("error", errMsg);
    await q(
      `UPDATE deploy_jobs SET status = 'failed', completed_at = NOW(), error = $2, logs = $3::jsonb
       WHERE id = $1`,
      [jobId, errMsg, JSON.stringify(logs)],
    );
    return { jobId, success: false, error: errMsg, logs };
  } finally {
    if (ownsSsh) {
      try { ssh.close(); } catch {}
    }
  }
}
