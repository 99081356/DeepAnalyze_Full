// =============================================================================
// DeepAnalyze - Discord Channel
// Skeleton implementation with testConnection
// =============================================================================

import { BaseChannel } from "./channel-base.js";
import type { DiscordConfig, TestResult } from "./types.js";

export class DiscordChannel extends BaseChannel {
  readonly channelId = "discord";
  readonly name = "Discord";

  private config: DiscordConfig;

  constructor(config: DiscordConfig) {
    super();
    this.config = config;
  }

  async testConnection(): Promise<TestResult> {
    if (!this.config.token) {
      return { success: false, message: "缺少 Bot Token" };
    }

    try {
      const resp = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${this.config.token}` },
      });

      if (resp.ok) {
        const data = await resp.json() as { username?: string; id?: string };
        return { success: true, message: `连接成功! Bot: ${data.username ?? "Unknown"} (${data.id ?? "?"})` };
      }

      if (resp.status === 401) {
        return { success: false, message: "认证失败: 无效的 Bot Token" };
      }
      return { success: false, message: `认证失败: HTTP ${resp.status}` };
    } catch (err) {
      return { success: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
