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
const { ipcMain, app, shell, dialog, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

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

// 应用是否已进入退出流程（由 before-quit 置位，用于看门狗判定）
let isQuitInProgress = false;

/**
 * 定位 electron-updater 已下载并校验完成的待安装包（macOS 缓存目录）
 */
function findPendingUpdatePackage() {
  try {
    const cacheDir = app.getPath("cache");
    const candidates = [
      path.join(cacheDir, `${app.getName()}-updater`, "pending"),
      path.join(cacheDir, "omcx-desktop-updater", "pending"),
      path.join(cacheDir, "OMCX-updater", "pending"),
    ];
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      const files = fs
        .readdirSync(dir)
        .filter((f) => /\.(zip|dmg)$/i.test(f))
        .map((f) => {
          const full = path.join(dir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) return files[0].full;
    }
  } catch (err) {
    console.warn("[updater] 定位已下载安装包失败:", err.message);
  }
  return null;
}

function initAutoUpdater(mainWindow) {
  if (isInitialized) return;
  isInitialized = true;

  // 窗口可能在运行期被关闭重建（或主窗口被销毁后新建），因此事件发送时再解析目标窗口，
  // 不能把初始化瞬间的窗口实例永久绑定在闭包里。
  let fallbackWindow = mainWindow || null;
  const getTargetWindow = () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return focused;
    if (fallbackWindow && !fallbackWindow.isDestroyed()) return fallbackWindow;
    const all = BrowserWindow.getAllWindows().filter((win) => win && !win.isDestroyed());
    return all[0] || null;
  };
  const sendUpdateEvent = (channel, payload) => {
    const target = getTargetWindow();
    if (!target) return;
    try {
      target.webContents.send(channel, payload);
    } catch (err) {
      console.warn(`[updater] 推送 ${channel} 失败:`, err.message);
    }
  };

  // 配置更新行为
  autoUpdater.autoDownload = false; // 由用户查看更新日志后手动触发下载，更轻量受控
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.forceDevUpdateConfig = true; // 允许开发调试阶段正常读取 dev-app-update.yml 检查更新

  autoUpdater.logger = {
    info: (msg) => console.log(`[updater] ${String(msg || "").split("\n")[0].slice(0, 100)}`),
    warn: (msg) => console.warn(`[updater] ${String(msg || "").split("\n")[0].slice(0, 100)}`),
    error: (msg) => {
      const clean = String(msg || "").includes("504")
        ? "远端网关响应超时 (504)，稍后重试"
        : String(msg || "").split("\n")[0].slice(0, 100);
      console.warn(`[updater] ${clean}`);
    },
  };

  // 记录退出流程，供安装看门狗判定
  app.on("before-quit", () => {
    isQuitInProgress = true;
  });

  let eventHandled = false;

  // 1. 开始检查更新
  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] 正在检查远端更新元数据...");
    eventHandled = false;
    sendUpdateEvent("update-checking");
  });

  // 2. 发现新版本可用
  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] 发现可用新版本: v${info.version}`);
    eventHandled = true;
    hasSucceededStartupCheck = true;
    sendUpdateEvent("update-available", {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
      releaseUrl: `${GITHUB_REPO_URL}/tag/v${info.version}`,
    });
  });

  // 3. 当前已是最新版本
  autoUpdater.on("update-not-available", (info) => {
    console.log(`[updater] 当前已是最新版本 (v${info.version || app.getVersion()})`);
    eventHandled = true;
    hasSucceededStartupCheck = true;
    sendUpdateEvent("update-not-available", {
      version: info.version || app.getVersion(),
    });
  });

  // 4. 下载进度实时推送 (0% ~ 100%)
  autoUpdater.on("download-progress", (progressObj) => {
    sendUpdateEvent("update-download-progress", {
      percent: Math.min(100, Math.floor(progressObj.percent || 0)),
      bytesPerSecond: progressObj.bytesPerSecond || 0,
      transferred: progressObj.transferred || 0,
      total: progressObj.total || 0,
    });
  });

  // 5. 新版本安装包已下载完成并校验成功
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] 新版本 v${info.version} 下载校验完成，已就绪重启替换`);
    updateDownloadedInfo = info;
    sendUpdateEvent("update-downloaded", {
      version: info.version,
      releaseDate: info.releaseDate,
    });
  });

  // 6. 异常捕获 (轻量化清洗输出，避免打印大段 HTML 504 错误页堆栈)
  autoUpdater.on("error", (err) => {
    const rawMsg = String(err?.message || "");
    const cleanMsg = rawMsg.includes("504")
      ? "远端网络连接超时 (504 Gateway Timeout)"
      : rawMsg.includes("403")
      ? "GitHub 访问频次限制 (403 Rate Limit)"
      : rawMsg.split("\n")[0].slice(0, 100);
    console.warn(`[updater] 检测更新遇网络波动: ${cleanMsg}`);
  });

  /**
   * 双通道检测实现：
   * 优先通过 autoUpdater 检查，若因未打包等原因跳过或未产生事件，
   * 自动通过 GitHub 官方 REST API 直连比对，确保前端必定收到明确响应，绝不挂起。
   */
  async function performUnifiedCheck(isManual = false) {
    sendUpdateEvent("update-checking");

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
        sendUpdateEvent("update-available", {
          version: cleanVersion(remoteTag),
          releaseDate: releaseData.published_at,
          releaseNotes: releaseData.body,
          releaseUrl: releaseData.html_url || `${GITHUB_REPO_URL}/tag/${remoteTag}`,
        });
      } else {
        console.log(`[updater:fallback] 比对确认当前已是最新版 (v${currentVersion})`);
        hasSucceededStartupCheck = true;
        sendUpdateEvent("update-not-available", {
          version: currentVersion,
        });
      }
      return { success: true };
    } catch (apiErr) {
      console.error("[updater:fallback] GitHub API 直连检测失败:", apiErr.message);
      if (isManual) {
        sendUpdateEvent("update-error", {
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

  // 立即退出并重启安装（带诊断日志 + 1.5s 看门狗兜底，确保点击必有结果）
  ipcMain.handle("quit-and-install-update", () => {
    const pendingPackage = findPendingUpdatePackage();
    console.log("[updater] quitAndInstall 触发诊断:", {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appVersion: app.getVersion(),
      downloadedVersion: updateDownloadedInfo?.version || null,
      pendingPackage,
    });

    let installFlowStarted = false;
    try {
      autoUpdater.once("before-quit-for-update", () => {
        installFlowStarted = true;
        console.log("[updater] 已触发 before-quit-for-update，ShipIt 安装流程已启动");
      });
    } catch (e) {
      // 忽略事件绑定异常
    }

    try {
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.quitAndInstall(false, true);
      console.log("[updater] quitAndInstall() 调用完成，等待进程退出...");
    } catch (err) {
      console.warn("[updater] quitAndInstall() 抛出异常:", err.message);
    }

    // 看门狗：1.5 秒后若应用仍未退出，判定 ShipIt 静默失败（多见于未签名构建），立即给出确定性兜底
    setTimeout(() => {
      if (isQuitInProgress) {
        console.log("[updater] 应用已进入退出流程，安装交由系统守护进程执行");
        return;
      }

      console.warn(
        `[updater] 1.5s 内应用未退出 (installFlowStarted=${installFlowStarted})，判定系统级静默替换被阻断，启用兜底方案`
      );

      if (pendingPackage) {
        try {
          shell.showItemInFolder(pendingPackage);
        } catch (e) {
          // 忽略定位失败
        }
      }

      const detail =
        "当前构建未配置 Apple Developer ID 签名，macOS 系统守护进程无法静默替换应用（ShipIt 被系统拦截）。\n\n" +
        (pendingPackage
          ? `已为您在访达中定位新版安装包：\n${pendingPackage}\n\n请将 OMCX 拖入「应用程序」文件夹覆盖旧版本后重新打开。`
          : "未在更新缓存中找到安装包，可前往 GitHub Releases 手动下载最新版本。");

      const boxOptions = {
        type: "info",
        title: "更新已下载完成",
        message: `新版本 v${updateDownloadedInfo?.version || ""} 已就绪`,
        detail,
        buttons: ["退出应用以完成安装", "稍后自行处理"],
        defaultId: 0,
        cancelId: 1,
      };

      const dialogParent = getTargetWindow();
      const dialogPromise = dialogParent
        ? dialog.showMessageBox(dialogParent, boxOptions)
        : dialog.showMessageBox(boxOptions);

      dialogPromise
        .then(({ response }) => {
          if (response === 0) {
            console.log("[updater] 用户确认退出应用以完成手动覆盖安装");
            app.exit(0);
          }
        })
        .catch(() => {});
    }, 1500);

    return { success: true, pendingPackage: !!pendingPackage };
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
