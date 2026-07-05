// =============================================================================
// DeepAnalyze - Feishu (Lark) Channel
// Skeleton implementation with testConnection
// =============================================================================

import { BaseChannel } from "./channel-base.js";
import type { FeishuConfig, TestResult } from "./types.js";

export class FeishuChannel extends BaseChannel {
  readonly channelId = "feishu";
  readonly name = "飞书";

  private config: FeishuConfig;

  constructor(config: FeishuConfig) {
    super();
    this.config = config;
  }

  async testConnection(): Promise<TestResult> {
    if (!this.config.app_id || !this.config.app_secret) {
      return { success: false, message: "缺少 app_id 或 app_secret" };
    }

    try {
      const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.app_id,
          app_secret: this.config.app_secret,
        }),
      });

      const data = await resp.json() as { code: number; msg: string; tenant_access_token?: string };

      if (data.code === 0 && data.tenant_access_token) {
        return { success: true, message: "连接成功! tenant_access_token 已获取" };
      }
      return { success: false, message: `认证失败: ${data.msg} (code: ${data.code})` };
    } catch (err) {
      return { success: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
