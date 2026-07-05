import { describe, test, expect } from "bun:test";
import { MockSshExecutor } from "../../src/domain/ssh-executor";
import type { PgCredentials } from "../../src/domain/worker-pg-credentials";
import {
  pgContainerName,
  pgVolumeName,
  daPostgresImage,
  pgContainerExists,
  ensurePgContainer,
  waitForPgReady,
  removePgContainer,
} from "../../src/domain/worker-pg-container";

const FAKE_CREDS: PgCredentials = {
  database: "deepanalyze",
  username: "da",
  password: "testpass123",
};

describe("naming helpers", () => {
  test("pgContainerName", () => {
    expect(pgContainerName("abc")).toBe("da-pg-abc");
  });
  test("pgVolumeName", () => {
    expect(pgVolumeName("abc")).toBe("da-pg-data-abc");
  });
  test("daPostgresImage 默认无 registry", () => {
    const oldReg = process.env.HUB_DOCKER_REGISTRY;
    delete process.env.HUB_DOCKER_REGISTRY;
    expect(daPostgresImage()).toBe("da-postgres:16-tuned");
    if (oldReg) process.env.HUB_DOCKER_REGISTRY = oldReg;
  });
  test("daPostgresImage 有 registry 时加前缀", () => {
    const oldReg = process.env.HUB_DOCKER_REGISTRY;
    process.env.HUB_DOCKER_REGISTRY = "registry.example.com/";
    expect(daPostgresImage()).toBe("registry.example.com/da-postgres:16-tuned");
    if (oldReg) process.env.HUB_DOCKER_REGISTRY = oldReg;
    else delete process.env.HUB_DOCKER_REGISTRY;
  });
});

describe("pgContainerExists", () => {
  test("存在返回 true", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({
      stdout: "da-pg-abc\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await pgContainerExists(ssh, "abc")).toBe(true);
  });
  test("不存在返回 false", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    expect(await pgContainerExists(ssh, "abc")).toBe(false);
  });
});

describe("ensurePgContainer", () => {
  test("已存在则跳过", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({
      stdout: "da-pg-abc\n",
      stderr: "",
      exitCode: 0,
    });
    // 不注册 docker run
    await ensurePgContainer(ssh, "abc", FAKE_CREDS);
  });

  test("不存在则 run + wait", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/docker run -d/).resolve({ stdout: "containerid123\n", stderr: "", exitCode: 0 });
    ssh.when(/pg_isready/).resolve({ stdout: "accepting\n", stderr: "", exitCode: 0 });

    await ensurePgContainer(ssh, "abc", FAKE_CREDS);
  });

  test("run 失败抛错", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/docker run -d/).resolve({
      stdout: "",
      stderr: "image not found\n",
      exitCode: 1,
    });
    expect(ensurePgContainer(ssh, "abc", FAKE_CREDS)).rejects.toThrow(/image not found/);
  });
});

describe("waitForPgReady", () => {
  test("立即 ready", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/pg_isready/).resolve({ stdout: "accepting\n", stderr: "", exitCode: 0 });
    await waitForPgReady(ssh, "abc", 5);
  });

  test("超时抛错", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/pg_isready/).resolve({ stdout: "no response\n", stderr: "", exitCode: 0 });
    expect(waitForPgReady(ssh, "abc", 1)).rejects.toThrow(/timeout/);
  });
});

describe("removePgContainer", () => {
  test("默认不删 volume", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker rm -f da-pg-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    // 不注册 docker volume rm
    await removePgContainer(ssh, "abc");
  });

  test("opts.removeVolume=true 删 volume", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker rm -f da-pg-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/docker volume rm da-pg-data-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    await removePgContainer(ssh, "abc", { removeVolume: true });
  });
});
