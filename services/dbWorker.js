/**
 * dbWorker.js — SQLite 后台工作线程 (Worker Thread)
 *
 * 核心职责：
 * 1. 独占持有 better-sqlite3 数据库实例 (~/.omcx/omcx.db)；
 * 2. 线程内执行建表、预编译 SQL 与 WAL 事务；
 * 3. 将所有磁盘 I/O、日志合并 (Checkpoint) 从 Electron 主进程彻底剥离；
 * 4. 响应主线程指令，异步持久化并同步数据。
 */

const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

if (!parentPort) {
  throw new Error("dbWorker 必须在 Worker Thread 中运行");
}

const dbFile = workerData?.dbFile;
if (!dbFile) {
  throw new Error("缺少 dbFile 路径参数");
}

let db = null;
let statements = null;

/**
 * 兼容两种调用形态：直接传 sessionId 字符串，或传 { sessionId } 负载。
 * 早期主线程 GET_MESSAGES / GET_OUTPUTS 以对象负载发送，若按字符串绑定
 * 会被 better-sqlite3 当作命名参数，抛出 "Too few parameter values were provided"。
 */
function resolveSessionId(payload) {
  if (typeof payload === "string") return payload.trim();
  if (payload && typeof payload === "object") {
    return String(payload.sessionId || payload.session_id || "").trim();
  }
  return "";
}

function initDb() {
  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000"); // 64MB 缓存

  db.exec(`
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
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);

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

  statements = {
    getConfig: db.prepare("SELECT value FROM configs WHERE key = ?"),
    setConfig: db.prepare(`
      INSERT INTO configs (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    getAllConfigs: db.prepare("SELECT key, value FROM configs"),

    getSessions: db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC"),
    getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    upsertSession: db.prepare(`
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
    `),
    touchSession: db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),

    getMessages: db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC"),
    upsertMessage: db.prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, metadata, created_at)
      VALUES (@id, @session_id, @role, @content, @tool_calls, @tool_call_id, @metadata, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        tool_calls = excluded.tool_calls,
        tool_call_id = excluded.tool_call_id,
        metadata = excluded.metadata
    `),
    deleteMessagesAfter: db.prepare("DELETE FROM messages WHERE session_id = ? AND created_at > ?"),
    deleteSessionMessages: db.prepare("DELETE FROM messages WHERE session_id = ?"),

    getSessionOutputs: db.prepare("SELECT * FROM session_outputs WHERE session_id = ? ORDER BY created_at ASC"),
    insertOutput: db.prepare(`
      INSERT INTO session_outputs (session_id, name, file_path, file_type, action, created_at)
      VALUES (@session_id, @name, @file_path, @file_type, @action, @created_at)
    `),
    deleteSessionOutputs: db.prepare("DELETE FROM session_outputs WHERE session_id = ?"),
  };
}

try {
  initDb();
  parentPort.postMessage({ type: "READY" });
} catch (err) {
  parentPort.postMessage({ type: "ERROR", error: err.message });
}

parentPort.on("message", (msg) => {
  const { id, action, payload } = msg || {};
  if (!action) return;

  try {
    switch (action) {
      case "INIT_SNAPSHOT": {
        // 读取全量初始配置与会话索引，供主线程启动时瞬间秒级建立内存索引
        const configs = {};
        const configRows = statements.getAllConfigs.all();
        for (const row of configRows) {
          try {
            configs[row.key] = JSON.parse(row.value);
          } catch {
            configs[row.key] = row.value;
          }
        }
        const sessions = statements.getSessions.all().map((r) => ({
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

        parentPort.postMessage({ id, success: true, result: { configs, sessions } });
        break;
      }

      case "SET_CONFIG": {
        const { key, value } = payload;
        const valStr = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
        statements.setConfig.run(key, valStr, Date.now());
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "UPSERT_SESSION": {
        statements.upsertSession.run(payload);
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "DELETE_SESSION": {
        const sessionId = resolveSessionId(payload);
        if (!sessionId) throw new Error("DELETE_SESSION 缺少 sessionId");
        const deleteTx = db.transaction(() => {
          statements.deleteSession.run(sessionId);
          statements.deleteSessionMessages.run(sessionId);
          statements.deleteSessionOutputs.run(sessionId);
        });
        deleteTx();
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "UPSERT_MESSAGE": {
        const { message, now } = payload;
        const upsertTx = db.transaction(() => {
          statements.upsertMessage.run(message);
          statements.touchSession.run(now, message.session_id);
        });
        upsertTx();
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "DELETE_MESSAGES_AFTER": {
        const { sessionId, timestamp } = payload;
        statements.deleteMessagesAfter.run(sessionId, timestamp);
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "INSERT_OUTPUT": {
        statements.insertOutput.run(payload);
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "GET_MESSAGES": {
        const sessionId = resolveSessionId(payload);
        if (!sessionId) throw new Error("GET_MESSAGES 缺少 sessionId");
        // 返回原始行（snake_case + JSON 字符串），由主线程统一走 mapMessageRow 归一化，
        // 避免 Worker 与降级引擎两条读取链路返回不同形状的数据。
        const rows = statements.getMessages.all(sessionId);
        parentPort.postMessage({ id, success: true, result: rows });
        break;
      }

      case "GET_OUTPUTS": {
        const sessionId = resolveSessionId(payload);
        if (!sessionId) throw new Error("GET_OUTPUTS 缺少 sessionId");
        const rows = statements.getSessionOutputs.all(sessionId);
        parentPort.postMessage({ id, success: true, result: rows });
        break;
      }

      default:
        parentPort.postMessage({ id, success: false, error: `未知 action: ${action}` });
    }
  } catch (err) {
    console.error(`[dbWorker] 执行 ${action} 异常:`, err.message);
    parentPort.postMessage({ id, success: false, error: err.message });
  }
});
