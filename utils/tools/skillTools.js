const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { z } = require("zod");
const { StructuredTool } = require("@langchain/core/tools");
const storageService = require("../../services/storageService");
const { getPermissionModePolicy, PERMISSION_MODES } = require("../../services/sandboxPolicyService");
const { isUnderFolder } = require("./pathResolver");

const MAX_OUTPUT_CHARS = 30000;
const DEFAULT_TIMEOUT_MS = 120000;

function splitArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args.slice(0, 50);
}

function buildCommand(scriptPath) {
  const ext = path.extname(scriptPath).toLowerCase();
  switch (ext) {
    case ".sh":
    case ".bash":
      return { command: "/bin/bash", prefix: [] };
    case ".zsh":
      return { command: "/bin/zsh", prefix: [] };
    case ".py":
      return { command: "python3", prefix: [] };
    case ".rb":
      return { command: "ruby", prefix: [] };
    case ".js":
    case ".mjs":
    case ".cjs":
      return { command: "node", prefix: [] };
    case ".ts":
      return { command: "npx", prefix: ["--no-install", "tsx"] };
    default:
      return { command: "/bin/sh", prefix: [] };
  }
}

function runScript(scriptPath, args, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    const { command, prefix } = buildCommand(scriptPath);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(command, [...prefix, scriptPath, ...args], {
        cwd,
        env: {
          ...process.env,
          OMCX_SKILL_SCRIPT: "1",
          COLORTERM: "truecolor",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ success: false, timedOut: true, error: `脚本执行超时（>${timeoutMs / 1000}s）`, stdout, stderr });
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({ success: false, aborted: true, error: "脚本执行已被用户中断", stdout, stderr });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });
    child.on("error", (err) => finish({ success: false, error: err.message, stdout, stderr }));
    child.on("close", (code, sig) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      finish({
        success: code === 0,
        exitCode: code,
        signal: sig,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
      });
    });
  });
}

class RunSkillScriptTool extends StructuredTool {
  constructor() {
    super();
    this.name = "run_skill_script";
    this.description =
      "执行已安装技能声明的脚本（技能目录 scripts/ 下的 .sh/.py/.js/.ts 等）。仅允许执行技能清单中声明的脚本，路径越界会被拒绝。适用于技能需要运行格式化、扫描、生成器等确定性步骤时。";
    this.schema = z.object({
      skill: z.string().describe("技能名称或 ID，例如 api-review"),
      script: z.string().optional().describe("脚本文件名；省略时执行该技能的第一个脚本"),
      args: z.string().optional().describe("传给脚本的命令行参数（支持空格与引号）"),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(300000)
        .optional()
        .describe("超时毫秒数，默认 120000"),
    });
  }

  async _call({ skill, script, args, timeout_ms, __workDir, __checkPermission, __toolContext }) {
    if (!__workDir) {
      return JSON.stringify({ success: false, error: "当前会话未绑定工作目录" });
    }
    const skills = storageService.getSkills(__workDir);
    const matched = skills.find(
      (s) => s.name === skill || s.id === skill || s.name.toLowerCase() === String(skill).toLowerCase()
    );
    if (!matched) {
      return JSON.stringify({ success: false, error: `未找到技能: ${skill}` });
    }
    const scripts = Array.isArray(matched.scripts) ? matched.scripts : [];
    if (scripts.length === 0) {
      return JSON.stringify({
        success: false,
        error: `技能 ${matched.name} 未声明任何可执行脚本（需在技能目录 scripts/ 下提供脚本文件）`,
      });
    }

    const chosen = script
      ? scripts.find(
          (item) =>
            item.name === script ||
            path.basename(item.path) === script ||
            path.basename(item.path, path.extname(item.path)) === script
        )
      : scripts[0];
    if (!chosen) {
      return JSON.stringify({
        success: false,
        error: `技能 ${matched.name} 未找到脚本: ${script}`,
        availableScripts: scripts.map((s) => s.name),
      });
    }

    const realScript = (() => {
      try {
        return fs.realpathSync(chosen.path);
      } catch {
        return path.resolve(chosen.path);
      }
    })();
    const skillRoot = (() => {
      try {
        return fs.realpathSync(matched.dir || path.dirname(chosen.path));
      } catch {
        return path.resolve(matched.dir || path.dirname(chosen.path));
      }
    })();
    if (!isUnderFolder(realScript, skillRoot) || !fs.existsSync(realScript)) {
      return JSON.stringify({ success: false, error: "脚本路径超出技能目录或文件不存在，已拒绝执行" });
    }

    const permissionMode = __toolContext?.permissionMode;
    const policy = getPermissionModePolicy(permissionMode);
    if (permissionMode === PERMISSION_MODES.PLAN) {
      return JSON.stringify({
        success: false,
        error: "当前为只读规划模式，禁止执行技能脚本",
      });
    }

    const insideWorkspace = (__toolContext?.allowedFolders || []).some((folder) =>
      isUnderFolder(realScript, folder)
    );
    // 全局技能脚本位于工作区之外时必须经过用户审批；ask 模式同样确认
    if (!insideWorkspace || policy?.confirmCommand) {
      if (typeof __checkPermission !== "function") {
        return JSON.stringify({ success: false, error: "当前环境缺少权限审批通道，已拒绝执行脚本" });
      }
      const allowed = await __checkPermission(
        `${realScript} ($ ${chosen.name} ${args || ""})`.trim(),
        "执行技能脚本",
        {
          kind: "ask_command",
          command: `${chosen.name} ${args || ""}`.trim(),
          reason: `技能 ${matched.name} 请求执行脚本 ${chosen.name}`,
          allowSwitchAutoSandbox: true,
        }
      );
      if (!allowed) {
        return JSON.stringify({ success: false, error: "用户已拒绝执行该技能脚本" });
      }
    }

    const result = await runScript(
      realScript,
      splitArgs(args),
      skillRoot,
      timeout_ms || DEFAULT_TIMEOUT_MS,
      __toolContext?.abortSignal
    );
    return JSON.stringify({
      success: result.success,
      skill: matched.name,
      script: chosen.name,
      ...result,
    });
  }
}

module.exports = { RunSkillScriptTool };
