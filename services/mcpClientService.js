const { spawn } = require("child_process");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const storageService = require("./storageService");
const { McpHttpClient } = require("./mcpHttpClient");
const mcpOAuthService = require("./mcpOAuthService");

const MCP_TOOL_PREFIX = "mcp__";
const HANDSHAKE_TIMEOUT_MS = 12000;
const CALL_TIMEOUT_MS = 30000;
const TOOLS_CACHE_TTL_MS = 60000;

function sanitizeSegment(str) {
  return String(str || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatMcpToolName(serverId, toolName) {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
}

/**
 * 将 MCP prompts/get 返回的多模态消息合并为可复制/可读的纯文本。
 */
function promptMessagesToText(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  return messages
    .map((message) => {
      const content = message?.content;
      if (typeof content === "string") return content;
      // MCP PromptMessage.content 既可能是单个 ContentBlock，也可能是数组
      const blocks = Array.isArray(content) ? content : content ? [content] : [];
      return blocks
        .map((item) => {
          if (!item) return "";
          if (item.type === "text") return item.text || "";
          if (item.type === "image") return "[图片内容]";
          if (item.type === "resource") {
            return `[资源: ${item.resource?.uri || ""}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildEnhancedEnv(customEnv = {}) {
  const basePath = process.env.PATH || "";
  const extraPaths = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const mergedPath = Array.from(new Set([...extraPaths, ...basePath.split(path.delimiter).filter(Boolean)])).join(
    path.delimiter
  );
  return {
    ...process.env,
    ...customEnv,
    PATH: mergedPath,
  };
}

class McpStdioClient {
  constructor(serverConfig) {
    this.id = serverConfig.id;
    this.command = serverConfig.command;
    this.args = Array.isArray(serverConfig.args) ? serverConfig.args : [];
    this.env = serverConfig.env || {};
    this.cwd = serverConfig.cwd || undefined;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    // UTF-8 流式解码：分块边界可能切断多字节字符，StringDecoder 负责跨块拼装
    this.stdoutDecoder = new StringDecoder("utf-8");
    this.initialized = false;
    this.initializingPromise = null;
    this.cachedTools = null;
    this.cachedToolsAt = 0;
  }

  isAlive() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  async ensureConnected() {
    if (this.initialized && this.isAlive()) {
      return true;
    }
    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.initializingPromise = this._connect().finally(() => {
      this.initializingPromise = null;
    });
    return this.initializingPromise;
  }

  async _connect() {
    this.close();

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(err);
      };

      try {
        this.proc = spawn(this.command, this.args, {
          env: buildEnhancedEnv(this.env),
          cwd: this.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          // 独立进程组：关闭时可连同其派生的孙进程一并终止，避免孤儿进程残留
          detached: process.platform !== "win32",
        });
      } catch (err) {
        return fail(err);
      }

      this.proc.on("error", (err) => {
        this._rejectAllPending(err);
        fail(err);
      });

      this.proc.on("exit", (code, signal) => {
        this.initialized = false;
        this._rejectAllPending(new Error(`MCP server "${this.id}" exited (code=${code}, signal=${signal})`));
        if (!settled) {
          fail(new Error(`MCP server "${this.id}" exited prematurely (code=${code})`));
        }
      });

      this.proc.stdout.on("data", (chunk) => {
        this._onStdoutData(chunk);
      });

      this.proc.stderr.on("data", () => {
        // 静默消费 stderr，防止缓冲区满阻塞子进程
      });

      // 子进程提前退出后继续写入 stdin 会触发 EPIPE，若不监听将直接击穿主进程
      this.proc.stdin.on("error", (err) => {
        this._rejectAllPending(err);
      });

      this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "omcx-desktop",
            version: "2.0.0",
          },
        },
        HANDSHAKE_TIMEOUT_MS
      )
        .then(() => {
          this.notify("notifications/initialized", {});
          this.initialized = true;
          if (!settled) {
            settled = true;
            resolve(true);
          }
        })
        .catch((err) => {
          fail(err);
        });
    });
  }

  _onStdoutData(chunk) {
    this.buffer += this.stdoutDecoder.write(chunk);

    while (true) {
      const headerMatch = this.buffer.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
      if (headerMatch) {
        const headerLen = headerMatch[0].length;
        const bodyLen = parseInt(headerMatch[1], 10);
        const restBuf = Buffer.from(this.buffer.slice(headerLen), "utf-8");
        if (restBuf.length < bodyLen) break;
        const jsonStr = restBuf.subarray(0, bodyLen).toString("utf-8");
        const remainingStr = restBuf.subarray(bodyLen).toString("utf-8");
        this.buffer = remainingStr;
        this._handleRawJson(jsonStr);
        continue;
      }

      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      this._handleRawJson(line);
    }
  }

  _handleRawJson(raw) {
    try {
      const msg = JSON.parse(raw);
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // 忽略非 JSON 标准输出行
    }
  }

  notify(method, params = {}) {
    if (!this.isAlive() || !this.proc.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      this.proc.stdin.write(payload);
    } catch {
      // 忽略写入异常
    }
  }

  request(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.isAlive() || !this.proc.stdin.writable) {
        return reject(new Error(`MCP server "${this.id}" is not running`));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request "${method}" to "${this.id}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      try {
        this.proc.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
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
    const res = await this.request(
      "tools/call",
      {
        name: toolName,
        arguments: args || {},
      },
      CALL_TIMEOUT_MS
    );
    return res;
  }

  _rejectAllPending(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  close() {
    this.initialized = false;
    this.cachedTools = null;
    this.buffer = "";
    this.stdoutDecoder = new StringDecoder("utf-8");
    this._rejectAllPending(new Error(`MCP client "${this.id}" closed`));
    if (this.proc) {
      const pid = this.proc.pid;
      try {
        if (process.platform !== "win32" && Number.isInteger(pid) && pid > 0) {
          // 负 PID 终止整个进程组，覆盖 MCP Server 自行派生的子进程
          process.kill(-pid, "SIGTERM");
        } else {
          this.proc.kill();
        }
      } catch {
        try {
          this.proc.kill();
        } catch {
          // 忽略关闭异常
        }
      }
      this.proc = null;
    }
  }
}

class McpClientManager {
  constructor() {
    this.clients = new Map();
    this.toolRouteMap = new Map();
  }

  _getClientKey(server) {
    const envKeys = Object.keys(server.env || {}).sort();
    const envSig = envKeys.map((k) => `${k}=${server.env[k]}`).join("\u0001");
    const headerKeys = Object.keys(server.headers || {}).sort();
    const headerSig = headerKeys
      .map((k) => `${k}=${server.headers[k]}`)
      .join("\u0001");
    return `${server.id}::${server.command || ""}::${JSON.stringify(server.args || [])}::${envSig}::${server.cwd || ""}::${server.url || ""}::${server.transport || ""}::${headerSig}::${server.authToken ? "auth" : ""}::${mcpOAuthService.isOAuthEnabled(server) ? "oauth" : ""}`;
  }

  _getOrCreateClient(server) {
    const existing = this.clients.get(server.id);
    const desiredKey = this._getClientKey(server);
    if (existing && existing._configKey === desiredKey) {
      return existing;
    }
    if (existing) {
      existing.close();
      this.clients.delete(server.id);
    }
    const client = server.url
      ? new McpHttpClient({
          ...server,
          tokenProvider: mcpOAuthService.isOAuthEnabled(server)
            ? () => mcpOAuthService.getAccessToken(server)
            : null,
        })
      : new McpStdioClient(server);
    client._configKey = desiredKey;
    this.clients.set(server.id, client);
    return client;
  }

  async getActiveMcpTools(workDir = null) {
    const servers = storageService
      .getMcpServers(workDir)
      // 安全加固：项目级 MCP 配置必须经用户显式信任后才允许拉起子进程
      .filter(
        (s) =>
          s.enabled !== false &&
          (s.command || s.url) &&
          (s.source !== "project" || s.trusted === true)
      );

    if (servers.length === 0) {
      return [];
    }

    const discovered = [];
    await Promise.allSettled(
      servers.map(async (server) => {
        try {
          const client = this._getOrCreateClient(server);
          const rawTools = await client.listTools();
          const disabledTools = new Set(Array.isArray(server.disabledTools) ? server.disabledTools : []);
          for (const rawTool of rawTools) {
            if (!rawTool || !rawTool.name) continue;
            if (disabledTools.has(rawTool.name)) continue;
            const fullName = formatMcpToolName(server.id, rawTool.name);
            const parameters =
              rawTool.inputSchema && typeof rawTool.inputSchema === "object"
                ? rawTool.inputSchema
                : { type: "object", properties: {}, required: [] };

            this.toolRouteMap.set(fullName, {
              serverId: server.id,
              toolName: rawTool.name,
              serverConfig: server,
            });

            discovered.push({
              name: fullName,
              serverId: server.id,
              originalName: rawTool.name,
              description: `[MCP:${server.id}] ${rawTool.description || rawTool.name}`,
              parameters,
              execute: async (args) => this.executeMcpTool(fullName, args, workDir),
            });
          }
        } catch (err) {
          console.warn(`[mcpClientService] 跳过不可用的 MCP Server "${server.id}": ${err.message}`);
        }
      })
    );

    return discovered;
  }

  isMcpTool(toolName) {
    return typeof toolName === "string" && toolName.startsWith(MCP_TOOL_PREFIX);
  }

  async executeMcpTool(fullName, args = {}, workDir = null) {
    let route = this.toolRouteMap.get(fullName);
    if (!route) {
      await this.getActiveMcpTools(workDir);
      route = this.toolRouteMap.get(fullName);
    }
    if (!route) {
      throw new Error(`未找到对应的 MCP 工具路由: ${fullName}`);
    }

    const client = this._getOrCreateClient(route.serverConfig);
    const result = await client.callTool(route.toolName, args);

    if (Array.isArray(result?.content)) {
      const textParts = result.content
        .map((item) => {
          if (item.type === "text") return item.text;
          return JSON.stringify(item);
        })
        .join("\n");
      return {
        isError: Boolean(result.isError),
        content: textParts || result.content,
      };
    }

    return result;
  }

  async getServerTools(serverId, workDir = null) {
    const server = storageService
      .getMcpServers(workDir)
      .find((item) => item.id === serverId);
    if (!server) {
      return { success: false, error: `未找到 MCP 服务器: ${serverId}` };
    }
    if (server.source === "project" && server.trusted !== true) {
      return { success: false, error: "项目级 MCP 尚未获得信任授权" };
    }
    if (!server.command && !server.url) {
      return { success: false, error: "该 MCP 服务器缺少 command 或 url 配置" };
    }
    try {
      const client = this._getOrCreateClient(server);
      const rawTools = await client.listTools();
      const disabled = new Set(Array.isArray(server.disabledTools) ? server.disabledTools : []);
      return {
        success: true,
        serverId,
        source: server.source,
        transport: server.url ? server.transport || "http" : "stdio",
        tools: rawTools
          .filter((tool) => tool && tool.name)
          .map((tool) => ({
            name: tool.name,
            description: tool.description || "",
            enabled: !disabled.has(tool.name),
            inputSchema: tool.inputSchema || null,
          })),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async listResources(workDir = null) {
    const servers = storageService
      .getMcpServers(workDir)
      .filter(
        (server) =>
          server.enabled !== false &&
          (server.command || server.url) &&
          (server.source !== "project" || server.trusted === true)
      );
    const result = [];
    await Promise.allSettled(
      servers.map(async (server) => {
        try {
          const client = this._getOrCreateClient(server);
          await client.ensureConnected();
          const res = await client.request("resources/list", {}, HANDSHAKE_TIMEOUT_MS);
          result.push({
            serverId: server.id,
            source: server.source,
            resources: Array.isArray(res?.resources) ? res.resources : [],
          });
        } catch (err) {
          result.push({ serverId: server.id, source: server.source, resources: [], error: err.message });
        }
      })
    );
    return result;
  }

  async readResource(uri, workDir = null) {
    const servers = storageService
      .getMcpServers(workDir)
      .filter(
        (server) =>
          server.enabled !== false &&
          (server.command || server.url) &&
          (server.source !== "project" || server.trusted === true)
      );
    for (const server of servers) {
      try {
        const client = this._getOrCreateClient(server);
        await client.ensureConnected();
        const res = await client.request("resources/read", { uri }, CALL_TIMEOUT_MS);
        return { success: true, serverId: server.id, result: res };
      } catch {
        // 继续尝试其他服务器
      }
    }
    return { success: false, error: `没有 MCP 服务器能够读取资源: ${uri}` };
  }

  async listPrompts(workDir = null) {
    const servers = storageService
      .getMcpServers(workDir)
      .filter(
        (server) =>
          server.enabled !== false &&
          (server.command || server.url) &&
          (server.source !== "project" || server.trusted === true)
      );
    const result = [];
    await Promise.allSettled(
      servers.map(async (server) => {
        try {
          const client = this._getOrCreateClient(server);
          await client.ensureConnected();
          const res = await client.request("prompts/list", {}, HANDSHAKE_TIMEOUT_MS);
          result.push({
            serverId: server.id,
            source: server.source,
            prompts: Array.isArray(res?.prompts) ? res.prompts : [],
          });
        } catch (err) {
          result.push({
            serverId: server.id,
            source: server.source,
            prompts: [],
            error: err.message,
          });
        }
      })
    );
    return result;
  }

  async getPrompt(serverId, promptName, args = {}, workDir = null) {
    if (!serverId || !promptName) {
      return { success: false, error: "缺少 serverId 或 promptName" };
    }
    const server = storageService
      .getMcpServers(workDir)
      .find(
        (item) =>
          item.id === serverId &&
          item.enabled !== false &&
          (item.source !== "project" || item.trusted === true)
      );
    if (!server) {
      return { success: false, error: `MCP 服务器不存在或未启用: ${serverId}` };
    }
    try {
      const client = this._getOrCreateClient(server);
      await client.ensureConnected();
      const res = await client.request(
        "prompts/get",
        { name: promptName, arguments: args || {} },
        CALL_TIMEOUT_MS
      );
      return {
        success: true,
        serverId,
        result: res,
        text: promptMessagesToText(res),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  reloadClients() {
    this.closeAll();
  }

  closeAll() {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.toolRouteMap.clear();
  }
}

const mcpClientService = new McpClientManager();

module.exports = {
  mcpClientService,
  MCP_TOOL_PREFIX,
  promptMessagesToText,
};
