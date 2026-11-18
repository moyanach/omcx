/**
 * storageService.js — OMCX 持久化存储门面 (Worker Thread 隔离架构)
 *
 * 门面职责：路径初始化、内存快照状态持有与子模块工厂装配：
 * - services/storage/dbEngine.js             Worker 队列、WAL 与同线程 SQLite 降级引擎
 * - services/storage/configWorkspaceStorage.js 配置 / 模型池 / 工作空间 / 最近项目
 * - services/storage/sessionMessageStorage.js  会话 / 消息 / 思考分流 / 产出物
 * - services/storage/attachmentStorage.js      会话附件沙箱读写与路径校验
 * - services/storage/mcpStorage.js             MCP 服务配置与项目信任
 * - services/storage/skillsMemoryStorage.js    Skills 扫描与记忆读写
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

let Database = null;
try {
  if (process.env.OMCX_STORAGE_MEMORY_ONLY !== "1") {
    Database = require("better-sqlite3");
  }
} catch {}

const reasoningPolicy = require("./reasoningPolicy");
const { createMcpStorage, writeFileAtomicSync } = require("./storage/mcpStorage");
const { createSkillsMemoryStorage } = require("./storage/skillsMemoryStorage");
const { createDbEngine } = require("./storage/dbEngine");
const {
  inferVisionSupport,
  isModelUsable,
  selectExplicitLiteModel,
  createConfigWorkspaceStorage,
} = require("./storage/configWorkspaceStorage");
const {
  extractLegacyThinking,
  splitThinkingContent,
  createSessionMessageStorage,
} = require("./storage/sessionMessageStorage");
const { createAttachmentStorage } = require("./storage/attachmentStorage");
const { createAutomationStorage } = require("./storage/automationStorage");

function isMemoryOnlyMode() {
  return process.env.OMCX_STORAGE_MEMORY_ONLY === "1" || !Database;
}

const USER_HOME = os.homedir();
let OMCX_HOME = process.env.OMCX_HOME || path.join(USER_HOME, ".omcx");
let DB_FILE = path.join(OMCX_HOME, "omcx.db");
let MCP_FILE = path.join(OMCX_HOME, "mcp.json");
let SKILLS_DIR = path.join(OMCX_HOME, "skills");
let MEMORY_DIR = path.join(OMCX_HOME, "memory");
let SESSIONS_DIR = path.join(OMCX_HOME, "sessions");

function updatePaths(newRoot) {
  OMCX_HOME = newRoot;
  DB_FILE = path.join(OMCX_HOME, "omcx.db");
  MCP_FILE = path.join(OMCX_HOME, "mcp.json");
  SKILLS_DIR = path.join(OMCX_HOME, "skills");
  MEMORY_DIR = path.join(OMCX_HOME, "memory");
  SESSIONS_DIR = path.join(OMCX_HOME, "sessions");
}

function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EACCES") {
      const defaultUserOmcx = path.join(USER_HOME, ".omcx");
      const fallbackRoot = path.join(process.cwd(), ".omcx_local");
      console.warn(`[storageService] 访问 ${dirPath} 权限不足，回退到本地目录: ${fallbackRoot}`);
      updatePaths(fallbackRoot);
      const targetPath = dirPath.startsWith(defaultUserOmcx)
        ? dirPath.replace(defaultUserOmcx, fallbackRoot)
        : fallbackRoot;
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
      }
    } else {
      throw err;
    }
  }
}

const getStoragePaths = () => ({
  OMCX_HOME,
  DB_FILE,
  MCP_FILE,
  SKILLS_DIR,
  MEMORY_DIR,
  SESSIONS_DIR,
});

// ─── 内存级高速只读快照池 (In-Memory Cache) ───────────────────
let memorySessions = [];
let memoryAutomations = [];
let memoryAutomationRuns = [];
const memoryState = {
  configs: new Map(),
  getSessions: () => memorySessions,
  setSessions: (next) => {
    memorySessions = Array.isArray(next) ? next : [];
  },
  getAutomations: () => memoryAutomations,
  setAutomations: (next) => {
    memoryAutomations = Array.isArray(next) ? next : [];
  },
  getAutomationRuns: () => memoryAutomationRuns,
  setAutomationRuns: (next) => {
    memoryAutomationRuns = Array.isArray(next) ? next : [];
  },
  messagesBySession: new Map(),
  outputsBySession: new Map(),
  reasoningsByMsgId: new Map(),
};

const dbEngine = createDbEngine({
  Database,
  isMemoryOnlyMode,
  getPaths: getStoragePaths,
  ensureDir,
  extractLegacyThinking,
  memoryState,
});

const {
  getAllConfig,
  getConfig,
  setConfig,
  getModels,
  addModel,
  deleteModel,
  migratePlaintextSecrets,
  getWorkspaces,
  saveWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  getRecentProjects,
  addRecentProject,
} = createConfigWorkspaceStorage({
  memoryConfigs: memoryState.configs,
  isMemoryOnlyMode,
  getFallbackDb: dbEngine.getFallbackDb,
  sendToWorker: dbEngine.sendToWorker,
});

const {
  getSessionAttachmentsDir,
  saveAttachmentBuffer,
  isSessionAttachmentPath,
  deleteAttachmentFile,
  deleteSessionAttachments,
} = createAttachmentStorage({
  getPaths: getStoragePaths,
  ensureDir,
});

const {
  getSessions,
  getSession,
  saveSession,
  promoteSessionToChat,
  updateSessionGeneratedTitle,
  updateSessionWorkspace,
  deleteSession,
  getMessages,
  getMessagesAsync,
  getMessageByIdAsync,
  getMessageReasoning,
  getMessageReasoningAsync,
  addMessage,
  persistMessageSync,
  deleteMessagesAfter,
  searchSessionsAsync,
  getSessionOutputs,
  getSessionOutputsAsync,
  addSessionOutput,
} = createSessionMessageStorage({
  memoryState,
  isMemoryOnlyMode,
  getConfig,
  reasoningPolicy,
  dbEngine,
  deleteSessionAttachments,
});

const {
  getProjectMcpConfigPath,
  readProjectMcpConfig,
  isProjectMcpTrusted,
  setProjectMcpTrust,
  isProjectHooksTrusted,
  setProjectHooksTrust,
  getMcpServers,
  saveGlobalMcpServers,
  upsertGlobalMcpServer,
  deleteGlobalMcpServer,
} = createMcpStorage({
  getConfig,
  setConfig,
  getPaths: getStoragePaths,
  ensureDir,
});

const {
  getDisabledSkillNames,
  setSkillEnabled,
  getSkills,
  importSkill,
  deleteSkill,
  getMemories,
  getProjectInstructions,
  getMemoryIndex,
} = createSkillsMemoryStorage({
  USER_HOME,
  getConfig,
  setConfig,
  getPaths: getStoragePaths,
  ensureDir,
});

const {
  getAutomations,
  getAutomation,
  saveAutomation,
  deleteAutomation,
  getAutomationRuns,
  getAutomationRun,
  getUnreadAutomationRunCount,
  saveAutomationRun,
  updateAutomationRunTriage,
  markAllAutomationRunsRead,
  deleteAutomationRun,
  getWebhookTargets,
  getWebhookTargetsForRenderer,
  saveWebhookTarget,
  deleteWebhookTarget,
  getInboundWebhookConfig,
  getInboundWebhookConfigForRenderer,
  saveInboundWebhookConfig,
  rotateInboundWebhookToken,
} = createAutomationStorage({
  memoryState,
  getConfig,
  setConfig,
  dbEngine,
});

function initStorage() {
  if (isMemoryOnlyMode()) {
    dbEngine.markSnapshotLoaded();
    if (!getConfig("default_model")) {
      setConfig("default_model", "gpt-4o");
      setConfig("base_url", "https://api.openai.com/v1");
      setConfig("api_key", "");
    }
    console.log(`[storageService] 已启用纯内存存储模式 (无 SQLite 原生依赖)`);
    return;
  }

  ensureDir(OMCX_HOME);
  ensureDir(SKILLS_DIR);
  ensureDir(MEMORY_DIR);
  ensureDir(SESSIONS_DIR);

  dbEngine.initWorkerEngine();
  dbEngine.loadInitialSnapshot();
  try {
    migratePlaintextSecrets();
  } catch (err) {
    console.warn("[storageService] 启动迁移密钥加密失败（已忽略）:", err.message);
  }

  if (!getConfig("default_model")) {
    setConfig("default_model", "gpt-4o");
    setConfig("base_url", "https://api.openai.com/v1");
    setConfig("api_key", "");
  }

  if (!fs.existsSync(MCP_FILE)) {
    const defaultMcp = { mcpServers: {} };
    writeFileAtomicSync(MCP_FILE, JSON.stringify(defaultMcp, null, 2), ensureDir);
  }

  console.log(`[storageService] 存储层架构质变就绪 (0ms 内存秒读 + Worker Thread 异步持久化): ${DB_FILE}`);
}

module.exports = {
  OMCX_HOME,
  isMemoryOnlyMode,
  initStorage,
  getAllConfig,
  getConfig,
  setConfig,
  getModels,
  addModel,
  deleteModel,
  getRecentProjects,
  addRecentProject,
  getWorkspaces,
  saveWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  getSessions,
  getSession,
  saveSession,
  promoteSessionToChat,
  updateSessionWorkspace,
  updateSessionGeneratedTitle,
  deleteSession,
  getMessages,
  getMessagesAsync,
  getMessageByIdAsync,
  getMessageReasoning,
  getMessageReasoningAsync,
  splitThinkingContent,
  extractLegacyThinking,
  addMessage,
  persistMessageSync,
  flushPendingWritesSync: dbEngine.flushPendingWritesSync,
  checkpointWalSync: dbEngine.checkpointWalSync,
  deleteMessagesAfter,
  searchSessionsAsync,
  saveAttachmentBuffer,
  getSessionAttachmentsDir,
  ensureDir,
  deleteAttachmentFile,
  deleteSessionAttachments,
  isSessionAttachmentPath,
  inferVisionSupport,
  isModelUsable,
  selectExplicitLiteModel,
  getMcpServers,
  saveGlobalMcpServers,
  upsertGlobalMcpServer,
  setProjectMcpTrust,
  isProjectMcpTrusted,
  isProjectHooksTrusted,
  setProjectHooksTrust,
  readProjectMcpConfig,
  getSkills,
  setSkillEnabled,
  getDisabledSkillNames,
  deleteSkill,
  importSkill,
  deleteGlobalMcpServer,
  getMemories,
  getMemoryIndex,
  getProjectInstructions,
  getSessionOutputs,
  getSessionOutputsAsync,
  addSessionOutput,
  getAutomations,
  getAutomation,
  saveAutomation,
  deleteAutomation,
  getAutomationRuns,
  getAutomationRun,
  getUnreadAutomationRunCount,
  saveAutomationRun,
  updateAutomationRunTriage,
  markAllAutomationRunsRead,
  deleteAutomationRun,
  getWebhookTargets,
  getWebhookTargetsForRenderer,
  saveWebhookTarget,
  deleteWebhookTarget,
  getInboundWebhookConfig,
  getInboundWebhookConfigForRenderer,
  saveInboundWebhookConfig,
  rotateInboundWebhookToken,
};
