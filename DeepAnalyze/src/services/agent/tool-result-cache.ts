// =============================================================================
// DeepAnalyze - Tool Result Cache
// =============================================================================
// In-memory cache for tool results within a single session. Prevents the model
// from re-running identical searches after context compaction forgets previous
// results.
//
// Reference: Design doc R4.7 "工具调用结果缓存"
// =============================================================================

import type { ChatMessage } from "../../models/provider.js";

interface CacheEntry {
  /** The tool result content (already serialized) */
  content: string;
  /** Timestamp when cached */
  timestamp: number;
  /** Tool name for debugging */
  toolName: string;
}

/**
 * Cache key: combination of tool name and sorted arguments.
 * Two calls with the same tool and same arguments should produce the same key.
 */
function buildCacheKey(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = Object.keys(args)
    .sort()
    .map(k => `${k}=${JSON.stringify(args[k])}`)
    .join("&");
  return `${toolName}:${sortedArgs}`;
}

/**
 * Tools whose results are worth caching. Search tools benefit the most
 * since re-running them wastes API calls and time. Write tools are NOT cached
 * since they modify state.
 */
const CACHEABLE_TOOLS = new Set([
  "kb_search",
  "web_search",
  "mcp__minimax_websearch__web_search",
  "wikipedia",
  "web_fetch",
  "doc_grep",
  "glob",
  "bash",       // Read-only bash commands benefit from caching
]);

export class ToolResultCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private maxAgeMs: number;
  private hits = 0;
  private misses = 0;

  constructor(options?: { maxSize?: number; maxAgeMs?: number }) {
    this.maxSize = options?.maxSize ?? 50;
    this.maxAgeMs = options?.maxAgeMs ?? 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Check if a tool is cacheable.
   */
  isCacheable(toolName: string, args: Record<string, unknown>): boolean {
    if (!CACHEABLE_TOOLS.has(toolName)) return false;
    // For bash, only cache read-only commands (no write operations)
    if (toolName === "bash") {
      const cmd = typeof args.command === "string" ? args.command : "";
      // Skip commands that modify state
      if (/\b(rm|mv|cp|mkdir|write|echo\s*>|tee|pip|npm|apt|curl.*-X\s*(POST|PUT|DELETE)|wget)/i.test(cmd)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get a cached result if available and not expired.
   */
  get(toolName: string, args: Record<string, unknown>): string | null {
    const key = buildCacheKey(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check expiry
    if (Date.now() - entry.timestamp > this.maxAgeMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.content;
  }

  /**
   * Store a tool result in the cache.
   */
  set(toolName: string, args: Record<string, unknown>, content: string): void {
    const key = buildCacheKey(toolName, args);

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      content,
      timestamp: Date.now(),
      toolName,
    });
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { size: number; hitRate: number; hits: number; misses: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
