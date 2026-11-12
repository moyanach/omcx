/**
 * shellTools — 基于 LangChain StructuredTool 的异步非阻塞 Shell 命令执行工具
 *
 * 特性：
 * 1. 异步 spawn 执行，绝不阻塞 Electron 主进程事件循环
 * 2. 支持 AbortSignal 秒级中断整个子进程组（点击停止生成立即终止命令）
 * 3. 对齐 4 档权限模式与 macOS Seatbelt (sandbox-exec) 内核级沙箱隔离
 * 4. 沙箱权限拦截自动识别与「仅本次沙箱外重跑」逃生舱口审批闭环
 * 5. 高危破坏性命令（rm -rf / git reset --hard / git push -f / sudo 等）强制弹窗审批
 */

const path = require("path");
const { z } = require("zod");
const { StructuredTool } = require("@langchain/core/tools");
const { resolveWorkspacePath, DEFAULT_ROOT } = require("./pathResolver");
const {
  PERMISSION_MODES,
  getPermissionModePolicy,
} = require("../../services/sandboxPolicyService");
const { runSandboxedCommand } = require("../../services/sandboxRunner");

const MAX_STDOUT_CHARS = 5000;
const MAX_STDERR_CHARS = 2000;

const DANGEROUS_COMMAND_PATTERNS = [
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+([^\n]*\s+)?(--force|-f|\+\S+)\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/i,
  /\bsudo\s+/i,
  /\b(?:mkfs|fdisk|dd\s+if=|shutdown|reboot)\b/i,
  /\b(?:drop\s+table|drop\s+database|truncate\s+table)\b/i,
  // find 的 -delete/-exec rm 等价于批量删除，统一纳入高危确认
  /\bfind\b[^\n]*\s-delete\b/i,
  /\bfind\b[^\n]*\s-exec\s+(?:rm|shred)\b/i,
];

/**
 * rm 的递归/强制参数经常被拆成 rm -r -f、rm -f -r、rm --recursive --force 等形态，
 * 单一正则容易被绕过，这里按参数逐个判定（只要出现递归或强制即视为高危）。
 */
function isDangerousRm(text) {
  const match = text.match(/\brm\b([^\n;&|]*)/i);
  if (!match) return false;
  const args = match[1].split(/\s+/).filter(Boolean);
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg)) recursive = true;
    if (arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) force = true;
  }
  return recursive || force;
}

function isDangerousCommand(cmd) {
  const text = String(cmd || "").trim();
  if (!text) return false;
  if (isDangerousRm(text)) return true;
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

// ─── 工具: run_command ───────────────────────────────────────

class RunCommandTool extends StructuredTool {
  constructor() {
    super();
    this.name = "run_command";
    this.description =
      "在项目目录中执行 Shell 命令。适合运行构建、测试、安装依赖、git 操作等开发命令。命令默认受工作区安全沙箱保护。";
    this.schema = z.object({
      command: z.string().describe("要执行的 Shell 命令"),
      description: z.string().describe("命令说明，解释为什么需要执行这条命令及预期的效果"),
      timeout: z.number().optional().default(30).describe("超时时间（秒，默认 30）"),
      cwd: z.string().optional().describe("工作目录（可选，默认项目根目录）"),
    });
  }

  async _call({
    command,
    description,
    timeout = 30,
    cwd,
    __workDir,
    __allowedFolders,
    __checkPermission,
    __abortSignal,
    __toolContext,
  }) {
    const permissionMode =
      __toolContext?.permissionMode || PERMISSION_MODES.AUTO_SANDBOX;
    const policy = getPermissionModePolicy(permissionMode);
    const sessionId = __toolContext?.sessionId || null;
    const baseDir = __workDir ? path.resolve(__workDir) : DEFAULT_ROOT;
    const writableFolders =
      Array.isArray(__toolContext?.writableFolders) && __toolContext.writableFolders.length > 0
        ? __toolContext.writableFolders
        : Array.isArray(__allowedFolders) && __allowedFolders.length > 0
        ? __allowedFolders
        : [baseDir];

    let targetCwd = baseDir;

    if (cwd && String(cwd).trim()) {
      const resolved = resolveWorkspacePath(
        String(cwd).trim(),
        __workDir,
        __allowedFolders,
        {
          mode: "read",
          sessionId,
          writableFolders,
        }
      );

      if (resolved.isSensitiveBlocked) {
        return JSON.stringify({
          success: false,
          command,
          description,
          exitCode: -1,
          error: resolved.sensitiveReason || `禁止在敏感目录执行命令: ${cwd}`,
        });
      }

      if (resolved.isExternal && permissionMode !== PERMISSION_MODES.FULL_ACCESS) {
        if (typeof __checkPermission === "function") {
          const allowed = await __checkPermission(
            resolved.resolvedPath,
            `在外部目录执行命令: ${command}`,
            {
              kind: "external_path",
              command,
              reason: "命令指定的工作目录位于当前工作空间之外，请确认是否授权",
            }
          );
          if (!allowed) {
            return JSON.stringify({
              success: false,
              command,
              description,
              exitCode: -1,
              error: `用户已拒绝授权在工作空间外部目录执行命令: ${resolved.resolvedPath}`,
            });
          }
        } else {
          return JSON.stringify({
            success: false,
            command,
            description,
            exitCode: -1,
            error: `工作目录超出工作空间范围: ${cwd}`,
          });
        }
      }
      targetCwd = resolved.resolvedPath;
    }

    const dangerous = isDangerousCommand(command);

    // 1. 只读规划模式下，直接拦截破坏性命令
    if (permissionMode === PERMISSION_MODES.PLAN && dangerous) {
      return JSON.stringify({
        success: false,
        command,
        description,
        exitCode: -1,
        sandboxed: true,
        sandboxMode: "read-only",
        error: `当前会话处于「只读规划 (plan)」模式，已禁止执行破坏性命令: ${command}`,
      });
    }

    // 2. 高危破坏性命令检测与用户确认拦截（所有模式均拦截确认）
    if (dangerous && typeof __checkPermission === "function") {
      const allowed = await __checkPermission(
        `${targetCwd} ($ ${command})`,
        "执行高危命令",
        {
          kind: "dangerous_command",
          command,
          reason: `检测到潜在不可逆或破坏性命令 (${description || command})，请确认是否允许执行`,
        }
      );
      if (!allowed) {
        return JSON.stringify({
          success: false,
          command,
          description,
          exitCode: -1,
          error: `用户已拒绝执行高危命令: ${command}`,
        });
      }
    } else if (policy.confirmCommand && typeof __checkPermission === "function") {
      // 3. 「询问确认 (ask)」模式下，常规命令执行前请求用户确认
      const allowed = await __checkPermission(
        `${targetCwd} ($ ${command})`,
        "执行终端命令",
        {
          kind: "ask_command",
          command,
          reason: description
            ? `命令说明: ${description}`
            : "当前处于「询问确认」权限模式，执行命令前需经您确认",
          allowSwitchAutoSandbox: true,
        }
      );
      if (!allowed) {
        return JSON.stringify({
          success: false,
          command,
          description,
          exitCode: -1,
          error: `用户已取消执行命令: ${command}`,
        });
      }
    }

    const timeoutMs = Math.max(1, Number(timeout) || 30) * 1000;
    let result = await runSandboxedCommand(command, {
      cwd: targetCwd,
      timeoutMs,
      abortSignal: __abortSignal,
      useSandbox: policy.useOsSandbox,
      writeMode: policy.osSandboxWriteMode,
      writableFolders,
      sessionId,
    });

    // 4. 沙箱拦截逃生舱口（Escape Hatch）：
    //    若在 auto-sandbox / ask 模式下因 OS 沙箱权限限制导致命令失败，询问用户是否允许仅本次在沙箱外重跑
    if (
      !result.success &&
      result.sandboxViolation &&
      permissionMode !== PERMISSION_MODES.PLAN &&
      typeof __checkPermission === "function"
    ) {
      const allowUnsandboxed = await __checkPermission(
        `${targetCwd} ($ ${command})`,
        "沙箱拦截 · 申请沙箱外重跑",
        {
          kind: "sandbox_escape",
          command,
          reason: `命令受安全沙箱限制 (${result.sandboxViolationSummary || "Operation not permitted"})。是否允许仅本次在沙箱外重新执行？`,
        }
      );

      if (allowUnsandboxed) {
        result = await runSandboxedCommand(command, {
          cwd: targetCwd,
          timeoutMs,
          abortSignal: __abortSignal,
          useSandbox: false,
          writeMode: "none",
          writableFolders,
          sessionId,
        });
        result.sandboxBypassedOnce = true;
      }
    }

    const basePayload = {
      success: result.success,
      command,
      description,
      exitCode: result.exitCode,
      sandboxed: Boolean(result.sandboxed),
      sandboxMode: result.sandboxMode || "none",
      ...(result.sandboxBypassedOnce ? { sandboxBypassedOnce: true } : {}),
      ...(result.sandboxViolation ? { sandboxViolation: true } : {}),
      stdout: (result.stdout || "").substring(0, MAX_STDOUT_CHARS),
      stderr: result.stderr ? result.stderr.substring(0, MAX_STDERR_CHARS) : undefined,
      truncated: (result.stdout || "").length > MAX_STDOUT_CHARS,
    };

    if (result.success) {
      return JSON.stringify(basePayload);
    }

    return JSON.stringify({
      ...basePayload,
      stderr: (result.stderr || "").substring(0, MAX_STDERR_CHARS),
      error:
        permissionMode === PERMISSION_MODES.PLAN && result.sandboxViolation
          ? `只读规划沙箱已阻止该命令的写入操作: ${result.sandboxViolationSummary || result.error}`
          : result.error,
    });
  }
}

module.exports = {
  RunCommandTool,
};
