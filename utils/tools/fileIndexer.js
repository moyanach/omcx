const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MAX_ENTRIES = 20000;
const CACHE_TTL = 30000;

const IGNORED_DIRS = new Set([
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
  "env",
  "__pycache__",
  "target",
  "vendor",
  ".idea",
  ".vscode",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".dart_tool",
  "Pods",
  "DerivedData",
]);

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".tiff", ".svgz",
  ".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv",
  ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".war",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".db", ".sqlite", ".sqlite3", ".lockb", ".pyc", ".pyo", ".o", ".a", ".obj",
]);

const cache = new Map();

function isIgnoredName(name, isDir) {
  if (isDir) return IGNORED_DIRS.has(name);
  return IGNORED_FILES.has(name) || BINARY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function hasIgnoredSegment(relPath) {
  return relPath.split("/").some((segment, index, arr) => {
    const isLast = index === arr.length - 1;
    return isIgnoredName(segment, !isLast);
  });
}

function listWithGit(root) {
  try {
    const stdout = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], {
      cwd: root,
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = [];
    for (const raw of stdout.split("\0")) {
      if (!raw) continue;
      const rel = raw.replace(/\\/g, "/");
      if (hasIgnoredSegment(rel)) continue;
      files.push(rel);
      if (files.length >= MAX_ENTRIES) break;
    }
    return files;
  } catch {
    return null;
  }
}

function listWithWalk(root) {
  const files = [];
  const stack = [""];
  while (stack.length > 0 && files.length < MAX_ENTRIES) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(root, relDir) : root;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_ENTRIES) break;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isIgnoredName(entry.name, true)) continue;
        stack.push(rel);
      } else if (entry.isFile()) {
        if (isIgnoredName(entry.name, false)) continue;
        files.push(rel);
      }
    }
  }
  return files;
}

function collectDirectoryEntries(relPaths) {
  const dirs = new Set();
  for (const rel of relPaths) {
    const segments = rel.split("/");
    segments.pop();
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      dirs.add(prefix);
    }
  }
  return dirs;
}

function normalizeFolders(workDir, allowedFolders) {
  const folders = [];
  const seen = new Set();
  const push = (folderPath, name) => {
    if (!folderPath) return;
    let resolved;
    try {
      resolved = path.resolve(folderPath);
    } catch {
      return;
    }
    if (seen.has(resolved)) return;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
    seen.add(resolved);
    folders.push({ path: resolved, name: name || path.basename(resolved) || resolved });
  };
  push(workDir);
  if (Array.isArray(allowedFolders)) {
    for (const folder of allowedFolders) push(folder);
  }
  return folders;
}

function buildIndex(workDir, allowedFolders) {
  const folders = normalizeFolders(workDir, allowedFolders);
  if (folders.length === 0) {
    return { files: [], source: "none", truncated: false };
  }

  const multiFolder = folders.length > 1;
  const entries = [];
  const seenPaths = new Set();
  let source = "git";
  let truncated = false;

  for (const folder of folders) {
    let relFiles = listWithGit(folder.path);
    if (relFiles === null) {
      source = "walk";
      relFiles = listWithWalk(folder.path);
    }
    if (relFiles.length >= MAX_ENTRIES) truncated = true;

    for (const rel of relFiles) {
      const displayPath = multiFolder ? `${folder.name}/${rel}` : rel;
      if (seenPaths.has(displayPath)) continue;
      seenPaths.add(displayPath);
      entries.push({ path: displayPath, isDir: false });
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
    }
    if (entries.length >= MAX_ENTRIES) break;
  }

  if (multiFolder) {
    for (const folder of folders) {
      if (seenPaths.has(folder.name)) continue;
      seenPaths.add(folder.name);
      entries.push({ path: folder.name, isDir: true });
    }
  }

  for (const dir of collectDirectoryEntries(entries.filter((e) => !e.isDir).map((e) => e.path))) {
    if (seenPaths.has(dir)) continue;
    seenPaths.add(dir);
    entries.push({ path: dir, isDir: true });
    if (entries.length >= MAX_ENTRIES * 2) {
      truncated = true;
      break;
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return { files: entries, source, truncated };
}

function listWorkspaceFiles(workDir, allowedFolders = []) {
  const key = `${workDir || ""}|${(allowedFolders || []).join("|")}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL) {
    return cached.value;
  }
  const value = buildIndex(workDir, allowedFolders);
  cache.set(key, { at: now, value });
  if (cache.size > 50) {
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

function clearFileIndexCache() {
  cache.clear();
}

module.exports = {
  listWorkspaceFiles,
  clearFileIndexCache,
  isIgnoredName,
  IGNORED_DIRS,
  BINARY_EXTENSIONS,
};
