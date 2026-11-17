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
  if (!text || text.indexOf("<think") === -1) {
    return { content: text, reasoning: "" };
  }

  let cursor = 0;
  let content = "";
  let reasoning = "";

  while (cursor < text.length) {
    const thinkOpen = text.indexOf("<think>", cursor);
    const thinkingOpen = text.indexOf("<thinking>", cursor);
    let openIdx = -1;
    let openTag = "";
    let closeTag = "";

    if (thinkOpen !== -1 && (thinkingOpen === -1 || thinkOpen <= thinkingOpen)) {
      openIdx = thinkOpen;
      openTag = "<think>";
      closeTag = "</think>";
    } else if (thinkingOpen !== -1) {
      openIdx = thinkingOpen;
      openTag = "<thinking>";
      closeTag = "</thinking>";
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

function parseJsonColumn(value) {
  if (value === null || value === undefined || value === "") return null;
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

function createSessionMessageStorage({
  memoryState,
  isMemoryOnlyMode,
  getConfig,
  reasoningPolicy,
  dbEngine,
  deleteSessionAttachments,
}) {
  const {
    getFallbackDb,
    executeFallbackAction,
    sendToWorker,
    sendToWorkerWithPromise,
    loadInitialSnapshot,
    hasLoadedSnapshot,
  } = dbEngine;

  function getSessions() {
    if (!hasLoadedSnapshot()) {
      loadInitialSnapshot();
    }
    return [...memoryState.getSessions()];
  }

  function getSession(sessionId) {
    if (!sessionId) return null;
    if (!hasLoadedSnapshot()) {
      loadInitialSnapshot();
    }
    const found = memoryState.getSessions().find((s) => s.id === sessionId);
    return found ? { ...found } : null;
  }

  function saveSession(session) {
    if (!session || !session.id) return { success: false, error: "缺少会话 ID" };
    const now = Date.now();
    const sessions = memoryState.getSessions();
    const existing = sessions.find((s) => s.id === session.id);

    const record = {
      id: session.id,
      title: session.title || existing?.title || "新的 Agent 会话",
      title_source: session.title_source || existing?.title_source || "default",
      model: session.model || existing?.model || "",
      workspace_id:
        session.workspace_id !== undefined ? session.workspace_id : existing?.workspace_id || null,
      work_dir: session.work_dir !== undefined ? session.work_dir : existing?.work_dir || null,
      permission_mode: session.permission_mode || existing?.permission_mode || "auto-sandbox",
      reasoning_effort: session.reasoning_effort || existing?.reasoning_effort || "medium",
      agent_mode:
        (session.agent_mode || session.agentMode || existing?.agent_mode || existing?.agentMode) === "work"
          ? "work"
          : "code",
      session_type:
        (session.session_type || session.sessionType || existing?.session_type || existing?.sessionType) === "automation"
          ? "automation"
          : "chat",
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

    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = record;
    } else {
      sessions.unshift(record);
    }

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

    memoryState.setSessions(memoryState.getSessions().filter((s) => s.id !== sessionId));
    const cachedMessages = memoryState.messagesBySession.get(sessionId);
    if (Array.isArray(cachedMessages)) {
      for (const msg of cachedMessages) {
        if (msg?.id) memoryState.reasoningsByMsgId.delete(msg.id);
      }
    }
    memoryState.messagesBySession.delete(sessionId);
    memoryState.outputsBySession.delete(sessionId);

    sendToWorker("DELETE_SESSION", sessionId);
    deleteSessionAttachments(sessionId);
    return { success: true };
  }

  function getMessages(sessionId) {
    if (!sessionId) return [];
    if (memoryState.messagesBySession.has(sessionId)) {
      const cached = memoryState.messagesBySession.get(sessionId);
      touchLruCache(memoryState.messagesBySession, sessionId, cached, MAX_CACHED_MESSAGE_SESSIONS);
      return [...cached];
    }

    if (isMemoryOnlyMode()) return [];
    try {
      const db = getFallbackDb();
      if (!db) return [];
      const rows = db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId);
      const list = rows.map(mapMessageRow);
      touchLruCache(memoryState.messagesBySession, sessionId, list, MAX_CACHED_MESSAGE_SESSIONS);
      return list;
    } catch (err) {
      console.error(`[storageService] 获取会话 ${sessionId} 消息失败:`, err.message);
      return [];
    }
  }

  async function getMessagesAsync(sessionId) {
    if (!sessionId) return [];
    if (memoryState.messagesBySession.has(sessionId)) {
      const cached = memoryState.messagesBySession.get(sessionId);
      touchLruCache(memoryState.messagesBySession, sessionId, cached, MAX_CACHED_MESSAGE_SESSIONS);
      return [...cached];
    }
    try {
      const rows = await sendToWorkerWithPromise("GET_MESSAGES", { sessionId });
      if (!Array.isArray(rows)) throw new Error("Worker 未返回消息数组");
      const list = rows.map(mapMessageRow);
      touchLruCache(memoryState.messagesBySession, sessionId, list, MAX_CACHED_MESSAGE_SESSIONS);
      return list;
    } catch (err) {
      console.warn(
        `[storageService] Worker 读取会话 ${sessionId} 消息失败，回退主线程读取:`,
        err.message
      );
      return getMessages(sessionId);
    }
  }

  async function getMessageByIdAsync(messageId) {
    const id = String(messageId || "").trim();
    if (!id) return null;
    try {
      const row = await sendToWorkerWithPromise("GET_MESSAGE_BY_ID", { messageId: id });
      return row ? mapMessageRow(row) : null;
    } catch {
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

  function getMessageReasoning(messageId) {
    const id = String(messageId || "").trim();
    if (!id) return "";
    if (memoryState.reasoningsByMsgId.has(id)) {
      const cached = memoryState.reasoningsByMsgId.get(id);
      touchLruCache(memoryState.reasoningsByMsgId, id, cached, MAX_CACHED_REASONINGS);
      return cached;
    }
    const text = executeFallbackAction("GET_MESSAGE_REASONING", id);
    if (text) {
      touchLruCache(memoryState.reasoningsByMsgId, id, text, MAX_CACHED_REASONINGS);
      return text;
    }
    return "";
  }

  async function getMessageReasoningAsync(messageId) {
    const id = String(messageId || "").trim();
    if (!id) return "";
    if (memoryState.reasoningsByMsgId.has(id)) {
      const cached = memoryState.reasoningsByMsgId.get(id);
      touchLruCache(memoryState.reasoningsByMsgId, id, cached, MAX_CACHED_REASONINGS);
      return cached;
    }
    try {
      const text = await sendToWorkerWithPromise("GET_MESSAGE_REASONING", { messageId: id });
      if (typeof text === "string" && text) {
        touchLruCache(memoryState.reasoningsByMsgId, id, text, MAX_CACHED_REASONINGS);
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
    if (!memoryState.getSessions().some((s) => s.id === sessionId)) {
      return { success: false, error: "会话不存在或已删除" };
    }

    // 架构防御：若该会话尚未加载历史缓存，必须先调用 getMessages(sessionId) 预热内存池，
    // 杜绝首次写入直接覆盖导致历史消息丢失的重大时序缺口
    if (!memoryState.messagesBySession.has(sessionId)) {
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
        : Number(
            message.reasoning_chars || message.reasoningChars || message.metadata?.reasoningChars || 0
          );

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

    const currentList = memoryState.messagesBySession.get(sessionId) || [];
    const existingIdx = currentList.findIndex((m) => m.id === msgId);
    if (existingIdx >= 0) {
      currentList[existingIdx] = fullMsg;
    } else {
      currentList.push(fullMsg);
    }
    touchLruCache(memoryState.messagesBySession, sessionId, currentList, MAX_CACHED_MESSAGE_SESSIONS);

    if (reasoning) {
      touchLruCache(memoryState.reasoningsByMsgId, msgId, reasoning, MAX_CACHED_REASONINGS);
    } else if (reasoningPersistence === "off") {
      memoryState.reasoningsByMsgId.delete(msgId);
    }

    const sess = memoryState.getSessions().find((s) => s.id === sessionId);
    if (sess) {
      sess.updated_at = now;
    }

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
      dropReasoning: reasoningPersistence === "off",
      now,
    });

    return { success: true, message: fullMsg };
  }

  function persistMessageSync(sessionId, message) {
    if (!sessionId || !message) return { success: false, error: "参数不完整" };

    const res = addMessage(sessionId, message);
    if (!res.success) return res;

    const record = res.message;
    const reasoning = memoryState.reasoningsByMsgId.get(record.id) || null;
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

    const currentList = memoryState.messagesBySession.get(sessionId) || [];
    const filtered = currentList.filter((m) => m.created_at <= timestamp);
    touchLruCache(memoryState.messagesBySession, sessionId, filtered, MAX_CACHED_MESSAGE_SESSIONS);

    sendToWorker("DELETE_MESSAGES_AFTER", { sessionId, timestamp });
    return { success: true };
  }

  function getSessionOutputs(sessionId) {
    if (!sessionId) return [];
    if (memoryState.outputsBySession.has(sessionId)) {
      const cached = memoryState.outputsBySession.get(sessionId);
      touchLruCache(memoryState.outputsBySession, sessionId, cached, MAX_CACHED_OUTPUT_SESSIONS);
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
      touchLruCache(memoryState.outputsBySession, sessionId, list, MAX_CACHED_OUTPUT_SESSIONS);
      return list;
    } catch {
      return [];
    }
  }

  async function getSessionOutputsAsync(sessionId) {
    if (!sessionId) return [];
    if (memoryState.outputsBySession.has(sessionId)) {
      const cached = memoryState.outputsBySession.get(sessionId);
      touchLruCache(memoryState.outputsBySession, sessionId, cached, MAX_CACHED_OUTPUT_SESSIONS);
      return [...cached];
    }
    try {
      const rows = await sendToWorkerWithPromise("GET_OUTPUTS", { sessionId });
      if (!Array.isArray(rows)) throw new Error("Worker 未返回产出物数组");
      const list = rows.map(mapOutputRow);
      touchLruCache(memoryState.outputsBySession, sessionId, list, MAX_CACHED_OUTPUT_SESSIONS);
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
      touchLruCache(memoryState.outputsBySession, sessionId, current, MAX_CACHED_OUTPUT_SESSIONS);

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

  function searchMemorySessions(query, limit) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const extractSnippet = (text) => {
      const flat = String(text || "").replace(/\s+/g, " ").trim();
      const idx = flat.toLowerCase().indexOf(q);
      if (idx === -1) return "";
      const start = Math.max(0, idx - 26);
      const end = Math.min(flat.length, idx + q.length + 52);
      return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
    };
    const bySession = new Map();
    for (const s of memoryState.getSessions()) {
      if (s?.session_type === "automation" || s?.sessionType === "automation") continue;
      if (String(s?.title || "").toLowerCase().includes(q)) {
        bySession.set(s.id, {
          sessionId: s.id,
          title: s.title || "新的 Agent 会话",
          updatedAt: s.updated_at || 0,
          matchType: "title",
          matchSnippet: "",
        });
      }
    }
    for (const [sid, list] of memoryState.messagesBySession.entries()) {
      const sess = memoryState.getSessions().find((s) => s.id === sid);
      if (!sess || !Array.isArray(list)) continue;
      if (sess.session_type === "automation" || sess.sessionType === "automation") continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const content = String(list[i]?.content || "");
        if (!content.toLowerCase().includes(q)) continue;
        const snippet = extractSnippet(content);
        const existing = bySession.get(sid);
        if (!existing) {
          bySession.set(sid, {
            sessionId: sid,
            title: sess.title || "新的 Agent 会话",
            updatedAt: sess.updated_at || 0,
            matchType: "message",
            matchSnippet: snippet,
          });
        } else if (!existing.matchSnippet && snippet) {
          existing.matchSnippet = snippet;
        }
        break;
      }
    }
    return Array.from(bySession.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
  }

  async function searchSessionsAsync(query, { limit = 40 } = {}) {
    const clean = String(query || "").trim();
    if (!clean) return [];
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 40));

    if (!hasLoadedSnapshot()) {
      loadInitialSnapshot();
    }

    const memoryHits = searchMemorySessions(clean, safeLimit);
    if (isMemoryOnlyMode()) {
      return memoryHits;
    }

    let dbHits = [];
    try {
      const rows = await sendToWorkerWithPromise("SEARCH_SESSIONS", {
        query: clean,
        limit: safeLimit,
      });
      if (Array.isArray(rows)) dbHits = rows;
    } catch {
      const fallback = executeFallbackAction("SEARCH_SESSIONS", {
        query: clean,
        limit: safeLimit,
      });
      if (Array.isArray(fallback)) dbHits = fallback;
    }

    const merged = new Map();
    for (const hit of dbHits) {
      if (hit?.sessionId) merged.set(hit.sessionId, hit);
    }
    for (const hit of memoryHits) {
      const existing = merged.get(hit.sessionId);
      if (!existing) {
        merged.set(hit.sessionId, hit);
      } else if (!existing.matchSnippet && hit.matchSnippet) {
        existing.matchSnippet = hit.matchSnippet;
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, safeLimit);
  }

  function promoteSessionToChat(sessionId) {
    const session = getSession(sessionId);
    if (!session) return null;
    if (session.session_type !== "automation" && session.sessionType !== "automation") {
      return session;
    }
    const res = saveSession({ ...session, session_type: "chat", updated_at: Date.now() });
    return res?.session || session;
  }

  return {
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
  };
}

module.exports = {
  extractLegacyThinking,
  splitThinkingContent,
  createSessionMessageStorage,
};
