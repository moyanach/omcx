/**
 * projectArtifactService — 项目产物目录解析（项目内 .omcx 优先）
 *
 * 设计目标：
 * 1. index / wiki / checkpoints / browser-shots 四类产物均由「当前项目」派生，
 *    默认落盘到 <workDir>/.omcx/<kind>/，跟随项目一起归档、跨机器可复用；
 * 2. 通过 artifact_scope_* 配置可逐类回退到全局 <OMCX_HOME>/<kind>/；
 * 3. 读取路径保留全局旧目录兜底，升级后历史产物不会凭空消失；
 * 4. 首次写入项目内目录时幂等追加 .gitignore 的 .omcx/ 规则，避免污染 git status。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SCOPE_PROJECT = "project";
const SCOPE_GLOBAL = "global";

const KIND = {
  INDEX: "index",
  WIKI: "wiki",
  CHECKPOINTS: "checkpoints",
  BROWSER_SHOTS: "browser-shots",
};

const CONFIG_BY_KIND = {
  [KIND.INDEX]: "artifact_scope_index",
  [KIND.WIKI]: "artifact_scope_wiki",
  [KIND.CHECKPOINTS]: "artifact_scope_checkpoints",
  [KIND.BROWSER_SHOTS]: "artifact_scope_browser_shots",
};

const PROJECT_DIR_NAME = ".omcx";
const GITIGNORE_CONFIG_KEY = "artifact_auto_gitignore";
const GITIGNORE_MAX_DEPTH = 8;

// 已处理过的 workDir，避免每次落盘都重复读取 .gitignore
const gitignoreSettled = new Set();

function omcxHome() {
  return process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
}

function normalizeWorkDir(workDir) {
  if (!workDir || typeof workDir !== "string") return null;
  const trimmed = workDir.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function hashWorkDir(resolvedWorkDir) {
  return crypto
    .createHash("sha1")
    .update(String(resolvedWorkDir))
    .digest("hex")
    .slice(0, 20);
}

// 延迟 require：storageService 依赖面较大，且避免模块加载期形成依赖环
function storage() {
  return require("./storageService");
}

function readConfig(key) {
  try {
    return storage().getConfig(key);
  } catch {
    return null;
  }
}

function resolveScope(kind) {
  const key = CONFIG_BY_KIND[kind];
  if (!key) return SCOPE_PROJECT;
  const raw = readConfig(key);
  return String(raw || "").trim().toLowerCase() === SCOPE_GLOBAL ? SCOPE_GLOBAL : SCOPE_PROJECT;
}

/**
 * 全局目录（也是升级前的历史目录），用于不走项目内时的落盘与读取兜底。
 * wiki 保持 <hash> 子目录结构，避免不同仓库互相覆盖。
 */
function globalDir(kind, workDir) {
  const home = omcxHome();
  if (kind === KIND.WIKI) {
    const resolved = normalizeWorkDir(workDir);
    return path.join(home, KIND.WIKI, resolved ? hashWorkDir(resolved) : "_unbound");
  }
  return path.join(home, kind);
}

function projectDir(kind, workDir) {
  const resolved = normalizeWorkDir(workDir);
  if (!resolved) return null;
  return path.join(resolved, PROJECT_DIR_NAME, kind);
}

/**
 * 解析落盘目录。
 * @returns {{dir:string|null, scope:string, kind:string, workDir:string|null, isProject:boolean}}
 */
function resolveDir(kind, workDir) {
  const resolved = normalizeWorkDir(workDir);
  const scope = resolveScope(kind);
  if (scope === SCOPE_PROJECT && resolved) {
    return {
      dir: path.join(resolved, PROJECT_DIR_NAME, kind),
      scope: SCOPE_PROJECT,
      kind,
      workDir: resolved,
      isProject: true,
    };
  }
  return {
    dir: globalDir(kind, resolved),
    scope: SCOPE_GLOBAL,
    kind,
    workDir: resolved,
    isProject: false,
  };
}

/**
 * 读取候选目录序列：项目内优先，全局旧目录兜底。去重后返回。
 */
function readCandidates(kind, workDir) {
  const resolved = normalizeWorkDir(workDir);
  const dirs = [];
  const project = projectDir(kind, resolved);
  const legacy = globalDir(kind, resolved);
  if (project) dirs.push(project);
  if (!dirs.includes(legacy)) dirs.push(legacy);
  return dirs;
}

function findGitRoot(workDir) {
  let current = path.resolve(workDir);
  for (let depth = 0; depth < GITIGNORE_MAX_DEPTH; depth += 1) {
    try {
      if (fs.existsSync(path.join(current, ".git"))) return current;
    } catch {
      // 权限异常时继续向上探测
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 幂等向项目 .gitignore 追加 .omcx/。
 * 仅在 Git 仓库内、且配置未关闭时生效；任何写失败都静默忽略，不阻断产物落盘。
 */
function ensureGitignore(workDir) {
  const resolved = normalizeWorkDir(workDir);
  if (!resolved) return false;
  if (gitignoreSettled.has(resolved)) return true;

  const configured = readConfig(GITIGNORE_CONFIG_KEY);
  if (configured !== null && configured !== undefined && !configured) {
    gitignoreSettled.add(resolved);
    return false;
  }

  const gitRoot = findGitRoot(resolved);
  if (!gitRoot) {
    gitignoreSettled.add(resolved);
    return false;
  }

  const target = path.join(gitRoot, ".gitignore");
  try {
    let content = "";
    try {
      content = fs.readFileSync(target, "utf-8");
    } catch {
      content = "";
    }
    if (/(^|\r?\n)[ \t]*\/?\.omcx\/?[ \t]*(\r?\n|$)/.test(content)) {
      gitignoreSettled.add(resolved);
      return true;
    }
    const leading = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    fs.appendFileSync(
      target,
      `${leading}# OMCX 本地产物目录（由 OMCX Desktop 自动维护）\n.omcx/\n`,
      "utf-8"
    );
    gitignoreSettled.add(resolved);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保目录存在（并在项目内场景补齐 .gitignore），返回解析结果。
 */
function prepareDir(kind, workDir) {
  const target = resolveDir(kind, workDir);
  if (!target.dir) return target;
  try {
    fs.mkdirSync(target.dir, { recursive: true });
  } catch {
    // 创建失败交给调用方在写盘时暴露更具体的错误
  }
  if (target.isProject) ensureGitignore(target.workDir);
  return target;
}

/**
 * 判断某个绝对路径是否位于某工作目录的 .omcx 之下（供需要区分来源的调用方使用）。
 */
function isProjectArtifact(workDir, absPath) {
  const resolved = normalizeWorkDir(workDir);
  if (!resolved || !absPath) return false;
  const base = path.join(resolved, PROJECT_DIR_NAME);
  const rel = path.relative(base, path.resolve(absPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

module.exports = {
  KIND,
  SCOPE_PROJECT,
  SCOPE_GLOBAL,
  CONFIG_BY_KIND,
  PROJECT_DIR_NAME,
  omcxHome,
  normalizeWorkDir,
  hashWorkDir,
  resolveScope,
  resolveDir,
  globalDir,
  projectDir,
  readCandidates,
  ensureGitignore,
  prepareDir,
  isProjectArtifact,
};
