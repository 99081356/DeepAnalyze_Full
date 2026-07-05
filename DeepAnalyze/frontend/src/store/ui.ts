import { create } from 'zustand';
import { storage } from '../utils/storage';

// Global router navigate bridge — registered by App.tsx after router mounts
let _routerNavigate: ((path: string, options?: { replace?: boolean }) => void) | null = null;

export function registerRouterNavigate(
  navigate: (path: string, options?: { replace?: boolean }) => void,
) {
  _routerNavigate = navigate;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type ViewId = 'chat' | 'knowledge' | 'reports' | 'tasks';
export type PanelContentType = 'sessions' | 'plugins' | 'skills' | 'cron' | 'settings' | 'teams' | 'evolution' | 'marketplace' | 'mcp';

interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
}

interface UIState {
  // Theme
  themeMode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setThemeMode: (mode: ThemeMode) => void;

  // Sidebar
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  // Active view
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;

  // Right panel
  rightPanelOpen: boolean;
  rightPanelContentType: PanelContentType | null;
  openRightPanel: (type: PanelContentType) => void;
  closeRightPanel: () => void;

  // Current knowledge base
  currentKbId: string;
  setCurrentKbId: (id: string) => void;

  // Cross-module navigation
  navigateToDoc: (kbId: string, docId: string) => void;
  navigateToWikiPage: (kbId: string, pageId: string) => void;

  // Toasts
  toasts: ToastItem[];
  addToast: (type: ToastItem['type'], message: string) => void;
  removeToast: (id: string) => void;

  // Confirm dialog
  confirmDialog: {
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    variant: 'danger' | 'warning' | 'default';
    onConfirm: () => void;
    onCancel: () => void;
  } | null;
  showConfirm: (options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
  }) => Promise<boolean>;
  resolveConfirm: (result: boolean) => void;
}

let confirmResolver: ((result: boolean) => void) | null = null;

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return getSystemTheme();
  return mode;
}

function applyTheme(theme: 'light' | 'dark') {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // Brief transition class for smooth theme switch
  root.classList.add('theme-transitioning');
  setTimeout(() => root.classList.remove('theme-transitioning'), 400);
}

export const useUIStore = create<UIState>((set, get) => {
  const savedMode = storage.get<ThemeMode>('theme', 'light');
  const initialResolved = resolveTheme(savedMode);

  // Apply theme on init
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', initialResolved);
  }

  return {
    // Theme
    themeMode: savedMode,
    resolvedTheme: initialResolved,
    setThemeMode: (mode) => {
      const resolved = resolveTheme(mode);
      storage.set('theme', mode);
      applyTheme(resolved);
      set({ themeMode: mode, resolvedTheme: resolved });
    },

    // Sidebar
    sidebarCollapsed: storage.get<boolean>('sidebar', false),
    toggleSidebar: () => set((s) => {
      const next = !s.sidebarCollapsed;
      storage.set('sidebar', next);
      return { sidebarCollapsed: next };
    }),

    // Active view
    activeView: 'chat',
    setActiveView: (view) => set({ activeView: view }),

    // Right panel
    rightPanelOpen: false,
    rightPanelContentType: null,
    openRightPanel: (type) => set((s) => {
      // Toggle: if clicking the same panel type that's already open, close it
      if (s.rightPanelOpen && s.rightPanelContentType === type) {
        return { rightPanelOpen: false, rightPanelContentType: null };
      }
      return { rightPanelOpen: true, rightPanelContentType: type };
    }),
    closeRightPanel: () => set({ rightPanelOpen: false, rightPanelContentType: null }),

    // Current knowledge base
    currentKbId: storage.get<string>('kb', ''),
    setCurrentKbId: (id) => {
      storage.set('kb', id);
      set({ currentKbId: id });
    },

    // Cross-module navigation
    navigateToDoc: (kbId, docId) => {
      set({ currentKbId: kbId, activeView: 'knowledge' });
      if (_routerNavigate) {
        _routerNavigate(`/knowledge/${kbId}?docId=${encodeURIComponent(docId)}`);
      } else {
        window.location.hash = `#/knowledge/${kbId}?docId=${encodeURIComponent(docId)}`;
      }
    },
    navigateToWikiPage: (kbId, pageId) => {
      set({ currentKbId: kbId, activeView: 'knowledge' });
      if (_routerNavigate) {
        _routerNavigate(`/knowledge/${kbId}?pageId=${encodeURIComponent(pageId)}`);
      } else {
        window.location.hash = `#/knowledge/${kbId}?pageId=${encodeURIComponent(pageId)}`;
      }
    },

    // Toasts
    toasts: [],
    addToast: (type, message) => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
      setTimeout(() => get().removeToast(id), 4000);
    },
    removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    // Confirm dialog
    confirmDialog: null,
    showConfirm: ({ title, message, confirmLabel = '确定', cancelLabel = '取消', variant = 'default' }) => {
      return new Promise<boolean>((resolve) => {
        confirmResolver = resolve;
        set({
          confirmDialog: {
            open: true,
            title,
            message,
            confirmLabel,
            cancelLabel,
            variant,
            onConfirm: () => get().resolveConfirm(true),
            onCancel: () => get().resolveConfirm(false),
          },
        });
      });
    },
    resolveConfirm: (result) => {
      set({ confirmDialog: null });
      confirmResolver?.(result);
      confirmResolver = null;
    },
  };
});

// Listen for system theme changes
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { themeMode } = useUIStore.getState();
    if (themeMode === 'system') {
      const resolved = getSystemTheme();
      applyTheme(resolved);
      useUIStore.setState({ resolvedTheme: resolved });
    }
  });
}
