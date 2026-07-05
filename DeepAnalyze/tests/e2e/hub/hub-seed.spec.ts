/**
 * T81: Seed script idempotency test.
 *
 * Verifies that scripts/seed-realistic.ts in deepanalyze-hub is idempotent:
 * running it twice produces identical row counts for orgs, users, and skills.
 *
 * Uses child_process exec to invoke the seed script directly, then queries
 * the Hub API (http://localhost:22000) to verify data state.
 */
import { test, expect } from "@playwright/test";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const HUB_API = "http://localhost:22000/api/v1";
const SEED_CMD = "cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run scripts/seed-realistic.ts";

test.describe.serial("Hub seed — T81", () => {
  test("T81: seed script is idempotent (run twice, same counts)", async () => {
    // ── Helper: login and return access token ──
    const login = async (): Promise<string> => {
      const { stdout } = await execAsync(
        `curl -s ${HUB_API}/auth/login -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}'`,
      );
      return JSON.parse(stdout).access_token;
    };

    // ── Helper: fetch JSON from an API endpoint ──
    const fetchJson = async (endpoint: string, token: string) => {
      const { stdout } = await execAsync(
        `curl -s ${HUB_API}${endpoint} -H 'Authorization: Bearer ${token}'`,
      );
      return JSON.parse(stdout);
    };

    // ── First seed run ──
    await execAsync(SEED_CMD);

    const token1 = await login();
    const orgs1 = await fetchJson("/orgs", token1);
    const users1 = await fetchJson("/users", token1);
    const skills1 = await fetchJson("/skills", token1);

    // ── Second seed run ──
    await execAsync(SEED_CMD);

    const token2 = await login();
    const orgs2 = await fetchJson("/orgs", token2);
    const users2 = await fetchJson("/users", token2);
    const skills2 = await fetchJson("/skills", token2);

    // ── Idempotency: counts must be identical across runs ──
    // GET /orgs returns { organizations: [...] }
    expect(orgs2.organizations.length).toBe(orgs1.organizations.length);
    // GET /users returns { users: [...], page, pageSize }
    expect(users2.users.length).toBe(users1.users.length);
    // GET /skills returns { items: [...], total }
    expect(skills2.items.length).toBe(skills1.items.length);

    // ── Concrete expected values ──
    // Org tree: DSI + 3 departments (PRC, COMM, SEC) + 4 sub-departments (INFRA, APP, SOL, CS) + 3 teams (AGENT, DATA, KB) = 11
    expect(orgs2.organizations.length).toBe(11);
    // Users: 1 admin + 5 org admins + 13 regular users = 19
    expect(users2.users.length).toBe(19);
    // Skills visible to admin (super_admin in org DSI):
    //   2 system-scope (da-agent-debug, kb-report-writing)
    //   1 org-scope for DSI (infra-cost-opt)
    //   Other org-scope skills (SOL, SEC) and user-scope (sun.jiayi) are filtered out
    expect(skills2.items.length).toBe(3);
  });
});
