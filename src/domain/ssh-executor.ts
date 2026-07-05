// SshExecutor abstraction: 让所有 SSH 操作可测试
// 生产用 RealSshExecutor (ssh2 包装)，测试用 MockSshExecutor (脚本化响应)

import type { Readable, Writable } from "node:stream";
import type { Client } from "ssh2";

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshExecutor {
  exec(cmd: string): Promise<SshExecResult>;
  pullFile(remotePath: string, localStream: Writable): Promise<void>;
  pushFile(localStream: Readable, remotePath: string): Promise<void>;
  close(): void;
}

// ============================================================================
// MockSshExecutor — 测试用
// ============================================================================

type Matcher = string | RegExp;
interface MockResponse { stdout: string; stderr: string; exitCode: number }

export class MockSshExecutor implements SshExecutor {
  private responses: Array<{ matcher: Matcher; response: MockResponse }> = [];
  private pullResponses = new Map<string, Buffer>();
  private pushCaptures: Array<{ remotePath: string; data: Buffer }> = [];
  private closed = false;

  when(cmd: Matcher): { resolve: (r: MockResponse) => void } {
    return {
      resolve: (response: MockResponse) => {
        this.responses.push({ matcher: cmd, response });
      },
    };
  }

  mockPullFile(remotePath: string, data: Buffer): void {
    this.pullResponses.set(remotePath, data);
  }

  get pushHistory(): ReadonlyArray<{ remotePath: string; data: Buffer }> {
    return this.pushCaptures;
  }

  async exec(cmd: string): Promise<SshExecResult> {
    if (this.closed) throw new Error("MockSshExecutor: closed");
    const idx = this.responses.findIndex(r =>
      typeof r.matcher === "string" ? r.matcher === cmd : r.matcher.test(cmd)
    );
    if (idx === -1) {
      throw new Error(`MockSshExecutor: unexpected command: ${cmd}`);
    }
    const [entry] = this.responses.splice(idx, 1);
    return entry.response;
  }

  async pullFile(remotePath: string, localStream: Writable): Promise<void> {
    const data = this.pullResponses.get(remotePath);
    if (!data) throw new Error(`MockSshExecutor: no pull response for ${remotePath}`);
    await new Promise<void>((resolve, reject) => {
      localStream.write(data, (err) => err ? reject(err) : resolve());
    });
  }

  async pushFile(localStream: Readable, remotePath: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of localStream) chunks.push(chunk as Buffer);
    this.pushCaptures.push({ remotePath, data: Buffer.concat(chunks) });
  }

  close(): void {
    this.closed = true;
  }
}

// ============================================================================
// RealSshExecutor — ssh2 包装（生产用）
// ============================================================================

export interface ConnectSshOpts {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  readyTimeout?: number;
}

export class RealSshExecutor implements SshExecutor {
  constructor(private conn: Client) {}

  async exec(cmd: string): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let exitCode = -1;
        stream.on("close", (code: number) => {
          exitCode = typeof code === "number" ? code : 0;
          resolve({ stdout, stderr, exitCode });
        });
        stream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      });
    });
  }

  async pullFile(remotePath: string, localStream: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createReadStream(remotePath);
        stream.on("error", reject);
        stream.on("end", () => resolve());
        stream.pipe(localStream);
      });
    });
  }

  async pushFile(localStream: Readable, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath);
        stream.on("error", reject);
        stream.on("close", () => resolve());
        localStream.pipe(stream);
      });
    });
  }

  close(): void {
    try { this.conn.end(); } catch {}
  }
}

// 工厂函数：替代原 connectSsh
export async function connectRealSsh(opts: ConnectSshOpts): Promise<SshExecutor> {
  const { Client } = await import("ssh2");
  const conn = new Client();
  return new Promise<SshExecutor>((resolve, reject) => {
    const onReady = () => {
      conn.off("error", onError);
      resolve(new RealSshExecutor(conn));
    };
    const onError = (err: Error) => reject(err);
    conn.once("ready", onReady);
    conn.once("error", onError);
    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      privateKey: opts.privateKey,
      readyTimeout: opts.readyTimeout ?? 60000,
    });
  });
}
