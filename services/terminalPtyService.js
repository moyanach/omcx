/**
 * TerminalPtyService — 基于 node-pty 的原生伪终端会话管理
 *
 * 与旧的一次性 terminal-run-command 并存：
 * - 旧通道继续服务 Agent 命令回放与快捷命令；
 * - 新通道提供真正的交互式 Shell（REPL / vim / ssh / watch / Ctrl+C 等）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const pty = require("node-pty");

const MAX_SESSIONS = 8;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function sanitizeId(id) {
  return String(id || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function resolveCwd(cwd, workDir) {
  const candidates = [cwd, workDir, os.homedir()];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") continue;
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      // 继续尝试下一个候选目录
    }
  }
  return os.homedir();
}

function summarizePath(pathValue) {
  return String(pathValue || "")
    .split(":")
    .filter(Boolean)
    .slice(0, 8)
    .join(":");
}

function buildEnv(extraEnv = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  return {
    ...env,
    ...extraEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    OMCX_TERMINAL: "1",
    // 声明 iTerm2 兼容身份：yazi / viu / imgcat 这类 TUI 只有检测到真终端支持图形协议时
    // 才会走 IIP（OSC 1337）内联图片，渲染进程由 @xterm/addon-image 负责绘制，
    // 因此不再依赖本机安装 chafa 之类的外部转换器。
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "3.5.0",
    LC_TERMINAL: "iTerm2",
  };
}

class TerminalPtyService {
  constructor() {
    this.sessions = new Map();
  }

  create({ terminalId, cwd, workDir, cols, rows, shell, env } = {}) {
    const id = sanitizeId(terminalId || `pty_${Date.now()}`);
    if (!id) return { success: false, error: "缺少终端 ID" };

    const existing = this.sessions.get(id);
    if (existing && existing.pty) {
      return {
        success: true,
        terminalId: id,
        cwd: existing.cwd,
        shell: existing.shell,
        cols: existing.cols,
        rows: existing.rows,
        pathHead: summarizePath(existing.envPath),
        reused: true,
      };
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      return { success: false, error: `终端会话数已达上限 (${MAX_SESSIONS})，请先关闭其他终端` };
    }

    const resolvedCwd = resolveCwd(cwd, workDir);
    const shellPath = shell || process.env.SHELL || "/bin/zsh";
    const finalCols = clamp(cols, 20, 400, DEFAULT_COLS);
    const finalRows = clamp(rows, 5, 200, DEFAULT_ROWS);
    const ptyEnv = buildEnv(env);

    let proc;
    try {
      proc = pty.spawn(shellPath, ["-l"], {
        name: "xterm-256color",
        cols: finalCols,
        rows: finalRows,
        cwd: resolvedCwd,
        env: ptyEnv,
      });
    } catch (err) {
      return { success: false, error: `启动交互式终端失败: ${err.message}` };
    }

    const session = {
      id,
      pty: proc,
      cwd: resolvedCwd,
      shell: shellPath,
      cols: finalCols,
      rows: finalRows,
      sender: null,
      envPath: ptyEnv.PATH,
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);

    proc.onData((data) => {
      this._send(session, "terminal-pty-data", { terminalId: id, data });
    });

    proc.onExit(({ exitCode, signal }) => {
      this._send(session, "terminal-pty-exit", {
        terminalId: id,
        exitCode,
        signal,
      });
      this.sessions.delete(id);
    });

    return {
      success: true,
      terminalId: id,
      cwd: resolvedCwd,
      shell: shellPath,
      cols: finalCols,
      rows: finalRows,
      pid: proc.pid,
      pathHead: summarizePath(ptyEnv.PATH),
    };
  }

  bindSender(terminalId, sender) {
    const session = this.sessions.get(sanitizeId(terminalId));
    if (session) session.sender = sender;
  }

  _send(session, channel, payload) {
    const sender = session.sender;
    if (!sender || (sender.isDestroyed && sender.isDestroyed())) return;
    try {
      sender.send(channel, payload);
    } catch {
      // 渲染进程已关闭时忽略推送异常
    }
  }

  write(terminalId, data) {
    const session = this.sessions.get(sanitizeId(terminalId));
    if (!session || !session.pty) return { success: false, error: "终端不存在" };
    try {
      session.pty.write(String(data ?? ""));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  resize(terminalId, cols, rows) {
    const session = this.sessions.get(sanitizeId(terminalId));
    if (!session || !session.pty) return { success: false, error: "终端不存在" };
    const finalCols = clamp(cols, 20, 400, session.cols);
    const finalRows = clamp(rows, 5, 200, session.rows);
    try {
      session.pty.resize(finalCols, finalRows);
      session.cols = finalCols;
      session.rows = finalRows;
      return { success: true, cols: finalCols, rows: finalRows };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  dispose(terminalId) {
    const id = sanitizeId(terminalId);
    const session = this.sessions.get(id);
    if (!session) return { success: true, alreadyClosed: true };
    try {
      session.pty.kill();
    } catch {}
    this.sessions.delete(id);
    return { success: true };
  }

  disposeBySender(sender) {
    if (!sender) return;
    for (const [id, session] of this.sessions.entries()) {
      if (session.sender === sender) {
        try {
          session.pty.kill();
        } catch {}
        this.sessions.delete(id);
      }
    }
  }

  disposeAll() {
    for (const session of this.sessions.values()) {
      try {
        session.pty.kill();
      } catch {}
    }
    this.sessions.clear();
  }
}

const terminalPtyService = new TerminalPtyService();

module.exports = {
  terminalPtyService,
  MAX_SESSIONS,
};
