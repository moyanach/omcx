const path = require("path");
const { app, BrowserWindow, shell } = require("electron");
const {
  MODULES,
  getLoadedModule,
  getStorageService,
  getUpdaterService,
  setMainWindow,
  getMainWindow,
  flushActiveRunsAndStorageOnExit,
  notifyMainProcessError,
  isSafeExternalUrl,
} = require("./main/shared");
const {
  INTERNAL_APP_URL_PREFIX,
  registerPrivilegedSchemes,
  registerProtocols,
} = require("./main/protocol");
const { registerSessionIpc } = require("./main/ipc/sessionIpc");
const { registerMcpSkillsIpc } = require("./main/ipc/mcpSkillsIpc");
const { registerGitIpc } = require("./main/ipc/gitIpc");
const { registerFsIpc } = require("./main/ipc/fsIpc");
const { registerTerminalBrowserIpc } = require("./main/ipc/terminalBrowserIpc");
const { registerAgentRunner } = require("./main/agentRunner");

// 全局未捕获异常与未处理 Rejection 兜底：记录堆栈、落盘中断快照并通知渲染进程
process.on("uncaughtException", (err, origin) => {
  console.error(`[main] 未捕获异常 (${origin || "uncaughtException"}):`, err?.stack || err);
  flushActiveRunsAndStorageOnExit();
  notifyMainProcessError(err, origin || "uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] 未处理的 Promise 拒绝:", reason?.stack || reason);
});

// 注册特权协议 (必须在 app.whenReady() 之前调用)
registerPrivilegedSchemes();

function createWindow() {
  const win = new BrowserWindow({
    title: "OMCX Desktop",
    width: 1400,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#111111",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  setMainWindow(win);

  win.loadURL("app://dist/index.html");

  win.webContents.on("console-message", (event, level, message, line, sourceId) => {
    console.log(`[Renderer Log] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main did-fail-load] code: ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`);
  });

  const guardNavigation = (event, url) => {
    const target = String(url || "");
    if (target.startsWith(INTERNAL_APP_URL_PREFIX)) return;
    event.preventDefault();
    if (isSafeExternalUrl(target)) {
      shell.openExternal(target);
    }
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const windowWebContents = win.webContents;
  windowWebContents.on("destroyed", () => {
    getLoadedModule(MODULES.terminalPtyService)?.terminalPtyService?.disposeBySender(windowWebContents);
  });

  win.on("closed", () => {
    if (getMainWindow() === win) {
      setMainWindow(null);
    }
  });

  return win;
}

app.whenReady().then(() => {
  // 初始化存储环境并注册协议、领域 IPC 与 Agent 执行循环
  getStorageService().initStorage();
  registerProtocols();
  registerSessionIpc();
  registerMcpSkillsIpc();
  registerGitIpc();
  registerFsIpc();
  registerTerminalBrowserIpc();
  registerAgentRunner();

  const win = createWindow();
  getUpdaterService().initAutoUpdater(win);
});

app.on("before-quit", () => {
  flushActiveRunsAndStorageOnExit();
  try {
    getLoadedModule(MODULES.terminalPtyService)?.terminalPtyService?.disposeAll();
  } catch (err) {
    console.warn("[before-quit] 关闭 PTY 终端异常（已忽略）:", err.message);
  }
  try {
    getLoadedModule(MODULES.mcpClientService)?.mcpClientService?.closeAll();
  } catch (err) {
    console.warn("[before-quit] 关闭 MCP 客户端异常（已忽略，不阻断退出）:", err.message);
  }
  try {
    getLoadedModule(MODULES.browserAutomationService)?.close();
  } catch (err) {
    console.warn("[before-quit] 关闭自动化浏览器异常（已忽略）:", err.message);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
