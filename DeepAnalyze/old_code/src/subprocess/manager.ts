/**
 * SubprocessManager – generic subprocess manager that communicates with
 * child processes (e.g. Python services) over a JSON-line protocol on
 * stdin / stdout.
 *
 * Supports both the Bun and Node.js runtimes.
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

const isBun = typeof Bun !== "undefined";

// ---------------------------------------------------------------------------
// Lazy-loaded Node.js child_process (only needed when not running under Bun)
// ---------------------------------------------------------------------------

let _nodeChildProcess: typeof import("node:child_process") | null = null;

async function getNodeChildProcess(): Promise<typeof import("node:child_process")> {
  if (_nodeChildProcess) return _nodeChildProcess;
  _nodeChildProcess = await import("node:child_process");
  return _nodeChildProcess;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ManagedProcess {
  stdin: WritableStream | NodeJS.WritableStream;
  stdout: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
  stderr: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
  kill: () => void;
  exited: Promise<number | null>;
}

// ---------------------------------------------------------------------------
// SubprocessManager
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 600_000;

export class SubprocessManager {
  private processes: Map<string, ManagedProcess> = new Map();
  private pendingRequests: Map<
    string,
    { resolve: (data: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  > = new Map();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Spawn a named subprocess.
   *
   * @param name    Logical name used to refer to this process later.
   * @param command Array of command + args, e.g. ["python", "main.py"].
   * @param cwd     Working directory for the child process.
   */
  async start(name: string, command: string[], cwd?: string): Promise<void> {
    if (this.processes.has(name)) {
      throw new Error(`Process "${name}" is already running`);
    }

    let proc: ManagedProcess;

    if (isBun) {
      proc = this._startBun(command, cwd);
    } else {
      proc = await this._startNode(command, cwd);
    }

    this.processes.set(name, proc);

    // Start reading stdout lines in the background.
    this._readStdoutLoop(name, proc.stdout).catch((err) => {
      console.error(`[SubprocessManager] stdout reader for "${name}" failed:`, err);
    });

    // Forward stderr for debugging.
    this._forwardStderr(name, proc.stderr).catch(() => {
      /* ignore */
    });

    // When the process exits, clean up pending requests.
    proc.exited.then((code) => {
      this._onProcessExit(name, code);
    });
  }

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  /**
   * Send a JSON message to the named subprocess and wait for a response
   * that carries the same `id`.
   *
   * A unique `id` is automatically added to the payload unless one is
   * already provided.
   */
  async send(
    name: string,
    data: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<any> {
    const proc = this.processes.get(name);
    if (!proc) {
      throw new Error(`No process named "${name}" is running`);
    }

    const id = (data.id as string) ?? randomUUID();
    const payload = { ...data, id };

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${id} to "${name}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const line = JSON.stringify(payload) + "\n";
      this._writeToStdin(proc.stdin, line);
    });
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  /** Check whether a named process is currently running. */
  isRunning(name: string): boolean {
    return this.processes.has(name);
  }

  /** Stop a single named process. */
  async stop(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (!proc) return;

    proc.kill();
    this.processes.delete(name);

    // Reject all pending requests targeting this process.
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Process "${name}" was stopped`));
      this.pendingRequests.delete(id);
    }
  }

  /** Stop every managed process. */
  async stopAll(): Promise<void> {
    const names = [...this.processes.keys()];
    await Promise.all(names.map((n) => this.stop(n)));
  }

  // -----------------------------------------------------------------------
  // Internal – Bun spawn
  // -----------------------------------------------------------------------

  private _startBun(command: string[], cwd?: string): ManagedProcess {
    const child = (Bun as any).spawn(command, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const exited = new Promise<number | null>((resolve) => {
      (child.exited as Promise<number>)
        .then((code: number) => resolve(code))
        .catch(() => resolve(null));
    });

    return {
      stdin: child.stdin as WritableStream,
      stdout: child.stdout as ReadableStream<Uint8Array>,
      stderr: child.stderr as ReadableStream<Uint8Array>,
      kill: () => {
        try {
          child.kill();
        } catch {
          /* already dead */
        }
      },
      exited,
    };
  }

  // -----------------------------------------------------------------------
  // Internal – Node.js spawn
  // -----------------------------------------------------------------------

  private async _startNode(command: string[], cwd?: string): Promise<ManagedProcess> {
    const cp = await getNodeChildProcess();

    const child = cp.spawn(command[0], command.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code: number | null) => resolve(code));
      child.on("error", () => resolve(null));
    });

    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      kill: () => {
        try {
          child.kill();
        } catch {
          /* already dead */
        }
      },
      exited,
    };
  }

  // -----------------------------------------------------------------------
  // Internal – stdout reader
  // -----------------------------------------------------------------------

  private async _readStdoutLoop(
    name: string,
    stdout: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  ): Promise<void> {
    const decoder = new TextDecoder();

    if (isBun && stdout instanceof ReadableStream) {
      const reader = (stdout as ReadableStream<Uint8Array>).getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!; // keep incomplete tail

        for (const line of lines) {
          this._handleResponseLine(line);
        }
      }

      // Process any remaining data.
      if (buffer.trim()) {
        this._handleResponseLine(buffer);
      }
    } else {
      // Node.js Readable
      const nodeStream = stdout as NodeJS.ReadableStream;
      let buffer = "";

      for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          this._handleResponseLine(line);
        }
      }

      if (buffer.trim()) {
        this._handleResponseLine(buffer);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal – stderr forwarder
  // -----------------------------------------------------------------------

  private async _forwardStderr(
    name: string,
    stderr: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  ): Promise<void> {
    try {
      if (isBun && stderr instanceof ReadableStream) {
        const reader = (stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (line.trim()) {
              console.error(`[${name}:stderr] ${line}`);
            }
          }
        }
      } else {
        const nodeStream = stderr as NodeJS.ReadableStream;
        for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
          const text = chunk.toString("utf-8");
          for (const line of text.split("\n")) {
            if (line.trim()) {
              console.error(`[${name}:stderr] ${line}`);
            }
          }
        }
      }
    } catch {
      /* stream already closed */
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private _handleResponseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error("[SubprocessManager] Failed to parse response line:", trimmed);
      return;
    }

    const id: string | undefined = parsed?.id;
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.resolve(parsed);
    }
  }

  private _writeToStdin(stdin: WritableStream | NodeJS.WritableStream, data: string): void {
    if (isBun && "getWriter" in stdin) {
      const writer = (stdin as WritableStream).getWriter();
      writer.write(new TextEncoder().encode(data));
      // Release the lock so future writes can acquire it.
      writer.releaseLock();
    } else {
      const nodeStdin = stdin as NodeJS.WritableStream;
      nodeStdin.write(data);
    }
  }

  private _onProcessExit(name: string, code: number | null): void {
    console.error(`[SubprocessManager] Process "${name}" exited with code ${code}`);
    this.processes.delete(name);

    // Reject any pending requests that were waiting on this process.
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Process "${name}" exited unexpectedly with code ${code}`));
      this.pendingRequests.delete(id);
    }
  }
}
