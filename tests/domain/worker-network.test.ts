import { describe, test, expect } from "bun:test";
import { MockSshExecutor } from "../../src/domain/ssh-executor";
import {
  workerNetworkName,
  ensureWorkerNetwork,
  removeWorkerNetwork,
  networkExists,
} from "../../src/domain/worker-network";

describe("workerNetworkName", () => {
  test("返回 da-net-<workerId>", () => {
    expect(workerNetworkName("abc123")).toBe("da-net-abc123");
  });
});

describe("networkExists", () => {
  test("存在返回 true", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({
      stdout: '[{"Name":"da-net-abc"}]\n', stderr: "", exitCode: 0,
    });
    expect(await networkExists(ssh, "abc")).toBe(true);
  });

  test("不存在返回 false", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({
      stdout: "", stderr: "Error: no such network\n", exitCode: 1,
    });
    expect(await networkExists(ssh, "abc")).toBe(false);
  });
});

describe("ensureWorkerNetwork", () => {
  test("已存在则跳过创建", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({
      stdout: '[{"Name":"da-net-abc"}]\n', stderr: "", exitCode: 0,
    });
    // 不注册 docker network create — 如果调用会抛 "unexpected command"

    await ensureWorkerNetwork(ssh, "abc");
    // 没抛错就过
  });

  test("不存在则 create", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({ stdout: "", stderr: "no such", exitCode: 1 });
    ssh.when(/docker network create da-net-abc/).resolve({
      stdout: "abc123networkid\n", stderr: "", exitCode: 0,
    });

    await ensureWorkerNetwork(ssh, "abc");
    // 没抛错就过
  });
});

describe("removeWorkerNetwork", () => {
  test("调用 docker network rm", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network rm da-net-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });

    await removeWorkerNetwork(ssh, "abc");
  });

  test("network 不存在不抛错（idempotent）", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network rm da-net-abc/).resolve({
      stdout: "", stderr: "no such network\n", exitCode: 1,
    });

    // 不应抛错
    await removeWorkerNetwork(ssh, "abc");
  });
});
