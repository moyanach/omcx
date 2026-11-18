/**
 * WorkspaceRefreshService — 轻量工作区事件总线与缓存主动失效中心
 *
 * 职责：
 * 1. 统一失效 fileIndexer / repoIndexService / workspaceGitService 三层缓存；
 * 2. 对活跃工作区目录维护防抖 fs.watch（严格过滤 .git/node_modules/dist/.omcx/index 等高频噪声）；
 * 3. 在窗口聚焦、Agent 工具写入、Shell 执行、文件还原及 Git 操作后广播细粒度 `workspace-changed` 事件；
 * 4. 保持 Headless 纯 JS 边界（零 Electron 硬依赖）。
 */

const fs = require("fs");
const path = require("path");
const fileIndexer = require("../utils/tools/fileIndexer");
const repoIndexService = require("./repoIndexService");
const workspaceGitService = require("./workspaceGitService");

const ALL_AREAS = [
  "files",
  "git",
  "specs",
  "worktrees",
  "commands",
  "skills",
  "subagents",
  "wiki",
];

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  "Pods",
  "DerivedData",
]);

const WATCH_DEBOUNCE_MS = 500;
const FOCUS_COOLDOWN_MS = 1000;
const MAX_WATCHED_FOLDERS = 5;

const listeners = new Set();
const watchers = new Map(); // resolvedDir -> { watcher, timer, paths: Set<string> }
let primaryWatchedDir = "";
let lastFocusAt = 0;

function normalizeDir(dirPath) {
  if (!dirPath || typeof dirPath !== "string" || !dirPath.trim()) return "";
  try {
    return path.resolve(dirPath.trim());
  } catch {
    return "";
  }
}

function shouldIgnoreWatchFilename(filename) {
  if (!filename) return false;
  const rel = String(filename).replace(/\\/g, "/");
  if (!rel) return false;
  const base = path.posix.basename(rel);
  if (
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base.endsWith(".swp") ||
    base.endsWith(".tmp") ||
    base.endsWith("~") ||
    base.endsWith(".lock")
  ) {
    return true;
  }
  const segments = rel.split("/").filter(Boolean);
  for (const seg of segments) {
    if (IGNORED_PATH_SEGMENTS.has(seg)) return true;
  }
  // 忽略索引缓存与浏览截图目录写入（由自身服务写入），避免自激刷新循环
  if (
    rel === ".omcx/index" ||
    rel.startsWith(".omcx/index/") ||
    rel === ".omcx/cache" ||
    rel.startsWith(".omcx/cache/") ||
    rel === ".omcx/browser-shots" ||
    rel.startsWith(".omcx/browser-shots/")
  ) {
    return true;
  }
  return false;
}

function inferAreasFromPaths(paths = [], fallback = ["files", "git"]) {
  const areaSet = new Set(Array.isArray(fallback) && fallback.length > 0 ? fallback : ["files", "git"]);
  for (const p of paths) {
    const norm = String(p || "").replace(/\\/g, "/");
    if (!norm) continue;
    if (norm.includes(".omcx/specs/") || norm.endsWith(".omcx/specs")) {
      areaSet.add("specs");
    }
    if (norm.includes(".omcx/commands/") || norm.endsWith(".omcx/commands")) {
      areaSet.add("commands");
    }
    if (norm.includes(".agents/skills/") || norm.endsWith(".agents/skills")) {
      areaSet.add("skills");
    }
    if (norm.includes(".omcx/agents/") || norm.endsWith(".omcx/agents")) {
      areaSet.add("subagents");
    }
    if (norm.includes(".omcx/wiki/") || norm.endsWith(".omcx/wiki")) {
      areaSet.add("wiki");
    }
  }
  return Array.from(areaSet);
}

function invalidateWorkspaceCaches(
  workDir,
  { fileIndex = true, repoIndex = true, git = true } = {}
) {
  const target = normalizeDir(workDir);
  if (fileIndex) {
    try {
      fileIndexer.clearFileIndexCache(target || undefined);
    } catch {}
  }
  if (repoIndex) {
    try {
      repoIndexService.invalidateRepoIndex(target || undefined);
    } catch {}
  }
  if (git) {
    try {
      workspaceGitService.invalidateGitStatusCache(target || undefined);
    } catch {}
  }
}

function subscribeWorkspaceChanged(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitWorkspaceChanged({
  workDir = null,
  reason = "manual",
  areas = ["files", "git"],
  paths = [],
  invalidate = false,
} = {}) {
  const normDir = normalizeDir(workDir) || null;
  if (invalidate) {
    invalidateWorkspaceCaches(normDir, {
      fileIndex: areas.includes("all") || areas.includes("files"),
      repoIndex: areas.includes("all") || areas.includes("files"),
      git: areas.includes("all") || areas.includes("git"),
    });
  }
  const normalizedAreas = areas.includes("all")
    ? [...ALL_AREAS]
    : inferAreasFromPaths(paths, areas);

  const payload = {
    workDir: normDir,
    reason,
    areas: normalizedAreas,
    paths: Array.isArray(paths) ? paths.slice(0, 30) : [],
    ts: Date.now(),
  };

  for (const listener of Array.from(listeners)) {
    try {
      listener(payload);
    } catch {}
  }
  return payload;
}

function createWatcherEntry(resolvedDir) {
  const entry = {
    watcher: null,
    timer: null,
    paths: new Set(),
  };

  const scheduleFlush = () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const changedPaths = Array.from(entry.paths);
      entry.paths.clear();
      invalidateWorkspaceCaches(resolvedDir, {
        fileIndex: true,
        repoIndex: true,
        git: true,
      });
      emitWorkspaceChanged({
        workDir: resolvedDir,
        reason: "fs_watch",
        areas: inferAreasFromPaths(changedPaths, ["files", "git"]),
        paths: changedPaths,
      });
    }, WATCH_DEBOUNCE_MS);
    if (entry.timer.unref) entry.timer.unref();
  };

  const onEvent = (_eventType, filename) => {
    if (shouldIgnoreWatchFilename(filename)) return;
    if (filename && entry.paths.size < 30) {
      entry.paths.add(String(filename).replace(/\\/g, "/"));
    }
    scheduleFlush();
  };

  try {
    entry.watcher = fs.watch(resolvedDir, { recursive: true }, onEvent);
  } catch {
    try {
      entry.watcher = fs.watch(resolvedDir, onEvent);
    } catch {
      entry.watcher = null;
    }
  }

  if (entry.watcher) {
    entry.watcher.on("error", () => {
      try {
        entry.watcher?.close();
      } catch {}
      watchers.delete(resolvedDir);
    });
  }
  return entry;
}

function watchWorkspaceFolders(workDir, allowedFolders = []) {
  const candidates = [];
  const seen = new Set();
  const pushDir = (d) => {
    const norm = normalizeDir(d);
    if (!norm || seen.has(norm)) return;
    try {
      if (!fs.existsSync(norm) || !fs.statSync(norm).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(norm);
    candidates.push(norm);
  };

  pushDir(workDir);
  if (Array.isArray(allowedFolders)) {
    for (const f of allowedFolders) {
      if (candidates.length >= MAX_WATCHED_FOLDERS) break;
      pushDir(f);
    }
  }

  primaryWatchedDir = candidates[0] || "";
  const nextSet = new Set(candidates);

  // 清理不再关注的目录监听
  for (const [dir, entry] of Array.from(watchers.entries())) {
    if (!nextSet.has(dir)) {
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.watcher?.close();
      } catch {}
      watchers.delete(dir);
    }
  }

  for (const dir of candidates) {
    if (watchers.has(dir)) continue;
    const entry = createWatcherEntry(dir);
    if (entry.watcher) {
      watchers.set(dir, entry);
    }
  }

  return Array.from(watchers.keys());
}

function unwatchAllWorkspaces() {
  for (const [, entry] of Array.from(watchers.entries())) {
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.watcher?.close();
    } catch {}
  }
  watchers.clear();
  primaryWatchedDir = "";
}

function notifyWindowFocus(explicitWorkDirs = []) {
  const now = Date.now();
  if (now - lastFocusAt < FOCUS_COOLDOWN_MS) return null;
  lastFocusAt = now;

  const targets = new Set();
  for (const d of explicitWorkDirs || []) {
    const norm = normalizeDir(d);
    if (norm) targets.add(norm);
  }
  for (const dir of watchers.keys()) {
    targets.add(dir);
  }
  if (primaryWatchedDir) targets.add(primaryWatchedDir);

  if (targets.size === 0) {
    invalidateWorkspaceCaches(null);
    return emitWorkspaceChanged({
      workDir: null,
      reason: "window_focus",
      areas: [...ALL_AREAS],
    });
  }

  let lastPayload = null;
  for (const dir of targets) {
    invalidateWorkspaceCaches(dir);
    lastPayload = emitWorkspaceChanged({
      workDir: dir,
      reason: "window_focus",
      areas: [...ALL_AREAS],
    });
  }
  return lastPayload;
}

module.exports = {
  ALL_AREAS,
  shouldIgnoreWatchFilename,
  inferAreasFromPaths,
  invalidateWorkspaceCaches,
  subscribeWorkspaceChanged,
  emitWorkspaceChanged,
  watchWorkspaceFolders,
  unwatchAllWorkspaces,
  notifyWindowFocus,
};
