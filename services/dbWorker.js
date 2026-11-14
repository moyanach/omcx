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

  // 保证历史 messages 表升级增加 reasoning_chars 列
  try {
    const messageCols = db.pragma("table_info(messages)");
    if (!messageCols.some((c) => c.name === "reasoning_chars")) {
      db.exec("ALTER TABLE messages ADD COLUMN reasoning_chars INTEGER DEFAULT 0;");
    }
  } catch (e) {
    console.warn("[dbWorker] 检查 messages 表列失败:", e.message);
  }

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
    getMessageById: db.prepare("SELECT * FROM messages WHERE id = ?"),
    upsertMessage: db.prepare(`
      INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, metadata, reasoning_chars, created_at)
      VALUES (@id, @session_id, @role, @content, @tool_calls, @tool_call_id, @metadata, @reasoning_chars, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        tool_calls = excluded.tool_calls,
        tool_call_id = excluded.tool_call_id,
        metadata = excluded.metadata,
        reasoning_chars = excluded.reasoning_chars
    `),
    deleteMessagesAfter: db.prepare("DELETE FROM messages WHERE session_id = ? AND created_at > ?"),
    deleteSessionMessages: db.prepare("DELETE FROM messages WHERE session_id = ?"),

    getMessageReasoning: db.prepare("SELECT reasoning_content FROM message_reasonings WHERE message_id = ?"),
    upsertMessageReasoning: db.prepare(`
      INSERT INTO message_reasonings (message_id, session_id, reasoning_content, created_at)
      VALUES (@message_id, @session_id, @reasoning_content, @created_at)
      ON CONFLICT(message_id) DO UPDATE SET
        reasoning_content = excluded.reasoning_content
    `),
    deleteSessionReasonings: db.prepare("DELETE FROM message_reasonings WHERE session_id = ?"),
    deleteReasoningsAfter: db.prepare("DELETE FROM message_reasonings WHERE session_id = ? AND created_at > ?"),
    deleteReasoningByMessage: db.prepare("DELETE FROM message_reasonings WHERE message_id = ?"),

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
          statements.deleteSessionReasonings.run(sessionId);
        });
        deleteTx();
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "UPSERT_MESSAGE": {
        const { message, reasoning, now, dropReasoning } = payload;
        const upsertTx = db.transaction(() => {
          statements.upsertMessage.run(message);
          if (reasoning && reasoning.reasoning_content) {
            statements.upsertMessageReasoning.run(reasoning);
          } else if (dropReasoning) {
            // persistence=off：同一消息在流式快照期间可能已写入过思考行，
            // 终稿必须把它清除，确保重启后折叠条彻底消失。
            statements.deleteReasoningByMessage.run(message.id);
          }
          statements.touchSession.run(now, message.session_id);
        });
        upsertTx();
        parentPort.postMessage({ id, success: true });
        break;
      }

      case "DELETE_MESSAGES_AFTER": {
        const { sessionId, timestamp } = payload;
        const deleteTx = db.transaction(() => {
          statements.deleteMessagesAfter.run(sessionId, timestamp);
          statements.deleteReasoningsAfter.run(sessionId, timestamp);
        });
        deleteTx();
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

      case "GET_MESSAGE_BY_ID": {
        const messageId =
          typeof payload === "string" ? payload : payload?.messageId || payload?.id || "";
        if (!messageId) throw new Error("GET_MESSAGE_BY_ID 缺少 messageId");
        const row = statements.getMessageById.get(String(messageId).trim());
        parentPort.postMessage({ id, success: true, result: row || null });
        break;
      }

      case "GET_MESSAGE_REASONING": {
        const messageId =
          typeof payload === "string" ? payload : payload?.messageId || payload?.id || "";
        if (!messageId) throw new Error("GET_MESSAGE_REASONING 缺少 messageId");
        const row = statements.getMessageReasoning.get(String(messageId).trim());
        parentPort.postMessage({ id, success: true, result: row ? row.reasoning_content : null });
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
