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
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { listWorkspaceFiles } = require("../utils/tools/fileIndexer");

const INDEX_DIR = path.join(
  process.env.OMCX_HOME || path.join(os.homedir(), ".omcx"),
  "index"
);
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

  const diskPath = path.join(INDEX_DIR, `${hashKey(resolved)}.json`);
  if (!force) {
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
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    fs.writeFileSync(diskPath, JSON.stringify(value), "utf-8");
  } catch {
    // 索引落盘失败不影响内存可用性
  }

  return value;
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

/**
 * 生成受字符预算约束的 Repo Map。
 */
function buildRepoMap(workDir, { maxChars = 6000, force = false } = {}) {
  const index = scanRepo(workDir, { force });
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

function searchSymbols(workDir, query, { limit = 40, force = false } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const index = scanRepo(workDir, { force });
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

function getRepoStats(workDir, { force = false } = {}) {
  const index = scanRepo(workDir, { force });
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

module.exports = {
  scanRepo,
  buildRepoMap,
  searchSymbols,
  findReferences,
  getRepoStats,
  extractSymbols,
  INDEX_DIR,
};
