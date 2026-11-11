/**
 * McpHttpClient — MCP Streamable HTTP / 旧版 SSE 传输客户端
 *
 * 支持：
 * - Streamable HTTP：POST JSON-RPC，响应可为 application/json 或 text/event-stream；
 * - Legacy SSE：GET 建立事件流，从 endpoint 事件获取消息投递地址；
 * - 会话头 Mcp-Session-Id 保持、静态 Authorization/自定义 headers；
 * - 工具列表与调用与 Stdio 客户端保持同一接口。
 */

const CALL_TIMEOUT_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 15000;
const TOOLS_CACHE_TTL_MS = 60000;

function joinUrl(base, pathname) {
  if (!pathname) return base;
  try {
    return new URL(pathname, base).toString();
  } catch {
    return `${base.replace(/\/+$/, "")}/${String(pathname).replace(/^\/+/, "")}`;
  }
}

function parseSseEvent(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}

class McpHttpClient {
  constructor(serverConfig) {
    this.id = serverConfig.id;
    this.url = serverConfig.url;
    this.transport = serverConfig.transport === "sse" ? "sse" : "http";
    this.headers = serverConfig.headers && typeof serverConfig.headers === "object"
      ? serverConfig.headers
      : {};
    this.authToken = serverConfig.authToken || "";
    this.tokenProvider =
      typeof serverConfig.tokenProvider === "function" ? serverConfig.tokenProvider : null;
    this.nextId = 1;
    this.sessionId = null;
    this.initialized = false;
    this.initializingPromise = null;
    this.cachedTools = null;
    this.cachedToolsAt = 0;
    this.closed = false;
    this.pending = new Map();
    this.sseAbort = null;
    this.sseEndpoint = null;
    this.sseReadyPromise = null;
  }

  isAlive() {
    return !this.closed;
  }

  _headers(extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
      ...extra,
    };
    if (this.authToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
  }

  async _authHeaders(extra = {}) {
    if (this.tokenProvider) {
      try {
        const token = await this.tokenProvider();
        if (token) this.authToken = token;
      } catch {
        // OAuth token 获取失败时回退到已有 token/静态 headers
      }
    }
    return this._headers(extra);
  }

  async ensureConnected() {
    if (this.initialized && this.isAlive()) return true;
    if (this.initializingPromise) return this.initializingPromise;
    this.initializingPromise = this._connect().finally(() => {
      this.initializingPromise = null;
    });
    return this.initializingPromise;
  }

  async _connect() {
    this.closed = false;
    if (this.transport === "sse") {
      await this._ensureSseStream();
    }
    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omcx-desktop", version: "2.1.7" },
      },
      HANDSHAKE_TIMEOUT_MS
    );
    this.notify("notifications/initialized", {});
    this.initialized = true;
    return result;
  }

  async _ensureSseStream() {
    if (this.sseReadyPromise) return this.sseReadyPromise;
    const sseHeaders = await this._authHeaders({ Accept: "text/event-stream" });
    this.sseReadyPromise = new Promise((resolve, reject) => {
      const controller = new AbortController();
      this.sseAbort = controller;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          controller.abort();
          reject(new Error(`MCP SSE 握手超时: ${this.id}`));
        }
      }, HANDSHAKE_TIMEOUT_MS);

      fetch(this.url, {
        method: "GET",
        headers: sseHeaders,
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok || !response.body) {
            throw new Error(`MCP SSE 连接失败 (${response.status})`);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || "";
            for (const raw of events) {
              const { event, data } = parseSseEvent(raw);
              if (!data) continue;
              if (event === "endpoint") {
                this.sseEndpoint = joinUrl(this.url, data.trim());
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  resolve(true);
                }
                continue;
              }
              if (event === "message" || event === "json") {
                try {
                  this._handleMessage(JSON.parse(data));
                } catch {
                  // 忽略不可解析的 SSE 消息
                }
              }
            }
          }
          throw new Error("MCP SSE 事件流已结束");
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
          this._rejectAllPending(err);
        });
    }).finally(() => {
      this.sseReadyPromise = null;
    });
    return this.sseReadyPromise;
  }

  _handleMessage(message) {
    if (!message) return;
    if (Array.isArray(message)) {
      for (const item of message) this._handleMessage(item);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }

  async _post(body, { expectResponse = true, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const endpoint = this.transport === "sse" ? this.sseEndpoint : this.url;
    if (!endpoint) throw new Error(`MCP SSE endpoint 尚未就绪: ${this.id}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: await this._authHeaders(),
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }

    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) this.sessionId = sessionHeader;

    if (!expectResponse || response.status === 202 || response.status === 204) {
      return null;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP HTTP 请求失败 (${response.status}): ${text.slice(0, 600)}`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || "";
          for (const raw of events) {
            const { data } = parseSseEvent(raw);
            if (!data) continue;
            let message;
            try {
              message = JSON.parse(data);
            } catch {
              continue;
            }
            const list = Array.isArray(message) ? message : [message];
            const matched = list.find(
              (item) => item && item.id !== undefined && item.id === body.id
            );
            if (matched) return matched.result;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {}
      }
      throw new Error(`MCP 流式响应未返回匹配的 JSON-RPC 结果: ${this.id}`);
    }

    const text = await response.text();
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const matched = parsed.find((item) => item && item.id === body.id);
      if (matched) return matched.result;
      return parsed;
    }
    if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    return parsed.result;
  }

  notify(method, params = {}) {
    if (!this.isAlive()) return;
    this._post({ jsonrpc: "2.0", method, params }, { expectResponse: false }).catch(() => {
      // 通知失败不影响主流程
    });
  }

  request(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };

    if (this.transport === "sse") {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`MCP 请求 "${method}" 超时 (${timeoutMs}ms)`));
          }
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this._post(body, { expectResponse: false, timeoutMs }).catch((err) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        });
      });
    }

    return this._post(body, { expectResponse: true, timeoutMs });
  }

  async listTools() {
    if (this.cachedTools && Date.now() - this.cachedToolsAt < TOOLS_CACHE_TTL_MS) {
      return this.cachedTools;
    }
    await this.ensureConnected();
    const res = await this.request("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    this.cachedTools = tools;
    this.cachedToolsAt = Date.now();
    return tools;
  }

  async callTool(toolName, args = {}) {
    await this.ensureConnected();
    return this.request(
      "tools/call",
      { name: toolName, arguments: args || {} },
      CALL_TIMEOUT_MS
    );
  }

  _rejectAllPending(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.initialized = false;
    this.cachedTools = null;
    this.sessionId = null;
    this.sseEndpoint = null;
    this._rejectAllPending(new Error(`MCP HTTP client "${this.id}" closed`));
    if (this.sseAbort) {
      try {
        this.sseAbort.abort();
      } catch {}
      this.sseAbort = null;
    }
  }
}

module.exports = {
  McpHttpClient,
};
