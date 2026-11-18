/**
 * Agent 生命周期 Hooks 服务
 *
 * 配置文件（JSON）：
 *   ~/.omcx/hooks.json                         全局，始终加载
 *   <workDir>/.omcx/hooks.json                 项目级，仅在用户显式信任后加载
 *
 * 结构兼容两种写法：
 *   { "hooks": { "PreToolUse": [ { "matcher": "write_file", "command": "...", "timeout": 10 } ] } }
 *   { "PreToolUse": [ ... ] }
 *
 * 支持事件：UserPromptSubmit / PreToolUse / PostToolUse / Stop
 * 兼容别名：beforeToolUse → PreToolUse、afterToolUse → PostToolUse、
 *           afterFileWrite → PostToolUse（仅对 write_file / edit_file 生效）
 * 退出码语义：0 继续；2 阻断；其他按警告处理。
 * stdout 若为 JSON，可返回 { decision: "block"|"approve", reason, additionalContext }。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const EVENT_NAMES = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const EVENT_ALIASES = {
  beforeToolUse: "PreToolUse",
  afterToolUse: "PostToolUse",
  afterFileWrite: "PostToolUse",
};
const SOURCE_EVENT_NAMES = [...EVENT_NAMES, ...Object.keys(EVENT_ALIASES)];
const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const MAX_OUTPUT_CHARS = 32 * 1024;
const DEFAULT_TIMEOUT_SEC = 10;

// 与 storageService 保持一致：支持 OMCX_HOME 覆盖（测试 / 便携模式）
function omcxHomeDir() {
  return process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
}

function hooksFilePath(workDir, scope) {
  if (scope === "global") return path.join(omcxHomeDir(), "hooks.json");
  return workDir ? path.join(workDir, ".omcx", "hooks.json") : null;
}

function readHooksFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const source = raw && typeof raw.hooks === "object" ? raw.hooks : raw;
    const result = {};
    for (const event of EVENT_NAMES) result[event] = [];
    for (const sourceEvent of SOURCE_EVENT_NAMES) {
      const event = EVENT_ALIASES[sourceEvent] || sourceEvent;
      const list = Array.isArray(source?.[sourceEvent]) ? source[sourceEvent] : [];
      const mapped = list
        .filter((item) => item && typeof item.command === "string" && item.command.trim())
        .map((item, idx) => ({
          id: `${sourceEvent}-${idx}`,
          event,
          sourceEvent,
          // afterFileWrite 只对文件写入工具生效，即使未配置 matcher
          onlyFileWrite: sourceEvent === "afterFileWrite",
          command: item.command.trim(),
          matcher: typeof item.matcher === "string" ? item.matcher : "",
          timeout: Math.min(
            120,
            Math.max(1, Number(item.timeout) || DEFAULT_TIMEOUT_SEC)
          ),
          enabled: item.enabled !== false,
        }));
      result[event].push(...mapped);
    }
    return result;
  } catch (err) {
    console.error(`[hookService] 读取 Hooks 配置失败 (${filePath}):`, err.message);
    return {};
  }
}

function listHooks(workDir, { projectTrusted = false } = {}) {
  const globalPath = hooksFilePath(null, "global");
  const projectPath = hooksFilePath(workDir, "project");
  const global = readHooksFile(globalPath);
  const projectConfigured = readHooksFile(projectPath);
  const project = projectTrusted ? projectConfigured : {};
  const counts = {};
  for (const event of EVENT_NAMES) {
    counts[event] = (global[event]?.length || 0) + (project[event]?.length || 0);
  }
  return {
    globalPath,
    projectPath,
    global,
    project,
    projectConfigured,
    projectTrusted: Boolean(projectTrusted),
    hasProjectHooks: EVENT_NAMES.some(
      (event) => (projectConfigured[event]?.length || 0) > 0
    ),
    counts,
  };
}

function matchesTool(matcher, toolName) {
  if (!matcher || matcher === "*") return true;
  const value = String(toolName || "");
  if (matcher === value) return true;
  const regexMatch = matcher.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2]).test(value);
    } catch {
      return false;
    }
  }
  return matcher.split(",").map((s) => s.trim()).some((s) => s && (s === value || value.includes(s)));
}

function runHookCommand(hook, payload, { workDir, sessionId }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      OMCX_HOOK_EVENT: hook.event,
      OMCX_SESSION_ID: sessionId || "",
      OMCX_PROJECT_DIR: workDir || "",
    };
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn("/bin/sh", ["-c", hook.command], {
        cwd: workDir && fs.existsSync(workDir) ? workDir : process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ id: hook.id, event: hook.event, ok: false, error: err.message });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({
        id: hook.id,
        event: hook.event,
        ok: false,
        timedOut: true,
        error: `Hook 超时（>${hook.timeout}s）`,
      });
    }, hook.timeout * 1000);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish({ id: hook.id, event: hook.event, ok: false, error: err.message });
    });
    child.on("close", (code) => {
      let parsed = null;
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {}
      }
      const decision =
        parsed?.decision === "block" || code === 2
          ? "block"
          : parsed?.decision === "approve"
          ? "approve"
          : "continue";
      finish({
        id: hook.id,
        event: hook.event,
        command: hook.command,
        exitCode: code,
        decision,
        reason:
          parsed?.reason ||
          (code === 2 ? stderr.trim() || stdout.trim() || "Hook 返回退出码 2" : ""),
        additionalContext: parsed?.additionalContext || "",
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        ok: code === 0,
      });
    });

    try {
      child.stdin.end(JSON.stringify(payload || {}));
    } catch {}
  });
}

/**
 * @returns {Promise<{blocked:boolean, reason:string, additionalContext:string, results:Array}>}
 */
async function runHooks(eventName, payload, options = {}) {
  const out = { blocked: false, reason: "", additionalContext: "", results: [] };
  const canonicalEvent = EVENT_ALIASES[eventName] || eventName;
  if (!EVENT_NAMES.includes(canonicalEvent)) return out;
  if (options.enabled === false) return out;

  const workDir = options.workDir || null;
  const hooks = listHooks(workDir, { projectTrusted: options.projectTrusted });
  const list = [
    ...(hooks.global[canonicalEvent] || []),
    ...(hooks.project[canonicalEvent] || []),
  ].filter(
    (hook) =>
      hook.enabled &&
      (canonicalEvent !== "PreToolUse" && canonicalEvent !== "PostToolUse"
        ? true
        : (!hook.onlyFileWrite || FILE_WRITE_TOOLS.has(payload?.tool_name)) &&
          matchesTool(hook.matcher, payload?.tool_name))
  );

  for (const hook of list) {
    const result = await runHookCommand(hook, payload, {
      workDir,
      sessionId: options.sessionId,
    });
    out.results.push(result);
    if (result.additionalContext) {
      out.additionalContext = out.additionalContext
        ? `${out.additionalContext}\n\n${result.additionalContext}`
        : result.additionalContext;
    }
    if (result.decision === "block" && !out.blocked) {
      out.blocked = true;
      out.reason = result.reason || `Hook 阻断了 ${eventName}`;
    }
  }
  return out;
}

module.exports = { EVENT_NAMES, EVENT_ALIASES, listHooks, runHooks, hooksFilePath };
