// =============================================================================
// DeepAnalyze - Hub SkillSync Handler
// =============================================================================
// 处理来自 Hub 的 SkillSync 指令（sync/force_update/kill/rollback/policy_refresh）
//
// 通过 repos.agentSkill 操作本地 agent_skills 表，与 Phase 1 marketplace 的
// install 路径保持一致（source='hub'，UNIQUE(name, source) 约束）。
// =============================================================================

import type { AgentSkillRepo } from "../../store/repos/interfaces.js";
import type { SkillSyncInstruction } from "./types.js";

/** SyncHandler 依赖的最小 repo 子集，便于测试和未来替换。 */
export interface SyncHandlerRepos {
  agentSkill: AgentSkillRepo;
}

/**
 * 处理来自 Hub 的 SkillSync 指令。
 *
 * Phase 1: 基础实现——sync upsert 到 agent_skills (source='hub')，
 * kill 标记为 inactive。Phase 2/3 的 version rollback 暂留 stub。
 */
export class SyncHandler {
  constructor(private repos: SyncHandlerRepos) {}

  async handle(inst: SkillSyncInstruction): Promise<void> {
    switch (inst.action) {
      case "sync":
        await this.syncSkill(inst);
        break;
      case "force_update":
        await this.forceUpdateSkill(inst);
        break;
      case "kill":
        await this.removeLocalSkill(inst.package_id);
        break;
      case "rollback":
        await this.rollbackSkill(inst);
        break;
      case "policy_refresh":
        console.log(
          `[HubSync] Policy refreshed for ${inst.package_id}: ${inst.reason ?? "no reason"}`,
        );
        break;
    }
  }

  /** 同步 skill 到本地 agent_skills 表（upsert by name+source='hub'） */
  private async syncSkill(inst: SkillSyncInstruction): Promise<void> {
    const content =
      inst.content ??
      (inst.content_url ? await this.fetchContent(inst.content_url) : "");
    if (!content) {
      console.warn(
        `[HubSync] syncSkill: no content for ${inst.package_id}`,
      );
      return;
    }

    // 用 package_id 作为本地 name 和 hub_slug
    // （Phase 2 package 系统中 package_id 是 UUID；Hub 端的 human-readable 名称
    //   目前未在 SkillSyncInstruction 中传递，等 Hub 后续扩展再优化）
    const localName = inst.package_id;
    const existing = await this.repos.agentSkill.getByNameAndSource(localName, "hub");

    if (existing) {
      await this.repos.agentSkill.update(existing.id, {
        prompt: content,
        isActive: true,
        version: inst.version ?? existing.version,
      });
    } else {
      await this.repos.agentSkill.create({
        name: localName,
        description: `Synced from Hub (package ${inst.package_id})`,
        prompt: content,
        source: "hub",
        hubSlug: inst.package_id,
        version: inst.version ?? null,
        isActive: true,
      });
    }

    console.log(
      `[HubSync] Synced skill ${inst.package_id} v${inst.version ?? "?"}`,
    );
  }

  /** 强制更新 skill（带 deadline） */
  private async forceUpdateSkill(inst: SkillSyncInstruction): Promise<void> {
    await this.syncSkill(inst);
    if (inst.deadline) {
      console.log(`[HubSync] Force update deadline: ${inst.deadline}`);
    }
  }

  /** 标记本地 skill 为 inactive（不删除，便于审计） */
  private async removeLocalSkill(packageId: string): Promise<void> {
    const existing = await this.repos.agentSkill.getByNameAndSource(packageId, "hub");
    if (existing) {
      await this.repos.agentSkill.update(existing.id, { isActive: false });
      console.log(`[HubSync] Killed skill ${packageId}`);
    } else {
      console.log(`[HubSync] Kill target not found: ${packageId}`);
    }
  }

  /** 回滚 skill（Phase 3 完整实现） */
  private async rollbackSkill(inst: SkillSyncInstruction): Promise<void> {
    console.log(
      `[HubSync] Rollback skill ${inst.package_id} (Phase 3 will implement version rollback)`,
    );
  }

  /** 从 URL 获取 skill 内容 */
  private async fetchContent(url: string): Promise<string> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch content failed: ${resp.status}`);
    return await resp.text();
  }
}
