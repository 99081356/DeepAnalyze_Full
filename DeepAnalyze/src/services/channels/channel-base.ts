// =============================================================================
// DeepAnalyze - Channel Base Interface
// Defines the contract all channel implementations must satisfy
// =============================================================================

import type { TestResult } from "./types.js";

export interface IChannel {
  /** Unique channel identifier (e.g. "feishu", "telegram") */
  readonly channelId: string;

  /** Human-readable name */
  readonly name: string;

  /** Start listening for inbound messages */
  start(): Promise<void>;

  /** Stop and cleanup resources */
  stop(): Promise<void>;

  /** Test connectivity with current config */
  testConnection(): Promise<TestResult>;

  /** Send a message to a specific chat */
  sendMessage(chatId: string, message: string): Promise<void>;

  /** Whether the channel is currently running */
  isRunning(): boolean;
}

/**
 * Base channel implementation with common utilities.
 * Concrete channels extend this class.
 */
export abstract class BaseChannel implements IChannel {
  abstract readonly channelId: string;
  abstract readonly name: string;

  protected running = false;

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Channel:${this.channelId}] Started`);
  }

  async stop(): Promise<void> {
    this.running = false;
    console.log(`[Channel:${this.channelId}] Stopped`);
  }

  abstract testConnection(): Promise<TestResult>;

  async sendMessage(_chatId: string, _message: string): Promise<void> {
    // Default: not implemented
    console.log(`[Channel:${this.channelId}] sendMessage not yet implemented`);
  }

  isRunning(): boolean {
    return this.running;
  }
}
