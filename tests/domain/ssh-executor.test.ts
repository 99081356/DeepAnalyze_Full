import { describe, test, expect } from "bun:test";
import { MockSshExecutor } from "../../src/domain/ssh-executor";

describe("MockSshExecutor", () => {
  test("按注册顺序返回响应", async () => {
    const exec = new MockSshExecutor();
    exec.when("docker ps").resolve({ stdout: "container1\n", stderr: "", exitCode: 0 });
    exec.when(/docker run/).resolve({ stdout: "abc123\n", stderr: "", exitCode: 0 });

    const r1 = await exec.exec("docker ps");
    expect(r1.stdout).toBe("container1\n");
    expect(r1.exitCode).toBe(0);

    const r2 = await exec.exec("docker run -d alpine");
    expect(r2.stdout).toBe("abc123\n");
  });

  test("未注册的命令抛错", async () => {
    const exec = new MockSshExecutor();
    expect(exec.exec("unknown cmd")).rejects.toThrow(/unexpected command/);
  });

  test("支持 exitCode 非零", async () => {
    const exec = new MockSshExecutor();
    exec.when(/docker rm/).resolve({ stdout: "", stderr: "no such container\n", exitCode: 1 });

    const r = await exec.exec("docker rm foo");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("no such container\n");
  });

  test("pullFile/pushFile 调用记录可查", async () => {
    const exec = new MockSshExecutor();
    const chunks: Buffer[] = [];
    const { Writable } = await import("node:stream");
    const writable = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });
    exec.mockPullFile("/tmp/test.dump", Buffer.from("dump data"));

    await exec.pullFile("/tmp/test.dump", writable);
    expect(Buffer.concat(chunks).toString()).toBe("dump data");
  });

  test("close 幂等", () => {
    const exec = new MockSshExecutor();
    exec.close();
    exec.close();  // 不抛错
  });
});
