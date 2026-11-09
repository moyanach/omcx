/**
 * updaterService.js — 现代桌面客户端自动更新服务 (基于 electron-updater)
 *
 * 核心能力：
 * 1. 自动与手动检查 GitHub Releases 最新版本元数据 (latest-mac.yml)
 * 2. 支持流式下载进度实时回传 (百分比、速度、字节数)
 * 3. 下载完成后支持 quitAndInstall() 一键重启静默替换
 * 4. 内置无证书签名与网络异常优雅降级 (支持一键直达 GitHub Release 下载页)
 */

const { autoUpdater } = require("electron-updater");
const { ipcMain, app, shell } = require("electron");

const GITHUB_REPO_URL = "https://github.com/moyanach/omcx/releases";

let isInitialized = false;
let updateDownloadedInfo = null;

function initAutoUpdater(mainWindow) {
  if (isInitialized) return;
  isInitialized = true;

  // 配置更新行为
  autoUpdater.autoDownload = false; // 建议由用户在界面上明确触发下载或查看变更后再下载
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  // 日志记录
  autoUpdater.logger = console;

  // 1. 开始检查更新
  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] 正在检查远端更新元数据...");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-checking");
    }
  });

  // 2. 发现新版本可用
  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] 发现可用新版本: v${info.version}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-available", {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
        releaseUrl: `${GITHUB_REPO_URL}/tag/v${info.version}`,
      });
    }
  });

  // 3. 当前已是最新版本
  autoUpdater.on("update-not-available", (info) => {
    console.log(`[updater] 当前已是最新版本 (v${info.version || app.getVersion()})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-not-available", {
        version: info.version || app.getVersion(),
      });
    }
  });

  // 4. 下载进度实时推送 (0% ~ 100%)
  autoUpdater.on("download-progress", (progressObj) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-download-progress", {
        percent: Math.min(100, Math.floor(progressObj.percent || 0)),
        bytesPerSecond: progressObj.bytesPerSecond || 0,
        transferred: progressObj.transferred || 0,
        total: progressObj.total || 0,
      });
    }
  });

  // 5. 新版本安装包已下载完成并校验成功
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] 新版本 v${info.version} 下载校验完成，已就绪重启替换`);
    updateDownloadedInfo = info;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-downloaded", {
        version: info.version,
        releaseDate: info.releaseDate,
      });
    }
  });

  // 6. 异常捕获
  autoUpdater.on("error", (err) => {
    console.error("[updater] 检查/下载更新失败:", err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-error", {
        message: err.message,
        fallbackUrl: GITHUB_REPO_URL,
      });
    }
  });

  // ─── IPC 处理通道 ───────────────────────────────────────
  // 获取当前客户端版本
  ipcMain.handle("get-app-version", () => {
    return app.getVersion();
  });

  // 手动触发检查更新
  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, updateInfo: result?.updateInfo };
    } catch (err) {
      console.error("[updater] checkForUpdates 异常:", err.message);
      return {
        success: false,
        error: err.message,
        fallbackUrl: GITHUB_REPO_URL,
      };
    }
  });

  // 开始下载更新
  ipcMain.handle("start-download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      console.error("[updater] startDownloadUpdate 异常:", err.message);
      return { success: false, error: err.message };
    }
  });

  // 立即退出并重启安装
  ipcMain.handle("quit-and-install-update", () => {
    try {
      // isSilent: false (显示原生进度或直接拉起), isForceRunAfter: true (退出后强制启动新版本)
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (err) {
      console.error("[updater] quitAndInstall 异常:", err.message);
      // 若因签名问题失败，引导打开下载页面
      shell.openExternal(GITHUB_REPO_URL);
      return { success: false, error: err.message };
    }
  });

  // 浏览器直达发布页面
  ipcMain.handle("open-release-page", (event, targetUrl) => {
    const url = targetUrl || GITHUB_REPO_URL;
    shell.openExternal(url);
    return true;
  });

  // 启动 6 秒后在后台静默发起一次更新检查（不阻塞主窗口渲染）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log("[updater] 后台静默检查跳过:", err.message);
    });
  }, 6000);
}

module.exports = { initAutoUpdater };
