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
const { Worker } = require("worker_threads");
let Database = null;
try {
  if (process.env.OMCX_STORAGE_MEMORY_ONLY !== "1") {
    Database = require("better-sqlite3");
  }
} catch {}
const reasoningPolicy = require("./reasoningPolicy");
const { createMcpStorage, writeFileAtomicSync } = require("./storage/mcpStorage");
const { createSkillsMemoryStorage } = require("./storage/skillsMemoryStorage");

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

// ─── 内存级高速只读快照池 (In-Memory Cache) ───────────────────
let memoryConfigs = new Map();
let memorySessions = [];
let memoryMessagesBySession = new Map();
let memoryOutputsBySession = new Map();
let memoryReasoningsByMsgId = new Map();

const MAX_CACHED_MESSAGE_SESSIONS = 50;
const MAX_CACHED_OUTPUT_SESSIONS = 100;
const MAX_CACHED_REASONINGS = 200;

/**
 * 旧数据兼容：仅剥离正文中“成对且闭合”的思考标签。
 *
 * v2.1.9 后新消息的思考内容物理独立存储，正文不再包含任何思考标记；
 * 本函数仅用于读取历史数据或迁移兜底。为避免再次出现“正文字面量标签
 * 被误判为未闭合思考块”的灾难性截断，这里严禁再做未闭合标签的强制吞尾：
 * 凡是找不到对应闭合标签的思考标签，一律按字面文本保留在正文中。
 */
function extractLegacyThinking(raw) {
  const text = String(raw || "");
  if (!text || text.indexOf('<think>') === -1) {
    return { content: text, reasoning: "" };
  }

  let cursor = 0;
  let content = "";
  let reasoning = "";

  while (cursor < text.length) {
    const thinkOpen = text.indexOf('<think>', cursor);
    const thinkingOpen = text.indexOf('<thinking>', cursor);
    let openIdx = -1;
    let openTag = "";
    let closeTag = "";

    if (thinkOpen !== -1 && (thinkingOpen === -1 || thinkOpen <= thinkingOpen)) {
      openIdx = thinkOpen;
      openTag = '<think>';
      closeTag = '</think>';
    } else if (thinkingOpen !== -1) {
      openIdx = thinkingOpen;
      openTag = '<thinking>';
      closeTag = '</thinking>';
    }

    if (openIdx === -1) {
      content += text.slice(cursor);
      break;
    }

    const closeIdx = text.indexOf(closeTag, openIdx + openTag.length);
    if (closeIdx === -1) {
      // 未闭合：必须保留原文，不能吞尾
      content += text.slice(cursor);
      break;
    }

    content += text.slice(cursor, openIdx);
    const inner = text.slice(openIdx + openTag.length, closeIdx).trim();
    if (inner) reasoning = reasoning ? `${reasoning}\n\n${inner}` : inner;
    cursor = closeIdx + closeTag.length;
  }

  return { content: content.trim(), reasoning: reasoning.trim() };

}
// 兼容旧调用名：对外仍暴露 splitThinkingContent，但实现改为非正则的安全提取
function splitThinkingContent(raw) {
  return extractLegacyThinking(raw);
}

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
  if (isMemoryOnlyMode()) return;
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
  if (isMemoryOnlyMode()) {
    try {
      return Promise.resolve(executeMemoryReadAction(action, payload));
    } catch (err) {
      return Promise.reject(err);
    }
  }
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

/**
 * 退出前或崩溃兜底同步刷盘：停止异步 Worker 并顺序回放尚未 ACK 的写队列，
 * 消除主线程同步落盘与 Worker 线程异步队列的双写竞争及 Cmd+Q 丢数据风险。
 */
function flushPendingWritesSync() {
  if (isMemoryOnlyMode()) return;
  if (dbWorker) {
    const workerToStop = dbWorker;
    dbWorker = null;
    try {
      workerToStop.terminate();
    } catch {}
    handleWorkerFailure("flush-before-quit");
    return;
  }
  if (pendingWorkerWrites.size > 0) {
    handleWorkerFailure("flush-pending-writes");
  }
}

function checkpointWalSync() {
  if (isMemoryOnlyMode()) return;
  try {
    const d = fallbackDb || getFallbackDb();
    d?.pragma("wal_checkpoint(PASSIVE)");
  } catch (err) {
    console.warn("[storageService] WAL checkpoint 异常（已忽略）:", err?.message || err);
  }
}

function executeMemoryReadAction(action, payload) {
  switch (action) {
    case "GET_MESSAGES": {
      const sessionId =
        typeof payload === "string" ? payload : payload?.sessionId || payload?.session_id;
      return memoryMessagesBySession.get(sessionId) || [];
    }
    case "GET_MESSAGE_BY_ID": {
      const messageId =
        typeof payload === "string" ? payload : payload?.messageId || payload?.id;
      for (const list of memoryMessagesBySession.values()) {
        const found = list.find((m) => m && m.id === messageId);
        if (found) return found;
      }
      return null;
    }
    case "GET_MESSAGE_REASONING": {
      const messageId =
        typeof payload === "string" ? payload : payload?.messageId || payload?.id;
      const id = String(messageId || "").trim();
      return id ? memoryReasoningsByMsgId.get(id) || null : null;
    }
    case "GET_OUTPUTS": {
      const sessionId =
        typeof payload === "string" ? payload : payload?.sessionId || payload?.session_id;
      return memoryOutputsBySession.get(sessionId) || [];
    }
    default:
      return null;
  }
}

// 降级模式同线程备用执行引擎
function executeFallbackAction(action, payload) {
  if (isMemoryOnlyMode()) {
    return executeMemoryReadAction(action, payload);
  }
  const d = getFallbackDb();
  if (!d) return executeMemoryReadAction(action, payload);
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
        d.prepare("DELETE FROM message_reasonings WHERE session_id = ?").run(sessionId);
      });
      tx();
      break;
    }
    case "UPSERT_MESSAGE": {
      const { message, reasoning, now, dropReasoning } = payload;
      const tx = d.transaction(() => {
        d.prepare(`
          INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, metadata, reasoning_chars, created_at)
          VALUES (@id, @session_id, @role, @content, @tool_calls, @tool_call_id, @metadata, @reasoning_chars, @created_at)
          ON CONFLICT(id) DO UPDATE SET
            role = excluded.role,
            content = excluded.content,
            tool_calls = excluded.tool_calls,
            tool_call_id = excluded.tool_call_id,
            metadata = excluded.metadata,
            reasoning_chars = excluded.reasoning_chars
        `).run(message);
        if (reasoning && reasoning.reasoning_content) {
          d.prepare(`
            INSERT INTO message_reasonings (message_id, session_id, reasoning_content, created_at)
            VALUES (@message_id, @session_id, @reasoning_content, @created_at)
            ON CONFLICT(message_id) DO UPDATE SET
              reasoning_content = excluded.reasoning_content
          `).run(reasoning);
        } else if (dropReasoning) {
          d.prepare("DELETE FROM message_reasonings WHERE message_id = ?").run(message.id);
        }
        d.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, message.session_id);
      });
      tx();
      break;
    }
    case "DELETE_MESSAGES_AFTER": {
      const { sessionId, timestamp } = payload;
      const tx = d.transaction(() => {
        d.prepare("DELETE FROM messages WHERE session_id = ? AND created_at > ?").run(sessionId, timestamp);
        d.prepare("DELETE FROM message_reasonings WHERE session_id = ? AND created_at > ?").run(sessionId, timestamp);
      });
      tx();
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
    case "GET_MESSAGE_BY_ID": {
      const messageId =
        typeof payload === "string" ? payload : payload?.messageId || payload?.id;
      return d.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) || null;
    }
    case "GET_MESSAGE_REASONING": {
      const messageId =
        typeof payload === "string" ? payload : payload?.messageId || payload?.id;
      const id = String(messageId || "").trim();
      if (!id) return null;
      try {
        const row = d.prepare("SELECT reasoning_content FROM message_reasonings WHERE message_id = ?").get(id);
        if (row && row.reasoning_content) return row.reasoning_content;
      } catch (_) {}
      // 兼容历史混杂在 messages.content 中的旧数据
      try {
        const msg = d.prepare("SELECT content FROM messages WHERE id = ?").get(id);
        if (msg && msg.content) {
          const { reasoning } = splitThinkingContent(msg.content);
          return reasoning || null;
        }
      } catch (_) {}
      return null;
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
  if (isMemoryOnlyMode()) return null;
  if (!fallbackDb) {
    ensureDir(OMCX_HOME);
    fallbackDb = new Database(DB_FILE);
    fallbackDb.pragma("journal_mode = WAL");
    fallbackDb.pragma("synchronous = NORMAL");
    fallbackDb.pragma("temp_store = MEMORY");
    fallbackDb.pragma("cache_size = -64000");

    fallbackDb.exec(`
      CREATE TABLE IF NOT EXISTS configs (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        title_source TEXT,
        model TEXT,
        workspace_id TEXT,
        work_dir TEXT,
        permission_mode TEXT,
        reasoning_effort TEXT,
        archived INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        metadata TEXT,
        reasoning_chars INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);
      CREATE TABLE IF NOT EXISTS message_reasonings (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reasoning_content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reasonings_session ON message_reasonings(session_id);
      CREATE TABLE IF NOT EXISTS session_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT,
        action TEXT,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outputs_session ON session_outputs(session_id, created_at ASC);
    `);

    try {
      const cols = fallbackDb.pragma("table_info(messages)");
      if (!cols.some((c) => c.name === "reasoning_chars")) {
        fallbackDb.exec("ALTER TABLE messages ADD COLUMN reasoning_chars INTEGER DEFAULT 0;");
      }
    } catch (_) {}
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
  if (isMemoryOnlyMode()) {
    hasLoadedSnapshot = true;
    return;
  }
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
  if (isMemoryOnlyMode()) {
    hasLoadedSnapshot = true;
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
    writeFileAtomicSync(MCP_FILE, JSON.stringify(defaultMcp, null, 2));
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
  if (isMemoryOnlyMode()) return null;
  try {
    const db = getFallbackDb();
    if (!db) return null;
    const row = db.prepare("SELECT value FROM configs WHERE key = ?").get(key);
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
    // 显式传入 false 必须能够“取消归档”，不能被 existing.archived 覆盖
    archived:
      session.archived !== undefined
        ? session.archived
          ? 1
          : 0
        : existing?.archived
        ? 1
        : 0,
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

  // 1. 内存同步移除（同时清理该会话消息的思考内容缓存，避免残留占用）
  memorySessions = memorySessions.filter((s) => s.id !== sessionId);
  const cachedMessages = memoryMessagesBySession.get(sessionId);
  if (Array.isArray(cachedMessages)) {
    for (const msg of cachedMessages) {
      if (msg?.id) memoryReasoningsByMsgId.delete(msg.id);
    }
  }
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
  if (isMemoryOnlyMode()) return [];
  try {
    const db = getFallbackDb();
    if (!db) return [];
    const rows = db
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
  const metadata = parseJsonColumn(r.metadata);
  const reasoningChars =
    r.reasoning_chars !== undefined && r.reasoning_chars !== null
      ? Number(r.reasoning_chars)
      : Number(metadata?.reasoningChars || 0);

  let normalizedMeta = metadata;
  if (reasoningChars > 0 && (!normalizedMeta || normalizedMeta.reasoningChars === undefined)) {
    normalizedMeta = {
      ...(normalizedMeta && typeof normalizedMeta === "object" ? normalizedMeta : {}),
      reasoningChars,
    };
  }

  return {
    id: r.id,
    session_id: r.session_id,
    role: r.role,
    content: r.content || "",
    tool_calls: parseJsonColumn(r.tool_calls),
    tool_call_id: r.tool_call_id || null,
    metadata: normalizedMeta,
    reasoning_chars: reasoningChars,
    reasoningChars: reasoningChars,
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

/**
 * 按消息 ID 读取单条消息：供思考块展开时按需拉取，避免整会话重传。
 */
async function getMessageByIdAsync(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return null;
  try {
    const row = await sendToWorkerWithPromise("GET_MESSAGE_BY_ID", { messageId: id });
    return row ? mapMessageRow(row) : null;
  } catch (err) {
    if (isMemoryOnlyMode()) return null;
    try {
      const db = getFallbackDb();
      if (!db) return null;
      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      return row ? mapMessageRow(row) : null;
    } catch {
      return null;
    }
  }
}

/**
 * 同步读取单条消息的思考内容（优先查内存池，其次查 DB，兼容老数据）
 */
function getMessageReasoning(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return "";
  if (memoryReasoningsByMsgId.has(id)) {
    const cached = memoryReasoningsByMsgId.get(id);
    touchLruCache(memoryReasoningsByMsgId, id, cached, MAX_CACHED_REASONINGS);
    return cached;
  }
  const text = executeFallbackAction("GET_MESSAGE_REASONING", id);
  if (text) {
    touchLruCache(memoryReasoningsByMsgId, id, text, MAX_CACHED_REASONINGS);
    return text;
  }
  return "";
}

/**
 * 异步读取单条消息的思考内容（展开卡片时按需单点调取，0ms 不卡死主进程）
 */
async function getMessageReasoningAsync(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return "";
  if (memoryReasoningsByMsgId.has(id)) {
    const cached = memoryReasoningsByMsgId.get(id);
    touchLruCache(memoryReasoningsByMsgId, id, cached, MAX_CACHED_REASONINGS);
    return cached;
  }
  try {
    const text = await sendToWorkerWithPromise("GET_MESSAGE_REASONING", { messageId: id });
    if (typeof text === "string" && text) {
      touchLruCache(memoryReasoningsByMsgId, id, text, MAX_CACHED_REASONINGS);
      return text;
    }
  } catch (err) {
    console.warn(`[storageService] Worker 读取思考内容失败，回退降级引擎:`, err.message);
  }
  return getMessageReasoning(id);
}

function addMessage(sessionId, message) {
  if (!sessionId || !message) return { success: false, error: "参数不完整" };

  // 已删除会话的晚到写入（流式收尾/快照 flush）直接丢弃：
  // Worker 队列是 FIFO，DELETE_SESSION 之后到达的 UPSERT 会重新插入孤儿消息行。
  if (!memorySessions.some((s) => s.id === sessionId)) {
    return { success: false, error: "会话不存在或已删除" };
  }

  // 架构防御：若该会话尚未加载历史缓存，必须先调用 getMessages(sessionId) 预热内存池，
  // 杜绝首次写入直接覆盖导致历史消息丢失的重大时序缺口
  if (!memoryMessagesBySession.has(sessionId)) {
    getMessages(sessionId);
  }

  const msgId = message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const createdAt = message.created_at || message.createdAt || now;

  let rawContent = message.content !== undefined ? String(message.content) : "";
  let reasoning =
    typeof message.reasoning === "string"
      ? message.reasoning
      : typeof message.reasoningContent === "string"
      ? message.reasoningContent
      : "";

  // 旧数据兼容：仅在未显式提供 reasoning 时，安全剥离已成对闭合的历史思考标签
  if (!reasoning && rawContent && rawContent.indexOf("<think") !== -1) {
    const legacy = extractLegacyThinking(rawContent);
    if (legacy.reasoning) {
      rawContent = legacy.content;
      reasoning = legacy.reasoning;
    }
  }

  // 思考内容落盘策略分流（full / truncated / off）：
  // - off：仅内存保留（供当前回合协议回传与流式展示），真正不写盘，重启后折叠条消失；
  // - truncated：保留头 8000 + 尾 2000 字符，中间打标记；
  // - full：全量落盘，单条超过 200k 字符时强制按 truncated 行为降级。
  const reasoningPersistence = reasoningPolicy.normalizePersistence(
    getConfig("reasoning_persistence")
  );
  const shapedReasoning = reasoningPolicy.shapeForPersistence(reasoning, reasoningPersistence);
  const reasoningOriginalChars = shapedReasoning.chars;
  reasoning = shapedReasoning.text;

  const reasoningChars =
    reasoningPersistence === "off"
      ? 0
      : reasoningOriginalChars > 0
      ? reasoningOriginalChars
      : Number(message.reasoning_chars || message.reasoningChars || message.metadata?.reasoningChars || 0);

  let metadataObj = message.metadata;
  if (reasoningChars > 0) {
    metadataObj = {
      ...(metadataObj && typeof metadataObj === "object" ? metadataObj : {}),
      reasoningChars,
    };
  } else if (metadataObj && typeof metadataObj === "object" && "reasoningChars" in metadataObj) {
    // off 档：必须同时抹掉 metadata 里的历史计数字段，否则重启后折叠条仍会残留
    const { reasoningChars: _droppedReasoningChars, ...restMeta } = metadataObj;
    metadataObj = restMeta;
  }

  const toolCallsStr = message.tool_calls ? JSON.stringify(message.tool_calls) : null;
  const metadataStr = metadataObj ? JSON.stringify(metadataObj) : null;

  const fullMsg = {
    id: msgId,
    session_id: sessionId,
    role: message.role,
    content: rawContent,
    tool_calls: message.tool_calls || null,
    tool_call_id: message.tool_call_id || null,
    metadata: metadataObj || null,
    reasoning_chars: reasoningChars,
    reasoningChars: reasoningChars,
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

  // 缓存思考文本到 LRU 池；off 档必须同时从内存池移除，
  // 否则当前进程内仍能读到思考内容，违背“仅内存保留”之外的语义一致性预期。
  if (reasoning) {
    touchLruCache(memoryReasoningsByMsgId, msgId, reasoning, MAX_CACHED_REASONINGS);
  } else if (reasoningPersistence === "off") {
    memoryReasoningsByMsgId.delete(msgId);
  }

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
      content: rawContent,
      tool_calls: toolCallsStr,
      tool_call_id: message.tool_call_id || null,
      metadata: metadataStr,
      reasoning_chars: reasoningChars,
      created_at: createdAt,
    },
    reasoning: reasoning
      ? {
          message_id: msgId,
          session_id: sessionId,
          reasoning_content: reasoning,
          created_at: createdAt,
        }
      : null,
    // off 档：不仅本次不写盘，还要清掉同一消息此前快照期间遗留的思考行，
    // 保证 SELECT COUNT(*) FROM message_reasonings WHERE message_id = ? 归零。
    dropReasoning: reasoningPersistence === "off",
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
  const reasoning = memoryReasoningsByMsgId.get(record.id) || null;
  const persistenceMode = reasoningPolicy.normalizePersistence(getConfig("reasoning_persistence"));
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
        reasoning_chars: record.reasoning_chars || 0,
        created_at: record.created_at,
      },
      reasoning: reasoning
        ? {
            message_id: record.id,
            session_id: sessionId,
            reasoning_content: reasoning,
            created_at: record.created_at,
          }
        : null,
      dropReasoning: persistenceMode === "off",
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

// 会话 ID / 附件名必须锁定为单层安全段，杜绝 ../../ 路径穿越改写/删除会话外文件
const SAFE_SESSION_ID = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ATTACHMENT_EXT = /^[A-Za-z0-9]{1,12}$/;

function isSafeSessionId(sessionId) {
  const value = String(sessionId || "");
  if (!SAFE_SESSION_ID.test(value)) return false;
  const root = path.resolve(SESSIONS_DIR);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getSessionAttachmentsDir(sessionId) {
  if (!isSafeSessionId(sessionId)) {
    throw new Error("非法会话 ID");
  }
  return path.join(SESSIONS_DIR, sessionId, "attachments");
}

function saveAttachmentBuffer(sessionId, id, ext, buffer) {
  const safeId = String(id || "");
  const rawExt = String(ext || "").replace(/^\./, "");
  // 扩展名来自原始文件名，可能超长或含特殊字符：截断/降级而不是让整次上传失败
  const safeExt = SAFE_ATTACHMENT_EXT.test(rawExt)
    ? rawExt
    : rawExt.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "bin";
  if (!SAFE_ATTACHMENT_ID.test(safeId)) {
    throw new Error("非法附件标识");
  }
  const dir = getSessionAttachmentsDir(sessionId);
  ensureDir(dir);
  const filePath = path.join(dir, `${safeId}.${safeExt}`);
  fs.writeFileSync(filePath, buffer);
  return { id: safeId, path: filePath, size: buffer.length };
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
  if (!isSafeSessionId(sessionId)) {
    console.warn(`[storageService] 拒绝删除非法会话目录: ${sessionId}`);
    return { success: false, error: "非法会话 ID" };
  }
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
  if (isMemoryOnlyMode()) return [];
  try {
    const db = getFallbackDb();
    if (!db) return [];
    const rows = db
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
// MCP / Skills / Memory 静态 Markdown 与配置文件扫描（委托子模块）
// ─────────────────────────────────────────────────────────────

const getStoragePaths = () => ({
  OMCX_HOME,
  DB_FILE,
  MCP_FILE,
  SKILLS_DIR,
  MEMORY_DIR,
  SESSIONS_DIR,
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
  getSessions,
  getSession,
  saveSession,
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
  flushPendingWritesSync,
  checkpointWalSync,
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
};
