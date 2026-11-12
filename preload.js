const { contextBridge, ipcRenderer } = require("electron");

// ─── 全局单一多路复用流式 IPC 总线 (chat-stream-event) ───────
// 彻底消灭动态 channel 拼接 (chat-stream-xxx-sessionId) 与孤儿监听器泄漏隐患
const activeStreamSessions = new Map();

ipcRenderer.on("chat-stream-event", (event, envelope) => {
  if (!envelope || !envelope.sessionId) return;
  const entry = activeStreamSessions.get(envelope.sessionId);
  if (!entry) return;

  // 事件归属校验：同一会话快速重发/并发时，旧 run 的迟到事件绝不能污染新 run 的回调
  if (envelope.runId && entry.runId !== envelope.runId) return;

  const callbacks = entry.callbacks;
  const { type, data } = envelope;
  switch (type) {
    case "data":
      callbacks.onData?.(data);
      break;
    case "reasoning":
      callbacks.onReasoning?.(data);
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
    case "permission_resolved":
      callbacks.onPermissionResolved?.(data);
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
      if (activeStreamSessions.get(envelope.sessionId) === entry) {
        activeStreamSessions.delete(envelope.sessionId);
      }
      callbacks.onEnd?.(data);
      break;
    case "error":
      if (activeStreamSessions.get(envelope.sessionId) === entry) {
        activeStreamSessions.delete(envelope.sessionId);
      }
      callbacks.onError?.(data);
      break;
  }
});

// ─── 旁路问答独立流式总线 (btw-stream-event) ───────────────
// 与主对话总线完全隔离：按 btwId 路由，旧 run 的迟到事件不会污染新请求。
const activeBtwRequests = new Map();

ipcRenderer.on("btw-stream-event", (event, envelope) => {
  if (!envelope || !envelope.btwId) return;
  const entry = activeBtwRequests.get(envelope.btwId);
  if (!entry) return;
  if (envelope.runId && entry.runId !== envelope.runId) return;

  const callbacks = entry.callbacks || {};
  switch (envelope.type) {
    case "data":
      callbacks.onData?.(envelope.data);
      break;
    case "tool_status":
      callbacks.onToolStatus?.(envelope.data);
      break;
    case "end":
      if (activeBtwRequests.get(envelope.btwId) === entry) {
        activeBtwRequests.delete(envelope.btwId);
      }
      callbacks.onEnd?.(envelope.data);
      break;
    case "error":
      if (activeBtwRequests.get(envelope.btwId) === entry) {
        activeBtwRequests.delete(envelope.btwId);
      }
      callbacks.onError?.(envelope.data);
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
  getSystemFonts: (refresh = false) => ipcRenderer.invoke("get-system-fonts", { refresh }),
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
  dbGetMessageReasoning: (messageId) => ipcRenderer.invoke("db-get-message-reasoning", messageId),
  dbAddMessage: (message) => ipcRenderer.invoke("db-add-message", message),
  dbDeleteMessagesAfter: (sessionId, timestamp) =>
    ipcRenderer.invoke("db-delete-messages-after", { sessionId, timestamp }),
  saveChatAttachment: (payload) => ipcRenderer.invoke("save-chat-attachment", payload),
  deleteChatAttachment: (filePath) => ipcRenderer.invoke("delete-chat-attachment", filePath),

  // ─── Agent 扩展与 Inspector 监控 ────────────────────
  getMcpServers: (workDir) => ipcRenderer.invoke("get-mcp-servers", workDir),
  saveMcpServers: (servers) => ipcRenderer.invoke("save-mcp-servers", servers),
  trustProjectMcp: (workDir, trusted) =>
    ipcRenderer.invoke("trust-project-mcp", { workDir, trusted }),
  toggleMcpServer: (id, enabled) => ipcRenderer.invoke("toggle-mcp-server", { id, enabled }),
  deleteMcpServer: (id) => ipcRenderer.invoke("delete-mcp-server", { id }),
  getMcpTools: (serverId, workDir) => ipcRenderer.invoke("get-mcp-tools", { serverId, workDir }),
  toggleMcpTool: (serverId, toolName, enabled, workDir) =>
    ipcRenderer.invoke("toggle-mcp-tool", { serverId, toolName, enabled, workDir }),
  listMcpResources: (workDir) => ipcRenderer.invoke("list-mcp-resources", workDir),
  readMcpResource: (uri, workDir) => ipcRenderer.invoke("read-mcp-resource", { uri, workDir }),
  listMcpPrompts: (workDir) => ipcRenderer.invoke("list-mcp-prompts", { workDir }),
  getMcpPrompt: (serverId, promptName, args, workDir) =>
    ipcRenderer.invoke("get-mcp-prompt", { serverId, promptName, args, workDir }),
  getMcpOAuthStatus: (workDir) => ipcRenderer.invoke("mcp-oauth-status", { workDir }),
  authorizeMcpOAuth: (serverId, workDir) =>
    ipcRenderer.invoke("mcp-oauth-authorize", { serverId, workDir }),
  logoutMcpOAuth: (serverId, workDir) =>
    ipcRenderer.invoke("mcp-oauth-logout", { serverId, workDir }),
  getSkills: (workDir, includeDisabled = false) =>
    ipcRenderer.invoke("get-skills", { workDir, includeDisabled }),
  toggleSkill: (name, enabled) => ipcRenderer.invoke("toggle-skill", { name, enabled }),
  deleteSkill: (filePath, workDir) => ipcRenderer.invoke("delete-skill", { filePath, workDir }),
  importSkill: (options = {}) => ipcRenderer.invoke("import-skill", options),
  fetchSkillMarket: (payload = {}) => ipcRenderer.invoke("fetch-skill-market", payload),
  installMarketSkill: (item, overwrite = false) =>
    ipcRenderer.invoke("install-market-skill", { item, overwrite }),
  getSubagents: (workDir) => ipcRenderer.invoke("get-subagents", workDir),
  getMemories: (workDir) => ipcRenderer.invoke("get-memories", workDir),
  getSessionOutputs: (sessionId) => ipcRenderer.invoke("get-session-outputs", sessionId),
  getSessionCheckpoints: (sessionId) => ipcRenderer.invoke("get-session-checkpoints", sessionId),
  getSessionCheckpoint: (sessionId, checkpointId) =>
    ipcRenderer.invoke("get-session-checkpoint", { sessionId, checkpointId }),
  restoreCheckpoint: (sessionId, checkpointId) =>
    ipcRenderer.invoke("restore-checkpoint", { sessionId, checkpointId }),
  deleteCheckpoint: (sessionId, checkpointId) =>
    ipcRenderer.invoke("delete-checkpoint", { sessionId, checkpointId }),
  getRepoIndexStats: (workDir, refresh = false) =>
    ipcRenderer.invoke("get-repo-index-stats", { workDir, refresh }),
  getRepoMap: (workDir, maxChars = 6000, refresh = false) =>
    ipcRenderer.invoke("get-repo-map", { workDir, maxChars, refresh }),
  searchRepoSymbols: (workDir, query, limit = 40) =>
    ipcRenderer.invoke("search-repo-symbols", { workDir, query, limit }),
  getRepoWiki: (workDir) => ipcRenderer.invoke("get-repo-wiki", workDir),
  generateRepoWiki: (workDir, model) => ipcRenderer.invoke("generate-repo-wiki", { workDir, model }),
  getContextMetrics: (params) => ipcRenderer.invoke("get-context-metrics", params),
  getWorkspaceGitStatus: (workDir) => ipcRenderer.invoke("get-workspace-git-status", workDir),
  getWorkspaceBranches: (workDir) => ipcRenderer.invoke("workspace-get-branches", workDir),
  checkoutWorkspaceBranch: (workDir, branchName, createNew = false) =>
    ipcRenderer.invoke("workspace-checkout-branch", { workDir, branchName, createNew }),
  getWorkspaceFileDiff: (workDir, filePath) =>
    ipcRenderer.invoke("workspace-git-diff", { workDir, filePath }),
  commitWorkspaceChanges: (workDir, message) =>
    ipcRenderer.invoke("workspace-git-commit", { workDir, message }),
  getGitFileHunks: (workDir, filePath, staged = false) =>
    ipcRenderer.invoke("git-get-file-hunks", { workDir, filePath, staged }),
  applyGitHunks: (workDir, filePath, hunkIds, options = {}) =>
    ipcRenderer.invoke("git-apply-hunks", {
      workDir,
      filePath,
      hunkIds,
      staged: Boolean(options.staged),
      reverse: Boolean(options.reverse),
      target: options.target,
    }),
  discardGitHunks: (workDir, filePath, hunkIds) =>
    ipcRenderer.invoke("git-discard-hunks", { workDir, filePath, hunkIds }),
  discardGitFile: (workDir, filePath, staged = false) =>
    ipcRenderer.invoke("git-discard-file", { workDir, filePath, staged }),
  stageGitFile: (workDir, filePath) =>
    ipcRenderer.invoke("git-stage-file", { workDir, filePath }),
  unstageGitFile: (workDir, filePath) =>
    ipcRenderer.invoke("git-unstage-file", { workDir, filePath }),
  stageAllGitChanges: (workDir) => ipcRenderer.invoke("git-stage-all", { workDir }),
  createGitPullRequest: (params) => ipcRenderer.invoke("git-create-pr", params),
  listGitWorktrees: (workDir) => ipcRenderer.invoke("git-worktree-list", { workDir }),
  createGitWorktree: (params) => ipcRenderer.invoke("git-worktree-create", params),
  removeGitWorktree: (workDir, targetPath, force = false) =>
    ipcRenderer.invoke("git-worktree-remove", { workDir, targetPath, force }),

  // ─── P1: 斜杠命令 / 诊断 / Hooks / 会话导出 ──────────
  getSlashCommands: (workDir) => ipcRenderer.invoke("get-slash-commands", { workDir }),
  listSpecs: (workDir) => ipcRenderer.invoke("spec-list", { workDir }),
  readSpec: (workDir, id) => ipcRenderer.invoke("spec-read", { workDir, id }),
  saveSpec: (payload) => ipcRenderer.invoke("spec-save", payload),
  updateSpecStatus: (workDir, id, status) =>
    ipcRenderer.invoke("spec-update-status", { workDir, id, status }),
  deleteSpec: (workDir, id) => ipcRenderer.invoke("spec-delete", { workDir, id }),
  getProjectTasks: (workDir) => ipcRenderer.invoke("get-project-tasks", { workDir }),
  runProjectTask: (workDir, taskId, timeoutMs) =>
    ipcRenderer.invoke("run-project-task", { workDir, taskId, timeoutMs }),
  getProjectHooks: (workDir) => ipcRenderer.invoke("get-project-hooks", { workDir }),
  createHooksTemplate: () => ipcRenderer.invoke("create-hooks-template"),
  setProjectHooksTrust: (workDir, trusted) =>
    ipcRenderer.invoke("set-project-hooks-trust", { workDir, trusted }),
  forkSession: (sessionId, upToMessageId) =>
    ipcRenderer.invoke("fork-session", { sessionId, upToMessageId }),
  exportSession: (sessionId) => ipcRenderer.invoke("export-session", { sessionId }),

  // ─── P2: 运行观测 / 评测 / 浏览器自动化 ───────────────
  telemetryGetStats: (params = {}) => ipcRenderer.invoke("telemetry-get-stats", params),
  telemetryListRuns: (params = {}) => ipcRenderer.invoke("telemetry-list-runs", params),
  telemetryGetRun: (id) => ipcRenderer.invoke("telemetry-get-run", { id }),
  telemetryClear: () => ipcRenderer.invoke("telemetry-clear"),
  listEvals: () => ipcRenderer.invoke("evals-list"),
  runEval: (evalId, model, maxRounds) =>
    ipcRenderer.invoke("eval-run", { evalId, model, maxRounds }),
  runAllEvals: (model, ids, maxRounds) =>
    ipcRenderer.invoke("eval-run-all", { model, ids, maxRounds }),
  browserAutoOpen: (url, workDir) => ipcRenderer.invoke("browser-auto-open", { url, workDir }),
  browserAutoInteract: (payload) => ipcRenderer.invoke("browser-auto-interact", payload),
  browserAutoSnapshot: (payload = {}) => ipcRenderer.invoke("browser-auto-snapshot", payload),
  browserAutoSaveBaseline: (payload = {}) =>
    ipcRenderer.invoke("browser-auto-save-baseline", payload),
  browserAutoState: () => ipcRenderer.invoke("browser-auto-state"),
  browserAutoBack: () => ipcRenderer.invoke("browser-auto-back"),
  browserAutoForward: () => ipcRenderer.invoke("browser-auto-forward"),
  browserAutoReload: (payload = {}) => ipcRenderer.invoke("browser-auto-reload", payload),
  browserAutoClose: () => ipcRenderer.invoke("browser-auto-close"),
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

  // ─── 原生 PTY 交互式终端 ──────────────────────────
  createTerminalSession: (params) => ipcRenderer.invoke("terminal-create", params),
  writeTerminalSession: (terminalId, data) =>
    ipcRenderer.send("terminal-input", { terminalId, data }),
  resizeTerminalSession: (terminalId, cols, rows) =>
    ipcRenderer.invoke("terminal-resize", { terminalId, cols, rows }),
  disposeTerminalSession: (terminalId) => ipcRenderer.invoke("terminal-dispose", terminalId),
  onTerminalPtyData: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on("terminal-pty-data", handler);
    return () => ipcRenderer.removeListener("terminal-pty-data", handler);
  },
  onTerminalPtyExit: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on("terminal-pty-exit", handler);
    return () => ipcRenderer.removeListener("terminal-pty-exit", handler);
  },
  getWorkspaceFileIndex: (workDir) => ipcRenderer.invoke("get-workspace-file-index", workDir),
  getRecentProjects: () => ipcRenderer.invoke("get-recent-projects"),
  addRecentProject: (proj) => ipcRenderer.invoke("add-recent-project", proj),
  getWorkspaces: () => ipcRenderer.invoke("get-workspaces"),
  saveWorkspace: (ws) => ipcRenderer.invoke("save-workspace", ws),
  deleteWorkspace: (id) => ipcRenderer.invoke("delete-workspace", id),

  // ─── 工具调用 ──────────────────────────────────────
  getTools: () => ipcRenderer.invoke("get-tools"),
  executeTool: (name, args, workDir) => ipcRenderer.invoke("execute-tool", { name, args, workDir }),

  respondPermission: (id, allow, decision) =>
    ipcRenderer.send("chat-permission-response", { id, allow, decision }),
  cancelChat: (sessionId) => {
    // 仅向主进程派发取消信号，保留回调等待主进程携带已产出结果与 cancelled 标记统一收尾，保障最终元数据与持久化完整
    ipcRenderer.send("chat-cancel", sessionId);
  },
  steerChat: (sessionId, content, id) =>
    ipcRenderer.send("chat-steer", { sessionId, content, id }),

  // ─── 流式 Agent 调用 (挂载至多路复用总线，零监听器残留) ──
  // 思考内容通过 onReasoning 独立回传，不再与正文混合在 data 通道中。
  streamChat: (
    sessionId,
    messages,
    model,
    enableTools,
    workDir,
    assistantMsgId,
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
    onWaiting,
    onReasoning,
    onPermissionResolved
  ) => {
    // 每次请求生成独立 runId：同一会话重发时，旧 run 的迟到事件会被总线丢弃
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    activeStreamSessions.set(sessionId, {
      runId,
      callbacks: {
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
        onReasoning,
        onPermissionResolved,
      },
    });

    // 触发主进程的流式 Agent 请求 (显式透传当前绑定的工作空间目录、权限模式与推理强度)
    ipcRenderer.send("chat-request", {
      sessionId,
      runId,
      messages,
      model,
      enableTools,
      workDir,
      assistantMsgId,
      permissionMode,
      reasoningEffort,
    });
  },

  // ─── 旁路问答 (/btw)：独立请求与取消，不写会话、不打断主任务 ──
  btwChat: (payload = {}, callbacks = {}) => {
    const btwId = payload.btwId || `btw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const runId = payload.runId || `bwrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    activeBtwRequests.set(btwId, { runId, callbacks });
    return ipcRenderer
      .invoke("btw-request", { ...payload, btwId, runId })
      .then((res) => {
        // 主进程在启动阶段直接拒绝（如缺少 API Key）时不会产生任何流式事件，需主动释放监听表
        if (res && res.ok === false) activeBtwRequests.delete(btwId);
        return res;
      })
      .catch((err) => {
        activeBtwRequests.delete(btwId);
        try {
          callbacks.onError?.({ message: err?.message || String(err) });
        } catch {}
        return { ok: false, error: err?.message || String(err) };
      });
  },
  cancelBtw: (btwId) => ipcRenderer.invoke("btw-cancel", { btwId }),

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
