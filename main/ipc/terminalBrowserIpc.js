const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { ipcMain } = require("electron");
const {
  safeHandler,
  asyncPathExists,
  asyncStatSafe,
  getTerminalPtyService,
  getBrowserAutomationService,
  getPathResolver,
  getSandboxPolicyService,
} = require("../shared");

function registerTerminalBrowserIpc() {
  const activeTerminalProcs = new Map();

  ipcMain.handle(
    "terminal-kill-command",
    safeHandler((event, cmdId) => {
      const proc = activeTerminalProcs.get(cmdId);
      if (proc && proc.pid) {
        try {
          if (process.platform !== "win32") {
            process.kill(-proc.pid, "SIGKILL");
          } else {
            proc.kill("SIGKILL");
          }
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
        activeTerminalProcs.delete(cmdId);
        return { success: true };
      }
      return { success: false };
    })
  );

  ipcMain.handle(
    "terminal-create",
    safeHandler((event, params = {}) => {
      const terminalPtyService = getTerminalPtyService();
      const result = terminalPtyService.create(params);
      if (result.success) {
        terminalPtyService.bindSender(result.terminalId, event.sender);
      }
      return result;
    })
  );

  ipcMain.on("terminal-input", (event, { terminalId, data } = {}) => {
    getTerminalPtyService().write(terminalId, data);
  });

  ipcMain.handle(
    "terminal-resize",
    safeHandler((event, { terminalId, cols, rows } = {}) =>
      getTerminalPtyService().resize(terminalId, cols, rows)
    )
  );

  ipcMain.handle(
    "terminal-dispose",
    safeHandler((event, terminalId) => getTerminalPtyService().dispose(terminalId))
  );

  ipcMain.handle(
    "terminal-run-command",
    safeHandler(async (event, { cmdId, command, cwd, workDir }) => {
      const { DEFAULT_ROOT } = getPathResolver();
      const { buildSanitizedShellEnv } = getSandboxPolicyService();
      const rawCmd = String(command || "").trim();
      const baseCwd =
        cwd && (await asyncPathExists(cwd))
          ? path.resolve(cwd)
          : workDir && (await asyncPathExists(workDir))
          ? path.resolve(workDir)
          : DEFAULT_ROOT;

      if (!rawCmd) {
        return { success: true, exitCode: 0, stdout: "", stderr: "", cwd: baseCwd };
      }

      const cdMatch = rawCmd.match(/^cd(?:\s+(.+))?$/);
      if (cdMatch) {
        const targetRaw = (cdMatch[1] || "").trim().replace(/^["']|["']$/g, "");
        const nextDir =
          !targetRaw || targetRaw === "~"
            ? os.homedir()
            : targetRaw.startsWith("~/")
            ? path.join(os.homedir(), targetRaw.slice(2))
            : path.resolve(baseCwd, targetRaw);
        const nextStat = await asyncStatSafe(nextDir);
        if (nextStat && nextStat.isDirectory()) {
          return {
            success: true,
            exitCode: 0,
            stdout: `已切换工作目录至: ${nextDir}\n`,
            stderr: "",
            cwd: nextDir,
          };
        }
        return {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: `cd: 目录不存在: ${targetRaw}\n`,
          cwd: baseCwd,
        };
      }

      const id = cmdId || `term_${Date.now()}`;
      const userShell = process.env.SHELL || "/bin/zsh";
      const env = buildSanitizedShellEnv(process.env, { stripSecrets: false });

      return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;

        let child;
        try {
          child = spawn(userShell, ["-c", rawCmd], {
            cwd: baseCwd,
            env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err) {
          return resolve({
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: err.message || String(err),
            cwd: baseCwd,
          });
        }

        activeTerminalProcs.set(id, child);

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          activeTerminalProcs.delete(id);
          resolve(payload);
        };

        const timer = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
          finish({
            success: false,
            exitCode: -1,
            stdout,
            stderr: `${stderr}\n[终端命令执行超过 120s 已自动终止]`,
            cwd: baseCwd,
          });
        }, 120000);

        child.stdout?.on("data", (chunk) => {
          const text = chunk.toString("utf-8");
          if (stdout.length < 200000) stdout += text;
          try {
            event.sender.send(`terminal-stream-${id}`, { type: "stdout", data: text });
          } catch {}
        });

        child.stderr?.on("data", (chunk) => {
          const text = chunk.toString("utf-8");
          if (stderr.length < 100000) stderr += text;
          try {
            event.sender.send(`terminal-stream-${id}`, { type: "stderr", data: text });
          } catch {}
        });

        child.on("error", (err) => {
          finish({
            success: false,
            exitCode: -1,
            stdout,
            stderr: `${stderr}\n${err.message}`,
            cwd: baseCwd,
          });
        });

        child.on("close", (code, signal) => {
          const exitCode = typeof code === "number" ? code : signal ? -1 : 0;
          finish({
            success: exitCode === 0,
            exitCode,
            stdout,
            stderr,
            cwd: baseCwd,
          });
        });
      });
    })
  );

  ipcMain.handle(
    "browser-auto-open",
    safeHandler((event, { url, workDir } = {}) =>
      getBrowserAutomationService().open({ url, workDir })
    )
  );
  ipcMain.handle(
    "browser-auto-inspect",
    safeHandler((event, payload = {}) => getBrowserAutomationService().inspect(payload))
  );
  ipcMain.handle(
    "browser-auto-interact",
    safeHandler((event, payload = {}) => getBrowserAutomationService().interact(payload))
  );
  ipcMain.handle(
    "browser-auto-snapshot",
    safeHandler((event, payload = {}) => getBrowserAutomationService().snapshot(payload))
  );
  ipcMain.handle(
    "browser-auto-logs",
    safeHandler((event, payload = {}) => getBrowserAutomationService().getLogs(payload))
  );
  ipcMain.handle(
    "browser-auto-stop",
    safeHandler(() => getBrowserAutomationService().stopAutomation())
  );
  ipcMain.handle(
    "browser-auto-save-baseline",
    safeHandler((event, payload = {}) => getBrowserAutomationService().saveBaseline(payload))
  );
  ipcMain.handle(
    "browser-auto-state",
    safeHandler(() => getBrowserAutomationService().getState())
  );
  ipcMain.handle(
    "browser-auto-back",
    safeHandler(() => getBrowserAutomationService().back())
  );
  ipcMain.handle(
    "browser-auto-forward",
    safeHandler(() => getBrowserAutomationService().forward())
  );
  ipcMain.handle(
    "browser-auto-reload",
    safeHandler((event, payload = {}) => getBrowserAutomationService().reload(payload))
  );
  ipcMain.handle(
    "browser-auto-close",
    safeHandler(() => getBrowserAutomationService().close())
  );
}

module.exports = { registerTerminalBrowserIpc };
