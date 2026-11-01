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

export interface Session {
  id: string;
  title: string;
  title_source?: string;
  updatedAt: number;
  model?: string;
  workDir?: string;
  archived?: boolean;
}

export interface ContextBreakdownItem {
  tokens: number;
  formatted: string;
  percent: number;
  color: string;
  label: string;
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
  contextMetrics: ContextMetrics | null;
  outputs: SessionOutput[];
  gitStatus: WorkspaceGitStatus | null;
  mcpServers: McpServerItem[];
  skills: SkillItem[];
  workspaces: WorkspaceItem[];
  models: LlmModelItem[];
  isWorkspaceModalOpen: boolean;
  activeEditingWorkspace: WorkspaceItem | null;
  stepDisplayStyle: 'detailed' | 'compact';

  initStore: () => Promise<void>;
  setStepDisplayStyle: (style: 'detailed' | 'compact') => Promise<void>;
  fetchModels: () => Promise<void>;
  fetchWorkspaces: () => Promise<void>;
  saveWorkspace: (ws: WorkspaceItem) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  openWorkspaceModal: (ws?: WorkspaceItem | null) => void;
  closeWorkspaceModal: () => void;
  addSessionWithWorkspacePrompt: () => Promise<void>;
  addSession: (options?: { workDir?: string | null; model?: string }) => Promise<void>;
  addSessionInWorkspace: (workspaceId: string) => Promise<string | null>;
  setActiveSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  archiveSession: (id: string, isArchived: boolean) => Promise<void>;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  setSessionWorkDir: (id: string, workDir: string | null) => Promise<void>;
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

  setContextMetrics: (metrics: ContextMetrics | null) => void;
  lastCompaction: CompactionInfo | null;
  setLastCompaction: (data: CompactionInfo | null) => void;
  refreshOutputs: (sessionId: string) => Promise<void>;
  refreshGitStatus: (workDir?: string | null) => Promise<void>;
  refreshMcpAndSkills: (workDir?: string | null) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: {},
  contextMetrics: null,
  lastCompaction: null,
  outputs: [],
  gitStatus: null,
  mcpServers: [],
  skills: [],
  workspaces: [],
  models: [],
  stepDisplayStyle: 'detailed',

  setStepDisplayStyle: async (style) => {
    set({ stepDisplayStyle: style });
    if (window.electronAPI?.setConfig) {
      try {
        await window.electronAPI.setConfig("step_display_style", style);
      } catch (err) {
        console.error("保存步骤展示风格失败:", err);
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

      set({
        sessions: dbSessions.map((s: any) => ({
          id: s.id,
          title: s.title,
          title_source: s.title_source || "default",
          updatedAt: s.updated_at || s.updatedAt,
          model: s.model || "",
          workDir: s.work_dir || s.workDir || undefined,
          archived: !!s.archived,
        })),
        activeSessionId: activeId,
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

      if (window.electronAPI?.getConfig) {
        try {
          const savedStyle = await window.electronAPI.getConfig("step_display_style");
          if (savedStyle === "detailed" || savedStyle === "compact") {
            set({ stepDisplayStyle: savedStyle });
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
    if (!window.electronAPI) return;
    const newId = crypto.randomUUID();

    const chatModels = get().models.filter((model) => !model.type || model.type === "chat");
    const usableModels = chatModels.filter(
      (model) => model.api_key || model.provider === "ollama"
    );
    const fallbackModel = usableModels[0]?.id || chatModels[0]?.id || "";

    const newSession = {
      id: newId,
      title: "新的 Agent 会话",
      updatedAt: Date.now(),
      model: options?.model || fallbackModel,
      workDir: options?.workDir || undefined,
    };

    try {
      await window.electronAPI.dbAddSession(newSession);

      set((state) => ({
        sessions: [newSession, ...state.sessions],
        activeSessionId: newId,
        messages: { ...state.messages, [newId]: [] },
        outputs: [],
        contextMetrics: null,
      }));

      get().refreshMcpAndSkills(options?.workDir || null);
    } catch (err) {
      console.error("创建会话失败:", err);
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
          session.workDir &&
          workspace.folders.some((folder) => folder.path === session.workDir)
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
    const newSession = {
      id: newId,
      title: "新的 Agent 会话",
      updatedAt: Date.now(),
      model,
      workDir: workDir || undefined,
    };

    try {
      await window.electronAPI.dbAddSession(newSession);

      set((state) => ({
        sessions: [newSession, ...state.sessions],
        activeSessionId: newId,
        messages: { ...state.messages, [newId]: [] },
        outputs: [],
        contextMetrics: null,
      }));

      get().refreshMcpAndSkills(workDir);
      get().refreshGitStatus(workDir);
      return newId;
    } catch (err) {
      console.error("创建会话失败:", err);
      return null;
    }
  },

  setActiveSession: async (id) => {
    if (!window.electronAPI) return;

    const state = get();
    const targetSession = state.sessions.find((s) => s.id === id);
    const workDir = targetSession?.workDir;

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
          messages: { ...state.messages, [id]: mappedMsgs }
        }));
      } catch (err) {
        console.error("获取消息历史失败:", err);
      }
    } else {
      set({ activeSessionId: id });
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

        return {
          sessions: newSessions,
          activeSessionId: newActive,
          messages: newMessages,
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
      await window.electronAPI.dbUpdateSessionWorkDir(id, workDir || "");
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, workDir: workDir || undefined, updatedAt: Date.now() } : s
        ),
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

  setContextMetrics: (metrics) => set({ contextMetrics: metrics }),
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
      const [mcps, skills, tools] = await Promise.all([
        window.electronAPI.getMcpServers ? window.electronAPI.getMcpServers(workDir) : [],
        window.electronAPI.getSkills ? window.electronAPI.getSkills(workDir) : [],
        window.electronAPI.getTools ? window.electronAPI.getTools() : [],
      ]);
      set({ mcpServers: mcps || [], skills: skills || [] });

      // 联动重算 ContextMetrics
      const activeSessionId = get().activeSessionId;
      const currentMsgs = activeSessionId ? get().messages[activeSessionId] || [] : [];
      if (window.electronAPI.getContextMetrics) {
        const metrics = await window.electronAPI.getContextMetrics({
          messages: currentMsgs,
          tools: tools || [],
          systemPrompt: "You are a professional AI developer agent.",
          activeSkills: skills || [],
        });
        if (metrics) {
          set({ contextMetrics: metrics });
        }
      }
    } catch (err) {
      console.error("刷新 MCP 和 Skills 失败:", err);
    }
  },
}));
