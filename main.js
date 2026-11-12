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
const reasoningPolicy = require("./services/reasoningPolicy");
const { initAutoUpdater } = require("./services/updaterService");
const {
  getWorkspaceGitStatus,
  getWorkspaceFileDiff,
  commitWorkspaceChanges,
  getWorkspaceBranches,
  checkoutWorkspaceBranch,
} = require("./services/workspaceGitService");
const { calculateContextMetrics, estimateTokens } = require("./services/contextCalculator");
const { toolRegistry } = require("./utils/toolRegistry");
const { performWebSearch, scrapePageContent } = require("./utils/tools/webTools");
const { listWorkspaceFiles } = require("./utils/tools/fileIndexer");
const { buildMentionContext } = require("./utils/tools/mentionResolver");
const { isUnderFolder, isBuiltinTrustedPath, DEFAULT_ROOT } = require("./utils/tools/pathResolver");
const { buildSystemContext, getGitSnapshotAsync } = require("./utils/contextBuilder");
const { mcpClientService } = require("./services/mcpClientService");
const mcpOAuthService = require("./services/mcpOAuthService");
const subagentService = require("./services/subagentService");
const skillMarketService = require("./services/skillMarketService");
const checkpointService = require("./services/checkpointService");
const { terminalPtyService } = require("./services/terminalPtyService");
const repoIndexService = require("./services/repoIndexService");
const repoWikiService = require("./services/repoWikiService");
const { getSystemFonts } = require("./services/fontService");
const commandService = require("./services/commandService");
const specService = require("./services/specService");
const btwService = require("./services/btwService");
const hookService = require("./services/hookService");
const gitHunkService = require("./services/gitHunkService");
const gitWorktreeService = require("./services/gitWorktreeService");
const diagnosticsService = require("./services/diagnosticsService");
const sessionTransferService = require("./services/sessionTransferService");
const telemetryService = require("./services/telemetryService");
const evalService = require("./services/evalService");
const browserAutomationService = require("./services/browserAutomationService");
const {
  isAnthropicProvider,
  streamAnthropicMessage,
  completeAnthropicMessage,
  normalizeAnthropicUsage,
} = require("./services/anthropicClient");
const {
  PERMISSION_MODES,
  normalizePermissionMode,
  checkSensitivePath,
  resolveRealPathSafe,
  isUnderFolderReal,
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

// 进程级异常兜底：主进程任一异步链路漏网都不应让整个应用瞬间消失。
// 统一记录完整堆栈，保留现场以便定位；未捕获异常后继续运行，由各自链路自行恢复。
process.on("uncaughtException", (err, origin) => {
  console.error(`[main] 未捕获异常 (${origin || "uncaughtException"}):`, err?.stack || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] 未处理的 Promise 拒绝:", reason?.stack || reason);
});

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

// 活动 Agent 运行的中断快照落盘器 (sessionId -> flush)，供 before-quit 同步兜底
const activeStreamSnapshotFlushers = new Map();

// 渲染进程内容安全策略（仅在生产 app:// 协议响应头中下发，避免干扰 Vite 开发态 HMR）
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: app: local-media:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: local-media:",
  "connect-src 'self' app: local-media: http: https: ws: wss:",
  // 工作台内嵌预览需要 http(s) 与本地产物协议；iframe 自身仍由 sandbox 属性隔离
  "frame-src 'self' data: about: blob: local-media: http: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// 本地媒体响应策略：即使被当作文档直接加载，也禁止脚本执行与外部资源请求
const LOCAL_MEDIA_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
// 显式请求网页渲染（?render=1）时才允许 text/html：仍禁用脚本/表单/跨源请求，
// 仅放行同协议下的图片、样式、字体与媒体，供工作区静态页面预览使用。
const LOCAL_MEDIA_RENDER_CSP =
  "sandbox; default-src 'none'; img-src local-media: data:; style-src 'unsafe-inline' local-media:; font-src local-media: data:; media-src local-media: data:; script-src 'none'; form-action 'none'; base-uri 'none'";

const INTERNAL_APP_URL_PREFIX = "app://dist/";

function isSafeExternalUrl(targetUrl) {
  return /^https?:\/\//i.test(String(targetUrl || "").trim());
}

/**
 * 判断目标路径是否为当前会话已登记的文件产物（允许在产物面板中预览工作区外文件）
 */
function isKnownSessionOutputPath(targetPath) {
  if (!targetPath) return false;
  const realTarget = resolveRealPathSafe(targetPath);
  if (!realTarget) return false;
  try {
    for (const session of storageService.getSessions() || []) {
      const outputs = storageService.getSessionOutputs(session.id) || [];
      for (const out of outputs) {
        if (!out || !out.filePath) continue;
        if (resolveRealPathSafe(out.filePath) === realTarget) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

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

function processAttachmentImageBuffer(inputBuffer, mime) {
  if (!inputBuffer || inputBuffer.length === 0) throw new Error("图片内容为空");

  const image = nativeImage.createFromBuffer(inputBuffer);
  if (image.isEmpty()) throw new Error("无法识别的图片格式");

  let { width, height } = image.getSize();
  let buffer = inputBuffer;
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

function processAttachmentImage(base64, mime) {
  const input = Buffer.from(String(base64 || ""), "base64");
  return processAttachmentImageBuffer(input, mime);
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

/** 是否以未闭合的代码围栏结尾（上游静默截断的典型特征） */
function hasUnclosedCodeFence(text) {
  const matches = String(text || "").match(/^```/gm);
  return Boolean(matches && matches.length % 2 === 1);
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
  const maxOutputTokens = Number(matched?.max_output_tokens) || 8192;
  const supportsVision =
    typeof matched?.supports_vision === "boolean"
      ? matched.supports_vision
      : storageService.inferVisionSupport(apiModelId);

  return {
    modelBaseUrl,
    modelApiKey,
    provider,
    apiModelId,
    contextLimit,
    maxOutputTokens,
    supportsVision,
    inputPrice: Number(matched?.input_price) || 0,
    outputPrice: Number(matched?.output_price) || 0,
    cacheReadPrice: Number(matched?.cache_read_price) || 0,
    cacheWritePrice: Number(matched?.cache_write_price) || 0,
  };
}

/**
 * 统一 Usage 归一化：兼容 OpenAI 与 Anthropic 两套字段命名。
 */
function normalizeUsage(usage, provider) {
  if (!usage || typeof usage !== "object") return null;
  if (provider === "anthropic") return normalizeAnthropicUsage(usage);

  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  const cached =
    Number(usage.prompt_tokens_details?.cached_tokens) ||
    Number(usage.cached_tokens) ||
    Number(usage.cache_read_input_tokens) ||
    0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
    cached_tokens: cached,
    cache_creation_tokens: cacheCreation,
    raw: usage,
  };
}

function mergeUsage(total, usage) {
  if (!usage) return total;
  const base = total || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
  };
  return {
    prompt_tokens: base.prompt_tokens + (Number(usage.prompt_tokens) || 0),
    completion_tokens: base.completion_tokens + (Number(usage.completion_tokens) || 0),
    total_tokens: base.total_tokens + (Number(usage.total_tokens) || 0),
    cached_tokens: base.cached_tokens + (Number(usage.cached_tokens) || 0),
    cache_creation_tokens:
      base.cache_creation_tokens + (Number(usage.cache_creation_tokens) || 0),
  };
}

function computeUsageCost(usage, pricing = {}) {
  if (!usage) return 0;
  const inputPrice = Number(pricing.inputPrice) || 0;
  const outputPrice = Number(pricing.outputPrice) || 0;
  const cacheReadPrice =
    Number(pricing.cacheReadPrice) || (inputPrice > 0 ? inputPrice * 0.1 : 0);
  const cacheWritePrice =
    Number(pricing.cacheWritePrice) || (inputPrice > 0 ? inputPrice * 1.25 : 0);

  const prompt = Number(usage.prompt_tokens) || 0;
  const cached = Math.min(Number(usage.cached_tokens) || 0, prompt);
  const cacheCreation = Number(usage.cache_creation_tokens) || 0;
  const normalPrompt = Math.max(0, prompt - cached - cacheCreation);
  const completion = Number(usage.completion_tokens) || 0;

  const cost =
    (normalPrompt * inputPrice +
      cached * cacheReadPrice +
      cacheCreation * cacheWritePrice +
      completion * outputPrice) /
    1_000_000;
  return Math.round(cost * 100_000_000) / 100_000_000;
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

  // 2. Anthropic Claude 思考模型（含经 OpenAI 兼容网关暴露的 claude 模型）
  //    注意：legacy 的 thinking.type="enabled" + budget_tokens 已被官方标记为弃用，
  //    Claude 4.7+ 直接返回 400。这里统一下发 adaptive thinking，并用 output_config.effort
  //    表达强度意图；若网关仍不认识，main.js 的 400 安全退避会自动剥离重试。
  //    仅匹配明确支持思考的版本（3.7+ / 4.x / 5.x），避免给 claude-3-5 等旧模型平白多打一次 400。
  const supportsClaudeThinking =
    /claude[-_]?(?:3[-.]?7|4|5|6|7|8|9)/i.test(modelLower) ||
    /(?:sonnet|opus|haiku)[-_]?(?:4|5|6|7|8|9)/i.test(modelLower) ||
    modelLower.includes("thinking");
  const isClaudeThinking =
    (providerLower === "anthropic" || modelLower.includes("claude")) && supportsClaudeThinking;

  if (isClaudeThinking) {
    const effortMap = { low: "low", medium: "medium", high: "high", max: "max" };
    return {
      payload: {
        thinking: { type: "adaptive" },
        output_config: { effort: effortMap[reasoningEffort] || "high" },
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
 * 支持 AI 智能提炼 + 本地关键词提纯双重保底，彻底杜绝会话一直名为“新的 Agent 会话”
 */
async function generateSessionTitleSidecar(sessionId, userPrompt, currentModelId, webContents) {
  try {
    const session = storageService.getSessions().find((s) => s.id === sessionId);
    if (!session || session.title_source === "custom") {
      return; // 用户已自定义过标题，绝不覆盖
    }

    let cleanPrompt = String(userPrompt || "").trim();
    // 过滤掉 [image #1] 占位符与 @ 提及标签，提取真正的用户意图文字
    cleanPrompt = cleanPrompt
      .replace(/\[image\s*#?\d+\]/gi, "")
      .replace(/@\S+/g, "")
      .trim();
    if (!cleanPrompt || cleanPrompt.length < 2) return;

    // 本地规则提炼保底函数
    const applyLocalFallbackTitle = () => {
      let snippet = cleanPrompt
        .replace(/^(请问|帮我|请帮我|如何|怎么|麻烦|想问下|我想|分析一下|看一下|看看)[：:，,\s]*/i, "")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
      if (snippet.length > 15) {
        snippet = snippet.slice(0, 15);
      }
      if (snippet.length >= 2) {
        const updated = storageService.updateSessionGeneratedTitle(sessionId, snippet);
        if (updated && webContents && !webContents.isDestroyed()) {
          webContents.send("session-title-updated", { sessionId, title: snippet });
          console.log(`[title-sidecar:fallback] applied local fallback title for ${sessionId}: "${snippet}"`);
        }
      }
    };

    // 优先使用当前正在调用的会话模型配置 (既然用户刚成功发送，说明该模型 100% 可用且密钥有效)
    let { modelBaseUrl, modelApiKey, apiModelId, provider } = getModelConfig(
      currentModelId,
      "gpt-4o"
    );
    if (!modelBaseUrl || (!modelApiKey && currentModelId !== "ollama")) {
      const liteChoice = pickLiteModel(currentModelId);
      const liteCfg = getModelConfig(liteChoice, "gpt-4o");
      if (liteCfg.modelBaseUrl && (liteCfg.modelApiKey || liteChoice === "ollama")) {
        modelBaseUrl = liteCfg.modelBaseUrl;
        modelApiKey = liteCfg.modelApiKey;
        apiModelId = liteCfg.apiModelId;
        provider = liteCfg.provider;
      } else {
        applyLocalFallbackTitle();
        return;
      }
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 6000);

    let rawTitle = "";
    try {
      if (isAnthropicProvider(provider, modelBaseUrl)) {
        const anthropicTitle = await completeAnthropicMessage({
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
          model: apiModelId,
          system:
            "你是会话命名助手。根据用户提问的核心意图，提炼出一个简短、精准的中文标题（4到10个汉字）。禁止回答问题，禁止输出任何标点符号、引号、书名号或“标题：”等前缀，直接输出纯文本标题本身。",
          messages: [
            {
              role: "user",
              content: `<message>\n${cleanPrompt.slice(0, 400)}\n</message>`,
            },
          ],
          maxTokens: 40,
          temperature: 0.2,
          signal: controller.signal,
        });
        rawTitle = String(anthropicTitle.content || "").trim();
      } else {
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (modelApiKey) {
          headers["Authorization"] = `Bearer ${modelApiKey}`;
        }

        // 纯净标准的命名请求体，严禁附带非法的 reasoning_effort 避免 400 阻断
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
          }),
        });

        if (!response.ok) {
          console.warn(`[title-sidecar] AI 标题接口返回 HTTP ${response.status}，切换本地规则提纯命名`);
          clearTimeout(timeoutTimer);
          applyLocalFallbackTitle();
          return;
        }

        const data = await response.json();
        rawTitle = data?.choices?.[0]?.message?.content?.trim() || "";
      }
    } finally {
      clearTimeout(timeoutTimer);
    }

    if (!rawTitle) {
      applyLocalFallbackTitle();
      return;
    }

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
        console.log(`[title-sidecar] generated AI title for ${sessionId}: "${title}"`);
      }
    } else {
      applyLocalFallbackTitle();
    }
  } catch (err) {
    console.warn(`[title-sidecar] 异常 (${err.message})，使用本地规则提纯命名`);
    try {
      let snippet = String(userPrompt || "")
        .replace(/\[image\s*#?\d+\]/gi, "")
        .replace(/@\S+/g, "")
        .replace(/^(请问|帮我|请帮我|如何|怎么|麻烦|想问下|我想|分析一下|看一下|看看)[：:，,\s]*/i, "")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
      if (snippet.length > 15) snippet = snippet.slice(0, 15);
      if (snippet.length >= 2) {
        const updated = storageService.updateSessionGeneratedTitle(sessionId, snippet);
        if (updated && webContents && !webContents.isDestroyed()) {
          webContents.send("session-title-updated", { sessionId, title: snippet });
        }
      }
    } catch {}
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

  // 安全加固：窗口内导航必须锁定在本地打包产物内，任何外部跳转一律交给系统浏览器，
  // 防止模型输出/恶意链接把 preload 暴露的 electronAPI 带到远端页面。
  const guardNavigation = (event, url) => {
    const target = String(url || "");
    if (target.startsWith(INTERNAL_APP_URL_PREFIX)) return;
    event.preventDefault();
    if (isSafeExternalUrl(target)) {
      shell.openExternal(target);
    }
  };
  mainWindow.webContents.on("will-navigate", guardNavigation);
  mainWindow.webContents.on("will-redirect", guardNavigation);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 仅允许通过系统浏览器打开 http/https，杜绝自定义协议与本地文件协议被滥用
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const windowWebContents = mainWindow.webContents;
  windowWebContents.on("destroyed", () => {
    terminalPtyService.disposeBySender(windowWebContents);
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
    const resolved = resolveRealPathSafe(targetPath);

    // 1. 最高优先级拦截高危隐私黑名单与客户端数据库（必须在附件放行之前判断，
    //    防止通过符号链接或大小写变体绕过 ~/.omcx/sessions 的附件白名单）
    if (checkSensitivePath(resolved).blocked) {
      return false;
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

    // 3. 放行会话附件目录 (~/.omcx/sessions/<id>/attachments/*)，基于 realpath 校验
    if (storageService.isSessionAttachmentPath(resolved)) {
      return true;
    }

    // 4. 精确放行已登记的文件产物（不做整目录放行，避免产物目录被扩大为任意读取面）
    if (isKnownSessionOutputPath(resolved)) {
      return true;
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
    }
    for (const root of allowedRoots) {
      if (isUnderFolderReal(resolved, root)) return true;
    }
    return false;
  }

  protocol.handle("local-media", async (request) => {
    try {
      let filePath = "";
      let wantsRender = false;
      try {
        const parsedUrl = new URL(request.url);
        wantsRender = parsedUrl.searchParams.get("render") === "1";
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
      // macOS APFS 大小写规范化：将小写的 /users/ 无条件规范化为标准大写的 /Users/，杜绝 path.relative 误判
      if (process.platform === "darwin" && /^\/users\//i.test(resolvedPath)) {
        resolvedPath = "/Users/" + resolvedPath.slice("/users/".length);
      }

      if (!isAllowedLocalMediaPath(resolvedPath)) {
        console.warn(`[protocol:local-media] 拦截越界访问请求: ${resolvedPath}`);
        return new Response("Forbidden", { status: 403 });
      }

      if (!fs.existsSync(resolvedPath)) {
        console.warn(`[protocol:local-media] 文件不存在: ${resolvedPath}`);
        return new Response("File not found", { status: 404 });
      }

      // 提取准确的标准 MIME 类型。
      // 本地任意文件可能是 HTML/JS/CSS，绝不能以可执行 MIME 回源（即便有 CSP sandbox），
      // 统一降级为 text/plain 纯文本，杜绝被当成同源脚本或文档执行。
      const lower = resolvedPath.toLowerCase();
      let mimeType = "application/octet-stream";
      if (lower.endsWith(".png")) mimeType = "image/png";
      else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mimeType = "image/jpeg";
      else if (lower.endsWith(".webp")) mimeType = "image/webp";
      else if (lower.endsWith(".gif")) mimeType = "image/gif";
      else if (lower.endsWith(".svg")) mimeType = "image/svg+xml";
      else if (lower.endsWith(".html") || lower.endsWith(".htm")) mimeType = "text/plain; charset=utf-8";
      else if (lower.endsWith(".css")) mimeType = "text/plain; charset=utf-8";
      else if (lower.endsWith(".js") || lower.endsWith(".mjs")) mimeType = "text/plain; charset=utf-8";
      else if (lower.endsWith(".json")) mimeType = "text/plain; charset=utf-8";

      // 仅当显式携带 ?render=1 时，HTML 才按文档渲染（脚本已被 CSP sandbox + script-src 'none' 双重禁用）
      const isHtmlDoc = lower.endsWith(".html") || lower.endsWith(".htm");
      const renderAsDocument = isHtmlDoc && wantsRender;
      if (renderAsDocument) mimeType = "text/html; charset=utf-8";

      const fileBuffer = await fs.promises.readFile(resolvedPath);
      return new Response(fileBuffer, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400",
          "Content-Security-Policy": renderAsDocument ? LOCAL_MEDIA_RENDER_CSP : LOCAL_MEDIA_CSP,
          "X-Content-Type-Options": "nosniff",
        },
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
      headers.set("Content-Security-Policy", RENDERER_CSP);
      headers.set("X-Content-Type-Options", "nosniff");
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
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": RENDERER_CSP,
            "X-Content-Type-Options": "nosniff",
          },
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

  // --- 系统字体枚举（供设置页选择界面/终端字体） ---
  ipcMain.handle(
    "get-system-fonts",
    safeHandler((event, { refresh } = {}) => getSystemFonts({ force: Boolean(refresh) }))
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
    safeHandler(async (event, sessionId) => {
      // 大历史会话的首次读取交给 Worker 线程，避免主进程同步 SQLite 阻塞事件循环
      const msgs = await storageService.getMessagesAsync(sessionId);

      // IPC 瘦身与零正则直通：
      // 新数据在入库时已将思考抽离至独立存储，消息自带 reasoningChars 元数据；
      // 对老数据保留兜底解析，但仅在包含思考围栏标签时才执行正则，避免全量无谓扫描。
      const toIpcMessage = (m) => {
        if (!m || m.role !== "assistant") return m;
        const chars = Number(m.reasoning_chars || m.reasoningChars || m.metadata?.reasoningChars || 0);
        if (chars > 0) {
          // 已具有独立思考字段，正文已经是剥离后的纯净正文，无需任何正则扫描
          return {
            ...m,
            reasoningChars: chars,
            metadata: {
              ...(m.metadata && typeof m.metadata === "object" ? m.metadata : {}),
              reasoningChars: chars,
            },
          };
        }
        // 兼容历史混杂在 content 里的老数据（仅安全剥离成对标签，未闭合一律保留正文）
        if (typeof m.content === "string" && m.content.includes("<think")) {
          const { content, reasoning } = storageService.extractLegacyThinking(m.content);
          if (reasoning) {
            return {
              ...m,
              content,
              reasoningChars: reasoning.length,
              metadata: {
                ...(m.metadata && typeof m.metadata === "object" ? m.metadata : {}),
                reasoningChars: reasoning.length,
              },
            };
          }
        }
        return m;
      };

      // 崩溃恢复：非活动会话中若存在上次进程异常退出遗留的 streaming 快照，
      // 归一化为 interrupted 终态并回写，避免它永远停留在"进行中"而无法展示中断提示。
      if (activeStreamSessions.has(sessionId)) return msgs.map(toIpcMessage);
      const stale = msgs.filter(
        (m) => m.metadata && typeof m.metadata === "object" && m.metadata.streaming
      );
      if (stale.length === 0) return msgs.map(toIpcMessage);

      const interruptedAt = Date.now();
      for (const m of stale) {
        const metadata = {
          ...m.metadata,
          streaming: false,
          interrupted: true,
          interruptedAt,
        };
        storageService.addMessage(sessionId, {
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          metadata,
        });
        m.metadata = metadata;
      }
      return msgs.map(toIpcMessage);
    })
  );

  ipcMain.handle(
    "db-get-message-reasoning",
    safeHandler(async (event, messageId) => {
      const id = String(messageId || "").trim();
      if (!id) return "";
      // 优先异步按需从独立的思考表中读取，零阻塞事件循环
      const reasoning = await storageService.getMessageReasoningAsync(id);
      if (reasoning) return reasoning;
      // 降级兜底：查询老消息记录正文并抽离
      const message = await storageService.getMessageByIdAsync(id);
      if (!message || !message.content) return "";
      return storageService.extractLegacyThinking(message.content).reasoning;
    })
  );

  ipcMain.handle(
    "db-add-message",
    safeHandler((event, { id, sessionId, role, content, metadata, reasoning }) =>
      storageService.addMessage(sessionId, { id, role, content, metadata, reasoning })
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
    safeHandler((event, { sessionId, name, mime, sourcePath, base64 }) => {
      if (!sessionId || (!base64 && !sourcePath)) throw new Error("附件参数不完整");
      if (sourcePath && !fs.existsSync(sourcePath)) throw new Error("附件源文件不存在");
      const cleanName = name || "attachment";
      const isImg = isImageFile({ name: cleanName, mime });

      // 1. 优先使用本地物理路径直通，彻底避免大文件转 Base64 的内存暴涨与 IPC 序列化卡顿
      if (sourcePath && fs.existsSync(sourcePath)) {
        // 安全加固：禁止把宿主机凭据/客户端数据库等敏感文件复制进可公开读取的会话附件目录
        const realSource = resolveRealPathSafe(sourcePath) || path.resolve(sourcePath);
        const sensitiveCheck = checkSensitivePath(realSource);
        if (sensitiveCheck.blocked) {
          throw new Error(sensitiveCheck.reason || "安全策略已禁止上传该敏感文件");
        }
        const sourceStat = fs.statSync(realSource);
        if (!sourceStat.isFile()) throw new Error("附件源路径不是文件");
        if (sourceStat.size > 512 * 1024 * 1024) throw new Error("附件超过 512MB 上限");

        const id = crypto.randomUUID();
        if (isImg) {
          const rawBuffer = fs.readFileSync(realSource);
          const processed = processAttachmentImageBuffer(rawBuffer, mime);
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

        // 非图片文件（代码、文本、表格、压缩包等）：调用内核原生 copyFileSync 零内存直通落盘
        const ext = getAttachmentExtension(cleanName) || "bin";
        const dir = storageService.getSessionAttachmentsDir(sessionId);
        storageService.ensureDir(dir);
        const targetPath = path.join(dir, `${id}.${ext}`);
        fs.copyFileSync(realSource, targetPath);
        const stat = fs.statSync(targetPath);
        return {
          id,
          path: targetPath,
          size: stat.size,
          mime: mime || "application/octet-stream",
          name: cleanName,
        };
      }

      // 2. 剪贴板内存截图等无源文件路径的场景，优雅降级走原有 Buffer 解码
      const inputBuffer = Buffer.from(String(base64 || ""), "base64");
      if (isImg) {
        const processed = processAttachmentImageBuffer(inputBuffer, mime);
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

      // 非图片文件原样无损落盘
      const id = crypto.randomUUID();
      const ext = getAttachmentExtension(cleanName) || "bin";
      const saved = storageService.saveAttachmentBuffer(sessionId, id, ext, inputBuffer);
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

  // 项目级 MCP 配置信任授权（指纹绑定，配置变更后自动失效）
  ipcMain.handle(
    "trust-project-mcp",
    safeHandler((event, { workDir, trusted } = {}) => {
      const result = storageService.setProjectMcpTrust(workDir, Boolean(trusted));
      mcpClientService.reloadClients();
      return result;
    })
  );

  // 仅切换全局 MCP 服务器的启用状态，绝不把项目级配置写回全局文件
  ipcMain.handle(
    "toggle-mcp-server",
    safeHandler((event, { id, enabled } = {}) => {
      if (!id) return { success: false, error: "缺少服务器 ID" };
      const globalServers = storageService.getMcpServers(null);
      const nextMap = {};
      for (const server of globalServers) {
        nextMap[server.id] = {
          command: server.command,
          args: server.args,
          env: server.env,
          url: server.url,
          transport: server.transport,
          headers: server.headers,
          authToken: server.authToken,
          disabledTools: server.disabledTools,
          description: server.description,
          enabled: server.id === id ? Boolean(enabled) : server.enabled,
        };
      }
      if (!nextMap[id]) return { success: false, error: "未找到该全局 MCP 服务器" };
      storageService.saveGlobalMcpServers(nextMap);
      mcpClientService.reloadClients();
      return { success: true };
    })
  );

  // 删除全局 MCP 服务器（项目级配置由项目文件托管，不在此处改写）
  ipcMain.handle(
    "delete-mcp-server",
    safeHandler((event, { id } = {}) => {
      const result = storageService.deleteGlobalMcpServer(id);
      if (result?.success) mcpClientService.reloadClients();
      return result;
    })
  );

  ipcMain.handle(
    "get-mcp-tools",
    safeHandler((event, { serverId, workDir } = {}) =>
      mcpClientService.getServerTools(serverId, workDir)
    )
  );

  // 工具级启停：仅改写全局 MCP 配置，项目级配置保持文件托管
  ipcMain.handle(
    "toggle-mcp-tool",
    safeHandler((event, { serverId, toolName, enabled, workDir } = {}) => {
      if (!serverId || !toolName) {
        return { success: false, error: "缺少服务器或工具名称" };
      }
      const allServers = storageService.getMcpServers(workDir);
      const target = allServers.find((server) => server.id === serverId);
      if (!target) return { success: false, error: "未找到该 MCP 服务器" };
      if (target.source === "project") {
        return {
          success: false,
          error: "项目级 MCP 的工具权限请直接编辑项目 .omcx/mcp.json",
        };
      }

      const globalServers = storageService.getMcpServers(null);
      const nextMap = {};
      for (const server of globalServers) {
        const disabled = new Set(
          Array.isArray(server.disabledTools) ? server.disabledTools : []
        );
        if (server.id === serverId) {
          if (enabled) disabled.delete(toolName);
          else disabled.add(toolName);
        }
        nextMap[server.id] = {
          command: server.command,
          args: server.args,
          env: server.env,
          url: server.url,
          transport: server.transport,
          headers: server.headers,
          authToken: server.authToken,
          disabledTools: Array.from(disabled),
          description: server.description,
          enabled: server.enabled,
        };
      }
      storageService.saveGlobalMcpServers(nextMap);
      mcpClientService.reloadClients();
      return { success: true, disabledTools: nextMap[serverId]?.disabledTools || [] };
    })
  );

  ipcMain.handle(
    "list-mcp-resources",
    safeHandler((event, workDir) => mcpClientService.listResources(workDir))
  );

  ipcMain.handle(
    "read-mcp-resource",
    safeHandler((event, { uri, workDir } = {}) =>
      mcpClientService.readResource(uri, workDir)
    )
  );

  ipcMain.handle(
    "list-mcp-prompts",
    safeHandler((event, { workDir } = {}) => mcpClientService.listPrompts(workDir))
  );
  ipcMain.handle(
    "get-mcp-prompt",
    safeHandler((event, { serverId, promptName, args, workDir } = {}) =>
      mcpClientService.getPrompt(serverId, promptName, args, workDir)
    )
  );

  // --- P0: MCP OAuth 2.1 授权（授权码 + PKCE + 动态客户端注册） ---
  ipcMain.handle(
    "mcp-oauth-status",
    safeHandler((event, { workDir } = {}) =>
      storageService
        .getMcpServers(workDir)
        .filter((server) => server.url)
        .map((server) => ({
          serverId: server.id,
          ...mcpOAuthService.getStatus(server),
        }))
    )
  );
  ipcMain.handle(
    "mcp-oauth-authorize",
    safeHandler(async (event, { serverId, workDir } = {}) => {
      const server = storageService
        .getMcpServers(workDir)
        .find((item) => item.id === serverId);
      if (!server) return { success: false, error: `MCP 服务器不存在: ${serverId}` };
      const result = await mcpOAuthService.authorize(server, {
        openExternal: (url) => shell.openExternal(url),
      });
      if (result.success) mcpClientService.reloadClients();
      return result;
    })
  );
  ipcMain.handle(
    "mcp-oauth-logout",
    safeHandler((event, { serverId, workDir } = {}) => {
      const server = storageService
        .getMcpServers(workDir)
        .find((item) => item.id === serverId);
      if (!server) return { success: false, error: `MCP 服务器不存在: ${serverId}` };
      const result = mcpOAuthService.logout(server);
      mcpClientService.reloadClients();
      return result;
    })
  );

  ipcMain.handle(
    "get-skills",
    safeHandler((event, payload) => {
      const workDir =
        typeof payload === "string" ? payload : payload?.workDir || null;
      const includeDisabled =
        payload && typeof payload === "object" ? Boolean(payload.includeDisabled) : false;
      return storageService.getSkills(workDir, { includeDisabled });
    })
  );

  // 技能启停：仅写入 disabled_skills 配置，不改动磁盘文件
  ipcMain.handle(
    "toggle-skill",
    safeHandler((event, { name, enabled } = {}) =>
      storageService.setSkillEnabled(name, Boolean(enabled))
    )
  );

  // 删除技能：严格限制在全局 / 项目技能根目录内
  ipcMain.handle(
    "delete-skill",
    safeHandler((event, { filePath, workDir } = {}) =>
      storageService.deleteSkill({ filePath, workDir })
    )
  );

  // 导入本地技能：支持 .md / .zip / 文件夹；sourcePath 可复用上一次选择，避免重复弹窗
  ipcMain.handle(
    "import-skill",
    safeHandler(async (event, { mode = "file", sourcePath, overwrite = false, workDir, scope } = {}) => {
      let target = sourcePath;
      if (!target) {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: mode === "folder" ? "选择技能文件夹" : "选择技能文件（.md / .zip）",
          properties: mode === "folder" ? ["openDirectory"] : ["openFile"],
          filters:
            mode === "folder"
              ? undefined
              : [{ name: "技能文件", extensions: ["md", "zip"] }],
        });
        if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
        target = result.filePaths[0];
      }
      const resolvedScope = scope === "project" ? "project" : "global";
      return storageService.importSkill(target, {
        overwrite: Boolean(overwrite),
        workDir: resolvedScope === "project" ? workDir : null,
        scope: resolvedScope,
      });
    })
  );

  // 技能市场：链接自适应分页拉取
  ipcMain.handle(
    "fetch-skill-market",
    safeHandler((event, payload = {}) =>
      skillMarketService.fetchMarketPage({
        url: payload.url,
        page: payload.page,
        pageSize: payload.pageSize,
        query: payload.query,
      })
    )
  );

  // 技能市场：直接下载并安装到 ~/.omcx/skills
  ipcMain.handle(
    "install-market-skill",
    safeHandler((event, { item, overwrite = false } = {}) =>
      skillMarketService.installSkill(item, { overwrite: Boolean(overwrite) })
    )
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
    safeHandler((event, sessionId) => storageService.getSessionOutputsAsync(sessionId))
  );

  // --- 会话文件检查点与一键回滚 ---
  ipcMain.handle(
    "get-session-checkpoints",
    safeHandler((event, sessionId) => checkpointService.listCheckpoints(sessionId))
  );

  ipcMain.handle(
    "get-session-checkpoint",
    safeHandler((event, { sessionId, checkpointId } = {}) =>
      checkpointService.getCheckpoint(sessionId, checkpointId)
    )
  );

  ipcMain.handle(
    "restore-checkpoint",
    safeHandler((event, { sessionId, checkpointId } = {}) => {
      if (!sessionId || !checkpointId) {
        return { success: false, error: "缺少会话或检查点 ID" };
      }
      return checkpointService.restoreCheckpoint(sessionId, checkpointId);
    })
  );

  ipcMain.handle(
    "delete-checkpoint",
    safeHandler((event, { sessionId, checkpointId } = {}) =>
      checkpointService.deleteCheckpoint(sessionId, checkpointId)
    )
  );

  // --- 仓库索引与 Repo Wiki ---
  ipcMain.handle(
    "get-repo-index-stats",
    safeHandler((event, { workDir, refresh } = {}) =>
      repoIndexService.getRepoStats(workDir, { force: Boolean(refresh) })
    )
  );

  ipcMain.handle(
    "get-repo-map",
    safeHandler((event, { workDir, maxChars, refresh } = {}) =>
      repoIndexService.buildRepoMap(workDir, {
        maxChars: Number(maxChars) || 6000,
        force: Boolean(refresh),
      })
    )
  );

  ipcMain.handle(
    "search-repo-symbols",
    safeHandler((event, { workDir, query, limit } = {}) =>
      repoIndexService.searchSymbols(workDir, query, { limit: Number(limit) || 40 })
    )
  );

  ipcMain.handle(
    "get-repo-wiki",
    safeHandler((event, workDir) => repoWikiService.getRepoWiki(workDir))
  );

  ipcMain.handle(
    "generate-repo-wiki",
    safeHandler(async (event, { workDir, model } = {}) => {
      const session = storageService
        .getSessions()
        .find((item) => item.workDir === workDir || item.work_dir === workDir);
      const modelId = model || session?.model || storageService.getConfig("default_model");
      const cfg = getModelConfig(modelId, "gpt-4o");
      if (!cfg.modelApiKey && cfg.provider !== "ollama") {
        return { success: false, error: "请先在【设置】中为当前模型配置 API Key" };
      }
      return repoWikiService.generateRepoWiki({
        workDir,
        modelConfig: {
          provider: cfg.provider,
          base_url: cfg.modelBaseUrl,
          api_key: cfg.modelApiKey,
          model_id: cfg.apiModelId,
          max_output_tokens: cfg.maxOutputTokens,
        },
      });
    })
  );

  ipcMain.handle(
    "get-context-metrics",
    safeHandler(async (event, params = {}) => {
      // 若提供了 sessionId 或指定了工作目录，则根据当前真实工程上下文进行精准计算
      if (params.sessionId || params.workDir) {
        const session = params.sessionId
          ? storageService.getSessions().find((s) => s.id === params.sessionId)
          : null;
        const targetWorkDir =
          (params.workDir && String(params.workDir).trim()) ||
          session?.workDir ||
          session?.work_dir ||
          null;
        const sessionPermissionMode =
          params.permissionMode || session?.permissionMode || "auto-sandbox";

        const rawMessages =
          Array.isArray(params.messages) && params.messages.length > 0
            ? params.messages
            : params.sessionId
            ? await storageService.getMessagesAsync(params.sessionId)
            : [];

        const { matchedWorkspace } = getWorkspaceFolders(targetWorkDir);
        const availableSkills = storageService.getSkills(targetWorkDir);
        const mcpTools = await mcpClientService.getActiveMcpTools(targetWorkDir);

        const tools = toolRegistry.getToolDefinitions(mcpTools, null, {
          permissionMode: sessionPermissionMode,
        });

        const toolDocs = toolRegistry.getToolPromptDocs(mcpTools, {
          permissionMode: sessionPermissionMode,
        });

        const memories = storageService.getMemories(targetWorkDir);
        const memoryIndex = storageService.getMemoryIndex(targetWorkDir);
        const projectRules = storageService.getProjectInstructions(targetWorkDir);
        const customSystemPrompt = storageService.getConfig("custom_system_prompt") || "";
        const gitInfo = await getGitSnapshotAsync(targetWorkDir);
        const initialTodos = session?.todos || [];
        const wikiInfo = targetWorkDir ? repoWikiService.getRepoWiki(targetWorkDir) : null;
        // 真实请求默认注入仓库地图，指标计算必须同源，否则会低估 System Prompt 占用
        let repoMapText = "";
        if (targetWorkDir && storageService.getConfig("repo_map_enabled") !== "false") {
          try {
            repoMapText = repoIndexService.buildRepoMap(targetWorkDir, {
              maxChars: Number(storageService.getConfig("repo_map_max_chars")) || 6000,
            });
          } catch (repoErr) {
            console.warn(`[repo-map] 指标计算生成失败: ${repoErr.message}`);
          }
        }

        const modelId =
          params.model ||
          session?.model ||
          storageService.getConfig("active_model") ||
          "";
        const models = storageService.getModels();
        const matchedModel = models.find((m) => m.id === modelId);
        const contextLimit =
          Number(params.maxTokensLimit) ||
          Number(matchedModel?.context_limit) ||
          1000000;

        const builtContext = buildSystemContext({
          workDir: targetWorkDir,
          matchedWorkspace,
          skills: availableSkills,
          memories,
          memoryIndex,
          projectRules,
          repoMap: repoMapText,
          repoWiki: wikiInfo?.exists ? String(wikiInfo.content || "").slice(0, 3500) : "",
          repoWikiPath: wikiInfo?.path || "",
          todos: initialTodos,
          toolDocs,
          model: modelId,
          enableTools: true,
          permissionMode: sessionPermissionMode,
          customSystemPrompt,
          gitInfo,
        });

        const skillsTokens =
          builtContext.sections.find((s) => s.name === "skills")?.tokens || 0;

        return calculateContextMetrics({
          messages: rawMessages,
          tools,
          systemPrompt: builtContext.text,
          skillsTokens,
          maxTokensLimit: contextLimit,
        });
      }

      return calculateContextMetrics(params);
    })
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
    "workspace-get-branches",
    safeHandler((event, workDir) => getWorkspaceBranches(workDir))
  );

  ipcMain.handle(
    "workspace-checkout-branch",
    safeHandler((event, { workDir, branchName, createNew }) =>
      checkoutWorkspaceBranch(workDir, branchName, createNew)
    )
  );

  // --- P1: 斜杠命令 ---
  ipcMain.handle(
    "get-slash-commands",
    safeHandler((event, { workDir } = {}) => commandService.listCommands(workDir))
  );

  // --- P1: Quest / 规格模式文档 ---
  ipcMain.handle(
    "spec-list",
    safeHandler((event, { workDir } = {}) => specService.listSpecs(workDir))
  );
  ipcMain.handle(
    "spec-read",
    safeHandler((event, { workDir, id } = {}) => specService.readSpec(workDir, id))
  );
  ipcMain.handle(
    "spec-save",
    safeHandler((event, payload = {}) =>
      specService.saveSpec(payload.workDir, payload)
    )
  );
  ipcMain.handle(
    "spec-update-status",
    safeHandler((event, { workDir, id, status } = {}) =>
      specService.updateSpecStatus(workDir, id, status)
    )
  );
  ipcMain.handle(
    "spec-delete",
    safeHandler((event, { workDir, id } = {}) => specService.deleteSpec(workDir, id))
  );

  // --- P1: Git Hunk 级暂存与 PR ---
  ipcMain.handle(
    "git-get-file-hunks",
    safeHandler((event, { workDir, filePath, staged } = {}) =>
      gitHunkService.getFileHunks(workDir, filePath, Boolean(staged))
    )
  );
  ipcMain.handle(
    "git-apply-hunks",
    safeHandler((event, { workDir, filePath, hunkIds, staged, reverse, target } = {}) =>
      gitHunkService.applyHunks(workDir, filePath, hunkIds, {
        staged: Boolean(staged),
        reverse: Boolean(reverse),
        target: target === "worktree" ? "worktree" : "index",
      })
    )
  );
  ipcMain.handle(
    "git-discard-hunks",
    safeHandler((event, { workDir, filePath, hunkIds } = {}) =>
      gitHunkService.applyHunks(workDir, filePath, hunkIds, {
        target: "worktree",
        reverse: true,
      })
    )
  );
  ipcMain.handle(
    "git-discard-file",
    safeHandler((event, { workDir, filePath, staged } = {}) =>
      gitHunkService.discardFile(workDir, filePath, { staged: Boolean(staged) })
    )
  );
  ipcMain.handle(
    "git-stage-file",
    safeHandler((event, { workDir, filePath } = {}) =>
      gitHunkService.stageFile(workDir, filePath)
    )
  );
  ipcMain.handle(
    "git-unstage-file",
    safeHandler((event, { workDir, filePath } = {}) =>
      gitHunkService.unstageFile(workDir, filePath)
    )
  );
  ipcMain.handle(
    "git-stage-all",
    safeHandler((event, { workDir } = {}) => gitHunkService.stageAll(workDir))
  );
  ipcMain.handle(
    "git-create-pr",
    safeHandler((event, payload = {}) => gitHunkService.createPullRequest(payload.workDir, payload))
  );

  // --- P1: Git Worktree 隔离 ---
  ipcMain.handle(
    "git-worktree-list",
    safeHandler((event, { workDir } = {}) => gitWorktreeService.listWorktrees(workDir))
  );
  ipcMain.handle(
    "git-worktree-create",
    safeHandler((event, payload = {}) =>
      gitWorktreeService.createWorktree(payload.workDir, payload)
    )
  );
  ipcMain.handle(
    "git-worktree-remove",
    safeHandler((event, { workDir, targetPath, force } = {}) =>
      gitWorktreeService.removeWorktree(workDir, targetPath, { force: Boolean(force) })
    )
  );

  // --- P1: 项目诊断与测试运行 ---
  ipcMain.handle(
    "get-project-tasks",
    safeHandler((event, { workDir } = {}) => diagnosticsService.detectTasks(workDir))
  );
  ipcMain.handle(
    "run-project-task",
    safeHandler((event, { workDir, taskId, timeoutMs } = {}) =>
      diagnosticsService.runTask(workDir, taskId, { timeoutMs })
    )
  );

  // --- P1: 生命周期 Hooks ---
  ipcMain.handle(
    "get-project-hooks",
    safeHandler((event, { workDir } = {}) => {
      const info = hookService.listHooks(workDir, {
        projectTrusted: storageService.isProjectHooksTrusted(workDir),
      });
      return {
        ...info,
        enabled: storageService.getConfig("hooks_enabled") !== "false",
        globalExists: fs.existsSync(info.globalPath),
      };
    })
  );
  ipcMain.handle(
    "create-hooks-template",
    safeHandler(() => {
      const target = hookService.hooksFilePath(null, "global");
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          JSON.stringify(
            {
              hooks: {
                UserPromptSubmit: [],
                PreToolUse: [],
                PostToolUse: [],
                Stop: [],
              },
              _readme:
                "Hook 配置：command 通过 stdin 接收 JSON，退出码 0 继续，2 阻断；也可输出 {decision:'block',reason,additionalContext}。项目级 hooks 位于 <workDir>/.omcx/hooks.json，需在设置中显式信任。",
            },
            null,
            2
          ),
          "utf-8"
        );
      }
      return { success: true, filePath: target };
    })
  );
  ipcMain.handle(
    "set-project-hooks-trust",
    safeHandler((event, { workDir, trusted } = {}) =>
      storageService.setProjectHooksTrust(workDir, Boolean(trusted))
    )
  );

  // --- P2: 运行观测（trace / 成本 / 成功率）---
  ipcMain.handle(
    "telemetry-get-stats",
    safeHandler((event, { sinceMs, source } = {}) =>
      telemetryService.getStats({ sinceMs, source })
    )
  );
  ipcMain.handle(
    "telemetry-list-runs",
    safeHandler((event, { limit, offset, source, sinceMs } = {}) =>
      telemetryService.listRuns({ limit, offset, source, sinceMs })
    )
  );
  ipcMain.handle(
    "telemetry-get-run",
    safeHandler((event, { id } = {}) => telemetryService.getRun(id))
  );
  ipcMain.handle(
    "telemetry-clear",
    safeHandler(() => telemetryService.clearAll())
  );

  // --- P2: 评测集 ---
  const resolveEvalModelConfig = (modelId) => {
    const cfg = getModelConfig(modelId, "gpt-4o");
    return {
      baseUrl: cfg.modelBaseUrl,
      apiKey: cfg.modelApiKey,
      provider: cfg.provider,
      model: cfg.apiModelId,
      inputPrice: cfg.inputPrice,
      outputPrice: cfg.outputPrice,
      cacheReadPrice: cfg.cacheReadPrice,
      cacheWritePrice: cfg.cacheWritePrice,
    };
  };
  ipcMain.handle(
    "evals-list",
    safeHandler(() => evalService.listEvals())
  );
  ipcMain.handle(
    "eval-run",
    safeHandler((event, { evalId, model, maxRounds } = {}) =>
      evalService.runEval(evalId, {
        modelConfig: resolveEvalModelConfig(model),
        maxRounds,
      })
    )
  );
  ipcMain.handle(
    "eval-run-all",
    safeHandler((event, { model, ids, maxRounds } = {}) =>
      evalService.runAll({
        modelConfig: resolveEvalModelConfig(model),
        ids,
        maxRounds,
      })
    )
  );

  // --- P2: 内置浏览器自动化 ---
  ipcMain.handle(
    "browser-auto-open",
    safeHandler((event, { url, workDir } = {}) => browserAutomationService.open({ url, workDir }))
  );
  ipcMain.handle(
    "browser-auto-interact",
    safeHandler((event, payload = {}) => browserAutomationService.interact(payload))
  );
  ipcMain.handle(
    "browser-auto-snapshot",
    safeHandler((event, payload = {}) => browserAutomationService.snapshot(payload))
  );
  ipcMain.handle(
    "browser-auto-save-baseline",
    safeHandler((event, payload = {}) => browserAutomationService.saveBaseline(payload))
  );
  ipcMain.handle(
    "browser-auto-state",
    safeHandler(() => browserAutomationService.getState())
  );
  ipcMain.handle(
    "browser-auto-back",
    safeHandler(() => browserAutomationService.back())
  );
  ipcMain.handle(
    "browser-auto-forward",
    safeHandler(() => browserAutomationService.forward())
  );
  ipcMain.handle(
    "browser-auto-reload",
    safeHandler((event, payload = {}) => browserAutomationService.reload(payload))
  );
  ipcMain.handle(
    "browser-auto-close",
    safeHandler(() => browserAutomationService.close())
  );

  // --- P1: 会话分支与导出 ---
  ipcMain.handle(
    "fork-session",
    safeHandler((event, { sessionId, upToMessageId } = {}) =>
      sessionTransferService.forkSession(sessionId, { upToMessageId })
    )
  );
  ipcMain.handle(
    "export-session",
    safeHandler(async (event, { sessionId } = {}) => {
      const built = sessionTransferService.buildSessionMarkdown(sessionId);
      if (!built.success) return built;
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win, {
        title: "导出会话为 Markdown",
        defaultPath: built.suggestedFileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      fs.writeFileSync(result.filePath, built.markdown, "utf-8");
      return { success: true, filePath: result.filePath };
    })
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
        // 1. 尝试在当前工作空间挂载的全部源目录中直接匹配
        for (const folder of validFolders) {
          const candidate = path.resolve(folder, filePath);
          if (fs.existsSync(candidate)) {
            targetAbs = candidate;
            break;
          }
        }
      }

      // 2. 智能多源目录穿透与深度后缀寻址 (处理大模型引用可能省略顶层或包含局部路径的情况)
      if (!fs.existsSync(targetAbs)) {
        const normRel = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
        const firstSlash = normRel.indexOf("/");

        // 若大模型在相对路径中带了模块名（如 cmdb-api-v2/core/...），尝试剥离第一层在各挂载源下匹配
        if (firstSlash > 0) {
          const withoutFirst = normRel.slice(firstSlash + 1);
          for (const folder of validFolders) {
            const cand = path.resolve(folder, withoutFirst);
            if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              targetAbs = cand;
              break;
            }
          }
        }

        // 3. 递归模糊后缀与文件名穿透匹配 (彻底解决深层微服务子目录如 notify_v2/runner/life_runner.py)
        if (!fs.existsSync(targetAbs)) {
          const IGNORED = new Set([
            ".git",
            "node_modules",
            ".venv",
            "venv",
            "__pycache__",
            "dist",
            "build",
            ".next",
            ".nuxt",
            "target",
            "vendor",
            "Pods",
            "coverage",
            ".cache",
            ".omcx",
            ".vscode",
          ]);
          const targetSuffix = "/" + normRel;
          const targetFileName = normRel.split("/").pop();
          // 主进程同步遍历必须设上限：大仓库（尤其含构建产物/依赖目录）下无界 BFS 会直接冻结 UI
          const MAX_SCAN_ENTRIES = 30000;
          const MAX_SCAN_MS = 1500;
          const scanStartedAt = Date.now();
          let scannedEntries = 0;
          let suffixMatch = "";
          let filenameFallback = "";

          for (const folder of validFolders) {
            if (suffixMatch) break;
            const queue = [folder];
            while (queue.length > 0 && !suffixMatch) {
              if (
                scannedEntries > MAX_SCAN_ENTRIES ||
                Date.now() - scanStartedAt > MAX_SCAN_MS
              ) {
                break;
              }
              const curDir = queue.shift();
              let entries = [];
              try {
                entries = fs.readdirSync(curDir);
              } catch {
                continue;
              }
              for (const item of entries) {
                if (item.startsWith(".") || IGNORED.has(item)) continue;
                scannedEntries += 1;
                const full = path.join(curDir, item);
                let stat;
                try {
                  stat = fs.statSync(full);
                } catch {
                  continue;
                }
                if (stat.isDirectory()) {
                  queue.push(full);
                } else if (stat.isFile()) {
                  const normFull = full.replace(/\\/g, "/");
                  // 优先完整后缀匹配；同名文件只作为兜底候选，避免浅层同名文件抢先命中
                  if (normFull.endsWith(targetSuffix)) {
                    suffixMatch = full;
                    break;
                  }
                  if (!filenameFallback && item === targetFileName) {
                    filenameFallback = full;
                  }
                }
              }
              if (
                scannedEntries > MAX_SCAN_ENTRIES ||
                Date.now() - scanStartedAt > MAX_SCAN_MS
              ) {
                break;
              }
            }
          }

          targetAbs = suffixMatch || filenameFallback || targetAbs;
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

      // 安全加固：基于 realpath 做目录包含性校验，禁止渲染进程越权读取工作空间外的任意文件
      const realTarget = resolveRealPathSafe(targetAbs) || targetAbs;
      const insideWorkspace = validFolders.some((folder) => isUnderFolderReal(realTarget, folder));
      const isTrustedBuiltin = isBuiltinTrustedPath(realTarget);
      const isAttachment = storageService.isSessionAttachmentPath(realTarget);
      const isKnownOutput = isKnownSessionOutputPath(realTarget);
      if (!insideWorkspace && !isTrustedBuiltin && !isAttachment && !isKnownOutput) {
        return { success: false, error: `安全策略已拒绝访问工作空间外部路径: ${filePath}` };
      }

      const safeMaxChars = Number.isFinite(Number(maxChars))
        ? Math.max(1000, Math.min(1000000, Math.floor(Number(maxChars))))
        : 250000;
      const readBytes = Math.min(stat.size, safeMaxChars * 4);
      const fd = fs.openSync(realTarget, "r");
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
          resolvedPath: targetAbs,
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
        resolvedPath: targetAbs,
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

  // --- 原生 PTY 交互式终端 (支持 REPL/vim/ssh/Ctrl+C 与窗口尺寸联动) ---
  ipcMain.handle(
    "terminal-create",
    safeHandler((event, params = {}) => {
      const result = terminalPtyService.create(params);
      if (result.success) {
        terminalPtyService.bindSender(result.terminalId, event.sender);
      }
      return result;
    })
  );

  ipcMain.on("terminal-input", (event, { terminalId, data } = {}) => {
    terminalPtyService.write(terminalId, data);
  });

  ipcMain.handle(
    "terminal-resize",
    safeHandler((event, { terminalId, cols, rows } = {}) =>
      terminalPtyService.resize(terminalId, cols, rows)
    )
  );

  ipcMain.handle(
    "terminal-dispose",
    safeHandler((event, terminalId) => terminalPtyService.dispose(terminalId))
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

  // 直接工具执行通道：仅开放只读工具，写文件/执行命令等高危能力必须走完整的 Agent 会话链路
  const DIRECT_READONLY_TOOLS = new Set([
    "read_file",
    "list_directory",
    "search_code",
    "search_symbols",
    "repo_map",
  ]);
  ipcMain.handle(
    "execute-tool",
    safeHandler(async (event, { name, args, workDir } = {}) => {
      if (!DIRECT_READONLY_TOOLS.has(name)) {
        return {
          success: false,
          error: `execute-tool 仅支持只读工具 (${Array.from(DIRECT_READONLY_TOOLS).join(", ")})，写操作请通过 Agent 会话执行`,
        };
      }
      const resolvedWorkDir =
        workDir && typeof workDir === "string" && fs.existsSync(workDir)
          ? path.resolve(workDir)
          : null;
      const context = {
        sessionId: null,
        workDir: resolvedWorkDir,
        allowedFolders: resolvedWorkDir ? [resolvedWorkDir] : [],
        permissionMode: PERMISSION_MODES.PLAN,
        checkPermission: null,
      };
      return await toolRegistry.execute(name, args || {}, context);
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
      const isAnthropicEndpoint =
        params.provider === "anthropic" ||
        /anthropic\.com|claude/i.test(activeBaseUrl);
      if (activeApiKey) {
        if (isAnthropicEndpoint) {
          headers["x-api-key"] = activeApiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${activeApiKey}`;
        }
      }

      try {
        const fetchUrl = isAnthropicEndpoint
          ? /\/v1$/i.test(activeBaseUrl)
            ? `${activeBaseUrl}/models`
            : `${activeBaseUrl}/v1/models`
          : `${activeBaseUrl}/models`;
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
  const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
  ipcMain.on("chat-permission-response", (event, { id, allow, decision }) => {
    const entry = pendingPermissions.get(id);
    if (entry) {
      pendingPermissions.delete(id);
      entry.settle({
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

      // 取消时必须同步终结该会话所有挂起的权限审批，否则 Agent 会永久卡在 await 上，
      // 导致 finally 不执行、快照不落盘、会话被误判为持续运行。
      let rejectedPermissions = 0;
      for (const [permId, entry] of pendingPermissions) {
        if (entry.sessionId !== sessionId) continue;
        pendingPermissions.delete(permId);
        try {
          entry.settle({ allow: false, decision: "cancelled", reason: "用户已取消本次执行" });
        } catch (e) {}
        rejectedPermissions += 1;
      }

      console.log(
        `[chat-cancel] session ${sessionId} cancellation requested` +
          (rejectedPermissions > 0 ? ` (rejected ${rejectedPermissions} pending permissions)` : "")
      );
    }
  });

  // --- 中途动态转向 (Mid-flight Steering) ---
  // 用户在 Agent 执行期间追加的纠偏/补充指示，不打断当前工具链，
  // 而是暂存于该会话的执行上下文，在下一轮工具循环发起模型请求前注入为 user 消息。
  ipcMain.on("chat-steer", (event, { sessionId, id, content } = {}) => {
    const text = String(content || "").trim();
    if (!sessionId || !text) return;
    const active = activeStreamSessions.get(sessionId);
    if (!active || active.cancelled) {
      // 会话已结束或已取消，返回未被接收的信号，由前端回退为普通排队任务
      event.reply("chat-steer-rejected", { sessionId, id, content: text });
      return;
    }
    if (!Array.isArray(active.steerQueue)) active.steerQueue = [];
    active.steerQueue.push({ id: id || `steer_${Date.now()}`, content: text, at: Date.now() });
    console.log(`[chat-steer] session ${sessionId} queued steering injection (pending=${active.steerQueue.length})`);
  });

  // ─── 全局单一多路复用流式 IPC 总线派发助手 (chat-stream-event) ───────
  // 彻底消灭动态拼接频道 (chat-stream-xxx-sessionId) 导致的内存泄漏与乱序
  function sendStreamEvent(sender, sessionId, type, data, runId = null) {
    if (!sender || (sender.isDestroyed && sender.isDestroyed())) return;
    try {
      sender.send("chat-stream-event", { sessionId, runId, type, data });
    } catch (e) {
      // 忽略已关闭窗口异常
    }
  }

  // ─── 旁路问答 (/btw) ────────────────────────────────────────
  // 与 chat-request 完全隔离：独立事件总线、独立 AbortController、不写会话、不触发压缩/标题/产物。
  const activeBtwSessions = new Map();
  const BTW_READONLY_TOOL_NAMES = new Set([
    "read_file",
    "search_code",
    "find_references",
    "repo_map",
  ]);

  function sendBtwEvent(sender, envelope, type, data) {
    if (!sender || (sender.isDestroyed && sender.isDestroyed())) return;
    try {
      sender.send("btw-stream-event", { ...envelope, type, data });
    } catch (e) {
      // 忽略已关闭窗口异常
    }
  }

  ipcMain.handle("btw-request", async (event, payload = {}) => {
    const sessionId = String(payload.sessionId || "").trim();
    const btwId = String(payload.btwId || "").trim();
    const runId = String(payload.runId || "").trim();
    const question = String(payload.question || "").trim();

    if (!sessionId || !btwId || !question) {
      return { ok: false, error: "旁路请求参数不完整" };
    }

    // 同一会话只保留一条旁路请求：新请求先中断旧请求（与主任务完全无关）
    for (const [existingId, existing] of activeBtwSessions) {
      if (existing.sessionId !== sessionId) continue;
      try {
        existing.controller.abort();
      } catch {}
      activeBtwSessions.delete(existingId);
      sendBtwEvent(existing.sender, existing.envelope, "end", {
        cancelled: true,
        superseded: true,
        content: "",
      });
    }

    const {
      modelBaseUrl,
      modelApiKey,
      provider,
      apiModelId,
      maxOutputTokens,
    } = getModelConfig(payload.model, "gpt-4o");

    if (!modelApiKey && provider !== "ollama") {
      return { ok: false, error: "请先在【设置】中配置该模型的 API Key" };
    }

    const session = storageService.getSessions().find((s) => s.id === sessionId);
    let workDir =
      payload.workDir && typeof payload.workDir === "string" && payload.workDir.trim()
        ? payload.workDir.trim()
        : session?.work_dir || null;
    if (workDir && !fs.existsSync(workDir)) workDir = null;

    const { allowedFolders } = getWorkspaceFolders(workDir);

    // @file / @dir 内联：仅允许工作空间内路径；无审批 UI，越界引用直接跳过
    let userContent = question;
    if (workDir) {
      try {
        const mention = buildMentionContext(question, workDir, allowedFolders, {
          skills: [],
          mcpServers: [],
        });
        if (mention?.block) {
          userContent = `${mention.block}\n\n【旁路问题】\n${question}`;
        }
        if (Array.isArray(mention?.skipped) && mention.skipped.length > 0) {
          console.log(`[btw] 跳过 ${mention.skipped.length} 个无法解析的 @ 引用`);
        }
      } catch (err) {
        console.warn("[btw] @ 引用解析失败，回退原始问题:", err.message);
      }
    }

    // 主会话选中片段：只作为旁路问题的只读引用，永不写回主会话
    const quotedText = String(payload.quotedText || "").trim().slice(0, 8000);

    const controller = new AbortController();
    const envelope = { sessionId, btwId, runId };    const entry = {
      sessionId,
      btwId,
      runId,
      controller,
      sender: event.sender,
      envelope,
    };
    activeBtwSessions.set(btwId, entry);

    const abortTimer = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, 6 * 60 * 1000);

    const onSenderDestroyed = () => {
      try {
        controller.abort();
      } catch {}
    };
    try {
      event.sender.once("destroyed", onSenderDestroyed);
    } catch {}

    const toolDefinitions = toolRegistry.getToolDefinitions(
      [],
      BTW_READONLY_TOOL_NAMES,
      { permissionMode: PERMISSION_MODES.PLAN }
    );

    const toolContext = {
      sessionId: `${sessionId}::btw::${btwId}`,
      workDir,
      allowedFolders,
      writableFolders: [],
      permissionMode: PERMISSION_MODES.PLAN,
      // 旁路通道没有权限审批弹窗：外部路径读取直接拒绝，工具会返回明确错误
      checkPermission: null,
      allowedToolNames: BTW_READONLY_TOOL_NAMES,
      abortSignal: controller.signal,
      mcpTools: [],
      modelConfig: {
        baseUrl: modelBaseUrl,
        apiKey: modelApiKey,
        provider,
        modelName: apiModelId,
      },
    };

    void (async () => {
      try {
        const result = await btwService.runBtw({
          question: userContent,
          quotedText,
          digest: payload.contextDigest,
          history: Array.isArray(payload.history) ? payload.history : [],
          workDir,
          modelConfig: {
            baseUrl: modelBaseUrl,
            apiKey: modelApiKey,
            provider,
            modelName: apiModelId,
            maxOutputTokens,
          },
          toolDefinitions,
          toolContext,
          allowedToolNames: BTW_READONLY_TOOL_NAMES,
          toolRegistry,
          abortSignal: controller.signal,
          onDelta: (delta) => sendBtwEvent(event.sender, envelope, "data", delta),
          onToolStatus: (status) =>
            sendBtwEvent(event.sender, envelope, "tool_status", status),
        });

        if (controller.signal.aborted || result.cancelled) {
          sendBtwEvent(event.sender, envelope, "end", {
            cancelled: true,
            content: result.content || "",
            usage: result.usage || null,
            rounds: result.rounds,
          });
        } else {
          sendBtwEvent(event.sender, envelope, "end", {
            cancelled: false,
            content: result.content || "",
            usage: result.usage || null,
            rounds: result.rounds,
            hitRoundLimit: Boolean(result.hitRoundLimit),
          });
        }
        console.log(
          `[btw] ${btwId} 完成：${result.rounds} 轮，${result.content?.length || 0} 字符`
        );
      } catch (err) {
        const cancelled = controller.signal.aborted;
        if (cancelled) {
          sendBtwEvent(event.sender, envelope, "end", {
            cancelled: true,
            content: "",
          });
        } else {
          console.error("[btw] 请求失败:", err?.message || err);
          sendBtwEvent(event.sender, envelope, "error", {
            message: err?.message || String(err),
          });
        }
      } finally {
        clearTimeout(abortTimer);
        try {
          event.sender.removeListener("destroyed", onSenderDestroyed);
        } catch {}
        if (activeBtwSessions.get(btwId) === entry) {
          activeBtwSessions.delete(btwId);
        }
      }
    })();

    return { ok: true, btwId };
  });

  ipcMain.handle("btw-cancel", async (_event, { btwId } = {}) => {
    const entry = activeBtwSessions.get(String(btwId || "").trim());
    if (!entry) return { ok: true, alreadyEnded: true };
    try {
      entry.controller.abort();
    } catch {}
    return { ok: true };
  });

  // --- 流式聊天与 Agent 执行循环 ---
  ipcMain.on(
    "chat-request",
    async (
      event,
      {
        sessionId,
        runId,
        messages,
        model,
        enableTools,
        workDir,
        assistantMsgId,
        permissionMode,
        reasoningEffort,
      }
    ) => {
      // 统一双轨流式派发器：主通道走 chat-stream-event 多路复用总线，副通道向下兼容
      const replyStream = (type, data) => {
        sendStreamEvent(event.sender, sessionId, type, data, runId);
        try {
          if (type === "data") event.reply(`chat-stream-data-${sessionId}`, data);
          else if (type === "tool_status") event.reply(`chat-stream-tool-status-${sessionId}`, data);
          else if (type === "todos") event.reply(`chat-stream-todos-${sessionId}`, data);
          else if (type === "metrics") event.reply(`chat-stream-context-metrics-${sessionId}`, data);
          else if (type === "compaction") event.reply(`chat-stream-compaction-${sessionId}`, data);
          else if (type === "steered") event.reply(`chat-stream-steered-${sessionId}`, data);
          else if (type === "waiting") event.reply(`chat-stream-waiting-${sessionId}`, data);
          else if (type === "permission") event.reply(`chat-permission-request-${sessionId}`, data);
          else if (type === "outputs") event.reply(`session-outputs-updated-${sessionId}`, data);
          else if (type === "end") event.reply(`chat-stream-end-${sessionId}`, data);
          else if (type === "error") event.reply(`chat-stream-error-${sessionId}`, data);
        } catch (e) {}
      };

      const {
        modelBaseUrl,
        modelApiKey,
        provider,
        apiModelId,
        contextLimit,
        maxOutputTokens,
        supportsVision,
        inputPrice,
        outputPrice,
        cacheReadPrice,
        cacheWritePrice,
      } = getModelConfig(model, "gpt-4o");

      if (!modelApiKey && provider !== "ollama") {
        replyStream("error", "请先在【设置】中配置该模型的 API Key");
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
      // 同一会话并发请求时，新 run 必须先中断旧 run，避免两个 Agent 循环同时写同一份快照。
      const previousRun = activeStreamSessions.get(sessionId);
      if (previousRun && !previousRun.cancelled) {
        previousRun.cancelled = true;
        try {
          previousRun.abortController.abort();
        } catch (e) {}
        // 并发抢占同样要终结旧 run 挂起的权限审批：否则旧工具调用会永久卡在 await 上，
        // 即使前端已切换到新 run，也可能残留幽灵审批弹窗。
        for (const [permId, entry] of pendingPermissions) {
          if (entry.sessionId !== sessionId) continue;
          pendingPermissions.delete(permId);
          try {
            entry.settle({
              allow: false,
              decision: "superseded",
              reason: "新的执行请求已接管当前会话，旧审批自动作废",
            });
          } catch (e) {}
          try {
            if (!event.sender.isDestroyed()) {
              replyStream("permission_resolved", {
                id: permId,
                reason: "新的执行请求已接管当前会话，旧审批自动作废",
              });
            }
          } catch (e) {}
        }
        console.warn(`[chat-request] session ${sessionId} 检测到并发请求，已中断上一轮 run`);
      }
      const sessionAbort = {
        runId,
        abortController: new AbortController(),
        cancelled: false,
        toolContext: null,
        steerQueue: [],
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
          let settled = false;
          let destroyedHandler = null;
          let timer = null;
          const settleOnce = (resp) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            pendingPermissions.delete(reqId);
            if (destroyedHandler) {
              try {
                event.sender.removeListener("destroyed", destroyedHandler);
              } catch {}
            }
            {
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
            }
          };

          // 主进程侧自动收敛时必须同步通知渲染进程关闭审批弹窗，避免 UI 挂着一个已经作废的请求
          const notifyResolved = (reason) => {
            try {
              if (!event.sender.isDestroyed()) {
                replyStream("permission_resolved", { id: reqId, reason });
              }
            } catch {}
          };

          // 审批不能无限挂起：渲染进程崩溃/窗口关闭/用户不再响应时必须自动收敛
          timer = setTimeout(() => {
            settleOnce({
              allow: false,
              decision: "deny",
              reason: "审批等待超时，已自动拒绝",
            });
            notifyResolved("审批等待超时，已自动拒绝");
          }, PERMISSION_TIMEOUT_MS);
          destroyedHandler = () => {
            settleOnce({
              allow: false,
              decision: "deny",
              reason: "窗口已关闭，审批自动作废",
            });
          };
          try {
            event.sender.once("destroyed", destroyedHandler);
          } catch {}

          pendingPermissions.set(reqId, { sessionId, settle: settleOnce });
          replyStream("permission", {
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
      let fullGeneratedReasoning = "";
      let toolRound = 0;
      const executedToolSteps = [];

      // ─── 运行快照落盘 (Crash-Safe Streaming Snapshot) ───
      // 运行中的 assistant 回合不再只存在于 renderer 内存：主进程按节流周期把当前正文、
      // 工具步骤与 Todo 写入 SQLite，并以 metadata.streaming = true 标记"进行中"。
      // 正常结束时由 renderer 以终稿覆盖；异常退出时由 before-quit / 下次启动归一化
      // 转为 interrupted 状态，确保中断前的执行轨迹与部分正文不丢失。
      const partialMessageId =
        assistantMsgId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const runStartedAt = Date.now();

      // P2 运行观测：记录 trace / token / 成本 / 成功率（仅本地 JSONL，不联网）
      const telemetryRun = telemetryService.startRun({
        sessionId,
        runId,
        model: apiModelId,
        provider,
        source: "chat",
      });

      // 回合累计用量与成本（声明在 try 之外，确保 catch/finally 的观测收尾可安全读取）
      let turnUsage = null;
      let turnCostUsd = 0;
      // 写入削峰保护：节流拉长至 4000ms，增量阈值提升至 2500 字符，
      // 关键里程碑（如工具调用完成/回合结束）仍会 force=true 即刻落盘。
      const PARTIAL_PERSIST_INTERVAL_MS = 4000;
      const PARTIAL_PERSIST_MIN_GROWTH = 2500;
      let lastPartialPersistAt = 0;
      let lastPartialPersistLength = 0;

      const formatRunDuration = (ms) => {
        const totalSec = Math.max(0, Math.floor(ms / 1000));
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m > 0 ? `${m}m ${s < 10 ? "0" : ""}${s}s` : `${s}s`;
      };

      // 运行快照写入 SQLite 时按结构裁剪：保留 result.data / error / success 等字段语义，
      // 仅压缩超长字符串与过深层级，避免每 1.2s 重复序列化全部历史工具输出造成写放大。
      const SNAPSHOT_MAX_TOOL_STEPS = 60;
      const SNAPSHOT_MAX_STRING_CHARS = 4000;
      const truncateSnapshotValue = (value, depth = 0) => {
        if (typeof value === "string") {
          return value.length > SNAPSHOT_MAX_STRING_CHARS
            ? `${value.slice(0, SNAPSHOT_MAX_STRING_CHARS)}…[快照截断，原始 ${value.length} 字符]`
            : value;
        }
        if (value === null || typeof value !== "object" || depth >= 6) return value;
        if (Array.isArray(value)) {
          return value.slice(0, 200).map((item) => truncateSnapshotValue(item, depth + 1));
        }
        const out = {};
        for (const [key, item] of Object.entries(value).slice(0, 100)) {
          out[key] = truncateSnapshotValue(item, depth + 1);
        }
        return out;
      };
      const buildSnapshotToolSteps = () =>
        executedToolSteps
          .slice(-SNAPSHOT_MAX_TOOL_STEPS)
          .map((step) => truncateSnapshotValue(step));

      const persistPartial = (force = false, overrides = {}) => {
        const now = Date.now();
        if (!force && now - lastPartialPersistAt < PARTIAL_PERSIST_INTERVAL_MS) return;
        if (
          !force &&
          fullGeneratedText.length - lastPartialPersistLength < PARTIAL_PERSIST_MIN_GROWTH
        ) {
          return;
        }
        lastPartialPersistAt = now;
        lastPartialPersistLength = fullGeneratedText.length;
        try {
          storageService.addMessage(sessionId, {
            id: partialMessageId,
            role: "assistant",
            content: fullGeneratedText,
            reasoning: fullGeneratedReasoning,
            createdAt: runStartedAt,
            metadata: {
              streaming: true,
              startedAt: runStartedAt,
              durationMs: now - runStartedAt,
              durationFormatted: formatRunDuration(now - runStartedAt),
              toolRounds: toolRound,
              toolSteps: buildSnapshotToolSteps(),
              todos: initialTodos,
              ...overrides,
            },
          });
        } catch (err) {
          console.warn(`[chat-stream] 运行快照落盘失败 (${partialMessageId}):`, err.message);
        }
      };
      // 启动即刻写入空占位：覆盖"模型连接建立阶段即崩溃"导致回合彻底消失的窗口
      persistPartial(true);

      // 退出兜底：Cmd+Q / 进程退出时同步落盘，明确标记为 interrupted，
      // 确保下一次启动能看到"执行被中断"的完整轨迹，而不是一条诡异的空回合。
      const persistInterrupted = () => {
        const now = Date.now();
        try {
          storageService.persistMessageSync(sessionId, {
            id: partialMessageId,
            role: "assistant",
            content: fullGeneratedText,
            reasoning: fullGeneratedReasoning,
            createdAt: runStartedAt,
            metadata: {
              streaming: false,
              interrupted: true,
              interruptedAt: now,
              startedAt: runStartedAt,
              durationMs: now - runStartedAt,
              durationFormatted: formatRunDuration(now - runStartedAt),
              toolRounds: toolRound,
              toolSteps: buildSnapshotToolSteps(),
              todos: initialTodos,
            },
          });
        } catch (err) {
          console.warn(`[chat-stream] 退出前快照落盘失败 (${partialMessageId}):`, err.message);
        }
      };
      activeStreamSnapshotFlushers.set(sessionId, { runId, flush: persistInterrupted });

      // 会话级隔离工具上下文（杜绝并发会话串台覆盖全局单例，并挂载中断信号与沙箱权限模式）
      const sessionToolContext = {
        sessionId,
        workDir: sessionWorkDir,
        allowedFolders,
        writableFolders,
        permissionMode: resolvedPermissionMode,
        checkPermission: checkPermissionFn,
        allowedToolNames: null,
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
          replyStream("outputs", outItem);
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

        // 历史回合的思考块仅剥离正文中的字面量标签（v2.1.9 前线上下发的旧格式），
        // 是否把历史推理回传给上游由 reasoning_replay_scope 策略决定（见下方 reasoningReplay）。
        // 同时用 WeakMap 记住每条历史消息的持久化 id，供窗口回填按需拉取思考全文；
        // id 属于内部字段，必须在进入请求体前剥离，避免污染上游 protocol payload。
        const historyMessageIds = new WeakMap();
        let apiMessages = (Array.isArray(messages) ? messages : []).map((m) => {
          if (!m || typeof m !== "object") return m;
          const cloned = { ...m };
          if (m.id) historyMessageIds.set(cloned, m.id);
          delete cloned.id;
          if (
            cloned.role === "assistant" &&
            typeof cloned.content === "string" &&
            cloned.content.includes("<think")
          ) {
            cloned.content = storageService.extractLegacyThinking(cloned.content).content;
          }
          return cloned;
        });

        // ─── 推理回传策略（provider-aware reasoning replay） ───
        // 协议正确性与成本控制的核心开关：
        // - Anthropic：只在同一 assistant turn 内回传 thinking block（历史缺 signature 会 400）；
        // - OpenAI 兼容（DeepSeek 等）：仅在携带 tools 时回传 reasoning_content；
        // - scope=window 时额外带上最近 N 个用户轮次的思考（默认 3 轮）。
        const reasoningReplay = reasoningPolicy.resolveReplayPolicy({
          provider,
          baseUrl: modelBaseUrl,
          modelId: apiModelId,
          hasTools: Boolean(enableTools),
          scope: storageService.getConfig("reasoning_replay_scope"),
          window: storageService.getConfig("reasoning_replay_window"),
        });
        console.log(
          `[reasoning-replay] mode=${reasoningReplay.mode} scope=${reasoningReplay.scope} window=${reasoningReplay.window} includeHistory=${reasoningReplay.includeHistory}`
        );

        if (reasoningReplay.includeHistory && reasoningReplay.mode === "openai-field") {
          // 从最近的消息往前扫描，只回填最近 N 个用户轮次内的 assistant 思考，
          // 避免把整段会话的推理全部塞回请求体导致上下文与成本双爆。
          const MAX_HISTORY_REPLAY_ITEMS = 12;
          let userTurnsSeen = 0;
          let replayed = 0;
          for (let i = apiMessages.length - 1; i >= 0; i--) {
            if (replayed >= MAX_HISTORY_REPLAY_ITEMS) break;
            const msg = apiMessages[i];
            if (!msg) continue;
            if (msg.role === "user") {
              userTurnsSeen += 1;
              if (userTurnsSeen > reasoningReplay.window) break;
              continue;
            }
            if (msg.role !== "assistant" || msg.reasoning_content) continue;
            const persistedId = historyMessageIds.get(msg);
            if (!persistedId) continue;
            try {
              const text = storageService.getMessageReasoning(persistedId);
              const payload = reasoningPolicy.buildReplayPayload(reasoningReplay, {
                reasoning: text,
              });
              if (payload) {
                msg[payload.field] = payload.value;
                replayed += 1;
              }
            } catch (err) {
              console.warn(`[reasoning-replay] 历史思考回填失败 (${persistedId}):`, err.message);
            }
          }
          if (replayed > 0) {
            console.log(
              `[reasoning-replay] 已回填 ${replayed} 条历史推理 (window=${reasoningReplay.window})`
            );
          }
        }

        /**
         * 把本轮 assistant 产出（content + reasoning + tool_calls）组装成可回传的消息。
         * 推理字段按 provider 策略注入，绝不无条件塞入，避免非推理端点因未知字段 400。
         */
        const buildAssistantReplayMessage = (result, { toolCalls, content } = {}) => {
          const message = {
            role: "assistant",
            content: content !== undefined ? content : result.content || "",
          };
          if (reasoningReplay.mode === "openai-field") {
            const replayPayload = reasoningPolicy.buildReplayPayload(reasoningReplay, result);
            if (replayPayload) message[replayPayload.field] = replayPayload.value;
          } else if (reasoningReplay.mode === "anthropic-block") {
            // Anthropic 的 thinking block 与 signature 必须严格配对且不可截断，
            // 因此这里直接使用本轮原始推理文本，不走 buildReplayPayload 的长度护栏。
            const rawReasoning = reasoningPolicy.extractReplayReasoning(result);
            const signatures = Array.isArray(result.reasoningMeta?.signatures)
              ? result.reasoningMeta.signatures
              : [];
            if (rawReasoning && signatures.some(Boolean)) {
              message.reasoning = rawReasoning;
              message.reasoningSignatures = signatures;
            } else if (rawReasoning) {
              // 缺少 signature 时不回传：结构不合法的 thinking block 会被上游拒绝，
              // 直接丢弃反而更安全（正文与 tool_calls 仍然完整）。
              console.warn("[reasoning-replay] Anthropic thinking 缺少 signature，本轮跳过推理回传");
            }
          }
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            message.tool_calls = toolCalls;
          }
          return message;
        };

        // 斜杠命令展开：仅在最后一条用户消息以 /command 开头时替换为完整提示词
        let slashCommandInfo = null;
        try {
          const lastUserIndex = (() => {
            for (let i = apiMessages.length - 1; i >= 0; i--) {
              if (apiMessages[i]?.role === "user") return i;
            }
            return -1;
          })();
          if (lastUserIndex >= 0) {
            const rawText = extractTextContent(apiMessages[lastUserIndex].content);
            // /btw 必须走独立的旁路通道，绝不能被主 Agent 当作普通任务执行
            if (/^\/btw(?:\s|$)/i.test(rawText.trim())) {
              replyStream(
                "error",
                "旁路提问请直接在主输入框发送 /btw <问题>：它不会打断主任务，也不会写入主会话。"
              );
              return;
            }
            const expanded = await commandService.expandCommand(rawText, sessionWorkDir);
            if (expanded) {
              slashCommandInfo = {
                command: expanded.command,
                scope: expanded.scope,
                builtin: expanded.builtin,
                original: rawText,
              };
              apiMessages[lastUserIndex] = {
                ...apiMessages[lastUserIndex],
                content: expanded.prompt,
              };
              if (expanded.allowedTools?.length) {
                sessionToolContext.allowedToolNames = new Set([
                  ...expanded.allowedTools,
                  "todo_write",
                  "run_skill_script",
                ]);
              }
              console.log(`[slash-command] 已展开 /${expanded.command} (${expanded.scope})`);
            }
          }
        } catch (slashErr) {
          console.warn("[slash-command] 展开失败，回退原文:", slashErr.message);
        }
        let compactionSummary = "";
        const compactionStats = { count: 0, beforeTokens: 0, afterTokens: 0 };
        let lastProviderUsage = null;
        const modelPricing = {
          inputPrice,
          outputPrice,
          cacheReadPrice,
          cacheWritePrice,
        };

        const recordUsage = (usage) => {
          if (!usage) return;
          const normalized = usage.raw ? usage : normalizeUsage(usage, provider);
          if (!normalized) return;
          lastProviderUsage = normalized;
          turnUsage = mergeUsage(turnUsage, normalized);
          turnCostUsd += computeUsageCost(normalized, modelPricing);
        };

        const withUsageMetrics = (metrics) => ({
          ...metrics,
          usage: turnUsage,
          costUsd: Math.round(turnCostUsd * 100_000_000) / 100_000_000,
        });
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
          replyStream("error", "当前模型不支持图片输入，请切换到支持视觉的模型");
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
            mcpServers: storageService
              .getMcpServers(sessionWorkDir)
              .filter((s) => s.source !== "project" || s.trusted === true),
          });
          if (mentionContext.block) {
            mentionBlock = mentionContext.block;
            console.log(
              `[mention] resolved ${mentionContext.skills.length} skills / ${mentionContext.mcps.length} mcps / ${mentionContext.files.length} files / ${mentionContext.dirs.length} dirs` +
                (mentionContext.skipped.length > 0 ? ` / skipped ${mentionContext.skipped.length}` : "")
            );
          }
          // 技能声明 allowed-tools 时收敛本轮可用工具（所有激活技能都声明才生效）
          if (Array.isArray(mentionContext.allowedTools) && mentionContext.allowedTools.length > 0) {
            sessionToolContext.allowedToolNames = new Set([
              ...mentionContext.allowedTools,
              "todo_write",
              "run_skill_script",
            ]);
            console.log(
              `[skill-permission] 本轮工具白名单: ${[...sessionToolContext.allowedToolNames].join(", ")}`
            );
          }
        }

        // 生命周期 Hooks：UserPromptSubmit（项目级 hooks 必须由用户显式信任）
        const hooksEnabled = storageService.getConfig("hooks_enabled") !== "false";
        const hooksTrusted = storageService.isProjectHooksTrusted(sessionWorkDir);
        const hookOptions = {
          workDir: sessionWorkDir,
          sessionId,
          projectTrusted: hooksTrusted,
          enabled: hooksEnabled,
        };
        if (hooksEnabled) {
          try {
            const promptHook = await hookService.runHooks(
              "UserPromptSubmit",
              {
                prompt: mentionText,
                slash_command: slashCommandInfo?.command || null,
                session_id: sessionId,
                cwd: sessionWorkDir,
              },
              hookOptions
            );
            if (promptHook.blocked) {
              replyStream("error", `Hook 阻断了本次请求：${promptHook.reason}`);
              return;
            }
            if (promptHook.additionalContext) {
              mentionBlock = mentionBlock
                ? `${mentionBlock}\n\n【Hooks 注入的额外上下文】\n${promptHook.additionalContext}`
                : `【Hooks 注入的额外上下文】\n${promptHook.additionalContext}`;
            }
          } catch (hookErr) {
            console.warn("[hook] UserPromptSubmit 执行异常:", hookErr.message);
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

        const globalCustomSystemPrompt = storageService.getConfig("custom_system_prompt") || "";

        // 仓库符号地图：默认开启，可通过设置关闭；内部带 45s 缓存，避免每轮全量扫描
        let repoMapText = "";
        if (
          sessionWorkDir &&
          storageService.getConfig("repo_map_enabled") !== "false"
        ) {
          try {
            repoMapText = repoIndexService.buildRepoMap(sessionWorkDir, {
              maxChars: Number(storageService.getConfig("repo_map_max_chars")) || 6000,
            });
          } catch (repoErr) {
            console.warn(`[repo-map] 生成失败: ${repoErr.message}`);
          }
        }

        // Repo Wiki：若用户已在 Inspector 生成过，则注入摘要（完整文档保留路径）
        let wikiInfo = null;
        if (sessionWorkDir) {
          try {
            wikiInfo = repoWikiService.getRepoWiki(sessionWorkDir);
          } catch (wikiErr) {
            console.warn(`[repo-wiki] 读取失败: ${wikiErr.message}`);
          }
        }

        const buildInstruction = () =>
          buildSystemContext({
            workDir: sessionWorkDir,
            matchedWorkspace,
            skills: availableSkills,
            memories,
            memoryIndex,
            projectRules,
            repoMap: repoMapText,
            repoWiki: wikiInfo?.exists ? String(wikiInfo.content || "").slice(0, 3500) : "",
            repoWikiPath: wikiInfo?.path || "",
            todos: initialTodos,
            toolDocs: getActiveToolPromptDocs(),
            model: `${provider}/${apiModelId}`,
            enableTools,
            permissionMode: sessionToolContext.permissionMode,
            customSystemPrompt: globalCustomSystemPrompt,
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

        const getActiveToolDefs = () =>
          enableTools
            ? toolRegistry.getToolDefinitions(
                mcpTools,
                sessionToolContext.allowedToolNames || null,
                {
                  permissionMode: sessionToolContext.permissionMode,
                }
              )
            : [];

        // 工具 Schema 同样占用上下文预算，必须计入阈值判断，否则会持续低估真实占用
        const toolDefsTokenEstimate = (() => {
          try {
            const defs = getActiveToolDefs();
            return defs.length > 0 ? estimateTokens(JSON.stringify(defs)) : 0;
          } catch {
            return 0;
          }
        })();

        const maybeCompact = async (reason = "preflight", options = {}) => {
          if (!compactCfg.enabled) return false;

          const thresholds = getThresholds(contextLimit, compactCfg);
          const nonSystemMessages = apiMessages.filter((message) => message.role !== "system");
          let tokens =
            estimateMessagesTokens(nonSystemMessages) +
            estimateTokens(systemInstruction) +
            toolDefsTokenEstimate;
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
              estimateTokens(systemInstruction) +
              toolDefsTokenEstimate;
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
              // 没有任何可摘要的早期历史（例如单条超长用户消息），摘要链路无法生效，
              // 直接落到硬截断兜底，避免上下文持续超限后反复溢出重试。
              if (force || tokens > thresholds.threshold) {
                apiMessages = hardTruncate(apiMessages, thresholds.threshold);
                lastProviderUsage = null;
                console.log("[compact] no summarizable history, fallback hardTruncate");
                return true;
              }
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

            replyStream("compaction", {
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
          replyStream("todos", initialTodos);
          persistPartial(true);
          refreshSystemInstruction();
          console.log(`[context] todos updated: ${initialTodos.length}`);
        };

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
        replyStream("metrics", withUsageMetrics(initMetrics));

        const MAX_TOOL_ROUNDS = Number(storageService.getConfig("max_tool_rounds")) || 5000;

        // 流式空闲看门狗：连续 N 秒收不到任何字节即主动中断，避免网关掐断后界面无限期干等
        const STREAM_IDLE_TIMEOUT_SEC = Math.max(
          30,
          Number(storageService.getConfig("stream_idle_timeout")) || 180
        );
        const STREAM_IDLE_TIMEOUT_MS = STREAM_IDLE_TIMEOUT_SEC * 1000;

        function sendData(delta) {
          fullGeneratedText += delta;
          replyStream("data", delta);
          // 节流快照：流式正文持续推进时按固定周期落盘一次，避免进程异常退出丢失整段输出
          persistPartial();
        }

        // 思考内容走独立通道：正文中不再插入任何思考标签标记，
        // 从根源上杜绝正文里出现同名标签时被误判为思考块。
        function sendReasoning(delta) {
          if (!delta) return;
          fullGeneratedReasoning += delta;
          replyStream("reasoning", delta);
          persistPartial();
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
          // Anthropic 原生 Messages API：独立协议分支，输出结构与 OpenAI 分支完全一致
          if (isAnthropicProvider(provider, modelBaseUrl)) {
            const anthropicResult = await streamAnthropicMessage({
              baseUrl: modelBaseUrl,
              apiKey: modelApiKey,
              model: apiModelId,
              messages: requestMessages,
              tools: requestBody.tools || [],
              maxTokens: maxOutputTokens,
              temperature: 0.2,
              // 迁移到 adaptive thinking：由 effort 表达思考意图，禁止下发 legacy 的 budget_tokens
              reasoningEffort: sessionReasoningEffort,
              signal: sessionAbort.abortController.signal,
              onText: (delta) => sendData(delta),
              onReasoning: (delta) => sendReasoning(delta),
            });
            if (anthropicResult.usage) {
              lastProviderUsage = anthropicResult.usage;
            }
            const signatureCount = Array.isArray(anthropicResult.reasoningSignatures)
              ? anthropicResult.reasoningSignatures.filter(Boolean).length
              : 0;
            if (signatureCount > 0) {
              console.log(`[anthropic] 采集到 ${signatureCount} 个 thinking signature，可在工具轮回传`);
            }
            return anthropicResult;
          }

          const reasoningSpec = buildReasoningPayload(apiModelId, provider, sessionReasoningEffort);
          let requestBodyFinal = {
            model: apiModelId,
            messages: requestMessages,
            stream: true,
            temperature: 0.2,
            ...reasoningSpec.payload,
            ...requestBody,
          };
          // 显式下发输出上限：此前完全依赖网关默认值，导致 finish_reason=length
          // 与设置中的 max_output_tokens 脱节（长思考后正文被提前截断的诱因之一）。
          // 思考模型的 completion 预算需容纳思考本身，因此在配置值基础上追加余量。
          if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
            const thinkingActive = Object.keys(reasoningSpec.payload).length > 0;
            requestBodyFinal.max_tokens = thinkingActive
              ? Math.min(64000, maxOutputTokens * 2)
              : maxOutputTokens;
          }

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
          let toolCalls = [];
          let usage = null;
          let streamFinished = false;
          let finishReason = null;
          let hitLengthLimit = false;
          let receivedBytes = 0;
          let lastDataAt = Date.now();
          let waitingNotifiedSec = 0;

          // 心跳：长时间无任何数据时向前端上报等待状态，避免用户误以为应用卡死
          const waitingTimer = setInterval(() => {
            const idleSec = Math.floor((Date.now() - lastDataAt) / 1000);
            if (idleSec >= 15 && idleSec - waitingNotifiedSec >= 15) {
              waitingNotifiedSec = idleSec;
              try {
                replyStream("waiting", {
                  idleSec,
                  timeoutSec: STREAM_IDLE_TIMEOUT_SEC,
                });
              } catch (e) {
                // 忽略窗口已关闭的推送异常
              }
            }
          }, 5000);

          // 空闲看门狗：为每次 read() 施加超时，杜绝上游静默挂起导致无限期等待
          const readWithIdleGuard = () =>
            new Promise((resolve, reject) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                const err = new Error(
                  `上游连接已连续 ${STREAM_IDLE_TIMEOUT_SEC} 秒未返回任何数据（可能网关超时、代理中断或模型服务卡死）`
                );
                err.name = "StreamIdleTimeoutError";
                err.code = "STREAM_IDLE_TIMEOUT";
                reject(err);
              }, STREAM_IDLE_TIMEOUT_MS);
              reader.read().then(
                (v) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  resolve(v);
                },
                (e) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  reject(e);
                }
              );
            });

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
              const { done, value } = await readWithIdleGuard();
              if (done) break;
              if (value && value.byteLength) {
                receivedBytes += value.byteLength;
                lastDataAt = Date.now();
                waitingNotifiedSec = 0;
              }
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
                    lastProviderUsage = normalizeUsage(json.usage, provider);
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
                    fullReasoning += reasoningDelta;
                    sendReasoning(reasoningDelta);
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
              // 异常中断前收口未闭合的思考块，避免错误提示被吞进 <think> 内
              console.warn(
                `[chat-stream] 流式读取中断: ${readErr?.name || "Error"} - ${readErr?.message || ""} ` +
                  `(receivedBytes=${receivedBytes}, finishReason=${finishReason || "none"})`
              );
              throw readErr;
            }
          } finally {
            clearInterval(waitingTimer);
            try {
              await reader.cancel();
            } catch {
              // 忽略释放 reader 异常
            }
          }

          return {
            content: fullContent,
            reasoning: fullReasoning,
            // OpenAI 兼容端点无加密推理副本，仅回传明文 reasoning_content
            reasoningMeta: { provider: "openai-compatible", signatures: [] },
            toolCalls: toolCalls.filter(Boolean),
            usage,
            hitLengthLimit,
            finishReason,
            receivedBytes,
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
        let emptyRoundRetry = 0;
        const MAX_CONTINUATIONS = 4;

        while (toolRound < MAX_TOOL_ROUNDS) {
          let requestBody = {};
          if (enableTools) {
            requestBody.tools = getActiveToolDefs();
            requestBody.tool_choice = "auto";
          }

          if (sessionAbort.cancelled) break;

          // 中途动态转向：在每轮工具循环发起模型请求之前，将用户追加的上下文/指示注入会话
          if (Array.isArray(sessionAbort.steerQueue) && sessionAbort.steerQueue.length > 0) {
            const steers = sessionAbort.steerQueue.splice(0);
            for (const steer of steers) {
              apiMessages.push({
                role: "user",
                content: `【用户中途更新/追加的需求上下文】\n${steer.content}\n\n[系统引导]：用户在当前任务执行中途补充或更新了上述内容。请自主综合分析用户意图（是补充业务背景、澄清细节、细化边界条件，还是调整/纠偏当前执行路线）：\n- 若属于补充背景、澄清细节或细化约束：请将该上下文无缝融合进当前任务，并在后续步骤与最终答复中予以落实；\n- 若属于方向调整或纠偏：请以最新指示为准调整后续行动，无需推倒已完成且不冲突的工作。`,
              });
            }
            replyStream("steered", steers);
            console.log(`[chat-steer] injected ${steers.length} steering message(s) into context`);
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

          recordUsage(result.usage);

          if (sessionAbort.cancelled) break;

          if (!enableTools || result.toolCalls.length === 0) {
            const cleanRoundText = (result.content || "").trim();
            const hasIncompleteTodos =
              initialTodos.length > 0 && initialTodos.some((t) => t.status !== "completed");

            // 中途动态转向：模型本轮已准备收尾，但用户在执行期间追加了纠偏指示
            // -> 保留本轮正式回复，注入纠偏后立即在当前会话内继续推理（无需用户重新发送）
            if (Array.isArray(sessionAbort.steerQueue) && sessionAbort.steerQueue.length > 0) {
              const steers = sessionAbort.steerQueue.splice(0);
              if (cleanRoundText) {
                apiMessages.push({ role: "assistant", content: result.content });
              }
              for (const steer of steers) {
                apiMessages.push({
                  role: "user",
                  content: `【用户中途更新/追加的需求上下文】\n${steer.content}\n\n[系统引导]：用户在当前任务执行中途补充或更新了上述内容。请自主综合分析用户意图（是补充业务背景、澄清细节、细化边界条件，还是调整/纠偏当前执行路线）：\n- 若属于补充背景、澄清细节或细化约束：请将该上下文无缝融合进当前任务，并在后续步骤与最终答复中予以落实；\n- 若属于方向调整或纠偏：请以最新指示为准调整后续行动，无需推倒已完成且不冲突的工作。`,
                });
              }
              replyStream("steered", steers);
              console.log(
                `[chat-steer] assistant was finishing; injected ${steers.length} steering message(s) and continued the loop`
              );
              // 让前端消息流中清晰呈现"已接收中途追加上下文并继续推进"的分隔
              sendData("\n\n");
              continue;
            }

            // 空响应兜底：上游未返回任何正文、思考或工具调用（多见于网关静默掐断连接）
            const hasAnyPayload =
              cleanRoundText.length > 0 ||
              Boolean(result.reasoning && String(result.reasoning).trim()) ||
              result.toolCalls.length > 0;
            if (!hasAnyPayload) {
              if (emptyRoundRetry < 1) {
                emptyRoundRetry++;
                console.warn(
                  `[chat-stream] 第 ${toolRound + 1} 轮模型返回空响应 ` +
                    `(receivedBytes=${result.receivedBytes || 0}, finishReason=${result.finishReason || "none"})，自动重试 1 次`
                );
                await new Promise((r) => setTimeout(r, 600));
                continue;
              }
              throw new Error(
                `上游模型未返回任何内容（收到的数据量 ${result.receivedBytes || 0} 字节，finish_reason=${
                  result.finishReason || "无"
                }）。可能原因：网关超时/连接被中断、模型服务异常或请求被代理拦截。请重试，或切换其他模型。`
              );
            }

            // 模式 A：正在输出长篇正文或代码块时触发单次输出长度上限 -> 无缝断点续写
            if (result.hitLengthLimit && cleanRoundText.length > 0 && continuationCount < MAX_CONTINUATIONS) {
              continuationCount++;
              const tailSnippet = result.content.slice(-80);
              console.log(`[auto-continue] 模式A：正文触发长度上限，发起第 ${continuationCount} 次无缝断点续写`);
              // 续写回填同样携带推理，避免在 Reasoning 模型上丢失推理链导致续写跑偏
              apiMessages.push(buildAssistantReplayMessage(result, { content: result.content }));
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
              // 模式 B 的推理已作为摘要写进 content（旧行为），因此这里只回填正文，
              // 避免同一段推理同时出现在 reasoning_content 与 content 中导致语义重复。
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
                apiMessages.push(buildAssistantReplayMessage(result, { content: cleanRoundText }));
              }
              apiMessages.push({
                role: "user",
                content: `当前任务规划中仍有未完成的待办项（当前待完成：${
                  activeTodo?.text || "剩余任务"
                }），请不要停留在准备阶段，立即调用相应工具（如 write_file / edit_file / run_command）继续执行，并在全部完成后更新 todo_write 及输出最终总结。`,
              });
              continue;
            }

            // 模式 D：上游以 stop 收尾但把代码块留在未闭合状态（网关静默截断的典型表现）
            // -> 断点续写一次，避免最终回答直接断在代码块中间。
            // 必须检查累计正文：单轮续写可能只输出"闭合围栏"，只看本轮会误判并无限续写。
            const cumulativeVisibleText = fullGeneratedText
              .replace(/\btask ready\b/gi, "")
              .trim();
            if (
              !result.hitLengthLimit &&
              cumulativeVisibleText.length > 0 &&
              hasUnclosedCodeFence(cumulativeVisibleText) &&
              continuationCount < MAX_CONTINUATIONS
            ) {
              continuationCount++;
              console.log(
                `[auto-continue] 模式D：代码块未闭合即结束，发起第 ${continuationCount} 次断点续写`
              );
              // 只回填“本轮”输出：累计正文已包含此前各轮，重复回填会让历史成倍膨胀。
              // 累计文本仅用于判断围栏是否仍未闭合。
              apiMessages.push(
                buildAssistantReplayMessage(result, { content: result.content || cleanRoundText })
              );
              apiMessages.push({
                role: "user",
                content:
                  "你的上一条回复在一个未闭合的代码块中途停止了（末尾没有正常收尾）。请紧接最后一行继续输出剩余内容，补全代码块并给出完整结论；禁止重复前文、禁止重新开场。",
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
            "search_symbols",
            "repo_map",
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
            replyStream("tool_status", {
              tool: item.tc.function.name,
              status: "running",
              args: item.args,
              callId: item.callId,
            });
          }

          const executeSingleCall = async ({ tc, callId, args }) => {
            const toolStartedAt = Date.now();
            const recordToolTrace = (status, detail = "") =>
              telemetryService.recordToolCall(telemetryRun.id, {
                name: tc.function.name,
                status,
                durationMs: Date.now() - toolStartedAt,
                args,
                summary: detail,
              });

            if (sessionAbort.cancelled) {
              recordToolTrace("cancelled", "运行已取消");
              return { tc, callId, args, execResult: { success: false, error: "已取消" } };
            }

            // 技能 allowed-tools 白名单：硬性阻断白名单外的工具调用
            if (
              sessionToolContext.allowedToolNames &&
              !sessionToolContext.allowedToolNames.has(tc.function.name)
            ) {
              recordToolTrace("blocked", "技能工具白名单拦截");
              const whitelistBlockedResult = {
                success: false,
                error: `当前激活的技能限制了可用工具范围，已拒绝调用 ${tc.function.name}`,
              };
              // 与 Hook 阻断保持一致：必须补齐 done 状态与快照步骤，
              // 否则该 callId 会永久停留在 running，UI 与持久化轨迹都缺这一步
              executedToolSteps.push({
                tool: tc.function.name,
                status: "done",
                args,
                result: whitelistBlockedResult,
                callId,
              });
              replyStream("tool_status", {
                tool: tc.function.name,
                status: "done",
                args,
                result: whitelistBlockedResult,
                callId,
              });
              persistPartial(true);
              return {
                tc,
                callId,
                args,
                execResult: whitelistBlockedResult,
              };
            }

            // PreToolUse Hook：可阻断工具执行
            if (hooksEnabled) {
              try {
                const preHook = await hookService.runHooks(
                  "PreToolUse",
                  {
                    tool_name: tc.function.name,
                    tool_input: args,
                    session_id: sessionId,
                    cwd: sessionWorkDir,
                  },
                  hookOptions
                );
                if (preHook.blocked) {
                  const blockedResult = {
                    success: false,
                    error: `Hook 阻断了工具 ${tc.function.name}：${preHook.reason}`,
                  };
                  recordToolTrace("blocked", `Hook 阻断: ${preHook.reason || ""}`);
                  executedToolSteps.push({
                    tool: tc.function.name,
                    status: "done",
                    args,
                    result: blockedResult,
                    callId,
                  });
                  replyStream("tool_status", {
                    tool: tc.function.name,
                    status: "done",
                    args,
                    result: blockedResult,
                    callId,
                  });
                  return { tc, callId, args, execResult: blockedResult };
                }
              } catch (hookErr) {
                console.warn("[hook] PreToolUse 执行异常:", hookErr.message);
              }
            }

            // 写前检查点：仅记录 Agent 即将修改文件的原始内容，供用户一键回滚
            if (tc.function.name === "write_file" || tc.function.name === "edit_file") {
              const targetPath = typeof args?.path === "string" ? args.path : "";
              if (targetPath) {
                try {
                  checkpointService.recordFile({
                    sessionId,
                    turnId: runId,
                    filePath: targetPath,
                    workDir: sessionWorkDir,
                    tool: tc.function.name,
                  });
                } catch (checkpointErr) {
                  console.warn(`[checkpoint] 记录 ${targetPath} 失败: ${checkpointErr.message}`);
                }
              }
            }

            let currentSubSteps = [];
            const callScopedContext =
              tc.function.name === "dispatch_subagent"
                ? {
                    ...sessionToolContext,
                    onSubagentProgress: (subSteps) => {
                      currentSubSteps = subSteps;
                      replyStream("tool_status", {
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
            recordToolTrace(
              execResult?.success ? "ok" : "error",
              execResult?.success ? "" : execResult?.error || ""
            );

            // PostToolUse Hook：用于审计、格式化、补充上下文；不改变本次工具结果
            if (hooksEnabled) {
              try {
                await hookService.runHooks(
                  "PostToolUse",
                  {
                    tool_name: tc.function.name,
                    tool_input: args,
                    tool_response: execResult,
                    session_id: sessionId,
                    cwd: sessionWorkDir,
                  },
                  hookOptions
                );
              } catch (hookErr) {
                console.warn("[hook] PostToolUse 执行异常:", hookErr.message);
              }
            }

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
              replyStream("outputs", outItem);
            }

            executedToolSteps.push({
              tool: tc.function.name,
              status: "done",
              args,
              result: execResult,
              callId,
              ...(currentSubSteps.length > 0 ? { subSteps: currentSubSteps } : {}),
            });

            // 每一步工具执行完成后立即强制落盘一次：即使随后进程崩溃，工具轨迹也不丢失
            persistPartial(true);

            replyStream("tool_status", {
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
            //    推理回传：DeepSeek 等要求在带 tools 的请求中回传本轮 reasoning_content；
            //    Anthropic 要求回传 thinking block + signature。统一走 buildAssistantReplayMessage。
            apiMessages.push(
              buildAssistantReplayMessage(result, {
                toolCalls: completedCalls.map(({ tc, callId }) => ({
                  id: callId,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                })),
              })
            );

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
          replyStream("metrics", withUsageMetrics(updatedMetrics));
        }

        // 正文通道已与思考通道彻底分离，仅需过滤网关注入的合成占位符
        const visibleGeneratedText = fullGeneratedText
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
          if (finalResult) recordUsage(finalResult.usage);
        }

        // 若任务正常结束（非用户取消），将仍遗留在 in_progress 的 Todo 自动收敛为 completed
        if (!sessionAbort.cancelled && initialTodos.some((t) => t.status === "in_progress")) {
          for (const todo of initialTodos) {
            if (todo.status === "in_progress") {
              todo.status = "completed";
            }
          }
          replyStream("todos", initialTodos);
        }

        // Stop Hook：任务收尾钩子（用于通知、审计、清理，不阻断最终结果）
        if (hooksEnabled) {
          try {
            await hookService.runHooks(
              "Stop",
              {
                session_id: sessionId,
                cwd: sessionWorkDir,
                tool_rounds: toolRound,
                cancelled: !!sessionAbort.cancelled,
                response: fullGeneratedText,
              },
              hookOptions
            );
          } catch (hookErr) {
            console.warn("[hook] Stop 执行异常:", hookErr.message);
          }
        }

        // 最终推送一次 Context
        const finalMetrics = computeContextMetrics();
        replyStream("metrics", withUsageMetrics(finalMetrics));

        telemetryService.finishRun(telemetryRun.id, {
          success: !sessionAbort.cancelled,
          cancelled: !!sessionAbort.cancelled,
          rounds: toolRound,
          contentChars: (fullGeneratedText || "").length,
          usage: turnUsage,
          costUsd: turnCostUsd,
        });

        // 结束时通知前端，由前端单源原子落盘 (消除主进程重复双写导致的消息被覆盖Bug)
        const finalVisibleForCheck = fullGeneratedText;
        const outputTruncated = hasUnclosedCodeFence(finalVisibleForCheck);
        replyStream("end", {
          content: fullGeneratedText,
          reasoning: fullGeneratedReasoning,
          metadata: {
            cancelled: !!sessionAbort.cancelled,
            truncated: outputTruncated,
            toolRounds: toolRound,
            toolSteps: executedToolSteps,
            todos: initialTodos,
            pendingSteers: Array.isArray(sessionAbort.steerQueue) ? sessionAbort.steerQueue.slice() : [],
            compaction: {
              count: compactionStats.count,
              beforeTokens: compactionStats.beforeTokens,
              afterTokens: compactionStats.afterTokens,
            },
            usage: turnUsage,
            costUsd: Math.round(turnCostUsd * 100_000_000) / 100_000_000,
            model: apiModelId,
            provider,
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
          telemetryService.finishRun(telemetryRun.id, {
            success: false,
            cancelled: true,
            rounds: toolRound,
            contentChars: (fullGeneratedText || "").length,
            usage: turnUsage,
            costUsd: turnCostUsd,
          });
          try {
            replyStream("end", {
              content: fullGeneratedText,
              metadata: {
                cancelled: true,
                toolRounds: toolRound,
                toolSteps: executedToolSteps,
                todos: initialTodos,
                pendingSteers: Array.isArray(sessionAbort.steerQueue) ? sessionAbort.steerQueue.slice() : [],
                usage: turnUsage,
                costUsd: Math.round(turnCostUsd * 100_000_000) / 100_000_000,
              },
            });
          } catch (e) {
            // 忽略已关闭窗口的 reply 异常
          }
        } else {
          console.error(`[chat-stream error ${sessionId}]`, err);
          telemetryService.finishRun(telemetryRun.id, {
            success: false,
            error: err.message,
            rounds: toolRound,
            contentChars: (fullGeneratedText || "").length,
            usage: turnUsage,
            costUsd: turnCostUsd,
          });
          replyStream("error", err.message);
        }
      } finally {
        // 窗口已销毁（用户关闭窗口但 Agent 仍在后台跑完）时没有 renderer 负责终稿落盘，
        // 由主进程补写终态，避免数据库中遗留 streaming=true 的"永远进行中"回合。
        try {
          if (event.sender.isDestroyed && event.sender.isDestroyed()) {
            const now = Date.now();
            storageService.persistMessageSync(sessionId, {
              id: partialMessageId,
              role: "assistant",
              content: fullGeneratedText,
              createdAt: runStartedAt,
              metadata: {
                streaming: false,
                completed: !sessionAbort.cancelled,
                cancelled: !!sessionAbort.cancelled,
                durationMs: now - runStartedAt,
                durationFormatted: formatRunDuration(now - runStartedAt),
                toolRounds: toolRound,
                toolSteps: buildSnapshotToolSteps(),
                todos: initialTodos,
              },
            });
          }
        } catch (e) {
          // 忽略窗口已销毁的异常
        }
        // 仅清理属于当前 run 的登记项，避免旧 run 的 finally 误删新 run 的快照兜底与取消句柄
        if (activeStreamSnapshotFlushers.get(sessionId)?.runId === runId) {
          activeStreamSnapshotFlushers.delete(sessionId);
        }
        if (activeStreamSessions.get(sessionId) === sessionAbort) {
          activeStreamSessions.delete(sessionId);
        }
      }
    }
  );

  createWindow();
  initAutoUpdater(mainWindow);
});

app.on("before-quit", () => {
  // 退出流程中任何子服务异常都绝不能阻断进程退出（否则会卡住自动更新安装）
  // 1. 同步落盘所有仍在运行中的 Agent 回合快照，确保中断前的正文与工具轨迹不丢失
  try {
    for (const [sid, entry] of activeStreamSnapshotFlushers) {
      try {
        entry.flush();
      } catch (err) {
        console.warn(`[before-quit] 会话 ${sid} 中断快照落盘异常（已忽略）:`, err.message);
      }
    }
    activeStreamSnapshotFlushers.clear();
  } catch (err) {
    console.warn("[before-quit] 中断快照统一落盘异常（已忽略）:", err.message);
  }
  try {
    terminalPtyService.disposeAll();
  } catch (err) {
    console.warn("[before-quit] 关闭 PTY 终端异常（已忽略）:", err.message);
  }
  try {
    mcpClientService.closeAll();
  } catch (err) {
    console.warn("[before-quit] 关闭 MCP 客户端异常（已忽略，不阻断退出）:", err.message);
  }
  try {
    browserAutomationService.close();
  } catch (err) {
    console.warn("[before-quit] 关闭自动化浏览器异常（已忽略）:", err.message);
  }
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
