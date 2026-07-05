// Worker 专属 PG 凭据管理
// - generate: 随机 32 字节密码
// - save: 加密入库
// - load: 解密读取
// - ensure: 没有则生成 + 入库，有则返回（幂等）

import { randomBytes } from "node:crypto";
import { query } from "../store/pg.js";
import { encryptString, decryptString } from "../core/crypto.js";

export interface PgCredentials {
  database: string;
  username: string;
  password: string;
}

const DEFAULT_DATABASE = "deepanalyze";
const DEFAULT_USERNAME = "da";

export async function generatePgCredentials(): Promise<PgCredentials> {
  // 32 字节随机 → base64 (~44 字符)，作为 PG password 足够强
  const password = randomBytes(32).toString("base64");
  return {
    database: DEFAULT_DATABASE,
    username: DEFAULT_USERNAME,
    password,
  };
}

export async function savePgCredentials(
  workerId: string,
  creds: PgCredentials,
): Promise<void> {
  const encrypted = encryptString(creds.password);
  await query(
    `UPDATE workers
       SET pg_database = $2,
           pg_username = $3,
           pg_password_encrypted = $4
     WHERE id = $1`,
    [workerId, creds.database, creds.username, encrypted],
  );
}

export async function loadPgCredentials(workerId: string): Promise<PgCredentials> {
  const { rows } = await query<{
    pg_database: string; pg_username: string; pg_password_encrypted: string | null;
  }>(
    `SELECT pg_database, pg_username, pg_password_encrypted FROM workers WHERE id = $1`,
    [workerId],
  );
  if (rows.length === 0) throw new Error(`worker ${workerId} not found`);
  const row = rows[0];
  if (!row.pg_password_encrypted) {
    throw new Error(`worker ${workerId} has no pg_password_encrypted (not yet provisioned)`);
  }
  return {
    database: row.pg_database,
    username: row.pg_username,
    password: decryptString(row.pg_password_encrypted),
  };
}

export async function ensurePgCredentials(workerId: string): Promise<PgCredentials> {
  // 先尝试 load
  try {
    return await loadPgCredentials(workerId);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("no pg_password_encrypted")) {
      throw err;
    }
    // 没凭据 → 生成 + 入库
    const creds = await generatePgCredentials();
    await savePgCredentials(workerId, creds);
    return creds;
  }
}
