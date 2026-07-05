// =============================================================================
// DeepAnalyze - DingTalk Channel
// Skeleton implementation with testConnection
// =============================================================================

import { BaseChannel } from "./channel-base.js";
import type { DingTalkConfig, TestResult } from "./types.js";

export class DingTalkChannel extends BaseChannel {
  readonly channelId = "dingtalk";
  readonly name = "钉钉";

  private config: DingTalkConfig;

  constructor(config: DingTalkConfig) {
    super();
    this.config = config;
  }

  async testConnection(): Promise<TestResult> {
    if (!this.config.client_id || !this.config.client_secret) {
      return { success: false, message: "缺少 client_id 或 client_secret" };
    }

    try {
      const resp = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appKey: this.config.client_id,
          appSecret: this.config.client_secret,
        }),
      });

      const data = await resp.json() as { expireIn?: number; accessToken?: string; message?: string };

      if (data.accessToken) {
        return { success: true, message: "连接成功! access_token 已获取" };
      }
      return { success: false, message: `认证失败: ${data.message ?? "未知错误"}` };
    } catch (err) {
      return { success: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
