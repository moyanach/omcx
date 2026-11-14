/**
 * sandboxPolicyService — Agent 权限模式与沙箱安全策略核心引擎
 *
 * 对标主流 Agent (Claude Code / Cursor / Codex CLI) 的 4 档权限模式：
 * 1. plan         — 只读规划模式：禁止写文件工具，命令在只读 OS 沙箱中执行
 * 2. auto-sandbox — 工作区沙箱模式（默认推荐）：工作区内自动读写，命令在工作区写沙箱内自动隔离执行
 * 3. ask          — 询问确认模式：每次写文件或执行命令前弹窗确认，命令仍在工作区写沙箱中保护执行
 * 4. full-access  — 完全访问模式：关闭 OS 沙箱限制，仅对高危破坏性命令与外部目录保留确认
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const USER_HOME = os.homedir();
const DEFAULT_OMCX_HOME = process.env.OMCX_HOME || path.join(USER_HOME, ".omcx");
const LOCAL_OMCX_FALLBACK = path.join(process.cwd(), ".omcx_local");

const PERMISSION_MODES = {
  PLAN: "plan",
  AUTO_SANDBOX: "auto-sandbox",
  ASK: "ask",
  FULL_ACCESS: "full-access",
};

const VALID_PERMISSION_MODES = new Set([
  PERMISSION_MODES.PLAN,
  PERMISSION_MODES.AUTO_SANDBOX,
  PERMISSION_MODES.ASK,
  PERMISSION_MODES.FULL_ACCESS,
]);

const DEFAULT_PERMISSION_MODE = PERMISSION_MODES.AUTO_SANDBOX;

const PERMISSION_MODE_META = {
  [PERMISSION_MODES.PLAN]: {
    id: PERMISSION_MODES.PLAN,
    label: "只读规划",
    shortLabel: "只读规划",
    description: "仅允许检索代码与输出规划，禁止修改文件与磁盘写入",
    allowFileWrite: false,
    confirmFileWrite: false,
    confirmCommand: false,
    useOsSandbox: true,
    osSandboxWriteMode: "read-only",
  },
  [PERMISSION_MODES.AUTO_SANDBOX]: {
    id: PERMISSION_MODES.AUTO_SANDBOX,
    label: "工作区沙箱",
    shortLabel: "工作区沙箱",
    description: "工作区内自动读写，命令在 OS 沙箱内安全隔离执行（推荐）",
    allowFileWrite: true,
    confirmFileWrite: false,
    confirmCommand: false,
    useOsSandbox: true,
    osSandboxWriteMode: "workspace-write",
  },
  [PERMISSION_MODES.ASK]: {
    id: PERMISSION_MODES.ASK,
    label: "询问确认",
    shortLabel: "询问确认",
    description: "每次修改文件或执行命令前请求确认，命令受沙箱保护",
    allowFileWrite: true,
    confirmFileWrite: true,
    confirmCommand: true,
    useOsSandbox: true,
    osSandboxWriteMode: "workspace-write",
  },
  [PERMISSION_MODES.FULL_ACCESS]: {
    id: PERMISSION_MODES.FULL_ACCESS,
    label: "完全访问",
    shortLabel: "完全访问",
    description: "关闭 OS 沙箱限制，仅对高危命令与跨工作区写入弹窗确认",
    allowFileWrite: true,
    confirmFileWrite: false,
    confirmCommand: false,
    useOsSandbox: false,
    osSandboxWriteMode: "none",
  },
};

function normalizePermissionMode(mode) {
  const raw = String(mode || "").trim().toLowerCase();
  if (VALID_PERMISSION_MODES.has(raw)) {
    return raw;
  }
  return DEFAULT_PERMISSION_MODE;
}

function getPermissionModePolicy(mode) {
  const normalized = normalizePermissionMode(mode);
  return PERMISSION_MODE_META[normalized] || PERMISSION_MODE_META[DEFAULT_PERMISSION_MODE];
}

/**
 * 解析物理真实路径（兼容尚未创建的文件与多级符号链接，例如 macOS /tmp -> /private/tmp）
 */
function resolveRealPathSafe(targetPath, depth = 0) {
  if (!targetPath || typeof targetPath !== "string") return "";
  const abs = path.resolve(targetPath);
  const realpathFn = fs.realpathSync.native || fs.realpathSync;

  try {
    if (fs.existsSync(abs)) {
      return realpathFn(abs);
    }
    // 悬挂符号链接：existsSync 会因目标不存在而返回 false，但写入仍会跟随链接落到工作区外。
    // 先解析链接目标再做边界判定（限定递归深度，防止符号链接环）。
    if (depth < 16) {
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(abs);
        return resolveRealPathSafe(
          path.resolve(path.dirname(abs), linkTarget),
          depth + 1
        );
      }
    }
  } catch {
    // 忽略权限或瞬态异常，向下走祖先回溯
  }

  const tailSegments = [];
  let current = abs;
  let guard = 0;

  while (current && guard < 64) {
    guard += 1;
    try {
      if (fs.existsSync(current)) {
        const realBase = realpathFn(current);
        return tailSegments.length > 0
          ? path.join(realBase, ...tailSegments.reverse())
          : realBase;
      }
    } catch {
      // 继续向上回溯
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    tailSegments.push(path.basename(current));
    current = parent;
  }

  return abs;
}

/**
 * 校验 targetPath 是否归属于 folderPath（同时比对逻辑路径与 realpath 物理路径）
 */
function isUnderFolderReal(targetPath, folderPath) {
  if (!targetPath || !folderPath) return false;
  const realTarget = resolveRealPathSafe(targetPath);
  const realFolder = resolveRealPathSafe(folderPath);
  if (!realTarget || !realFolder) return false;

  const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const compareTarget = isCaseInsensitive ? realTarget.toLowerCase() : realTarget;
  const compareFolder = isCaseInsensitive ? realFolder.toLowerCase() : realFolder;

  const rel = path.relative(compareFolder, compareTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 系统内置只读信任目录（Skills / Memory / Agents 定义目录，允许读取但严禁 Agent 直接当成工作区静默覆写）
 */
function getBuiltinReadOnlyTrustedDirs(sessionId = null) {
  const dirs = [
    path.join(USER_HOME, ".agents"),
    path.join(USER_HOME, ".omcx", "skills"),
    path.join(USER_HOME, ".omcx", "memory"),
    path.join(USER_HOME, ".omcx", "agents"),
    path.join(DEFAULT_OMCX_HOME, "skills"),
    path.join(DEFAULT_OMCX_HOME, "memory"),
    path.join(DEFAULT_OMCX_HOME, "agents"),
  ];

  // 仅将当前会话的上传附件目录加入只读信任（确保表格/PDF/压缩包解析脚本可读取，同时隔离其他会话记录）
  if (sessionId) {
    dirs.push(path.join(USER_HOME, ".omcx", "sessions", String(sessionId), "attachments"));
    dirs.push(path.join(DEFAULT_OMCX_HOME, "sessions", String(sessionId), "attachments"));
    dirs.push(path.join(LOCAL_OMCX_FALLBACK, "sessions", String(sessionId), "attachments"));
  }

  return Array.from(new Set(dirs.map((d) => resolveRealPathSafe(d)).filter(Boolean)));
}

/**
 * 宿主机高敏凭据与客户端私密配置黑名单（禁止读取与写入）
 */
function getSensitiveBlacklistPaths() {
  const omcxHomes = [path.join(USER_HOME, ".omcx"), DEFAULT_OMCX_HOME, LOCAL_OMCX_FALLBACK];
  const omcxDbFiles = [];
  const omcxConfigFiles = [];
  for (const home of omcxHomes) {
    // SQLite 主库与 WAL/SHM 伴随文件包含全部会话历史、产物索引与明文 API Key
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      omcxDbFiles.push(path.join(home, `omcx.db${suffix}`));
    }
    omcxConfigFiles.push(path.join(home, "config.json"), path.join(home, "mcp.json"));
  }

  return [
    // 客户端 SQLite 核心数据库（含明文 API Key 与全部会话内容）
    ...omcxDbFiles,
    // 客户端自身核心配置（包含明文 API Key 与全局 MCP 配置）
    ...omcxConfigFiles,
    // 注：~/.omcx/sessions 交由下方 checkSensitivePath 第 2 步精细校验，
    // 严格保护会话历史/元数据文件，同时放行 attachments 附件目录预览与只读读取
    // 宿主机 SSH / 云厂商 / GPG / 密钥链凭据
    path.join(USER_HOME, ".ssh"),
    path.join(USER_HOME, ".aws"),
    path.join(USER_HOME, ".gnupg"),
    path.join(USER_HOME, ".kube"),
    path.join(USER_HOME, ".docker", "config.json"),
    path.join(USER_HOME, ".npmrc"),
    path.join(USER_HOME, ".pypirc"),
    path.join(USER_HOME, ".netrc"),
    path.join(USER_HOME, ".git-credentials"),
    path.join(USER_HOME, "Library", "Keychains"),
  ];
}

/**
 * 检查目标路径是否命中高敏隐私黑名单
 */
function checkSensitivePath(targetPath, sessionId = null) {
  if (!targetPath) return { blocked: false };
  const realTarget = resolveRealPathSafe(targetPath);

  // 1. 检查显式黑名单文件与目录
  for (const sensitive of getSensitiveBlacklistPaths()) {
    if (isUnderFolderReal(realTarget, sensitive)) {
      return {
        blocked: true,
        reason: `安全沙箱已拦截访问敏感凭据或客户端核心配置文件: ${targetPath}`,
      };
    }
  }

  // 2. 保护 ~/.omcx/sessions 下除 attachments 之外的会话历史与配置元数据文件
  const sessionRoots = [
    path.join(USER_HOME, ".omcx", "sessions"),
    path.join(DEFAULT_OMCX_HOME, "sessions"),
    path.join(LOCAL_OMCX_FALLBACK, "sessions"),
  ];
  for (const sRoot of sessionRoots) {
    if (isUnderFolderReal(realTarget, sRoot)) {
      // 允许访问会话 attachments 附件静态媒体资源 (图片、文本、文档预览)，兼顾 macOS APFS 大小写不敏感
      const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
      const compareRoot = isCaseInsensitive ? sRoot.toLowerCase() : sRoot;
      const compareTarget = isCaseInsensitive ? realTarget.toLowerCase() : realTarget;
      const relative = path.relative(compareRoot, compareTarget);
      const segments = relative.split(path.sep);
      if (segments.length >= 2 && segments[1] === "attachments") {
        return { blocked: false };
      }
      return {
        blocked: true,
        reason: `安全沙箱已拦截直接访问会话核心数据文件: ${targetPath}`,
      };
    }
  }

  return { blocked: false };
}

/**
 * 检查写入目标是否属于工作区内受保护的控制文件（防 Git Hooks / .omcx 恶意篡改提权）
 */
function checkProtectedWorkspaceWrite(targetPath, writableFolders = []) {
  if (!targetPath) return { protected: false };
  const realTarget = resolveRealPathSafe(targetPath);

  for (const folder of writableFolders) {
    if (!isUnderFolderReal(realTarget, folder)) continue;
    const realFolder = resolveRealPathSafe(folder);
    const rel = path.relative(realFolder, realTarget).replace(/\\/g, "/");

    if (
      rel === ".git/hooks" ||
      rel.startsWith(".git/hooks/") ||
      rel === ".git/config" ||
      rel === ".omcx" ||
      rel.startsWith(".omcx/") ||
      rel === ".vscode/tasks.json"
    ) {
      return {
        protected: true,
        reason: `目标文件属于工作区受保护控制配置 (${rel})，修改可能带来自动执行风险，需要用户确认`,
      };
    }
  }

  return { protected: false };
}

/**
 * 清洗传入沙箱子进程的环境变量，剥离宿主机云密钥与模型 API Key
 */
const SENSITIVE_ENV_PATTERNS = [
  /^(OPENAI|ANTHROPIC|CLAUDE|GEMINI|DEEPSEEK|MOONSHOT|DASHSCOPE|ZHIPU|MINIMAX|SILICONFLOW)_API_KEY$/i,
  /^AWS_(SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN)$/i,
  /^(GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|PYPI_TOKEN|SLACK_TOKEN)$/i,
  /^(PRIVATE_KEY|SECRET_KEY|DATABASE_URL|REDIS_URL)$/i,
];

function buildSanitizedShellEnv(baseEnv = process.env, { stripSecrets = true } = {}) {
  const extraPaths = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const currentPath = baseEnv.PATH || "";
  const mergedPath = Array.from(
    new Set([...extraPaths, ...currentPath.split(path.delimiter).filter(Boolean)])
  ).join(path.delimiter);

  const result = {};
  for (const [key, val] of Object.entries(baseEnv)) {
    if (val === undefined || val === null) continue;
    if (stripSecrets && SENSITIVE_ENV_PATTERNS.some((re) => re.test(key))) {
      continue;
    }
    result[key] = val;
  }

  result.PATH = mergedPath;
  return result;
}

/**
 * 构建会话级沙箱上下文（严格区分可读目录与可写目录）
 */
function createSessionSandboxContext({
  sessionId = null,
  permissionMode = DEFAULT_PERMISSION_MODE,
  workDir = null,
  workspaceFolders = [],
  extraReadableFolders = [],
} = {}) {
  const normalizedMode = normalizePermissionMode(permissionMode);
  const policy = getPermissionModePolicy(normalizedMode);

  const rawWritable = new Set();
  if (workDir && typeof workDir === "string") {
    rawWritable.add(path.resolve(workDir));
    rawWritable.add(resolveRealPathSafe(workDir));
  }
  if (Array.isArray(workspaceFolders)) {
    for (const f of workspaceFolders) {
      if (f && typeof f === "string") {
        rawWritable.add(path.resolve(f));
        rawWritable.add(resolveRealPathSafe(f));
      }
    }
  }

  const writableFolders = Array.from(rawWritable).filter(Boolean);

  const rawReadable = new Set([
    ...writableFolders,
    ...getBuiltinReadOnlyTrustedDirs(sessionId),
  ]);
  if (Array.isArray(extraReadableFolders)) {
    for (const f of extraReadableFolders) {
      if (f && typeof f === "string") {
        rawReadable.add(path.resolve(f));
        rawReadable.add(resolveRealPathSafe(f));
      }
    }
  }

  const readableFolders = Array.from(rawReadable).filter(Boolean);

  return {
    sessionId,
    permissionMode: normalizedMode,
    policy,
    writableFolders,
    readableFolders,
  };
}

module.exports = {
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_META,
  normalizePermissionMode,
  getPermissionModePolicy,
  resolveRealPathSafe,
  isUnderFolderReal,
  getBuiltinReadOnlyTrustedDirs,
  getSensitiveBlacklistPaths,
  checkSensitivePath,
  checkProtectedWorkspaceWrite,
  buildSanitizedShellEnv,
  createSessionSandboxContext,
};
