// =============================================================================
// DeepAnalyze - Telegram Channel
// Skeleton implementation with testConnection
// =============================================================================

import { BaseChannel } from "./channel-base.js";
import type { TelegramConfig, TestResult } from "./types.js";

export class TelegramChannel extends BaseChannel {
  readonly channelId = "telegram";
  readonly name = "Telegram";

  private config: TelegramConfig;

  constructor(config: TelegramConfig) {
    super();
    this.config = config;
  }

  async testConnection(): Promise<TestResult> {
    if (!this.config.token) {
      return { success: false, message: "缺少 Bot Token" };
    }

    try {
      const apiBase = this.config.proxy || "https://api.telegram.org";
      const resp = await fetch(`${apiBase}/bot${this.config.token}/getMe`);

      const data = await resp.json() as { ok: boolean; result?: { username: string; first_name: string }; description?: string };

      if (data.ok && data.result) {
        return { success: true, message: `连接成功! Bot: @${data.result.username} (${data.result.first_name})` };
      }
      return { success: false, message: `认证失败: ${data.description ?? "无效的 Token"}` };
    } catch (err) {
      return { success: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
