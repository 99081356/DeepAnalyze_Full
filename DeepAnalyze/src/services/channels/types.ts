// =============================================================================
// DeepAnalyze - Channel Types
// Type definitions for the communication channel system
// =============================================================================

// ---------------------------------------------------------------------------
// Individual channel config interfaces
// ---------------------------------------------------------------------------

export interface FeishuConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  encrypt_key?: string;
  verification_token?: string;
  allow_from: string[];
}

export interface DingTalkConfig {
  enabled: boolean;
  client_id: string;
  client_secret: string;
  allow_from: string[];
}

export interface WeChatConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  token: string;
  encoding_aes_key?: string;
  allow_from: string[];
}

export interface QQConfig {
  enabled: boolean;
  app_id: string;
  app_secret: string;
  allow_from: string[];
  markdown_enabled: boolean;
  group_markdown_enabled: boolean;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  proxy?: string;
  allow_from: string[];
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  application_id?: string;
  guild_id?: string;
  allow_from: string[];
}

// ---------------------------------------------------------------------------
// Aggregated config type
// ---------------------------------------------------------------------------

export interface ChannelsConfig {
  feishu: FeishuConfig;
  dingtalk: DingTalkConfig;
  wechat: WeChatConfig;
  qq: QQConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
}

/** Channel IDs — used as keys in ChannelsConfig and API paths */
export type ChannelId = keyof ChannelsConfig;

export const CHANNEL_IDS: ChannelId[] = ["feishu", "dingtalk", "wechat", "qq", "telegram", "discord"];

// ---------------------------------------------------------------------------
// Channel metadata (static info for each channel)
// ---------------------------------------------------------------------------

export interface ChannelMeta {
  id: ChannelId;
  name: string;
  description: string;
  icon: string; // emoji or lucide icon name
}

export const CHANNEL_META: Record<ChannelId, ChannelMeta> = {
  feishu: {
    id: "feishu",
    name: "飞书",
    description: "Lark / Feishu 机器人，支持文本、卡片消息",
    icon: "MessageCircle",
  },
  dingtalk: {
    id: "dingtalk",
    name: "钉钉",
    description: "DingTalk 机器人，支持文本、Markdown 消息",
    icon: "Bell",
  },
  wechat: {
    id: "wechat",
    name: "微信",
    description: "微信公众号 / 企业微信",
    icon: "Smartphone",
  },
  qq: {
    id: "qq",
    name: "QQ",
    description: "QQ 机器人，支持私聊、群聊",
    icon: "Users",
  },
  telegram: {
    id: "telegram",
    name: "Telegram",
    description: "Telegram Bot，支持文本、媒体消息",
    icon: "Send",
  },
  discord: {
    id: "discord",
    name: "Discord",
    description: "Discord Bot，支持文本、Embed 消息",
    icon: "Hash",
  },
};

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

export interface ChannelInfo {
  id: ChannelId;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
}

export interface ChannelStatus {
  enabled: boolean;
  running: boolean;
  displayName: string;
}

export interface TestResult {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Default configs (factory functions)
// ---------------------------------------------------------------------------

export function defaultFeishuConfig(): FeishuConfig {
  return { enabled: false, app_id: "", app_secret: "", allow_from: [] };
}
export function defaultDingTalkConfig(): DingTalkConfig {
  return { enabled: false, client_id: "", client_secret: "", allow_from: [] };
}
export function defaultWeChatConfig(): WeChatConfig {
  return { enabled: false, app_id: "", app_secret: "", token: "", allow_from: [] };
}
export function defaultQQConfig(): QQConfig {
  return { enabled: false, app_id: "", app_secret: "", allow_from: [], markdown_enabled: true, group_markdown_enabled: true };
}
export function defaultTelegramConfig(): TelegramConfig {
  return { enabled: false, token: "", allow_from: [] };
}
export function defaultDiscordConfig(): DiscordConfig {
  return { enabled: false, token: "", allow_from: [] };
}

export function defaultChannelsConfig(): ChannelsConfig {
  return {
    feishu: defaultFeishuConfig(),
    dingtalk: defaultDingTalkConfig(),
    wechat: defaultWeChatConfig(),
    qq: defaultQQConfig(),
    telegram: defaultTelegramConfig(),
    discord: defaultDiscordConfig(),
  };
}

// ---------------------------------------------------------------------------
// Config type map (for type-safe channel lookup)
// ---------------------------------------------------------------------------

export type ChannelConfigMap = {
  feishu: FeishuConfig;
  dingtalk: DingTalkConfig;
  wechat: WeChatConfig;
  qq: QQConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
};
