/**
 * RepoIndexService — 轻量级仓库符号索引与 Repo Map
 *
 * 不依赖外部语言服务器：
 * - 复用工作区文件索引（优先 git ls-files，自动尊重 .gitignore）；
 * - 通过分语言正则抽取顶层符号（类/函数/接口/类型/结构体等）；
 * - 生成受 Token 预算约束的 Repo Map 注入 System Prompt；
 * - 提供 search_symbols 工具，弥补纯文本 grep 缺少“符号语义”的问题。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { listWorkspaceFiles, listWorkspaceFilesAsync } = require("../utils/tools/fileIndexer");
const projectArtifactService = require("./projectArtifactService");

// 索引是仓库派生产物：默认随项目落盘到 <workDir>/.omcx/index/，可通过配置回退全局
const KIND = projectArtifactService.KIND.INDEX;
const SCAN_TTL_MS = 45 * 1000;
const DISK_TTL_MS = 5 * 60 * 1000;
const MAX_SCAN_FILES = 4000;
const MAX_FILE_READ_BYTES = 192 * 1024;
const MAX_SYMBOLS_PER_FILE = 40;

const LANGUAGE_BY_EXT = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".scala": "Scala",
  ".sh": "Shell",
  ".sql": "SQL",
};

const IGNORED_EXT = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".lock",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf", ".zip",
  ".gz", ".tar", ".dmg", ".exe", ".dll", ".so", ".dylib", ".node", ".map",
]);

const scanCache = new Map();
const inFlightScans = new Map();
const ASYNC_READ_CONCURRENCY = 16;

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function hashKey(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex");
}

function safeRead(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_READ_BYTES) return "";
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function safeReadAsync(filePath, maxBytes = MAX_FILE_READ_BYTES) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function extractSymbols(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const symbols = [];
  const seen = new Set();
  const push = (name, kind, line) => {
    const clean = String(name || "").trim();
    if (!clean || clean.length > 120) return;
    const key = `${kind}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({ name: clean, kind, line });
  };

  const lines = content.split(/\r?\n/);
  const patterns = [];

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    patterns.push(
      { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
      { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/, kind: "function" },
      { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
      { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
      { re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, kind: "method" }
    );
  } else if (ext === ".py") {
    patterns.push(
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
      { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" }
    );
  } else if (ext === ".go") {
    patterns.push(
      { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
      { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: "type" }
    );
  } else if (ext === ".rs") {
    patterns.push(
      { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/, kind: "type" }
    );
  } else if ([".java", ".kt", ".kts", ".cs", ".scala"].includes(ext)) {
    patterns.push(
      { re: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)/, kind: "type" },
      { re: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|override\s+)*(?:async\s+)?(?:fun|void|int|long|double|float|boolean|String|[A-Z]\w*(?:<[^>]+>)?)\s+([A-Za-z_]\w*)\s*\(/, kind: "method" }
    );
  } else if ([".c", ".h", ".cc", ".cpp", ".hpp"].includes(ext)) {
    patterns.push(
      { re: /^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)/, kind: "type" },
      { re: /^\s*(?:[A-Za-z_]\w*[\s*]+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/, kind: "function" }
    );
  } else if (ext === ".rb") {
    patterns.push(
      { re: /^\s*class\s+([A-Z]\w*)/, kind: "class" },
      { re: /^\s*module\s+([A-Z]\w*)/, kind: "module" },
      { re: /^\s*def\s+([A-Za-z_]\w*[?!]?)/, kind: "function" }
    );
  } else if (ext === ".php") {
    patterns.push(
      { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
      { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/, kind: "function" }
    );
  } else if (ext === ".swift") {
    patterns.push(
      { re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)*(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/, kind: "type" },
      { re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|static\s+|override\s+)*func\s+([A-Za-z_]\w*)/, kind: "function" }
    );
  }

  if (patterns.length === 0) return symbols;

  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; i += 1) {
    const line = lines[i];
    if (!line || line.length > 400) continue;
    for (const { re, kind } of patterns) {
      const match = line.match(re);
      if (match && match[1]) {
        push(match[1], kind, i + 1);
        break;
      }
    }
  }
  return symbols;
}

function scanRepo(workDir, { force = false } = {}) {
  if (!workDir || typeof workDir !== "string") {
    return { workDir: null, files: [], symbols: [], stats: { fileCount: 0, symbolCount: 0 } };
  }
  const resolved = path.resolve(workDir);
  const cacheKey = resolved;
  const now = Date.now();
  const cached = scanCache.get(cacheKey);
  if (!force && cached && now - cached.at < SCAN_TTL_MS) {
    return cached.value;
  }

  const indexTarget = projectArtifactService.resolveDir(KIND, resolved);
  const diskPath = indexTarget.dir ? path.join(indexTarget.dir, `${hashKey(resolved)}.json`) : null;
  if (!force && diskPath) {
    try {
      const stat = fs.statSync(diskPath);
      if (now - stat.mtimeMs < DISK_TTL_MS) {
        const disk = JSON.parse(fs.readFileSync(diskPath, "utf-8"));
        if (disk && disk.workDir === resolved && Array.isArray(disk.files)) {
          scanCache.set(cacheKey, { at: now, value: disk });
          return disk;
        }
      }
    } catch {
      // 缓存不存在或已损坏，继续全量扫描
    }
  }

  // 项目内缓存未命中时，读取升级前的全局旧索引兜底
  if (!force) {
    for (const legacyDir of projectArtifactService.readCandidates(KIND, resolved)) {
      const legacyPath = path.join(legacyDir, `${hashKey(resolved)}.json`);
      if (legacyPath === diskPath) continue;
      try {
        const stat = fs.statSync(legacyPath);
        if (now - stat.mtimeMs >= DISK_TTL_MS) continue;
        const disk = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
        if (disk && disk.workDir === resolved && Array.isArray(disk.files)) {
          scanCache.set(cacheKey, { at: now, value: disk });
          return disk;
        }
      } catch {
        // 继续尝试下一个候选目录
      }
    }
  }

  const listed = listWorkspaceFiles(resolved, [resolved]);
  const candidates = (listed.files || [])
    .filter((entry) => entry && entry.isDir === false)
    .filter((entry) => {
      const ext = path.extname(entry.path).toLowerCase();
      return LANGUAGE_BY_EXT[ext] && !IGNORED_EXT.has(ext);
    })
    .slice(0, MAX_SCAN_FILES);

  const files = [];
  const languageCounts = {};

  for (const entry of candidates) {
    const absPath = path.isAbsolute(entry.path) ? entry.path : path.join(resolved, entry.path);
    const relPath = path.isAbsolute(entry.path)
      ? path.relative(resolved, entry.path).replace(/\\/g, "/")
      : String(entry.path).replace(/\\/g, "/");
    const ext = path.extname(relPath).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext];
    languageCounts[language] = (languageCounts[language] || 0) + 1;
    const content = safeRead(absPath);
    if (!content) continue;
    const symbols = extractSymbols(relPath, content);
    if (symbols.length === 0) continue;
    files.push({
      path: relPath,
      language,
      size: content.length,
      symbols,
    });
  }

  const value = {
    workDir: resolved,
    generatedAt: now,
    files,
    stats: {
      fileCount: files.length,
      symbolCount: files.reduce((sum, file) => sum + file.symbols.length, 0),
      languages: languageCounts,
      scannedFiles: candidates.length,
      truncated: Boolean(listed.truncated) || (listed.files || []).length > MAX_SCAN_FILES,
    },
  };

  scanCache.set(cacheKey, { at: now, value });
  if (scanCache.size > 20) {
    const oldest = Array.from(scanCache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) scanCache.delete(oldest[0]);
  }

  try {
    if (diskPath) {
      projectArtifactService.prepareDir(KIND, resolved);
      fs.writeFileSync(diskPath, JSON.stringify(value), "utf-8");
    }
  } catch {
    // 索引落盘失败不影响内存可用性
  }

  return value;
}

async function readValidDiskIndexAsync(filePath, resolved, now) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (now - stat.mtimeMs >= DISK_TTL_MS) return null;
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const disk = JSON.parse(raw);
    if (disk && disk.workDir === resolved && Array.isArray(disk.files)) {
      return disk;
    }
  } catch {
    // 缓存不存在或已损坏
  }
  return null;
}

/**
 * 异步无阻塞仓库扫描（避免 Electron 主线程同步读取大量文件导致卡顿）。
 */
async function scanRepoAsync(workDir, { force = false } = {}) {
  if (!workDir || typeof workDir !== "string") {
    return { workDir: null, files: [], symbols: [], stats: { fileCount: 0, symbolCount: 0 } };
  }
  const resolved = path.resolve(workDir);
  const cacheKey = resolved;
  const now = Date.now();
  const cached = scanCache.get(cacheKey);
  if (!force && cached && now - cached.at < SCAN_TTL_MS) {
    return cached.value;
  }

  if (!force && inFlightScans.has(cacheKey)) {
    return inFlightScans.get(cacheKey);
  }

  const runScan = async () => {
    const indexTarget = projectArtifactService.resolveDir(KIND, resolved);
    const diskPath = indexTarget.dir ? path.join(indexTarget.dir, `${hashKey(resolved)}.json`) : null;

    if (!force && diskPath) {
      const disk = await readValidDiskIndexAsync(diskPath, resolved, now);
      if (disk) {
        scanCache.set(cacheKey, { at: Date.now(), value: disk });
        return disk;
      }
      for (const legacyDir of projectArtifactService.readCandidates(KIND, resolved)) {
        const legacyPath = path.join(legacyDir, `${hashKey(resolved)}.json`);
        if (legacyPath === diskPath) continue;
        const legacyDisk = await readValidDiskIndexAsync(legacyPath, resolved, now);
        if (legacyDisk) {
          scanCache.set(cacheKey, { at: Date.now(), value: legacyDisk });
          return legacyDisk;
        }
      }
    }

    const listed = await listWorkspaceFilesAsync(resolved, [resolved]);
    const candidates = (listed.files || [])
      .filter((entry) => entry && entry.isDir === false)
      .filter((entry) => {
        const ext = path.extname(entry.path).toLowerCase();
        return LANGUAGE_BY_EXT[ext] && !IGNORED_EXT.has(ext);
      })
      .slice(0, MAX_SCAN_FILES);

    const languageCounts = {};
    const scannedEntries = await mapWithConcurrency(
      candidates,
      ASYNC_READ_CONCURRENCY,
      async (entry) => {
        const absPath = path.isAbsolute(entry.path) ? entry.path : path.join(resolved, entry.path);
        const relPath = path.isAbsolute(entry.path)
          ? path.relative(resolved, entry.path).replace(/\\/g, "/")
          : String(entry.path).replace(/\\/g, "/");
        const ext = path.extname(relPath).toLowerCase();
        const language = LANGUAGE_BY_EXT[ext];
        languageCounts[language] = (languageCounts[language] || 0) + 1;
        const content = await safeReadAsync(absPath);
        if (!content) return null;
        const symbols = extractSymbols(relPath, content);
        if (symbols.length === 0) return null;
        return {
          path: relPath,
          language,
          size: content.length,
          symbols,
        };
      }
    );

    const files = scannedEntries.filter(Boolean);
    const value = {
      workDir: resolved,
      generatedAt: Date.now(),
      files,
      stats: {
        fileCount: files.length,
        symbolCount: files.reduce((sum, file) => sum + file.symbols.length, 0),
        languages: languageCounts,
        scannedFiles: candidates.length,
        truncated: Boolean(listed.truncated) || (listed.files || []).length > MAX_SCAN_FILES,
      },
    };

    scanCache.set(cacheKey, { at: Date.now(), value });
    if (scanCache.size > 20) {
      const oldest = Array.from(scanCache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) scanCache.delete(oldest[0]);
    }

    if (diskPath) {
      try {
        projectArtifactService.prepareDir(KIND, resolved);
        await fs.promises.writeFile(diskPath, JSON.stringify(value), "utf-8");
      } catch {
        // 索引落盘失败不影响内存可用性
      }
    }
    return value;
  };

  const promise = runScan().finally(() => {
    inFlightScans.delete(cacheKey);
  });
  if (!force) {
    inFlightScans.set(cacheKey, promise);
  }
  return promise;
}

function flattenSymbols(index) {
  const out = [];
  for (const file of index.files || []) {
    for (const symbol of file.symbols || []) {
      out.push({ ...symbol, path: file.path, language: file.language });
    }
  }
  return out;
}

function formatRepoMapFromIndex(index, maxChars = 6000) {
  if (!index.files || index.files.length === 0) return "";

  const budget = Math.max(800, Math.min(20000, Number(maxChars) || 6000));
  const ranked = [...index.files].sort((a, b) => {
    const depthA = a.path.split("/").length;
    const depthB = b.path.split("/").length;
    if (a.symbols.length !== b.symbols.length) return b.symbols.length - a.symbols.length;
    return depthA - depthB;
  });

  const groups = new Map();
  for (const file of ranked) {
    const segments = file.path.split("/");
    const group = segments.length > 1 ? segments.slice(0, 2).join("/") : ".";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(file);
  }

  const lines = [];
  lines.push(
    `<repo_map files="${index.stats.fileCount}" symbols="${index.stats.symbolCount}" languages="${Object.keys(index.stats.languages).length}">`
  );

  let used = lines[0].length;
  let emittedFiles = 0;

  for (const [group, groupFiles] of groups.entries()) {
    const header = `${group}/`;
    if (used + header.length + 2 > budget) break;
    lines.push(header);
    used += header.length + 1;

    for (const file of groupFiles) {
      const symbolText = file.symbols
        .slice(0, 12)
        .map((symbol) => `${symbol.name}@${symbol.line}`)
        .join(", ");
      const suffix = file.symbols.length > 12 ? ` …+${file.symbols.length - 12}` : "";
      const line = `  ${file.path}${file.symbols.length ? ` :: ${symbolText}${suffix}` : ""}`;
      if (used + line.length + 1 > budget) {
        lines.push(`  … (已按 Token 预算截断，共 ${index.stats.fileCount} 个符号文件)`);
        used += 80;
        break;
      }
      lines.push(line);
      used += line.length + 1;
      emittedFiles += 1;
    }
    if (used >= budget) break;
  }

  if (emittedFiles < index.stats.fileCount) {
    lines.push(
      `# 说明：Repo Map 仅列出高价值符号文件；完整检索请调用 search_symbols / search_code / repo_map 工具。`
    );
  }
  lines.push("</repo_map>");
  return lines.join("\n");
}

/**
 * 生成受字符预算约束的 Repo Map。
 */
function buildRepoMap(workDir, { maxChars = 6000, force = false } = {}) {
  const index = scanRepo(workDir, { force });
  return formatRepoMapFromIndex(index, maxChars);
}

async function buildRepoMapAsync(workDir, { maxChars = 6000, force = false } = {}) {
  const index = await scanRepoAsync(workDir, { force });
  return formatRepoMapFromIndex(index, maxChars);
}

function matchSymbolsFromIndex(index, query, limit = 40) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const all = flattenSymbols(index);
  const scored = [];

  for (const symbol of all) {
    const name = symbol.name.toLowerCase();
    let score = -1;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 80;
    else if (name.includes(needle)) score = 60;
    else if (symbol.path.toLowerCase().includes(needle)) score = 30;
    if (score >= 0) scored.push({ ...symbol, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 40)));
}

function searchSymbols(workDir, query, { limit = 40, force = false } = {}) {
  const index = scanRepo(workDir, { force });
  return matchSymbolsFromIndex(index, query, limit);
}

async function searchSymbolsAsync(workDir, query, { limit = 40, force = false } = {}) {
  const index = await scanRepoAsync(workDir, { force });
  return matchSymbolsFromIndex(index, query, limit);
}

function getRepoStats(workDir, { force = false } = {}) {
  const index = scanRepo(workDir, { force });
  return index.stats;
}

async function getRepoStatsAsync(workDir, { force = false } = {}) {
  const index = await scanRepoAsync(workDir, { force });
  return index.stats;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 轻量调用图/引用检索：基于符号索引定位定义，再逐文件扫描同名标识符，
 * 将出现位置分类为 definition / call / reference，供 Agent 快速判断影响面。
 *
 * @param {string} workDir
 * @param {string} symbol
 * @param {{limit?:number, maxFiles?:number}} options
 */
function findReferences(workDir, symbol, { limit = 60, maxFiles = 5000 } = {}) {
  const name = String(symbol || "").trim();
  const result = {
    query: name,
    definitions: [],
    references: [],
    total: 0,
    scannedFiles: 0,
    truncated: false,
  };
  if (!workDir || !name) {
    result.error = "缺少工作目录或符号名";
    return result;
  }

  const index = scanRepo(workDir);
  const wordRe = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const callRe = new RegExp(`\\b${escapeRegExp(name)}\\s*[(<]`);
  const defLineMap = new Map();
  for (const file of index.files) {
    for (const sym of file.symbols || []) {
      if (sym.name === name) defLineMap.set(`${file.path}:${sym.line}`, sym.kind);
    }
  }

  // 引用扫描必须覆盖所有源码文件，而不能只扫描「含顶层符号」的索引文件，
  // 否则调用点所在的文件（例如只包含表达式/常量赋值的入口文件）会被漏掉。
  const listed = listWorkspaceFiles(path.resolve(workDir), [path.resolve(workDir)]);
  const candidates = (listed.files || [])
    .filter((entry) => entry && entry.isDir === false)
    .filter((entry) => {
      const ext = path.extname(entry.path).toLowerCase();
      return LANGUAGE_BY_EXT[ext] && !IGNORED_EXT.has(ext);
    })
    .slice(0, maxFiles);

  for (const entry of candidates) {
    if (result.scannedFiles >= maxFiles) {
      result.truncated = true;
      break;
    }
    result.scannedFiles += 1;
    const relPath = String(entry.path).replace(/\\/g, "/");
    let content;
    try {
      content = fs.readFileSync(
        path.isAbsolute(entry.path) ? entry.path : path.join(workDir, entry.path),
        "utf-8"
      );
    } catch {
      continue;
    }
    if (content.length > 2 * 1024 * 1024) continue;
    if (!content.includes(name)) continue;
    const language = LANGUAGE_BY_EXT[path.extname(relPath).toLowerCase()];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes(name) || !wordRe.test(line)) continue;
      const key = `${relPath}:${i + 1}`;
      const text = line.trim().slice(0, 240);
      if (defLineMap.has(key)) {
        result.definitions.push({
          path: relPath,
          line: i + 1,
          kind: "definition",
          symbolKind: defLineMap.get(key),
          language,
          text,
        });
      } else {
        result.references.push({
          path: relPath,
          line: i + 1,
          kind: callRe.test(line) ? "call" : "reference",
          language,
          text,
        });
      }
      if (result.references.length >= limit) {
        result.truncated = true;
        break;
      }
    }
    if (result.truncated) break;
  }

  result.total = result.definitions.length + result.references.length;
  return result;
}

async function findReferencesAsync(workDir, symbol, { limit = 60, maxFiles = 5000 } = {}) {
  const name = String(symbol || "").trim();
  const result = {
    query: name,
    definitions: [],
    references: [],
    total: 0,
    scannedFiles: 0,
    truncated: false,
  };
  if (!workDir || !name) {
    result.error = "缺少工作目录或符号名";
    return result;
  }

  const index = await scanRepoAsync(workDir);
  const wordRe = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const callRe = new RegExp(`\\b${escapeRegExp(name)}\\s*[(<]`);
  const defLineMap = new Map();
  for (const file of index.files) {
    for (const sym of file.symbols || []) {
      if (sym.name === name) defLineMap.set(`${file.path}:${sym.line}`, sym.kind);
    }
  }

  const listed = await listWorkspaceFilesAsync(path.resolve(workDir), [path.resolve(workDir)]);
  const candidates = (listed.files || [])
    .filter((entry) => entry && entry.isDir === false)
    .filter((entry) => {
      const ext = path.extname(entry.path).toLowerCase();
      return LANGUAGE_BY_EXT[ext] && !IGNORED_EXT.has(ext);
    })
    .slice(0, maxFiles);

  // 分批异步读取，既避免阻塞主线程又可在达到 limit 后提前停止
  for (let start = 0; start < candidates.length; start += ASYNC_READ_CONCURRENCY) {
    if (result.truncated) break;
    const batch = candidates.slice(start, start + ASYNC_READ_CONCURRENCY);
    const contents = await Promise.all(
      batch.map((entry) => {
        const absPath = path.isAbsolute(entry.path) ? entry.path : path.join(workDir, entry.path);
        return safeReadAsync(absPath, 2 * 1024 * 1024);
      })
    );
    for (let i = 0; i < batch.length; i += 1) {
      if (result.scannedFiles >= maxFiles) {
        result.truncated = true;
        break;
      }
      result.scannedFiles += 1;
      const content = contents[i];
      if (!content || !content.includes(name)) continue;
      const relPath = String(batch[i].path).replace(/\\/g, "/");
      const language = LANGUAGE_BY_EXT[path.extname(relPath).toLowerCase()];
      const lines = content.split(/\r?\n/);
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
        const line = lines[lineIdx];
        if (!line.includes(name) || !wordRe.test(line)) continue;
        const key = `${relPath}:${lineIdx + 1}`;
        const text = line.trim().slice(0, 240);
        if (defLineMap.has(key)) {
          result.definitions.push({
            path: relPath,
            line: lineIdx + 1,
            kind: "definition",
            symbolKind: defLineMap.get(key),
            language,
            text,
          });
        } else {
          result.references.push({
            path: relPath,
            line: lineIdx + 1,
            kind: callRe.test(line) ? "call" : "reference",
            language,
            text,
          });
        }
        if (result.references.length >= limit) {
          result.truncated = true;
          break;
        }
      }
      if (result.truncated) break;
    }
  }

  result.total = result.definitions.length + result.references.length;
  return result;
}

/**
 * 索引落盘目录（按项目解析）。
 * @param {string} [workDir] 工作目录；缺省时返回全局旧目录，仅作兼容用途
 */
function getIndexDir(workDir) {
  return projectArtifactService.resolveDir(KIND, workDir || "").dir;
}

module.exports = {
  scanRepo,
  scanRepoAsync,
  buildRepoMap,
  buildRepoMapAsync,
  searchSymbols,
  searchSymbolsAsync,
  findReferences,
  findReferencesAsync,
  getRepoStats,
  getRepoStatsAsync,
  extractSymbols,
  getIndexDir,
  INDEX_DIR: projectArtifactService.globalDir(KIND),
};
