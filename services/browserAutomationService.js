/**
 * browserAutomationService — 内置浏览器自动化（Electron 隐藏窗口 + CDP）
 *
 * 能力：
 *  - open(url)                 打开 http/https 页面
 *  - interact({action,...})    click / fill / press / hover / scroll / wait_for
 *  - snapshot({fullPage,live,...}) CDP 全页/视口截图，支持基线视觉回归对比与低清实时预览
 *  - reload() / state() / close()
 *
 * 安全约束：
 *  - 仅允许 http/https，拒绝 file/javascript/data 等协议
 *  - 自动化窗口禁用 nodeIntegration / preload，开启 contextIsolation + sandbox
 *  - 禁止 window.open 弹出新窗口与全部权限请求
 *
 * 产物目录：默认随项目落盘到 <workDir>/.omcx/browser-shots/，可通过
 * artifact_scope_browser_shots=global 回退到 <OMCX_HOME>/browser-shots/。
 */

const fs = require("fs");
const path = require("path");
const { BrowserWindow, nativeImage } = require("electron");
const projectArtifactService = require("./projectArtifactService");

const KIND = projectArtifactService.KIND.BROWSER_SHOTS;
const NAV_TIMEOUT_MS = 30000;
const MAX_TEXT_CHARS = 6000;

// 当前绑定的工作目录：由 open() 或显式 setWorkDir() 设定，决定截图落盘位置
let activeWorkDir = null;

function setWorkDir(workDir) {
  const normalized = projectArtifactService.normalizeWorkDir(workDir);
  if (normalized) activeWorkDir = normalized;
  return activeWorkDir;
}

function shotsDir() {
  const target = projectArtifactService.resolveDir(KIND, activeWorkDir);
  return target.dir || projectArtifactService.globalDir(KIND, activeWorkDir);
}

function baselinesDir() {
  return path.join(shotsDir(), "baselines");
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  if (projectArtifactService.isProjectArtifact(activeWorkDir, dir)) {
    projectArtifactService.ensureGitignore(activeWorkDir);
  }
}

let win = null;
let lastShotPath = "";
let lastError = "";
let lastActionAt = 0;
// 导航进行中标记：供前端在页面尚未完成加载时显示进度，而不是误判为“未启动”
let navigating = false;

function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("URL 不能为空");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`无法解析 URL: ${input}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("浏览器自动化仅支持 http/https 地址");
  }
  return parsed.toString();
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: undefined,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  } catch {}
  win.on("closed", () => {
    win = null;
  });
  return win;
}

async function waitForLoad(wc, timeoutMs = NAV_TIMEOUT_MS) {
  // 注意：必须在 loadURL 之前调用，否则可能错过 did-finish-load 事件（loadURL 本身已等到加载完成）
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ timedOut: true });
    }, timeoutMs);
    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ timedOut: false });
    };
    const onFail = (_e, code, desc) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ timedOut: false, failed: true, code, desc });
    };
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
    };
    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * 等待页面进入可截图状态：readyState complete + 字体就绪 + 两帧渲染，
 * 再叠加一个可配置的 settle 窗口，避免 SPA 首屏 loading 被提前截下来。
 */
async function waitForReady(wc, settleMs = 600) {
  try {
    await wc.executeJavaScript(
      `(async () => {
        if (document.readyState !== "complete") {
          await new Promise((resolve) => {
            const done = () => resolve();
            document.addEventListener("readystatechange", () => {
              if (document.readyState === "complete") done();
            }, { once: true });
            setTimeout(done, 5000);
          });
        }
        try { await document.fonts?.ready; } catch {}
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        return document.readyState;
      })()`,
      true
    );
  } catch {}
  const settle = Math.max(0, Math.min(10000, Number(settleMs) || 0));
  if (settle > 0) await sleep(settle);
}

async function readPageInfo(wc) {
  try {
    const info = await wc.executeJavaScript(
      `(() => {
        const text = (document.body && document.body.innerText) || "";
        return {
          url: location.href,
          title: document.title || "",
          text: text.slice(0, ${MAX_TEXT_CHARS}),
        };
      })()`,
      true
    );
    return {
      url: info?.url || wc.getURL(),
      title: info?.title || "",
      text: info?.text || "",
    };
  } catch (err) {
    return { url: wc.getURL(), title: "", text: "", error: err.message };
  }
}

async function open({ url, workDir, settleMs = 600 } = {}) {
  const target = normalizeUrl(url);
  if (workDir) setWorkDir(workDir);
  const browser = ensureWindow();
  const wc = browser.webContents;
  lastError = "";
  let timedOut = false;
  let navTimer = null;
  navigating = true;
  try {
    const loaded = waitForLoad(wc);
    // loadURL 本身可能因页面请求挂起而永不返回，必须叠加硬超时并主动 stop 兜底
    const navTimeout = new Promise((_, reject) => {
      navTimer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`页面加载超过 ${Math.round(NAV_TIMEOUT_MS / 1000)}s`));
      }, NAV_TIMEOUT_MS);
    });
    try {
      await Promise.race([wc.loadURL(target), navTimeout]);
    } finally {
      if (navTimer) clearTimeout(navTimer);
    }
    const loadState = await loaded;
    await waitForReady(wc, settleMs);
    lastActionAt = Date.now();
    const info = await readPageInfo(wc);
    if (loadState?.failed) {
      lastError = `页面加载失败 (${loadState.code}): ${loadState.desc || ""}`.trim();
    } else if (loadState?.timedOut) {
      lastError = `页面加载超过 ${Math.round(NAV_TIMEOUT_MS / 1000)}s，已返回当前可交互内容`;
    }
    return { ok: true, ...info, warning: lastError || undefined };
  } catch (err) {
    // 中断仍在进行的导航，避免后台继续占用加载队列
    try {
      wc.stop();
    } catch {}
    lastError = err?.message || String(err);
    if (timedOut) {
      // 超时不等于完全失败：尽量返回当前已经渲染出的内容，供用户继续操作/截图
      const info = await readPageInfo(wc).catch(() => ({ url: target, title: "", text: "" }));
      return { ok: true, ...info, warning: lastError, timedOut: true };
    }
    return { ok: false, error: lastError, url: target };
  } finally {
    navigating = false;
  }
}

function buildInteractScript(action, selector, payload) {
  const sel = JSON.stringify(selector || "");
  const text = JSON.stringify(payload?.text ?? "");
  const key = JSON.stringify(payload?.key ?? "Enter");
  const amount = Number(payload?.amount) || 600;
  switch (action) {
    case "click":
      return `(() => {
        const el = document.querySelector(${sel});
        if (!el) return { ok: false, error: "未找到元素: " + ${sel} };
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return { ok: true, tag: el.tagName };
      })()`;
    case "fill":
      return `(() => {
        const el = document.querySelector(${sel});
        if (!el) return { ok: false, error: "未找到元素: " + ${sel} };
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, ${text});
        else el.value = ${text};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, tag: el.tagName, value: el.value };
      })()`;
    case "press":
      return `(() => {
        const el = (${sel} && document.querySelector(${sel})) || document.activeElement || document.body;
        if (!el) return { ok: false, error: "无可聚焦元素" };
        el.focus?.();
        const opts = { key: ${key}, code: ${key}, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
        if (${key} === "Enter" && el.form && typeof el.form.requestSubmit === "function") {
          try { el.form.requestSubmit(); } catch (e) {}
        }
        return { ok: true, key: ${key} };
      })()`;
    case "hover":
      return `(() => {
        const el = document.querySelector(${sel});
        if (!el) return { ok: false, error: "未找到元素: " + ${sel} };
        el.scrollIntoView({ block: "center" });
        for (const type of ["mouseover", "mouseenter", "mousemove"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        }
        return { ok: true };
      })()`;
    case "scroll":
      return `(() => {
        const el = (${sel} && document.querySelector(${sel})) || null;
        if (el) el.scrollBy(0, ${amount});
        else window.scrollBy(0, ${amount});
        return { ok: true, y: window.scrollY };
      })()`;
    default:
      return null;
  }
}

async function interact({ action, selector = "", text = "", key = "Enter", amount = 600, timeout_ms = 8000 } = {}) {
  const browser = ensureWindow();
  const wc = browser.webContents;
  const act = String(action || "").toLowerCase();
  lastError = "";

  try {
    if (act === "wait_for") {
      if (!selector) return { ok: false, error: "wait_for 需要 selector" };
      const deadline = Date.now() + Math.min(60000, Math.max(500, Number(timeout_ms) || 8000));
      const selLiteral = JSON.stringify(selector);
      while (Date.now() < deadline) {
        const found = await wc.executeJavaScript(
          `!!document.querySelector(${selLiteral})`,
          true
        );
        if (found) {
          lastActionAt = Date.now();
          return { ok: true, ...(await readPageInfo(wc)) };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return { ok: false, error: `等待元素超时: ${selector}` };
    }

    const script = buildInteractScript(act, selector, { text, key, amount });
    if (!script) {
      return { ok: false, error: `不支持的动作: ${action}` };
    }
    const result = await wc.executeJavaScript(script, true);
    await new Promise((r) => setTimeout(r, 250));
    lastActionAt = Date.now();
    const info = await readPageInfo(wc);
    return { ok: Boolean(result?.ok), action: act, detail: result, ...info };
  } catch (err) {
    lastError = err.message || String(err);
    return { ok: false, error: lastError };
  }
}

function safeBaselineName(name) {
  return String(name || "default")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80) || "default";
}

async function captureImage({ fullPage = false, format = "png", quality = 60 } = {}) {
  const browser = ensureWindow();
  const wc = browser.webContents;
  const useJpeg = format === "jpeg";
  const jpegQuality = Math.max(10, Math.min(90, Number(quality) || 60));
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const params = {
      format: useJpeg ? "jpeg" : "png",
      captureBeyondViewport: Boolean(fullPage),
    };
    if (useJpeg) params.quality = jpegQuality;
    if (fullPage) {
      const metrics = await wc.debugger.sendCommand("Page.getLayoutMetrics");
      const content = metrics.cssContentSize || metrics.contentSize || {};
      const width = Math.max(1, Math.ceil(content.width || 1280));
      const height = Math.max(1, Math.ceil(content.height || 900));
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    const shot = await wc.debugger.sendCommand("Page.captureScreenshot", params);
    if (shot?.data) return Buffer.from(shot.data, "base64");
    throw new Error("CDP 未返回截图数据");
  } catch (err) {
    try {
      const image = await wc.capturePage();
      return useJpeg ? image.toJPEG(jpegQuality) : image.toPNG();
    } catch (fallbackErr) {
      throw new Error(`截图失败: ${err.message}; 回退失败: ${fallbackErr.message}`);
    }
  }
}

function compareBuffers(shotPng, baselinePath) {
  const shotImage = nativeImage.createFromBuffer(shotPng);
  const baseImage = nativeImage.createFromPath(baselinePath);
  if (baseImage.isEmpty() || shotImage.isEmpty()) {
    return { match: false, error: "基线或截图为空" };
  }
  const a = baseImage.getSize();
  const b = shotImage.getSize();
  if (a.width !== b.width || a.height !== b.height) {
    return {
      match: false,
      diffRatio: 1,
      note: `尺寸不同: 基线 ${a.width}x${a.height}，当前 ${b.width}x${b.height}`,
    };
  }
  const bufA = baseImage.toBitmap();
  const bufB = shotImage.toBitmap();
  const diffBuf = Buffer.alloc(bufB.length);
  let diffPixels = 0;
  const totalPixels = b.width * b.height;
  const threshold = 24;
  for (let i = 0; i < bufB.length; i += 4) {
    const dr = Math.abs(bufA[i] - bufB[i]);
    const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
    const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
    if (dr > threshold || dg > threshold || db > threshold) {
      diffPixels += 1;
      diffBuf[i] = 255;
      diffBuf[i + 1] = 0;
      diffBuf[i + 2] = 255;
      diffBuf[i + 3] = 255;
    }
  }
  const diffRatio = totalPixels ? diffPixels / totalPixels : 0;
  return {
    match: diffPixels === 0,
    diffRatio: Math.round(diffRatio * 1e6) / 1e6,
    diffPixels,
    totalPixels,
    width: b.width,
    height: b.height,
    diffBuf,
  };
}

async function snapshot({ fullPage = false, baseline = "", threshold = 0.001, live = false, settleMs, workDir } = {}) {
  if (workDir) setWorkDir(workDir);
  const browser = ensureWindow();
  const wc = browser.webContents;
  ensureDir(shotsDir());
  try {
    // 自动等待渲染就绪，避免刚导航就截到 loading
    if (settleMs !== false) {
      await waitForReady(wc, settleMs === undefined ? 400 : settleMs);
    }
    const useLive = Boolean(live) && !baseline;
    const img = await captureImage({
      fullPage: Boolean(fullPage),
      format: useLive ? "jpeg" : "png",
      quality: 55,
    });
    const mime = useLive ? "image/jpeg" : "image/png";
    const shotPath = useLive
      ? ""
      : path.join(shotsDir(), `shot-${Date.now()}.png`);
    if (!useLive) {
      fs.writeFileSync(shotPath, img);
      lastShotPath = shotPath;
    }
    lastActionAt = Date.now();
    const info = await readPageInfo(wc);

    let compare = null;
    if (baseline && !useLive) {
      const name = safeBaselineName(baseline);
      // 项目内基线优先，读不到时回退到升级前的全局目录
      const baselineCandidates = projectArtifactService
        .readCandidates(KIND, activeWorkDir)
        .map((dir) => path.join(dir, "baselines", `${name}.png`));
      const baselinePath =
        baselineCandidates.find((candidate) => fs.existsSync(candidate)) || baselineCandidates[0];
      if (!baselinePath || !fs.existsSync(baselinePath)) {
        compare = { match: false, error: `基线不存在: ${baselinePath || name}`, baselineName: name };
      } else {
        const result = compareBuffers(img, baselinePath);
        if (result.diffBuf) {
          const diffPath = path.join(shotsDir(), `diff-${name}-${Date.now()}.png`);
          try {
            const diffImage = nativeImage.createFromBitmap(result.diffBuf, {
              width: result.width,
              height: result.height,
            });
            fs.writeFileSync(diffPath, diffImage.toPNG());
            result.diffPath = diffPath;
          } catch {}
          delete result.diffBuf;
        }
        compare = {
          baselineName: name,
          baselinePath,
          threshold: Number(threshold) || 0.001,
          match:
            result.match || (Number(result.diffRatio) || 0) <= (Number(threshold) || 0.001),
          ...result,
        };
      }
    }

    return {
      ok: true,
      shotPath,
      dataUrl: `data:${mime};base64,${img.toString("base64")}`,
      live: useLive,
      ...info,
      compare,
    };
  } catch (err) {
    lastError = err.message || String(err);
    return { ok: false, error: lastError };
  }
}

function saveBaseline({ name = "default", shotPath, workDir } = {}) {
  if (workDir) setWorkDir(workDir);
  const source = shotPath || lastShotPath;
  if (!source || !fs.existsSync(source)) {
    return { ok: false, error: "没有可保存的截图，请先执行 snapshot" };
  }
  ensureDir(baselinesDir());
  const safe = safeBaselineName(name);
  const target = path.join(baselinesDir(), `${safe}.png`);
  try {
    fs.copyFileSync(source, target);
    return { ok: true, baselinePath: target, baselineName: safe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 列出可用基线：项目内目录优先，并合并升级前全局目录中的同名基线（去重）。
 */
function listBaselines() {
  const nameSet = new Set();
  for (const base of projectArtifactService.readCandidates(KIND, activeWorkDir)) {
    const dir = path.join(base, "baselines");
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith(".png")) nameSet.add(file.replace(/\.png$/i, ""));
      }
    } catch {
      // 目录不存在或不可读时跳过
    }
  }
  ensureDir(baselinesDir());
  return [...nameSet].sort();
}

function getState() {
  const alive = Boolean(win && !win.isDestroyed());
  const pageUrl = alive ? win.webContents.getURL() : "";
  // 仅当窗口已经真正载入页面时才算“会话运行中”，避免打开失败后一直显示运行态
  const open = Boolean(alive && pageUrl && pageUrl !== "about:blank");
  return {
    open,
    loading: navigating,
    url: open ? pageUrl : "",
    title: open ? win.webContents.getTitle() : "",
    lastShotPath,
    lastError,
    lastActionAt,
    workDir: activeWorkDir,
    shotsDir: shotsDir(),
    baselines: listBaselines(),
  };
}

async function reload({ settleMs = 500 } = {}) {
  const browser = ensureWindow();
  const wc = browser.webContents;
  lastError = "";
  navigating = true;
  try {
    const loaded = waitForLoad(wc, 15000);
    wc.reload();
    const loadState = await loaded;
    await waitForReady(wc, settleMs);
    lastActionAt = Date.now();
    const info = await readPageInfo(wc);
    if (loadState?.failed) {
      lastError = `页面加载失败 (${loadState.code}): ${loadState.desc || ""}`.trim();
    } else if (loadState?.timedOut) {
      lastError = "刷新超过 15s，已返回当前可交互内容";
    }
    return { ok: true, ...info, warning: lastError || undefined };
  } catch (err) {
    try {
      wc.stop();
    } catch {}
    lastError = err.message || String(err);
    return { ok: false, error: lastError };
  } finally {
    navigating = false;
  }
}

async function back() {
  const browser = ensureWindow();
  const wc = browser.webContents;
  navigating = true;
  try {
    const loaded = waitForLoad(wc, 10000);
    if (wc.navigationHistory?.canGoBack?.()) {
      wc.navigationHistory.goBack();
    } else {
      wc.goBack();
    }
    await loaded;
    lastActionAt = Date.now();
    return { ok: true, ...(await readPageInfo(wc)) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    navigating = false;
  }
}

async function forward() {
  const browser = ensureWindow();
  const wc = browser.webContents;
  navigating = true;
  try {
    const loaded = waitForLoad(wc, 10000);
    if (wc.navigationHistory?.canGoForward?.()) {
      wc.navigationHistory.goForward();
    } else {
      wc.goForward();
    }
    await loaded;
    lastActionAt = Date.now();
    return { ok: true, ...(await readPageInfo(wc)) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    navigating = false;
  }
}

function close() {
  try {
    if (win && !win.isDestroyed()) {
      try {
        if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
      } catch {}
      win.destroy();
    }
  } catch {}
  win = null;
  navigating = false;
  return { ok: true };
}

module.exports = {
  open,
  interact,
  snapshot,
  saveBaseline,
  listBaselines,
  getState,
  back,
  forward,
  reload,
  close,
  normalizeUrl,
  setWorkDir,
  getWorkDir: () => activeWorkDir,
  shotsDir,
  baselinesDir,
};
