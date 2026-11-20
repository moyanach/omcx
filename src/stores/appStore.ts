import { create } from "zustand";

export type View = "chat" | "settings";
export type NavTab = "sessions" | "automations" | "tools" | "workspaces" | "settings";
export type ThemeMode = "light" | "dark" | "system";

const LEFT_SIDEBAR_WIDTH_KEY = "omcx.left_sidebar_width";
const DEFAULT_LEFT_SIDEBAR_WIDTH = 280;
const MIN_LEFT_SIDEBAR_WIDTH = 220;
const MAX_LEFT_SIDEBAR_WIDTH = 520;
const LEFT_SIDEBAR_COLLAPSED_KEY = "omcx.left_sidebar_collapsed";

const INSPECTOR_WIDTH_KEY = "omcx.inspector_width";
const DEFAULT_INSPECTOR_WIDTH = 325;
const MIN_INSPECTOR_WIDTH = 260;
const MAX_INSPECTOR_WIDTH = 560;

const MASCOT_ENABLED_KEY = "omcx.mascot_enabled";
const MASCOT_POSITION_KEY = "omcx.mascot_position";

export interface MascotPosition {
  right: number;
  bottom: number;
}

const clampLeftSidebarWidth = (width: number) =>
  Math.max(
    MIN_LEFT_SIDEBAR_WIDTH,
    Math.min(MAX_LEFT_SIDEBAR_WIDTH, Math.round(width))
  );

const clampInspectorWidth = (width: number) =>
  Math.max(
    MIN_INSPECTOR_WIDTH,
    Math.min(MAX_INSPECTOR_WIDTH, Math.round(width))
  );

const readLeftSidebarWidth = () => {
  if (typeof window === "undefined") return DEFAULT_LEFT_SIDEBAR_WIDTH;
  try {
    const raw = Number(window.localStorage.getItem(LEFT_SIDEBAR_WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0
      ? clampLeftSidebarWidth(raw)
      : DEFAULT_LEFT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_LEFT_SIDEBAR_WIDTH;
  }
};

const readLeftSidebarCollapsed = () => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LEFT_SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
};

const readInspectorWidth = () => {
  if (typeof window === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  try {
    const raw = Number(window.localStorage.getItem(INSPECTOR_WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0
      ? clampInspectorWidth(raw)
      : DEFAULT_INSPECTOR_WIDTH;
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
};

const readMascotEnabled = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(MASCOT_ENABLED_KEY);
    return raw === null ? true : raw !== "false";
  } catch {
    return true;
  }
};

const readMascotPosition = (): MascotPosition | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MASCOT_POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.right === "number" &&
      Number.isFinite(parsed.right) &&
      typeof parsed.bottom === "number" &&
      Number.isFinite(parsed.bottom)
    ) {
      return { right: parsed.right, bottom: parsed.bottom };
    }
    return null;
  } catch {
    return null;
  }
};

interface AppState {
  activeView: View;
  setActiveView: (view: View) => void;
  activeNavTab: NavTab;
  setActiveNavTab: (tab: NavTab) => void;
  /** 设置弹出层是否打开（不再切换主视图，会话保持挂载） */
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  currentWorkDir: string | null;
  setCurrentWorkDir: (dir: string | null) => void;
  /** 左侧菜单栏拖拽宽度（持久化到 localStorage） */
  leftSidebarWidth: number;
  setLeftSidebarWidth: (width: number) => void;
  /** 左侧菜单栏是否收起为纯图标列 */
  leftSidebarCollapsed: boolean;
  setLeftSidebarCollapsed: (collapsed: boolean) => void;
  toggleLeftSidebarCollapsed: () => void;
  /** 右侧监控面板拖拽宽度（持久化到 localStorage） */
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
  /** 跨视图跳转至工具中心的意图（如自动切换 MCP 标签并打开添加向导） */
  toolsIntent: { tab?: "skills" | "subagents" | "mcp"; openConnectorWizard?: boolean } | null;
  setToolsIntent: (
    intent: { tab?: "skills" | "subagents" | "mcp"; openConnectorWizard?: boolean } | null
  ) => void;
  /** 定时任务收件箱未读结果数量 */
  unreadAutomationRuns: number;
  setUnreadAutomationRuns: (count: number) => void;
  /** 常驻对话状态吉祥物开关与自定义拖拽位置（null = 默认停靠输入框右上角） */
  mascotEnabled: boolean;
  setMascotEnabled: (enabled: boolean) => void;
  mascotPosition: MascotPosition | null;
  setMascotPosition: (pos: MascotPosition | null) => void;
  resetMascotPosition: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeView: "chat",
  setActiveView: (view) => set({ activeView: view }),
  activeNavTab: "sessions",
  setActiveNavTab: (tab) => {
    if (tab === "settings") {
      // 设置改为覆盖式弹出层：保持当前视图与会话挂载，仅打开弹层
      set({ settingsOpen: true });
    } else {
      set({ activeNavTab: tab, activeView: "chat" });
    }
  },
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  theme: "system",
  setTheme: (mode) => set({ theme: mode }),
  currentWorkDir: null,
  setCurrentWorkDir: (dir) => set({ currentWorkDir: dir }),
  leftSidebarWidth: readLeftSidebarWidth(),
  setLeftSidebarWidth: (width) => {
    const next = clampLeftSidebarWidth(width);
    set({ leftSidebarWidth: next });
    try {
      window.localStorage.setItem(LEFT_SIDEBAR_WIDTH_KEY, String(next));
    } catch {}
  },
  leftSidebarCollapsed: readLeftSidebarCollapsed(),
  setLeftSidebarCollapsed: (collapsed) => {
    set({ leftSidebarCollapsed: collapsed });
    try {
      window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {}
  },
  toggleLeftSidebarCollapsed: () =>
    set((state) => {
      const next = !state.leftSidebarCollapsed;
      try {
        window.localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {}
      return { leftSidebarCollapsed: next };
    }),
  inspectorWidth: readInspectorWidth(),
  setInspectorWidth: (width) => {
    const next = clampInspectorWidth(width);
    set({ inspectorWidth: next });
    try {
      window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(next));
    } catch {}
  },
  toolsIntent: null,
  setToolsIntent: (intent) => set({ toolsIntent: intent }),
  unreadAutomationRuns: 0,
  setUnreadAutomationRuns: (count) => set({ unreadAutomationRuns: Math.max(0, Number(count) || 0) }),
  mascotEnabled: readMascotEnabled(),
  setMascotEnabled: (enabled) => {
    set({ mascotEnabled: Boolean(enabled) });
    try {
      window.localStorage.setItem(MASCOT_ENABLED_KEY, String(Boolean(enabled)));
    } catch {}
  },
  mascotPosition: readMascotPosition(),
  setMascotPosition: (pos) => {
    set({ mascotPosition: pos });
    try {
      if (pos) {
        window.localStorage.setItem(MASCOT_POSITION_KEY, JSON.stringify(pos));
      } else {
        window.localStorage.removeItem(MASCOT_POSITION_KEY);
      }
    } catch {}
  },
  resetMascotPosition: () => {
    set({ mascotPosition: null });
    try {
      window.localStorage.removeItem(MASCOT_POSITION_KEY);
    } catch {}
  },
}));
