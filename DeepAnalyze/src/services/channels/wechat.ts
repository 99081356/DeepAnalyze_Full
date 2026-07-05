// =============================================================================
// DeepAnalyze - WeChat Channel
// Skeleton implementation with testConnection
// =============================================================================

import { BaseChannel } from "./channel-base.js";
import type { WeChatConfig, TestResult } from "./types.js";

export class WeChatChannel extends BaseChannel {
  readonly channelId = "wechat";
  readonly name = "微信";

  private config: WeChatConfig;

  constructor(config: WeChatConfig) {
    super();
    this.config = config;
  }

  async testConnection(): Promise<TestResult> {
    if (!this.config.app_id || !this.config.app_secret) {
      return { success: false, message: "缺少 app_id 或 app_secret" };
    }

    try {
      const resp = await fetch(
        `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.config.app_id}&secret=${this.config.app_secret}`,
      );

      const data = await resp.json() as { access_token?: string; errmsg?: string; errcode?: number };

      if (data.access_token) {
        return { success: true, message: "连接成功! access_token 已获取" };
      }
      return { success: false, message: `认证失败: ${data.errmsg ?? "未知错误"} (${data.errcode})` };
    } catch (err) {
      return { success: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
