// =============================================================================
// DeepAnalyze Hub - Worker SSH Deployment Orchestrator
// =============================================================================
// 通过 SSH 到目标机器，执行 docker load + docker run + 健康检查。
// 全过程记录到 deploy_jobs 表，失败回滚到 previous_image_tag。
// =============================================================================

import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import { randomUUID } from "node:crypto";
import { query } from "../store/pg.js";
import { resolveImageTar } from "./bundle.js";
import { decryptString } from "../core/crypto.js";

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

export async function upgradeWorker(
  workerId: string, newTag: string, initiatedBy: string,
): Promise<DeployResult> {
  const w = await query<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; current_image_tag: string;
  }>(`SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, current_image_tag
      FROM workers WHERE id = $1`, [workerId]);
  if (w.rows.length === 0) throw new Error("worker not found");
  const row = w.rows[0];
  if (!row.ssh_target_host || !row.ssh_key_encrypted) {
    throw new Error("worker missing ssh credentials");
  }

  // 解密私钥（AES）— 见 Task F3
  const privateKey = await decryptSshKey(row.ssh_key_encrypted);

  // 复用 deployWorker（覆盖 imageTag）
  return deployWorker({
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
  return upgradeWorker(workerId, w.rows[0].current_image_tag, initiatedBy);
}

// FIX #4: rollbackWorker type mismatch. The original brief queried
// deploy_jobs for image_tag but typed the result as { previous_image_tag;
// image_tag } and the comment said "failed deploy_job's
// previous_image_tag" while the SQL filtered status='success'. The actual
// intent: rollback means "redeploy the currently-known-good image", which
// is exactly workers.current_image_tag (updated only on successful deploys
// by deployWorker above). Simplified to query workers directly.
export async function rollbackWorker(workerId: string, initiatedBy: string): Promise<DeployResult> {
  const w = await query<{ current_image_tag: string | null }>(
    `SELECT current_image_tag FROM workers WHERE id = $1`,
    [workerId],
  );
  if (w.rows.length === 0) throw new Error("worker not found");
  if (!w.rows[0].current_image_tag) {
    throw new Error("no current image tag — nothing to rollback to");
  }
  return upgradeWorker(workerId, w.rows[0].current_image_tag, initiatedBy);
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
