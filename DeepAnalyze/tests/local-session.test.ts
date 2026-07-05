import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { signLocalSession, verifyLocalSession } from "../src/services/auth/local-session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("local-session", () => {
  let authDir: string;
  const origAuthDir = process.env.DA_AUTH_DIR;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "da-session-test-"));
    process.env.DA_AUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (origAuthDir === undefined) delete process.env.DA_AUTH_DIR;
    else process.env.DA_AUTH_DIR = origAuthDir;
  });

  test("sign + verify roundtrip", async () => {
    const jwt = await signLocalSession({
      sub: "u1",
      name: "Alice",
      orgId: "o1",
      daWorkerId: "wk1",
    });
    const payload = await verifyLocalSession(jwt);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("u1");
    expect(payload!.name).toBe("Alice");
    expect(payload!.orgId).toBe("o1");
    expect(payload!.daWorkerId).toBe("wk1");
  });

  test("过期 token 拒绝", async () => {
    const jwt = await signLocalSession({
      sub: "u1",
      name: "A",
      orgId: null,
      daWorkerId: "wk1",
      exp: Math.floor(Date.now() / 1000) - 3600, // 1h ago
    });
    const payload = await verifyLocalSession(jwt);
    expect(payload).toBeNull();
  });

  test("篡改 token 拒绝", async () => {
    const jwt = await signLocalSession({
      sub: "u1",
      name: "A",
      orgId: null,
      daWorkerId: "wk1",
    });
    const tampered = jwt.slice(0, -5) + "XXXXX";
    const payload = await verifyLocalSession(tampered);
    expect(payload).toBeNull();
  });
});
