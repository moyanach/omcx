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
  dbSearchSessions: (
    query: string,
    limit?: number
  ) => Promise<
    Array<{
      sessionId: string;
      title: string;
      updatedAt?: number;
      matchType: "title" | "message";
      matchSnippet?: string;
    }>
  >;
  dbAddSession: (session: any) => Promise<any>;
  dbUpdateSessionTitle: (id: string, title: string) => Promise<any>;
  dbDeleteSession: (id: string) => Promise<any>;
  dbGetSessionWorkDir: (id: string) => Promise<string>;
  dbUpdateSessionWorkDir: (id: string, workDir: string | null) => Promise<any>;
  dbUpdateSessionWorkspace: (id: string, workspaceId: string | null, workDir?: string | null) => Promise<any>;
  dbUpdateSessionPermissionMode: (id: string, permissionMode: string) => Promise<any>;
  dbUpdateSessionAgentMode: (id: string, agentMode: "code" | "work") => Promise<any>;
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
  upsertMcpServer: (id: string, config: any) => Promise<{ success: boolean; id?: string; error?: string }>;
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
  previewWorkspaceDocument: (workDir: string, filePath: string) => Promise<any>;
  revertFileModification: (payload: {
    workDir?: string | null;
    filePath: string;
    tool: "edit_file" | "write_file";
    oldText?: string;
    newText?: string;
    isNewFile?: boolean;
    noSnapshot?: boolean;
    replaceAll?: boolean;
  }) => Promise<{ success: boolean; action?: string; path?: string; error?: string }>;
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
  watchWorkspace: (workDir?: string | null) => Promise<string[]>;
  onWorkspaceChanged: (
    callback: (payload: {
      workDir?: string | null;
      reason?: string;
      areas?: string[];
      paths?: string[];
      ts?: number;
    }) => void
  ) => () => void;
  getRecentProjects: () => Promise<any[]>;
  addRecentProject: (proj: any) => Promise<any>;
  getWorkspaces: () => Promise<any[]>;
  saveWorkspace: (ws: any) => Promise<any>;
  deleteWorkspace: (id: string) => Promise<any>;
  reorderWorkspaces: (orderedIds: string[]) => Promise<any>;

  // ─── 工具调用 ──────────────────────────────────────
  getTools: () => Promise<any[]>;
  executeTool: (name: string, args: any, workDir?: string) => Promise<any>;

  // ─── 定时任务与 Webhook ────────────────────────────
  listAutomations: () => Promise<{ rules: any[]; runtime: any; unreadCount: number }>;
  saveAutomation: (payload: any) => Promise<{ success: boolean; rule: any }>;
  deleteAutomation: (id: string) => Promise<{ success: boolean }>;
  toggleAutomation: (id: string, enabled: boolean) => Promise<{ success: boolean; rule: any }>;
  runAutomationNow: (
    id: string,
    extraInput?: string
  ) => Promise<{ ok: boolean; runId?: string; queued?: boolean; error?: string }>;
  cancelAutomationRun: (runId: string) => Promise<{ success: boolean }>;
  previewCronExpression: (
    expr: string
  ) => Promise<{ valid: boolean; error?: string; summary?: string; nextRuns: number[] }>;
  listAutomationRuns: (filters?: {
    automationId?: string | null;
    triageState?: string | null;
    status?: string | null;
    limit?: number;
  }) => Promise<{ runs: any[]; unreadCount: number }>;
  updateAutomationRunTriage: (
    runId: string,
    triageState: "unread" | "read" | "archived"
  ) => Promise<{ success: boolean; unreadCount: number }>;
  markAllAutomationRunsRead: () => Promise<{ success: boolean; unreadCount: number }>;
  deleteAutomationRun: (runId: string) => Promise<{ success: boolean; unreadCount: number }>;
  openAutomationRunSession: (payload: {
    runId?: string;
    sessionId?: string;
  }) => Promise<{ success: boolean; session: any; unreadCount: number }>;
  listWebhookTargets: () => Promise<any[]>;
  saveWebhookTarget: (payload: any) => Promise<{ success: boolean; target: any }>;
  deleteWebhookTarget: (id: string) => Promise<{ success: boolean }>;
  testWebhookTarget: (id: string) => Promise<{ ok: boolean; status?: number }>;
  getInboundWebhookConfig: () => Promise<{ config: any; status: any }>;
  saveInboundWebhookConfig: (payload: any) => Promise<{ success: boolean; config: any; status: any }>;
  rotateInboundWebhookToken: () => Promise<{ success: boolean; config: any; status: any }>;
  onAutomationUpdated: (callback: (payload: any) => void) => () => void;

  // ─── 流式 Agent 调用与控制 ─────────────────────────
  respondPermission: (id: string, allow: boolean, decision?: string) => void;
  respondQuestion: (
    id: string,
    payload: { submitted?: boolean; skipped?: boolean; answers?: Record<string, any> }
  ) => void;
  exportFileOutput: (payload: {
    workDir?: string | null;
    filePath: string;
    format?: "original" | "html" | "pdf";
  }) => Promise<{ success: boolean; canceled?: boolean; savedPath?: string; error?: string }>;
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
