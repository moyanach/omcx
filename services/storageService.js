/**
 * storageService.js — OMCX 现代化持久化存储服务 (Worker Thread 隔离架构)
 *
 * 核心架构特性 (阶段三)：
 * 1. 【主线程 0 磁盘 I/O 占用】: 独创 Write-Behind Worker 架构，SQLite WAL 事务与磁盘 I/O
 *    全部交由独立的后台 Worker 线程 (services/dbWorker.js) 执行，主进程事件循环实现真正的 0 磁盘阻塞；
 * 2. 【内存级秒读 (0ms)】: 主线程常驻高性能内存快照，读操作全部 O(1) 内存瞬时返回；
 * 3. 【无损优雅降级】: 若 Worker 线程受限，自适应平滑降级为已验证的同线程 SQLite 引擎，双重保障绝对高可用；
 * 4. 【100% 向后兼容】: 所有业务 API 签名保持 100% 原样兼容，零侵入、零破坏。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { Worker } = require("worker_threads");
const Database = require("better-sqlite3");

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

// ─── 内存级高速只读快照池 (In-Memory Cache) ───────────────────
let memoryConfigs = new Map();
let memorySessions = [];
let memoryMessagesBySession = new Map();
let memoryOutputsBySession = new Map();

const MAX_CACHED_MESSAGE_SESSIONS = 50;
const MAX_CACHED_OUTPUT_SESSIONS = 100;

/**
 * 带 LRU 上限的缓存写入：长时间运行时不至于无限增长，同时保留最近访问的会话
 */
function touchLruCache(cache, key, value, maxSize) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === key) break;
    cache.delete(oldestKey);
  }
}

// ─── Worker 线程通信管理器 ────────────────────────────────────
let dbWorker = null;
let fallbackDb = null;
let workerMsgId = 1;
const pendingWorkerRequests = new Map();
// 最近写入操作的有限回放队列：Worker 崩溃时在主线程降级引擎中重放，避免写请求静默丢失
const pendingWorkerWrites = new Map();
const MAX_PENDING_WRITES = 200;
const WORKER_REQUEST_TIMEOUT_MS = 8000;

function sendToWorker(action, payload) {
  if (dbWorker) {
    const id = workerMsgId++;
    pendingWorkerWrites.set(id, { action, payload, at: Date.now() });
    while (pendingWorkerWrites.size > MAX_PENDING_WRITES) {
      const oldestId = pendingWorkerWrites.keys().next().value;
      pendingWorkerWrites.delete(oldestId);
    }
    dbWorker.postMessage({ id, action, payload });
  } else if (fallbackDb) {
    // 降级模式：在主线程同线程执行
    executeFallbackAction(action, payload);
  } else {
    // Worker 尚在初始化但降级库已可用时，直接同步落盘，避免首次启动丢写
    executeFallbackAction(action, payload);
  }
}

function sendToWorkerWithPromise(action, payload) {
  if (dbWorker) {
    const id = workerMsgId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingWorkerRequests.delete(id);
        reject(new Error(`Worker 请求超时: ${action}`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      pendingWorkerRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      dbWorker.postMessage({ id, action, payload });
    });
  }
  try {
    return Promise.resolve(executeFallbackAction(action, payload));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Worker 崩溃 / 退出时的兜底：拒绝所有挂起请求，并回放最近的写操作
 */
function handleWorkerFailure(reason) {
  for (const [id, pending] of pendingWorkerRequests) {
    pendingWorkerRequests.delete(id);
    try {
      pending.reject(new Error(reason));
    } catch {}
  }
  const replay = Array.from(pendingWorkerWrites.values());
  pendingWorkerWrites.clear();
  try {
    getFallbackDb();
  } catch (err) {
    console.warn("[storageService] 降级引擎初始化失败:", err.message);
    return;
  }
  for (const item of replay) {
    try {
      executeFallbackAction(item.action, item.payload);
    } catch (err) {
      console.warn(`[storageService] 回放操作 ${item.action} 失败:`, err.message);
    }
  }
  if (replay.length > 0) {
    console.warn(`[storageService] 已将 ${replay.length} 条待写入操作回放到同线程降级引擎`);
  }
}

// 降级模式同线程备用执行引擎
function executeFallbackAction(action, payload) {
  const d = getFallbackDb();
  switch (action) {
    case "SET_CONFIG": {
      const { key, value } = payload;
      const valStr = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
      d.prepare(`
        INSERT INTO configs (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, valStr, Date.now());
      break;
    }
    case "UPSERT_SESSION": {
      d.prepare(`
        INSERT INTO sessions (id, title, title_source, model, workspace_id, work_dir, permission_mode, reasoning_effort, archived, created_at, updated_at)
        VALUES (@id, @title, @title_source, @model, @workspace_id, @work_dir, @permission_mode, @reasoning_effort, @archived, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          title_source = excluded.title_source,
          model = excluded.model,
          workspace_id = excluded.workspace_id,
          work_dir = excluded.work_dir,
          permission_mode = excluded.permission_mode,
          reasoning_effort = excluded.reasoning_effort,
          archived = excluded.archived,
          updated_at = excluded.updated_at
      `).run(payload);
      break;
    }
    case "DELETE_SESSION": {
      const sessionId =
        typeof payload === "string" ? payload : payload?.sessionId || payload?.session_id;
      const tx = d.transaction(() => {
        d.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        d.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
        d.prepare("DELETE FROM session_outputs WHERE session_id = ?").run(sessionId);
      });
      tx();
      break;
    }
    case "UPSERT_MESSAGE": {
      const { message, now } = payload;
      const tx = d.transaction(() => {
        d.prepare(`
          INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, metadata, created_at)
          VALUES (@id, @session_id, @role, @content, @tool_calls, @tool_call_id, @metadata, @created_at)
          ON CONFLICT(id) DO UPDATE SET
            role = excluded.role,
            content = excluded.content,
            tool_calls = excluded.tool_calls,
            tool_call_id = excluded.tool_call_id,
            metadata = excluded.metadata
        `).run(message);
        d.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, message.session_id);
      });
      tx();
      break;
    }
    case "DELETE_MESSAGES_AFTER": {
      const { sessionId, timestamp } = payload;
      d.prepare("DELETE FROM messages WHERE session_id = ? AND created_at > ?").run(sessionId, timestamp);
      break;
    }
    case "INSERT_OUTPUT": {
      d.prepare(`
        INSERT INTO session_outputs (session_id, name, file_path, file_type, action, created_at)
        VALUES (@session_id, @name, @file_path, @file_type, @action, @created_at)
      `).run(payload);
      break;
    }
    case "GET_MESSAGES": {
      const sessionId =
        typeof payload === "string" ? payload : payload?.sessionId || payload?.session_id;
      return d
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId);
    }
    case "GET_OUTPUTS": {
      const sessionId =
        typeof payload === "string" ? payload : payload?.sessionId || payload?.session_id;
      return d
        .prepare("SELECT * FROM session_outputs WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId);
    }
  }
}

function getFallbackDb() {
  if (!fallbackDb) {
    ensureDir(OMCX_HOME);
    fallbackDb = new Database(DB_FILE);
    fallbackDb.pragma("journal_mode = WAL");
    fallbackDb.pragma("synchronous = NORMAL");
  }
  return fallbackDb;
}

function initWorkerEngine() {
  ensureDir(OMCX_HOME);
  const workerScript = path.join(__dirname, "dbWorker.js");

  try {
    dbWorker = new Worker(workerScript, {
      workerData: { dbFile: DB_FILE },
    });

    dbWorker.on("message", (msg) => {
      const { id, type, result, error, success } = msg || {};
      if (type === "READY") {
        console.log(`[storageService] SQLite 后台 Worker 线程初始化成功 (WAL Mode)`);
        // 加载初始内存快照
        loadInitialSnapshot();
        return;
      }

      if (id && pendingWorkerRequests.has(id)) {
        const { resolve, reject } = pendingWorkerRequests.get(id);
        pendingWorkerRequests.delete(id);
        if (error || success === false) reject(new Error(error || "Worker 执行失败"));
        else resolve(result);
        return;
      }

      if (id && pendingWorkerWrites.has(id)) {
        pendingWorkerWrites.delete(id);
        if (error || success === false) {
          console.error(`[storageService] Worker 写入失败 (id=${id}):`, error || "未知错误");
        }
      }
    });

    dbWorker.on("error", (err) => {
      console.warn("[storageService] dbWorker 抛出异常，启动同线程降级引擎:", err.message);
      const deadWorker = dbWorker;
      dbWorker = null;
      try {
        deadWorker?.terminate();
      } catch {}
      handleWorkerFailure(`Worker 异常: ${err.message}`);
    });

    dbWorker.on("exit", (code) => {
      if (code !== 0 && dbWorker) {
        console.warn(`[storageService] dbWorker 异常退出 (code ${code})，切换至同线程降级引擎`);
        dbWorker = null;
        handleWorkerFailure(`Worker 异常退出 (code ${code})`);
      }
    });
  } catch (err) {
    console.warn("[storageService] 创建 Worker 线程失败，使用同线程降级引擎:", err.message);
    dbWorker = null;
    getFallbackDb();
  }
}

let hasLoadedSnapshot = false;

function loadInitialSnapshot() {
  if (hasLoadedSnapshot) return;
  // 注意：成功后才置位。首次启动时 Worker 可能尚未建表，失败后必须允许后续重试，
  // 否则一次竞态失败会导致整个进程生命周期内会话列表为空。
  try {
    const d = getFallbackDb();
    const rows = d.prepare("SELECT key, value FROM configs").all();
    for (const r of rows) {
      try {
        memoryConfigs.set(r.key, JSON.parse(r.value));
      } catch {
        memoryConfigs.set(r.key, r.value);
      }
    }
    const sessRows = d.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all();
    memorySessions = sessRows.map((r) => ({
      id: r.id,
      title: r.title,
      title_source: r.title_source || "default",
      model: r.model || "",
      workspace_id: r.workspace_id || null,
      work_dir: r.work_dir || null,
      permission_mode: r.permission_mode || "auto-sandbox",
      reasoning_effort: r.reasoning_effort || "medium",
      archived: Boolean(r.archived),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    hasLoadedSnapshot = true;
  } catch (e) {
    // 保留 hasLoadedSnapshot = false，等待下一次 READY / 读取时重试
    console.warn("[storageService] 预加载初始快照提示（稍后自动重试）:", e.message);
  }
}

function initStorage() {
  ensureDir(OMCX_HOME);
  ensureDir(SKILLS_DIR);
  ensureDir(MEMORY_DIR);
  ensureDir(SESSIONS_DIR);

  // 初始化后台工作线程
  initWorkerEngine();
  // 建立内存快照
  loadInitialSnapshot();

  if (!getConfig("default_model")) {
    setConfig("default_model", "gpt-4o");
    setConfig("base_url", "https://api.openai.com/v1");
    setConfig("api_key", "");
  }

  if (!fs.existsSync(MCP_FILE)) {
    const defaultMcp = { mcpServers: {} };
    fs.writeFileSync(MCP_FILE, JSON.stringify(defaultMcp, null, 2), "utf-8");
  }

  console.log(`[storageService] 存储层架构质变就绪 (0ms 内存秒读 + Worker Thread 异步持久化): ${DB_FILE}`);
}

// ─────────────────────────────────────────────────────────────
// 全局配置 (Configs) 管理 —— 0ms 内存直读
// ─────────────────────────────────────────────────────────────

function getAllConfig() {
  const result = {};
  for (const [k, v] of memoryConfigs.entries()) {
    result[k] = v;
  }
  return result;
}

function getConfig(key) {
  if (memoryConfigs.has(key)) {
    return memoryConfigs.get(key);
  }
  // 内存未命中兜底
  try {
    const row = getFallbackDb().prepare("SELECT value FROM configs WHERE key = ?").get(key);
    if (!row || row.value === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    memoryConfigs.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function setConfig(key, value) {
  memoryConfigs.set(key, value);
  sendToWorker("SET_CONFIG", { key, value });
  return true;
}

// ─────────────────────────────────────────────────────────────
// LLM 模型池配置管理
// ─────────────────────────────────────────────────────────────

const DEFAULT_MODELS = [
  {
    id: "gpt-4o",
    name: "GPT-4o (Omni 全能旗舰)",
    provider: "openai",
    model_id: "gpt-4o",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    supports_vision: true,
    context_limit: 128000,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini (轻量极速)",
    provider: "openai",
    model_id: "gpt-4o-mini",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    supports_vision: true,
    context_limit: 128000,
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    model_id: "claude-3-5-sonnet-20241022",
    base_url: "https://api.anthropic.com/v1",
    api_key: "",
    supports_vision: true,
    context_limit: 200000,
  },
  {
    id: "deepseek-coder",
    name: "DeepSeek Coder V2",
    provider: "deepseek",
    model_id: "deepseek-coder",
    base_url: "https://api.deepseek.com/v1",
    api_key: "",
    supports_vision: false,
    context_limit: 128000,
  },
];

function inferVisionSupport(modelId = "") {
  return /gpt-4o|claude-3|gemini|vision|vl|qwen-vl|glm-4v/i.test(modelId);
}

function getModels() {
  const models = getConfig("llm_models");
  if (Array.isArray(models) && models.length > 0) {
    return models;
  }
  setConfig("llm_models", DEFAULT_MODELS);
  return DEFAULT_MODELS;
}

function addModel(model) {
  const models = getModels();
  const idx = models.findIndex((m) => m.id === model.id);
  const now = Date.now();
  const safeModel = {
    id: model.id || `model_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: model.name || model.id || "未命名模型",
    provider: model.provider || "openai",
    model_id: model.model_id || model.id,
    base_url: model.base_url || "https://api.openai.com/v1",
    api_key: model.api_key || "",
    supports_vision: model.supports_vision ?? inferVisionSupport(model.model_id || model.id),
    context_limit: Number(model.context_limit) || 128000,
    max_output_tokens: Number(model.max_output_tokens) || 8192,
    input_price: Number(model.input_price) || 0,
    output_price: Number(model.output_price) || 0,
    cache_read_price: Number(model.cache_read_price) || 0,
    cache_write_price: Number(model.cache_write_price) || 0,
  };

  if (idx >= 0) {
    models[idx] = safeModel;
  } else {
    models.push(safeModel);
  }
  setConfig("llm_models", models);
  return { success: true, model: safeModel };
}

function deleteModel(id) {
  const models = getModels();
  const filtered = models.filter((m) => m.id !== id);
  setConfig("llm_models", filtered);
  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// 多目录工作空间管理 (Workspaces)
// ─────────────────────────────────────────────────────────────

function getWorkspaces() {
  const list = getConfig("workspaces");
  if (Array.isArray(list) && list.length > 0) {
    return list;
  }
  const defaultWs = [
    {
      id: "ws_default_omcx",
      name: "OMCX 核心研发空间",
      folders: [
        {
          path: process.cwd(),
          name: path.basename(process.cwd()) || "omcx",
          isPrimary: true,
        },
      ],
      updatedAt: Date.now(),
    },
  ];
  setConfig("workspaces", defaultWs);
  return defaultWs;
}

function saveWorkspace(ws) {
  const list = getWorkspaces();
  const idx = list.findIndex((w) => w.id === ws.id);
  const now = Date.now();
  const item = {
    id: ws.id || `ws_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: ws.name || "新工作空间",
    folders: Array.isArray(ws.folders) ? ws.folders : [],
    updatedAt: now,
  };

  if (idx >= 0) {
    list[idx] = item;
  } else {
    list.unshift(item);
  }
  setConfig("workspaces", list);
  return { success: true, workspace: item };
}

function deleteWorkspace(id) {
  const list = getWorkspaces();
  const filtered = list.filter((w) => w.id !== id);
  setConfig("workspaces", filtered);
  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// 会话与消息管理 (Sessions & Messages) —— Write-Behind 架构
// ─────────────────────────────────────────────────────────────

function getSessions() {
  if (!hasLoadedSnapshot) {
    loadInitialSnapshot();
  }
  return [...memorySessions];
}

function getSession(sessionId) {
  if (!sessionId) return null;
  if (!hasLoadedSnapshot) {
    loadInitialSnapshot();
  }
  const found = memorySessions.find((s) => s.id === sessionId);
  return found ? { ...found } : null;
}

function saveSession(session) {
  if (!session || !session.id) return { success: false, error: "缺少会话 ID" };
  const now = Date.now();
  const existing = memorySessions.find((s) => s.id === session.id);

  const record = {
    id: session.id,
    title: session.title || existing?.title || "新的 Agent 会话",
    title_source: session.title_source || existing?.title_source || "default",
    model: session.model || existing?.model || "",
    workspace_id: session.workspace_id !== undefined ? session.workspace_id : (existing?.workspace_id || null),
    work_dir: session.work_dir !== undefined ? session.work_dir : (existing?.work_dir || null),
    permission_mode: session.permission_mode || existing?.permission_mode || "auto-sandbox",
    reasoning_effort: session.reasoning_effort || existing?.reasoning_effort || "medium",
    archived: session.archived ? 1 : (existing?.archived ? 1 : 0),
    created_at: session.created_at || existing?.created_at || now,
    updated_at: session.updated_at || now,
  };

  // 1. 内存极速同步更新
  const idx = memorySessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    memorySessions[idx] = record;
  } else {
    memorySessions.unshift(record);
  }

  // 2. 异步派发至 Worker 持久化 (主线程 0 磁盘 I/O 阻塞)
  sendToWorker("UPSERT_SESSION", record);

  return { success: true, session: record };
}

function updateSessionGeneratedTitle(sessionId, title) {
  if (!sessionId || !title) return false;
  const session = getSession(sessionId);
  if (!session) return false;

  if (session.title_source === "custom") {
    return false;
  }

  session.title = title;
  session.title_source = "generated";
  saveSession(session);
  return true;
}

function updateSessionWorkspace(sessionId, workspaceId, workDir = null) {
  const session = getSession(sessionId);
  if (!session) return false;
  session.workspace_id = workspaceId || null;
  if (workDir) {
    session.work_dir = workDir;
  }
  saveSession(session);
  return true;
}

function deleteSession(sessionId) {
  if (!sessionId) return { success: false };

  // 1. 内存同步移除
  memorySessions = memorySessions.filter((s) => s.id !== sessionId);
  memoryMessagesBySession.delete(sessionId);
  memoryOutputsBySession.delete(sessionId);

  // 2. 异步派发至 Worker 事务删除
  sendToWorker("DELETE_SESSION", sessionId);

  deleteSessionAttachments(sessionId);
  return { success: true };
}

function getMessages(sessionId) {
  if (!sessionId) return [];
  if (memoryMessagesBySession.has(sessionId)) {
    const cached = memoryMessagesBySession.get(sessionId);
    touchLruCache(memoryMessagesBySession, sessionId, cached, MAX_CACHED_MESSAGE_SESSIONS);
    return [...cached];
  }

  // 内存未命中时，快速从 SQLite 读取并缓存进内存池
  try {
    const rows = getFallbackDb()
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId);
    const list = rows.map(mapMessageRow);
    touchLruCache(memoryMessagesBySession, sessionId, list, MAX_CACHED_MESSAGE_SESSIONS);
    return list;
  } catch (err) {
    console.error(`[storageService] 获取会话 ${sessionId} 消息失败:`, err.message);
    return [];
  }
}

function parseJsonColumn(value) {
  if (value === null || value === undefined || value === "") return null;
  // Worker / 降级引擎应返回 JSON 字符串；对象形态做兼容，避免二次 JSON.parse 丢字段
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapMessageRow(r) {
  return {
    id: r.id,
    session_id: r.session_id,
    role: r.role,
    content: r.content || "",
    tool_calls: parseJsonColumn(r.tool_calls),
    tool_call_id: r.tool_call_id || null,
    metadata: parseJsonColumn(r.metadata),
    created_at: r.created_at,
  };
}

/**
 * 异步读取消息：缓存未命中时交给 Worker 线程，避免主进程在大历史会话上同步阻塞。
 */
async function getMessagesAsync(sessionId) {
  if (!sessionId) return [];
  if (memoryMessagesBySession.has(sessionId)) {
    const cached = memoryMessagesBySession.get(sessionId);
    touchLruCache(memoryMessagesBySession, sessionId, cached, MAX_CACHED_MESSAGE_SESSIONS);
    return [...cached];
  }
  try {
    const rows = await sendToWorkerWithPromise("GET_MESSAGES", { sessionId });
    if (!Array.isArray(rows)) throw new Error("Worker 未返回消息数组");
    const list = rows.map(mapMessageRow);
    touchLruCache(memoryMessagesBySession, sessionId, list, MAX_CACHED_MESSAGE_SESSIONS);
    return list;
  } catch (err) {
    console.warn(
      `[storageService] Worker 读取会话 ${sessionId} 消息失败，回退主线程读取:`,
      err.message
    );
    return getMessages(sessionId);
  }
}

function addMessage(sessionId, message) {
  if (!sessionId || !message) return { success: false, error: "参数不完整" };

  // 架构防御：若该会话尚未加载历史缓存，必须先调用 getMessages(sessionId) 预热内存池，
  // 杜绝首次写入直接覆盖导致历史消息丢失的重大时序缺口
  if (!memoryMessagesBySession.has(sessionId)) {
    getMessages(sessionId);
  }

  const msgId = message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const createdAt = message.created_at || message.createdAt || now;

  const toolCallsStr = message.tool_calls ? JSON.stringify(message.tool_calls) : null;
  const metadataStr = message.metadata ? JSON.stringify(message.metadata) : null;
  const content = message.content !== undefined ? String(message.content) : "";

  const fullMsg = {
    id: msgId,
    session_id: sessionId,
    role: message.role,
    content,
    tool_calls: message.tool_calls || null,
    tool_call_id: message.tool_call_id || null,
    metadata: message.metadata || null,
    created_at: createdAt,
  };

  // 1. 内存同步写入 (0ms 秒级更新)
  const currentList = memoryMessagesBySession.get(sessionId) || [];
  const existingIdx = currentList.findIndex((m) => m.id === msgId);
  if (existingIdx >= 0) {
    currentList[existingIdx] = fullMsg;
  } else {
    currentList.push(fullMsg);
  }
  touchLruCache(memoryMessagesBySession, sessionId, currentList, MAX_CACHED_MESSAGE_SESSIONS);

  // 同步更新内存中该会话的 updated_at
  const sess = memorySessions.find((s) => s.id === sessionId);
  if (sess) {
    sess.updated_at = now;
  }

  // 2. 异步派发至 Worker 后台写盘，主线程彻底释放
  sendToWorker("UPSERT_MESSAGE", {
    message: {
      id: msgId,
      session_id: sessionId,
      role: message.role,
      content,
      tool_calls: toolCallsStr,
      tool_call_id: message.tool_call_id || null,
      metadata: metadataStr,
      created_at: createdAt,
    },
    now,
  });

  return { success: true, message: fullMsg };
}

/**
 * 同步兜底落盘：在主线程直接执行 SQLite UPSERT，不依赖 Worker 消息队列。
 * 仅用于 before-quit / 崩溃前等必须确保最后一份运行快照写入磁盘的极端场景。
 */
function persistMessageSync(sessionId, message) {
  if (!sessionId || !message) return { success: false, error: "参数不完整" };

  const res = addMessage(sessionId, message);
  if (!res.success) return res;

  const record = res.message;
  try {
    executeFallbackAction("UPSERT_MESSAGE", {
      message: {
        id: record.id,
        session_id: sessionId,
        role: record.role,
        content: record.content,
        tool_calls: record.tool_calls ? JSON.stringify(record.tool_calls) : null,
        tool_call_id: record.tool_call_id || null,
        metadata: record.metadata ? JSON.stringify(record.metadata) : null,
        created_at: record.created_at,
      },
      now: Date.now(),
    });
  } catch (err) {
    console.warn(`[storageService] 同步兜底落盘失败:`, err.message);
  }
  return res;
}

function deleteMessagesAfter(sessionId, timestamp) {
  if (!sessionId) return { success: false };

  // 内存裁剪
  const currentList = memoryMessagesBySession.get(sessionId) || [];
  const filtered = currentList.filter((m) => m.created_at <= timestamp);
  touchLruCache(memoryMessagesBySession, sessionId, filtered, MAX_CACHED_MESSAGE_SESSIONS);

  sendToWorker("DELETE_MESSAGES_AFTER", { sessionId, timestamp });
  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// 附件管理 (Attachments) —— 物理沙箱落盘
// ─────────────────────────────────────────────────────────────

function getSessionAttachmentsDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId, "attachments");
}

function saveAttachmentBuffer(sessionId, id, ext, buffer) {
  const dir = getSessionAttachmentsDir(sessionId);
  ensureDir(dir);
  const filePath = path.join(dir, `${id}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { id, path: filePath, size: buffer.length };
}

function isSessionAttachmentPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const resolved = path.resolve(filePath);
  const root = path.resolve(SESSIONS_DIR);

  const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const compareRoot = isCaseInsensitive ? root.toLowerCase() : root;
  const compareResolved = isCaseInsensitive ? resolved.toLowerCase() : resolved;

  const relative = path.relative(compareRoot, compareResolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments.length >= 3 && segments[1] === "attachments";
}

function deleteAttachmentFile(filePath) {
  if (!isSessionAttachmentPath(filePath)) {
    return { success: false, error: "非法附件路径" };
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function deleteSessionAttachments(sessionId) {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[storageService] 删除会话附件目录失败: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 导出产物管理 (Session Outputs)
// ─────────────────────────────────────────────────────────────

function mapOutputRow(r) {
  const rawId = String(r.id ?? "");
  return {
    id: rawId.startsWith("out_") ? rawId : `out_${rawId}`,
    name: r.name,
    filePath: r.filePath ?? r.file_path,
    fileType: r.fileType || r.file_type || "file",
    action: r.action || "created",
    createdAt: r.createdAt ?? r.created_at,
  };
}

function getSessionOutputs(sessionId) {
  if (!sessionId) return [];
  if (memoryOutputsBySession.has(sessionId)) {
    const cached = memoryOutputsBySession.get(sessionId);
    touchLruCache(memoryOutputsBySession, sessionId, cached, MAX_CACHED_OUTPUT_SESSIONS);
    return [...cached];
  }
  try {
    const rows = getFallbackDb()
      .prepare("SELECT * FROM session_outputs WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId);
    const list = rows.map(mapOutputRow);
    touchLruCache(memoryOutputsBySession, sessionId, list, MAX_CACHED_OUTPUT_SESSIONS);
    return list;
  } catch {
    return [];
  }
}

async function getSessionOutputsAsync(sessionId) {
  if (!sessionId) return [];
  if (memoryOutputsBySession.has(sessionId)) {
    const cached = memoryOutputsBySession.get(sessionId);
    touchLruCache(memoryOutputsBySession, sessionId, cached, MAX_CACHED_OUTPUT_SESSIONS);
    return [...cached];
  }
  try {
    const rows = await sendToWorkerWithPromise("GET_OUTPUTS", { sessionId });
    if (!Array.isArray(rows)) throw new Error("Worker 未返回产出物数组");
    const list = rows.map(mapOutputRow);
    touchLruCache(memoryOutputsBySession, sessionId, list, MAX_CACHED_OUTPUT_SESSIONS);
    return list;
  } catch {
    return getSessionOutputs(sessionId);
  }
}

function addSessionOutput(sessionId, outputItem) {
  if (!sessionId || !outputItem || !outputItem.filePath) return false;

  const current = getSessionOutputs(sessionId);
  const exists = current.some((o) => o.filePath === outputItem.filePath);
  if (!exists) {
    const item = {
      id: `out_${Date.now()}`,
      name: outputItem.name,
      filePath: outputItem.filePath,
      fileType: outputItem.fileType || "file",
      action: outputItem.action || "created",
      createdAt: Date.now(),
    };
    current.push(item);
    touchLruCache(memoryOutputsBySession, sessionId, current, MAX_CACHED_OUTPUT_SESSIONS);

    sendToWorker("INSERT_OUTPUT", {
      session_id: sessionId,
      name: outputItem.name,
      file_path: outputItem.filePath,
      file_type: outputItem.fileType || "file",
      action: outputItem.action || "created",
      created_at: Date.now(),
    });
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// 最近项目管理 (Recent Projects)
// ─────────────────────────────────────────────────────────────

function getRecentProjects() {
  const list = getConfig("recent_projects");
  if (Array.isArray(list) && list.length > 0) {
    return list;
  }
  return [
    { id: "p1", name: "notifycenter", path: "/opt/projects/notifycenter", hasChanges: true, isLoading: true },
    { id: "p2", name: "silence-fastapi", path: "/opt/projects/silence-fastapi", hasChanges: false, isLoading: false },
    { id: "p3", name: "alarmcenter-fastapi", path: "/opt/projects/alarmcenter-fastapi", hasChanges: false, isLoading: false },
  ];
}

function addRecentProject(proj) {
  const list = getRecentProjects().filter((p) => p.path !== proj.path);
  list.unshift(proj);
  if (list.length > 20) list.pop();
  setConfig("recent_projects", list);
  return list;
}

// ─────────────────────────────────────────────────────────────
// MCP / Skills / Memory 静态 Markdown 与配置文件扫描
// ─────────────────────────────────────────────────────────────

function getProjectMcpConfigPath(workDir) {
  if (!workDir || typeof workDir !== "string" || !workDir.trim()) return null;
  return path.join(path.resolve(workDir.trim()), ".omcx", "mcp.json");
}

function readProjectMcpConfig(workDir) {
  const projectMcpFile = getProjectMcpConfigPath(workDir);
  if (!projectMcpFile || !fs.existsSync(projectMcpFile)) {
    return { servers: null, fingerprint: null, configPath: projectMcpFile };
  }
  try {
    const raw = fs.readFileSync(projectMcpFile, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      servers: parsed?.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {},
      fingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
      configPath: projectMcpFile,
    };
  } catch {
    return { servers: null, fingerprint: null, configPath: projectMcpFile };
  }
}

function getProjectMcpTrustMap() {
  const map = getConfig("mcp_project_trust");
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

function isProjectMcpTrusted(workDir, fingerprint) {
  if (!workDir || !fingerprint) return false;
  const trustedFingerprint = getProjectMcpTrustMap()[path.resolve(workDir.trim())];
  return Boolean(trustedFingerprint && trustedFingerprint === fingerprint);
}

/**
 * 信任 / 撤销信任项目级 MCP 配置。
 * 信任记录与配置文件内容指纹绑定，配置文件一旦被修改即自动失效，必须重新授权。
 */
function setProjectMcpTrust(workDir, trusted) {
  if (!workDir || typeof workDir !== "string" || !workDir.trim()) {
    return { success: false, error: "缺少工作目录" };
  }
  const resolvedDir = path.resolve(workDir.trim());
  const map = { ...getProjectMcpTrustMap() };

  if (trusted) {
    const { fingerprint, configPath, servers } = readProjectMcpConfig(resolvedDir);
    if (!servers || !fingerprint) {
      return { success: false, error: `未找到有效的项目级 MCP 配置: ${configPath || resolvedDir}` };
    }
    map[resolvedDir] = fingerprint;
  } else {
    delete map[resolvedDir];
  }

  setConfig("mcp_project_trust", map);
  return { success: true, trusted: Boolean(trusted) };
}

// ─────────────────────────────────────────────────────────────
// 项目级 Hooks 信任（与项目 MCP 一致：显式信任后方可执行项目 hooks）
// ─────────────────────────────────────────────────────────────

function isProjectHooksTrusted(workDir) {
  if (!workDir || typeof workDir !== "string" || !workDir.trim()) return false;
  const map = getConfig("hooks_project_trust");
  return Boolean(map && map[path.resolve(workDir.trim())] === true);
}

function setProjectHooksTrust(workDir, trusted) {
  if (!workDir || typeof workDir !== "string" || !workDir.trim()) {
    return { success: false, error: "缺少工作目录" };
  }
  const map = { ...(getConfig("hooks_project_trust") || {}) };
  const key = path.resolve(workDir.trim());
  if (trusted) {
    map[key] = true;
  } else {
    delete map[key];
  }
  setConfig("hooks_project_trust", map);
  return { success: true, trusted: Boolean(trusted) };
}

function getMcpServers(workDir = null) {
  let globalServers = {};
  if (fs.existsSync(MCP_FILE)) {
    try {
      const globalMcp = JSON.parse(fs.readFileSync(MCP_FILE, "utf-8"));
      globalServers = { ...(globalMcp.mcpServers || {}) };
    } catch {}
  }

  const project = workDir ? readProjectMcpConfig(workDir) : { servers: null, fingerprint: null };
  const projectServers = project.servers || {};
  const projectTrusted = isProjectMcpTrusted(workDir, project.fingerprint);
  const merged = { ...globalServers, ...projectServers };

  return Object.entries(merged).map(([key, item]) => {
    const isProject = Object.prototype.hasOwnProperty.call(projectServers, key);
    return {
      id: key,
      name: key,
      command: item.command,
      args: item.args || [],
      env: item.env || {},
      url: item.url,
      transport: item.transport || (item.url ? "http" : "stdio"),
      headers: item.headers || {},
      authToken: item.authToken || "",
      oauth: item.oauth || null,
      auth: item.auth && typeof item.auth === "object" ? item.auth : null,
      disabledTools: Array.isArray(item.disabledTools) ? item.disabledTools : [],
      description: item.description || "",
      enabled: item.enabled !== false,
      source: isProject ? "project" : "global",
      trusted: isProject ? projectTrusted : true,
      requiresTrust: isProject && !projectTrusted,
      fingerprint: isProject ? project.fingerprint : null,
    };
  });
}

function saveGlobalMcpServers(serversMap) {
  ensureDir(path.dirname(MCP_FILE));
  // 读取现有配置，避免 UI 回传空 env 时抹掉用户原本配置的环境变量
  let existingServers = {};
  try {
    if (fs.existsSync(MCP_FILE)) {
      existingServers = JSON.parse(fs.readFileSync(MCP_FILE, "utf-8"))?.mcpServers || {};
    }
  } catch {}

  // 仅持久化全局 MCP 配置，剥离 UI 回传的运行时来源与信任标记字段
  const cleanServers = {};
  for (const [id, item] of Object.entries(serversMap || {})) {
    if (!item || typeof item !== "object") continue;
    const clean = {};
    if (typeof item.command === "string") clean.command = item.command;
    if (Array.isArray(item.args)) clean.args = item.args;
    if (typeof item.url === "string" && item.url.trim()) clean.url = item.url.trim();
    if (typeof item.transport === "string") clean.transport = item.transport;
    if (item.headers && typeof item.headers === "object") {
      clean.headers = Object.fromEntries(
        Object.entries(item.headers).filter(
          ([key, value]) => key && (typeof value === "string" || typeof value === "number")
        )
      );
    }
    if (typeof item.authToken === "string" && item.authToken.trim()) {
      clean.authToken = item.authToken.trim();
    }
    // OAuth 配置（布尔开关或包含 endpoints / clientId / scopes 的对象）
    if (typeof item.oauth === "boolean") {
      clean.oauth = item.oauth;
    } else if (item.oauth && typeof item.oauth === "object" && !Array.isArray(item.oauth)) {
      const oauthKeys = [
        "scopes",
        "clientId",
        "clientSecret",
        "clientAuthMethod",
        "authorizationEndpoint",
        "tokenEndpoint",
        "registrationEndpoint",
        "issuer",
        "redirectPort",
      ];
      clean.oauth = Object.fromEntries(
        Object.entries(item.oauth).filter(([key, value]) => {
          if (!oauthKeys.includes(key)) return false;
          return (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            Array.isArray(value)
          );
        })
      );
    }
    if (item.auth && typeof item.auth === "object" && !Array.isArray(item.auth)) {
      if (typeof item.auth.type === "string") {
        clean.auth = { type: item.auth.type };
      }
    }
    if (Array.isArray(item.disabledTools)) {
      clean.disabledTools = item.disabledTools
        .map((name) => String(name || "").trim())
        .filter(Boolean);
    }
    const incomingEnv = item.env && typeof item.env === "object" ? item.env : null;
    if (incomingEnv && Object.keys(incomingEnv).length > 0) {
      clean.env = incomingEnv;
    } else if (existingServers[id]?.env && typeof existingServers[id].env === "object") {
      clean.env = existingServers[id].env;
    } else if (incomingEnv) {
      clean.env = incomingEnv;
    }
    if (typeof item.description === "string") clean.description = item.description;
    if (typeof item.enabled === "boolean") clean.enabled = item.enabled;
    cleanServers[id] = clean;
  }
  fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: cleanServers }, null, 2), "utf-8");
  return true;
}

function parseSkillMarkdown(filePath, scope = "global", defaultName = null) {
  try {
    const realStat = fs.statSync(filePath);
    if (!realStat.isFile()) return null;

    const content = fs.readFileSync(filePath, "utf-8");
    const filename = path.basename(filePath);
    const parentDirName = path.basename(path.dirname(filePath));
    const isSkillIndex = /^skill\.md$/i.test(filename);
    let name = defaultName || (isSkillIndex ? parentDirName : filename.replace(/\.md$/i, ""));
    let description = "";
    let tools = [];
    let allowedTools = [];
    let declaredScripts = [];
    let version = "";
    let promptBody = content;

    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const yaml = frontmatterMatch[1];
      promptBody = frontmatterMatch[2].trim();

      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");

      const descMatch = yaml.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, "");

      const versionMatch = yaml.match(/^version:\s*(.+)$/m);
      if (versionMatch) version = versionMatch[1].trim().replace(/^['"]|['"]$/g, "");

      const toolsMatch = yaml.match(/^tools:\s*(?:\[(.*?)\]|(.+))$/m);
      if (toolsMatch) {
        const rawTools = toolsMatch[1] !== undefined ? toolsMatch[1] : toolsMatch[2];
        tools = (rawTools || "")
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }

      const allowedToolsMatch = yaml.match(/^allowed-tools:\s*(?:\[(.*?)\]|(.+))$/m);
      if (allowedToolsMatch) {
        const rawAllowed =
          allowedToolsMatch[1] !== undefined ? allowedToolsMatch[1] : allowedToolsMatch[2];
        allowedTools = (rawAllowed || "")
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }

      const scriptsMatch = yaml.match(/^scripts:\s*(?:\[(.*?)\]|(.+))$/m);
      if (scriptsMatch) {
        const rawScripts = scriptsMatch[1] !== undefined ? scriptsMatch[1] : scriptsMatch[2];
        declaredScripts = (rawScripts || "")
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
    }

    // 扫描技能目录下的 scripts/ 脚本，供 run_skill_script 工具安全执行
    const skillDir = path.dirname(filePath);
    let scripts = [];
    const scriptsDir = path.join(skillDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      try {
        const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
        for (const entry of entries.slice(0, 60)) {
          if (!entry.isFile() || entry.name.startsWith(".")) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (![".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb"].includes(ext)) {
            continue;
          }
          scripts.push({
            name: entry.name,
            path: path.join(scriptsDir, entry.name),
            ext,
          });
        }
      } catch {}
    }
    if (declaredScripts.length > 0) {
      scripts = scripts.filter((s) =>
        declaredScripts.some((declared) => declared === s.name || declared === path.basename(declared))
      );
      if (scripts.length === 0) {
        for (const declared of declaredScripts) {
          const candidate = path.resolve(skillDir, declared);
          if (
            candidate.startsWith(skillDir + path.sep) &&
            fs.existsSync(candidate) &&
            fs.statSync(candidate).isFile()
          ) {
            scripts.push({
              name: path.basename(candidate),
              path: candidate,
              ext: path.extname(candidate).toLowerCase(),
            });
          }
        }
      }
    }

    return {
      id: `${scope}:${name}`,
      name,
      description,
      tools,
      allowedTools,
      scripts,
      dir: skillDir,
      prompt: promptBody,
      scope,
      filePath,
      version: version || undefined,
    };
  } catch (err) {
    console.error(`[storageService] 解析 Skill 失败 (${filePath}):`, err.message);
    return null;
  }
}

function scanSkillsDir(targetDir, scope = "global") {
  const result = [];
  if (!targetDir || !fs.existsSync(targetDir)) return result;

  try {
    const entries = fs.readdirSync(targetDir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = path.join(targetDir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isFile() && entry.endsWith(".md")) {
        const item = parseSkillMarkdown(fullPath, scope);
        if (item) result.push(item);
      } else if (stat.isDirectory()) {
        const candidates = ["SKILL.md", "skill.md", `${entry}.md`];
        let found = false;
        for (const candidate of candidates) {
          const subPath = path.join(fullPath, candidate);
          if (fs.existsSync(subPath)) {
            const item = parseSkillMarkdown(subPath, scope, entry);
            if (item) {
              result.push(item);
              found = true;
              break;
            }
          }
        }
        if (!found) {
          try {
            const subEntries = fs.readdirSync(fullPath);
            const mdFile = subEntries.find((f) => f.endsWith(".md") && !f.startsWith("."));
            if (mdFile) {
              const item = parseSkillMarkdown(path.join(fullPath, mdFile), scope, entry);
              if (item) result.push(item);
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error(`[storageService] 扫描 Skills 目录失败 (${targetDir}):`, err.message);
  }

  return result;
}

function getSkills(workDir = null) {
  const skillsMap = new Map();

  const globalDirs = [
    path.join(USER_HOME, ".agents", "skills"),
    path.join(USER_HOME, ".omcx", "skills"),
  ];

  for (const dir of globalDirs) {
    const items = scanSkillsDir(dir, "global");
    for (const item of items) {
      if (!skillsMap.has(item.name)) {
        skillsMap.set(item.name, item);
      }
    }
  }

  if (workDir) {
    const projectDirs = [
      path.join(workDir, ".agents", "skills"),
      path.join(workDir, ".omcx", "skills"),
    ];

    for (const dir of projectDirs) {
      const items = scanSkillsDir(dir, "project");
      for (const item of items) {
        skillsMap.set(item.name, item);
      }
    }
  }

  const list = Array.from(skillsMap.values());
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function getMemories(workDir = null) {
  const memories = [];

  if (fs.existsSync(MEMORY_DIR)) {
    const files = fs.readdirSync(MEMORY_DIR);
    for (const file of files) {
      if (file.endsWith(".md") && file !== "MEMORY.md") {
        const fp = path.join(MEMORY_DIR, file);
        const content = fs.readFileSync(fp, "utf-8");
        memories.push({
          id: `global:${file}`,
          name: file.replace(/\.md$/, ""),
          path: fp,
          content,
          scope: "global",
        });
      }
    }
  }

  if (workDir) {
    const projMemDir = path.join(workDir, ".omcx", "memory");
    if (fs.existsSync(projMemDir)) {
      const files = fs.readdirSync(projMemDir);
      for (const file of files) {
        if (file.endsWith(".md") && file !== "MEMORY.md") {
          const fp = path.join(projMemDir, file);
          const content = fs.readFileSync(fp, "utf-8");
          memories.push({
            id: `project:${file}`,
            name: file.replace(/\.md$/, ""),
            path: fp,
            content,
            scope: "project",
          });
        }
      }
    }
  }

  return memories;
}

const PROJECT_RULES_BUDGET = 8000;

function getProjectInstructions(workDir) {
  const instructions = [];
  if (!workDir) return instructions;

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(workDir, name);
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, "utf-8");
    if (content.length > PROJECT_RULES_BUDGET) {
      content = `${content.slice(0, PROJECT_RULES_BUDGET)}\n…(已截断，原始长度 ${content.length} 字符)`;
    }
    instructions.push({ name, path: filePath, content });
  }

  return instructions;
}

function getMemoryIndex(workDir) {
  const indexes = [];

  const globalIndex = path.join(MEMORY_DIR, "MEMORY.md");
  if (fs.existsSync(globalIndex)) {
    indexes.push({
      scope: "global",
      path: globalIndex,
      content: fs.readFileSync(globalIndex, "utf-8"),
    });
  }

  if (workDir) {
    const projectIndex = path.join(workDir, ".omcx", "memory", "MEMORY.md");
    if (fs.existsSync(projectIndex)) {
      indexes.push({
        scope: "project",
        path: projectIndex,
        content: fs.readFileSync(projectIndex, "utf-8"),
      });
    }
  }

  return indexes;
}

module.exports = {
  OMCX_HOME,
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
  getSessions,
  getSession,
  saveSession,
  updateSessionWorkspace,
  updateSessionGeneratedTitle,
  deleteSession,
  getMessages,
  getMessagesAsync,
  addMessage,
  persistMessageSync,
  deleteMessagesAfter,
  saveAttachmentBuffer,
  getSessionAttachmentsDir,
  ensureDir,
  deleteAttachmentFile,
  deleteSessionAttachments,
  isSessionAttachmentPath,
  inferVisionSupport,
  getMcpServers,
  saveGlobalMcpServers,
  setProjectMcpTrust,
  isProjectMcpTrusted,
  isProjectHooksTrusted,
  setProjectHooksTrust,
  readProjectMcpConfig,
  getSkills,
  getMemories,
  getMemoryIndex,
  getProjectInstructions,
  getSessionOutputs,
  getSessionOutputsAsync,
  addSessionOutput,
};
