/**
 * E2E API Tests — Agent Skills
 * Tests the agent skills CRUD API endpoints.
 */
import { test, expect } from "@playwright/test";

test.describe("Agent Skill API", () => {
  // -----------------------------------------------------------------------
  // 1. GET /api/agent-skills returns skill list
  // -----------------------------------------------------------------------
  test("GET /api/agent-skills returns skill list", async ({ request }) => {
    const resp = await request.get("/api/agent-skills");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. POST /api/agent-skills creates a skill
  // -----------------------------------------------------------------------
  test("POST /api/agent-skills creates a new skill", async ({ request }) => {
    const uniqueName = `e2e_test_skill_${Date.now()}`;
    const resp = await request.post("/api/agent-skills", {
      data: {
        name: uniqueName,
        description: "E2E test skill",
        prompt: "This is a test skill for E2E testing.",
        tools: ["kb_search"],
        modelRole: "main",
        isActive: true,
      },
    });
    expect(resp.status()).toBe(201);
    const body = await resp.json();
    expect(body).toHaveProperty("id");
    expect(body.name).toBe(uniqueName);
    expect(body.description).toBe("E2E test skill");

    // Cleanup: delete the created skill
    if (body.id) {
      await request.delete(`/api/agent-skills/${body.id}`);
    }
  });

  // -----------------------------------------------------------------------
  // 3. DELETE /api/agent-skills/:id deletes a skill
  // -----------------------------------------------------------------------
  test("DELETE /api/agent-skills/:id deletes a skill", async ({ request }) => {
    // First create a skill to delete
    const createResp = await request.post("/api/agent-skills", {
      data: {
        name: `e2e_delete_skill_${Date.now()}`,
        prompt: "To be deleted",
      },
    });
    expect(createResp.status()).toBe(201);
    const { id } = await createResp.json();

    // Now delete it
    const deleteResp = await request.delete(`/api/agent-skills/${id}`);
    expect(deleteResp.status()).toBe(200);
    const body = await deleteResp.json();
    expect(body.success).toBe(true);

    // Verify it's gone
    const getResp = await request.get(`/api/agent-skills/${id}`);
    expect(getResp.status()).toBe(404);
  });
});
