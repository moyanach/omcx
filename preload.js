const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // ─── 文件系统与工作区 ──────────────────────────────
  showInFolder: (filePath) => ipcRenderer.send("show-in-folder", filePath),
  openExternalUrl: (targetUrl) => ipcRenderer.send("open-external-url", targetUrl),
  selectSaveDirectory: () => ipcRenderer.invoke("select-save-directory"),
  selectBackgroundImage: () => ipcRenderer.invoke("select-background-image"),
  dialogSelectWorkDirectory: () => ipcRenderer.invoke("dialog-select-work-directory"),
  getConfig: (key) => ipcRenderer.invoke("get-config", key),
  setConfig: (key, value) => ipcRenderer.invoke("set-config", key, value),
  getUserInfo: () => ipcRenderer.invoke("get-user-info"),

  // ─── 模型配置 ──────────────────────────────────────
  dbGetModels: () => ipcRenderer.invoke("db-get-models"),
  dbAddModel: (model) => ipcRenderer.invoke("db-add-model", model),
  dbDeleteModel: (id) => ipcRenderer.invoke("db-delete-model", id),
  apiGetModels: (params) => ipcRenderer.invoke("api-get-models", params),

  // ─── 会话与消息管理 ────────────────────────────────
  dbGetSessions: () => ipcRenderer.invoke("db-get-sessions"),
  dbAddSession: (session) => ipcRenderer.invoke("db-add-session", session),
  dbUpdateSessionTitle: (id, title) => ipcRenderer.invoke("db-update-session-title", id, title),
  dbDeleteSession: (id) => ipcRenderer.invoke("db-delete-session", id),
  dbGetSessionWorkDir: (id) => ipcRenderer.invoke("db-get-session-work-dir", id),
  dbUpdateSessionWorkDir: (id, workDir) => ipcRenderer.invoke("db-update-session-work-dir", id, workDir),
  dbUpdateSessionPermissionMode: (id, permissionMode) =>
    ipcRenderer.invoke("db-update-session-permission-mode", { id, permissionMode }),
  dbGetMessages: (sessionId) => ipcRenderer.invoke("db-get-messages", sessionId),
  dbAddMessage: (message) => ipcRenderer.invoke("db-add-message", message),
  dbDeleteMessagesAfter: (sessionId, timestamp) =>
    ipcRenderer.invoke("db-delete-messages-after", { sessionId, timestamp }),
  saveChatAttachment: (payload) => ipcRenderer.invoke("save-chat-attachment", payload),
  deleteChatAttachment: (filePath) => ipcRenderer.invoke("delete-chat-attachment", filePath),

  // ─── Agent 扩展与 Inspector 监控 ────────────────────
  getMcpServers: (workDir) => ipcRenderer.invoke("get-mcp-servers", workDir),
  saveMcpServers: (servers) => ipcRenderer.invoke("save-mcp-servers", servers),
  getSkills: (workDir) => ipcRenderer.invoke("get-skills", workDir),
  getSubagents: (workDir) => ipcRenderer.invoke("get-subagents", workDir),
  getMemories: (workDir) => ipcRenderer.invoke("get-memories", workDir),
  getSessionOutputs: (sessionId) => ipcRenderer.invoke("get-session-outputs", sessionId),
  getContextMetrics: (params) => ipcRenderer.invoke("get-context-metrics", params),
  getWorkspaceGitStatus: (workDir) => ipcRenderer.invoke("get-workspace-git-status", workDir),
  getWorkspaceFileDiff: (workDir, filePath) =>
    ipcRenderer.invoke("workspace-git-diff", { workDir, filePath }),
  commitWorkspaceChanges: (workDir, message) =>
    ipcRenderer.invoke("workspace-git-commit", { workDir, message }),
  listWorkspaceDir: (workDir, dirPath) =>
    ipcRenderer.invoke("workspace-list-dir", { workDir, dirPath }),
  readWorkspaceFile: (workDir, filePath, maxChars) =>
    ipcRenderer.invoke("workspace-read-file", { workDir, filePath, maxChars }),
  runTerminalCommand: (params, onStream) => {
    const cmdId = params?.cmdId || `term_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const channel = `terminal-stream-${cmdId}`;
    const handler = (event, payload) => {
      if (onStream) onStream(payload);
    };
    if (onStream) {
      ipcRenderer.on(channel, handler);
    }
    return ipcRenderer
      .invoke("terminal-run-command", { ...params, cmdId })
      .finally(() => {
        if (onStream) {
          ipcRenderer.removeListener(channel, handler);
        }
      });
  },
  killTerminalCommand: (cmdId) => ipcRenderer.invoke("terminal-kill-command", cmdId),
  getWorkspaceFileIndex: (workDir) => ipcRenderer.invoke("get-workspace-file-index", workDir),
  getRecentProjects: () => ipcRenderer.invoke("get-recent-projects"),
  addRecentProject: (proj) => ipcRenderer.invoke("add-recent-project", proj),
  getWorkspaces: () => ipcRenderer.invoke("get-workspaces"),
  saveWorkspace: (ws) => ipcRenderer.invoke("save-workspace", ws),
  deleteWorkspace: (id) => ipcRenderer.invoke("delete-workspace", id),

  // ─── 工具调用 ──────────────────────────────────────
  getTools: () => ipcRenderer.invoke("get-tools"),
  executeTool: (name, args) => ipcRenderer.invoke("execute-tool", { name, args }),

  respondPermission: (id, allow, decision) =>
    ipcRenderer.send("chat-permission-response", { id, allow, decision }),
  cancelChat: (sessionId) => ipcRenderer.send("chat-cancel", sessionId),

  // ─── 流式 Agent 调用 ───────────────────────────────
  streamChat: (
    sessionId,
    messages,
    model,
    enableTools,
    workDir,
    onData,
    onEnd,
    onError,
    onToolStatus,
    onContextMetrics,
    onOutputsUpdated,
    onPermissionRequest,
    onTodosUpdate,
    onCompaction,
    permissionMode
  ) => {
    const dataChannel = `chat-stream-data-${sessionId}`;
    const endChannel = `chat-stream-end-${sessionId}`;
    const errorChannel = `chat-stream-error-${sessionId}`;
    const toolStatusChannel = `chat-stream-tool-status-${sessionId}`;
    const metricsChannel = `chat-stream-context-metrics-${sessionId}`;
    const outputsChannel = `session-outputs-updated-${sessionId}`;
    const permChannel = `chat-permission-request-${sessionId}`;
    const todosChannel = `chat-stream-todos-${sessionId}`;
    const compactionChannel = `chat-stream-compaction-${sessionId}`;

    let isCleanedUp = false;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      ipcRenderer.removeListener(dataChannel, dataHandler);
      ipcRenderer.removeListener(endChannel, endHandler);
      ipcRenderer.removeListener(errorChannel, errorHandler);
      ipcRenderer.removeListener(toolStatusChannel, toolStatusHandler);
      ipcRenderer.removeListener(metricsChannel, metricsHandler);
      ipcRenderer.removeListener(outputsChannel, outputsHandler);
      ipcRenderer.removeListener(permChannel, permHandler);
      ipcRenderer.removeListener(todosChannel, todosHandler);
      ipcRenderer.removeListener(compactionChannel, compactionHandler);
    };

    const dataHandler = (e, data) => onData(data);
    const endHandler = (e, args) => {
      cleanup();
      onEnd(args || null);
    };
    const errorHandler = (e, err) => {
      cleanup();
      onError(err);
    };
    const toolStatusHandler = (e, statusData) => {
      if (onToolStatus) onToolStatus(statusData);
    };
    const metricsHandler = (e, metrics) => {
      if (onContextMetrics) onContextMetrics(metrics);
    };
    const outputsHandler = (e, outputItem) => {
      if (onOutputsUpdated) onOutputsUpdated(outputItem);
    };
    const permHandler = (e, permData) => {
      if (onPermissionRequest) onPermissionRequest(permData);
    };
    const todosHandler = (e, todos) => {
      if (onTodosUpdate) onTodosUpdate(todos);
    };
    const compactionHandler = (e, data) => {
      if (onCompaction) onCompaction(data);
    };

    ipcRenderer.on(toolStatusChannel, toolStatusHandler);
    ipcRenderer.on(dataChannel, dataHandler);
    ipcRenderer.on(metricsChannel, metricsHandler);
    ipcRenderer.on(outputsChannel, outputsHandler);
    ipcRenderer.on(permChannel, permHandler);
    ipcRenderer.on(todosChannel, todosHandler);
    ipcRenderer.on(compactionChannel, compactionHandler);
    ipcRenderer.once(endChannel, endHandler);
    ipcRenderer.once(errorChannel, errorHandler);

    // 触发主进程的流式 Agent 请求 (显式透传当前绑定的工作空间目录与权限模式)
    ipcRenderer.send("chat-request", {
      sessionId,
      messages,
      model,
      enableTools,
      workDir,
      permissionMode,
    });
  },

  // ─── 会话标题异步更新监听 ─────────────────────────
  onSessionTitleUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("session-title-updated", handler);
    return () => ipcRenderer.removeListener("session-title-updated", handler);
  },

  // ─── 会话权限模式异步更新监听 ─────────────────────
  onSessionPermissionModeUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("session-permission-mode-updated", handler);
    return () => ipcRenderer.removeListener("session-permission-mode-updated", handler);
  },
});
