import { create } from "zustand";

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  path: string;
  placeholder: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  metadata?: any;
  attachments?: ChatAttachment[];
}

export type PermissionMode = "plan" | "auto-sandbox" | "ask" | "full-access";
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

export interface Session {
  id: string;
  title: string;
  title_source?: string;
  updatedAt: number;
  model?: string;
  workspaceId?: string;
  workDir?: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffort;
  archived?: boolean;
}

export interface ContextBreakdownItem {
  tokens: number;
  formatted: string;
  percent: number;
  color: string;
  label: string;
}

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  content: string;
  attachments?: ChatAttachment[];
  modelId?: string;
  enableTools?: boolean;
  createdAt: number;
}

export interface CompactionInfo {
  at: number;
  beforeTokens: number;
  afterTokens: number;
  keptMessages: number;
  summarizedMessages: number;
}

export interface ContextMetrics {  totalLimit: number;
  totalLimitFormatted: string;
  usedTokens: number;
  usedTokensFormatted: string;
  usedPercent: number;
  breakdown: {
    messages: ContextBreakdownItem;
    systemTools: ContextBreakdownItem;
    systemPrompt: ContextBreakdownItem;
    skills: ContextBreakdownItem;
    freeSpace: ContextBreakdownItem;
  };
}

export interface SessionOutput {
  id: string;
  name: string;
  filePath: string;
  fileType: string;
  createdAt: number;
}

export interface WorkbenchTab {
  id: string;
  title: string;
  type: "newtab" | "url" | "files" | "changes" | "terminal";
  url?: string;
  filePath?: string;
  lineNumber?: number;
  viewMode?: "preview" | "code";
  refreshKey?: number;
}

export interface WorkspaceGitStatus {
  isGit: boolean;
  branch?: string;
  insertions: number;
  deletions: number;
  modifiedFiles: Array<{ path: string; status: string }>;
}

export interface McpServerItem {
  id: string;
  name: string;
  command: string;
  args: string[];
  description: string;
  enabled: boolean;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  tools: string[];
  scope: string;
}

export interface SubagentItem {
  id: string;
  name: string;
  description: string;
  tools: string[];
  readOnly: boolean;
  modelTier?: string;
  maxRounds?: number;
  scope: string;
  filePath?: string;
  systemPrompt?: string;
}

export interface WorkspaceFolder {
  path: string;
  name: string;
  isPrimary?: boolean;
}

export interface WorkspaceItem {
  id: string;
  name: string;
  folders: WorkspaceFolder[];
  updatedAt?: number;
}

export interface LlmModelItem {
  id: string;
  model_id: string;
  name: string;
  type: string;
  provider: string;
  base_url: string;
  api_key?: string;
  context_limit?: number;
}

interface ChatState {
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  generatingBySession: Record<string, boolean>;
  toolCallsBySession: Record<string, any[]>;
  todosBySession: Record<string, any[]>;
  permissionBySession: Record<string, any | null>;
  contextMetricsBySession: Record<string, ContextMetrics | null>;
  contextMetrics: ContextMetrics | null;
  outputs: SessionOutput[];
  gitStatus: WorkspaceGitStatus | null;
  mcpServers: McpServerItem[];
  skills: SkillItem[];
  subagents: SubagentItem[];
  workspaces: WorkspaceItem[];
  models: LlmModelItem[];
  activeWorkspaceId: string | null;
  isWorkspaceModalOpen: boolean;
  activeEditingWorkspace: WorkspaceItem | null;
  defaultPermissionMode: PermissionMode;

  // 右侧全能工作台 (浏览器 / 文件树 / 终端 / Git Diff) 全局状态
  workbenchOpen: boolean;
  workbenchWidth: number;
  workbenchMaximized: boolean;
  workbenchTabs: WorkbenchTab[];
  activeWorkbenchTabId: string;
  autoOpenHtmlOutputs: boolean;
  pendingMentionInsert: string | null;

  initStore: () => Promise<void>;
  setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
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
    options?: { line?: number; viewMode?: "preview" | "code" }
  ) => void;
  openDiffInWorkbench: (filePath?: string) => void;
  openTerminalInWorkbench: () => void;
  fetchModels: () => Promise<void>;
  fetchWorkspaces: () => Promise<void>;
  saveWorkspace: (ws: WorkspaceItem) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  openWorkspaceModal: (ws?: WorkspaceItem | null) => void;
  closeWorkspaceModal: () => void;
  setActiveWorkspace: (workspaceId: string | null) => Promise<void>;
  setSessionWorkspace: (sessionId: string, workspaceId: string | null, workDir?: string | null) => Promise<void>;
  addSessionWithWorkspacePrompt: () => Promise<void>;
  addSession: (options?: { workDir?: string | null; workspaceId?: string | null; model?: string }) => Promise<string | null>;
  addSessionInWorkspace: (workspaceId: string) => Promise<string | null>;
  setActiveSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  archiveSession: (id: string, isArchived: boolean) => Promise<void>;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  setSessionWorkDir: (id: string, workDir: string | null) => Promise<void>;
  setSessionReasoningEffort: (id: string, effort: ReasoningEffort) => Promise<void>;
  addMessage: (sessionId: string, message: Message, skipDb?: boolean) => Promise<void>;
  appendMessageDelta: (
    sessionId: string,
    messageId: string,
    delta: string,
  ) => void;
  saveMessageToDb: (sessionId: string, message: Message) => Promise<void>;
  updateSessionModel: (sessionId: string, model: string) => Promise<void>;
  updateMessageMetadata: (sessionId: string, messageId: string, metadata: any) => void;
  truncateMessages: (sessionId: string, messageId: string) => Promise<void>;

  setSessionGenerating: (sessionId: string, isGenerating: boolean) => void;
  sessionStartTimeBySession: Record<string, number | null>;
  setSessionStartTime: (sessionId: string, startTime: number | null) => void;
  upsertSessionToolCall: (sessionId: string, status: any) => void;
  clearSessionToolCalls: (sessionId: string) => void;
  setSessionTodos: (sessionId: string, todos: any[]) => void;
  setSessionPermission: (sessionId: string, perm: any | null) => void;
  setContextMetrics: (metrics: ContextMetrics | null, sessionId?: string) => void;
  lastCompaction: CompactionInfo | null;
  setLastCompaction: (data: CompactionInfo | null) => void;
  refreshOutputs: (sessionId: string) => Promise<void>;
  refreshGitStatus: (workDir?: string | null) => Promise<void>;
  refreshMcpAndSkills: (workDir?: string | null) => Promise<void>;

  // 单会话多任务排队管理 (Prompt Queuing)
  promptQueueBySession: Record<string, QueuedPrompt[]>;
  enqueuePrompt: (sessionId: string, prompt: QueuedPrompt) => void;
  dequeuePrompt: (sessionId: string) => QueuedPrompt | null;
  removeQueuedPrompt: (sessionId: string, promptId: string) => void;
  moveQueuedPromptToTop: (sessionId: string, promptId: string) => void;
  updateQueuedPrompt: (sessionId: string, promptId: string, newContent: string) => void;
  clearPromptQueue: (sessionId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: {},
  generatingBySession: {},
  sessionStartTimeBySession: {},
  toolCallsBySession: {},
  todosBySession: {},
  permissionBySession: {},
  contextMetricsBySession: {},
  contextMetrics: null,
  lastCompaction: null,
  promptQueueBySession: {},
  outputs: [],
  gitStatus: null,
  mcpServers: [],
  skills: [],
  subagents: [],
  workspaces: [],
  models: [],
  activeWorkspaceId: null,
  defaultPermissionMode: 'auto-sandbox',
  workbenchOpen: false,
  workbenchWidth: 560,
  workbenchMaximized: true,
  workbenchTabs: [{ id: 't_home', title: '工具台', type: 'newtab' }],
  activeWorkbenchTabId: 't_home',
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

      // 如果当前激活的是空白新标签页，直接复用它
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

    // 若是 HTML 网页且未强制指定看源码，优先以内置 Chromium 网页模式渲染
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

  setSessionPermissionMode: async (sessionId, mode) => {
    set((state) => ({
      defaultPermissionMode: mode,
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, permissionMode: mode, updatedAt: Date.now() } : s
      ),
    }));
    if (window.electronAPI?.dbUpdateSessionPermissionMode) {
      try {
        await window.electronAPI.dbUpdateSessionPermissionMode(sessionId, mode);
      } catch (err) {
        console.error("更新会话权限模式失败:", err);
      }
    }
    if (window.electronAPI?.setConfig) {
      try {
        await window.electronAPI.setConfig("default_permission_mode", mode);
      } catch (err) {
        console.error("保存默认权限模式失败:", err);
      }
    }
  },

  fetchModels: async () => {
    if (window.electronAPI?.dbGetModels) {
      try {
        const list = await window.electronAPI.dbGetModels();
        if (Array.isArray(list)) {
          set({ models: list });
        }
      } catch (err) {
        console.error("加载全局模型失败:", err);
      }
    }
  },

  fetchWorkspaces: async () => {
    if (window.electronAPI?.getWorkspaces) {
      try {
        const list = await window.electronAPI.getWorkspaces();
        if (Array.isArray(list)) {
          set({ workspaces: list });
        }
      } catch (err) {
        console.error("加载工作空间失败:", err);
      }
    }
  },

  saveWorkspace: async (ws) => {
    if (window.electronAPI?.saveWorkspace) {
      try {
        await window.electronAPI.saveWorkspace(ws);
        await get().fetchWorkspaces();
      } catch (err) {
        console.error("保存工作空间失败:", err);
      }
    }
  },

  deleteWorkspace: async (id) => {
    if (window.electronAPI?.deleteWorkspace) {
      try {
        await window.electronAPI.deleteWorkspace(id);
        await get().fetchWorkspaces();
      } catch (err) {
        console.error("删除工作空间失败:", err);
      }
    }
  },

  isWorkspaceModalOpen: false,
  activeEditingWorkspace: null,

  openWorkspaceModal: (ws) => {
    if (ws) {
      set({ isWorkspaceModalOpen: true, activeEditingWorkspace: ws });
    } else {
      const activeSession = get().sessions.find((s) => s.id === get().activeSessionId);
      const currentDir = activeSession?.workDir;
      const matched = get().workspaces.find((w) =>
        w.folders.some((f) => f.path === currentDir)
      );
      if (matched) {
        set({ isWorkspaceModalOpen: true, activeEditingWorkspace: matched });
      } else {
        set({
          isWorkspaceModalOpen: true,
          activeEditingWorkspace: {
            id: `ws_${Date.now()}`,
            name: activeSession?.title ? `${activeSession.title} 工作区` : '新工作空间',
            folders: currentDir
              ? [{ path: currentDir, name: currentDir.split(/[\\/]/).filter(Boolean).pop() || 'main', isPrimary: true }]
              : [],
          },
        });
      }
    }
  },

  closeWorkspaceModal: () => set({ isWorkspaceModalOpen: false, activeEditingWorkspace: null }),

  setActiveWorkspace: async (workspaceId) => {
    if (!workspaceId) {
      set({ activeWorkspaceId: null });
      return;
    }
    const targetWs = get().workspaces.find((w) => w.id === workspaceId);
    if (!targetWs) return;

    set({ activeWorkspaceId: workspaceId });

    // 寻找属于该工作空间的会话（优先 workspaceId 显式强绑定，向后兼容目录匹配）
    const wsSessions = get()
      .sessions.filter(
        (s) =>
          s.workspaceId === workspaceId ||
          (!s.workspaceId && s.workDir && targetWs.folders.some((f) => f.path === s.workDir))
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (wsSessions.length > 0) {
      await get().setActiveSession(wsSessions[0].id);
    } else {
      await get().addSessionInWorkspace(workspaceId);
    }
  },

  setSessionWorkspace: async (sessionId, workspaceId, workDir) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              workspaceId: workspaceId || undefined,
              workDir: workDir !== undefined ? (workDir || undefined) : s.workDir,
            }
          : s
      ),
      activeWorkspaceId:
        sessionId === state.activeSessionId && workspaceId
          ? workspaceId
          : state.activeWorkspaceId,
    }));
    if (window.electronAPI?.dbUpdateSessionWorkspace) {
      try {
        await window.electronAPI.dbUpdateSessionWorkspace(sessionId, workspaceId, workDir);
      } catch (err) {
        console.error("更新会话工作空间失败:", err);
      }
    }
  },

  addSessionWithWorkspacePrompt: async () => {
    await get().addSession();
    // 新建会话时，给一个空的工作空间，里面的目录为空，弹窗让用户选择
    set({
      isWorkspaceModalOpen: true,
      activeEditingWorkspace: {
        id: `ws_${Date.now()}`,
        name: '新工作空间',
        folders: [], // 目录为空，让用户选择！
      },
    });
  },

  initStore: async () => {
    if (!window.electronAPI) return;
    if ((get() as any)._storeInitialized && get().sessions.length > 0) {
      return;
    }
    (get() as any)._storeInitialized = true;
    try {
      await get().fetchModels();
      await get().fetchWorkspaces();

      const dbSessions = await window.electronAPI.dbGetSessions();

      let activeId = null;
      const initialMessages: Record<string, Message[]> = {};

      if (dbSessions.length > 0) {
        activeId = dbSessions[0].id;
        const dbMsgs = await window.electronAPI.dbGetMessages(activeId);
        initialMessages[activeId] = dbMsgs.map((m: any) => {
          let parsedMeta = null;
          if (m.metadata) {
            try {
              parsedMeta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
            } catch (e) {
              console.error("Failed to parse metadata in initStore:", e);
            }
          }
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.created_at || m.createdAt,
            metadata: parsedMeta,
          };
        });
      } else {
        const chatModels = get().models.filter((m) => !m.type || m.type === "chat");
        const usableFallback = chatModels.find((m) => m.api_key || m.provider === "ollama");
        const initialModel = usableFallback?.id || chatModels[0]?.id || "";

        const newId = crypto.randomUUID();
        const defaultSession = {
          id: newId,
          title: "新的 Agent 会话",
          updatedAt: Date.now(),
          model: initialModel,
        };
        await window.electronAPI.dbAddSession(defaultSession);

        const welcomeMsg = {
          id: "m1",
          role: "assistant" as const,
          content: "你好！我是你的智能开发助手。你可以指定工作区目录，让我帮你分析代码、重构工程、排查错误或执行任务。",
          createdAt: Date.now(),
          metadata: null,
        };
        await window.electronAPI.dbAddMessage({
          id: welcomeMsg.id,
          sessionId: newId,
          role: welcomeMsg.role,
          content: welcomeMsg.content,
          metadata: null,
        });

        dbSessions.push(defaultSession);
        activeId = newId;
        initialMessages[newId] = [welcomeMsg];
      }

      const activeSession = dbSessions.find((s: any) => s.id === activeId);
      let initialWsId = activeSession?.workspace_id || activeSession?.workspaceId || null;
      if (!initialWsId && (activeSession?.work_dir || activeSession?.workDir)) {
        const dir = activeSession?.work_dir || activeSession?.workDir;
        const matched = get().workspaces.find((w) => w.folders.some((f) => f.path === dir));
        if (matched) initialWsId = matched.id;
      }

      set({
        sessions: dbSessions.map((s: any) => ({
          id: s.id,
          title: s.title,
          title_source: s.title_source || "default",
          updatedAt: s.updated_at || s.updatedAt,
          model: s.model || "",
          workspaceId: s.workspace_id || s.workspaceId || undefined,
          workDir: s.work_dir || s.workDir || undefined,
          permissionMode: (s.permission_mode || s.permissionMode || "auto-sandbox") as PermissionMode,
          reasoningEffort: (s.reasoning_effort || s.reasoningEffort || "medium") as ReasoningEffort,
          archived: !!s.archived,
        })),
        activeSessionId: activeId,
        activeWorkspaceId: initialWsId,
        messages: initialMessages,
      });

      if (activeId) {
        const activeSession = dbSessions.find((s: any) => s.id === activeId);
        get().refreshOutputs(activeId);
        get().refreshGitStatus(activeSession?.work_dir || activeSession?.workDir);
        get().refreshMcpAndSkills(activeSession?.work_dir || activeSession?.workDir);
      }

      // 注册全局会话标题异步更新监听 (Sidecar 旁路通知)
      if (window.electronAPI?.onSessionTitleUpdated && !(get() as any)._titleListenerAttached) {
        (get() as any)._titleListenerAttached = true;
        window.electronAPI.onSessionTitleUpdated(({ sessionId, title }: { sessionId: string; title: string }) => {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === sessionId ? { ...s, title, title_source: "generated" } : s
            ),
          }));
        });
      }

      // 注册会话权限模式热更新监听 (例如用户在询问弹窗中点击「切换为工作区沙箱并允许」)
      if (
        window.electronAPI?.onSessionPermissionModeUpdated &&
        !(get() as any)._permModeListenerAttached
      ) {
        (get() as any)._permModeListenerAttached = true;
        window.electronAPI.onSessionPermissionModeUpdated(
          ({ sessionId, permissionMode }: { sessionId: string; permissionMode: PermissionMode }) => {
            set((state) => ({
              defaultPermissionMode: permissionMode,
              sessions: state.sessions.map((s) =>
                s.id === sessionId ? { ...s, permissionMode } : s
              ),
            }));
          }
        );
      }

      if (window.electronAPI?.getConfig) {
        try {
          const savedPermMode = await window.electronAPI.getConfig("default_permission_mode");
          if (
            savedPermMode === "plan" ||
            savedPermMode === "auto-sandbox" ||
            savedPermMode === "ask" ||
            savedPermMode === "full-access"
          ) {
            set({ defaultPermissionMode: savedPermMode });
          }
          const savedAutoOpen = await window.electronAPI.getConfig("auto_open_html_outputs");
          if (savedAutoOpen === "false") {
            set({ autoOpenHtmlOutputs: false });
          }
        } catch (e) {
          console.error("加载步骤风格失败:", e);
        }
      }
    } catch (err) {
      console.error("初始化 ChatStore 失败:", err);
    }
  },

  addSession: async (options) => {
    if (!window.electronAPI) return null;
    const newId = crypto.randomUUID();

    const chatModels = get().models.filter((model) => !model.type || model.type === "chat");
    const usableModels = chatModels.filter(
      (model) => model.api_key || model.provider === "ollama"
    );
    const fallbackModel = usableModels[0]?.id || chatModels[0]?.id || "";

    // 确定 workspaceId 与 workDir
    let targetWorkspaceId = options?.workspaceId !== undefined ? options.workspaceId : get().activeWorkspaceId;
    let targetWorkDir = options?.workDir;
    if (targetWorkspaceId && !targetWorkDir) {
      const ws = get().workspaces.find((w) => w.id === targetWorkspaceId);
      const primary = ws?.folders.find((f) => f.isPrimary) || ws?.folders[0];
      targetWorkDir = primary?.path || undefined;
    } else if (!targetWorkspaceId && targetWorkDir) {
      const ws = get().workspaces.find((w) => w.folders.some((f) => f.path === targetWorkDir));
      if (ws) targetWorkspaceId = ws.id;
    }

    const newSession: Session = {
      id: newId,
      title: "新的 Agent 会话",
      updatedAt: Date.now(),
      model: options?.model || fallbackModel,
      workspaceId: targetWorkspaceId || undefined,
      workDir: targetWorkDir || undefined,
      permissionMode: get().defaultPermissionMode || "auto-sandbox",
      reasoningEffort: "medium",
    };

    try {
      await window.electronAPI.dbAddSession({
        ...newSession,
        workspace_id: newSession.workspaceId,
        work_dir: newSession.workDir,
        reasoning_effort: newSession.reasoningEffort,
      });

      set((state) => ({
        sessions: [newSession, ...state.sessions],
        activeSessionId: newId,
        activeWorkspaceId: targetWorkspaceId || state.activeWorkspaceId,
        messages: { ...state.messages, [newId]: [] },
        outputs: [],
        contextMetrics: null,
      }));

      get().refreshMcpAndSkills(newSession.workDir || null);
      get().refreshGitStatus(newSession.workDir || null);
      return newId;
    } catch (err) {
      console.error("创建会话失败:", err);
      return null;
    }
  },

  addSessionInWorkspace: async (workspaceId) => {
    if (!window.electronAPI) return null;

    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.folders.length === 0) return null;

    const primaryFolder =
      workspace.folders.find((folder) => folder.isPrimary) || workspace.folders[0];
    const workDir = primaryFolder?.path || null;

    const workspaceSessions = get()
      .sessions.filter(
        (session) =>
          session.workspaceId === workspaceId ||
          (!session.workspaceId &&
            session.workDir &&
            workspace.folders.some((folder) => folder.path === session.workDir))
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const chatModels = get().models.filter((model) => !model.type || model.type === "chat");
    const usableModels = chatModels.filter(
      (model) => model.api_key || model.provider === "ollama"
    );
    const model =
      workspaceSessions[0]?.model ||
      usableModels[0]?.id ||
      chatModels[0]?.id ||
      "";

    const newId = crypto.randomUUID();
    const newSession: Session = {
      id: newId,
      title: "新的 Agent 会话",
      updatedAt: Date.now(),
      model,
      workspaceId,
      workDir: workDir || undefined,
      permissionMode:
        workspaceSessions[0]?.permissionMode ||
        get().defaultPermissionMode ||
        "auto-sandbox",
      reasoningEffort: workspaceSessions[0]?.reasoningEffort || "medium",
    };

    try {
      await window.electronAPI.dbAddSession({
        ...newSession,
        workspace_id: newSession.workspaceId,
        work_dir: newSession.workDir,
        reasoning_effort: newSession.reasoningEffort,
      });

      set((state) => ({
        sessions: [newSession, ...state.sessions],
        activeSessionId: newId,
        activeWorkspaceId: workspaceId,
        messages: { ...state.messages, [newId]: [] },
        outputs: [],
        contextMetrics: null,
      }));

      get().refreshMcpAndSkills(workDir);
      get().refreshGitStatus(workDir);
      return newId;
    } catch (err) {
      console.error("创建工作空间会话失败:", err);
      return null;
    }
  },

  setActiveSession: async (id) => {
    if (!window.electronAPI) return;

    const state = get();
    const targetSession = state.sessions.find((s) => s.id === id);
    const workDir = targetSession?.workDir;

    let targetWorkspaceId = targetSession?.workspaceId || null;
    if (!targetWorkspaceId && workDir) {
      const matched = state.workspaces.find((w) =>
        w.folders.some((f) => f.path === workDir)
      );
      if (matched) targetWorkspaceId = matched.id;
    }

    if (!state.messages[id]) {
      try {
        const dbMsgs = await window.electronAPI.dbGetMessages(id);
        const mappedMsgs = dbMsgs.map((m: any) => {
          let parsedMeta = null;
          if (m.metadata) {
            try {
              parsedMeta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
            } catch (e) {
              console.error("Failed to parse metadata in setActiveSession:", e);
            }
          }
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.created_at || m.createdAt,
            metadata: parsedMeta,
          };
        });
        set((state) => ({
          activeSessionId: id,
          activeWorkspaceId: targetWorkspaceId !== null ? targetWorkspaceId : state.activeWorkspaceId,
          contextMetrics: state.contextMetricsBySession[id] || null,
          messages: { ...state.messages, [id]: mappedMsgs }
        }));
      } catch (err) {
        console.error("获取消息历史失败:", err);
      }
    } else {
      set((state) => ({
        activeSessionId: id,
        activeWorkspaceId: targetWorkspaceId !== null ? targetWorkspaceId : state.activeWorkspaceId,
        contextMetrics: state.contextMetricsBySession[id] || null,
      }));
    }

    get().refreshOutputs(id);
    get().refreshGitStatus(workDir);
    get().refreshMcpAndSkills(workDir);
  },

  deleteSession: async (id) => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.dbDeleteSession(id);
      set((state) => {
        const newSessions = state.sessions.filter((s) => s.id !== id);
        const newActive =
          state.activeSessionId === id
            ? newSessions[0]?.id || null
            : state.activeSessionId;

        const newMessages = { ...state.messages };
        delete newMessages[id];

        const nextQueue = { ...state.promptQueueBySession };
        delete nextQueue[id];

        const nextStartTimes = { ...state.sessionStartTimeBySession };
        delete nextStartTimes[id];

        return {
          sessions: newSessions,
          activeSessionId: newActive,
          messages: newMessages,
          promptQueueBySession: nextQueue,
          sessionStartTimeBySession: nextStartTimes,
        };
      });

      const nextActiveId = get().activeSessionId;
      if (nextActiveId) {
        get().setActiveSession(nextActiveId);
      }
    } catch (err) {
      console.error("删除会话失败:", err);
    }
  },

  archiveSession: async (id, isArchived) => {
    if (!window.electronAPI) return;
    try {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, archived: isArchived } : s
        ),
      }));

      const session = get().sessions.find((s) => s.id === id);
      if (session) {
        await window.electronAPI.dbAddSession({
          id: session.id,
          title: session.title,
          model: session.model,
          work_dir: session.workDir,
          archived: isArchived,
        });
      }
    } catch (err) {
      console.error("归档会话失败:", err);
    }
  },

  updateSessionTitle: async (id, title) => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.dbUpdateSessionTitle(id, title);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, title, title_source: "custom", updatedAt: Date.now() } : s
        ),
      }));
    } catch (err) {
      console.error("更新会话标题失败:", err);
    }
  },

  setSessionWorkDir: async (id, workDir) => {
    if (!window.electronAPI) return;
    try {
      let matchedWorkspaceId: string | undefined = undefined;
      if (workDir) {
        const matched = get().workspaces.find((w) =>
          w.folders.some((f) => f.path === workDir)
        );
        if (matched) matchedWorkspaceId = matched.id;
      }

      await window.electronAPI.dbUpdateSessionWorkDir(id, workDir || "");
      if (window.electronAPI.dbUpdateSessionWorkspace && matchedWorkspaceId) {
        try {
          await window.electronAPI.dbUpdateSessionWorkspace(id, matchedWorkspaceId, workDir);
        } catch (e) {
          console.warn("同步更新会话工作空间失败:", e);
        }
      }

      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id
            ? {
                ...s,
                workDir: workDir || undefined,
                workspaceId: matchedWorkspaceId || s.workspaceId,
                updatedAt: Date.now(),
              }
            : s
        ),
        activeWorkspaceId:
          id === state.activeSessionId && matchedWorkspaceId
            ? matchedWorkspaceId
            : state.activeWorkspaceId,
      }));

      // 如果有选择工作目录，保存至最近项目
      if (workDir && window.electronAPI.addRecentProject) {
        const folderName = workDir.split(/[\\/]/).filter(Boolean).pop() || workDir;
        window.electronAPI.addRecentProject({
          id: `p_${Date.now()}`,
          name: folderName,
          path: workDir,
        });
      }

      // 实时全量联动刷新右侧伴随监控面板的各项数据
      await Promise.all([
        get().refreshGitStatus(workDir),
        get().refreshMcpAndSkills(workDir),
        get().refreshOutputs(id),
      ]);
    } catch (err) {
      console.error("更新会话工作目录失败:", err);
    }
  },

  setSessionReasoningEffort: async (id, effort) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, reasoningEffort: effort } : s
      ),
    }));
    if (window.electronAPI?.dbUpdateSessionReasoningEffort) {
      try {
        await window.electronAPI.dbUpdateSessionReasoningEffort(id, effort);
      } catch (err) {
        console.error("更新会话推理强度失败:", err);
      }
    }
  },

  addMessage: async (sessionId, message, skipDb = false) => {
    set((state) => {
      const currentMsgs = state.messages[sessionId] || [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: [...currentMsgs, message],
        },
      };
    });

    if (!skipDb && window.electronAPI) {
      try {
        await window.electronAPI.dbAddMessage({
          id: message.id,
          sessionId,
          role: message.role,
          content: message.content,
          metadata: message.metadata,
        });
      } catch (err) {
        console.error("持久化消息失败:", err);
      }
    }
  },

  appendMessageDelta: (sessionId, messageId, delta) => {
    set((state) => {
      const currentMsgs = state.messages[sessionId] || [];
      const msgIndex = currentMsgs.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return state;

      const updatedMsgs = [...currentMsgs];
      const targetMsg = updatedMsgs[msgIndex];
      updatedMsgs[msgIndex] = {
        ...targetMsg,
        content: targetMsg.content + delta,
      };

      return {
        messages: {
          ...state.messages,
          [sessionId]: updatedMsgs,
        },
      };
    });
  },

  saveMessageToDb: async (sessionId, message) => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.dbAddMessage({
        id: message.id,
        sessionId,
        role: message.role,
        content: message.content,
        metadata: message.metadata,
      });
    } catch (err) {
      console.error("保存消息到存储失败:", err);
    }
  },

  updateSessionModel: async (sessionId, model) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, model } : s
      ),
    }));
    if (window.electronAPI) {
      try {
        const session = get().sessions.find((s) => s.id === sessionId);
        await window.electronAPI.dbAddSession({
          id: sessionId,
          title: session?.title || "对话",
          model,
          work_dir: session?.workDir || null,
          workDir: session?.workDir || null,
          archived: !!session?.archived,
        });
      } catch (err) {
        console.error("更新模型持久化失败:", err);
      }
    }
  },

  updateMessageMetadata: (sessionId, messageId, metadata) => {
    set((state) => {
      const currentMsgs = state.messages[sessionId] || [];
      const msgIndex = currentMsgs.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return state;

      const updatedMsgs = [...currentMsgs];
      updatedMsgs[msgIndex] = {
        ...updatedMsgs[msgIndex],
        metadata,
      };

      return {
        messages: {
          ...state.messages,
          [sessionId]: updatedMsgs,
        },
      };
    });
  },

  truncateMessages: async (sessionId, messageId) => {
    const currentMsgs = get().messages[sessionId] || [];
    const targetMsg = currentMsgs.find((m) => m.id === messageId);
    if (!targetMsg) return;

    const filtered = currentMsgs.filter((m) => m.createdAt <= targetMsg.createdAt);
    const removed = currentMsgs.filter((m) => m.createdAt > targetMsg.createdAt);

    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: filtered,
      },
    }));

    if (window.electronAPI) {
      try {
        await window.electronAPI.dbDeleteMessagesAfter(sessionId, targetMsg.createdAt);
      } catch (err) {
        console.error("截断消息失败:", err);
      }

      for (const message of removed) {
        const attachmentList = message.metadata?.attachments;
        if (!Array.isArray(attachmentList)) continue;
        for (const attachment of attachmentList) {
          if (!attachment?.path) continue;
          try {
            await window.electronAPI.deleteChatAttachment(attachment.path);
          } catch (err) {
            console.error("清理附件失败:", err);
          }
        }
      }
    }
  },

  setSessionGenerating: (sessionId, isGenerating) =>
    set((state) => ({
      generatingBySession: {
        ...state.generatingBySession,
        [sessionId]: isGenerating,
      },
    })),

  setSessionStartTime: (sessionId, startTime) =>
    set((state) => ({
      sessionStartTimeBySession: {
        ...state.sessionStartTimeBySession,
        [sessionId]: startTime,
      },
    })),

  upsertSessionToolCall: (sessionId, status) =>
    set((state) => {
      const prev = state.toolCallsBySession[sessionId] || [];
      const matched = prev.some((t) => t.tool === status.tool && t.callId && t.callId === status.callId);
      const next = matched
        ? prev.map((t) => (t.tool === status.tool && t.callId === status.callId ? status : t))
        : [...prev, status];
      return {
        toolCallsBySession: {
          ...state.toolCallsBySession,
          [sessionId]: next,
        },
      };
    }),

  clearSessionToolCalls: (sessionId) =>
    set((state) => ({
      toolCallsBySession: {
        ...state.toolCallsBySession,
        [sessionId]: [],
      },
    })),

  setSessionTodos: (sessionId, todos) =>
    set((state) => ({
      todosBySession: {
        ...state.todosBySession,
        [sessionId]: Array.isArray(todos) ? todos : [],
      },
    })),

  setSessionPermission: (sessionId, perm) =>
    set((state) => ({
      permissionBySession: {
        ...state.permissionBySession,
        [sessionId]: perm,
      },
    })),

  setContextMetrics: (metrics, sessionId) =>
    set((state) => {
      const targetId = sessionId || state.activeSessionId;
      const nextBySession = targetId
        ? { ...state.contextMetricsBySession, [targetId]: metrics }
        : state.contextMetricsBySession;
      const shouldUpdateCurrent = !sessionId || sessionId === state.activeSessionId;
      return {
        contextMetricsBySession: nextBySession,
        ...(shouldUpdateCurrent ? { contextMetrics: metrics } : {}),
      };
    }),

  setLastCompaction: (data) => set({ lastCompaction: data }),

  refreshOutputs: async (sessionId) => {
    if (!window.electronAPI?.getSessionOutputs || !sessionId) return;
    try {
      const outs = await window.electronAPI.getSessionOutputs(sessionId);
      set({ outputs: outs || [] });
    } catch (err) {
      console.error("刷新 Outputs 失败:", err);
    }
  },

  refreshGitStatus: async (workDir) => {
    if (!window.electronAPI?.getWorkspaceGitStatus) return;
    try {
      const status = await window.electronAPI.getWorkspaceGitStatus(workDir || null);
      set({ gitStatus: status || null });
    } catch (err) {
      console.error("刷新 Git 状态失败:", err);
    }
  },

  refreshMcpAndSkills: async (workDir) => {
    if (!window.electronAPI) return;
    try {
      const [mcps, skills, subagents, tools] = await Promise.all([
        window.electronAPI.getMcpServers ? window.electronAPI.getMcpServers(workDir) : [],
        window.electronAPI.getSkills ? window.electronAPI.getSkills(workDir) : [],
        window.electronAPI.getSubagents ? window.electronAPI.getSubagents(workDir) : [],
        window.electronAPI.getTools ? window.electronAPI.getTools() : [],
      ]);
      set({ mcpServers: mcps || [], skills: skills || [], subagents: subagents || [] });

      // 联动重算 ContextMetrics (由主进程基于真实环境构建计算)
      const activeSessionId = get().activeSessionId;
      const currentMsgs = activeSessionId ? get().messages[activeSessionId] || [] : [];
      if (window.electronAPI.getContextMetrics && activeSessionId) {
        const metrics = await window.electronAPI.getContextMetrics({
          sessionId: activeSessionId,
          workDir: workDir || null,
          messages: currentMsgs,
        });
        if (metrics) {
          get().setContextMetrics(metrics, activeSessionId);
        }
      }
    } catch (err) {
      console.error("刷新 MCP 和 Skills 失败:", err);
    }
  },

  // ─── 排队任务管理 Actions ─────────────────────────
  enqueuePrompt: (sessionId, prompt) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: [...current, prompt],
        },
      };
    }),

  dequeuePrompt: (sessionId) => {
    const queue = get().promptQueueBySession[sessionId] || [];
    if (queue.length === 0) return null;
    const [first, ...rest] = queue;
    set((state) => ({
      promptQueueBySession: {
        ...state.promptQueueBySession,
        [sessionId]: rest,
      },
    }));
    return first;
  },

  removeQueuedPrompt: (sessionId, promptId) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: current.filter((p) => p.id !== promptId),
        },
      };
    }),

  moveQueuedPromptToTop: (sessionId, promptId) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      const idx = current.findIndex((p) => p.id === promptId);
      if (idx <= 0) return state;
      const target = current[idx];
      const next = [target, ...current.slice(0, idx), ...current.slice(idx + 1)];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: next,
        },
      };
    }),

  updateQueuedPrompt: (sessionId, promptId, newContent) =>
    set((state) => {
      const current = state.promptQueueBySession[sessionId] || [];
      return {
        promptQueueBySession: {
          ...state.promptQueueBySession,
          [sessionId]: current.map((p) =>
            p.id === promptId ? { ...p, content: newContent } : p
          ),
        },
      };
    }),

  clearPromptQueue: (sessionId) =>
    set((state) => ({
      promptQueueBySession: {
        ...state.promptQueueBySession,
        [sessionId]: [],
      },
    })),
}));
