import { StateCreator } from "zustand";
import type {
  ChatState,
  Session,
  WorkspaceItem,
  LlmModelItem,
  PermissionMode,
  ReasoningEffort,
  Message,
} from "../chatStore";

// 会话切换序号：用于丢弃并发切换时旧请求的迟到响应
let activeSessionSwitchSeq = 0;

// 渲染进程消息内存池上限：仅保留最近访问的少量会话，防止长思考大会话堆积导致 V8 Heap OOM
const MAX_CACHED_MESSAGE_SESSIONS = 3;

function pruneMessageCache(
  cache: Record<string, Message[]>,
  sessions: Session[],
  generatingBySession: Record<string, boolean>,
  activeSessionId: string
): Record<string, Message[]> {
  const ids = Object.keys(cache);
  if (ids.length <= MAX_CACHED_MESSAGE_SESSIONS) return cache;

  const protectedIds = new Set<string>([activeSessionId]);
  for (const [sessionId, generating] of Object.entries(generatingBySession || {})) {
    if (generating) protectedIds.add(sessionId);
  }

  const updatedAtById = new Map(sessions.map((s) => [s.id, s.updatedAt || 0]));
  const evictionOrder = ids
    .filter((sessionId) => !protectedIds.has(sessionId))
    .sort((a, b) => (updatedAtById.get(a) || 0) - (updatedAtById.get(b) || 0));

  const next = { ...cache };
  let remaining = ids.length;
  for (const sessionId of evictionOrder) {
    if (remaining <= MAX_CACHED_MESSAGE_SESSIONS) break;
    delete next[sessionId];
    remaining -= 1;
  }
  return next;
}

export interface SessionSlice {
  sessions: Session[];
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceItem[];
  models: LlmModelItem[];
  defaultPermissionMode: PermissionMode;
  isWorkspaceModalOpen: boolean;
  activeEditingWorkspace: WorkspaceItem | null;

  initStore: () => Promise<void>;
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
  forkSession: (id: string) => Promise<string | null>;
  archiveSession: (id: string, isArchived: boolean) => Promise<void>;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  setSessionWorkDir: (id: string, workDir: string | null) => Promise<void>;
  setSessionReasoningEffort: (id: string, effort: ReasoningEffort) => Promise<void>;
  setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
  updateSessionModel: (sessionId: string, model: string) => Promise<void>;
}

export const createSessionSlice: StateCreator<
  ChatState,
  [],
  [],
  SessionSlice
> = (set, get) => ({
  sessions: [],
  activeSessionId: null,
  activeWorkspaceId: null,
  workspaces: [],
  models: [],
  defaultPermissionMode: "auto-sandbox",
  isWorkspaceModalOpen: false,
  activeEditingWorkspace: null,

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
            name: activeSession?.title ? `${activeSession.title} 工作区` : "新工作空间",
            folders: currentDir
              ? [{ path: currentDir, name: currentDir.split(/[\\/]/).filter(Boolean).pop() || "main", isPrimary: true }]
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
    set({
      isWorkspaceModalOpen: true,
      activeEditingWorkspace: {
        id: `ws_${Date.now()}`,
        name: "新工作空间",
        folders: [],
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
            reasoningChars: Number(parsedMeta?.reasoningChars) || 0,
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
        const activeSess = dbSessions.find((s: any) => s.id === activeId);
        get().refreshOutputs(activeId);
        get().refreshGitStatus(activeSess?.work_dir || activeSess?.workDir);
        get().refreshMcpAndSkills(activeSess?.work_dir || activeSess?.workDir);
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

      // 注册会话权限模式热更新监听
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
          console.error("加载全局配置失败:", e);
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

    // 会话切换所有权令牌：快速 A→B 切换时，A 的迟到消息响应不得覆盖 B
    const switchSeq = ++activeSessionSwitchSeq;
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

    // 立即切换 activeSessionId，消息体稍后填充，避免界面停留在旧会话
    set((state) => ({
      activeSessionId: id,
      activeWorkspaceId: targetWorkspaceId !== null ? targetWorkspaceId : state.activeWorkspaceId,
      contextMetrics: state.contextMetricsBySession[id] || null,
    }));

    if (!state.messages[id]) {
      try {
        const dbMsgs = await window.electronAPI.dbGetMessages(id);
        if (switchSeq !== activeSessionSwitchSeq) return;
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
            reasoningChars: Number(parsedMeta?.reasoningChars) || 0,
          };
        });
        set((state) => {
          // 会话消息内存池 LRU：仅保留最近 3 个会话（切换到的大会话优先），
          // 避免连续浏览多个长思考会话导致渲染进程 Heap 持续膨胀。
          const nextMessages = pruneMessageCache(
            { ...state.messages, [id]: mappedMsgs },
            state.sessions,
            state.generatingBySession,
            id
          );
          const evictedIds = Object.keys(state.messages).filter(
            (sessionId) => sessionId !== id && !nextMessages[sessionId]
          );
          if (evictedIds.length === 0) return { messages: nextMessages };

          // 同步清理被淘汰会话的附属缓存，避免残留工具轨迹/待办占用内存
          const nextToolCalls = { ...state.toolCallsBySession };
          const nextTodos = { ...state.todosBySession };
          const nextMetrics = { ...state.contextMetricsBySession };
          for (const sessionId of evictedIds) {
            delete nextToolCalls[sessionId];
            delete nextTodos[sessionId];
            delete nextMetrics[sessionId];
          }
          return {
            messages: nextMessages,
            toolCallsBySession: nextToolCalls,
            todosBySession: nextTodos,
            contextMetricsBySession: nextMetrics,
          };
        });
      } catch (err) {
        console.error("获取消息历史失败:", err);
      }
    }

    if (switchSeq !== activeSessionSwitchSeq) return;

    get().refreshOutputs(id);
    get().refreshGitStatus(workDir);
    get().refreshMcpAndSkills(workDir);
  },

  deleteSession: async (id) => {
    if (!window.electronAPI) return;
    try {
      // 删除前先终止该会话所有在跑链路：否则主进程会继续执行工具并写回已删除会话
      if (get().generatingBySession[id]) {
        try {
          window.electronAPI.cancelChat?.(id);
        } catch {
          // 忽略取消失败，后续本地状态仍会清理
        }
      }
      const runningBtwId = get().btwRunningBySession?.[id];
      if (runningBtwId && window.electronAPI.cancelBtw) {
        try {
          await window.electronAPI.cancelBtw(runningBtwId);
        } catch {
          // 忽略
        }
      }

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

        const nextGenerating = { ...state.generatingBySession };
        delete nextGenerating[id];
        const nextWaiting = { ...state.waitingBySession };
        delete nextWaiting[id];
        const nextPermissions = { ...state.permissionBySession };
        delete nextPermissions[id];
        const nextToolCalls = { ...state.toolCallsBySession };
        delete nextToolCalls[id];
        const nextTodos = { ...state.todosBySession };
        delete nextTodos[id];
        const nextMetrics = { ...state.contextMetricsBySession };
        delete nextMetrics[id];
        const nextBtwThreads = { ...state.btwThreadsBySession };
        delete nextBtwThreads[id];
        const nextBtwRunning = { ...state.btwRunningBySession };
        delete nextBtwRunning[id];
        const nextBtwQuote = { ...state.btwQuoteBySession };
        delete nextBtwQuote[id];

        return {
          sessions: newSessions,
          activeSessionId: newActive,
          messages: newMessages,
          promptQueueBySession: nextQueue,
          sessionStartTimeBySession: nextStartTimes,
          generatingBySession: nextGenerating,
          waitingBySession: nextWaiting,
          permissionBySession: nextPermissions,
          toolCallsBySession: nextToolCalls,
          todosBySession: nextTodos,
          contextMetricsBySession: nextMetrics,
          btwThreadsBySession: nextBtwThreads,
          btwRunningBySession: nextBtwRunning,
          btwQuoteBySession: nextBtwQuote,
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

  forkSession: async (id) => {
    if (!window.electronAPI?.forkSession) return null;
    try {
      const result = await window.electronAPI.forkSession(id);
      if (!result?.success || !result.session) {
        console.error("分支会话失败:", result?.error);
        return null;
      }
      const record = result.session;
      const newSession: Session = {
        id: record.id,
        title: record.title,
        title_source: record.title_source,
        updatedAt: record.updated_at || Date.now(),
        model: record.model,
        workspaceId: record.workspace_id || undefined,
        workDir: record.work_dir || undefined,
        permissionMode: record.permission_mode,
        reasoningEffort: record.reasoning_effort,
        archived: Boolean(record.archived),
      };

      const dbMsgs = await window.electronAPI.dbGetMessages(newSession.id);
      const messages = (dbMsgs || []).map((m: any) => {
        let parsedMeta = null;
        if (m.metadata) {
          try {
            parsedMeta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
          } catch {}
        }
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at || m.createdAt,
          metadata: parsedMeta,
          reasoningChars: Number(parsedMeta?.reasoningChars) || 0,
        };
      });

      set((state) => ({
        sessions: [newSession, ...state.sessions],
        activeSessionId: newSession.id,
        activeWorkspaceId: newSession.workspaceId || state.activeWorkspaceId,
        messages: pruneMessageCache(
          { ...state.messages, [newSession.id]: messages },
          [newSession, ...state.sessions],
          state.generatingBySession,
          newSession.id
        ),
        outputs: [],
        contextMetrics: null,
      }));
      get().refreshMcpAndSkills(newSession.workDir || null);
      get().refreshGitStatus(newSession.workDir || null);
      return newSession.id;
    } catch (err) {
      console.error("分支会话失败:", err);
      return null;
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

      if (workDir && window.electronAPI.addRecentProject) {
        const folderName = workDir.split(/[\\/]/).filter(Boolean).pop() || workDir;
        window.electronAPI.addRecentProject({
          id: `p_${Date.now()}`,
          name: folderName,
          path: workDir,
        });
      }

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
});
