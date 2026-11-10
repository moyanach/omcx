import { StateCreator } from "zustand";
import type { ChatState, WorkbenchTab } from "../chatStore";

export interface WorkbenchSlice {
  workbenchOpen: boolean;
  workbenchWidth: number;
  workbenchMaximized: boolean;
  workbenchTabs: WorkbenchTab[];
  activeWorkbenchTabId: string;
  autoOpenHtmlOutputs: boolean;
  pendingMentionInsert: string | null;

  setWorkbenchOpen: (open: boolean) => void;
  setWorkbenchWidth: (width: number) => void;
  setWorkbenchMaximized: (maximized: boolean) => void;
  setAutoOpenHtmlOutputs: (enabled: boolean) => Promise<void>;
  setPendingMentionInsert: (text: string | null) => void;
  addWorkbenchTab: (tab?: Partial<WorkbenchTab>) => void;
  closeWorkbenchTab: (tabId: string) => void;
  setActiveWorkbenchTab: (tabId: string) => void;
  updateWorkbenchTab: (tabId: string, patch: Partial<WorkbenchTab>) => void;
  openUrlInWorkbench: (url: string, title?: string, filePath?: string) => void;
  openFileInWorkbench: (
    filePath: string,
    options?: { line?: number; lineEnd?: number; viewMode?: "preview" | "code" }
  ) => void;
  openDiffInWorkbench: (filePath?: string) => void;
  openTerminalInWorkbench: () => void;
}

export const createWorkbenchSlice: StateCreator<
  ChatState,
  [],
  [],
  WorkbenchSlice
> = (set, get) => ({
  workbenchOpen: false,
  workbenchWidth: 560,
  workbenchMaximized: true,
  workbenchTabs: [{ id: "t_home", title: "工具台", type: "newtab" }],
  activeWorkbenchTabId: "t_home",
  autoOpenHtmlOutputs: true,
  pendingMentionInsert: null,

  setWorkbenchOpen: (open) => set({ workbenchOpen: open }),
  setWorkbenchWidth: (width) => {
    const maxW =
      typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.9) : 1800;
    set({ workbenchWidth: Math.max(400, Math.min(maxW, Math.round(width))) });
  },
  setWorkbenchMaximized: (maximized) => set({ workbenchMaximized: maximized }),
  setPendingMentionInsert: (text) => set({ pendingMentionInsert: text }),

  setAutoOpenHtmlOutputs: async (enabled) => {
    set({ autoOpenHtmlOutputs: enabled });
    if (window.electronAPI?.setConfig) {
      try {
        await window.electronAPI.setConfig("auto_open_html_outputs", enabled ? "true" : "false");
      } catch (err) {
        console.error("保存自动打开产物配置失败:", err);
      }
    }
  },

  addWorkbenchTab: (tab) => {
    const newId = tab?.id || `tab_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    const newTab: WorkbenchTab = {
      id: newId,
      title: tab?.title || "新标签页",
      type: tab?.type || "newtab",
      url: tab?.url,
      filePath: tab?.filePath,
      lineNumber: tab?.lineNumber,
      viewMode: tab?.viewMode,
      refreshKey: Date.now(),
    };
    set((state) => ({
      workbenchOpen: true,
      workbenchTabs: [...state.workbenchTabs, newTab],
      activeWorkbenchTabId: newId,
    }));
  },

  closeWorkbenchTab: (tabId) => {
    set((state) => {
      if (state.workbenchTabs.length <= 1) {
        return {
          workbenchOpen: false,
          workbenchTabs: [{ id: "t_home", title: "工具台", type: "newtab" }],
          activeWorkbenchTabId: "t_home",
        };
      }
      const filtered = state.workbenchTabs.filter((t) => t.id !== tabId);
      const nextActive =
        state.activeWorkbenchTabId === tabId
          ? filtered[filtered.length - 1].id
          : state.activeWorkbenchTabId;
      return {
        workbenchTabs: filtered,
        activeWorkbenchTabId: nextActive,
      };
    });
  },

  setActiveWorkbenchTab: (tabId) => set({ activeWorkbenchTabId: tabId }),

  updateWorkbenchTab: (tabId, patch) =>
    set((state) => ({
      workbenchTabs: state.workbenchTabs.map((t) =>
        t.id === tabId ? { ...t, ...patch } : t
      ),
    })),

  openUrlInWorkbench: (url, title, filePath) => {
    set((state) => {
      const existing = state.workbenchTabs.find(
        (t) =>
          t.type === "url" &&
          ((filePath && t.filePath === filePath) || (!filePath && t.url === url))
      );
      const displayTitle =
        title ||
        (filePath ? filePath.split(/[\\/]/).pop() : url.replace(/^https?:\/\//, "")) ||
        "网页预览";

      if (existing) {
        return {
          workbenchOpen: true,
          activeWorkbenchTabId: existing.id,
          workbenchTabs: state.workbenchTabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  title: displayTitle,
                  url,
                  filePath: filePath || t.filePath,
                  refreshKey: Date.now(),
                }
              : t
          ),
        };
      }

      const activeTab = state.workbenchTabs.find((t) => t.id === state.activeWorkbenchTabId);
      if (activeTab && activeTab.type === "newtab") {
        return {
          workbenchOpen: true,
          workbenchTabs: state.workbenchTabs.map((t) =>
            t.id === activeTab.id
              ? {
                  ...t,
                  title: displayTitle,
                  type: "url",
                  url,
                  filePath,
                  viewMode: "preview",
                  refreshKey: Date.now(),
                }
              : t
          ),
        };
      }

      const newId = `tab_url_${Date.now()}`;
      return {
        workbenchOpen: true,
        activeWorkbenchTabId: newId,
        workbenchTabs: [
          ...state.workbenchTabs,
          {
            id: newId,
            title: displayTitle,
            type: "url",
            url,
            filePath,
            viewMode: "preview",
            refreshKey: Date.now(),
          },
        ],
      };
    });
  },

  openFileInWorkbench: (filePath, options) => {
    const cleanPath = String(filePath || "").trim();
    if (!cleanPath) return;
    const lower = cleanPath.toLowerCase();

    if ((lower.endsWith(".html") || lower.endsWith(".htm")) && options?.viewMode !== "code") {
      const activeSess = get().sessions.find((s) => s.id === get().activeSessionId);
      const workDir = activeSess?.workDir || "";
      const absPath =
        cleanPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(cleanPath)
          ? cleanPath
          : workDir
          ? `${workDir.replace(/\/+$/, "")}/${cleanPath.replace(/^\.?\//, "")}`
          : cleanPath;
      const localUrl = `local-media://local${encodeURI(absPath)}`;
      get().openUrlInWorkbench(localUrl, cleanPath.split(/[\\/]/).pop(), absPath);
      return;
    }

    set((state) => {
      const shortName = cleanPath.split(/[\\/]/).pop() || cleanPath;
      const existing = state.workbenchTabs.find((t) => t.type === "files");
      const defaultMode =
        options?.viewMode ||
        (lower.endsWith(".md") ||
        lower.endsWith(".markdown") ||
        lower.endsWith(".svg") ||
        lower.endsWith(".png") ||
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg") ||
        lower.endsWith(".webp") ||
        lower.endsWith(".gif")
          ? "preview"
          : "code");

      if (existing) {
        return {
          workbenchOpen: true,
          activeWorkbenchTabId: existing.id,
          workbenchTabs: state.workbenchTabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  title: `文件 · ${shortName}`,
                  filePath: cleanPath,
                  lineNumber: options?.line,
                  lineEnd: options?.lineEnd,
                  viewMode: defaultMode,
                  refreshKey: Date.now(),
                }
              : t
          ),
        };
      }

      const activeTab = state.workbenchTabs.find((t) => t.id === state.activeWorkbenchTabId);
      if (activeTab && activeTab.type === "newtab") {
        return {
          workbenchOpen: true,
          workbenchTabs: state.workbenchTabs.map((t) =>
            t.id === activeTab.id
              ? {
                  ...t,
                  title: `文件 · ${shortName}`,
                  type: "files",
                  filePath: cleanPath,
                  lineNumber: options?.line,
                  lineEnd: options?.lineEnd,
                  viewMode: defaultMode,
                  refreshKey: Date.now(),
                }
              : t
          ),
        };
      }

      const newId = `tab_files_${Date.now()}`;
      return {
        workbenchOpen: true,
        activeWorkbenchTabId: newId,
        workbenchTabs: [
          ...state.workbenchTabs,
          {
            id: newId,
            title: `文件 · ${shortName}`,
            type: "files",
            filePath: cleanPath,
            lineNumber: options?.line,
            lineEnd: options?.lineEnd,
            viewMode: defaultMode,
            refreshKey: Date.now(),
          },
        ],
      };
    });
  },

  openDiffInWorkbench: (filePath) => {
    set((state) => {
      const existing = state.workbenchTabs.find((t) => t.type === "changes");
      if (existing) {
        return {
          workbenchOpen: true,
          activeWorkbenchTabId: existing.id,
          workbenchTabs: state.workbenchTabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  filePath: filePath || t.filePath,
                  refreshKey: Date.now(),
                }
              : t
          ),
        };
      }

      const activeTab = state.workbenchTabs.find((t) => t.id === state.activeWorkbenchTabId);
      if (activeTab && activeTab.type === "newtab") {
        return {
          workbenchOpen: true,
          workbenchTabs: state.workbenchTabs.map((t) =>
            t.id === activeTab.id
              ? {
                  ...t,
                  title: "代码变更",
                  type: "changes",
                  filePath,
                  refreshKey: Date.now(),
                }
              : t
          ),
        };
      }

      const newId = `tab_changes_${Date.now()}`;
      return {
        workbenchOpen: true,
        activeWorkbenchTabId: newId,
        workbenchTabs: [
          ...state.workbenchTabs,
          {
            id: newId,
            title: "代码变更",
            type: "changes",
            filePath,
            refreshKey: Date.now(),
          },
        ],
      };
    });
  },

  openTerminalInWorkbench: () => {
    set((state) => {
      const existing = state.workbenchTabs.find((t) => t.type === "terminal");
      if (existing) {
        return {
          workbenchOpen: true,
          activeWorkbenchTabId: existing.id,
        };
      }

      const activeTab = state.workbenchTabs.find((t) => t.id === state.activeWorkbenchTabId);
      if (activeTab && activeTab.type === "newtab") {
        return {
          workbenchOpen: true,
          workbenchTabs: state.workbenchTabs.map((t) =>
            t.id === activeTab.id
              ? {
                  ...t,
                  title: "集成终端",
                  type: "terminal",
                  refreshKey: Date.now(),
                }
              : t
          ),
        };
      }

      const newId = `tab_term_${Date.now()}`;
      return {
        workbenchOpen: true,
        activeWorkbenchTabId: newId,
        workbenchTabs: [
          ...state.workbenchTabs,
          {
            id: newId,
            title: "集成终端",
            type: "terminal",
            refreshKey: Date.now(),
          },
        ],
      };
    });
  },
});
