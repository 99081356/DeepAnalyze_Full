import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import os from "os";
import { AgentPluginManager } from "../plugin-manager.js";

const TMP = join(os.tmpdir(), "da-plugin-test-" + Date.now());

beforeAll(async () => {
  // Create test plugin structure
  await mkdir(join(TMP, "test-plugin", "skills", "evidence-chain"), { recursive: true });
  await mkdir(join(TMP, "test-plugin", "agents"), { recursive: true });

  await writeFile(join(TMP, "test-plugin", "plugin.json"), JSON.stringify({
    name: "test-plugin",
    version: "1.0.0",
    description: "Test plugin",
    capabilities: ["skills", "agents"],
    skills: [{ dir: "skills/evidence-chain" }],
    agents: [{ file: "agents/verifier.md" }],
  }));

  await writeFile(join(TMP, "test-plugin", "skills", "evidence-chain", "SKILL.md"),
    `---
description: Evidence chain analysis
tools: [kb_search]
---

# Evidence Analysis

Analyze evidence.`);

  await writeFile(join(TMP, "test-plugin", "agents", "verifier.md"),
    `---
agentType: verifier
description: Verify facts
tools: [kb_search]
readOnly: true
---

# Verifier Agent

Verify all claims.`);
});

afterAll(async () => {
  await rm(TMP, { recursive: true });
});

describe("AgentPluginManager", () => {
  it("loads plugin from directory", async () => {
    const pm = new AgentPluginManager();
    const plugin = await pm.loadPlugin(join(TMP, "test-plugin"));
    expect(plugin.manifest.name).toBe("test-plugin");
    expect(plugin.enabled).toBe(true);
  });

  it("loads skills from plugin", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(TMP, "test-plugin"));
    const skills = pm.getAllSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].description).toBe("Evidence chain analysis");
    expect(skills[0].systemPrompt).toContain("Evidence Analysis");
  });

  it("loads agents from plugin", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(TMP, "test-plugin"));
    const agents = pm.getAllAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].agentType).toBe("verifier");
  });

  it("disabling plugin hides skills and agents", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(TMP, "test-plugin"));
    pm.setEnabled("test-plugin", false);
    expect(pm.getAllSkills()).toEqual([]);
    expect(pm.getAllAgents()).toEqual([]);
  });

  it("unloading plugin removes it", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(TMP, "test-plugin"));
    expect(pm.unload("test-plugin")).toBe(true);
    expect(pm.get("test-plugin")).toBeUndefined();
  });
});
