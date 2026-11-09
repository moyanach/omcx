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
const { initAutoUpdater } = require("./services/updaterService");
const {
  getWorkspaceGitStatus,
  getWorkspaceFileDiff,
  commitWorkspaceChanges,
} = require("./services/workspaceGitService");
const { calculateContextMetrics, estimateTokens } = require("./services/contextCalculator");
const { toolRegistry } = require("./utils/toolRegistry");
const { performWebSearch, scrapePageContent } = require("./utils/tools/webTools");
const { listWorkspaceFiles } = require("./utils/tools/fileIndexer");
const { buildMentionContext } = require("./utils/tools/mentionResolver");
const { isUnderFolder, isBuiltinTrustedPath, DEFAULT_ROOT } = require("./utils/tools/pathResolver");
const { buildSystemContext, getGitSnapshotAsync } = require("./utils/contextBuilder");
const { mcpClientService } = require("./services/mcpClientService");
const subagentService = require("./services/subagentService");
const {
  PERMISSION_MODES,
  normalizePermissionMode,
  checkSensitivePath,
  buildSanitizedShellEnv,
} = require("./services/sandboxPolicyService");
const { spawn } = require("child_process");
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

const TEXT_LIKE_EXTS = new Set([
  "md", "markdown", "txt", "text", "log", "json", "json5", "jsonl",
  "yaml", "yml", "toml", "xml", "html", "htm", "css", "scss", "less",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "pyw", "java", "go", "rs", "c", "h", "cpp", "hpp", "cc", "cxx",
  "cs", "php", "rb", "swift", "kt", "kts", "dart", "scala",
  "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1",
  "sql", "env", "ini", "conf", "config", "dockerfile", "makefile", "gemfile"
]);

const SPREADSHEET_EXTS = new Set(["xlsx", "xls", "csv", "tsv", "parquet"]);
const DOCUMENT_EXTS = new Set(["pdf", "docx", "doc", "pptx", "ppt", "epub", "rtf", "odt"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"]);

function getAttachmentExtension(filename) {
  const parts = String(filename || "").split(".");
  return parts.length > 1 ? (parts.pop() || "").toLowerCase() : "";
}

function isImageFile(att) {
  const ext = getAttachmentExtension(att?.name || att?.path);
  const mime = String(att?.mime || "").toLowerCase();
  return (
    mime.startsWith("image/") ||
    IMAGE_MIME_EXT[mime] !== undefined ||
    ["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "svg"].includes(ext)
  );
}

function isTextLikeFile(filename, mime) {
  const ext = getAttachmentExtension(filename);
  const lowerMime = String(mime || "").toLowerCase();
  return (
    TEXT_LIKE_EXTS.has(ext) ||
    lowerMime.startsWith("text/") ||
    lowerMime.includes("json") ||
    lowerMime.includes("javascript")
  );
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildAttachmentMessages(messages) {
  const withImages = [];
  messages.forEach((msg, index) => {
    if (msg.role === "user" && Array.isArray(msg.attachments) && msg.attachments.some(isImageFile)) {
      withImages.push(index);
    }
  });
  const injectImageIndexes = new Set(withImages.slice(-2));

  let imageCount = 0;
  let textAttachmentCount = 0;
  let binaryAttachmentCount = 0;

  const result = messages.map((msg, index) => {
    if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) return msg;

    let baseText = extractTextContent(msg.content);
    const images = [];
    const inlinedSections = [];

    for (const attachment of msg.attachments) {
      if (!attachment || !attachment.path || !fs.existsSync(attachment.path)) continue;

      // 通路 1: 图像多模态流
      if (isImageFile(attachment)) {
        if (!injectImageIndexes.has(index)) {
          baseText = baseText.replace(attachment.placeholder || "", `[图片已省略]`);
          continue;
        }
        const encoded = encodeAttachmentForModel(attachment);
        if (encoded) {
          images.push({
            type: "image_url",
            image_url: { url: `data:${encoded.mime};base64,${encoded.base64}` },
          });
          imageCount += 1;
        }
        continue;
      }

      // 通路 2: 文本轻量内联流 (代码、文档、配置等)
      if (isTextLikeFile(attachment.name, attachment.mime)) {
        try {
          let text = fs.readFileSync(attachment.path, "utf-8");
          let truncated = false;
          if (text.length > 80000) {
            text = text.slice(0, 80000);
            truncated = true;
          }
          const ext = getAttachmentExtension(attachment.name);
          const lang = ext || "text";
          inlinedSections.push(
            `### 用户上传的文本附件: ${attachment.name}\n\`\`\`${lang}\n${text}\n\`\`\`${
              truncated ? "\n[该文件超过 80,000 字符，已做安全截断]" : ""
            }`
          );
          textAttachmentCount += 1;
        } catch (e) {
          inlinedSections.push(`### 用户上传的文本附件: ${attachment.name} (读取失败: ${e.message})`);
        }
        continue;
      }

      // 通路 3: 复杂表格、文档与二进制数据流 (注入绝对路径与工具指引)
      const ext = getAttachmentExtension(attachment.name);
      let guide = "该文件已保存在上述本地路径。请根据需要，调用相应工具或通过 run_command 运行脚本读取和分析该文件。";
      if (SPREADSHEET_EXTS.has(ext)) {
        guide = "该文件为结构化表格数据，已保存在上述本地绝对路径。请优先通过 run_command 运行 Python 脚本 (如 python3 -c 'import pandas as pd...') 读取工作表内容并开展统计与分析。";
      } else if (DOCUMENT_EXTS.has(ext)) {
        guide = "该文件为办公排版文档，已保存在上述本地绝对路径。请根据任务需要，通过 run_command 调用对应解析脚本读取和提取正文。";
      } else if (ARCHIVE_EXTS.has(ext)) {
        guide = "该文件为压缩归档包，已保存在上述本地绝对路径。如需查看内容，可通过 run_command 执行 unzip/tar 查看文件列表或解压提取。";
      }

      inlinedSections.push(
        [
          `### 用户上传的文件附件: ${attachment.name}`,
          `- 本地存储绝对路径: ${attachment.path}`,
          `- 文件大小: ${formatBytes(attachment.size)}`,
          `- 格式扩展名: .${ext || "bin"}`,
          `【系统指引】${guide}`,
        ].join("\n")
      );
      binaryAttachmentCount += 1;
    }

    let finalPrompt = baseText;
    if (inlinedSections.length > 0) {
      finalPrompt = `${finalPrompt}\n\n【用户上传的文件附件内容与路径指引】:\n${inlinedSections.join("\n\n")}`;
    }

    if (images.length === 0) {
      return { role: msg.role, content: finalPrompt };
    }

    return {
      role: msg.role,
      content: [{ type: "text", text: finalPrompt || "请查看以下附件与图片。" }, ...images],
    };
  });

  return { messages: result, imageCount, textAttachmentCount, binaryAttachmentCount };
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
 * 根据大模型厂商与模型特征指纹，安全注入 5 档推理强度参数
 * 档位: "off" | "low" | "medium" | "high" | "max"
 */
function buildReasoningPayload(apiModelId, provider, reasoningEffort) {
  if (!reasoningEffort || reasoningEffort === "off") {
    return { payload: {}, isThinkingModel: false };
  }

  const modelLower = String(apiModelId || "").toLowerCase();
  const providerLower = String(provider || "").toLowerCase();

  // 1. OpenAI o系列与原生支持 reasoning_effort 的推理模型 (o1, o3, o3-mini, o4 等)
  const isOpenAIReasoning =
    /\b(o1|o3|o4)\b/i.test(modelLower) ||
    modelLower.includes("o1-") ||
    modelLower.includes("o3-") ||
    modelLower.includes("o4-") ||
    modelLower.includes("reasoning");

  if (isOpenAIReasoning) {
    const effortMap = {
      low: "low",
      medium: "medium",
      high: "high",
      max: "high",
    };
    const mapped = effortMap[reasoningEffort] || "medium";
    const payload = { reasoning_effort: mapped };
    if (reasoningEffort === "max") {
      payload.max_completion_tokens = 25000;
    }
    return { payload, isThinkingModel: true };
  }

  // 2. Anthropic Claude 3.7+ 思考模型规范 (claude-3-7-sonnet, claude-4 等)
  const isClaudeThinking =
    (providerLower === "anthropic" || modelLower.includes("claude")) &&
    (modelLower.includes("3-7") || modelLower.includes("3.7") || modelLower.includes("claude-4") || modelLower.includes("thinking"));

  if (isClaudeThinking) {
    const budgetMap = {
      low: 2048,
      medium: 4096,
      high: 8192,
      max: 16384,
    };
    const budget = budgetMap[reasoningEffort] || 4096;
    return {
      payload: {
        thinking: {
          type: "enabled",
          budget_tokens: budget,
        },
        temperature: 1.0,
      },
      isThinkingModel: true,
    };
  }

  // 3. Google Gemini 思考模型 (gemini-2.0-flash-thinking, gemini-3.8-flash-high 等)
  const isGeminiThinking =
    modelLower.includes("gemini") &&
    (modelLower.includes("thinking") || modelLower.includes("flash") || modelLower.includes("high") || modelLower.includes("pro"));

  if (isGeminiThinking) {
    const geminiEffortMap = {
      low: "low",
      medium: "medium",
      high: "high",
      max: "high",
    };
    const geminiBudgetMap = {
      low: 2048,
      medium: 4096,
      high: 8192,
      max: 16384,
    };
    return {
      payload: {
        reasoning_effort: geminiEffortMap[reasoningEffort] || "medium",
        thinking_budget: geminiBudgetMap[reasoningEffort] || 4096,
      },
      isThinkingModel: true,
    };
  }

  // 4. 显式开源推理模型 (DeepSeek-R1 / QwQ 等)
  const isGenericReasoning =
    modelLower.includes("r1") ||
    modelLower.includes("reasoner") ||
    modelLower.includes("qwq") ||
    modelLower.includes("deepseek-r1");

  if (isGenericReasoning) {
    return {
      payload: {
        reasoning_effort: reasoningEffort === "max" ? "high" : reasoningEffort,
        reasoning: {
          effort: reasoningEffort === "max" ? "high" : reasoningEffort,
        },
      },
      isThinkingModel: true,
    };
  }

  // 5. 其它明确带 thinking / reason 的模型
  if (modelLower.includes("thinking") || modelLower.includes("reason")) {
    return {
      payload: {
        reasoning_effort: reasoningEffort === "max" ? "high" : reasoningEffort,
      },
      isThinkingModel: true,
    };
  }

  // 6. 普通纯聊天模型 (gpt-4o, claude-3-5, qwen2.5 等)：坚决不注入未知的 reasoning_effort 字段
  return { payload: {}, isThinkingModel: false };
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

  // 3.2 注册特权协议（带严格目录边界与路径穿越防御）
  const DIST_ROOT = path.resolve(__dirname, "dist");

  function isAllowedLocalMediaPath(targetPath) {
    const resolved = path.resolve(targetPath);
    if (checkSensitivePath(resolved).blocked) {
      return false;
    }
    // 1. 允许访问会话附件目录 (~/.omcx/sessions/<id>/attachments/*)
    if (storageService.isSessionAttachmentPath(resolved)) {
      return true;
    }
    // 2. 排除 .env 等敏感配置文件
    const baseName = path.basename(resolved).toLowerCase();
    if (
      baseName === ".env" ||
      baseName.startsWith(".env.") ||
      resolved.includes(`${path.sep}.omcx${path.sep}config.json`)
    ) {
      return false;
    }
    const wallpaperDir = path.join(os.homedir(), ".omcx", "wallpaper");
    const allowedRoots = new Set([DEFAULT_ROOT, wallpaperDir]);
    for (const ws of storageService.getWorkspaces()) {
      if (Array.isArray(ws.folders)) {
        for (const f of ws.folders) {
          if (f?.path) allowedRoots.add(path.resolve(f.path));
        }
      }
    }
    for (const sess of storageService.getSessions()) {
      if (sess?.work_dir) allowedRoots.add(path.resolve(sess.work_dir));
      const outputs = storageService.getSessionOutputs(sess.id) || [];
      for (const out of outputs) {
        if (out?.filePath) {
          allowedRoots.add(path.resolve(path.dirname(out.filePath)));
        }
      }
    }
    for (const root of allowedRoots) {
      if (isUnderFolder(resolved, root)) return true;
    }
    return false;
  }

  protocol.handle("local-media", async (request) => {
    try {
      let filePath = "";
      try {
        const parsedUrl = new URL(request.url);
        if (parsedUrl.hostname === "local") {
          filePath = decodeURIComponent(parsedUrl.pathname);
        } else if (parsedUrl.hostname) {
          filePath = `/${parsedUrl.hostname}${decodeURIComponent(parsedUrl.pathname)}`;
        } else {
          filePath = decodeURIComponent(parsedUrl.pathname);
        }
      } catch {
        filePath = request.url;
        if (filePath.startsWith("local-media://")) {
          filePath = filePath.slice("local-media://".length);
        }
        const queryIndex = filePath.indexOf("?");
        if (queryIndex !== -1) filePath = filePath.substring(0, queryIndex);
        const hashIndex = filePath.indexOf("#");
        if (hashIndex !== -1) filePath = filePath.substring(0, hashIndex);
        filePath = decodeURIComponent(filePath);
        if (filePath.startsWith("local/")) {
          filePath = filePath.slice("local".length);
        }
      }

      if (process.platform === "win32") {
        if (filePath.startsWith("/")) filePath = filePath.slice(1);
        filePath = filePath.replace(/\//g, "\\");
      } else {
        if (!filePath.startsWith("/")) filePath = "/" + filePath;
      }

      let resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath) && resolvedPath.startsWith("/users/")) {
        const capitalUsers = "/Users/" + resolvedPath.slice("/users/".length);
        if (fs.existsSync(capitalUsers)) {
          resolvedPath = capitalUsers;
        }
      }

      if (!isAllowedLocalMediaPath(resolvedPath)) {
        console.warn(`[protocol:local-media] 拦截越界访问请求: ${resolvedPath}`);
        return new Response("Forbidden", { status: 403 });
      }

      const fileUrl = pathToFileURL(resolvedPath).toString();
      const response = await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true });
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      const lower = resolvedPath.toLowerCase();
      if (lower.endsWith(".html") || lower.endsWith(".htm")) {
        headers.set("Content-Type", "text/html; charset=utf-8");
      } else if (lower.endsWith(".svg")) {
        headers.set("Content-Type", "image/svg+xml");
      } else if (lower.endsWith(".css")) {
        headers.set("Content-Type", "text/css; charset=utf-8");
      } else if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
        headers.set("Content-Type", "text/javascript; charset=utf-8");
      } else if (lower.endsWith(".json")) {
        headers.set("Content-Type", "application/json; charset=utf-8");
      }

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

      // 统一将 app:// 静态资源锁定在 DIST_ROOT 内，防止 ../ 路径穿越读取主进程或系统文件
      let filePath = path.resolve(DIST_ROOT, relativePath);
      if (!isUnderFolder(filePath, DIST_ROOT)) {
        console.warn(`[protocol:app] 拦截路径穿越请求: ${request.url}`);
        return new Response("Forbidden", { status: 403 });
      }

      // 若请求目录或不存在，默认返回 dist/index.html
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          filePath = path.join(DIST_ROOT, "index.html");
        }
      } catch {
        filePath = path.join(DIST_ROOT, "index.html");
      }

      const buffer = await fs.promises.readFile(filePath);
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
      } else if (filePath.endsWith(".woff2")) {
        headers.set("Content-Type", "font/woff2");
      } else if (filePath.endsWith(".woff")) {
        headers.set("Content-Type", "font/woff");
      } else if (filePath.endsWith(".ttf")) {
        headers.set("Content-Type", "font/ttf");
      } else if (filePath.endsWith(".json")) {
        headers.set("Content-Type", "application/json; charset=utf-8");
      }

      return new Response(buffer, { status: 200, headers });
    } catch (err) {
      console.error("[protocol:app error]", err);
      try {
        const fallback = await fs.promises.readFile(path.join(__dirname, "dist", "index.html"));
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
    "db-update-session-workspace",
    safeHandler((event, { id, workspaceId, workDir }) => {
      return storageService.updateSessionWorkspace(id, workspaceId, workDir);
    })
  );

  ipcMain.handle(
    "db-update-session-reasoning-effort",
    safeHandler((event, { id, reasoningEffort }) => {
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.reasoning_effort = reasoningEffort || "off";
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
    "db-update-session-permission-mode",
    safeHandler((event, { id, permissionMode }) => {
      const normalized = normalizePermissionMode(permissionMode);
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.permission_mode = normalized;
        storageService.saveSession(session);
      }
      const active = activeStreamSessions.get(id);
      if (active && active.toolContext) {
        active.toolContext.permissionMode = normalized;
      }
      return { success: true, permissionMode: normalized };
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
      const cleanName = name || "attachment";
      const isImg = isImageFile({ name: cleanName, mime });

      if (isImg) {
        const processed = processAttachmentImage(base64, mime);
        const id = crypto.randomUUID();
        const ext = extFromMime(processed.mime, cleanName);
        const saved = storageService.saveAttachmentBuffer(sessionId, id, ext, processed.buffer);
        return {
          id,
          path: saved.path,
          width: processed.width,
          height: processed.height,
          size: saved.size,
          mime: processed.mime,
          name: cleanName,
        };
      }

      // 非图片文件（代码、文本、表格、PDF、压缩包等）原样无损落盘
      const buffer = Buffer.from(base64, "base64");
      const id = crypto.randomUUID();
      const ext = getAttachmentExtension(cleanName) || "bin";
      const saved = storageService.saveAttachmentBuffer(sessionId, id, ext, buffer);
      return {
        id,
        path: saved.path,
        size: saved.size,
        mime: mime || "application/octet-stream",
        name: cleanName,
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
    safeHandler((event, servers) => {
      const saved = storageService.saveGlobalMcpServers(servers);
      mcpClientService.reloadClients();
      return saved;
    })
  );

  ipcMain.handle(
    "get-skills",
    safeHandler((event, workDir) => storageService.getSkills(workDir))
  );

  ipcMain.handle(
    "get-subagents",
    safeHandler((event, workDir) => subagentService.discoverSubagents(workDir || null))
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
    "workspace-git-diff",
    safeHandler((event, { workDir, filePath }) => getWorkspaceFileDiff(workDir, filePath))
  );

  ipcMain.handle(
    "workspace-git-commit",
    safeHandler((event, { workDir, message }) => commitWorkspaceChanges(workDir, message))
  );

  ipcMain.handle(
    "workspace-list-dir",
    safeHandler((event, { workDir, dirPath = "." } = {}) => {
      const baseRoot = workDir && String(workDir).trim() ? path.resolve(workDir.trim()) : DEFAULT_ROOT;
      const { matchedWorkspace, allowedFolders } = getWorkspaceFolders(baseRoot);
      const validFolders = allowedFolders.length > 0 ? allowedFolders : [baseRoot];

      const targetAbs = path.isAbsolute(dirPath)
        ? path.resolve(dirPath)
        : path.resolve(baseRoot, dirPath || ".");

      const isAllowed = validFolders.some((root) => isUnderFolder(targetAbs, root));
      if (!isAllowed || checkSensitivePath(targetAbs).blocked) {
        return { success: false, error: "无权访问该目录", entries: [] };
      }
      if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isDirectory()) {
        return { success: false, error: "目录不存在", entries: [] };
      }

      const skipNames = new Set([".DS_Store", ".git", "node_modules"]);
      const rawItems = fs.readdirSync(targetAbs, { withFileTypes: true });
      const entries = [];

      for (const item of rawItems) {
        if (skipNames.has(item.name)) continue;
        if (item.name === ".env" || item.name.startsWith(".env.")) continue;
        const fullPath = path.join(targetAbs, item.name);
        if (checkSensitivePath(fullPath).blocked) continue;
        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        const isDir = stat.isDirectory();
        const relPath = path.relative(baseRoot, fullPath).replace(/\\/g, "/");
        entries.push({
          name: item.name,
          path: relPath && !relPath.startsWith("..") ? relPath : fullPath,
          absPath: fullPath,
          isDir,
          size: isDir ? 0 : stat.size,
          ext: isDir ? "" : path.extname(item.name).replace(".", "").toLowerCase(),
          mtimeMs: stat.mtimeMs,
        });
      }

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const workspaceRoots = (
        matchedWorkspace?.folders?.length
          ? matchedWorkspace.folders.map((f) => ({
              name: f.name || path.basename(f.path),
              path: path.resolve(f.path),
              isPrimary: !!f.isPrimary,
            }))
          : [{ name: path.basename(baseRoot), path: baseRoot, isPrimary: true }]
      ).filter((f) => fs.existsSync(f.path));

      return {
        success: true,
        workDir: baseRoot,
        currentDir: targetAbs,
        roots: workspaceRoots,
        entries,
      };
    })
  );

  ipcMain.handle(
    "workspace-read-file",
    safeHandler((event, { workDir, filePath, maxChars = 250000 } = {}) => {
      if (!filePath) return { success: false, error: "文件路径为空" };
      const baseRoot = workDir && String(workDir).trim() ? path.resolve(workDir.trim()) : DEFAULT_ROOT;
      const { allowedFolders } = getWorkspaceFolders(baseRoot);
      const validFolders = allowedFolders.length > 0 ? allowedFolders : [baseRoot];

      let targetAbs = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(baseRoot, filePath);

      if (!fs.existsSync(targetAbs)) {
        // 尝试在其他挂载源目录中匹配
        for (const folder of validFolders) {
          const candidate = path.resolve(folder, filePath);
          if (fs.existsSync(candidate)) {
            targetAbs = candidate;
            break;
          }
        }
      }

      if (checkSensitivePath(targetAbs).blocked) {
        return { success: false, error: "安全策略已禁止读取该敏感文件" };
      }
      const baseName = path.basename(targetAbs).toLowerCase();
      if (baseName === ".env" || baseName.startsWith(".env.")) {
        return { success: false, error: "出于安全保护，不直接展示 .env 密钥文件" };
      }
      if (!fs.existsSync(targetAbs)) {
        return { success: false, error: `文件不存在: ${filePath}` };
      }

      const stat = fs.statSync(targetAbs);
      if (!stat.isFile()) {
        return { success: false, error: `目标路径不是文件: ${filePath}` };
      }

      const readBytes = Math.min(stat.size, maxChars * 4);
      const fd = fs.openSync(targetAbs, "r");
      let buf;
      try {
        buf = Buffer.alloc(readBytes);
        const bytesRead = fs.readSync(fd, buf, 0, readBytes, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }

      const ext = path.extname(targetAbs).replace(".", "").toLowerCase();
      const isBinary = buf.subarray(0, 4096).includes(0);
      if (isBinary) {
        return {
          success: true,
          path: filePath,
          absPath: targetAbs,
          name: path.basename(targetAbs),
          ext,
          size: stat.size,
          isBinary: true,
          content: "",
          totalLines: 0,
          truncated: false,
        };
      }

      let content = buf.toString("utf-8");
      let truncated = stat.size > readBytes;
      if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        truncated = true;
      }
      const totalLines = content.split("\n").length;

      return {
        success: true,
        path: filePath,
        absPath: targetAbs,
        name: path.basename(targetAbs),
        ext,
        size: stat.size,
        isBinary: false,
        content,
        totalLines,
        truncated,
      };
    })
  );

  // --- 工作台交互式集成终端进程管理 ---
  const activeTerminalProcs = new Map();

  ipcMain.handle(
    "terminal-kill-command",
    safeHandler((event, cmdId) => {
      const proc = activeTerminalProcs.get(cmdId);
      if (proc && proc.pid) {
        try {
          if (process.platform !== "win32") {
            process.kill(-proc.pid, "SIGKILL");
          } else {
            proc.kill("SIGKILL");
          }
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
        activeTerminalProcs.delete(cmdId);
        return { success: true };
      }
      return { success: false };
    })
  );

  ipcMain.handle(
    "terminal-run-command",
    safeHandler(async (event, { cmdId, command, cwd, workDir }) => {
      const rawCmd = String(command || "").trim();
      const baseCwd =
        cwd && fs.existsSync(cwd)
          ? path.resolve(cwd)
          : workDir && fs.existsSync(workDir)
          ? path.resolve(workDir)
          : DEFAULT_ROOT;

      if (!rawCmd) {
        return { success: true, exitCode: 0, stdout: "", stderr: "", cwd: baseCwd };
      }

      // 原生支持 cd <dir> 切换终端当前工作目录
      const cdMatch = rawCmd.match(/^cd(?:\s+(.+))?$/);
      if (cdMatch) {
        const targetRaw = (cdMatch[1] || "").trim().replace(/^["']|["']$/g, "");
        const nextDir = !targetRaw || targetRaw === "~"
          ? os.homedir()
          : targetRaw.startsWith("~/")
          ? path.join(os.homedir(), targetRaw.slice(2))
          : path.resolve(baseCwd, targetRaw);
        if (fs.existsSync(nextDir) && fs.statSync(nextDir).isDirectory()) {
          return {
            success: true,
            exitCode: 0,
            stdout: `已切换工作目录至: ${nextDir}\n`,
            stderr: "",
            cwd: nextDir,
          };
        }
        return {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: `cd: 目录不存在: ${targetRaw}\n`,
          cwd: baseCwd,
        };
      }

      const id = cmdId || `term_${Date.now()}`;
      const userShell = process.env.SHELL || "/bin/zsh";
      const env = buildSanitizedShellEnv(process.env, { stripSecrets: false });

      return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;

        let child;
        try {
          child = spawn(userShell, ["-c", rawCmd], {
            cwd: baseCwd,
            env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err) {
          return resolve({
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: err.message || String(err),
            cwd: baseCwd,
          });
        }

        activeTerminalProcs.set(id, child);

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          activeTerminalProcs.delete(id);
          resolve(payload);
        };

        const timer = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
          finish({
            success: false,
            exitCode: -1,
            stdout,
            stderr: `${stderr}\n[终端命令执行超过 120s 已自动终止]`,
            cwd: baseCwd,
          });
        }, 120000);

        child.stdout?.on("data", (chunk) => {
          const text = chunk.toString("utf-8");
          if (stdout.length < 200000) stdout += text;
          try {
            event.sender.send(`terminal-stream-${id}`, { type: "stdout", data: text });
          } catch {}
        });

        child.stderr?.on("data", (chunk) => {
          const text = chunk.toString("utf-8");
          if (stderr.length < 100000) stderr += text;
          try {
            event.sender.send(`terminal-stream-${id}`, { type: "stderr", data: text });
          } catch {}
        });

        child.on("error", (err) => {
          finish({
            success: false,
            exitCode: -1,
            stdout,
            stderr: `${stderr}\n${err.message}`,
            cwd: baseCwd,
          });
        });

        child.on("close", (code, signal) => {
          const exitCode = typeof code === "number" ? code : signal ? -1 : 0;
          finish({
            success: exitCode === 0,
            exitCode,
            stdout,
            stderr,
            cwd: baseCwd,
          });
        });
      });
    })
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

  ipcMain.on("open-external-url", (event, targetUrl) => {
    if (typeof targetUrl === "string" && /^https?:\/\//i.test(targetUrl.trim())) {
      shell.openExternal(targetUrl.trim());
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
    "select-background-image",
    safeHandler(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile"],
        title: "选择主题背景图片",
        filters: [
          {
            name: "图片文件",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"],
          },
        ],
      });
      if (result.canceled || !result.filePaths?.[0]) return null;

      const srcPath = result.filePaths[0];
      const wallpaperDir = path.join(os.homedir(), ".omcx", "wallpaper");
      if (!fs.existsSync(wallpaperDir)) {
        fs.mkdirSync(wallpaperDir, { recursive: true });
      }
      // 清理旧壁纸缓存文件
      try {
        for (const f of fs.readdirSync(wallpaperDir)) {
          try {
            fs.unlinkSync(path.join(wallpaperDir, f));
          } catch {}
        }
      } catch {}

      const ext = path.extname(srcPath).toLowerCase() || ".png";
      const destPath = path.join(wallpaperDir, `wallpaper_${Date.now()}${ext}`);
      fs.copyFileSync(srcPath, destPath);
      return `local-media://local${encodeURI(destPath)}`;
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
  ipcMain.on("chat-permission-response", (event, { id, allow, decision }) => {
    const resolver = pendingPermissions.get(id);
    if (resolver) {
      pendingPermissions.delete(id);
      resolver({
        allow: !!allow,
        decision: decision || (allow ? "allow_once" : "deny"),
      });
    }
  });

  // --- 活动流式会话中断与取消管理器 ---
  const activeStreamSessions = new Map();
  ipcMain.on("chat-cancel", (event, sessionId) => {
    const active = activeStreamSessions.get(sessionId);
    if (active) {
      active.cancelled = true;
      try {
        active.abortController.abort();
      } catch (e) {
        // 忽略中断异常
      }
      console.log(`[chat-cancel] session ${sessionId} cancellation requested`);
    }
  });

  // --- 流式聊天与 Agent 执行循环 ---
  ipcMain.on(
    "chat-request",
    async (event, { sessionId, messages, model, enableTools, workDir, permissionMode, reasoningEffort }) => {
      const { modelBaseUrl, modelApiKey, provider, apiModelId, contextLimit, supportsVision } =
        getModelConfig(model, "gpt-4o");

      if (!modelApiKey && provider !== "ollama") {
        event.reply(
          `chat-stream-error-${sessionId}`,
          "请先在【设置】中配置该模型的 API Key"
        );
        return;
      }

      // 获取当前会话的工作目录与权限模式 (优先使用前端当前请求显式透传的值)
      let sessionWorkDir = (workDir && typeof workDir === "string" && workDir.trim()) ? workDir.trim() : null;
      const session = storageService.getSessions().find((s) => s.id === sessionId);
      if (!sessionWorkDir) {
        sessionWorkDir = session?.work_dir || null;
      }

      const sessionReasoningEffort =
        reasoningEffort ||
        session?.reasoning_effort ||
        session?.reasoningEffort ||
        "medium";

      const resolvedPermissionMode = normalizePermissionMode(
        permissionMode ||
          session?.permission_mode ||
          session?.permissionMode ||
          storageService.getConfig("default_permission_mode") ||
          PERMISSION_MODES.AUTO_SANDBOX
      );

      if (
        session &&
        (session.work_dir !== sessionWorkDir ||
          session.permission_mode !== resolvedPermissionMode ||
          (reasoningEffort && session.reasoning_effort !== reasoningEffort))
      ) {
        session.work_dir = sessionWorkDir;
        session.permission_mode = resolvedPermissionMode;
        if (reasoningEffort) {
          session.reasoning_effort = reasoningEffort;
        }
        storageService.saveSession(session);
      }

      // 匹配当前会话的多目录工作空间 (严格区分可写工作区目录 writableFolders 与可读目录 allowedFolders)
      const { matchedWorkspace, allowedFolders: workspaceFolders } = getWorkspaceFolders(sessionWorkDir);
      const writableFolders = [...workspaceFolders];
      const allowedFolders = [...workspaceFolders];

      // 注册当前会话的中断控制器与流式状态（声明在 try 外部，便于 catch/finally 安全访问）
      const sessionAbort = {
        abortController: new AbortController(),
        cancelled: false,
        toolContext: null,
      };
      activeStreamSessions.set(sessionId, sessionAbort);

      // 异步人机协同权限审批函数（支持外部路径、受保护文件、询问模式确认、高危命令、沙箱逃生重跑 5 类场景）
      const checkPermissionFn = async (targetPath, actionDesc, meta = {}) => {
        const kind = meta?.kind || "external_path";
        if (
          kind === "external_path" &&
          actionDesc === "读取" &&
          isBuiltinTrustedPath(targetPath, sessionId)
        ) {
          return true;
        }
        const reqId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        return new Promise((resolve) => {
          pendingPermissions.set(reqId, (resp) => {
            const allow = typeof resp === "object" ? !!resp.allow : !!resp;
            const decision =
              typeof resp === "object" && resp.decision
                ? resp.decision
                : allow
                ? "allow_once"
                : "deny";

            if (allow) {
              if (decision === "allow_session" && kind === "external_path" && targetPath) {
                const resolvedTarget = path.resolve(targetPath);
                const folderToTrust =
                  fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()
                    ? resolvedTarget
                    : path.dirname(resolvedTarget);
                if (!allowedFolders.includes(folderToTrust)) {
                  allowedFolders.push(folderToTrust);
                }
                if (actionDesc !== "读取" && actionDesc !== "浏览目录") {
                  if (!writableFolders.includes(folderToTrust)) {
                    writableFolders.push(folderToTrust);
                  }
                }
              } else if (decision === "switch_auto_sandbox") {
                if (sessionAbort.toolContext) {
                  sessionAbort.toolContext.permissionMode = PERMISSION_MODES.AUTO_SANDBOX;
                }
                const targetSess = storageService.getSessions().find((s) => s.id === sessionId);
                if (targetSess) {
                  targetSess.permission_mode = PERMISSION_MODES.AUTO_SANDBOX;
                  storageService.saveSession(targetSess);
                }
                event.reply("session-permission-mode-updated", {
                  sessionId,
                  permissionMode: PERMISSION_MODES.AUTO_SANDBOX,
                });
              }
            }
            resolve(allow);
          });
          event.reply(`chat-permission-request-${sessionId}`, {
            id: reqId,
            path: targetPath,
            action: actionDesc,
            kind,
            command: meta?.command || undefined,
            allowSwitchAutoSandbox: Boolean(meta?.allowSwitchAutoSandbox),
            reason:
              meta?.reason ||
              "该路径位于当前已选定的工作空间源文件夹之外，请确认是否允许 Agent 访问该外部路径",
          });
        });
      };

      const initialTodos = [];
      let fullGeneratedText = "";
      let toolRound = 0;
      const executedToolSteps = [];

      // 会话级隔离工具上下文（杜绝并发会话串台覆盖全局单例，并挂载中断信号与沙箱权限模式）
      const sessionToolContext = {
        sessionId,
        workDir: sessionWorkDir,
        allowedFolders,
        writableFolders,
        permissionMode: resolvedPermissionMode,
        checkPermission: checkPermissionFn,
        onTodosUpdate: null,
        abortSignal: sessionAbort.abortController.signal,
        sessionAbort,
        modelConfig: {
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
          provider,
          modelName: apiModelId,
        },
        mcpTools: [],
        onFileOutput: (filePath) => {
          if (!filePath) return;
          const fullOutPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(sessionWorkDir || "", filePath);
          const outItem = {
            name: path.basename(filePath),
            filePath: fullOutPath,
            fileType: path.extname(filePath).replace(".", "").toLowerCase() || "file",
          };
          storageService.addSessionOutput(sessionId, outItem);
          event.reply(`session-outputs-updated-${sessionId}`, outItem);
        },
      };
      sessionAbort.toolContext = sessionToolContext;

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

        // 将所有已声明 Skills 与 Memories 的物理目录自动纳入免授权白名单
        for (const skill of availableSkills) {
          if (skill?.filePath) {
            const skillDir = path.resolve(path.dirname(skill.filePath));
            if (!allowedFolders.includes(skillDir)) {
              allowedFolders.push(skillDir);
            }
          }
        }
        for (const mem of memories) {
          if (mem?.path) {
            const memDir = path.resolve(path.dirname(mem.path));
            if (!allowedFolders.includes(memDir)) {
              allowedFolders.push(memDir);
            }
          }
        }

        const hasAnyAttachments = apiMessages.some(
          (m) => Array.isArray(m.attachments) && m.attachments.length > 0
        );

        const hasRealImageAttachments = apiMessages.some(
          (m) => Array.isArray(m.attachments) && m.attachments.some(isImageFile)
        );

        if (hasRealImageAttachments && !supportsVision) {
          event.reply(
            `chat-stream-error-${sessionId}`,
            "当前模型不支持图片输入，请切换到支持视觉的模型"
          );
          return;
        }

        if (hasAnyAttachments) {
          const attached = buildAttachmentMessages(apiMessages);
          apiMessages = attached.messages;
          console.log(
            `[attachment-pipeline] resolved ${attached.imageCount} images / ${attached.textAttachmentCount} text inlines / ${attached.binaryAttachmentCount} file guides`
          );
        }

        const memoryIndex = storageService.getMemoryIndex(sessionWorkDir);
        const projectRules = storageService.getProjectInstructions(sessionWorkDir);

        // 自动装配用户通过 @ 显式引用的技能、MCP 与文件/目录上下文
        const mentionUserMsg = apiMessages.slice().reverse().find((m) => m.role === "user");
        const mentionText = extractTextContent(mentionUserMsg?.content);
        let mentionBlock = "";
        let mentionContext = null;
        if (mentionText) {
          mentionContext = buildMentionContext(mentionText, sessionWorkDir, allowedFolders, {
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

        const [gitInfo, mcpTools] = await Promise.all([
          getGitSnapshotAsync(sessionWorkDir),
          enableTools ? mcpClientService.getActiveMcpTools(sessionWorkDir) : Promise.resolve([]),
        ]);
        sessionToolContext.mcpTools = mcpTools;

        const getActiveToolPromptDocs = () =>
          enableTools && (toolRegistry.size > 0 || mcpTools.length > 0)
            ? toolRegistry.getToolPromptDocs(mcpTools, {
                permissionMode: sessionToolContext.permissionMode,
              })
            : [];

        const buildInstruction = () =>
          buildSystemContext({
            workDir: sessionWorkDir,
            matchedWorkspace,
            skills: availableSkills,
            memories,
            memoryIndex,
            projectRules,
            todos: initialTodos,
            toolDocs: getActiveToolPromptDocs(),
            model: `${provider}/${apiModelId}`,
            enableTools,
            permissionMode: sessionToolContext.permissionMode,
            gitInfo,
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

        // 精准提取 Skills 所占用的实际 Token 数量 (支持可用索引与 @skill 显式激活)
        let currentSkillsTokens =
          initialContext.sections.find((s) => s.name === "skills")?.tokens || 0;
        if (mentionContext && Array.isArray(mentionContext.skills) && mentionContext.skills.length > 0) {
          currentSkillsTokens += estimateTokens(mentionBlock);
        }

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
          currentSkillsTokens =
            rebuilt.sections.find((s) => s.name === "skills")?.tokens || 0;
          if (mentionContext && Array.isArray(mentionContext.skills) && mentionContext.skills.length > 0) {
            currentSkillsTokens += estimateTokens(mentionBlock);
          }
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

        sessionToolContext.onTodosUpdate = (nextTodos) => {
          if (!Array.isArray(nextTodos)) return;
          initialTodos.splice(0, initialTodos.length, ...nextTodos);
          event.reply(`chat-stream-todos-${sessionId}`, initialTodos);
          refreshSystemInstruction();
          console.log(`[context] todos updated: ${initialTodos.length}`);
        };

        const getActiveToolDefs = () =>
          enableTools
            ? toolRegistry.getToolDefinitions(mcpTools, null, {
                permissionMode: sessionToolContext.permissionMode,
              })
            : [];

        const initialTools = getActiveToolDefs();

        const computeContextMetrics = () =>
          calculateContextMetrics({
            messages: apiMessages,
            tools: getActiveToolDefs(),
            systemPrompt: systemInstruction,
            skillsTokens: currentSkillsTokens,
            maxTokensLimit: contextLimit,
          });

        const initMetrics = computeContextMetrics();
        event.reply(`chat-stream-context-metrics-${sessionId}`, initMetrics);

        const MAX_TOOL_ROUNDS = Number(storageService.getConfig("max_tool_rounds")) || 5000;

        function sendData(delta) {
          fullGeneratedText += delta;
          event.reply(`chat-stream-data-${sessionId}`, delta);
        }

        function isTransientSocketError(err) {
          if (!err) return false;
          const msg = String(err.message || "").toLowerCase();
          const causeCode = String(err.cause?.code || "").toUpperCase();
          const causeMsg = String(err.cause?.message || "").toLowerCase();
          return (
            msg.includes("terminated") ||
            msg.includes("fetch failed") ||
            msg.includes("socket") ||
            msg.includes("econnreset") ||
            causeCode === "UND_ERR_SOCKET" ||
            causeCode === "ECONNRESET" ||
            causeCode === "EPIPE" ||
            causeMsg.includes("other side closed")
          );
        }

        function hasValidToolCalls(list) {
          const valid = (list || []).filter(Boolean);
          if (valid.length === 0) return false;
          return valid.every((tc) => {
            if (!tc.function?.name) return false;
            try {
              JSON.parse(tc.function.arguments || "{}");
              return true;
            } catch {
              return false;
            }
          });
        }

        async function doStreamRequestOnce(requestMessages, requestBody) {
          const reasoningSpec = buildReasoningPayload(apiModelId, provider, sessionReasoningEffort);
          let requestBodyFinal = {
            model: apiModelId,
            messages: requestMessages,
            stream: true,
            temperature: 0.2,
            ...reasoningSpec.payload,
            ...requestBody,
          };

          let resp = await fetch(`${modelBaseUrl}/chat/completions`, {
            method: "POST",
            headers,
            signal: sessionAbort.abortController.signal,
            body: JSON.stringify(requestBodyFinal),
          });

          // 核心容错安全退避：若远端网关对未知思考参数返回 400，自动剥离推理参数并无缝降级重试
          if (!resp.ok && resp.status === 400 && Object.keys(reasoningSpec.payload).length > 0) {
            try {
              const errClone = resp.clone();
              const errText = await errClone.text();
              const lowerErr = errText.toLowerCase();
              if (
                lowerErr.includes("reasoning") ||
                lowerErr.includes("thinking") ||
                lowerErr.includes("unrecognized") ||
                lowerErr.includes("unknown parameter") ||
                lowerErr.includes("extra fields not permitted") ||
                lowerErr.includes("not supported")
              ) {
                console.warn(`[chat-stream] 远端端点不支持思考参数 (${errText.slice(0, 150)})，已自动剥离重试...`);
                delete requestBodyFinal.reasoning_effort;
                delete requestBodyFinal.thinking;
                delete requestBodyFinal.thinking_budget;
                delete requestBodyFinal.reasoning;
                delete requestBodyFinal.max_completion_tokens;
                requestBodyFinal.temperature = 0.2;

                resp = await fetch(`${modelBaseUrl}/chat/completions`, {
                  method: "POST",
                  headers,
                  signal: sessionAbort.abortController.signal,
                  body: JSON.stringify(requestBodyFinal),
                });
              }
            } catch (fallbackErr) {
              console.warn("[chat-stream] 自动退避重试执行失败:", fallbackErr.message);
            }
          }

          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`API 请求失败 (${resp.status}): ${errText}`);
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let fullContent = "";
          let fullReasoning = "";
          let inReasoningBlock = false;
          let toolCalls = [];
          let usage = null;
          let streamFinished = false;
          let finishReason = null;
          let hitLengthLimit = false;

          try {
            while (!streamFinished) {
              if (sessionAbort.cancelled) {
                try {
                  await reader.cancel();
                } catch (e) {
                  // 忽略取消读取异常
                }
                break;
              }
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") {
                  streamFinished = true;
                  break;
                }
                try {
                  const json = JSON.parse(payload);
                  if (json.usage) {
                    usage = json.usage;
                    lastProviderUsage = json.usage;
                  }
                  const choice = json.choices?.[0];
                  if (!choice) continue;
                  if (choice.finish_reason) {
                    if (choice.finish_reason === "length" || choice.finish_reason === "max_tokens") {
                      hitLengthLimit = true;
                    }
                    if (!hitLengthLimit) {
                      finishReason = choice.finish_reason;
                    } else {
                      finishReason = "length";
                    }
                  }
                  const delta = choice.delta || {};

                  const reasoningDelta = delta.reasoning_content || delta.reasoning;
                  if (reasoningDelta) {
                    if (!inReasoningBlock) {
                      inReasoningBlock = true;
                      sendData("<think>");
                    }
                    fullReasoning += reasoningDelta;
                    sendData(reasoningDelta);
                  }

                  if (delta.content) {
                    // 拦截并丢弃网关在思考截断 (finish_reason=length) 后注入的伪造占位符 "task ready"
                    if (
                      delta.content.trim().toLowerCase() === "task ready" &&
                      (hitLengthLimit || fullContent.trim().length === 0)
                    ) {
                      hitLengthLimit = true;
                      continue;
                    }
                    if (inReasoningBlock) {
                      inReasoningBlock = false;
                      sendData("</think>\n\n");
                    }
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
          } catch (readErr) {
            if (
              !sessionAbort.cancelled &&
              isTransientSocketError(readErr) &&
              (streamFinished ||
                finishReason ||
                hasValidToolCalls(toolCalls) ||
                fullContent.trim().length > 0)
            ) {
              console.warn(
                `[chat-stream] 忽略流尾部的对端 Socket 提前关闭 (${readErr.cause?.code || readErr.message})，保留已接收的完整响应`
              );
            } else {
              throw readErr;
            }
          } finally {
            try {
              await reader.cancel();
            } catch {
              // 忽略释放 reader 异常
            }
          }

          if (inReasoningBlock) {
            inReasoningBlock = false;
            sendData("</think>\n\n");
          }

          return {
            content: fullContent,
            reasoning: fullReasoning,
            toolCalls: toolCalls.filter(Boolean),
            usage,
            hitLengthLimit,
            finishReason,
          };
        }

        async function doStreamRequest(requestMessages, requestBody) {
          const maxAttempts = 3;
          let lastErr = null;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (sessionAbort.cancelled) break;
            try {
              return await doStreamRequestOnce(requestMessages, requestBody);
            } catch (err) {
              lastErr = err;
              if (sessionAbort.cancelled || !isTransientSocketError(err) || attempt === maxAttempts) {
                throw err;
              }
              const delayMs = attempt * 400;
              console.warn(
                `[chat-stream] 遇到瞬时 Socket 断开 (${err.cause?.code || err.message})，${delayMs}ms 后进行第 ${attempt + 1}/${maxAttempts} 次重试...`
              );
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }
          throw lastErr;
        }

        // Agent 工具执行与自适应断点续写循环
        let continuationCount = 0;
        const MAX_CONTINUATIONS = 4;

        while (toolRound < MAX_TOOL_ROUNDS) {
          let requestBody = {};
          if (enableTools) {
            requestBody.tools = getActiveToolDefs();
            requestBody.tool_choice = "auto";
          }

          if (sessionAbort.cancelled) break;

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

          if (sessionAbort.cancelled) break;

          if (!enableTools || result.toolCalls.length === 0) {
            const cleanRoundText = (result.content || "").trim();
            const hasIncompleteTodos =
              initialTodos.length > 0 && initialTodos.some((t) => t.status !== "completed");

            // 模式 A：正在输出长篇正文或代码块时触发单次输出长度上限 -> 无缝断点续写
            if (result.hitLengthLimit && cleanRoundText.length > 0 && continuationCount < MAX_CONTINUATIONS) {
              continuationCount++;
              const tailSnippet = result.content.slice(-80);
              console.log(`[auto-continue] 模式A：正文触发长度上限，发起第 ${continuationCount} 次无缝断点续写`);
              apiMessages.push({
                role: "assistant",
                content: result.content,
              });
              apiMessages.push({
                role: "user",
                content: `你的上一条回复因达到单次输出长度上限而在末尾中断（中断处末尾字符为：${JSON.stringify(
                  tailSnippet
                )}）。请紧接在该位置之后无缝继续输出剩余内容，禁止重复前文或添加任何开场白。`,
              });
              continue;
            }

            // 模式 B：深度思考或超大工具调用参数触发长度截断（无正文产出） -> 引导增量拆分执行
            if (
              (result.hitLengthLimit || (result.reasoning && cleanRoundText.length === 0)) &&
              continuationCount < MAX_CONTINUATIONS
            ) {
              continuationCount++;
              console.log(`[auto-continue] 模式B：思考或大工具参数被截断，发起第 ${continuationCount} 次增量恢复`);
              apiMessages.push({
                role: "assistant",
                content: result.reasoning
                  ? `已完成阶段思考分析：${result.reasoning.slice(-1200)}`
                  : "已完成阶段思考分析。",
              });
              apiMessages.push({
                role: "user",
                content:
                  "你刚才的思考或工具调用参数因超出单次输出上限被截断，尚未发出工具调用或正文。你已经完成了思考推导，接下来请：(1) 不要再重复长篇思考（保持极简思考）；(2) 若要写入较长文件（如完整 README 或复杂 SVG），请拆分为多步执行——先调用 write_file 写入前半部分或核心骨架，再调用 edit_file 分段追加剩余章节；或者直接输出最终完整代码与回复。",
              });
              continue;
            }

            // 模式 C：待办清单 (Todo List) 仍有未完成项，但模型只吐出简短过渡词就停下 -> 督促继续执行
            if (
              hasIncompleteTodos &&
              sessionToolContext.permissionMode !== PERMISSION_MODES.PLAN &&
              cleanRoundText.length < 80 &&
              continuationCount < MAX_CONTINUATIONS
            ) {
              continuationCount++;
              const activeTodo = initialTodos.find((t) => t.status === "in_progress") || initialTodos.find((t) => t.status === "pending");
              console.log(`[auto-continue] 模式C：检测到未完成 Todo (${activeTodo?.text})，督促继续执行`);
              if (cleanRoundText) {
                apiMessages.push({ role: "assistant", content: cleanRoundText });
              }
              apiMessages.push({
                role: "user",
                content: `当前任务规划中仍有未完成的待办项（当前待完成：${
                  activeTodo?.text || "剩余任务"
                }），请不要停留在准备阶段，立即调用相应工具（如 write_file / edit_file / run_command）继续执行，并在全部完成后更新 todo_write 及输出最终总结。`,
              });
              continue;
            }

            break;
          }

          // 成功发起了工具调用，重置连续续写计数
          continuationCount = 0;
          toolRound++;

          const READ_ONLY_TOOLS = new Set([
            "read_file",
            "list_directory",
            "search_code",
            "web_search",
            "web_fetch",
          ]);

          const preparedCalls = result.toolCalls.map((tc, idx) => {
            const callId = tc.id || `call_${Date.now()}_${idx}`;
            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) {
              args = { _parseError: tc.function.arguments };
            }
            return { tc, callId, args };
          });

          // 1. 先统一广播本轮所有工具的 running 状态
          for (const item of preparedCalls) {
            event.reply(`chat-stream-tool-status-${sessionId}`, {
              tool: item.tc.function.name,
              status: "running",
              args: item.args,
              callId: item.callId,
            });
          }

          const executeSingleCall = async ({ tc, callId, args }) => {
            if (sessionAbort.cancelled) {
              return { tc, callId, args, execResult: { success: false, error: "已取消" } };
            }

            let currentSubSteps = [];
            const callScopedContext =
              tc.function.name === "dispatch_subagent"
                ? {
                    ...sessionToolContext,
                    onSubagentProgress: (subSteps) => {
                      currentSubSteps = subSteps;
                      event.reply(`chat-stream-tool-status-${sessionId}`, {
                        tool: tc.function.name,
                        status: "running",
                        args,
                        callId,
                        subSteps,
                      });
                    },
                  }
                : sessionToolContext;

            const execResult = await toolRegistry.execute(
              tc.function.name,
              args,
              callScopedContext,
              mcpTools
            );

            if (
              (tc.function.name === "write_file" || tc.function.name === "edit_file") &&
              execResult?.success &&
              execResult?.data?.success !== false
            ) {
              const fullOutPath = path.isAbsolute(args.path)
                ? args.path
                : path.join(sessionWorkDir || "", args.path);
              const outItem = {
                name: path.basename(args.path),
                filePath: fullOutPath,
                fileType: path.extname(args.path).replace(".", "").toLowerCase() || "file",
                action: execResult?.data?.action || "modified",
              };
              storageService.addSessionOutput(sessionId, outItem);
              event.reply(`session-outputs-updated-${sessionId}`, outItem);
            }

            executedToolSteps.push({
              tool: tc.function.name,
              status: "done",
              args,
              result: execResult,
              callId,
              ...(currentSubSteps.length > 0 ? { subSteps: currentSubSteps } : {}),
            });

            event.reply(`chat-stream-tool-status-${sessionId}`, {
              tool: tc.function.name,
              status: "done",
              args,
              result: execResult,
              callId,
              ...(currentSubSteps.length > 0 ? { subSteps: currentSubSteps } : {}),
            });

            return { tc, callId, args, execResult };
          };

          // 判断工具调用是否并发安全（只读工具 或 只读型 Subagent 均可多路并发执行）
          const isParallelSafeCall = (item) => {
            const name = item.tc.function.name;
            if (READ_ONLY_TOOLS.has(name)) return true;
            if (name === "dispatch_subagent") {
              const a = item.args || {};
              if (Array.isArray(a.tasks)) {
                return a.tasks.every((t) => t.readOnly !== false && t.agent !== "general");
              }
              return a.readOnly !== false && a.agent !== "general";
            }
            return false;
          };

          // 2. 若本轮全部为并发安全调用，使用 Promise.all 并发执行；否则按序执行以保证文件修改时序安全
          const allReadOnly =
            preparedCalls.length > 1 &&
            preparedCalls.every((item) => isParallelSafeCall(item));

          let completedCalls = [];
          if (allReadOnly) {
            completedCalls = await Promise.all(preparedCalls.map((item) => executeSingleCall(item)));
          } else {
            for (const item of preparedCalls) {
              if (sessionAbort.cancelled) break;
              const res = await executeSingleCall(item);
              completedCalls.push(res);
            }
          }

          if (completedCalls.length > 0) {
            // 3. 标准消息序列：单条聚合 assistant 消息（保留本轮产出的 content 与全部 tool_calls）+ 紧随其后的多条 tool 消息
            apiMessages.push({
              role: "assistant",
              content: result.content || "",
              tool_calls: completedCalls.map(({ tc, callId }) => ({
                id: callId,
                type: "function",
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              })),
            });

            for (const { callId, execResult } of completedCalls) {
              // 过滤前端对比专用的大体积旧文件快照字段，避免浪费大模型上下文 Token
              const modelVisibleResult =
                execResult?.data && typeof execResult.data === "object" && "originalContent" in execResult.data
                  ? {
                      ...execResult,
                      data: { ...execResult.data, originalContent: undefined },
                    }
                  : execResult;
              apiMessages.push({
                role: "tool",
                tool_call_id: callId,
                content: truncateToolResult(JSON.stringify(modelVisibleResult), compactCfg.toolResultMaxChars),
              });
            }
          }

          // 每轮后更新 Context 计量
          const updatedMetrics = computeContextMetrics();
          event.reply(`chat-stream-context-metrics-${sessionId}`, updatedMetrics);
        }

        // 提取剥离了 <think> 思考块与合成占位符后的可见正文
        const visibleGeneratedText = fullGeneratedText
          .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
          .replace(/<(?:think|thinking)>[\s\S]*$/gi, "")
          .replace(/\btask ready\b/gi, "")
          .trim();

        // 若大模型在工具调用结束后未给出最终可见文本回答，强制进行最终一轮总结输出
        // 注意：用户已主动取消时不再发起总结请求
        if (!sessionAbort.cancelled && !visibleGeneratedText && toolRound > 0) {
          apiMessages.push({
            role: "user",
            content: "请基于以上工具执行获取到的全部信息、代码与事实，直接给出条理清晰、完整详尽的最终总结分析与答复（不要再调用工具，精简思考过程直接输出正文）。",
          });
          await maybeCompact("preflight");
          let finalResult;
          try {
            finalResult = await doStreamRequest(apiMessages, { reasoning_effort: "low" });
          } catch (err) {
            if (!isContextOverflowError(err.message)) throw err;
            const compacted = await maybeCompact("overflow", { force: true });
            if (!compacted) throw err;
            finalResult = await doStreamRequest(apiMessages, { reasoning_effort: "low" });
          }
        }

        // 若任务正常结束（非用户取消），将仍遗留在 in_progress 的 Todo 自动收敛为 completed
        if (!sessionAbort.cancelled && initialTodos.some((t) => t.status === "in_progress")) {
          for (const todo of initialTodos) {
            if (todo.status === "in_progress") {
              todo.status = "completed";
            }
          }
          event.reply(`chat-stream-todos-${sessionId}`, initialTodos);
        }

        // 最终推送一次 Context
        const finalMetrics = computeContextMetrics();
        event.reply(`chat-stream-context-metrics-${sessionId}`, finalMetrics);

        // 结束时通知前端，由前端单源原子落盘 (消除主进程重复双写导致的消息被覆盖Bug)
        event.reply(`chat-stream-end-${sessionId}`, {
          content: fullGeneratedText,
          metadata: {
            cancelled: !!sessionAbort.cancelled,
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
        if (err.name === "AbortError" || sessionAbort.cancelled) {
          console.log(`[chat-stream] session ${sessionId} cancelled by user`);
          try {
            event.reply(`chat-stream-end-${sessionId}`, {
              content: fullGeneratedText,
              metadata: {
                cancelled: true,
                toolRounds: toolRound,
                toolSteps: executedToolSteps,
                todos: initialTodos,
              },
            });
          } catch (e) {
            // 忽略已关闭窗口的 reply 异常
          }
        } else {
          console.error(`[chat-stream error ${sessionId}]`, err);
          event.reply(`chat-stream-error-${sessionId}`, err.message);
        }
      } finally {
        activeStreamSessions.delete(sessionId);
      }
    }
  );

  createWindow();
  initAutoUpdater(mainWindow);
});

app.on("before-quit", () => {
  mcpClientService.closeAll();
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
