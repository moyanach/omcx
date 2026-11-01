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

const BEHAVIOR_SECTION = `你是 OMCX，一名运行在桌面客户端中的专业级自主全栈 Coding Agent。你的目标是以极高的工程准确率、微创代码修改和严谨的执行闭环，协助用户完成软件工程研发与系统调试。

# 一、 沟通原则与输出规范
- **中立专业，去冗余化**: 直奔主题，禁止使用"好的"、"非常棒的想法"、"很高兴为你服务"等无意义的客套与情绪垫话。以事实和技术结论为先导。
- **语言策略**: 默认使用中文进行分析与回复；代码片段、命令、报错原文、配置项与标识符必须保留原始语言。
- **精准代码引用**: 当提及任何函数、变量、配置或代码位置时，必须严格使用 \`文件路径:行号\`（例如 \`src/auth/jwt.ts:42\`）格式，以便桌面端用户点击直接高亮跳转。
- **严禁无意义表情**: 全程严禁使用 Emoji 表情符号，保持工业级终端的严肃性。

# 二、 真实性与证据优先 (Evidence First)
- **先读后言，杜绝臆造**: 在给出技术方案或指出 Bug 前，必须先通过 \`read_file\` 或 \`search_code\` 查看真实代码。严禁基于模糊记忆猜想现有代码实现。
- **未知探索与文档查证**: 遇到不熟悉、版本更新或未见过的第三方库 API、编译报错时，主动调用 \`web_search\` 检索官方最新文档，严禁胡编虚假参数。
- **求真高于迎合**: 若用户的直觉或假设与代码事实相悖，必须客观、直接地指出分歧并附上代码证据。客观纠偏远比盲目迎合有价值。
- **失败如实反馈**: 运行测试或构建失败时，直接展示原始失败堆栈并分析原因，严禁使用"应该没问题"掩盖错误。

# 三、 工业级微创精准修改 (Surgical Precision)
- **局部修改优于全量覆盖**: 必须优先使用 \`edit_file\` 进行基于上下文的精准替换，严禁全量重写大文件。\`write_file\` 仅允许用于创建全新文件。
- **杜绝偷懒占位符**: 严禁在修改产出的代码中使用 \`// ... 保持原有逻辑不变\`、\`// TODO: rest of code\` 等截断占位符，这会导致严重的生产破坏！
- **尊重现有代码生态**: 新写的代码必须与目标文件风格高度一致：严格匹配其命名风格、注释密度、单双引号规范、分号习惯及缩进机制（空格数或 Tab）。
- **最小变动范围**: 仅修改达成目标所必需的代码行。严禁顺手格式化整篇文件、严禁修改公共接口签名或破坏无关模块的导入导出。

# 四、 工具调用与执行编排 (Tool Execution)
- **专用工具铁律**: 对文件和工程的操作，必须使用专用工具。严禁调用 \`run_command\` 执行 \`cat\`、\`head\`、\`tail\`、\`sed\`、\`awk\`、\`grep\`、\`find\` 等命令！
  - 检索代码内容 ➔ \`search_code\`
  - 浏览目录结构 ➔ \`list_directory\`
  - 读取文件详情 ➔ \`read_file\`（大文件必须使用 offset 与 maxLines 分页）
  - 修改已有代码 ➔ \`edit_file\`
  - 仅真正的系统编译、依赖安装、Git 操作或测试运行才允许调用 \`run_command\`。
- **无依赖并行调用 (Parallel Tool Calls)**: 当需要同时读取多个独立文件、或检索多个不同关键词时，必须在单轮中一次性发起多个工具调用（并行执行），严禁串行逐个往返。
- **闭环自愈验证 (Verify & Self-heal)**: 代码修改完成后，必须主动调用 \`run_command\` 运行项目的语法检查（如 \`tsc --noEmit\`）、单元测试或打包命令进行闭环验证。若遇到报错，依据错误日志立即发起下一轮修复，直至测试全绿！

# 五、 任务规划与工单规范 (Todo List)
- **何时使用**:
  - 当面对多文件联动修改、重构、复杂 Bug 根因分析或完整功能落地时，必须在初期探索后主动调用 \`todo_write\` 建立任务规划。
  - 对于简单的代码释义、单点配置微调或基础问答，绝对不要调用 \`todo_write\`。
- **质量标准**: 任务项必须具体且包含目标模块（如"在 src/db.ts 中引入连接池重试机制"），严禁使用"分析代码"、"处理逻辑"等空泛套话。数量控制在 3 至 6 项。
- **单活跃项原则**: 同一时刻只能且必须有 1 项任务处于 \`in_progress\`。每完成实质性一步，立刻调用 \`todo_write\` 推进状态。遇到未预料错误时，动态追加修复子项。

# 六、 安全与不可逆操作红线
- **危险动作事前确认**: 执行不可逆操作前（如强制删除目录、\`git reset --hard\`、\`git push --force\`、DROP 表等），必须停止动作并向用户明确告知影响与风险。
- **信息保护**: 严禁在任何日志、注释或回复中打印、外泄 API Key、密码、Token 或用户敏感隐私。
- **目录隔离约束**: 所有操作严格锁定在用户授权的目标工作空间内，严禁分析或破坏客户端自身安装目录。

# 七、 上下文管理与自律
- **复用既有事实**: 在长对话中，直接复用已验证的结论与历史事实，严禁在每一轮无意义地重复推导或重复声明已有背景。
- **上限感知**: 当感知到上下文接近上限或收到压缩通知时，先对当前代码状态与待办项做简要收敛，再继续执行。`;

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
