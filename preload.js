const { contextBridge, ipcRenderer } = require("electron");

// ─── 全局单一多路复用流式 IPC 总线 (chat-stream-event) ───────
// 彻底消灭动态 channel 拼接 (chat-stream-xxx-sessionId) 与孤儿监听器泄漏隐患
const activeStreamSessions = new Map();

ipcRenderer.on("chat-stream-event", (event, envelope) => {
  if (!envelope || !envelope.sessionId) return;
  const callbacks = activeStreamSessions.get(envelope.sessionId);
  if (!callbacks) return;

  const { type, data } = envelope;
  switch (type) {
    case "data":
      callbacks.onData?.(data);
      break;
    case "tool_status":
      callbacks.onToolStatus?.(data);
      break;
    case "todos":
      callbacks.onTodosUpdate?.(data);
      break;
    case "waiting":
      callbacks.onWaiting?.(data);
      break;
    case "steered":
      callbacks.onSteered?.(data);
      break;
    case "permission":
      callbacks.onPermissionRequest?.(data);
      break;
    case "outputs":
      callbacks.onOutputsUpdated?.(data);
      break;
    case "compaction":
      callbacks.onCompaction?.(data);
      break;
    case "metrics":
      callbacks.onContextMetrics?.(data);
      break;
    case "end":
      activeStreamSessions.delete(envelope.sessionId);
      callbacks.onEnd?.(data);
      break;
    case "error":
      activeStreamSessions.delete(envelope.sessionId);
      callbacks.onError?.(data);
      break;
  }
});

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
  dbUpdateSessionWorkspace: (id, workspaceId, workDir) =>
    ipcRenderer.invoke("db-update-session-workspace", { id, workspaceId, workDir }),
  dbUpdateSessionPermissionMode: (id, permissionMode) =>
    ipcRenderer.invoke("db-update-session-permission-mode", { id, permissionMode }),
  dbUpdateSessionReasoningEffort: (id, reasoningEffort) =>
    ipcRenderer.invoke("db-update-session-reasoning-effort", { id, reasoningEffort }),
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
  getWorkspaceBranches: (workDir) => ipcRenderer.invoke("workspace-get-branches", workDir),
  checkoutWorkspaceBranch: (workDir, branchName, createNew = false) =>
    ipcRenderer.invoke("workspace-checkout-branch", { workDir, branchName, createNew }),
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
  cancelChat: (sessionId) => {
    // 仅向主进程派发取消信号，保留回调等待主进程携带已产出结果与 cancelled 标记统一收尾，保障最终元数据与持久化完整
    ipcRenderer.send("chat-cancel", sessionId);
  },
  steerChat: (sessionId, content, id) =>
    ipcRenderer.send("chat-steer", { sessionId, content, id }),

  // ─── 流式 Agent 调用 (挂载至多路复用总线，零监听器残留) ──
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
    permissionMode,
    reasoningEffort,
    onSteered,
    onWaiting
  ) => {
    activeStreamSessions.set(sessionId, {
      onData,
      onEnd,
      onError,
      onToolStatus,
      onContextMetrics,
      onOutputsUpdated,
      onPermissionRequest,
      onTodosUpdate,
      onCompaction,
      onSteered,
      onWaiting,
    });

    // 触发主进程的流式 Agent 请求 (显式透传当前绑定的工作空间目录、权限模式与推理强度)
    ipcRenderer.send("chat-request", {
      sessionId,
      messages,
      model,
      enableTools,
      workDir,
      permissionMode,
      reasoningEffort,
    });
  },

  // ─── 纠偏注入被拒绝监听（会话已结束时回退为排队）────
  onSteerRejected: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("chat-steer-rejected", handler);
    return () => ipcRenderer.removeListener("chat-steer-rejected", handler);
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

  // ─── 软件自动更新管理 ─────────────────────────────
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  startDownloadUpdate: () => ipcRenderer.invoke("start-download-update"),
  quitAndInstallUpdate: () => ipcRenderer.invoke("quit-and-install-update"),
  openReleasePage: (url) => ipcRenderer.invoke("open-release-page", url),

  onUpdateChecking: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("update-checking", handler);
    return () => ipcRenderer.removeListener("update-checking", handler);
  },
  onUpdateAvailable: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },
  onUpdateNotAvailable: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("update-not-available", handler);
    return () => ipcRenderer.removeListener("update-not-available", handler);
  },
  onUpdateDownloadProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("update-download-progress", handler);
    return () => ipcRenderer.removeListener("update-download-progress", handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("update-downloaded", handler);
    return () => ipcRenderer.removeListener("update-downloaded", handler);
  },
  onUpdateError: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on("update-error", handler);
    return () => ipcRenderer.removeListener("update-error", handler);
  },
});
