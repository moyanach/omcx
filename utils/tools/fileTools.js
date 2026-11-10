/**
 * fileTools — 基于 LangChain StructuredTool 的文件操作工具
 *
 * 保留原有路径安全校验，增强：
 * 1. 接入 4 档权限模式与沙箱策略 (plan / auto-sandbox / ask / full-access)
 * 2. realpath 物理路径防软链接穿越 + 宿主机敏感凭据黑名单拦截
 * 3. 工作区内受保护配置 (.git/hooks, .omcx) 写入确认保护
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { z } = require("zod");
const { StructuredTool } = require("@langchain/core/tools");
const { resolveWorkspacePath } = require("./pathResolver");
const {
  PERMISSION_MODES,
  getPermissionModePolicy,
  checkSensitivePath,
} = require("../../services/sandboxPolicyService");
const { fileLockService } = require("../../services/fileLockService");

// ─── 路径安全 ────────────────────────────────────────────────

function getProjectRoot() {
  const candidates = [
    path.join(__dirname, "..", ".."),       // utils/tools/../.. → 项目根
    process.cwd(),
  ];
  for (const dir of candidates) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) return dir;
  }
  return path.resolve(__dirname, "..", "..");
}

const PROJECT_ROOT = getProjectRoot();
const DEFAULT_ROOT = PROJECT_ROOT;

async function checkSafePath(
  userPath,
  workDir,
  allowedFolders,
  checkPermissionFn,
  actionDesc = "访问",
  options = {}
) {
  const mode = options.mode === "write" ? "write" : "read";
  const toolContext = options.toolContext || {};
  const permissionMode = toolContext.permissionMode || PERMISSION_MODES.AUTO_SANDBOX;
  const policy = getPermissionModePolicy(permissionMode);
  const sessionId = toolContext.sessionId || null;
  const writableFolders = toolContext.writableFolders || null;

  // 1. 只读规划模式下，严禁任何文件写入
  if (mode === "write" && !policy.allowFileWrite) {
    throw new Error(
      `当前会话处于「${policy.label} (${permissionMode})」模式，禁止创建或修改文件。请仅输出分析与规划方案，或提示用户在输入框左下角将权限模式切换为「工作区沙箱」。`
    );
  }

  const resolved = resolveWorkspacePath(userPath, workDir, allowedFolders, {
    mode,
    sessionId,
    writableFolders,
  });

  // 2. 高敏凭据与客户端私密配置黑名单强制拦截
  if (resolved.isSensitiveBlocked) {
    throw new Error(resolved.sensitiveReason || `安全策略已禁止访问敏感路径: ${userPath}`);
  }

  // 3. 外部路径越界拦截（full-access 模式下读取外部普通文件免弹窗，但写入外部路径仍需确认）
  if (resolved.isExternal) {
    const skipReadPromptInFullAccess =
      mode === "read" && permissionMode === PERMISSION_MODES.FULL_ACCESS;
    if (!skipReadPromptInFullAccess) {
      if (typeof checkPermissionFn === "function") {
        const isAllowed = await checkPermissionFn(resolved.resolvedPath, actionDesc, {
          kind: "external_path",
          reason:
            mode === "write"
              ? "Agent 正在请求写入工作空间以外的外部路径，请确认是否授权"
              : "该路径位于当前已选定的工作空间源文件夹之外，请确认是否允许 Agent 读取该外部路径",
        });
        if (!isAllowed) {
          throw new Error(`用户已拒绝授权${actionDesc}工作空间外部路径: ${resolved.resolvedPath}`);
        }
      } else {
        throw new Error(`路径超出当前工作空间允许范围: ${resolved.resolvedPath}`);
      }
    }
    return resolved.resolvedPath;
  }

  // 4. 工作区内受保护控制配置写入拦截 (.git/hooks, .omcx 等)
  if (mode === "write" && resolved.isProtectedWrite) {
    if (typeof checkPermissionFn === "function") {
      const isAllowed = await checkPermissionFn(resolved.resolvedPath, `${actionDesc}受保护配置`, {
        kind: "protected_write",
        reason: resolved.protectedReason,
      });
      if (!isAllowed) {
        throw new Error(`用户已拒绝修改受保护配置文件: ${resolved.resolvedPath}`);
      }
    } else {
      throw new Error(resolved.protectedReason || `禁止修改受保护配置: ${resolved.resolvedPath}`);
    }
    return resolved.resolvedPath;
  }

  // 5. 「询问确认 (ask)」模式下，工作区内每次写入文件前请求用户确认
  if (mode === "write" && policy.confirmFileWrite && typeof checkPermissionFn === "function") {
    const isAllowed = await checkPermissionFn(resolved.resolvedPath, `${actionDesc}文件`, {
      kind: "ask_write",
      reason: "当前处于「询问确认」权限模式，修改工作区文件前需经您确认",
      allowSwitchAutoSandbox: true,
    });
    if (!isAllowed) {
      throw new Error(`用户已取消${actionDesc}文件: ${userPath}`);
    }
  }

  return resolved.resolvedPath;
}

// ─── 工具: read_file ─────────────────────────────────────────

class ReadFileTool extends StructuredTool {
  constructor() {
    super();
    this.name = "read_file";
    this.description = "读取项目文件的内容。支持任意文本文件，自动检测编码。适合查看源代码、配置文件、文档、数据文件等。";
    this.schema = z.object({
      path: z.string().describe("文件路径，相对于项目根目录或绝对路径"),
      maxLines: z.number().optional().default(200).describe("最大读取行数（默认 200，设为 -1 读取全部）"),
      offset: z.number().optional().default(0).describe("起始行号（从 0 开始，默认 0）"),
    });
  }

  async _call(rawArgs) {
    const {
      path: filePath,
      maxLines = 200,
      offset = 0,
      __workDir,
      __allowedFolders,
      __checkPermission,
      __toolContext,
    } = rawArgs || {};

    const targetFilePath = filePath ?? rawArgs?.filepath ?? rawArgs?.file_path ?? rawArgs?.file;
    if (!targetFilePath || typeof targetFilePath !== "string" || !targetFilePath.trim()) {
      return JSON.stringify({
        success: false,
        error: `read_file 调用失败: 缺少有效的文件路径 path 参数。`,
      });
    }

    let targetPath;
    try {
      targetPath = await checkSafePath(targetFilePath, __workDir, __allowedFolders, __checkPermission, "读取", {
        mode: "read",
        toolContext: __toolContext,
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }

    if (!fs.existsSync(targetPath)) {
      return JSON.stringify({ success: false, error: `文件不存在: ${targetFilePath}` });
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return JSON.stringify({ success: false, error: `路径不是文件: ${targetFilePath}` });
    }

    const content = fs.readFileSync(targetPath, "utf-8");
    const lines = content.split("\n");

    if (maxLines === -1) {
      // 读取全部
      return JSON.stringify({
        success: true,
        path: filePath,
        totalLines: lines.length,
        content,
        size: content.length,
        truncated: false,
      });
    }

    const start = offset;
    const end = Math.min(offset + maxLines, lines.length);
    const limited = lines.slice(start, end);
    const isTruncated = lines.length > end;

    return JSON.stringify({
      success: true,
      path: filePath,
      totalLines: lines.length,
      startLine: start,
      endLine: end,
      content: limited.join("\n"),
      size: limited.join("\n").length,
      truncated: isTruncated,
      note: isTruncated
        ? `文件共 ${lines.length} 行，当前显示 ${start + 1}-${end} 行（共 ${maxLines} 行）。使用 offset 参数继续读取。`
        : undefined,
    });
  }
}

// ─── 工具: write_file ────────────────────────────────────────

class WriteFileTool extends StructuredTool {
  constructor() {
    super();
    this.name = "write_file";
    this.description = "创建新文件或修改已有文件的内容。请在写入前先用 read_file 确认现有内容。注意：危险操作，需要用户确认。";
    this.schema = z.object({
      path: z.string().describe("文件路径，相对于工作目录"),
      content: z.string().describe("要写入的完整文件内容"),
      description: z.string().optional().describe("变更说明，描述本次修改的目的和变更内容"),
    });
  }

  async _call(rawArgs) {
    const {
      path: filePath,
      content,
      description,
      __workDir,
      __allowedFolders,
      __checkPermission,
      __toolContext,
    } = rawArgs || {};

    // 1. 兼容文件路径别名
    const targetFilePath = filePath ?? rawArgs?.filepath ?? rawArgs?.file_path ?? rawArgs?.file;
    if (!targetFilePath || typeof targetFilePath !== "string" || !targetFilePath.trim()) {
      return JSON.stringify({
        success: false,
        error: `write_file 调用失败: 缺少有效的文件路径 path 参数。`,
      });
    }

    // 2. 参数防御与常见大模型别名吸收 (text / data / code / file_content 等)
    let finalContent = content;
    if (finalContent === undefined || finalContent === null) {
      finalContent =
        rawArgs?.text ??
        rawArgs?.data ??
        rawArgs?.code ??
        rawArgs?.file_content ??
        rawArgs?.fileContent ??
        rawArgs?.body;
    }

    if (finalContent === undefined || finalContent === null) {
      return JSON.stringify({
        success: false,
        error: `write_file 调用失败: 缺少必需参数 content (接收到的内容为 undefined)。请在 content 参数中提供要写入的完整文件内容（字符串形式）后重试。`,
      });
    }

    // 3. 自动转换非字符串形式的内容 (如大模型把 JSON 对象直接塞入参数)
    if (typeof finalContent !== "string") {
      if (typeof finalContent === "object") {
        try {
          finalContent = JSON.stringify(finalContent, null, 2);
        } catch {
          finalContent = String(finalContent);
        }
      } else {
        finalContent = String(finalContent);
      }
    }

    let targetPath;
    try {
      targetPath = await checkSafePath(targetFilePath, __workDir, __allowedFolders, __checkPermission, "写入/创建", {
        mode: "write",
        toolContext: __toolContext,
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }

    // 检查父目录是否存在
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // 路径级异步排他并发锁：同文件排他，不同文件天然并发，杜绝交叉修改覆盖
    return await fileLockService.withLock(targetPath, async () => {
      const isNew = !fs.existsSync(targetPath);
      let originalContent = "";
      if (!isNew) {
        originalContent = fs.readFileSync(targetPath, "utf-8");
      }

      fs.writeFileSync(targetPath, finalContent, "utf-8");

      const MAX_SNAPSHOT_CHARS = 30000;
      const originalTruncated = originalContent.length > MAX_SNAPSHOT_CHARS;
      const originalSnapshot = !isNew
        ? originalTruncated
          ? originalContent.slice(0, MAX_SNAPSHOT_CHARS)
          : originalContent
        : undefined;

      return JSON.stringify({
        success: true,
        path: targetFilePath,
        action: isNew ? "created" : "modified",
        description: description || (isNew ? "创建新文件" : "修改已有文件"),
        size: Buffer.byteLength(finalContent, "utf-8"),
        originalSize: originalContent ? Buffer.byteLength(originalContent, "utf-8") : 0,
        diffHint: isNew ? null : "(文件已修改，建议使用 git diff 查看具体变更)",
        ...(originalSnapshot !== undefined ? { originalContent: originalSnapshot } : {}),
        ...(originalTruncated ? { originalTruncated: true } : {}),
      });
    });
  }
}

// ─── 工具: list_directory ────────────────────────────────────

class ListDirectoryTool extends StructuredTool {
  constructor() {
    super();
    this.name = "list_directory";
    this.description = "列出项目目录中的文件和子目录。适合浏览项目结构、查找文件。自动跳过 node_modules、dist、.git 等目录。";
    this.schema = z.object({
      path: z.string().optional().default(".").describe("目录路径，相对于项目根目录（默认 '.'）"),
      depth: z.number().optional().default(1).describe("递归深度（默认 1，设为 2 或 3 查看更多层级）"),
    });
  }

  async _call({ path: dirPath = ".", depth = 1, __workDir, __allowedFolders, __checkPermission, __toolContext }) {
    let targetPath;
    try {
      targetPath = await checkSafePath(dirPath, __workDir, __allowedFolders, __checkPermission, "浏览目录", {
        mode: "read",
        toolContext: __toolContext,
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }

    const rootPath = targetPath;

    if (!fs.existsSync(targetPath)) {
      return JSON.stringify({ success: false, error: `目录不存在: ${dirPath}` });
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return JSON.stringify({ success: false, error: `路径不是目录: ${dirPath}` });
    }

    const skipDirs = new Set(["node_modules", ".git", "dist", ".next", "build", ".cache"]);
    const skipFiles = new Set([".DS_Store"]);

    function scanDir(dir, currentDepth) {
      if (currentDepth > depth) return [];
      const entries = [];
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (item.startsWith(".")) continue; // skip hidden files/dirs
          if (skipFiles.has(item)) continue;
          const fullPath = path.join(dir, item);
          const isDir = fs.statSync(fullPath).isDirectory();
          if (isDir && skipDirs.has(item)) continue;
          const relPath = path.relative(rootPath, fullPath);
          entries.push({
            name: item,
            type: isDir ? "directory" : "file",
            path: relPath,
          });
          if (isDir) {
            entries.push(...scanDir(fullPath, currentDepth + 1));
          }
        }
      } catch (e) {
        // 跳过无法读取的目录
      }
      return entries;
    }

    const entries = scanDir(targetPath, 1);
    return JSON.stringify({
      success: true,
      path: dirPath,
      entries,
      total: entries.length,
    });
  }
}

// ─── 工具: search_code ───────────────────────────────────────

class SearchCodeTool extends StructuredTool {
  constructor() {
    super();
    this.name = "search_code";
    this.description = "搜索项目代码中的关键字、函数名、变量名、错误信息等。使用 ripgrep 引擎，支持正则表达式。适合定位代码定义、查找引用、搜索错误位置。";
    this.schema = z.object({
      query: z.string().describe("搜索关键字（支持正则表达式）"),
      include: z.string().optional().describe("文件类型过滤，如 '*.ts'、'*.{tsx,jsx}'"),
      maxResults: z.number().optional().default(20).describe("最多返回结果数（默认 20）"),
      contextLines: z.number().optional().default(0).describe("每行结果前后显示的上下文行数（默认 0）"),
    });
  }

  async _call({ query, include, maxResults = 20, contextLines = 0, __workDir, __allowedFolders, __toolContext }) {
    try {
      const rootPath = path.resolve(__workDir || DEFAULT_ROOT);
      const sessionId = __toolContext?.sessionId || null;
      const folderCandidates =
        Array.isArray(__toolContext?.writableFolders) && __toolContext.writableFolders.length > 0
          ? __toolContext.writableFolders
          : Array.isArray(__allowedFolders) && __allowedFolders.length > 0
          ? __allowedFolders
          : [rootPath];

      const safeFolders = folderCandidates.filter(
        (f) => f && fs.existsSync(f) && !checkSensitivePath(f, sessionId).blocked
      );
      const searchTargets = (safeFolders.length > 0 ? safeFolders : [rootPath])
        .map((f) => `"${path.resolve(f)}"`)
        .join(" ");

      let cmd = `rg -n --no-heading`;
      if (contextLines > 0) {
        cmd += ` -C ${contextLines}`;
      }
      cmd += ` "${query.replace(/"/g, '\\"')}"`;
      if (include) {
        cmd += ` -g "${include}"`;
      }
      cmd += ` --glob '!node_modules' --glob '!.git' --glob '!dist'`;
      cmd += ` ${searchTargets}`;

      const stdout = execSync(cmd, {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 15000,
      });

      const lines = stdout.trim().split("\n").filter(Boolean);
      const results = [];
      for (const line of lines) {
        if (results.length >= maxResults) break;
        const firstColon = line.indexOf(":");
        const secondColon = line.indexOf(":", firstColon + 1);
        if (firstColon === -1) continue;
        const rawFilePath = line.substring(0, firstColon);
        if (checkSensitivePath(rawFilePath, sessionId).blocked) continue;
        results.push({
          file: rawFilePath.startsWith(rootPath + "/")
            ? rawFilePath.slice(rootPath.length + 1)
            : rawFilePath,
          line: parseInt(line.substring(firstColon + 1, secondColon), 10) || 0,
          content: line.substring(secondColon + 1),
        });
      }

      return JSON.stringify({
        success: true,
        total: lines.length,
        results,
        truncated: lines.length > maxResults,
      });
    } catch (err) {
      if (err.status === 1 && err.stdout === "") {
        return JSON.stringify({ success: true, total: 0, results: [], truncated: false });
      }
      if (err.stderr && err.stderr.includes("not found")) {
        return JSON.stringify({ success: false, error: "需要安装 ripgrep (rg) 来使用代码搜索功能" });
      }
      return JSON.stringify({ success: false, error: `搜索失败: ${err.message}` });
    }
  }
}

module.exports = {
  PROJECT_ROOT,
  checkSafePath,
  ReadFileTool,
  WriteFileTool,
  ListDirectoryTool,
  SearchCodeTool,
};
