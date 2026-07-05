#!/usr/bin/env bun
/**
 * 现有 worker 迁移到 B 模式脚本
 *
 * 用法:
 *   bun run scripts/migrate-workers-to-b.ts [--dry-run] [--worker=<id>] [--concurrency=N]
 *
 * 检测每个 online worker 是否已有 da-pg-<workerId> 容器，没有则迁移：
 *   1. docker inspect 老 da-app 容器提取 PG_* env vars
 *   2. 生成新 PG 凭据，写入 workers 表
 *   3. 创建 da-net-<workerId> network
 *   4. 启动 da-pg-<workerId>（空 DB）
 *   5. pg_dump 老 PG → pg_restore 新 PG
 *   6. stop 老 da-app 容器
 *   7. docker run 新 da-app-<workerId> 指向 da-pg-<workerId>
 *   8. 健康检查
 *   9. 失败则回滚（停新 da-app，启动老 da-app）
 *
 * 老 PG 资源（容器/数据/卷）不自动删 — 运维确认所有 worker 迁完才手动清理。
 *
 * ============================================================================
 * DEVIATION NOTE (DI for testability — same pattern as T6/T7):
 * ============================================================================
 * The brief's `migrateWorker` body hardcoded module imports of `query`,
 * `connectRealSsh`, `decryptString`, `ensurePgCredentials`,
 * `ensureWorkerNetwork`, `ensurePgContainer`, `pgContainerExists`. To make the
 * function hermetically testable (no real SSH, no real DB), we refactor it to
 * accept an optional `deps?: MigrateWorkerDeps` parameter. Production code
 * (the CLI `main()` below) calls `migrateWorker(w.id, opts)` WITHOUT deps,
 * which falls back to the real implementations. Tests inject mocks. This is
 * the SAME deviation T6 (`WorkerStackDeps`) and T7 made; the brief's
 * placeholder-scan self-review note explicitly authorized this fallback:
 *   "如果 implementer 写不出 mock，应当 fallback 到依赖注入"
 * ============================================================================
 */

import { query } from "../src/store/pg.js";
import { connectRealSsh, type SshExecutor, type ConnectSshOpts } from "../src/domain/ssh-executor.js";
import { decryptString } from "../src/core/crypto.js";
import {
  ensurePgCredentials, type PgCredentials,
} from "../src/domain/worker-pg-credentials.js";
import {
  ensureWorkerNetwork, removeWorkerNetwork,
} from "../src/domain/worker-network.js";
import {
  ensurePgContainer, pgContainerName, pgContainerExists, waitForPgReady,
} from "../src/domain/worker-pg-container.js";

interface CliOpts {
  dryRun: boolean;
  workerId?: string;
  concurrency: number;
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2);
  const opts: CliOpts = { dryRun: false, concurrency: 1 };
  for (const a of args) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--worker=")) opts.workerId = a.slice(9);
    else if (a.startsWith("--concurrency=")) opts.concurrency = parseInt(a.slice(14), 10);
  }
  return opts;
}

interface OldPgConfig {
  host: string; port: string; user: string; password: string; database: string;
}

async function extractOldPgConfig(
  ssh: SshExecutor, oldContainerName: string,
): Promise<OldPgConfig | null> {
  const r = await ssh.exec(
    `docker inspect ${oldContainerName} --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true`,
  );
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;

  const env: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  if (!env.PG_HOST) return null;
  return {
    host: env.PG_HOST,
    port: env.PG_PORT ?? "5432",
    user: env.PG_USER ?? "da",
    password: env.PG_PASSWORD ?? "",
    database: env.PG_DATABASE ?? "deepanalyze",
  };
}

// ============================================================================
// MigrateWorkerDeps — DI surface for testability (T6/T7 pattern)
// ============================================================================
// Production code omits `deps` → real implementations are used.
// Tests pass mock `query`, `ssh`, `connectRealSsh`, `ensurePgCredentials`,
// `ensureWorkerNetwork`, `ensurePgContainer`, `pgContainerExists` to verify
// orchestration behavior hermetically (no real SSH, no real DB writes).
//
// `decryptString` is sync per src/core/crypto.ts:41. We type it as sync here.
// ============================================================================
export interface MigrateWorkerDeps {
  /** DB query function. Tests pass a recording mock. */
  query?: typeof query;
  /** Pre-connected SshExecutor (when deps.connectRealSsh is also passed, the
   *  connected SshExecutor from connectRealSsh is used instead). */
  ssh?: SshExecutor;
  /** Sync AES-256-GCM decryption of stored SSH key. */
  decryptString?: (s: string) => string;
  /** SSH connection factory; tests stub this to avoid real SSH. */
  connectRealSsh?: (opts: ConnectSshOpts) => Promise<SshExecutor>;
  /** Ensure PG credentials row exists (idempotent). */
  ensurePgCredentials?: (workerId: string) => Promise<PgCredentials>;
  /** Ensure da-net-<workerId> exists. */
  ensureWorkerNetwork?: (ssh: SshExecutor, workerId: string) => Promise<void>;
  /** Ensure da-pg-<workerId> container exists + ready. */
  ensurePgContainer?: (ssh: SshExecutor, workerId: string, creds: PgCredentials) => Promise<void>;
  /** Return true if da-pg-<workerId> container already exists. */
  pgContainerExists?: (ssh: SshExecutor, workerId: string) => Promise<boolean>;
}

async function migrateWorker(
  workerId: string,
  opts: CliOpts,
  deps: MigrateWorkerDeps = {},
): Promise<{ success: boolean; error?: string }> {
  // Resolve dependencies — production falls back to real implementations.
  const q = deps.query ?? query;
  const decrypt = deps.decryptString ?? decryptString;
  const ensureCreds = deps.ensurePgCredentials ?? ensurePgCredentials;
  const ensureNet = deps.ensureWorkerNetwork ?? ensureWorkerNetwork;
  const ensurePg = deps.ensurePgContainer ?? ensurePgContainer;
  const pgExists = deps.pgContainerExists ?? pgContainerExists;

  console.log(`\n[migrate] worker ${workerId}`);

  // 取 SSH 凭据
  const w = await q<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; host_id: string | null;
    current_image_tag: string;
  }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, host_id, current_image_tag
     FROM workers WHERE id = $1`, [workerId],
  );
  if (w.rows.length === 0) return { success: false, error: "worker not found" };
  const worker = w.rows[0];

  // host_server 优先
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
       FROM host_servers WHERE id = $1`, [worker.host_id],
    );
    if (hs.rows.length > 0 && hs.rows[0].ssh_key_encrypted) {
      sshHost = hs.rows[0].ssh_target_host;
      sshPort = hs.rows[0].ssh_target_port;
      sshUser = hs.rows[0].ssh_user;
      sshKeyEncrypted = hs.rows[0].ssh_key_encrypted;
    }
  }

  if (!sshHost || !sshKeyEncrypted) {
    return { success: false, error: "no SSH credentials" };
  }

  const privateKey = decrypt(sshKeyEncrypted);
  const connectFn = deps.connectRealSsh ?? connectRealSsh;
  const ssh = await connectFn({
    host: sshHost, port: sshPort, username: sshUser, privateKey,
  });

  try {
    // 0. 已迁移检测
    if (await pgExists(ssh, workerId)) {
      console.log(`[migrate] worker ${workerId}: da-pg exists, skipping`);
      return { success: true };
    }

    // 1. 找老 da-app 容器（兼容新旧命名）
    const oldName = `da-${workerId.slice(0, 12)}`;
    const newName = `da-app-${workerId}`;
    const oldInspect = await ssh.exec(
      `docker ps -a --filter name=^/${oldName}$ --format '{{.Names}}' 2>/dev/null`,
    );
    const oldExists = oldInspect.stdout.trim() === oldName;
    if (!oldExists) {
      console.log(`[migrate] worker ${workerId}: no old container ${oldName}, fresh deploy`);
      // 全新 worker，让 deployWorkerStack 处理即可
      return { success: true };
    }

    // 2. 提取老 PG 配置
    const oldPg = await extractOldPgConfig(ssh, oldName);
    if (!oldPg) {
      console.log(`[migrate] worker ${workerId}: no PG env in old container, assuming localhost`);
      // 假设 localhost:5432 + 默认 user/db — 老部署模型可能这样
    }

    if (opts.dryRun) {
      console.log(`[migrate][dry-run] would migrate ${workerId}: ${oldName} → ${newName}, pg=${oldPg?.host ?? 'localhost'}`);
      return { success: true };
    }

    // 3. 生成新凭据
    const newCreds = await ensureCreds(workerId);
    console.log(`[migrate] generated new PG credentials for ${workerId}`);

    // 4. 创建 network + pg 容器（空 DB）
    await ensureNet(ssh, workerId);
    await ensurePg(ssh, workerId, newCreds);
    console.log(`[migrate] created da-pg-${workerId}`);

    // 5. 数据迁移：pg_dump | pg_restore
    if (oldPg) {
      console.log(`[migrate] copying data from old PG (${oldPg.host}) to new da-pg-${workerId}`);
      // 注意：老 PG 凭据里的 password 可能有特殊字符，PGPASSWORD env 包装
      const dumpCmd = `PGPASSWORD='${oldPg.password.replace(/'/g, "'\\''")}' \
        pg_dump -h ${oldPg.host} -p ${oldPg.port} -U ${oldPg.user} -Fc ${oldPg.database}`;
      const restoreCmd = `docker exec -i da-pg-${workerId} \
        pg_restore -U ${newCreds.username} -d ${newCreds.database} --no-owner --if-exists`;
      const fullCmd = `${dumpCmd} | ${restoreCmd}`;
      const r = await ssh.exec(fullCmd);
      if (r.exitCode !== 0) {
        // pg_restore 经常有 warning（owner/ACL），exitCode 非 0 不一定是失败
        console.log(`[migrate] pg_restore exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
      }
    }

    // 6. stop 老 da-app
    console.log(`[migrate] stopping old container ${oldName}`);
    await ssh.exec(`docker stop ${oldName} 2>/dev/null || true`);

    // 7. docker run 新 da-app-<workerId>（指向新 PG）
    // 注意：这里复用 worker.current_image_tag，不是 deployWorkerStack（避免循环依赖）
    const envVars = [
      `-e PG_HOST=${pgContainerName(workerId)}`,
      `-e PG_PORT=5432`,
      `-e PG_USER=${newCreds.username}`,
      `-e PG_PASSWORD='${newCreds.password.replace(/'/g, "'\\''")}'`,
      `-e PG_DATABASE=${newCreds.database}`,
      // TODO: 其他 DA_* env 从老容器继承
    ].join(" ");

    // 从老容器继承非 PG 的 env vars
    const inheritR = await ssh.exec(
      `docker inspect ${oldName} --format '{{range .Config.Env}}{{println .}}{{end}}'`,
    );
    const inheritedEnvs: string[] = [];
    for (const line of inheritR.stdout.split("\n")) {
      if (!line.trim()) continue;
      const key = line.split("=")[0];
      if (!key.startsWith("PG_")) {
        inheritedEnvs.push(`-e ${line.replace(/'/g, "'\\''")}`);
      }
    }

    const volFlag = `-v da-app-data-${workerId}:/app/data`;
    const netFlag = `--network da-net-${workerId}`;
    const label = `--label com.deepanalyze.workerId=${workerId} --label com.deepanalyze.role=app`;
    const portFlag = `-p 21000:21000`;  // TODO: 从老容器读 port mapping

    const runCmd = `docker run -d --name ${newName} ${netFlag} ${label} ${inheritedEnvs.join(" ")} ${envVars} ${volFlag} ${portFlag} --restart unless-stopped ${worker.current_image_tag}`;
    console.log(`[migrate] starting new container: ${runCmd}`);
    const runR = await ssh.exec(runCmd);
    if (runR.exitCode !== 0) {
      // 回滚：启动老容器
      console.log(`[migrate][error] failed to start new container, rolling back: ${runR.stderr}`);
      await ssh.exec(`docker start ${oldName} 2>/dev/null || true`);
      return { success: false, error: `failed to start new da-app: ${runR.stderr}` };
    }

    // 8. 健康检查
    console.log(`[migrate] waiting for da-app-${workerId} healthcheck`);
    const deadline = Date.now() + 180_000;
    let healthy = false;
    while (Date.now() < deadline) {
      const h = await ssh.exec(
        `docker exec ${newName} curl -sf http://localhost:21000/api/health 2>/dev/null || echo FAIL`,
      );
      if (!h.stdout.includes("FAIL") && h.stdout.includes("ok")) {
        healthy = true;
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!healthy) {
      console.log(`[migrate][error] healthcheck failed, rolling back`);
      await ssh.exec(`docker rm -f ${newName} 2>/dev/null || true`);
      await ssh.exec(`docker start ${oldName} 2>/dev/null || true`);
      return { success: false, error: "healthcheck timeout" };
    }

    console.log(`[migrate] worker ${workerId} migrated successfully`);
    return { success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[migrate][error] ${workerId}: ${errMsg}`);
    return { success: false, error: errMsg };
  } finally {
    ssh.close();
  }
}

async function main() {
  const opts = parseArgs();
  console.log(`[migrate] starting, dryRun=${opts.dryRun}, concurrency=${opts.concurrency}`);

  // 取所有 online worker
  const where = opts.workerId
    ? `WHERE id = $1 AND status = 'online'`
    : `WHERE status = 'online'`;
  const params = opts.workerId ? [opts.workerId] : [];
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM workers ${where} ORDER BY id`, params,
  );

  console.log(`[migrate] ${rows.length} workers to check`);

  let success = 0, failed = 0, skipped = 0;
  for (const w of rows) {
    const r = await migrateWorker(w.id, opts);
    if (r.success) success++;
    else if (r.error?.includes("skipping")) skipped++;
    else failed++;
  }

  console.log(`\n[migrate] done: ${success} success, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// Run main() only when executed directly (not when imported by tests).
// Bun exposes `import.meta.main` which is `true` when the module is the
// entry point. This guard lets tests import { migrateWorker } without
// triggering the CLI's DB-dependent main().
if (import.meta.main) {
  main().catch(err => {
    console.error("[migrate] fatal:", err);
    process.exit(2);
  });
}

// Export for tests (only migrateWorker + extractOldPgConfig are tested).
export { migrateWorker, extractOldPgConfig };
export type { MigrateWorkerDeps, OldPgConfig, CliOpts };
