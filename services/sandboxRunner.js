/**
 * sandboxRunner — macOS Seatbelt (sandbox-exec) 内核级命令沙箱执行器
 *
 * 特性：
 * 1. 基于 Apple Seatbelt SBPL 动态生成每次命令专属的 .sb 配置文件
 * 2. 支持 "read-only"（只读沙箱）与 "workspace-write"（工作区写沙箱）两档内核隔离
 * 3. 自动解析 fs.realpathSync 真实路径（兼容 macOS /tmp -> /private/tmp 等软链接）
 * 4. 放行 Node/Python/Clang/Git 等研发工具链必需的系统临时目录与包管理器缓存目录
 * 5. 强制封锁 ~/.omcx/config.json、~/.ssh、~/.aws 等高敏路径读取，以及 .git/hooks、.omcx 写入
 * 6. 精准识别沙箱拦截错误 (Operation not permitted / EPERM)，支持向上层抛出逃生审批信号
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  resolveRealPathSafe,
  getSensitiveBlacklistPaths,
  buildSanitizedShellEnv,
} = require("./sandboxPolicyService");

const USER_HOME = os.homedir();
const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/**
 * 检测当前系统是否具备可用的 macOS sandbox-exec
 */
function isMacOsSeatbeltAvailable() {
  return process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC_BIN);
}

/**
 * 安全转义写入 SBPL 双引号字符串的路径（剔除控制字符并转义反斜杠与双引号）
 */
function escapeSbplString(str) {
  return String(str || "")
    .replace(/[\r\n\0]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * 获取研发工具链（npm / pnpm / yarn / pip / cargo / pytest / v8 / clang）必需的可写临时与缓存目录
 */
function getToolchainWritableDirs(mode = "workspace-write") {
  const baseTmpDirs = [
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    os.tmpdir(),
  ];

  if (mode === "read-only") {
    // 只读模式下仅允许系统 /tmp 与进程瞬态临时目录（供 python/node/git 运行时创建临时句柄），绝不放行工作空间
    return Array.from(new Set(baseTmpDirs.map((d) => resolveRealPathSafe(d)).filter(Boolean)));
  }

  const devCacheDirs = [
    ...baseTmpDirs,
    path.join(USER_HOME, ".npm"),
    path.join(USER_HOME, ".pnpm-store"),
    path.join(USER_HOME, ".yarn"),
    path.join(USER_HOME, ".cache"),
    path.join(USER_HOME, ".cargo", "registry"),
    path.join(USER_HOME, ".cargo", "git"),
    path.join(USER_HOME, "Library", "Caches"),
  ];

  const expanded = new Set();
  for (const dir of devCacheDirs) {
    if (!dir) continue;
    expanded.add(path.resolve(dir));
    expanded.add(resolveRealPathSafe(dir));
  }
  return Array.from(expanded).filter(Boolean);
}

/**
 * 构建 macOS Seatbelt (.sb) 策略文本
 *
 * 注意 SBPL 优先级规则：后出现的规则（以及更具体的规则）覆盖先出现的规则。
 * 因此顺序为：
 *   1. (allow default)               — 允许基础系统运行库、进程派生、Mach 通信、网络与普通文件读取
 *   2. (deny file-write*)            — 默认禁止全盘一切文件写入与删除
 *   3. (allow file-write* ...)       — 放行工作区可写目录（仅 workspace-write 模式）、临时目录及设备节点
 *   4. (deny file-write* ...)        — 强制禁止改写工作区内的 .git/hooks、.git/config、.omcx（防提权逃逸）
 *   5. (deny file-read* file-write*) — 最高优先级封锁 ~/.ssh、~/.aws、~/.omcx/config.json 等高敏凭据
 */
function buildSeatbeltProfile({
  writeMode = "workspace-write",
  writableFolders = [],
  sessionId = null,
}) {
  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    "; 1. 默认封锁全盘写入",
    "(deny file-write*)",
    "",
    "; 2. 放行基础标准设备节点写入",
    "(allow file-write*",
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/random")',
    '  (literal "/dev/urandom")',
    '  (literal "/dev/dtracehelper")',
    ")",
  ];

  // 3. 放行临时目录与工具链缓存目录写入
  const toolchainDirs = getToolchainWritableDirs(writeMode);
  if (toolchainDirs.length > 0) {
    lines.push("", "; 3. 放行研发工具链临时目录与缓存写入", "(allow file-write*");
    for (const dir of toolchainDirs) {
      lines.push(`  (subpath "${escapeSbplString(dir)}")`);
    }
    lines.push(")");
  }

  // 4. 在 workspace-write 模式下，放行用户工作空间挂载目录写入
  const realWorkspaces = [];
  if (writeMode === "workspace-write" && Array.isArray(writableFolders) && writableFolders.length > 0) {
    const folderSet = new Set();
    for (const f of writableFolders) {
      if (!f) continue;
      folderSet.add(path.resolve(f));
      folderSet.add(resolveRealPathSafe(f));
    }
    for (const f of folderSet) {
      if (f) realWorkspaces.push(f);
    }

    if (realWorkspaces.length > 0) {
      lines.push("", "; 4. 放行当前会话绑定的工作空间目录写入", "(allow file-write*");
      for (const dir of realWorkspaces) {
        lines.push(`  (subpath "${escapeSbplString(dir)}")`);
      }
      lines.push(")");

      // 5. 保护工作区内的 .git/hooks、.git/config 与 .omcx 不被子进程静默篡改
      lines.push("", "; 5. 锁定工作区内高危控制目录，防止通过 Git Hooks 或 .omcx 配置自改提权", "(deny file-write*");
      for (const dir of realWorkspaces) {
        lines.push(`  (subpath "${escapeSbplString(path.join(dir, ".git", "hooks"))}")`);
        lines.push(`  (literal "${escapeSbplString(path.join(dir, ".git", "config"))}")`);
        lines.push(`  (subpath "${escapeSbplString(path.join(dir, ".omcx"))}")`);
      }
      lines.push(")");
    }
  }

  // 6. 最高优先级：封锁宿主机敏感凭据与客户端核心配置文件的读取与写入
  const sensitiveList = getSensitiveBlacklistPaths();
  const expandedSensitive = new Set();
  for (const p of sensitiveList) {
    if (!p) continue;
    expandedSensitive.add(path.resolve(p));
    expandedSensitive.add(resolveRealPathSafe(p));
  }

  lines.push("", "; 6. 最高优先级封锁敏感凭据与客户端配置文件读写", "(deny file-read* file-write*");
  for (const p of expandedSensitive) {
    lines.push(`  (subpath "${escapeSbplString(p)}")`);
  }
  lines.push(")");

  return lines.join("\n") + "\n";
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 忽略已退出进程异常
    }
  }
}

/**
 * 识别命令失败是否由沙箱权限拦截引起
 */
function detectSandboxViolation(exitCode, stdout = "", stderr = "", errorMsg = "") {
  if (exitCode === 0) return { isViolation: false };
  const combined = `${stderr}\n${stdout}\n${errorMsg}`;

  // 检查是否因为宿主环境本身禁止嵌套 sandbox_init (如在受限容器中运行客户端)
  if (/sandbox_apply:\s*Operation not permitted|bootstrap_check_in.*Permission denied/i.test(combined)) {
    return {
      isViolation: true,
      isNestedSandboxError: true,
      summary: "当前宿主环境限制了嵌套沙箱初始化或 Mach 服务访问",
    };
  }

  const patterns = [
    /Operation not permitted/i,
    /\bEPERM\b/,
    /\bEACCES\b.*(?:\.ssh|\.aws|\.omcx|\/Library|\/etc|\/usr|\/var)/i,
    /Read-only file system/i,
    /\bEROFS\b/,
    /sandbox-exec:.*denied/i,
    /Permission denied.*(?:\.git\/hooks|\.omcx)/i,
  ];

  const matched = patterns.some((re) => re.test(combined));
  if (!matched) return { isViolation: false };

  // 尝试从报错行中提取第一条包含 Operation not permitted / EPERM 的关键行
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const keyLine =
    lines.find((l) => /Operation not permitted|EPERM|Read-only file system|Permission denied/i.test(l)) ||
    lines[0] ||
    "沙箱策略拦截了越界系统调用或文件写入";

  return {
    isViolation: true,
    isNestedSandboxError: false,
    summary: keyLine.slice(0, 240),
  };
}

/**
 * 执行 Shell 命令（支持 OS 沙箱模式与非沙箱模式）
 */
function runSandboxedCommand(
  command,
  {
    cwd,
    timeoutMs = 30000,
    abortSignal = null,
    useSandbox = true,
    writeMode = "workspace-write",
    writableFolders = [],
    sessionId = null,
  } = {}
) {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      return resolve({
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        sandboxed: false,
        error: "命令执行已被用户取消",
      });
    }

    const canUseSeatbelt = useSandbox && isMacOsSeatbeltAvailable();
    let profilePath = null;

    if (canUseSeatbelt) {
      try {
        const profileContent = buildSeatbeltProfile({
          writeMode,
          writableFolders,
          sessionId,
        });
        const tmpDir = resolveRealPathSafe(os.tmpdir()) || "/tmp";
        const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        profilePath = path.join(tmpDir, `omcx-sb-${uniqueId}.sb`);
        fs.writeFileSync(profilePath, profileContent, { encoding: "utf-8", mode: 0o600 });
      } catch (err) {
        // 如果生成临时策略失败，安全降级并记录
        profilePath = null;
      }
    }

    const cleanupProfile = () => {
      if (profilePath) {
        try {
          if (fs.existsSync(profilePath)) {
            fs.unlinkSync(profilePath);
          }
        } catch {
          // 忽略临时文件清理异常
        }
        profilePath = null;
      }
    };

    const userShell = process.env.SHELL || "/bin/zsh";
    const env = buildSanitizedShellEnv(process.env, {
      stripSecrets: Boolean(canUseSeatbelt),
    });

    let child;
    try {
      if (canUseSeatbelt && profilePath) {
        child = spawn(SANDBOX_EXEC_BIN, ["-f", profilePath, userShell, "-c", command], {
          cwd,
          env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        child = spawn(command, {
          cwd,
          shell: true,
          env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (err) {
      cleanupProfile();
      return resolve({
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        sandboxed: Boolean(canUseSeatbelt && profilePath),
        error: err.message || String(err),
      });
    }

    const actuallySandboxed = Boolean(canUseSeatbelt && profilePath);
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      cleanupProfile();
      resolve(payload);
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
      finish({
        success: false,
        exitCode: -1,
        stdout,
        stderr,
        sandboxed: actuallySandboxed,
        error: "命令执行已被用户中断",
      });
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes < MAX_BUFFER_BYTES) {
        stdout += chunk.toString("utf-8");
        stdoutBytes += chunk.length;
      }
    });

    child.stderr?.on("data", (chunk) => {
      if (stderrBytes < MAX_BUFFER_BYTES) {
        stderr += chunk.toString("utf-8");
        stderrBytes += chunk.length;
      }
    });

    child.on("error", (err) => {
      finish({
        success: false,
        exitCode: -1,
        stdout,
        stderr,
        sandboxed: actuallySandboxed,
        error: err.message || String(err),
      });
    });

    child.on("close", (code, signal) => {
      if (aborted) return;
      if (timedOut) {
        return finish({
          success: false,
          exitCode: code ?? -1,
          stdout,
          stderr,
          sandboxed: actuallySandboxed,
          error: `命令执行超时 (${Math.round(timeoutMs / 1000)}s)`,
        });
      }

      const exitCode = typeof code === "number" ? code : signal ? -1 : 0;
      const errorMsg = exitCode === 0 ? undefined : stderr.trim() || `进程退出码: ${exitCode}`;
      const violation = actuallySandboxed
        ? detectSandboxViolation(exitCode, stdout, stderr, errorMsg)
        : { isViolation: false };

      finish({
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        sandboxed: actuallySandboxed,
        sandboxMode: actuallySandboxed ? writeMode : "none",
        sandboxViolation: violation.isViolation,
        sandboxViolationSummary: violation.summary,
        isNestedSandboxError: violation.isNestedSandboxError || false,
        error: errorMsg,
      });
    });
  });
}

module.exports = {
  isMacOsSeatbeltAvailable,
  buildSeatbeltProfile,
  detectSandboxViolation,
  runSandboxedCommand,
};
