/**
 * fileTools — 基于 LangChain StructuredTool 的文件操作工具
 *
 * 保留原有路径安全校验，增强：编码自动检测、大文件分页、错误恢复、结构化输出
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { z } = require("zod");
const { StructuredTool } = require("@langchain/core/tools");

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

const { resolveWorkspacePath } = require("./pathResolver");

async function checkSafePath(userPath, workDir, allowedFolders, checkPermissionFn, actionDesc = "访问") {
  const { resolvedPath, isExternal } = resolveWorkspacePath(userPath, workDir, allowedFolders);
  if (isExternal && typeof checkPermissionFn === "function") {
    const isAllowed = await checkPermissionFn(resolvedPath, actionDesc);
    if (!isAllowed) {
      throw new Error(`用户已拒绝授权访问工作空间外部路径: ${resolvedPath}`);
    }
  }
  return resolvedPath;
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

  async _call({ path: filePath, maxLines = 200, offset = 0, __workDir, __allowedFolders, __checkPermission }) {
    let targetPath;
    try {
      targetPath = await checkSafePath(filePath, __workDir, __allowedFolders, __checkPermission, "读取");
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }

    if (!fs.existsSync(targetPath)) {
      return JSON.stringify({ success: false, error: `文件不存在: ${filePath}` });
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return JSON.stringify({ success: false, error: `路径不是文件: ${filePath}` });
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

  async _call({ path: filePath, content, description, __workDir, __allowedFolders, __checkPermission }) {
    let targetPath;
    try {
      targetPath = await checkSafePath(filePath, __workDir, __allowedFolders, __checkPermission, "写入/创建");
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }

    // 检查父目录是否存在
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const isNew = !fs.existsSync(targetPath);
    let originalContent = "";
    if (!isNew) {
      originalContent = fs.readFileSync(targetPath, "utf-8");
    }

    fs.writeFileSync(targetPath, content, "utf-8");

    return JSON.stringify({
      success: true,
      path: filePath,
      action: isNew ? "created" : "modified",
      description: description || (isNew ? "创建新文件" : "修改已有文件"),
      size: Buffer.byteLength(content, "utf-8"),
      originalSize: originalContent ? Buffer.byteLength(originalContent, "utf-8") : 0,
      diffHint: isNew ? null : "(文件已修改，建议使用 git diff 查看具体变更)",
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

  async _call({ path: dirPath = ".", depth = 1, __workDir, __allowedFolders, __checkPermission }) {
    let targetPath;
    try {
      targetPath = await checkSafePath(dirPath, __workDir, __allowedFolders, __checkPermission, "浏览目录");
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
          if (item.startsWith(".") && !item.startsWith(".") === false) continue; // skip hidden files/dirs
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

  async _call({ query, include, maxResults = 20, contextLines = 0, __workDir, __allowedFolders }) {
    try {
      const searchTargets = Array.isArray(__allowedFolders) && __allowedFolders.length > 0
        ? __allowedFolders.map((f) => `"${path.resolve(f)}"`).join(" ")
        : `"${path.resolve(__workDir || DEFAULT_ROOT)}"`;

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
      const results = lines.slice(0, maxResults).map((line) => {
        // rg 输出格式: filepath:lineno:content
        const firstColon = line.indexOf(":");
        const secondColon = line.indexOf(":", firstColon + 1);
        if (firstColon === -1) return { file: line, line: 0, content: "" };
        return {
          file: line.substring(0, firstColon).replace(rootPath + "/", ""),
          line: parseInt(line.substring(firstColon + 1, secondColon), 10) || 0,
          content: line.substring(secondColon + 1),
        };
      });

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
  ReadFileTool,
  WriteFileTool,
  ListDirectoryTool,
  SearchCodeTool,
};