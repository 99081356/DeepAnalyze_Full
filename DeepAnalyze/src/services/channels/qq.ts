// =============================================================================
// DeepAnalyze - QQ Channel
// Skeleton implementation with testConnection
// =============================================================================

import { BaseChannel } from "./channel-base.js";
import type { QQConfig, TestResult } from "./types.js";

export class QQChannel extends BaseChannel {
  readonly channelId = "qq";
  readonly name = "QQ";

  private config: QQConfig;

  constructor(config: QQConfig) {
    super();
    this.config = config;
  }

  async testConnection(): Promise<TestResult> {
    if (!this.config.app_id || !this.config.app_secret) {
      return { success: false, message: "缺少 app_id 或 app_secret" };
    }

    try {
      // QQ Bot API — get access token
      const resp = await fetch("https://bots.qq.com/app/getAppAccessToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: this.config.app_id,
          clientSecret: this.config.app_secret,
        }),
      });

      const data = await resp.json() as { access_token?: string; message?: string };

      if (data.access_token) {
        return { success: true, message: "连接成功! access_token 已获取" };
      }
      return { success: false, message: `认证失败: ${data.message ?? "请检查 app_id 和 app_secret"}` };
    } catch (err) {
      return { success: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
