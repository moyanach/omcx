const {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  dialog,
  shell,
  net,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { pathToFileURL } = require("url");
const crypto = require("crypto");

// 引入核心业务服务
const storageService = require("./services/storageService");
const { getWorkspaceGitStatus } = require("./services/workspaceGitService");
const { calculateContextMetrics, estimateTokens } = require("./services/contextCalculator");
const { toolRegistry } = require("./utils/toolRegistry");
const { performWebSearch, scrapePageContent } = require("./utils/tools/webTools");
const { listWorkspaceFiles } = require("./utils/tools/fileIndexer");
const { buildMentionContext } = require("./utils/tools/mentionResolver");
const { buildSystemContext } = require("./utils/contextBuilder");
const {
  estimateMessagesTokens,
  getThresholds,
  shouldMicroCompact,
  microCompact,
  truncateToolResult,
  compactMessages,
  hardTruncate,
  isContextOverflowError,
} = require("./services/contextCompactor");

// 注册特权协议 (必须在 app.whenReady() 之前调用)
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: "local-media",
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// 读取系统配置辅助函数
function getApiConfig() {
  const apiKey = storageService.getConfig("api_key") || "";
  const baseUrl = storageService.getConfig("base_url") || "https://api.openai.com/v1";
  const savePath = storageService.getConfig("save_path") || "";
  return { apiKey, baseUrl, savePath };
}

// 读取搜索配置辅助函数
function getSearchConfig() {
  const provider = storageService.getConfig("search_provider") || "duckduckgo";
  const apiKey = storageService.getConfig("search_api_key") || "";
  const maxResultsVal = storageService.getConfig("search_max_results") || 5;
  const maxResults = parseInt(maxResultsVal, 10) || 5;
  return { provider, apiKey, maxResults };
}

/**
 * 匹配工作目录所属的多目录工作空间，返回挂载的全部源文件夹
 */
function getWorkspaceFolders(workDir) {
  if (!workDir || typeof workDir !== "string" || !workDir.trim()) {
    return { matchedWorkspace: null, allowedFolders: [] };
  }
  const resolvedDir = path.resolve(workDir.trim());
  const matchedWorkspace =
    storageService
      .getWorkspaces()
      .find((ws) => Array.isArray(ws.folders) && ws.folders.some((f) => f.path === workDir.trim())) || null;
  const allowedFolders = matchedWorkspace?.folders
    ? matchedWorkspace.folders.map((f) => path.resolve(f.path))
    : [resolvedDir];
  return { matchedWorkspace, allowedFolders };
}

const IMAGE_MAX_EDGE = 2000;
const IMAGE_INLINE_MAX_BYTES = 1.5 * 1024 * 1024;
const IMAGE_MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

function extFromMime(mime, name) {
  const byMime = IMAGE_MIME_EXT[String(mime || "").toLowerCase()];
  if (byMime) return byMime;
  const ext = path.extname(String(name || "")).replace(".", "").toLowerCase();
  return ext || "png";
}

function processAttachmentImage(base64, mime) {
  const input = Buffer.from(String(base64 || ""), "base64");
  if (input.length === 0) throw new Error("图片内容为空");

  const image = nativeImage.createFromBuffer(input);
  if (image.isEmpty()) throw new Error("无法识别的图片格式");

  let { width, height } = image.getSize();
  let buffer = input;
  let outMime = mime || "image/png";

  if (width > IMAGE_MAX_EDGE || height > IMAGE_MAX_EDGE) {
    const scale = IMAGE_MAX_EDGE / Math.max(width, height);
    const resized = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: "good",
    });
    const resizedSize = resized.getSize();
    width = resizedSize.width;
    height = resizedSize.height;
    const useJpeg = /jpe?g/i.test(outMime);
    buffer = useJpeg ? resized.toJPEG(90) : resized.toPNG();
    outMime = useJpeg ? "image/jpeg" : "image/png";
  }

  return { buffer, width, height, mime: outMime };
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }
  return "";
}

function encodeAttachmentForModel(attachment) {
  if (!attachment || !attachment.path) return null;
  if (!storageService.isSessionAttachmentPath(attachment.path)) return null;
  if (!fs.existsSync(attachment.path)) return null;

  let buffer = fs.readFileSync(attachment.path);
  let mime = attachment.mime || "image/png";

  if (buffer.length > IMAGE_INLINE_MAX_BYTES) {
    const image = nativeImage.createFromBuffer(buffer);
    if (!image.isEmpty()) {
      const { width, height } = image.getSize();
      let scale = Math.min(1, 1600 / Math.max(width, height));
      let resized = image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "good",
      });
      buffer = resized.toJPEG(85);
      mime = "image/jpeg";

      if (buffer.length > IMAGE_INLINE_MAX_BYTES) {
        scale *= 0.75;
        resized = image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "good",
        });
        buffer = resized.toJPEG(80);
      }
    }
  }

  return { mime, base64: buffer.toString("base64"), bytes: buffer.length };
}

function buildMultimodalMessages(messages) {
  const withImages = [];
  messages.forEach((msg, index) => {
    if (msg.role === "user" && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      withImages.push(index);
    }
  });
  const injectIndexes = new Set(withImages.slice(-2));

  let imageCount = 0;
  let imageBytes = 0;

  const result = messages.map((msg, index) => {
    if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) return msg;

    const text = extractTextContent(msg.content);

    if (!injectIndexes.has(index)) {
      const omitted = text.replace(/\[image #\d+\]/g, (token) => `${token.slice(0, -1)}: omitted]`);
      return { role: msg.role, content: omitted || "[历史图片已省略]" };
    }

    const images = [];
    for (const attachment of msg.attachments) {
      const encoded = encodeAttachmentForModel(attachment);
      if (!encoded) continue;
      images.push({
        type: "image_url",
        image_url: { url: `data:${encoded.mime};base64,${encoded.base64}` },
      });
      imageCount += 1;
      imageBytes += encoded.bytes;
    }

    if (images.length === 0) {
      return { role: msg.role, content: text };
    }

    return {
      role: msg.role,
      content: [{ type: "text", text: text || "请查看以下图片。" }, ...images],
    };
  });

  return { messages: result, imageCount, imageBytes };
}

/**
 * 统一获取模型配置（优先匹配 models 列表，回退到全局配置）
 */
function getModelConfig(model, defaultModelId = "gpt-4o") {
  const models = storageService.getModels();
  const matched = models.find(
    (m) => m.id === model || m.model_id === model,
  );

  const globalCfg = getApiConfig();
  const modelBaseUrl = matched?.base_url || globalCfg.baseUrl;
  const modelApiKey = matched?.api_key || globalCfg.apiKey;
  const provider = matched?.provider || "openai";
  const apiModelId = matched?.model_id || model || defaultModelId;
  const contextLimit = matched?.context_limit || 128000;
  const supportsVision =
    typeof matched?.supports_vision === "boolean"
      ? matched.supports_vision
      : storageService.inferVisionSupport(apiModelId);

  return { modelBaseUrl, modelApiKey, provider, apiModelId, contextLimit, supportsVision };
}

const LITE_MODEL_HINTS = [
  "mini",
  "flash",
  "haiku",
  "v3",
  "turbo",
  "small",
  "7b",
  "8b",
  "3b",
];

function pickLiteModel(currentModelId) {
  const allModels = storageService.getModels();
  const usable = allModels.filter((m) => m.api_key || m.provider === "ollama");
  const found = usable.find((m) => {
    const id = (m.model_id || m.id || "").toLowerCase();
    return LITE_MODEL_HINTS.some((hint) => id.includes(hint));
  });
  return found?.id || currentModelId;
}

/**
 * 异步旁路会话标题生成器 (Fire-and-forget Asynchronous Sidecar)
 */
async function generateSessionTitleSidecar(sessionId, userPrompt, currentModelId, webContents) {
  try {
    const session = storageService.getSessions().find((s) => s.id === sessionId);
    if (!session || session.title_source === "custom") {
      return; // 用户已自定义过标题，绝不覆盖
    }

    const cleanPrompt = String(userPrompt || "").trim();
    if (!cleanPrompt || cleanPrompt.length < 2) return;

    const liteModelChoice = pickLiteModel(currentModelId);
    const { modelBaseUrl, modelApiKey, apiModelId } = getModelConfig(liteModelChoice, "gpt-4o");
    if (!modelBaseUrl || (!modelApiKey && liteModelChoice !== "ollama")) {
      return;
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 6000);

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (modelApiKey) {
      headers["Authorization"] = `Bearer ${modelApiKey}`;
    }

    const response = await fetch(`${modelBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: apiModelId,
        messages: [
          {
            role: "system",
            content:
              "你是会话命名助手。根据用户提问的核心意图，提炼出一个简短、精准的中文标题（4到10个汉字）。禁止回答问题，禁止输出任何标点符号、引号、书名号或“标题：”等前缀，直接输出纯文本标题本身。",
          },
          {
            role: "user",
            content: `<message>\n${cleanPrompt.slice(0, 400)}\n</message>`,
          },
        ],
        max_tokens: 30,
        temperature: 0.2,
        stream: false,
        reasoning_effort: "none",
      }),
    });

    clearTimeout(timeoutTimer);

    if (!response.ok) return;

    const data = await response.json();
    let rawTitle = data?.choices?.[0]?.message?.content?.trim();
    if (!rawTitle) return;

    // 输出清洗
    let title = rawTitle
      .replace(/^[`"'“‘《【\[(（\s]+|[`"'”’》】\])）\s]+$/g, "")
      .replace(/^(会话标题|会话名称|标题|Title|Topic)[：:]\s*/i, "")
      .trim();

    title = title.split(/\r?\n/)[0].trim().slice(0, 20);

    if (title.length >= 2) {
      const updated = storageService.updateSessionGeneratedTitle(sessionId, title);
      if (updated && webContents && !webContents.isDestroyed()) {
        webContents.send("session-title-updated", { sessionId, title });
        console.log(`[title-sidecar] generated title for ${sessionId}: "${title}"`);
      }
    }
  } catch (err) {
    // 旁路任务静默失败，绝不打扰主流程
  }
}

/**
 * 包装 IPC handler 的异常处理
 */
function safeHandler(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error("[main IPC Error]", err);
      throw err;
    }
  };
}

let mainWindow = null;

// 2. 创建主窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    title: "OMCX Desktop",
    width: 1400,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#111111",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // 默认直接同步加载本地打包产物，杜绝异步探活挂起与黑屏
  mainWindow.loadURL("app://dist/index.html");

  // 监听渲染进程日志与失败事件
  mainWindow.webContents.on("console-message", (event, level, message, line, sourceId) => {
    console.log(`[Renderer Log] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main did-fail-load] code: ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 3. 注册 IPC 事件与生命周期
app.whenReady().then(() => {
  // 3.1 初始化 ~/.omcx 配置文件与环境
  storageService.initStorage();

  // 3.2 注册特权协议
  protocol.handle("local-media", async (request) => {
    try {
      let filePath = request.url;
      if (filePath.startsWith("local-media://")) {
        filePath = filePath.slice("local-media://".length);
      }
      const queryIndex = filePath.indexOf("?");
      if (queryIndex !== -1) filePath = filePath.substring(0, queryIndex);
      const hashIndex = filePath.indexOf("#");
      if (hashIndex !== -1) filePath = filePath.substring(0, hashIndex);
      filePath = decodeURIComponent(filePath);

      if (process.platform === "win32") {
        if (filePath.startsWith("/")) filePath = filePath.slice(1);
        filePath = filePath.replace(/\//g, "\\");
      } else {
        if (!filePath.startsWith("/")) filePath = "/" + filePath;
      }

      const fileUrl = pathToFileURL(filePath).toString();
      const response = await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true });
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.error("Failed to load local file via local-media:", error);
      return new Response("File not found", { status: 404 });
    }
  });

  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      let relativePath = decodeURIComponent(url.pathname);
      if (relativePath.startsWith("/")) relativePath = relativePath.slice(1);

      let filePath;
      if (url.host === "dist") {
        filePath = path.join(__dirname, "dist", relativePath);
      } else {
        filePath = path.join(__dirname, relativePath);
      }

      // 若请求目录或不存在，默认返回 index.html
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(__dirname, "dist", "index.html");
      }

      const buffer = fs.readFileSync(filePath);
      const headers = new Headers();
      headers.set("Access-Control-Allow-Origin", "*");
      if (filePath.endsWith(".html")) {
        headers.set("Content-Type", "text/html; charset=utf-8");
      } else if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
        headers.set("Content-Type", "text/javascript; charset=utf-8");
      } else if (filePath.endsWith(".css")) {
        headers.set("Content-Type", "text/css; charset=utf-8");
      } else if (filePath.endsWith(".svg")) {
        headers.set("Content-Type", "image/svg+xml");
      } else if (filePath.endsWith(".png")) {
        headers.set("Content-Type", "image/png");
      }

      return new Response(buffer, { status: 200, headers });
    } catch (err) {
      console.error("[protocol:app error]", err);
      try {
        const fallback = fs.readFileSync(path.join(__dirname, "dist", "index.html"));
        return new Response(fallback, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch {
        return new Response("Failed to load app", { status: 500 });
      }
    }
  });

  // --- 配置操作 IPC ---
  ipcMain.handle(
    "get-config",
    safeHandler((event, key) => storageService.getConfig(key))
  );

  ipcMain.handle(
    "set-config",
    safeHandler((event, key, value) => storageService.setConfig(key, value))
  );

  ipcMain.handle(
    "get-user-info",
    safeHandler(() => {
      try {
        return { username: os.userInfo().username || "本地用户" };
      } catch {
        return { username: "本地用户" };
      }
    })
  );

  // --- 模型操作 IPC ---
  ipcMain.handle(
    "db-get-models",
    safeHandler(() => storageService.getModels())
  );

  ipcMain.handle(
    "db-add-model",
    safeHandler((event, model) => storageService.addModel(model))
  );

  ipcMain.handle(
    "db-delete-model",
    safeHandler((event, id) => storageService.deleteModel(id))
  );

  // --- 会话与消息操作 IPC ---
  ipcMain.handle(
    "db-get-sessions",
    safeHandler(() => storageService.getSessions())
  );

  ipcMain.handle(
    "db-add-session",
    safeHandler((event, session) => storageService.saveSession(session))
  );

  ipcMain.handle(
    "db-update-session-title",
    safeHandler((event, id, title) => {
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.title = title;
        session.title_source = "custom";
        storageService.saveSession(session);
        return true;
      }
      return false;
    })
  );

  ipcMain.handle(
    "db-update-session-work-dir",
    safeHandler((event, id, workDir) => {
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.work_dir = workDir || null;
        storageService.saveSession(session);
        return true;
      }
      return false;
    })
  );

  ipcMain.handle(
    "db-get-session-work-dir",
    safeHandler((event, id) => {
      const session = storageService.getSessions().find((s) => s.id === id);
      return session?.work_dir || null;
    })
  );

  ipcMain.handle(
    "get-workspaces",
    safeHandler(() => storageService.getWorkspaces())
  );

  ipcMain.handle(
    "save-workspace",
    safeHandler((event, ws) => storageService.saveWorkspace(ws))
  );

  ipcMain.handle(
    "delete-workspace",
    safeHandler((event, id) => storageService.deleteWorkspace(id))
  );

  ipcMain.handle(
    "dialog-select-work-directory",
    safeHandler(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
        title: "选择项目工作目录",
      });
      if (result.canceled) return null;
      return result.filePaths[0] || null;
    })
  );

  ipcMain.handle(
    "db-delete-session",
    safeHandler((event, id) => storageService.deleteSession(id))
  );

  ipcMain.handle(
    "db-get-messages",
    safeHandler((event, sessionId) => storageService.getMessages(sessionId))
  );

  ipcMain.handle(
    "db-add-message",
    safeHandler((event, { id, sessionId, role, content, metadata }) =>
      storageService.addMessage(sessionId, { id, role, content, metadata })
    )
  );

  ipcMain.handle(
    "db-delete-messages-after",
    safeHandler((event, { sessionId, timestamp }) =>
      storageService.deleteMessagesAfter(sessionId, timestamp)
    )
  );

  ipcMain.handle(
    "save-chat-attachment",
    safeHandler((event, { sessionId, name, mime, base64 }) => {
      if (!sessionId || !base64) throw new Error("附件参数不完整");
      const processed = processAttachmentImage(base64, mime);
      const id = crypto.randomUUID();
      const ext = extFromMime(processed.mime, name);
      const saved = storageService.saveAttachmentBuffer(sessionId, id, ext, processed.buffer);
      return {
        id,
        path: saved.path,
        width: processed.width,
        height: processed.height,
        size: saved.size,
        mime: processed.mime,
        name: name || `${id}.${ext}`,
      };
    })
  );

  ipcMain.handle(
    "delete-chat-attachment",
    safeHandler((event, filePath) => storageService.deleteAttachmentFile(filePath))
  );

  // --- Agent Inspector 监控与扩展 IPC ---
  ipcMain.handle(
    "get-mcp-servers",
    safeHandler((event, workDir) => storageService.getMcpServers(workDir))
  );

  ipcMain.handle(
    "save-mcp-servers",
    safeHandler((event, servers) => storageService.saveGlobalMcpServers(servers))
  );

  ipcMain.handle(
    "get-skills",
    safeHandler((event, workDir) => storageService.getSkills(workDir))
  );

  ipcMain.handle(
    "get-memories",
    safeHandler((event, workDir) => storageService.getMemories(workDir))
  );

  ipcMain.handle(
    "get-session-outputs",
    safeHandler((event, sessionId) => storageService.getSessionOutputs(sessionId))
  );

  ipcMain.handle(
    "get-context-metrics",
    safeHandler((event, params) => calculateContextMetrics(params))
  );

  ipcMain.handle(
    "get-workspace-git-status",
    safeHandler((event, workDir) => getWorkspaceGitStatus(workDir))
  );

  ipcMain.handle(
    "get-workspace-file-index",
    safeHandler((event, workDir) => {
      if (!workDir || typeof workDir !== "string") {
        return { files: [], source: "none", truncated: false };
      }
      const { allowedFolders } = getWorkspaceFolders(workDir);
      return listWorkspaceFiles(workDir, allowedFolders);
    })
  );

  ipcMain.handle(
    "get-recent-projects",
    safeHandler(() => storageService.getRecentProjects())
  );

  ipcMain.handle(
    "add-recent-project",
    safeHandler((event, proj) => storageService.addRecentProject(proj))
  );

  // --- 工具注册与执行 IPC ---
  ipcMain.handle(
    "get-tools",
    safeHandler(() => toolRegistry.getToolSummaries())
  );

  ipcMain.handle(
    "execute-tool",
    safeHandler(async (event, { name, args }) => {
      return await toolRegistry.execute(name, args, toolRegistry.getContext());
    })
  );

  // 基础系统通道
  ipcMain.on("show-in-folder", (event, filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    }
  });

  ipcMain.handle(
    "select-save-directory",
    safeHandler(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
        title: "选择保存目录",
      });
      if (result.canceled) return null;
      return result.filePaths[0] || null;
    })
  );

  ipcMain.handle(
    "api-get-models",
    safeHandler(async (event, params = {}) => {
      const globalCfg = getApiConfig();
      const activeBaseUrl = (params.baseUrl || globalCfg.baseUrl || "").trim().replace(/\/+$/, "");
      const activeApiKey = params.apiKey !== undefined ? params.apiKey.trim() : (globalCfg.apiKey || "").trim();

      if (!activeBaseUrl) {
        throw new Error("Base URL 不能为空");
      }

      const headers = {};
      if (activeApiKey) {
        headers["Authorization"] = `Bearer ${activeApiKey}`;
      }

      try {
        const fetchUrl = `${activeBaseUrl}/models`;
        const response = await fetch(fetchUrl, {
          headers,
          signal: AbortSignal.timeout(10000), // 10秒超时
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
        }

        const data = await response.json();
        // 兼容标准 OpenAI 格式 { data: [...] } 或纯数组
        if (Array.isArray(data.data)) {
          return data.data;
        } else if (Array.isArray(data)) {
          return data;
        } else if (Array.isArray(data.models)) { // Ollama 原生 /api/tags 兼容
          return data.models.map((m) => ({ id: m.name || m.model }));
        }
        return [];
      } catch (err) {
        console.error("[api-get-models] 拉取远程模型失败:", err.message);
        throw new Error(err.message || "连接失败");
      }
    })
  );

  // --- 人机协同授权响应通道 ---
  const pendingPermissions = new Map();
  ipcMain.on("chat-permission-response", (event, { id, allow }) => {
    const resolver = pendingPermissions.get(id);
    if (resolver) {
      pendingPermissions.delete(id);
      resolver(!!allow);
    }
  });

  // --- 流式聊天与 Agent 执行循环 ---
  ipcMain.on(
    "chat-request",
    async (event, { sessionId, messages, model, enableTools, workDir }) => {
      const { modelBaseUrl, modelApiKey, provider, apiModelId, contextLimit, supportsVision } =
        getModelConfig(model, "gpt-4o");

      if (!modelApiKey && provider !== "ollama") {
        event.reply(
          `chat-stream-error-${sessionId}`,
          "请先在【设置】中配置该模型的 API Key"
        );
        return;
      }

      // 获取当前会话的工作目录 (优先使用前端当前请求显式透传的选定目录)
      let sessionWorkDir = (workDir && typeof workDir === "string" && workDir.trim()) ? workDir.trim() : null;
      const session = storageService.getSessions().find((s) => s.id === sessionId);
      if (!sessionWorkDir) {
        sessionWorkDir = session?.work_dir || null;
      } else if (session && session.work_dir !== sessionWorkDir) {
        session.work_dir = sessionWorkDir;
        storageService.saveSession(session);
      }

      // 匹配当前会话的多目录工作空间 (含全部挂载源文件夹，用于多目录全量放行)
      const { matchedWorkspace, allowedFolders } = getWorkspaceFolders(sessionWorkDir);

      // 异步人机协同权限审批函数 (当识别到访问外部未选定路径时挂起循环并请求用户授权)
      const checkPermissionFn = async (targetPath, actionDesc) => {
        const reqId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        return new Promise((resolve) => {
          pendingPermissions.set(reqId, (allow) => {
            if (allow) {
              // 用户允许后，将该路径加入临时白名单
              allowedFolders.push(path.resolve(targetPath));
            }
            resolve(allow);
          });
          event.reply(`chat-permission-request-${sessionId}`, {
            id: reqId,
            path: targetPath,
            action: actionDesc,
            reason: "该路径位于当前已选定的工作空间源文件夹之外，请确认是否允许 Agent 访问该外部路径",
          });
        });
      };

      // 设置工具上下文 (严格锁定目标工作目录、全量多源文件夹白名单与人机授权检查器)
      toolRegistry.setContext("workDir", sessionWorkDir);
      toolRegistry.setContext("allowedFolders", allowedFolders);
      toolRegistry.setContext("checkPermission", checkPermissionFn);

      try {
        const headers = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        };
        if (modelApiKey) {
          headers["Authorization"] = `Bearer ${modelApiKey}`;
        }

        let apiMessages = [...messages];
        let compactionSummary = "";
        const compactionStats = { count: 0, beforeTokens: 0, afterTokens: 0 };
        let lastProviderUsage = null;
        let consecutiveCompactFailures = 0;
        let turnCompactionCount = 0;
        const compactCfg = {
          enabled: storageService.getConfig("context_auto_compact") !== "false",
          thresholdPercent: Number(storageService.getConfig("context_compact_threshold_percent")) || 85,
          keepTokens: Number(storageService.getConfig("context_compact_keep_tokens")) || 20000,
          toolResultMaxChars: Number(storageService.getConfig("context_tool_result_max_chars")) || 8000,
          keepRecentToolResults: Number(storageService.getConfig("context_microcompact_keep_results")) || 5,
          outputReserve: 4096,
          maxConsecutiveFailures: 3,
        };
        const availableSkills = storageService.getSkills(sessionWorkDir);
        const memories = storageService.getMemories(sessionWorkDir);

        const hasImageAttachments = apiMessages.some(
          (m) => Array.isArray(m.attachments) && m.attachments.length > 0
        );

        if (hasImageAttachments && !supportsVision) {
          event.reply(
            `chat-stream-error-${sessionId}`,
            "当前模型不支持图片输入，请切换到支持视觉的模型"
          );
          return;
        }

        if (hasImageAttachments) {
          const multimodal = buildMultimodalMessages(apiMessages);
          apiMessages = multimodal.messages;
          if (multimodal.imageCount > 0) {
            console.log(
              `[chat-image] resolved ${multimodal.imageCount} images, bytes=${multimodal.imageBytes}`
            );
          }
        }

        const memoryIndex = storageService.getMemoryIndex(sessionWorkDir);
        const projectRules = storageService.getProjectInstructions(sessionWorkDir);

        const initialTodos = [];

        // 自动装配用户通过 @ 显式引用的技能、MCP 与文件/目录上下文
        const mentionUserMsg = apiMessages.slice().reverse().find((m) => m.role === "user");
        const mentionText = extractTextContent(mentionUserMsg?.content);
        let mentionBlock = "";
        if (mentionText) {
          const mentionContext = buildMentionContext(mentionText, sessionWorkDir, allowedFolders, {
            skills: availableSkills,
            mcpServers: storageService.getMcpServers(sessionWorkDir),
          });
          if (mentionContext.block) {
            mentionBlock = mentionContext.block;
            console.log(
              `[mention] resolved ${mentionContext.skills.length} skills / ${mentionContext.mcps.length} mcps / ${mentionContext.files.length} files / ${mentionContext.dirs.length} dirs` +
                (mentionContext.skipped.length > 0 ? ` / skipped ${mentionContext.skipped.length}` : "")
            );
          }
        }

        const toolDocs = enableTools && toolRegistry.size > 0 ? toolRegistry.getToolPromptDocs() : [];

        const buildInstruction = () =>
          buildSystemContext({
            workDir: sessionWorkDir,
            matchedWorkspace,
            skills: availableSkills,
            memories,
            memoryIndex,
            projectRules,
            todos: initialTodos,
            toolDocs,
            model: `${provider}/${apiModelId}`,
            enableTools,
          });

        const buildInstructionText = (built) =>
          mentionBlock ? `${built.text}\n\n${mentionBlock}` : built.text;

        const composeSystemInstruction = (built) => {
          const base = buildInstructionText(built);
          return compactionSummary ? `${base}\n\n${compactionSummary}` : base;
        };

        const initialContext = buildInstruction();
        let systemInstruction = composeSystemInstruction(initialContext);
        console.log(
          `[context] ${initialContext.sections.map((section) => `${section.name}=${section.chars}`).join(" ")}`
        );

        const systemIndex = apiMessages.findIndex((m) => m.role === "system");
        const baseSystemContent = systemIndex >= 0 ? apiMessages[systemIndex].content || "" : "";
        if (systemIndex >= 0) {
          apiMessages[systemIndex].content = `${baseSystemContent}\n\n${systemInstruction}`;
        } else {
          apiMessages.unshift({ role: "system", content: systemInstruction });
        }

        const refreshSystemInstruction = () => {
          const rebuilt = buildInstruction();
          systemInstruction = composeSystemInstruction(rebuilt);
          const idx = apiMessages.findIndex((m) => m.role === "system");
          if (idx >= 0) {
            apiMessages[idx].content = baseSystemContent
              ? `${baseSystemContent}\n\n${systemInstruction}`
              : systemInstruction;
          }
        };

        const maybeCompact = async (reason = "preflight", options = {}) => {
          if (!compactCfg.enabled) return false;

          const thresholds = getThresholds(contextLimit, compactCfg);
          const nonSystemMessages = apiMessages.filter((message) => message.role !== "system");
          let tokens = estimateMessagesTokens(nonSystemMessages) + estimateTokens(systemInstruction);
          if (lastProviderUsage?.prompt_tokens) {
            tokens = Math.max(tokens, Number(lastProviderUsage.prompt_tokens) || 0);
          }

          const force = reason === "overflow" || options.force === true;
          if (!force && !shouldMicroCompact(tokens, thresholds)) return false;

          const micro = microCompact(apiMessages, compactCfg);
          if (micro.cleared > 0) {
            apiMessages = micro.messages;
            lastProviderUsage = null;
            console.log(`[microcompact] saved=${micro.saved} cleared=${micro.cleared}`);
            tokens =
              estimateMessagesTokens(apiMessages.filter((message) => message.role !== "system")) +
              estimateTokens(systemInstruction);
          }

          if (!force && tokens <= thresholds.threshold) return micro.cleared > 0;
          if (!force && turnCompactionCount >= 1) return false;

          try {
            const systemMessage = apiMessages.find((message) => message.role === "system");
            const result = await compactMessages({
              messages: apiMessages,
              systemMessage,
              thresholds,
              modelCfg: {
                baseUrl: modelBaseUrl,
                apiKey: modelApiKey,
                modelId: apiModelId,
                headers: { ...headers, Accept: "application/json" },
              },
              cfg: compactCfg,
            });

            if (!result.summaryBlock) {
              return false;
            }

            apiMessages = result.messages;
            compactionSummary = result.summaryBlock;
            refreshSystemInstruction();
            lastProviderUsage = null;
            compactionStats.count += 1;
            compactionStats.beforeTokens += result.before;
            compactionStats.afterTokens += result.after;
            consecutiveCompactFailures = 0;
            turnCompactionCount += 1;

            event.reply(`chat-stream-compaction-${sessionId}`, {
              beforeTokens: result.before,
              afterTokens: result.after,
              keptMessages: result.kept,
              summarizedMessages: result.summarized,
              at: Date.now(),
            });
            console.log(
              `[compact] before=${result.before} after=${result.after} kept=${result.kept} summarized=${result.summarized}`
            );
            return true;
          } catch (err) {
            consecutiveCompactFailures += 1;
            console.error(`[compact] failed (${consecutiveCompactFailures}):`, err.message);
            if (consecutiveCompactFailures >= compactCfg.maxConsecutiveFailures) {
              apiMessages = hardTruncate(apiMessages, thresholds.threshold);
              lastProviderUsage = null;
              console.log("[compact] fallback hardTruncate");
              return true;
            }
            return false;
          }
        };

        toolRegistry.setContext("onTodosUpdate", (nextTodos) => {
          if (!Array.isArray(nextTodos)) return;
          initialTodos.splice(0, initialTodos.length, ...nextTodos);
          event.reply(`chat-stream-todos-${sessionId}`, initialTodos);
          refreshSystemInstruction();
          console.log(`[context] todos updated: ${initialTodos.length}`);
        });

        const initialTools = enableTools ? toolRegistry.getToolDefinitions() : [];
        const initMetrics = calculateContextMetrics({
          messages: apiMessages,
          tools: initialTools,
          systemPrompt: systemInstruction,
          activeSkills: [],
          maxTokensLimit: contextLimit,
        });
        event.reply(`chat-stream-context-metrics-${sessionId}`, initMetrics);

        const MAX_TOOL_ROUNDS = Number(storageService.getConfig("max_tool_rounds")) || 5000;
        let toolRound = 0;
        let fullGeneratedText = "";
        const executedToolSteps = [];

        function sendData(delta) {
          fullGeneratedText += delta;
          event.reply(`chat-stream-data-${sessionId}`, delta);
        }

        async function doStreamRequest(requestMessages, requestBody) {
          const requestBodyFinal = {
            model: apiModelId,
            messages: requestMessages,
            stream: true,
            max_tokens: 4096,
            temperature: 0.2,
            ...requestBody,
          };

          const resp = await fetch(`${modelBaseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBodyFinal),
          });

          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`API 请求失败 (${resp.status}): ${errText}`);
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let fullContent = "";
          let toolCalls = [];
          let usage = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") continue;
              try {
                const json = JSON.parse(payload);
                if (json.usage) {
                  usage = json.usage;
                  lastProviderUsage = json.usage;
                }
                const choice = json.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta || {};

                if (delta.content) {
                  fullContent += delta.content;
                  sendData(delta.content);
                }

                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCalls[idx]) {
                      toolCalls[idx] = {
                        index: idx,
                        id: tc.id || "",
                        type: tc.type || "function",
                        function: { name: "", arguments: "" },
                      };
                    }
                    if (tc.id) toolCalls[idx].id = tc.id;
                    if (tc.type) toolCalls[idx].type = tc.type;
                    if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                    if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                  }
                }
              } catch (e) {
                // 忽略流中的 JSON 解析错误
              }
            }
          }

          return {
            content: fullContent,
            toolCalls: toolCalls.filter(Boolean),
            usage,
          };
        }

        // Agent 工具执行循环
        while (toolRound < MAX_TOOL_ROUNDS) {
          let requestBody = {};
          if (enableTools) {
            requestBody.tools = toolRegistry.getToolDefinitions();
            requestBody.tool_choice = "auto";
          }

          const result = await (async () => {
            await maybeCompact("preflight");
            try {
              return await doStreamRequest(apiMessages, requestBody);
            } catch (err) {
              if (!isContextOverflowError(err.message)) throw err;
              const compacted = await maybeCompact("overflow", { force: true });
              if (!compacted) throw err;
              return await doStreamRequest(apiMessages, requestBody);
            }
          })();

          if (!enableTools || result.toolCalls.length === 0) {
            break;
          }

          toolRound++;

          for (const tc of result.toolCalls) {
            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) {
              args = { _parseError: tc.function.arguments };
            }

            event.reply(`chat-stream-tool-status-${sessionId}`, {
              tool: tc.function.name,
              status: "running",
              args,
              callId: tc.id,
            });

            // 执行工具
            const execResult = await toolRegistry.execute(
              tc.function.name,
              args,
              toolRegistry.getContext()
            );

            // 若调用了 write_file 或 edit_file，将产出物挂载并通知前端刷新 Changes
            if ((tc.function.name === "write_file" || tc.function.name === "edit_file") && execResult?.success) {
              const fullOutPath = path.isAbsolute(args.path)
                ? args.path
                : path.join(sessionWorkDir || "", args.path);
              storageService.addSessionOutput(sessionId, {
                name: path.basename(args.path),
                filePath: fullOutPath,
                fileType: path.extname(args.path).replace(".", "") || "file",
              });
              // 通知前端刷新产物与 Git 变更
              event.reply(`session-outputs-updated-${sessionId}`);
            }

            executedToolSteps.push({
              tool: tc.function.name,
              status: "done",
              args,
              result: execResult,
              callId: tc.id,
            });

            event.reply(`chat-stream-tool-status-${sessionId}`, {
              tool: tc.function.name,
              status: "done",
              args,
              result: execResult,
              callId: tc.id,
            });

            apiMessages.push({
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                },
              ],
            });

            apiMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: truncateToolResult(JSON.stringify(execResult), compactCfg.toolResultMaxChars),
            });
          }

          // 每轮后更新 Context 计量
          const updatedMetrics = calculateContextMetrics({
            messages: apiMessages,
            tools: initialTools,
            systemPrompt: systemInstruction,
            activeSkills: [],
            maxTokensLimit: contextLimit,
          });
          event.reply(`chat-stream-context-metrics-${sessionId}`, updatedMetrics);
        }

        // 若大模型在工具调用结束后未给出最终文本回答，强制进行最终一轮总结输出
        if (!fullGeneratedText.trim() && toolRound > 0) {
          apiMessages.push({
            role: "user",
            content: "请基于以上工具执行获取到的全部信息、代码与事实，给出条理清晰、完整详尽的总结分析与答复。",
          });
          await maybeCompact("preflight");
          let finalResult;
          try {
            finalResult = await doStreamRequest(apiMessages, {});
          } catch (err) {
            if (!isContextOverflowError(err.message)) throw err;
            const compacted = await maybeCompact("overflow", { force: true });
            if (!compacted) throw err;
            finalResult = await doStreamRequest(apiMessages, {});
          }
          if (finalResult.content) {
            fullGeneratedText += finalResult.content;
          }
        }

        // 最终推送一次 Context
        const finalMetrics = calculateContextMetrics({
          messages: apiMessages,
          tools: initialTools,
          systemPrompt: systemInstruction,
          activeSkills: [],
          maxTokensLimit: contextLimit,
        });
        event.reply(`chat-stream-context-metrics-${sessionId}`, finalMetrics);

        // 结束时通知前端，由前端单源原子落盘 (消除主进程重复双写导致的消息被覆盖Bug)
        event.reply(`chat-stream-end-${sessionId}`, {
          content: fullGeneratedText,
          metadata: {
            toolRounds: toolRound,
            toolSteps: executedToolSteps,
            todos: initialTodos,
            compaction: {
              count: compactionStats.count,
              beforeTokens: compactionStats.beforeTokens,
              afterTokens: compactionStats.afterTokens,
            },
          },
        });

        // 旁路异步任务：首轮交互结束后提炼会话标题 (零阻塞，Fire-and-forget)
        try {
          const currentSession = storageService.getSessions().find((s) => s.id === sessionId);
          const shouldGenTitle =
            currentSession &&
            currentSession.title_source !== "custom" &&
            (!currentSession.title || currentSession.title.includes("新的") || currentSession.title_source === "default");

          if (shouldGenTitle) {
            const firstUserMsg = apiMessages.find((m) => m.role === "user");
            const firstUserText = extractTextContent(firstUserMsg?.content);
            if (firstUserText) {
              generateSessionTitleSidecar(sessionId, firstUserText, model, event.sender).catch(() => {});
            }
          }
        } catch (e) {
          // 忽略旁路任务触发异常
        }
      } catch (err) {
        console.error(`[chat-stream error ${sessionId}]`, err);
        event.reply(`chat-stream-error-${sessionId}`, err.message);
      }
    }
  );

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
