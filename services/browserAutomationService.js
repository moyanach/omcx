/**
 * browserAutomationService — 内置浏览器自动化（Electron 隐藏窗口 + CDP）
 *
 * 能力：
 *  - open(url)                 打开 http/https 页面
 *  - interact({action,...})    click / fill / press / hover / scroll / wait_for
 *  - snapshot({fullPage,...})  CDP 全页/视口截图，支持基线视觉回归对比
 *  - state() / close()
 *
 * 安全约束：
 *  - 仅允许 http/https，拒绝 file/javascript/data 等协议
 *  - 自动化窗口禁用 nodeIntegration / preload，开启 contextIsolation + sandbox
 *  - 禁止 window.open 弹出新窗口与全部权限请求
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { BrowserWindow, nativeImage } = require("electron");

const NAV_TIMEOUT_MS = 30000;
const MAX_TEXT_CHARS = 6000;

function omcxHome() {
  return process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
}

function shotsDir() {
  return path.join(omcxHome(), "browser-shots");
}

function baselinesDir() {
  return path.join(shotsDir(), "baselines");
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

let win = null;
let lastShotPath = "";
let lastError = "";
let lastActionAt = 0;

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

async function open({ url } = {}) {
  const target = normalizeUrl(url);
  const browser = ensureWindow();
  const wc = browser.webContents;
  lastError = "";
  try {
    const loaded = waitForLoad(wc);
    await wc.loadURL(target);
    const loadState = await loaded;
    lastActionAt = Date.now();
    const info = await readPageInfo(wc);
    if (loadState?.failed) {
      lastError = `页面加载失败 (${loadState.code}): ${loadState.desc || ""}`.trim();
    } else if (loadState?.timedOut) {
      lastError = `页面加载超过 ${Math.round(NAV_TIMEOUT_MS / 1000)}s，已返回当前可交互内容`;
    }
    return { ok: true, ...info, warning: lastError || undefined };
  } catch (err) {
    lastError = err.message || String(err);
    return { ok: false, error: lastError, url: target };
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

async function capturePng(fullPage = false) {
  const browser = ensureWindow();
  const wc = browser.webContents;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const params = { format: "png", captureBeyondViewport: Boolean(fullPage) };
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
      return image.toPNG();
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

async function snapshot({ fullPage = false, baseline = "", threshold = 0.001 } = {}) {
  const browser = ensureWindow();
  const wc = browser.webContents;
  ensureDir(shotsDir());
  try {
    const png = await capturePng(Boolean(fullPage));
    const shotPath = path.join(shotsDir(), `shot-${Date.now()}.png`);
    fs.writeFileSync(shotPath, png);
    lastShotPath = shotPath;
    lastActionAt = Date.now();
    const info = await readPageInfo(wc);

    let compare = null;
    if (baseline) {
      const name = safeBaselineName(baseline);
      const baselinePath = path.join(baselinesDir(), `${name}.png`);
      if (!fs.existsSync(baselinePath)) {
        compare = { match: false, error: `基线不存在: ${baselinePath}`, baselineName: name };
      } else {
        const result = compareBuffers(png, baselinePath);
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
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      ...info,
      compare,
    };
  } catch (err) {
    lastError = err.message || String(err);
    return { ok: false, error: lastError };
  }
}

function saveBaseline({ name = "default", shotPath } = {}) {
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

function listBaselines() {
  ensureDir(baselinesDir());
  let names = [];
  try {
    names = fs
      .readdirSync(baselinesDir())
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.replace(/\.png$/i, ""))
      .sort();
  } catch {}
  return names;
}

function getState() {
  const open = Boolean(win && !win.isDestroyed());
  return {
    open,
    url: open ? win.webContents.getURL() : "",
    title: open ? win.webContents.getTitle() : "",
    lastShotPath,
    lastError,
    lastActionAt,
    baselines: listBaselines(),
  };
}

async function back() {
  const browser = ensureWindow();
  const wc = browser.webContents;
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
  }
}

async function forward() {
  const browser = ensureWindow();
  const wc = browser.webContents;
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
  close,
  normalizeUrl,
  shotsDir,
  baselinesDir,
};
