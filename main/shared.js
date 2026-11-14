const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
let electronMod = null;
try {
  const loaded = require("electron");
  if (loaded && typeof loaded === "object") {
    electronMod = loaded;
  }
} catch {}
const nativeImage = electronMod?.nativeImage || null;
const BrowserWindow = electronMod?.BrowserWindow || null;

const PROJECT_ROOT = path.resolve(__dirname, "..");

// ─── 懒加载模块缓存（避免冷启动时同步 require 25+ 重型后端模块阻塞窗口首屏） ───
const loadedModules = new Map();

function lazyRequire(modPath) {
  if (loadedModules.has(modPath)) {
    return loadedModules.get(modPath);
  }
  const loaded = require(modPath);
  loadedModules.set(modPath, loaded);
  return loaded;
}

function getLoadedModule(modPath) {
  return loadedModules.get(modPath) || null;
}

const MODULES = {
  storageService: "../services/storageService",
  reasoningPolicy: "../services/reasoningPolicy",
  updaterService: "../services/updaterService",
  workspaceGitService: "../services/workspaceGitService",
  contextCalculator: "../services/contextCalculator",
  toolRegistry: "../utils/toolRegistry",
  webTools: "../utils/tools/webTools",
  fileIndexer: "../utils/tools/fileIndexer",
  mentionResolver: "../utils/tools/mentionResolver",
  pathResolver: "../utils/tools/pathResolver",
  contextBuilder: "../utils/contextBuilder",
  mcpClientService: "../services/mcpClientService",
  mcpOAuthService: "../services/mcpOAuthService",
  subagentService: "../services/subagentService",
  skillMarketService: "../services/skillMarketService",
  terminalPtyService: "../services/terminalPtyService",
  repoIndexService: "../services/repoIndexService",
  repoWikiService: "../services/repoWikiService",
  fontService: "../services/fontService",
  commandService: "../services/commandService",
  specService: "../services/specService",
  btwService: "../services/btwService",
  hookService: "../services/hookService",
  gitHunkService: "../services/gitHunkService",
  gitWorktreeService: "../services/gitWorktreeService",
  sessionTransferService: "../services/sessionTransferService",
  browserAutomationService: "../services/browserAutomationService",
  anthropicClient: "../services/anthropicClient",
  sandboxPolicyService: "../services/sandboxPolicyService",
  contextCompactor: "../services/contextCompactor",
};

const getStorageService = () => lazyRequire(MODULES.storageService);
const getReasoningPolicy = () => lazyRequire(MODULES.reasoningPolicy);
const getUpdaterService = () => lazyRequire(MODULES.updaterService);
const getWorkspaceGitService = () => lazyRequire(MODULES.workspaceGitService);
const getContextCalculator = () => lazyRequire(MODULES.contextCalculator);
const getToolRegistry = () => lazyRequire(MODULES.toolRegistry).toolRegistry;
const getWebTools = () => lazyRequire(MODULES.webTools);
const getFileIndexer = () => lazyRequire(MODULES.fileIndexer);
const getMentionResolver = () => lazyRequire(MODULES.mentionResolver);
const getPathResolver = () => lazyRequire(MODULES.pathResolver);
const getContextBuilder = () => lazyRequire(MODULES.contextBuilder);
const getMcpClientService = () => lazyRequire(MODULES.mcpClientService).mcpClientService;
const getMcpOAuthService = () => lazyRequire(MODULES.mcpOAuthService);
const getSubagentService = () => lazyRequire(MODULES.subagentService);
const getSkillMarketService = () => lazyRequire(MODULES.skillMarketService);
const getTerminalPtyService = () => lazyRequire(MODULES.terminalPtyService).terminalPtyService;
const getRepoIndexService = () => lazyRequire(MODULES.repoIndexService);
const getRepoWikiService = () => lazyRequire(MODULES.repoWikiService);
const getFontService = () => lazyRequire(MODULES.fontService);
const getCommandService = () => lazyRequire(MODULES.commandService);
const getSpecService = () => lazyRequire(MODULES.specService);
const getBtwService = () => lazyRequire(MODULES.btwService);
const getHookService = () => lazyRequire(MODULES.hookService);
const getGitHunkService = () => lazyRequire(MODULES.gitHunkService);
const getGitWorktreeService = () => lazyRequire(MODULES.gitWorktreeService);
const getSessionTransferService = () => lazyRequire(MODULES.sessionTransferService);
const getBrowserAutomationService = () => lazyRequire(MODULES.browserAutomationService);
const getAnthropicClient = () => lazyRequire(MODULES.anthropicClient);
const getSandboxPolicyService = () => lazyRequire(MODULES.sandboxPolicyService);
const getContextCompactor = () => lazyRequire(MODULES.contextCompactor);

// ─── 运行时全局可变状态（统一收敛到 shared，避免模块循环依赖） ───
const activeStreamSnapshotFlushers = new Map();
const activeStreamSessions = new Map();
const pendingPermissions = new Map();
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

let mainWindow = null;
function setMainWindow(win) {
  mainWindow = win;
}
function getMainWindow() {
  return mainWindow;
}

// ─── 异步文件探测辅助函数 ───
async function asyncPathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function asyncStatSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * 退出或异常时同步落盘活动运行快照与存储写队列
 */
function flushActiveRunsAndStorageOnExit() {
  const storageService = getLoadedModule(MODULES.storageService);
  if (storageService) {
    try {
      storageService.flushPendingWritesSync?.();
    } catch (err) {
      console.warn("[exit-flush] 同步刷盘写队列异常:", err.message);
    }
  }
  if (activeStreamSnapshotFlushers.size > 0) {
    console.warn(`[exit-flush] 正在同步落盘 ${activeStreamSnapshotFlushers.size} 个活动会话中断快照...`);
    for (const [sid, entry] of activeStreamSnapshotFlushers) {
      try {
        entry?.flush?.();
      } catch (err) {
        console.warn(`[exit-flush] 会话 ${sid} 快照落盘失败:`, err.message);
      }
    }
  }
  if (storageService) {
    try {
      storageService.checkpointWalSync?.();
    } catch (err) {
      console.warn("[exit-flush] WAL checkpoint 异常:", err.message);
    }
  }
}

/**
 * 向所有存活窗口广播主进程未捕获异常通知，避免错误静默吞没
 */
function notifyMainProcessError(err, origin = "uncaughtException") {
  const payload = {
    origin,
    message: err?.message || String(err),
    at: Date.now(),
  };
  try {
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send("main-process-error", payload);
      }
    }
  } catch {
    // 忽略广播异常
  }
}

function isSafeExternalUrl(targetUrl) {
  return /^https?:\/\//i.test(String(targetUrl || "").trim());
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

/**
 * 判断目标路径是否为当前会话已登记的文件产物（允许在产物面板中预览工作区外文件）
 */
function isKnownSessionOutputPath(targetPath) {
  if (!targetPath) return false;
  const { resolveRealPathSafe } = getSandboxPolicyService();
  const storageService = getStorageService();
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

function getApiConfig() {
  const storageService = getStorageService();
  const apiKey = storageService.getConfig("api_key") || "";
  const baseUrl = storageService.getConfig("base_url") || "https://api.openai.com/v1";
  const savePath = storageService.getConfig("save_path") || "";
  return { apiKey, baseUrl, savePath };
}

function getWorkspaceFolders(workDir) {
  if (!workDir || typeof workDir !== "string" || !workDir.trim()) {
    return { matchedWorkspace: null, allowedFolders: [] };
  }
  const storageService = getStorageService();
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

  if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
    return { buffer: inputBuffer, width: 0, height: 0, mime: mime || "image/png" };
  }

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

function hasUnclosedCodeFence(text) {
  const matches = String(text || "").match(/^```/gm);
  return Boolean(matches && matches.length % 2 === 1);
}

async function encodeAttachmentForModelAsync(attachment) {
  if (!attachment || !attachment.path) return null;
  const storageService = getStorageService();
  if (!storageService.isSessionAttachmentPath(attachment.path)) return null;

  let buffer;
  try {
    buffer = await fsp.readFile(attachment.path);
  } catch {
    return null;
  }
  let mime = attachment.mime || "image/png";

  if (
    buffer.length > IMAGE_INLINE_MAX_BYTES &&
    nativeImage &&
    typeof nativeImage.createFromBuffer === "function"
  ) {
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

const TEXT_INLINE_MAX_CHARS = 20000;
const TEXT_INLINE_HISTORY_MAX_CHARS = 4000;
const TEXT_INLINE_TOTAL_BUDGET = 40000;
const TEXT_INLINE_MAX_BYTES = 100 * 1024;
const LINE_COUNT_MAX_BYTES = 20 * 1024 * 1024;

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function countFileLinesAsync(filePath, fileSize) {
  if (!fileSize || fileSize <= 0) return 0;
  if (fileSize > LINE_COUNT_MAX_BYTES) return null;
  return new Promise((resolve) => {
    let lines = 0;
    let lastByte = 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => {
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 10) lines += 1;
      }
      if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
    });
    stream.on("end", () => {
      if (lastByte !== 10) lines += 1;
      resolve(lines);
    });
    stream.on("error", () => resolve(null));
  });
}

function buildLargeTextGuide(ext, filePath) {
  const lowerExt = String(ext || "").toLowerCase();
  if (lowerExt === "csv" || lowerExt === "tsv") {
    return [
      `该文件为大型结构化表格文本，已完整保存在上述本地路径（已加入当前会话只读信任目录，无需额外授权即可直接读取）。`,
      `为避免撑爆上下文，系统未内联正文。请自主调用工具完成解析：`,
      `1. 优先通过 run_command 运行 Python（pandas 或标准库 csv 模块）先探查列名、总行数及前 5 行样本，再编写脚本按条件过滤、分组聚合或统计，避免全表 print；`,
      `2. 如需快速定位特定记录，也可使用 search_code 或 read_file(file_path="${filePath}", start_line=1, end_line=200) 分段查看。`,
    ].join("\n");
  }
  if (lowerExt === "json" || lowerExt === "jsonl") {
    return [
      `该文件为大型 JSON 数据文件，已完整保存在上述本地路径（已加入当前会话只读信任目录，可直接读取）。`,
      `为避免撑爆上下文，系统未内联正文。请自主调用工具完成解析：`,
      `1. 优先通过 run_command 运行 python3（json 模块）或 jq 探查顶层结构、字段 key、总条目数并提取目标字段，避免整文件打印；`,
      `2. 也可结合 read_file(file_path="${filePath}", start_line=1, end_line=200) 或 search_code 分段检索。`,
    ].join("\n");
  }
  return [
    `该文本文件体积较大，已完整保存在上述本地路径（已加入当前会话只读信任目录，可直接读取）。`,
    `为避免撑爆上下文，系统未内联正文。严禁仅凭猜测下结论或声称文件过大无法处理，请自主调用工具完成读取与分析：`,
    `1. 使用 read_file(file_path="${filePath}", start_line=..., end_line=...) 按行号分段逐块读取；`,
    `2. 使用 search_code 在该文件上检索关键词快速定位相关段落；`,
    `3. 如需全局统计、正则提取或大批量分析，使用 run_command 运行 python3 / rg / awk / wc 等脚本处理。`,
  ].join("\n");
}

function buildTextGuideSection(attachment, ext, fileSize, totalLines, totalChars) {
  const lines = [
    `### 用户上传的大文本附件: ${attachment.name}`,
    `- 本地存储绝对路径: ${attachment.path}`,
    `- 文件大小: ${formatBytes(fileSize)}`,
    `- 格式扩展名: .${ext || "txt"}`,
  ];
  if (typeof totalLines === "number") {
    lines.push(`- 总行数: ${totalLines.toLocaleString("en-US")} 行`);
  }
  if (typeof totalChars === "number") {
    lines.push(`- 总字符数: ${totalChars.toLocaleString("en-US")} 字符`);
  }
  lines.push(`【自主解析指引】\n${buildLargeTextGuide(ext, attachment.path)}`);
  return lines.join("\n");
}

async function buildAttachmentMessagesAsync(messages) {
  const withImages = [];
  messages.forEach((msg, index) => {
    if (msg.role === "user" && Array.isArray(msg.attachments) && msg.attachments.some(isImageFile)) {
      withImages.push(index);
    }
  });
  const injectImageIndexes = new Set(withImages.slice(-2));
  const recentTextThresholdIndex = Math.max(0, messages.length - 4);
  let remainingInlineBudget = TEXT_INLINE_TOTAL_BUDGET;

  let imageCount = 0;
  let textAttachmentCount = 0;
  let binaryAttachmentCount = 0;

  const result = await Promise.all(
    messages.map(async (msg, index) => {
      if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) return msg;

      let baseText = extractTextContent(msg.content);
      const images = [];
      const inlinedSections = [];
      const isRecentMessage = index >= recentTextThresholdIndex;

      for (const attachment of msg.attachments) {
        if (!attachment || !attachment.path || !(await asyncPathExists(attachment.path))) continue;

        if (isImageFile(attachment)) {
          if (!injectImageIndexes.has(index)) {
            baseText = baseText.replace(attachment.placeholder || "", `[图片已省略]`);
            continue;
          }
          const encoded = await encodeAttachmentForModelAsync(attachment);
          if (encoded) {
            images.push({
              type: "image_url",
              image_url: { url: `data:${encoded.mime};base64,${encoded.base64}` },
            });
            imageCount += 1;
          }
          continue;
        }

        if (isTextLikeFile(attachment.name, attachment.mime)) {
          const ext = getAttachmentExtension(attachment.name);
          try {
            const stat = await fsp.stat(attachment.path);
            const fileSize = Number(stat?.size ?? attachment.size ?? 0);
            const inlineCharCap = isRecentMessage ? TEXT_INLINE_MAX_CHARS : TEXT_INLINE_HISTORY_MAX_CHARS;

            // 大文件或超出本轮内联预算：不传正文，直接提供完整元信息与自主解析指引
            if (fileSize > TEXT_INLINE_MAX_BYTES || remainingInlineBudget <= 0) {
              const totalLines = await countFileLinesAsync(attachment.path, fileSize);
              inlinedSections.push(buildTextGuideSection(attachment, ext, fileSize, totalLines, null));
              binaryAttachmentCount += 1;
              continue;
            }

            const text = await fsp.readFile(attachment.path, "utf-8");
            const totalChars = text.length;
            const totalLines = text.length === 0 ? 0 : text.split(/\r?\n/).length;

            if (totalChars > inlineCharCap || totalChars > remainingInlineBudget) {
              inlinedSections.push(buildTextGuideSection(attachment, ext, fileSize, totalLines, totalChars));
              binaryAttachmentCount += 1;
              continue;
            }

            remainingInlineBudget -= totalChars;
            const lang = ext || "text";
            inlinedSections.push(
              [
                `### 用户上传的文本附件: ${attachment.name}`,
                `- 本地存储绝对路径: ${attachment.path}`,
                `- 文件大小: ${formatBytes(fileSize)}（${totalLines} 行 / ${totalChars} 字符）`,
                `\`\`\`${lang}\n${text}\n\`\`\``,
              ].join("\n")
            );
            textAttachmentCount += 1;
          } catch (e) {
            inlinedSections.push(`### 用户上传的文本附件: ${attachment.name} (读取失败: ${e.message})`);
          }
          continue;
        }

        const ext = getAttachmentExtension(attachment.name);
        let guide = "该文件已保存在上述本地路径（已加入当前会话只读信任目录）。请根据需要，调用相应工具或通过 run_command 运行脚本读取和分析该文件。";
        if (SPREADSHEET_EXTS.has(ext)) {
          guide = [
            "该文件为结构化表格数据，已完整保存在上述本地绝对路径（已加入当前会话只读信任目录）。",
            "请通过 run_command 运行 Python 脚本（优先使用 pandas / openpyxl，若环境未安装可使用内置 zipfile + xml.etree.ElementTree 解析 .xlsx）开展分析：",
            "1. 先探查所有工作表名称、各表总行数/列数、列名及前 5 行样本；",
            "2. 再根据需求编写过滤、分组、聚合统计脚本输出结论，严禁直接全表 print 导致终端输出被截断。",
          ].join("\n");
        } else if (DOCUMENT_EXTS.has(ext)) {
          guide = [
            "该文件为办公排版文档，已完整保存在上述本地绝对路径（已加入当前会话只读信任目录）。",
            "请通过 run_command 调用 Python 解析脚本提取结构与正文（如 PDF 用 pypdf/pdfplumber/pymupdf，DOCX 用 python-docx 或内置 zipfile + xml.etree.ElementTree 读取 word/document.xml）：",
            "1. 先探查文档总页数、章节目录或段落数量；",
            "2. 再按页码/章节分段提取或关键词检索，避免一次性输出过多文本导致截断。",
          ].join("\n");
        } else if (ARCHIVE_EXTS.has(ext)) {
          guide = "该文件为压缩归档包，已完整保存在上述本地绝对路径。如需查看内容，可通过 run_command 执行 unzip -l / tar -tzf 先查看文件列表，再按需解压到临时目录读取。";
        }

        inlinedSections.push(
          [
            `### 用户上传的文件附件: ${attachment.name}`,
            `- 本地存储绝对路径: ${attachment.path}`,
            `- 文件大小: ${formatBytes(attachment.size)}`,
            `- 格式扩展名: .${ext || "bin"}`,
            `【自主解析指引】\n${guide}`,
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
    })
  );

  return { messages: result, imageCount, textAttachmentCount, binaryAttachmentCount };
}

function getModelConfig(model, defaultModelId = "gpt-4o") {
  const storageService = getStorageService();
  const models = storageService.getModels();
  const matched = models.find((m) => m.id === model || m.model_id === model);

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

function normalizeUsage(usage, provider) {
  if (!usage || typeof usage !== "object") return null;
  if (provider === "anthropic") return getAnthropicClient().normalizeAnthropicUsage(usage);

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

const LITE_MODEL_HINTS = ["mini", "flash", "haiku", "v3", "turbo", "small", "7b", "8b", "3b"];

function pickLiteModel(currentModelId) {
  const allModels = getStorageService().getModels();
  const usable = allModels.filter((m) => m.api_key || m.provider === "ollama");
  const found = usable.find((m) => {
    const id = (m.model_id || m.id || "").toLowerCase();
    return LITE_MODEL_HINTS.some((hint) => id.includes(hint));
  });
  return found?.id || currentModelId;
}

function buildReasoningPayload(apiModelId, provider, reasoningEffort) {
  if (!reasoningEffort || reasoningEffort === "off") {
    return { payload: {}, isThinkingModel: false };
  }

  const modelLower = String(apiModelId || "").toLowerCase();
  const providerLower = String(provider || "").toLowerCase();

  const isOpenAIReasoning =
    /\b(o1|o3|o4)\b/i.test(modelLower) ||
    modelLower.includes("o1-") ||
    modelLower.includes("o3-") ||
    modelLower.includes("o4-") ||
    modelLower.includes("reasoning");

  if (isOpenAIReasoning) {
    const effortMap = { low: "low", medium: "medium", high: "high", max: "high" };
    const mapped = effortMap[reasoningEffort] || "medium";
    const payload = { reasoning_effort: mapped };
    if (reasoningEffort === "max") {
      payload.max_completion_tokens = 25000;
    }
    return { payload, isThinkingModel: true };
  }

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

  const isGeminiThinking =
    modelLower.includes("gemini") &&
    (modelLower.includes("thinking") ||
      modelLower.includes("flash") ||
      modelLower.includes("high") ||
      modelLower.includes("pro"));

  if (isGeminiThinking) {
    const geminiEffortMap = { low: "low", medium: "medium", high: "high", max: "high" };
    const geminiBudgetMap = { low: 2048, medium: 4096, high: 8192, max: 16384 };
    return {
      payload: {
        reasoning_effort: geminiEffortMap[reasoningEffort] || "medium",
        thinking_budget: geminiBudgetMap[reasoningEffort] || 4096,
      },
      isThinkingModel: true,
    };
  }

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

  if (modelLower.includes("thinking") || modelLower.includes("reason")) {
    return {
      payload: {
        reasoning_effort: reasoningEffort === "max" ? "high" : reasoningEffort,
      },
      isThinkingModel: true,
    };
  }

  return { payload: {}, isThinkingModel: false };
}

function sendStreamEvent(sender, sessionId, type, data, runId = null) {
  if (!sender || (sender.isDestroyed && sender.isDestroyed())) return;
  try {
    sender.send("chat-stream-event", { sessionId, runId, type, data });
  } catch {
    // 忽略已关闭窗口异常
  }
}

module.exports = {
  PROJECT_ROOT,
  MODULES,
  lazyRequire,
  getLoadedModule,
  getStorageService,
  getReasoningPolicy,
  getUpdaterService,
  getWorkspaceGitService,
  getContextCalculator,
  getToolRegistry,
  getWebTools,
  getFileIndexer,
  getMentionResolver,
  getPathResolver,
  getContextBuilder,
  getMcpClientService,
  getMcpOAuthService,
  getSubagentService,
  getSkillMarketService,
  getTerminalPtyService,
  getRepoIndexService,
  getRepoWikiService,
  getFontService,
  getCommandService,
  getSpecService,
  getBtwService,
  getHookService,
  getGitHunkService,
  getGitWorktreeService,
  getSessionTransferService,
  getBrowserAutomationService,
  getAnthropicClient,
  getSandboxPolicyService,
  getContextCompactor,
  activeStreamSnapshotFlushers,
  activeStreamSessions,
  pendingPermissions,
  PERMISSION_TIMEOUT_MS,
  setMainWindow,
  getMainWindow,
  asyncPathExists,
  asyncStatSafe,
  flushActiveRunsAndStorageOnExit,
  notifyMainProcessError,
  isSafeExternalUrl,
  safeHandler,
  isKnownSessionOutputPath,
  getApiConfig,
  getWorkspaceFolders,
  extFromMime,
  processAttachmentImageBuffer,
  processAttachmentImage,
  extractTextContent,
  hasUnclosedCodeFence,
  encodeAttachmentForModelAsync,
  getAttachmentExtension,
  isImageFile,
  isTextLikeFile,
  formatBytes,
  buildAttachmentMessagesAsync,
  getModelConfig,
  normalizeUsage,
  mergeUsage,
  computeUsageCost,
  pickLiteModel,
  buildReasoningPayload,
  sendStreamEvent,
};
