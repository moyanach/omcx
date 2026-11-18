/**
 * 斜杠命令服务
 *
 * 1. 内置工程工作流：/review、/test、/fix、/explain、/commit、/pr
 * 2. 自定义命令：~/.omcx/commands/*.md 与 <workDir>/.omcx/commands/*.md
 *    Frontmatter: name / description / argument-hint / allowed-tools
 *    正文支持 $ARGUMENTS、{{args}}、${ARGUMENTS} 占位符
 * 3. /review 会在客户端先读取 git 变更并内联，支持四种作用域：
 *    - 默认：未提交变更（工作区 + 暂存区）
 *    - --base <branch>：对比基线分支（merge-base 三点 diff + 提交清单）
 *    - --commit <sha>：审查指定提交
 *    - --pr <number>：审查 GitHub PR（gh pr diff）
 *    均可追加 `-- <路径...>` 限定范围，其余文本作为审查重点。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MAX_DIFF_CHARS = 120000;

const BUILTIN_COMMANDS = [
  {
    name: "btw",
    description:
      "旁路提问：不打断主线任务，也不写入会话历史；选中主会话文本后右键亦可发起（只读工具，最多 20 轮）",
    argumentHint: "<问题>",
    builtin: true,
  },
  {
    name: "review",
    description:
      "代码审查：默认审查未提交变更，也支持 --base <分支> / --commit <sha> / --pr <编号> 作用域",
    argumentHint: "[--base <branch> | --commit <sha> | --pr <number> | --staged] [-- <路径...>] [审查重点]",
    builtin: true,
  },
  {
    name: "test",
    description: "运行项目测试并根据失败输出定位修复",
    argumentHint: "[测试命令或用例名]",
    builtin: true,
  },
  {
    name: "fix",
    description: "定位并修复指定问题，补充必要的回归验证",
    argumentHint: "<问题描述或报错信息>",
    builtin: true,
  },
  {
    name: "explain",
    description: "解释指定文件、模块或调用链的实现与设计",
    argumentHint: "<文件路径 / 模块 / 问题>",
    builtin: true,
  },
  {
    name: "commit",
    description: "检查变更并生成规范的 Conventional Commits 提交",
    argumentHint: "[提交说明]",
    builtin: true,
  },
  {
    name: "pr",
    description: "整理当前分支变更并创建 Pull Request",
    argumentHint: "[PR 标题]",
    builtin: true,
  },
  {
    name: "spec",
    description:
      "Quest/规格模式：只读分析后生成结构化规格文档（需求/方案/验收/实施步骤），等待确认后执行",
    argumentHint: "<需求描述>",
    builtin: true,
  },
  {
    name: "execute-spec",
    description: "读取已确认的规格文档并自主实施，按验收标准逐项验证",
    argumentHint: "[规格文件名，省略时使用最新一份]",
    builtin: true,
  },
];

function commandDirs(workDir) {
  // OMCX_HOME 可覆盖全局数据目录（与 storageService 保持一致）
  const omcxHome = process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
  const dirs = [
    { dir: path.join(omcxHome, "commands"), scope: "global" },
    { dir: path.join(os.homedir(), ".agents", "commands"), scope: "global" },
  ];
  if (workDir) {
    dirs.push({ dir: path.join(workDir, ".omcx", "commands"), scope: "project" });
    dirs.push({ dir: path.join(workDir, ".agents", "commands"), scope: "project" });
  }
  return dirs;
}

function parseCommandMarkdown(filePath, scope = "global") {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const baseName = path.basename(filePath).replace(/\.md$/i, "");
    let name = baseName;
    let description = "";
    let argumentHint = "";
    let allowedTools = [];
    let body = content;

    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (fm) {
      const yaml = fm[1];
      body = fm[2].trim();
      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
      const descMatch = yaml.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, "");
      const hintMatch = yaml.match(/^argument-hint:\s*(.+)$/m);
      if (hintMatch) argumentHint = hintMatch[1].trim().replace(/^['"]|['"]$/g, "");
      const toolsMatch = yaml.match(/^allowed-tools:\s*(?:\[(.*?)\]|(.+))$/m);
      if (toolsMatch) {
        const raw = toolsMatch[1] !== undefined ? toolsMatch[1] : toolsMatch[2];
        allowedTools = (raw || "")
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
    }

    return {
      name: name.toLowerCase(),
      description,
      argumentHint,
      allowedTools,
      body,
      scope,
      builtin: false,
      filePath,
    };
  } catch (err) {
    console.error(`[commandService] 解析命令失败 (${filePath}):`, err.message);
    return null;
  }
}

function listCommands(workDir = null) {
  const map = new Map();
  for (const cmd of BUILTIN_COMMANDS) {
    map.set(cmd.name, { ...cmd, scope: "builtin" });
  }

  for (const { dir, scope } of commandDirs(workDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      if (entry.name.startsWith(".")) continue;
      const item = parseCommandMarkdown(path.join(dir, entry.name), scope);
      if (!item || !item.name) continue;
      map.set(item.name, item);
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function execCommand(file, args, cwd, { timeout = 20000, maxChars = MAX_DIFF_CHARS * 2 } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout, maxBuffer: maxChars, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || "",
          stderr: stderr || (err ? err.message : ""),
        });
      }
    );
  });
}

function execGit(args, cwd) {
  return execCommand("git", args, cwd).then((res) => (res.ok ? res.stdout : ""));
}

function safeGitRef(value) {
  const ref = String(value || "").trim();
  if (!ref) return "";
  // 仅允许常见 ref / SHA / 相对引用字符，杜绝把奇怪参数交给 git
  if (!/^[A-Za-z0-9._/~^@{}-]+$/.test(ref)) return "";
  if (ref.startsWith("-")) return "";
  return ref;
}

function isGitRepo(workDir) {
  return Boolean(workDir && fs.existsSync(path.join(workDir, ".git")));
}

/**
 * 解析 /review 参数
 * @returns {{scope:string, base:string, commit:string, pr:string, paths:string[], focus:string}}
 */
function parseReviewArgs(rawArgs) {
  const out = {
    scope: "worktree",
    base: "",
    commit: "",
    pr: "",
    paths: [],
    focus: "",
  };
  const tokens = String(rawArgs || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const focusParts = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      out.paths = tokens.slice(i + 1);
      break;
    }
    if (token === "--staged") {
      out.scope = "staged";
      continue;
    }
    const inline = token.match(/^--(base|commit|pr)=(.*)$/);
    if (inline) {
      out[inline[1]] = inline[2].trim();
      out.scope = inline[1];
      continue;
    }
    const spaced = token.match(/^--(base|commit|pr)$/);
    if (spaced) {
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        out[spaced[1]] = next.trim();
        out.scope = spaced[1];
        i += 1;
      }
      continue;
    }
    focusParts.push(token);
  }

  out.focus = focusParts.join(" ").trim();
  return out;
}

function truncateDiff(text, label) {
  if (!text) return "";
  if (text.length <= MAX_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_DIFF_CHARS)}\n\n…[${label} 过大，已截断，剩余变更请自行运行 git 查看]`;
}

async function collectGitDiff(workDir) {
  if (!isGitRepo(workDir)) return "";
  const [unstaged, staged, stat] = await Promise.all([
    execGit(["diff", "--no-color", "--no-ext-diff", "-U3"], workDir),
    execGit(["diff", "--cached", "--no-color", "--no-ext-diff", "-U3"], workDir),
    execGit(["diff", "HEAD", "--stat", "--no-color"], workDir),
  ]);
  const parts = [];
  if (stat.trim()) parts.push(`### git diff HEAD --stat\n${stat.trim()}`);
  if (staged.trim()) parts.push(`### 已暂存变更 (git diff --cached)\n${staged.trim()}`);
  if (unstaged.trim()) parts.push(`### 未暂存变更 (git diff)\n${unstaged.trim()}`);
  return truncateDiff(parts.join("\n\n"), "工作区 diff");
}

/**
 * 按作用域收集 /review 所需的 git 上下文
 * @param {string} workDir
 * @param {string} rawArgs
 * @returns {Promise<{scope:string,label:string,diff:string,meta:string,error?:string,paths:string[],focus:string}>}
 */
async function collectReviewContext(workDir, rawArgs = "") {
  const opts = parseReviewArgs(rawArgs);
  const baseResult = {
    ...opts,
    label: "",
    diff: "",
    meta: "",
  };

  if (!isGitRepo(workDir)) {
    return {
      ...baseResult,
      label: "未绑定 Git 仓库",
      error: "当前会话未绑定有效的 Git 工作目录，无法读取变更。",
    };
  }

  const pathArgs = opts.paths.length
    ? ["--", ...opts.paths.map((p) => String(p).trim()).filter(Boolean)]
    : [];

  if (opts.scope === "staged") {
    const [diff, stat] = await Promise.all([
      execGit(["diff", "--cached", "--no-color", "--no-ext-diff", "-U3", ...pathArgs], workDir),
      execGit(["diff", "--cached", "--stat", "--no-color", ...pathArgs], workDir),
    ]);
    return {
      ...baseResult,
      label: "已暂存变更 (git diff --cached)",
      diff: truncateDiff([stat.trim(), diff.trim()].filter(Boolean).join("\n\n"), "暂存区 diff"),
    };
  }

  if (opts.scope === "base") {
    const base = safeGitRef(opts.base);
    if (!base) {
      return { ...baseResult, error: `无效的基线分支名：${opts.base || "(空)"}` };
    }
    const verify = await execCommand("git", ["rev-parse", "--verify", `${base}^{commit}`], workDir);
    if (!verify.ok) {
      return { ...baseResult, error: `基线分支或提交不存在：${base}` };
    }
    const mergeBase = await execCommand("git", ["merge-base", base, "HEAD"], workDir);
    const range = mergeBase.ok && mergeBase.stdout.trim() ? `${base}...HEAD` : `${base}..HEAD`;
    const [diff, stat, log] = await Promise.all([
      execGit(["diff", "--no-color", "--no-ext-diff", "-U3", range, ...pathArgs], workDir),
      execGit(["diff", "--stat", "--no-color", range, ...pathArgs], workDir),
      execGit(["log", "--oneline", "--no-decorate", `${base}..HEAD`], workDir),
    ]);
    const metaParts = [];
    if (stat.trim()) metaParts.push(`### 变更统计\n${stat.trim()}`);
    if (log.trim()) metaParts.push(`### 相对 ${base} 的提交\n${log.trim()}`);
    return {
      ...baseResult,
      label: `对比基线分支 ${base} (${range})`,
      diff: truncateDiff(diff.trim(), `对比 ${base} 的 diff`),
      meta: metaParts.join("\n\n"),
    };
  }

  if (opts.scope === "commit") {
    const commit = safeGitRef(opts.commit);
    if (!commit) {
      return { ...baseResult, error: `无效的提交引用：${opts.commit || "(空)"}` };
    }
    const verify = await execCommand("git", ["rev-parse", "--verify", `${commit}^{commit}`], workDir);
    if (!verify.ok) {
      return { ...baseResult, error: `提交不存在：${commit}` };
    }
    const [show, stat] = await Promise.all([
      execGit(["show", "--no-color", "--no-ext-diff", "--format=fuller", "-U3", commit, ...pathArgs], workDir),
      execGit(["show", "--stat", "--no-color", "--format=", commit, ...pathArgs], workDir),
    ]);
    return {
      ...baseResult,
      label: `提交 ${commit}`,
      diff: truncateDiff(show.trim(), `提交 ${commit} 的 diff`),
      meta: stat.trim() ? `### 变更统计\n${stat.trim()}` : "",
    };
  }

  if (opts.scope === "pr") {
    const pr = String(opts.pr || "").trim();
    if (!/^\d+$/.test(pr)) {
      return { ...baseResult, error: `无效的 PR 编号：${opts.pr || "(空)"}` };
    }
    const [diff, view] = await Promise.all([
      execCommand("gh", ["pr", "diff", pr], workDir, { timeout: 60000 }),
      execCommand(
        "gh",
        ["pr", "view", pr, "--json", "title,body,baseRefName,headRefName,url,state"],
        workDir,
        { timeout: 30000 }
      ),
    ]);
    if (!diff.ok) {
      return {
        ...baseResult,
        error:
          diff.stderr.includes("ENOENT") || /not found|未找到/i.test(diff.stderr)
            ? "未检测到 GitHub CLI (gh)，请先安装并执行 gh auth login。"
            : `读取 PR #${pr} 失败：${diff.stderr.trim() || "未知错误"}`,
      };
    }
    let meta = "";
    if (view.ok) {
      try {
        const info = JSON.parse(view.stdout);
        meta = [
          `### PR #${pr}`,
          `- 标题: ${info.title || ""}`,
          `- 分支: ${info.headRefName || "?"} → ${info.baseRefName || "?"}`,
          `- 状态: ${info.state || "?"}`,
          `- 链接: ${info.url || ""}`,
          info.body ? `\n#### PR 描述\n${String(info.body).slice(0, 4000)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      } catch {
        meta = "";
      }
    }
    return {
      ...baseResult,
      label: `Pull Request #${pr}`,
      diff: truncateDiff(diff.stdout.trim(), `PR #${pr} 的 diff`),
      meta,
    };
  }

  return {
    ...baseResult,
    label: "未提交变更（工作区 + 暂存区）",
    diff: await collectGitDiff(workDir),
  };
}

function builtinPrompt(name, args, context) {
  const focus = args ? `\n\n【用户指定的审查重点 / 参数】\n${args}` : "";
  switch (name) {
    case "review": {
      const review = context.review || {};
      if (review.error) {
        return `无法执行代码审查：${review.error}`;
      }
      const scopeLabel = review.label || "未提交变更";
      return [
        `请对以下作用域执行一次严格的工程化代码审查：${scopeLabel}。`,
        "要求：",
        "1. 先阅读下面的 git 变更；必要时读取相关完整文件与调用链。",
        "2. 只报告真实存在、可复现的问题，按 P0（致命/安全/数据丢失）、P1（高：功能错误/卡死/越权）、P2（中：性能/健壮性）分级。",
        "3. 每条给出 `文件:行号`、问题机制、触发条件、实际影响与最小修复建议。",
        "4. 不要报告纯风格问题；不要臆测未读到的代码。",
        "5. 最后给出简短的合并结论（可合并 / 修复后合并 / 阻断）。",
        "6. 需要独立深度审查时，优先调用 `dispatch_subagent`（agent=\"reviewer\"）委派审查子代理；子代理不可用时再自行完成。",
        focus,
        review.meta ? `\n\n${review.meta}` : "",
        review.diff
          ? `\n\n【审查范围：${scopeLabel}】\n${review.diff}`
          : `\n\n【审查范围：${scopeLabel}】没有检测到可审查的文本变更。请如实说明该作用域为空，不要臆造问题；如需审查历史提交可使用 \`/review --commit HEAD\`，对比分支可使用 \`/review --base main\`。`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "test":
      return [
        "请执行项目测试并定位失败原因。",
        args ? `指定测试范围/命令：${args}` : "请先识别项目的测试框架与可用脚本，再运行完整测试。",
        "要求：运行测试、汇总通过/失败数量、对失败用例读取相关源码给出根因与最小修复方案；未经我确认不要大规模改写业务逻辑。",
      ].join("\n");
    case "fix":
      return [
        "请定位并修复以下问题，完成后运行相关测试或最小复现验证：",
        args || "（请在后续消息中补充问题描述）",
        "约束：保持改动最小，不引入无关重构；如涉及接口变更需说明影响面。",
      ].join("\n");
    case "explain":
      return [
        "请解释以下目标的实现与设计，包括入口、关键数据流、依赖关系与潜在风险：",
        args || "（请在后续消息中补充文件、模块或问题）",
        "优先基于代码事实，给出 `文件:行号` 引用。",
      ].join("\n");
    case "commit":
      return [
        "请检查当前 git 变更并创建一次规范提交。",
        "步骤：1) 查看 git status 与 diff；2) 排除敏感文件与构建产物；3) 生成符合 Conventional Commits 的中文/英文提交信息；4) 执行 git add 与 git commit。",
        args ? `用户指定的提交说明：${args}` : "提交说明需准确概括本次变更。",
        "不要推送远端。",
      ].join("\n");
    case "pr":
      return [
        "请为当前分支整理并创建 Pull Request。",
        args ? `PR 标题：${args}` : "请根据分支变更生成简洁准确的 PR 标题。",
        "步骤：1) 对比目标分支（默认 main）汇总变更；2) 生成包含背景、改动点、验证方式、风险的 PR 描述；3) 使用 gh pr create 创建 PR（如 gh 未登录则输出需要用户执行的命令）。",
        "不要自动合并 PR。",
      ].join("\n");
    case "spec":
      return [
        "你正在执行「Quest / 规格模式」。请先用只读工具（repo_map / search_symbols / find_references / read_file）理解代码库现状与约束，然后产出一份可直接执行的结构化规格文档，并调用 `spec_write` 工具保存。",
        "文档必须包含以下 5 个章节：",
        "1. `## 目标与范围`：明确要达成的结果，以及明确不做什么。",
        "2. `## 需求与约束`：用户可见行为、兼容性要求、安全与权限边界、性能约束。",
        "3. `## 技术方案`：涉及的具体文件与函数、数据结构、接口变化、关键流程；引用 `文件:行号`。",
        "4. `## 验收标准`：可执行的验证步骤与预期结果。",
        "5. `## 实施步骤`：拆解为 3-8 个可独立验证的步骤，并同步调用 `todo_write`。",
        "约束：本阶段不得修改任何源码或配置；若存在会改变方案的关键歧义，请在文档末尾列出「待确认问题」，先向用户提问。",
        "保存完成后停止执行，并提示用户：确认后发送 `/execute-spec <文件名>`，或切换到「工作区沙箱」权限模式继续。",
        args ? `\n\n【需求描述】\n${args}` : "\n\n【需求描述】用户尚未提供，请先询问要解决的核心问题。",
      ].join("\n");
    case "execute-spec": {
      const specDir = context.workDir
        ? `${String(context.workDir).replace(/\/+$/, "")}/.omcx/specs/`
        : ".omcx/specs/";
      return [
        "请执行已确认的规格文档。",
        `1. 规格目录：${specDir}。${
          args
            ? `目标文件：${args}（不存在时先在目录中按标题/关键词匹配）。`
            : "目标文件：选择最近更新的一份规格文档（可调用 list_directory 查看）。"
        }`,
        "2. 使用 read_file 读取完整规格，复述目标、约束与验收标准，并用 todo_write 建立执行计划。",
        "2.1 开始实施前，将规格文档 frontmatter 中的 `status` 更新为 `in-progress`；全部完成并验证后更新为 `done`（使用 edit_file；只读规划模式下不要执行此步）。",
        "3. 严格按「实施步骤」逐步实施；每完成一步运行相关测试/类型检查或最小复现验证。",
        "4. 遇到规格未覆盖且会改变方案的重大决策时暂停并询问用户，不要自行扩大范围。",
        "5. 全部完成后对照「验收标准」逐项验证，汇报改动文件、验证结果与剩余风险。",
        "若当前仍处于「只读规划模式 (plan)」，禁止修改文件；请提示用户将权限模式切换为「工作区沙箱」或「完全访问」后再执行。",
      ].join("\n");
    }
    default:
      return args;
  }
}

/**
 * 将用户输入的 /command 展开为实际提示词。
 * @returns {Promise<null | {command: string, prompt: string, scope: string, builtin: boolean}>}
 */
async function expandCommand(text, workDir = null) {
  if (typeof text !== "string") return null;
  const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = (match[2] || "").trim();
  const command = listCommands(workDir).find((c) => c.name === name);
  if (!command) return null;

  if (command.builtin) {
    let review = null;
    if (name === "review") {
      review = await collectReviewContext(workDir, args);
      if (review.error) {
        // 参数/仓库错误直接回传明确提示，避免把错误当成普通审查请求发给模型
        return {
          command: name,
          prompt: `无法执行代码审查：${review.error}`,
          scope: "builtin",
          builtin: true,
          error: review.error,
        };
      }
    }
    return {
      command: name,
      prompt: builtinPrompt(name, review ? review.focus : args, { review, workDir }),
      scope: "builtin",
      builtin: true,
    };
  }

  const hasPlaceholder = /\$ARGUMENTS|\{\{args\}\}|\$\{ARGUMENTS\}|\$1/.test(command.body);
  let prompt = command.body
    .replace(/\$ARGUMENTS|\{\{args\}\}|\$\{ARGUMENTS\}/g, args)
    .replace(/\$([1-9])/g, (_m, idx) => {
      const parts = args.split(/\s+/).filter(Boolean);
      return parts[Number(idx) - 1] || "";
    });
  if (!hasPlaceholder && args) {
    prompt += `\n\n补充参数：${args}`;
  }
  return {
    command: name,
    prompt,
    scope: command.scope,
    builtin: false,
    allowedTools: command.allowedTools || [],
  };
}

module.exports = {
  BUILTIN_COMMANDS,
  listCommands,
  expandCommand,
  collectGitDiff,
  collectReviewContext,
  parseReviewArgs,
};
