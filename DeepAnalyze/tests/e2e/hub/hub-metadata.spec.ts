/**
 * T82: Hub metadata validation test.
 *
 * Verifies that zod validation on skill creation endpoints correctly
 * rejects invalid input (missing/short description, invalid category,
 * missing change_summary) and accepts valid input.
 *
 * Tests:
 *   T82-a: missing description -> 400
 *   T82-b: short description (<10 chars) -> 400
 *   T82-c: invalid category -> 400
 *   T82-d: valid input -> 201
 *   T82-e: version without change_summary -> 400
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { HUB_BASE, adminLogin, uniq } from "../helpers/hubApi";

const API = `${HUB_BASE}/api/v1`;

test.describe.serial("Hub metadata validation — T82", () => {
  let ctx: APIRequestContext;
  let adminToken: string;

  test.beforeAll(async () => {
    ctx = await request.newContext();
    const admin = await adminLogin(ctx);
    adminToken = admin.token!;
  });

  test.afterAll(async () => {
    await ctx.dispose();
  });

  /** POST /skills with the given body, returning the raw response. */
  const postSkill = async (body: object) =>
    ctx.post(`${API}/skills`, {
      data: body,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    });

  // ── T82-a: missing description → 400 ──────────────────────────────────
  test("T82-a: missing description → 400", async () => {
    const resp = await postSkill({ name: uniq("e2e82"), scope: "user" });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("Validation");
    expect(body.fields.description).toBeTruthy();
  });

  // ── T82-b: short description (<10 chars) → 400 ────────────────────────
  test("T82-b: short description (<10 chars) → 400", async () => {
    const resp = await postSkill({
      name: uniq("e2e82"),
      description: "短",
      scope: "user",
    });
    expect(resp.status()).toBe(400);
  });

  // ── T82-c: invalid category → 400 ─────────────────────────────────────
  test("T82-c: invalid category → 400", async () => {
    const resp = await postSkill({
      name: uniq("e2e82"),
      description: "这是一个合法长度的描述",
      category: "nonexistent_category",
      scope: "user",
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.fields.category).toBeTruthy();
  });

  // ── T82-d: valid input → 201 ──────────────────────────────────────────
  test("T82-d: valid input → 201", async () => {
    const resp = await postSkill({
      name: uniq("e2e82_ok"),
      description: "这是一个合法的 E2E 测试 Skill 描述",
      category: "engineering",
      tags: ["e2e", "test"],
      icon: "🧪",
      scope: "user",
    });
    expect(resp.status()).toBe(201);
  });

  // ── T82-e: version without change_summary → 400 ───────────────────────
  test("T82-e: version without change_summary → 400", async () => {
    // First create a valid package
    const pkgResp = await postSkill({
      name: uniq("e2e82_ver"),
      description: "用于测试版本校验的 Skill 包",
      category: "general",
      scope: "user",
    });
    expect(pkgResp.status()).toBe(201);
    const pkg = await pkgResp.json();
    const pkgId = pkg.package.id;

    // Attempt to create a version without change_summary
    const verResp = await ctx.post(`${API}/skills/${pkgId}/versions`, {
      data: { version: "1.0.0", content: "test content" },
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    });
    expect(verResp.status()).toBe(400);
  });
});
