// =============================================================================
// DeepAnalyze - ChannelManager
// Manages lifecycle of all communication channel instances
// =============================================================================

import { getRepos } from "../../store/repos/index.js";
import { IChannel } from "./channel-base.js";
import {
  type ChannelId,
  type ChannelsConfig,
  type ChannelInfo,
  type ChannelStatus,
  type TestResult,
  CHANNEL_IDS,
  CHANNEL_META,
  defaultChannelsConfig,
} from "./types.js";

export class ChannelManager {
  private channels = new Map<string, IChannel>();
  private configs: ChannelsConfig;
  private _repos: Awaited<ReturnType<typeof getRepos>> | null = null;

  private async getReposInstance() {
    if (!this._repos) this._repos = await getRepos();
    return this._repos;
  }

  constructor() {
    // Start with defaults; init() will load from DB
    this.configs = defaultChannelsConfig();
  }

  /** Load persisted channel configs from the database. Call after construction. */
  async init(): Promise<void> {
    this.configs = await this.loadConfigs();
  }

  // -----------------------------------------------------------------------
  // Config management
  // -----------------------------------------------------------------------

  private async loadConfigs(): Promise<ChannelsConfig> {
    const repos = await this.getReposInstance();
    const raw = await repos.settings.get("channels");
    if (!raw) return defaultChannelsConfig();
    try {
      const parsed = JSON.parse(raw) as Partial<ChannelsConfig>;
      // Merge with defaults to ensure all keys exist
      return { ...defaultChannelsConfig(), ...parsed };
    } catch {
      return defaultChannelsConfig();
    }
  }

  private async saveConfigs(): Promise<void> {
    const repos = await this.getReposInstance();
    await repos.settings.set("channels", JSON.stringify(this.configs));
  }

  getConfigs(): ChannelsConfig {
    return { ...this.configs };
  }

  getConfig<K extends ChannelId>(id: K): ChannelsConfig[K] {
    return this.configs[id] ?? defaultChannelsConfig()[id];
  }

  async updateConfig<K extends ChannelId>(id: K, config: Partial<ChannelsConfig[K]>): Promise<ChannelsConfig[K]> {
    this.configs[id] = { ...this.configs[id], ...config };
    await this.saveConfigs();

    // Restart channel if it was running
    if (this.channels.has(id)) {
      this.restartChannel(id).catch((err) => {
        console.error(`[ChannelManager] Failed to restart ${id}:`, err);
      });
    }

    return this.configs[id];
  }

  // -----------------------------------------------------------------------
  // Channel lifecycle
  // -----------------------------------------------------------------------

  async startChannel(id: ChannelId): Promise<void> {
    if (this.channels.has(id)) return;

    if (!this.isConfigured(id)) {
      throw new Error(`渠道 ${CHANNEL_META[id].name} 尚未配置必要的凭据`);
    }

    const channel = await this.createChannel(id);
    if (!channel) {
      throw new Error(`Unknown channel: ${id}`);
    }

    await channel.start();
    this.channels.set(id, channel);
    console.log(`[ChannelManager] Channel ${id} started`);
  }

  async stopChannel(id: ChannelId): Promise<void> {
    const channel = this.channels.get(id);
    if (!channel) return;

    await channel.stop();
    this.channels.delete(id);
    console.log(`[ChannelManager] Channel ${id} stopped`);
  }

  async restartChannel(id: ChannelId): Promise<void> {
    await this.stopChannel(id);
    if (this.configs[id]?.enabled) {
      await this.startChannel(id);
    }
  }

  async startAll(): Promise<void> {
    const enabledChannels = CHANNEL_IDS.filter((id) => this.configs[id]?.enabled);
    console.log(`[ChannelManager] Starting ${enabledChannels.length} enabled channel(s)`);

    for (const id of enabledChannels) {
      try {
        await this.startChannel(id);
      } catch (err) {
        console.error(`[ChannelManager] Failed to start ${id}:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [id] of this.channels) {
      try {
        await this.stopChannel(id as ChannelId);
      } catch (err) {
        console.error(`[ChannelManager] Error stopping ${id}:`, err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Channel info & status
  // -----------------------------------------------------------------------

  listChannels(): ChannelInfo[] {
    return CHANNEL_IDS.map((id) => {
      const meta = CHANNEL_META[id];
      const config = this.configs[id];
      const channel = this.channels.get(id);
      return {
        id,
        name: meta.name,
        description: meta.description,
        icon: meta.icon,
        enabled: config?.enabled ?? false,
        configured: this.isConfigured(id),
        running: channel?.isRunning() ?? false,
      };
    });
  }

  getStatus(): Record<string, ChannelStatus> {
    const result: Record<string, ChannelStatus> = {};
    for (const id of CHANNEL_IDS) {
      const channel = this.channels.get(id);
      result[id] = {
        enabled: this.configs[id]?.enabled ?? false,
        running: channel?.isRunning() ?? false,
        displayName: CHANNEL_META[id].name,
      };
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Test connection
  // -----------------------------------------------------------------------

  async testConnection(id: ChannelId, tempConfig?: Record<string, unknown>): Promise<TestResult> {
    // Use existing channel instance or create a temp one
    let channel: IChannel | undefined = this.channels.get(id);

    if (!channel) {
      channel = await this.createChannel(id);
      if (!channel) {
        return { success: false, message: `未知的渠道: ${id}` };
      }
    }

    // If tempConfig provided, temporarily apply it
    if (tempConfig) {
      const original = { ...this.configs[id] };
      (this.configs as unknown as Record<string, unknown>)[id] = { ...this.configs[id], ...tempConfig };
      try {
        // Recreate with temp config
        const tempChannel = await this.createChannel(id);
        if (tempChannel) {
          const result = await tempChannel.testConnection();
          return result;
        }
      } finally {
        (this.configs as unknown as Record<string, unknown>)[id] = original;
      }
    }

    return channel.testConnection();
  }

  // -----------------------------------------------------------------------
  // Send message
  // -----------------------------------------------------------------------

  async sendMessage(channelId: ChannelId, chatId: string, message: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} is not running`);
    }
    await channel.sendMessage(chatId, message);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private isConfigured(id: ChannelId): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = this.configs[id] as any;
    if (!config) return false;

    switch (id) {
      case "feishu":
        return !!(config.app_id && config.app_secret);
      case "dingtalk":
        return !!(config.client_id && config.client_secret);
      case "wechat":
        return !!(config.app_id && config.app_secret && config.token);
      case "qq":
        return !!(config.app_id && config.app_secret);
      case "telegram":
        return !!config.token;
      case "discord":
        return !!config.token;
      default:
        return false;
    }
  }

  private async createChannel(id: ChannelId): Promise<IChannel | undefined> {
    if (!this.configs[id]) return undefined;

    try {
      switch (id) {
        case "feishu": {
          const { FeishuChannel } = await import("./feishu.js");
          return new FeishuChannel(this.configs.feishu);
        }
        case "dingtalk": {
          const { DingTalkChannel } = await import("./dingtalk.js");
          return new DingTalkChannel(this.configs.dingtalk);
        }
        case "wechat": {
          const { WeChatChannel } = await import("./wechat.js");
          return new WeChatChannel(this.configs.wechat);
        }
        case "qq": {
          const { QQChannel } = await import("./qq.js");
          return new QQChannel(this.configs.qq);
        }
        case "telegram": {
          const { TelegramChannel } = await import("./telegram.js");
          return new TelegramChannel(this.configs.telegram);
        }
        case "discord": {
          const { DiscordChannel } = await import("./discord.js");
          return new DiscordChannel(this.configs.discord);
        }
        default:
          return undefined;
      }
    } catch (err) {
      console.error(`[ChannelManager] Failed to create channel ${id}:`, err);
      return undefined;
    }
  }
}
