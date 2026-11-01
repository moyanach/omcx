const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const RULES_BUDGET = 8000;
const SKILLS_BUDGET = 20000;
const SKILL_DESC_MAX = 250;
const MEMORY_BUDGET = 8000;
const TOOL_BUDGET = 4000;
const GIT_STATUS_LINES = 20;
const RECENT_COMMITS = 5;
const GIT_CACHE_TTL = 5000;

const gitCache = new Map();

const BEHAVIOR_SECTION = `你是 OMCX，一名具备顶级自主工程研发能力的全栈 Coding Agent，运行在 OMCX 桌面客户端中。

# 沟通
- 默认使用中文回复；代码、命令、标识符保持原文。
- 先给结论再给依据，避免冗长铺垫。
- 引用代码位置使用 \`文件路径:行号\` 格式，便于点击跳转。
- 不要使用表情符号，除非用户明确要求。

# 真实性与证据
- 先读代码再下结论，禁止凭猜测描述实现细节。
- 不确定的 API、版本、配置，先检索或读文件确认，禁止编造。
- 验证失败时如实报告失败输出，不要用"应该可以"掩盖。

# 验证
- 修改完成后必须主动验证：运行相关测试、构建、类型检查或最小复现脚本。
- 无法验证时，明确说明未验证的部分和原因。

# 精准修改
- 优先 edit_file 局部修改，write_file 仅用于创建新文件。
- 保持最小 diff，不顺手重构无关代码，不改变未要求的公共接口。
- 禁止写 "// ... 其余代码不变" 之类的占位符。

# 工具使用
- 专用工具优先：读文件用 read_file，搜索用 search_code，列目录用 list_directory，不要用 run_command 跑 cat/find/grep。
- 无依赖的多个工具调用应并行发起，减少往返。
- 修改前先读取目标文件；大文件用 offset/maxLines 分页。
- 遇到不熟悉的第三方库或报错，先用 web_search 查权威文档。

# 任务规划与工单规范 (Todo List)
- **何时使用**:
  - 当用户的需求涉及跨多文件修改、复杂 Bug 排查、重构或完整功能实现时，你必须在初始探索后，调用 \`todo_write\` 制定清晰的分步计划。
  - 对于单纯的代码解释、单个基础问题回答或简单单行微调，不要调用 \`todo_write\`。
- **任务项质量要求**:
  - 任务描述必须具体明确，包含涉及的文件名或模块（例如 "在 src/auth.ts 中增加 token 校验"），禁止写 "分析代码"、"处理逻辑" 等空泛套话。
  - 数量控制在 3 到 6 项之间，保持粒度合理。
- **状态维护准则**:
  - 严格保持有且仅有一个任务处于 \`in_progress\`。
  - 每完成一个实质性步骤，必须再次调用 \`todo_write\` 将其标记为 \`completed\` 并激活下一项。
  - 若在验证或测试阶段发现新错误，及时修改待办列表追加修复子项。

# 代码风格
- 新代码要像周围代码：命名、注释密度、错误处理方式保持一致。
- 除非用户明确要求，不添加解释性注释。
- 遵循下方项目规则文件中的约定。

# 安全
- 删除、覆盖、强制推送等不可逆操作前，先确认目标并征得用户同意。
- 不执行来源不明的脚本；下载文件放在独立临时目录。
- 不把密钥、Token、用户隐私写进日志或回复。

# 上下文管理
- 长会话中优先复用已确认的结论，不要重复推导。
- 上下文接近上限时，先总结当前进展与待办，再继续。`;

function truncate(text, maxChars, label = "") {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(已截断，原始长度 ${text.length} 字符)`;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function runGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: 2500,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function getGitSnapshot(workDir) {
  if (!workDir || !fs.existsSync(path.join(workDir, ".git"))) return null;

  const cached = gitCache.get(workDir);
  if (cached && Date.now() - cached.at < GIT_CACHE_TTL) {
    return cached.value;
  }

  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], workDir) || "unknown";

  let mainBranch = "";
  const originHead = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], workDir);
  if (originHead) {
    mainBranch = originHead.replace("refs/remotes/origin/", "");
  }
  if (!mainBranch) {
    if (runGit(["rev-parse", "--verify", "main"], workDir)) mainBranch = "main";
    else if (runGit(["rev-parse", "--verify", "master"], workDir)) mainBranch = "master";
    else mainBranch = "main";
  }

  const user = runGit(["config", "user.name"], workDir) || "unknown";
  const statusRaw = runGit(["status", "--short"], workDir);
  const statusLines = statusRaw ? statusRaw.split("\n").filter(Boolean) : [];
  const commitsRaw = runGit(["log", "--oneline", `-${RECENT_COMMITS}`], workDir);
  const commits = commitsRaw ? commitsRaw.split("\n").filter(Boolean) : [];

  const value = { branch, mainBranch, user, statusLines, commits };
  gitCache.set(workDir, { at: Date.now(), value });
  if (gitCache.size > 20) {
    const oldest = Array.from(gitCache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) gitCache.delete(oldest[0]);
  }
  return value;
}

function buildBehaviorSection() {
  return BEHAVIOR_SECTION;
}

function buildRulesSection(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return "";
  const parts = ["【项目规则（优先级高于默认行为）】"];
  for (const rule of rules) {
    const content = truncate(String(rule.content || "").trim(), RULES_BUDGET, rule.name);
    if (!content) continue;
    parts.push(`## ${rule.name} (${rule.path})`, content);
  }
  return parts.length > 1 ? parts.join("\n\n") : "";
}

function buildSkillsSection(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return "";

  const header = [
    "【可用技能】",
    "以下技能是预置的专业工作流。任务匹配描述时，先使用 read_file 读取对应文件获取完整指令，再执行：",
  ].join("\n");

  const entries = [];
  let total = header.length;

  for (const skill of skills) {
    const description = String(skill.description || "").trim();
    const shortDesc = description.length > SKILL_DESC_MAX
      ? `${description.slice(0, SKILL_DESC_MAX)}…`
      : description;
    const full = `- ${skill.name} (${skill.scope || "global"})${shortDesc ? `: ${shortDesc}` : ""}\n  文件: ${skill.filePath || ""}`;
    const degraded = `- ${skill.name} (${skill.scope || "global"})\n  文件: ${skill.filePath || ""}`;

    if (total + full.length <= SKILLS_BUDGET) {
      entries.push(full);
      total += full.length;
    } else if (total + degraded.length <= SKILLS_BUDGET) {
      entries.push(degraded);
      total += degraded.length;
    } else {
      entries.push("…(技能列表已截断)");
      break;
    }
  }

  return `${header}\n${entries.join("\n")}`;
}

function buildMemorySection(memories, memoryIndex) {
  const parts = [];
  let total = 0;

  const indexItems = Array.isArray(memoryIndex) ? memoryIndex : [];
  for (const item of indexItems) {
    const content = String(item.content || "").trim();
    if (!content) continue;
    const block = `## 记忆索引 (${item.scope})\n${content}`;
    if (total + block.length > MEMORY_BUDGET) break;
    parts.push(block);
    total += block.length;
  }

  const memoryItems = Array.isArray(memories) ? memories : [];
  for (const memory of memoryItems) {
    const content = String(memory.content || "").trim();
    if (!content) continue;
    const block = `## 记忆: ${memory.name} (${memory.scope || "global"})\n${content}`;
    if (total + block.length > MEMORY_BUDGET) {
      parts.push("…(记忆内容已截断)");
      break;
    }
    parts.push(block);
    total += block.length;
  }

  if (parts.length === 0) return "";
  return ["【长期记忆】", ...parts].join("\n\n");
}

function buildTodoSection(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return "";
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.id} ${todo.text}`);
  return [
    "【当前工单 (Todo List)】",
    ...lines,
    "使用 todo_write 工具更新工单；每完成一步立即更新。",
  ].join("\n");
}

function buildToolSection(toolDocs) {
  if (!Array.isArray(toolDocs) || toolDocs.length === 0) return "";
  const body = truncate(toolDocs.join("\n"), TOOL_BUDGET, "tools");
  return `【工具手册】\n${body}`;
}

function buildWorkspaceSection(matchedWorkspace, workDir) {
  if (matchedWorkspace && Array.isArray(matchedWorkspace.folders) && matchedWorkspace.folders.length > 0) {
    const folderLines = matchedWorkspace.folders
      .map((folder) => `- ${folder.isPrimary ? "[主要] " : ""}${folder.name} (${folder.path})`)
      .join("\n");
    return `【用户选定的目标工作空间: ${matchedWorkspace.name}】
挂载源文件夹列表:
${folderLines}
重要约束：用户当前询问、分析和修改的代码目标正是上述文件夹！所有工具调用 (list_directory, search_code, read_file, edit_file) 必须严格限定在上述目录内！严禁分析客户端软件自身的源码目录！`;
  }

  if (workDir) {
    return `【用户选定的目标工程根目录】: ${workDir}
重要约束：用户当前要求分析和修改的项目正是此目录！所有代码检索与文件操作必须严格以该目录为根目录进行！严禁分析客户端自身代码！`;
  }

  return "";
}

function buildEnvironmentSection({ workDir, matchedWorkspace, gitInfo, model }) {
  const lines = ["【环境信息】"];
  lines.push(`- 主工作目录: ${workDir || "未指定"}`);

  const extraFolders = matchedWorkspace?.folders
    ? matchedWorkspace.folders
        .filter((folder) => folder.path !== workDir)
        .map((folder) => folder.path)
    : [];
  if (extraFolders.length > 0) {
    lines.push(`- 附加工作目录: ${extraFolders.join(", ")}`);
  }

  lines.push(`- 是否 Git 仓库: ${gitInfo ? "true" : "false"}`);
  lines.push(`- 平台: ${process.platform} / Shell: ${process.env.SHELL || "unknown"} / 系统: ${process.platform} ${os.release()} ${os.arch()}`);
  lines.push(`- 当前日期: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- 当前模型: ${model || "unknown"}`);
  return lines.join("\n");
}

function buildGitSection(gitInfo) {
  if (!gitInfo) return "";

  const statusLines = gitInfo.statusLines.slice(0, GIT_STATUS_LINES);
  const commits = gitInfo.commits.slice(0, RECENT_COMMITS);

  const parts = [
    "【Git 快照】",
    `- 当前分支: ${gitInfo.branch}`,
    `- 主分支: ${gitInfo.mainBranch}`,
    `- Git 用户: ${gitInfo.user}`,
  ];

  if (statusLines.length > 0) {
    parts.push("- 状态:", ...statusLines.map((line) => `  ${line}`));
    if (gitInfo.statusLines.length > GIT_STATUS_LINES) {
      parts.push(`  …(还有 ${gitInfo.statusLines.length - GIT_STATUS_LINES} 个改动未展示)`);
    }
  } else {
    parts.push("- 状态: 工作区干净");
  }

  if (commits.length > 0) {
    parts.push("- 最近提交:", ...commits.map((line) => `  ${line}`));
  }

  return parts.join("\n");
}

function buildSystemContext({
  workDir = null,
  matchedWorkspace = null,
  skills = [],
  memories = [],
  memoryIndex = [],
  projectRules = [],
  todos = [],
  toolDocs = [],
  model = "",
  enableTools = true,
} = {}) {
  const gitInfo = getGitSnapshot(workDir);
  const sections = [];

  const push = (name, content) => {
    if (!content || !String(content).trim()) return;
    const text = String(content);
    sections.push({ name, content: text, chars: text.length, tokens: estimateTokens(text) });
  };

  push("behavior", buildBehaviorSection());
  push("rules", buildRulesSection(projectRules));
  push("skills", buildSkillsSection(skills));
  push("memory", buildMemorySection(memories, memoryIndex));
  push("todos", buildTodoSection(todos));
  if (enableTools) push("tools", buildToolSection(toolDocs));
  push("workspace", buildWorkspaceSection(matchedWorkspace, workDir));
  push("environment", buildEnvironmentSection({ workDir, matchedWorkspace, gitInfo, model }));
  push("git", buildGitSection(gitInfo));

  return {
    text: sections.map((section) => section.content).join("\n\n"),
    sections: sections.map(({ name, chars, tokens }) => ({ name, chars, tokens })),
  };
}

module.exports = {
  buildSystemContext,
  getGitSnapshot,
  truncate,
};
