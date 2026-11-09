/**
 * updaterService.js — 现代桌面客户端自动更新服务 (基于 electron-updater)
 *
 * 核心策略：
 * 1. 启动阶段最多尝试 3 次渐进式检测，成功即停，之后彻底静默，绝不持续后台轮询。
 * 2. 开启 forceDevUpdateConfig，支持开发模式与生产模式统一检测。
 * 3. 具备 GitHub Releases API 双通道直连比对兜底，确保每次检查 100% 触发反馈，绝不悬挂一直 loading。
 * 4. 支持流式下载进度实时回传与无缝重启升级 (quitAndInstall)。
 */

const { autoUpdater } = require("electron-updater");
const { ipcMain, app, shell } = require("electron");

const GITHUB_REPO_URL = "https://github.com/moyanach/omcx/releases";
const GITHUB_API_LATEST = "https://api.github.com/repos/moyanach/omcx/releases/latest";

let isInitialized = false;
let updateDownloadedInfo = null;

// 启动检测控制：最多 3 次，任意一次成功后立即销毁定时器，不再做任何周期性轮询
const STARTUP_DELAYS = [4000, 15000, 45000];
let startupCheckIndex = 0;
let startupTimer = null;
let hasSucceededStartupCheck = false;

function cleanVersion(v) {
  return String(v || "").replace(/^[vV]/, "").trim();
}

/**
 * 语义化版本比对：若 remote > local 返回 true
 */
function isNewerVersion(remote, local) {
  const rParts = cleanVersion(remote).split(".").map((n) => parseInt(n, 10) || 0);
  const lParts = cleanVersion(local).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(rParts.length, lParts.length); i++) {
    const r = rParts[i] || 0;
    const l = lParts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

function initAutoUpdater(mainWindow) {
  if (isInitialized) return;
  isInitialized = true;

  // 配置更新行为
  autoUpdater.autoDownload = false; // 由用户查看更新日志后手动触发下载，更轻量受控
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.forceDevUpdateConfig = true; // 允许开发调试阶段正常读取 dev-app-update.yml 检查更新

  autoUpdater.logger = console;

  let eventHandled = false;

  // 1. 开始检查更新
  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] 正在检查远端更新元数据...");
    eventHandled = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-checking");
    }
  });

  // 2. 发现新版本可用
  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] 发现可用新版本: v${info.version}`);
    eventHandled = true;
    hasSucceededStartupCheck = true;
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
    eventHandled = true;
    hasSucceededStartupCheck = true;
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
    console.error("[updater] autoUpdater 报错:", err.message);
    // 这里不直接向前端抛出，留给 performUnifiedCheck 处理双通道降级
  });

  /**
   * 双通道检测实现：
   * 优先通过 autoUpdater 检查，若因未打包等原因跳过或未产生事件，
   * 自动通过 GitHub 官方 REST API 直连比对，确保前端必定收到明确响应，绝不挂起。
   */
  async function performUnifiedCheck(isManual = false) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-checking");
    }

    eventHandled = false;
    let updaterResult = null;

    try {
      updaterResult = await autoUpdater.checkForUpdates();
    } catch (e) {
      console.warn("[updater] autoUpdater 检查跳过或异常:", e.message);
    }

    // 若 autoUpdater 成功派发了事件，直接完成
    if (eventHandled) {
      return { success: true };
    }

    // 双通道降级：通过 GitHub Releases API 直连比对
    try {
      console.log("[updater] 启动 GitHub Releases API 双通道直连比对...");
      const currentVersion = app.getVersion();
      const response = await fetch(GITHUB_API_LATEST, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": `OMCX-Desktop/${currentVersion}`,
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!response.ok) {
        throw new Error(`GitHub 响应 HTTP ${response.status}`);
      }

      const releaseData = await response.json();
      const remoteTag = releaseData.tag_name || releaseData.name || "";
      const hasNewer = isNewerVersion(remoteTag, currentVersion);

      if (hasNewer) {
        console.log(`[updater:fallback] 比对发现新版本: ${remoteTag} (当前: v${currentVersion})`);
        hasSucceededStartupCheck = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("update-available", {
            version: cleanVersion(remoteTag),
            releaseDate: releaseData.published_at,
            releaseNotes: releaseData.body,
            releaseUrl: releaseData.html_url || `${GITHUB_REPO_URL}/tag/${remoteTag}`,
          });
        }
      } else {
        console.log(`[updater:fallback] 比对确认当前已是最新版 (v${currentVersion})`);
        hasSucceededStartupCheck = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("update-not-available", {
            version: currentVersion,
          });
        }
      }
      return { success: true };
    } catch (apiErr) {
      console.error("[updater:fallback] GitHub API 直连检测失败:", apiErr.message);
      if (isManual && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-error", {
          message: `检查更新失败 (${apiErr.message})，请检查网络或代理连接`,
          fallbackUrl: GITHUB_REPO_URL,
        });
      }
      return { success: false, error: apiErr.message };
    }
  }

  // ─── IPC 处理通道 ───────────────────────────────────────
  ipcMain.handle("get-app-version", () => {
    return app.getVersion();
  });

  // 手动触发检查更新 (用户在设置面板主动点击)
  ipcMain.handle("check-for-updates", async () => {
    return await performUnifiedCheck(true);
  });

  // 开始下载更新
  ipcMain.handle("start-download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      console.error("[updater] startDownloadUpdate 异常:", err.message);
      // 降级引导至 GitHub Releases 下载页面
      shell.openExternal(GITHUB_REPO_URL);
      return { success: false, error: err.message };
    }
  });

  // 立即退出并重启安装
  ipcMain.handle("quit-and-install-update", () => {
    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (err) {
      console.error("[updater] quitAndInstall 异常:", err.message);
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

  // ─── 启动检测生命周期策略：开机后仅尝试最多 3 次，成功即停，之后彻底静默 ───
  function scheduleNextStartupCheck() {
    if (hasSucceededStartupCheck || startupCheckIndex >= STARTUP_DELAYS.length) {
      console.log("[updater] 启动阶段自动检测任务已完成或达到3次上限，停止定时尝试，之后仅响应用户手动检查。");
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      return;
    }

    const delay = STARTUP_DELAYS[startupCheckIndex];
    startupCheckIndex += 1;
    startupTimer = setTimeout(async () => {
      console.log(`[updater] 触发启动自动更新检测 (${startupCheckIndex}/3)...`);
      const res = await performUnifiedCheck(false);
      if (res && res.success) {
        hasSucceededStartupCheck = true;
        console.log("[updater] 启动自动检测已确认，停止后续启动检测定时器。");
        return;
      }
      scheduleNextStartupCheck();
    }, delay);
  }

  // 开启启动检测
  scheduleNextStartupCheck();
}

module.exports = { initAutoUpdater };
