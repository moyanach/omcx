/**
 * Electron Preload 桥接 API 全局类型声明（对应 preload.js contextBridge 暴露对象）
 */
export interface ElectronAPI {
  // ─── 文件系统与工作区 ──────────────────────────────
  showInFolder: (filePath: string) => void;
  openExternalUrl: (targetUrl: string) => void;
  selectSaveDirectory: () => Promise<string | null>;
  selectBackgroundImage: () => Promise<any>;
  dialogSelectWorkDirectory: () => Promise<string | null>;
  getConfig: (key: string) => Promise<any>;
  setConfig: (key: string, value: any) => Promise<any>;
  getSystemFonts: (refresh?: boolean) => Promise<any>;
  getUserInfo: () => Promise<any>;

  // ─── 模型配置 ──────────────────────────────────────
  dbGetModels: () => Promise<any[]>;
  dbAddModel: (model: any) => Promise<any>;
  dbDeleteModel: (id: string) => Promise<any>;
  apiGetModels: (params: any) => Promise<any>;

  // ─── 会话与消息管理 ────────────────────────────────
  dbGetSessions: () => Promise<any[]>;
  dbAddSession: (session: any) => Promise<any>;
  dbUpdateSessionTitle: (id: string, title: string) => Promise<any>;
  dbDeleteSession: (id: string) => Promise<any>;
  dbGetSessionWorkDir: (id: string) => Promise<string>;
  dbUpdateSessionWorkDir: (id: string, workDir: string | null) => Promise<any>;
  dbUpdateSessionWorkspace: (id: string, workspaceId: string | null, workDir?: string | null) => Promise<any>;
  dbUpdateSessionPermissionMode: (id: string, permissionMode: string) => Promise<any>;
  dbUpdateSessionReasoningEffort: (id: string, reasoningEffort: string) => Promise<any>;
  dbGetMessages: (sessionId: string) => Promise<any[]>;
  dbGetMessageReasoning: (messageId: string) => Promise<any>;
  dbAddMessage: (message: any) => Promise<any>;
  dbDeleteMessagesAfter: (sessionId: string, timestamp: number) => Promise<any>;
  saveChatAttachment: (payload: any) => Promise<any>;
  deleteChatAttachment: (filePath: string) => Promise<any>;

  // ─── Agent 扩展与 Inspector 监控 ────────────────────
  getMcpServers: (workDir?: string | null) => Promise<any[]>;
  saveMcpServers: (servers: any) => Promise<any>;
  trustProjectMcp: (workDir: string, trusted: boolean) => Promise<any>;
  toggleMcpServer: (id: string, enabled: boolean) => Promise<any>;
  deleteMcpServer: (id: string) => Promise<any>;
  getMcpTools: (serverId: string, workDir?: string | null) => Promise<any>;
  toggleMcpTool: (serverId: string, toolName: string, enabled: boolean, workDir?: string | null) => Promise<any>;
  listMcpResources: (workDir?: string | null) => Promise<any>;
  readMcpResource: (uri: string, workDir?: string | null) => Promise<any>;
  listMcpPrompts: (workDir?: string | null) => Promise<any>;
  getMcpPrompt: (serverId: string, promptName: string, args?: any, workDir?: string | null) => Promise<any>;
  getMcpOAuthStatus: (workDir?: string | null) => Promise<any>;
  authorizeMcpOAuth: (serverId: string, workDir?: string | null) => Promise<any>;
  logoutMcpOAuth: (serverId: string, workDir?: string | null) => Promise<any>;
  getSkills: (workDir?: string | null, includeDisabled?: boolean) => Promise<any[]>;
  toggleSkill: (name: string, enabled: boolean) => Promise<any>;
  deleteSkill: (filePath: string, workDir?: string | null) => Promise<any>;
  importSkill: (options?: any) => Promise<any>;
  fetchSkillMarket: (payload?: any) => Promise<any>;
  installMarketSkill: (item: any, overwrite?: boolean) => Promise<any>;
  getSubagents: (workDir?: string | null) => Promise<any[]>;
  getMemories: (workDir?: string | null) => Promise<any>;
  getSessionOutputs: (sessionId: string) => Promise<any[]>;
  getRepoIndexStats: (workDir: string, refresh?: boolean) => Promise<any>;
  getRepoMap: (workDir: string, maxChars?: number, refresh?: boolean) => Promise<any>;
  searchRepoSymbols: (workDir: string, query: string, limit?: number) => Promise<any>;
  getRepoWiki: (workDir: string) => Promise<any>;
  generateRepoWiki: (workDir: string, model?: string) => Promise<any>;
  getContextMetrics: (params: any) => Promise<any>;
  getWorkspaceGitStatus: (workDir: string | null) => Promise<any>;
  getWorkspaceGitGraph: (workDir: string, limit?: number, scope?: string) => Promise<any>;
  getWorkspaceGitCommitDetail: (workDir: string, hash: string) => Promise<any>;
  getWorkspaceBranches: (workDir: string) => Promise<any>;
  checkoutWorkspaceBranch: (workDir: string, branchName: string, createNew?: boolean) => Promise<any>;
  deleteWorkspaceBranch: (workDir: string, branchName: string, options?: any) => Promise<any>;
  getWorkingTreeChanges: (workDir: string) => Promise<any>;
  commitStagedGitChanges: (workDir: string, message: string) => Promise<any>;
  gitFetch: (workDir: string) => Promise<any>;
  gitPull: (workDir: string) => Promise<any>;
  gitPush: (workDir: string) => Promise<any>;
  gitMergeBranch: (workDir: string, sourceBranch: string) => Promise<any>;
  gitStashAction: (workDir: string, action: string) => Promise<any>;
  gitCherryPick: (workDir: string, hash: string) => Promise<any>;
  gitCreateBranchAt: (workDir: string, branchName: string, startPoint?: string) => Promise<any>;
  getWorkspaceFileDiff: (workDir: string, filePath: string) => Promise<any>;
  commitWorkspaceChanges: (workDir: string, message: string) => Promise<any>;
  getGitFileHunks: (workDir: string, filePath: string, staged?: boolean) => Promise<any>;
  applyGitHunks: (workDir: string, filePath: string, hunkIds: any[], options?: any) => Promise<any>;
  discardGitHunks: (workDir: string, filePath: string, hunkIds: any[]) => Promise<any>;
  discardGitFile: (workDir: string, filePath: string, staged?: boolean) => Promise<any>;
  stageGitFile: (workDir: string, filePath: string) => Promise<any>;
  unstageGitFile: (workDir: string, filePath: string) => Promise<any>;
  stageAllGitChanges: (workDir: string) => Promise<any>;
  createGitPullRequest: (params: any) => Promise<any>;
  listGitWorktrees: (workDir: string) => Promise<any>;
  listGitBranches: (workDir: string) => Promise<any>;
  inspectManagedWorktree: (targetPath: string, sessionId?: string) => Promise<any>;
  inspectGitDirectories: (folders: any[]) => Promise<any>;
  createGitWorktree: (params: any) => Promise<any>;
  createMultiGitWorktrees: (params: any) => Promise<any>;
  saveSessionWorktreeGroup: (sessionId: string, entries: any[]) => Promise<any>;
  removeSessionWorktreeGroup: (sessionId: string) => Promise<any>;
  mergeGitWorktree: (params: any) => Promise<any>;
  removeGitWorktree: (workDir: string, targetPath: string, force?: boolean) => Promise<any>;

  // ─── 斜杠命令 / Spec / Hooks / 会话导出 ──────────────
  getSlashCommands: (workDir?: string | null) => Promise<any[]>;
  listSpecs: (workDir: string) => Promise<any[]>;
  readSpec: (workDir: string, id: string) => Promise<any>;
  saveSpec: (payload: any) => Promise<any>;
  updateSpecStatus: (workDir: string, id: string, status: string) => Promise<any>;
  deleteSpec: (workDir: string, id: string) => Promise<any>;
  getProjectHooks: (workDir?: string | null) => Promise<any>;
  createHooksTemplate: () => Promise<any>;
  setProjectHooksTrust: (workDir: string, trusted: boolean) => Promise<any>;
  forkSession: (sessionId: string, upToMessageId?: string) => Promise<any>;
  exportSession: (sessionId: string) => Promise<any>;

  // ─── 浏览器自动化与工作区文件浏览 ──────────────────
  browserAutoOpen: (url: string, workDir?: string) => Promise<any>;
  browserAutoInspect: (payload?: any) => Promise<any>;
  browserAutoInteract: (payload: any) => Promise<any>;
  browserAutoSnapshot: (payload?: any) => Promise<any>;
  browserAutoLogs: (payload?: any) => Promise<any>;
  browserAutoStop: () => Promise<any>;
  browserAutoSaveBaseline: (payload?: any) => Promise<any>;
  browserAutoState: () => Promise<any>;
  browserAutoBack: () => Promise<any>;
  browserAutoForward: () => Promise<any>;
  browserAutoReload: (payload?: any) => Promise<any>;
  browserAutoClose: () => Promise<any>;
  listWorkspaceDir: (workDir: string, dirPath?: string) => Promise<any>;
  readWorkspaceFile: (workDir: string, filePath: string, maxChars?: number) => Promise<any>;
  runTerminalCommand: (params: any, onStream?: (payload: any) => void) => Promise<any>;
  killTerminalCommand: (cmdId: string) => Promise<any>;

  // ─── 原生 PTY 交互式终端 ──────────────────────────
  createTerminalSession: (params: any) => Promise<any>;
  writeTerminalSession: (terminalId: string, data: string) => void;
  resizeTerminalSession: (terminalId: string, cols: number, rows: number) => Promise<any>;
  disposeTerminalSession: (terminalId: string) => Promise<any>;
  onTerminalPtyData: (callback: (payload: any) => void) => () => void;
  onTerminalPtyExit: (callback: (payload: any) => void) => () => void;
  getWorkspaceFileIndex: (workDir: string) => Promise<any>;
  getRecentProjects: () => Promise<any[]>;
  addRecentProject: (proj: any) => Promise<any>;
  getWorkspaces: () => Promise<any[]>;
  saveWorkspace: (ws: any) => Promise<any>;
  deleteWorkspace: (id: string) => Promise<any>;

  // ─── 工具调用 ──────────────────────────────────────
  getTools: () => Promise<any[]>;
  executeTool: (name: string, args: any, workDir?: string) => Promise<any>;

  // ─── 流式 Agent 调用与控制 ─────────────────────────
  respondPermission: (id: string, allow: boolean, decision?: string) => void;
  cancelChat: (sessionId: string) => void;
  steerChat: (sessionId: string, content: string, id?: string) => void;
  streamChat: (...args: any[]) => void;
  btwChat: (payload?: any, callbacks?: Record<string, any>) => Promise<any>;
  cancelBtw: (btwId: string) => Promise<any>;
  onSteerRejected: (callback: (data: any) => void) => () => void;
  onSessionTitleUpdated: (callback: (data: any) => void) => () => void;
  onSessionPermissionModeUpdated: (callback: (data: any) => void) => () => void;

  // ─── 软件自动更新管理 ─────────────────────────────
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<any>;
  startDownloadUpdate: () => Promise<any>;
  quitAndInstallUpdate: () => Promise<any>;
  openReleasePage: (url: string) => Promise<any>;
  onUpdateChecking: (callback: () => void) => () => void;
  onUpdateAvailable: (callback: (data: any) => void) => () => void;
  onUpdateNotAvailable: (callback: (data: any) => void) => () => void;
  onUpdateDownloadProgress: (callback: (data: any) => void) => () => void;
  onUpdateDownloaded: (callback: (data: any) => void) => () => void;
  onUpdateError: (callback: (data: any) => void) => () => void;

  [key: string]: any;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
