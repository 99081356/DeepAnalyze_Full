import { create } from 'zustand';
import { api } from '../api/client';
import type { HubSyncState, MarketplaceSkillItem } from '../types/index';

interface HubState {
  // State
  syncState: HubSyncState | null;
  isWorkerMode: boolean | null; // null = not yet detected
  marketplaceItems: MarketplaceSkillItem[];     // 累积列表（append 或 replace）
  marketplaceTotal: number;                     // 服务端总数
  marketplacePage: number;                      // 已加载到的最后一页（1-based）
  marketplaceSearch: string;                    // 当前服务端搜索词（debounce 后落定）
  loading: boolean;                             // 首次/搜索切换加载（replace 模式）
  loadingMore: boolean;                         // 滚动加载下一页（append 模式）
  hasMore: boolean;                             // 是否还有更多页可加载
  syncing: boolean;

  // Actions
  detectRunMode: () => Promise<void>;
  fetchSyncState: () => Promise<void>;
  syncConfig: () => Promise<void>;
  fetchMarketplaceSkills: (
    page?: number,
    search?: string,
    mode?: 'replace' | 'append',
  ) => Promise<void>;
}

export const useHubStore = create<HubState>((set, get) => ({
  syncState: null,
  isWorkerMode: null,
  marketplaceItems: [],
  marketplaceTotal: 0,
  marketplacePage: 1,
  marketplaceSearch: '',
  loading: false,
  loadingMore: false,
  hasMore: false,
  syncing: false,

  detectRunMode: async () => {
    try {
      const state = await api.getHubSyncState();
      set({ isWorkerMode: true, syncState: state });
    } catch {
      set({ isWorkerMode: false });
    }
  },

  fetchSyncState: async () => {
    try {
      const state = await api.getHubSyncState();
      set({ syncState: state });
    } catch {
      // ignore
    }
  },

  syncConfig: async () => {
    set({ syncing: true });
    try {
      const result = await api.syncConfig();
      if (result.success) {
        await get().fetchSyncState();
      }
    } catch {
      // ignore
    } finally {
      set({ syncing: false });
    }
  },

  fetchMarketplaceSkills: async (page, search, mode = 'replace') => {
    const p = page ?? get().marketplacePage;
    const s = search ?? get().marketplaceSearch;

    if (mode === 'replace') {
      set({ loading: true });
    } else {
      set({ loadingMore: true });
    }

    try {
      const result = await api.listMarketplaceSkills(p, 20, s);
      const items = result?.items ?? [];
      const total = result?.total ?? 0;

      set((state) => {
        const baseItems = mode === 'replace' ? [] : state.marketplaceItems;
        // 按 slug 去重（append 模式防御性去重，避免服务端重复返回）
        const existingSlugs = new Set(baseItems.map((it) => it.slug));
        const dedupedNew = items.filter((it) => !existingSlugs.has(it.slug));
        const merged = [...baseItems, ...dedupedNew];

        return {
          marketplaceItems: merged,
          marketplaceTotal: total,
          marketplacePage: p,
          marketplaceSearch: s,
          hasMore: merged.length < total && items.length > 0,
        };
      });
    } catch {
      // 失败时不清空列表（避免清屏），仅更新 loading 标志
      // state 字段（marketplacePage / marketplaceSearch）保持原值不动
    } finally {
      set({ loading: false, loadingMore: false });
    }
  },
}));
