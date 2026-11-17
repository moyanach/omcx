const path = require("path");
const { Worker } = require("worker_threads");

function createDbEngine({
  Database,
  isMemoryOnlyMode,
  getPaths,
  ensureDir,
  extractLegacyThinking,
  memoryState,
}) {
  let dbWorker = null;
  let fallbackDb = null;
  let workerMsgId = 1;
  let hasLoadedSnapshot = false;

  const pendingWorkerRequests = new Map();
  // 最近写入操作的有限回放队列：Worker 崩溃时在主线程降级引擎中重放，避免写请求静默丢失
  const pendingWorkerWrites = new Map();
  const MAX_PENDING_WRITES = 200;
  const WORKER_REQUEST_TIMEOUT_MS = 8000;

  function executeMemoryReadAction(action, payload) {
    switch (action) {
      case "GET_MESSAGES": {
        const sessionId =
          typeof payload === "string" ? payload : payload?.sessionId || payload?.session_id;
        return memoryState.messagesBySession.get(sessionId) || [];
      }
      case "GET_MESSAGE_BY_ID": {
        const messageId =
          typeof payload === "string" ? payload : payload?.messageId || payload?.id;
        for (const list of memoryState.messagesBySession.values()) {
          const found = list.find((m) => m && m.id === messageId);
          if (found) return found;
        }
        return null;
      }
      case "GET_MESSAGE_REASONING": {
        const messageId =
          typeof payload === "string" ? payload : payload?.messageId || payload?.id;
        const id = String(messageId || "").trim();
        return id ? memoryState.reasoningsByMsgId.get(id) || null : null;
      }
      case "GET_OUTPUTS": {
        const sessionId =
          typeof payload === "string" ? payload : payload?.sessionId || payload?.session_id;
        return memoryState.outputsBySession.get(sessionId) || [];
      }
      case "GET_AUTOMATIONS":
        return memoryState.getAutomations ? memoryState.getAutomations() : [];
      case "GET_AUTOMATION_RUNS":
        return memoryState.getAutomationRuns ? memoryState.getAutomationRuns() : [];
      default:
        return null;
    }
  }

  function getFallbackDb() {
    if (isMemoryOnlyMode()) return null;
    if (!fallbackDb) {
      const { OMCX_HOME, DB_FILE } = getPaths();
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
          agent_mode TEXT DEFAULT 'code',
          session_type TEXT DEFAULT 'chat',
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
        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER DEFAULT 1,
          schedule_type TEXT NOT NULL DEFAULT 'interval',
          interval_minutes INTEGER DEFAULT 60,
          cron_expr TEXT,
          prompt TEXT NOT NULL,
          work_dir TEXT,
          agent_mode TEXT DEFAULT 'work',
          permission_mode TEXT DEFAULT 'auto-sandbox',
          model TEXT,
          webhook_target_id TEXT,
          notify_on TEXT DEFAULT 'always',
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          automation_name TEXT NOT NULL,
          trigger_source TEXT NOT NULL DEFAULT 'schedule',
          status TEXT NOT NULL DEFAULT 'running',
          triage_state TEXT NOT NULL DEFAULT 'unread',
          session_id TEXT,
          summary TEXT,
          error TEXT,
          outputs_json TEXT,
          cost_usd REAL DEFAULT 0,
          duration_ms INTEGER DEFAULT 0,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_runs_aid ON automation_runs(automation_id, started_at DESC);
      `);

      try {
        const cols = fallbackDb.pragma("table_info(messages)");
        if (!cols.some((c) => c.name === "reasoning_chars")) {
          fallbackDb.exec("ALTER TABLE messages ADD COLUMN reasoning_chars INTEGER DEFAULT 0;");
        }
      } catch (_) {}

      try {
        const sessionCols = fallbackDb.pragma("table_info(sessions)");
        if (!sessionCols.some((c) => c.name === "agent_mode")) {
          fallbackDb.exec("ALTER TABLE sessions ADD COLUMN agent_mode TEXT DEFAULT 'code';");
        }
        if (!sessionCols.some((c) => c.name === "session_type")) {
          fallbackDb.exec("ALTER TABLE sessions ADD COLUMN session_type TEXT DEFAULT 'chat';");
        }
      } catch (_) {}
    }
    return fallbackDb;
  }

  function executeFallbackAction(action, payload) {
    if (isMemoryOnlyMode()) {
      return executeMemoryReadAction(action, payload);
    }
    const d = getFallbackDb();
    if (!d) return executeMemoryReadAction(action, payload);
    switch (action) {
      case "SET_CONFIG": {
        const { key, value } = payload;
        const valStr =
          typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
        d.prepare(`
          INSERT INTO configs (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, valStr, Date.now());
        break;
      }
      case "UPSERT_SESSION": {
        const record = {
          agent_mode: "code",
          session_type: "chat",
          ...payload,
          agent_mode: payload?.agent_mode === "work" ? "work" : "code",
          session_type: payload?.session_type === "automation" ? "automation" : "chat",
        };
        d.prepare(`
          INSERT INTO sessions (id, title, title_source, model, workspace_id, work_dir, permission_mode, reasoning_effort, agent_mode, session_type, archived, created_at, updated_at)
          VALUES (@id, @title, @title_source, @model, @workspace_id, @work_dir, @permission_mode, @reasoning_effort, @agent_mode, @session_type, @archived, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            title_source = excluded.title_source,
            model = excluded.model,
            workspace_id = excluded.workspace_id,
            work_dir = excluded.work_dir,
            permission_mode = excluded.permission_mode,
            reasoning_effort = excluded.reasoning_effort,
            agent_mode = excluded.agent_mode,
            session_type = excluded.session_type,
            archived = excluded.archived,
            updated_at = excluded.updated_at
        `).run(record);
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
        try {
          const msg = d.prepare("SELECT content FROM messages WHERE id = ?").get(id);
          if (msg && msg.content) {
            const { reasoning } = extractLegacyThinking(msg.content);
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
      case "SEARCH_SESSIONS": {
        const query = String(payload?.query || "").trim();
        const limit = Math.max(1, Math.min(100, Number(payload?.limit) || 40));
        if (!query) return [];
        const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escaped}%`;
        const extractSnippet = (text) => {
          const flat = String(text || "").replace(/\s+/g, " ").trim();
          const idx = flat.toLowerCase().indexOf(query.toLowerCase());
          if (idx === -1) return flat.slice(0, 88);
          const start = Math.max(0, idx - 26);
          const end = Math.min(flat.length, idx + query.length + 52);
          return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
        };
        const bySession = new Map();
        const titleRows = d
          .prepare(
            "SELECT id AS session_id, title, updated_at FROM sessions WHERE (session_type IS NULL OR session_type != 'automation') AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?"
          )
          .all(pattern, limit);
        for (const r of titleRows) {
          bySession.set(r.session_id, {
            sessionId: r.session_id,
            title: r.title || "新的 Agent 会话",
            updatedAt: r.updated_at || 0,
            matchType: "title",
            matchSnippet: "",
          });
        }
        const msgRows = d
          .prepare(
            "SELECT m.session_id, s.title, s.updated_at, m.content FROM messages m INNER JOIN sessions s ON s.id = m.session_id WHERE (s.session_type IS NULL OR s.session_type != 'automation') AND m.content LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT ?"
          )
          .all(pattern, limit * 6);
        for (const r of msgRows) {
          if (bySession.size >= limit && !bySession.has(r.session_id)) continue;
          const existing = bySession.get(r.session_id);
          if (!existing) {
            bySession.set(r.session_id, {
              sessionId: r.session_id,
              title: r.title || "新的 Agent 会话",
              updatedAt: r.updated_at || 0,
              matchType: "message",
              matchSnippet: extractSnippet(r.content),
            });
          } else if (!existing.matchSnippet) {
            existing.matchSnippet = extractSnippet(r.content);
          }
        }
        return Array.from(bySession.values())
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, limit);
      }
      case "GET_AUTOMATIONS":
        return d.prepare("SELECT * FROM automations ORDER BY updated_at DESC").all();
      case "UPSERT_AUTOMATION":
        d.prepare(`
          INSERT INTO automations (
            id, name, description, enabled, schedule_type, interval_minutes, cron_expr,
            prompt, work_dir, agent_mode, permission_mode, model, webhook_target_id,
            notify_on, next_run_at, last_run_at, last_status, created_at, updated_at
          )
          VALUES (
            @id, @name, @description, @enabled, @schedule_type, @interval_minutes, @cron_expr,
            @prompt, @work_dir, @agent_mode, @permission_mode, @model, @webhook_target_id,
            @notify_on, @next_run_at, @last_run_at, @last_status, @created_at, @updated_at
          )
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            enabled = excluded.enabled,
            schedule_type = excluded.schedule_type,
            interval_minutes = excluded.interval_minutes,
            cron_expr = excluded.cron_expr,
            prompt = excluded.prompt,
            work_dir = excluded.work_dir,
            agent_mode = excluded.agent_mode,
            permission_mode = excluded.permission_mode,
            model = excluded.model,
            webhook_target_id = excluded.webhook_target_id,
            notify_on = excluded.notify_on,
            next_run_at = excluded.next_run_at,
            last_run_at = excluded.last_run_at,
            last_status = excluded.last_status,
            updated_at = excluded.updated_at
        `).run(payload);
        break;
      case "DELETE_AUTOMATION": {
        const aid = typeof payload === "string" ? payload : payload?.id || "";
        const tx = d.transaction(() => {
          d.prepare("DELETE FROM automations WHERE id = ?").run(aid);
          d.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(aid);
        });
        tx();
        break;
      }
      case "GET_AUTOMATION_RUNS": {
        const limit = Math.max(1, Math.min(1000, Number(payload?.limit) || 300));
        return d.prepare("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?").all(limit);
      }
      case "UPSERT_AUTOMATION_RUN":
        d.prepare(`
          INSERT INTO automation_runs (
            id, automation_id, automation_name, trigger_source, status, triage_state,
            session_id, summary, error, outputs_json, cost_usd, duration_ms, started_at, finished_at
          )
          VALUES (
            @id, @automation_id, @automation_name, @trigger_source, @status, @triage_state,
            @session_id, @summary, @error, @outputs_json, @cost_usd, @duration_ms, @started_at, @finished_at
          )
          ON CONFLICT(id) DO UPDATE SET
            automation_name = excluded.automation_name,
            status = excluded.status,
            triage_state = excluded.triage_state,
            session_id = excluded.session_id,
            summary = excluded.summary,
            error = excluded.error,
            outputs_json = excluded.outputs_json,
            cost_usd = excluded.cost_usd,
            duration_ms = excluded.duration_ms,
            finished_at = excluded.finished_at
        `).run(payload);
        break;
      case "UPDATE_AUTOMATION_RUN_TRIAGE":
        d.prepare("UPDATE automation_runs SET triage_state = ? WHERE id = ?").run(
          payload?.triage_state || "read",
          payload?.id || ""
        );
        break;
      case "MARK_ALL_AUTOMATION_RUNS_READ":
        d.prepare("UPDATE automation_runs SET triage_state = 'read' WHERE triage_state = 'unread'").run();
        break;
      case "DELETE_AUTOMATION_RUN": {
        const runId = typeof payload === "string" ? payload : payload?.id || "";
        d.prepare("DELETE FROM automation_runs WHERE id = ?").run(runId);
        break;
      }
    }
    return undefined;
  }

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
      executeFallbackAction(action, payload);
    } else {
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

  function loadInitialSnapshot() {
    if (hasLoadedSnapshot) return;
    if (isMemoryOnlyMode()) {
      hasLoadedSnapshot = true;
      return;
    }
    try {
      const d = getFallbackDb();
      const rows = d.prepare("SELECT key, value FROM configs").all();
      for (const r of rows) {
        try {
          memoryState.configs.set(r.key, JSON.parse(r.value));
        } catch {
          memoryState.configs.set(r.key, r.value);
        }
      }
      const sessRows = d.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all();
      memoryState.setSessions(
        sessRows.map((r) => ({
          id: r.id,
          title: r.title,
          title_source: r.title_source || "default",
          model: r.model || "",
          workspace_id: r.workspace_id || null,
          work_dir: r.work_dir || null,
          permission_mode: r.permission_mode || "auto-sandbox",
          reasoning_effort: r.reasoning_effort || "medium",
          agent_mode: r.agent_mode === "work" ? "work" : "code",
          session_type: r.session_type === "automation" ? "automation" : "chat",
          archived: Boolean(r.archived),
          created_at: r.created_at,
          updated_at: r.updated_at,
        }))
      );
      if (memoryState.setAutomations) {
        const autoRows = d.prepare("SELECT * FROM automations ORDER BY updated_at DESC").all();
        memoryState.setAutomations(autoRows);
      }
      if (memoryState.setAutomationRuns) {
        const runRows = d
          .prepare("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 300")
          .all();
        memoryState.setAutomationRuns(runRows);
      }
      hasLoadedSnapshot = true;
    } catch (e) {
      console.warn("[storageService] 预加载初始快照提示（稍后自动重试）:", e.message);
    }
  }

  function initWorkerEngine() {
    const { OMCX_HOME, DB_FILE } = getPaths();
    ensureDir(OMCX_HOME);
    const workerScript = path.join(__dirname, "..", "dbWorker.js");

    try {
      dbWorker = new Worker(workerScript, {
        workerData: { dbFile: DB_FILE },
      });

      dbWorker.on("message", (msg) => {
        const { id, type, result, error, success } = msg || {};
        if (type === "READY") {
          console.log(`[storageService] SQLite 后台 Worker 线程初始化成功 (WAL Mode)`);
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

  return {
    getFallbackDb,
    executeFallbackAction,
    executeMemoryReadAction,
    sendToWorker,
    sendToWorkerWithPromise,
    flushPendingWritesSync,
    checkpointWalSync,
    loadInitialSnapshot,
    initWorkerEngine,
    hasLoadedSnapshot: () => hasLoadedSnapshot,
    markSnapshotLoaded: () => {
      hasLoadedSnapshot = true;
    },
  };
}

module.exports = { createDbEngine };
