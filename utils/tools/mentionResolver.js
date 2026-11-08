const fs = require("fs");
const path = require("path");
const { resolveWorkspacePath, isUnderFolder } = require("./pathResolver");
const { isIgnoredName } = require("./fileIndexer");
const { discoverSubagents } = require("../../services/subagentService");

const MAX_FILE_CHARS = 160000;
const MAX_FILE_LINES = 2000;
const MAX_TOTAL_CHARS = 120000;
const MAX_TREE_ENTRIES = 200;
const TREE_DEPTH = 2;

const LANGUAGE_BY_EXT = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".sh": "bash",
  ".zsh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".xml": "xml",
  ".env": "bash",
};

const MENTION_PATTERN = /(?:^|[\s(（[【"'`\u4e00-\u9fa5])@([^\s@`"'<>|]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>，。；：！？、】》」』…]+$/;

function extractMentions(text) {
  if (!text || typeof text !== "string") return [];
  const sanitized = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");

  const results = [];
  const seen = new Set();
  MENTION_PATTERN.lastIndex = 0;
  let match;
  while ((match = MENTION_PATTERN.exec(sanitized)) !== null) {
    let target = (match[1] || "").replace(TRAILING_PUNCTUATION, "");
    if (!target) continue;
    if (target.startsWith("./")) target = target.slice(2);
    if (target === "." || target === "..") continue;
    if (seen.has(target)) continue;
    seen.add(target);
    results.push(target);
    if (results.length >= 30) break;
  }
  return results;
}

function realPathSafe(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function isInsideFolders(targetPath, folders) {
  const resolved = path.resolve(targetPath);
  return folders.some((folder) => {
    const realFolder = realPathSafe(folder);
    return isUnderFolder(resolved, folder) || isUnderFolder(resolved, realFolder);
  });
}

function fenceFor(content) {
  const runs = content.match(/`{3,}/g);
  if (!runs) return "```";
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 3);
  return "`".repeat(Math.min(longest + 1, 10));
}

function readTextFile(absPath) {
  const stat = fs.statSync(absPath);
  const limitBytes = Math.min(stat.size, MAX_FILE_CHARS * 4);
  const fd = fs.openSync(absPath, "r");
  let buffer;
  try {
    buffer = Buffer.alloc(limitBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, limitBytes, 0);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }

  if (buffer.subarray(0, 8192).includes(0)) {
    return { binary: true };
  }

  let text = buffer.toString("utf8");
  let truncated = false;

  if (text.length > MAX_FILE_CHARS) {
    text = text.slice(0, MAX_FILE_CHARS);
    truncated = true;
  }

  const lines = text.split("\n");
  if (lines.length > MAX_FILE_LINES) {
    text = lines.slice(0, MAX_FILE_LINES).join("\n");
    truncated = true;
  }

  return { binary: false, text, truncated };
}

function buildDirectoryTree(absDir, displayPath) {
  const lines = [`${displayPath.replace(/\/+$/, "")}/`];
  let count = 0;
  let truncated = false;

  const walk = (dirAbs, depth) => {
    if (depth > TREE_DEPTH || truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (count >= MAX_TREE_ENTRIES) {
        lines.push(`${"  ".repeat(depth)}... (目录条目过多，已截断)`);
        truncated = true;
        return;
      }
      if (isIgnoredName(entry.name, entry.isDirectory())) continue;
      const isDir = entry.isDirectory();
      lines.push(`${"  ".repeat(depth)}${entry.name}${isDir ? "/" : ""}`);
      count += 1;
      if (isDir) walk(path.join(dirAbs, entry.name), depth + 1);
    }
  };

  walk(absDir, 1);
  return { tree: lines.join("\n"), truncated };
}

function buildCandidates(mention) {
  const candidates = [mention];
  let current = mention;
  for (let i = 0; i < 12; i += 1) {
    const next = current
      .replace(TRAILING_PUNCTUATION, "")
      .replace(/[\u4e00-\u9fa5]+$/, "")
      .replace(TRAILING_PUNCTUATION, "");
    if (!next || next === current) break;
    candidates.push(next);
    current = next;
  }
  return candidates;
}

function resolveMentionTarget(mention, workDir, allowedFolders) {
  const folders = allowedFolders.length > 0
    ? allowedFolders
    : (workDir ? [path.resolve(workDir)] : []);
  if (folders.length === 0) {
    return { ok: false, reason: "no-workspace" };
  }

  let sawOutside = false;
  let sawSensitive = false;

  for (const candidate of buildCandidates(mention)) {
    const { resolvedPath, isExternal, isSensitiveBlocked } = resolveWorkspacePath(candidate, workDir, folders, {
      mode: "read",
    });
    if (isSensitiveBlocked) {
      sawSensitive = true;
      continue;
    }
    if (isExternal) {
      sawOutside = true;
      continue;
    }
    if (!isInsideFolders(resolvedPath, folders)) {
      sawOutside = true;
      continue;
    }
    if (!fs.existsSync(resolvedPath)) continue;

    let stat;
    try {
      stat = fs.statSync(resolvedPath);
    } catch {
      continue;
    }

    return {
      ok: true,
      absPath: resolvedPath,
      isDir: stat.isDirectory(),
      displayPath: candidate.replace(/\/+$/, ""),
    };
  }

  return {
    ok: false,
    reason: sawSensitive ? "sensitive" : sawOutside ? "outside" : "missing",
  };
}

function buildMentionContext(text, workDir, allowedFolders = [], extraContext = {}) {
  const mentions = extractMentions(text);
  const result = { block: "", files: [], dirs: [], skills: [], mcps: [], subagents: [], skipped: [] };
  if (mentions.length === 0) return result;

  const skills = Array.isArray(extraContext.skills) ? extraContext.skills : [];
  const mcpServers = Array.isArray(extraContext.mcpServers) ? extraContext.mcpServers : [];
  const subagents = discoverSubagents(workDir);

  const parts = [];
  let totalChars = 0;
  let budgetExhausted = false;

  for (const mention of mentions) {
    if (budgetExhausted) {
      result.skipped.push({ mention, reason: "budget" });
      continue;
    }

    // 0. 匹配 @agent:id 显式指定子代理
    if (mention.startsWith("agent:")) {
      const agentId = mention.slice(6).trim().toLowerCase();
      const matchedAgent = subagents.find(
        (a) => a.id.toLowerCase() === agentId || a.name.toLowerCase().includes(agentId)
      );
      if (matchedAgent) {
        const section = [
          `### 用户显式指定调度的子代理: ${matchedAgent.name} (ID: ${matchedAgent.id})`,
          `职责说明: ${matchedAgent.description || "无"}`,
          `权限模式: ${matchedAgent.readOnly ? "只读安全模式" : "完整读写模式"}`,
          `【执行指示】用户在本次提问中显式点名使用子代理 [${matchedAgent.id}]，请优先调用 \`dispatch_subagent\` 工具（设置 agent="${matchedAgent.id}"）委派相关任务。`,
        ].join("\n");
        totalChars += section.length;
        parts.push(section);
        result.subagents.push(matchedAgent.id);
        continue;
      }
    }

    // A. 匹配 @skill:name 专家技能
    if (mention.startsWith("skill:")) {
      const skillName = mention.slice(6).trim();
      const matchedSkill = skills.find((s) => s.name === skillName || s.id === skillName);
      if (matchedSkill) {
        const fence = fenceFor(matchedSkill.prompt || "");
        const toolList = (matchedSkill.tools || []).join(", ") || "无特定依赖工具";
        const section = [
          `### 用户显式激活的专家技能: ${matchedSkill.name} (${matchedSkill.scope || "global"})`,
          `描述: ${matchedSkill.description || "无"}`,
          `依赖工具: ${toolList}`,
          `【执行指示】用户在本次提问中显式激活此技能，请以此技能最高工作流标准优先开展分析与执行：`,
          `${fence}markdown\n${matchedSkill.prompt || "无额外提示词说明"}\n${fence}`,
        ].join("\n");

        if (totalChars + section.length > MAX_TOTAL_CHARS) {
          budgetExhausted = true;
          result.skipped.push({ mention, reason: "budget" });
          continue;
        }
        totalChars += section.length;
        parts.push(section);
        result.skills.push(matchedSkill.name);
        continue;
      }
    }

    // B. 匹配 @mcp:name 外部连接器
    if (mention.startsWith("mcp:")) {
      const mcpName = mention.slice(4).trim();
      const matchedMcp = mcpServers.find((m) => m.name === mcpName || m.id === mcpName);
      if (matchedMcp) {
        const argsStr = Array.isArray(matchedMcp.args) ? matchedMcp.args.join(" ") : "";
        const section = [
          `### 用户显式引用的外部连接器: ${matchedMcp.name}`,
          `运行命令: ${matchedMcp.command} ${argsStr}`,
          `节点说明: ${matchedMcp.description || "标准 MCP 外部服务节点"}`,
          `【执行指示】用户在本轮中指定引用此 MCP 连接器，请优先考虑通过此连接器调度相关扩展工具。`,
        ].join("\n");

        if (totalChars + section.length > MAX_TOTAL_CHARS) {
          budgetExhausted = true;
          result.skipped.push({ mention, reason: "budget" });
          continue;
        }
        totalChars += section.length;
        parts.push(section);
        result.mcps.push(matchedMcp.name);
        continue;
      }
    }

    // C. 匹配工作空间文件与目录
    const target = resolveMentionTarget(mention, workDir, allowedFolders);
    if (!target.ok) {
      result.skipped.push({ mention, reason: target.reason });
      continue;
    }

    if (target.isDir) {
      const { tree, truncated } = buildDirectoryTree(target.absPath, target.displayPath);
      const fence = fenceFor(tree);
      const body = `${fence}text\n${tree}\n${fence}${truncated ? "\n（该目录条目过多，已截断）" : ""}`;
      const section = `### 目录: ${target.displayPath}/\n${body}`;
      if (totalChars + section.length > MAX_TOTAL_CHARS) {
        budgetExhausted = true;
        result.skipped.push({ mention, reason: "budget" });
        continue;
      }
      totalChars += section.length;
      parts.push(section);
      result.dirs.push(target.displayPath);
      continue;
    }

    const read = readTextFile(target.absPath);
    if (read.binary) {
      result.skipped.push({ mention, reason: "binary" });
      continue;
    }

    const ext = path.extname(target.absPath).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext] || "text";
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining < 500) {
      budgetExhausted = true;
      result.skipped.push({ mention, reason: "budget" });
      continue;
    }

    let content = read.text;
    let truncated = read.truncated;
    if (content.length > remaining - 200) {
      content = content.slice(0, Math.max(remaining - 200, 0));
      truncated = true;
    }

    const fence = fenceFor(content);
    const section = `### 文件: ${target.displayPath}\n${fence}${language}\n${content}\n${fence}${truncated ? "\n（该文件内容过长，已截断）" : ""}`;
    totalChars += section.length;
    parts.push(section);
    result.files.push(target.displayPath);
  }

  if (parts.length === 0) return result;

  const header = [
    "【用户通过 @ 显式引用的统一上下文资源】",
    "以下技能规范、外部连接器或文件内容由客户端在发送前自动读取并置顶注入。对于技能已预先装配工作流指令，对于文件已提供完整代码，请直接以此开展分析与执行。",
  ].join("\n");

  result.block = `${header}\n\n${parts.join("\n\n")}`;
  return result;
}

module.exports = {
  extractMentions,
  buildMentionContext,
  resolveMentionTarget,
};
