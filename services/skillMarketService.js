/**
 * skillMarketService.js — 技能市场：链接自适应分页拉取与一键下载
 *
 * 支持三类市场来源：
 * 1. JSON 列表接口（任意支持 page / pageSize / q 的 HTTP API，字段自动适配）
 * 2. GitHub 仓库 / 目录（Contents + Trees API，按页返回技能目录）
 * 3. 单个 SKILL.md / raw 链接（作为单条结果）
 *
 * 安全约定：仅 https/http 公网地址、12s 超时、响应体上限、禁止内网地址；
 * 下载内容只落盘到 ~/.omcx/skills，绝不执行。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const storageService = require("./storageService");

const REQUEST_TIMEOUT = 12000;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const PAGE_CACHE_TTL = 60 * 1000;
const TREE_CACHE_TTL = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 12;
const INSTALL_MAX_FILES = 80;
const INSTALL_MAX_FILE_BYTES = 2 * 1024 * 1024;
const INSTALL_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const pageCache = new Map();
const treeCache = new Map();

function assertSafeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    throw new Error("链接格式不正确");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("仅支持 http(s) 链接");
  }
  const host = parsed.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    throw new Error("不允许访问本地或内网地址");
  }
  return parsed;
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OMCX-Desktop-SkillMarket",
  };
  let token = "";
  try {
    token = storageService.getConfig("github_token") || "";
  } catch {}
  if (!token && process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN;
  if (typeof token === "string" && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function resolveFetch() {
  // 优先使用 Electron net.fetch：走 Chromium 网络栈，自动沿用系统代理与证书配置
  try {
    const electron = require("electron");
    if (electron?.net?.fetch) return electron.net.fetch.bind(electron.net);
  } catch {}
  return typeof fetch === "function" ? fetch : null;
}

async function requestText(rawUrl, headers = {}) {
  const url = assertSafeUrl(rawUrl);
  const fetcher = resolveFetch();
  if (!fetcher) throw new Error("当前环境不支持网络请求");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetcher(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "text/plain, application/json;q=0.9, */*;q=0.8",
        "User-Agent": "OMCX-Desktop-SkillMarket",
        ...headers,
      },
    });
    // 校验重定向后的最终地址，避免被跳转到内网
    assertSafeUrl(response.url || url.toString());
    if (!response.ok) {
      throw new Error(`请求失败 (HTTP ${response.status})`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new Error("响应内容过大，已拒绝");
    }
    return { text, contentType: response.headers.get("content-type") || "", finalUrl: response.url };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("请求超时，请检查网络或链接");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(rawUrl, headers) {
  const result = await requestText(rawUrl, headers);
  try {
    return { json: JSON.parse(result.text), finalUrl: result.finalUrl };
  } catch {
    throw new Error("该链接未返回合法的 JSON 数据");
  }
}

// ─── GitHub 适配 ─────────────────────────────────────────────
function parseGitHubUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, kind, ...rest] = parts;
  if (!owner || !repo) return null;
  if (kind === "tree" || kind === "blob") {
    const ref = rest[0] || "";
    const target = rest.slice(1);
    return {
      owner,
      repo: repo.replace(/\.git$/i, ""),
      ref,
      dirPath: kind === "blob" ? target.slice(0, -1).join("/") : target.join("/"),
      isBlob: kind === "blob",
      blobName: kind === "blob" ? target[target.length - 1] || "" : "",
    };
  }
  return { owner, repo: repo.replace(/\.git$/i, ""), ref: "", dirPath: "", isBlob: false };
}

async function loadGitHubSkillIndex(info) {
  const repoKey = `${info.owner}/${info.repo}`.toLowerCase();
  const cacheKey = `${repoKey}@${info.ref || "default"}#${info.dirPath || ""}#${info.isBlob ? info.blobName : ""}`;
  const cached = treeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TREE_CACHE_TTL) {
    return cached.value;
  }

  const repoMeta = await requestJson(
    `https://api.github.com/repos/${info.owner}/${info.repo}`,
    githubHeaders()
  );
  const meta = repoMeta.json || {};
  if (!meta.default_branch && meta.message) {
    throw new Error(`GitHub 仓库不可访问：${meta.message}`);
  }
  const branch = info.ref || meta.default_branch || "main";
  const treeRes = await requestJson(
    `https://api.github.com/repos/${info.owner}/${info.repo}/git/trees/${encodeURIComponent(
      branch
    )}?recursive=1`,
    githubHeaders()
  );
  const tree = Array.isArray(treeRes.json?.tree) ? treeRes.json.tree : [];
  const prefix = info.dirPath ? `${info.dirPath.replace(/^\/+|\/+$/g, "")}/` : "";

  if (info.isBlob) {
    const blob = tree.find((node) => node.type === "blob" && node.path === info.dirPath + "/" + info.blobName)
      || tree.find((node) => node.type === "blob" && node.path.endsWith("/" + info.blobName) && node.path.startsWith(prefix));
    const value = {
      branch,
      repo: `${info.owner}/${info.repo}`,
      items: blob
        ? [
            {
              id: `github:${repoKey}:${blob.path}`,
              name: path.basename(blob.path).replace(/\.md$/i, ""),
              description: `单文件技能 · ${repoKey}`,
              source: "github",
              sourceLabel: `github.com/${repoKey}`,
              installKind: "github-file",
              repo: `${info.owner}/${info.repo}`,
              ref: branch,
              filePath: blob.path,
            },
          ]
        : [],
      total: blob ? 1 : 0,
    };
    treeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  const scopedBlobs = tree.filter(
    (node) => node.type === "blob" && node.path.startsWith(prefix)
  );

  // 粘贴的目录自身就是一个技能（其下直接有 SKILL.md）
  const directDoc = scopedBlobs.find(
    (node) => node.path.toLowerCase() === `${prefix}skill.md`.toLowerCase()
  );
  if (directDoc) {
    const label = info.dirPath || info.repo;
    const items = [
      {
        id: `github:${repoKey}:${info.dirPath || "."}`,
        name: label.split("/").pop(),
        description: `GitHub 技能目录 · ${repoKey}${info.dirPath ? ` / ${info.dirPath}` : ""}`,
        source: "github",
        sourceLabel: `github.com/${repoKey}`,
        installKind: "github",
        repo: `${info.owner}/${info.repo}`,
        ref: branch,
        dirPath: prefix.replace(/\/+$/, ""),
      },
    ];
    const value = {
      branch,
      repo: `${info.owner}/${info.repo}`,
      items,
      total: 1,
      sourceLabel: `github.com/${repoKey}`,
    };
    treeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  const dirMap = new Map();
  for (const node of scopedBlobs) {
    if (!/(^|\/)skill\.md$/i.test(node.path)) continue;
    const dir = node.path.slice(0, node.path.lastIndexOf("/"));
    const relDir = dir.slice(prefix.length);
    if (relDir.split("/").filter(Boolean).length > 3) continue;
    if (!relDir) continue;
    dirMap.set(relDir, node.path);
  }

  // 兜底：<dir>/<dir>.md 形态的技能
  for (const node of scopedBlobs) {
    const rel = node.path.slice(prefix.length);
    const match = rel.match(/(?:^|\/)([^/]+)\/\1\.md$/i);
    if (!match) continue;
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    if (dir.split("/").filter(Boolean).length > 3 || dirMap.has(dir)) continue;
    dirMap.set(dir, node.path);
  }

  const items = Array.from(dirMap.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((relDir) => ({
      id: `github:${repoKey}:${relDir}`,
      name: relDir.split("/").pop(),
      description: `GitHub 技能目录 · ${repoKey}${relDir ? ` / ${relDir}` : ""}`,
      source: "github",
      sourceLabel: `github.com/${repoKey}`,
      installKind: "github",
      repo: `${info.owner}/${info.repo}`,
      ref: branch,
      dirPath: `${prefix}${relDir}`.replace(/\/+$/, ""),
    }));

  const value = {
    branch,
    repo: `${info.owner}/${info.repo}`,
    items,
    total: items.length,
    sourceLabel: `github.com/${repoKey}`,
    dirPath: prefix,
  };
  treeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// ─── JSON 适配 ───────────────────────────────────────────────
function findList(payload) {
  if (Array.isArray(payload)) return { list: payload, meta: {} };
  if (!payload || typeof payload !== "object") return { list: [], meta: {} };

  const keys = ["items", "skills", "data", "results", "list", "entries", "servers", "records"];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return { list: value, meta: payload };
    if (value && typeof value === "object") {
      const nested = findList(value);
      if (nested.list.length > 0 || Array.isArray(nested.list)) {
        return { list: nested.list, meta: { ...payload, ...value } };
      }
    }
  }
  return { list: [], meta: payload };
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return null;
}

function normalizeJsonItem(raw, index, baseUrl) {
  if (!raw || typeof raw !== "object") return null;
  const name = pickString(raw.name, raw.title, raw.slug, raw.id, raw.skillName);
  if (!name) return null;

  const repoValue = raw.repo || raw.repository || raw.repoUrl || raw.repositoryUrl;
  const repo =
    typeof repoValue === "string"
      ? repoValue
      : pickString(repoValue?.fullName, repoValue?.full_name, repoValue?.name, repoValue?.url);

  const downloadUrl = pickString(
    raw.downloadUrl,
    raw.download_url,
    raw.rawUrl,
    raw.raw_url,
    raw.fileUrl,
    raw.file_url,
    raw.contentUrl
  );

  let resolvedDownload = downloadUrl;
  if (!resolvedDownload && typeof raw.url === "string" && /\.(md|markdown|zip)(\?|$)/i.test(raw.url)) {
    resolvedDownload = raw.url;
  }
  if (!resolvedDownload && raw.url) {
    try {
      resolvedDownload = new URL(raw.url, baseUrl).toString();
    } catch {}
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => (typeof tag === "string" ? tag : tag?.name)).filter(Boolean).slice(0, 6)
    : [];

  return {
    id: pickString(raw.id, raw.slug, raw.name) || `market:${index}`,
    name,
    description: pickString(raw.description, raw.summary, raw.desc, raw.intro),
    version: pickString(raw.version, raw.latestVersion, raw.latest_version),
    author: typeof raw.author === "string" ? raw.author : pickString(raw.author?.name, raw.owner),
    tags,
    source: "json",
    sourceLabel: (() => {
      try {
        return new URL(baseUrl).hostname;
      } catch {
        return "市场";
      }
    })(),
    installKind: downloadUrl || resolvedDownload ? "raw" : repo ? "github" : "unknown",
    downloadUrl: resolvedDownload,
    repo,
    dirPath: pickString(raw.path, raw.dir, raw.directory),
    raw: undefined,
  };
}

function buildPageUrl(baseUrl, page, pageSize, query) {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  if (query) url.searchParams.set("q", query);
  return url.toString();
}

async function fetchJsonMarketPage({ url, page, pageSize, query }) {
  const key = `${url}|${page}|${pageSize}|${query || ""}`;
  const cached = pageCache.get(key);
  if (cached && Date.now() - cached.at < PAGE_CACHE_TTL) return cached.value;

  const { json, finalUrl } = await requestJson(buildPageUrl(url, page, pageSize, query));
  const { list, meta } = findList(json);
  const items = list
    .map((item, index) => normalizeJsonItem(item, index, finalUrl || url))
    .filter(Boolean);

  const pagination = meta?.pagination || meta?.pageInfo || meta?.paging || {};
  const total = pickNumber(
    meta?.total,
    meta?.totalCount,
    meta?.total_count,
    meta?.count,
    pagination.total,
    pagination.totalCount,
    pagination.count
  );
  const hasMoreFlag = meta?.hasMore ?? meta?.has_more ?? pagination.hasMore ?? pagination.has_more;
  const nextCursor = meta?.next ?? pagination.next;
  const hasMore =
    typeof hasMoreFlag === "boolean"
      ? hasMoreFlag
      : total != null
      ? page * pageSize < total
      : typeof nextCursor === "string"
      ? Boolean(nextCursor)
      : items.length >= pageSize;

  const value = {
    success: true,
    source: "json",
    sourceLabel: (() => {
      try {
        return new URL(finalUrl || url).hostname;
      } catch {
        return "市场";
      }
    })(),
    items,
    page,
    pageSize,
    // 接口未返回总数时给出已加载下界，前端按“至少 N 项”展示
    total: total != null ? total : (page - 1) * pageSize + items.length,
    hasMore,
  };
  pageCache.set(key, { at: Date.now(), value });
  return value;
}

// ─── 统一入口 ────────────────────────────────────────────────
async function fetchMarketPage({ url, page = 1, pageSize = DEFAULT_PAGE_SIZE, query = "" } = {}) {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) return { success: false, error: "请先填入技能市场链接" };

  const safePage = Math.max(1, Math.min(500, Math.round(Number(page) || 1)));
  const safeSize = Math.max(1, Math.min(60, Math.round(Number(pageSize) || DEFAULT_PAGE_SIZE)));

  try {
    assertSafeUrl(rawUrl);

    const github = parseGitHubUrl(rawUrl);
    if (github) {
      const index = await loadGitHubSkillIndex(github);
      let items = index.items;
      if (query) {
        const needle = query.toLowerCase();
        items = items.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) ||
            (item.description || "").toLowerCase().includes(needle)
        );
      }
      const start = (safePage - 1) * safeSize;
      const pageItems = items.slice(start, start + safeSize);
      return {
        success: true,
        source: "github",
        sourceLabel: index.sourceLabel,
        items: pageItems,
        page: safePage,
        pageSize: safeSize,
        total: items.length,
        hasMore: start + safeSize < items.length,
      };
    }

    if (/\.(md|markdown)(\?|$)/i.test(rawUrl)) {
      const name = decodeURIComponent(rawUrl.split("?")[0].split("/").pop() || "").replace(
        /\.(md|markdown)$/i,
        ""
      );
      return {
        success: true,
        source: "raw",
        sourceLabel: (() => {
          try {
            return new URL(rawUrl).hostname;
          } catch {
            return "直链";
          }
        })(),
        items: [
          {
            id: `raw:${rawUrl}`,
            name: name || "未命名技能",
            description: "单个 Markdown 技能文件直链",
            source: "raw",
            installKind: "raw",
            downloadUrl: rawUrl,
          },
        ],
        page: 1,
        pageSize: safeSize,
        total: 1,
        hasMore: false,
      };
    }

    return await fetchJsonMarketPage({ url: rawUrl, page: safePage, pageSize: safeSize, query });
  } catch (err) {
    return { success: false, error: err.message || "拉取技能市场失败" };
  }
}

// ─── 下载安装 ────────────────────────────────────────────────
function sanitizeRelativePath(raw) {
  const normalized = String(raw || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
  return normalized;
}

async function downloadRawSkill(item, overwrite) {
  const url = item.downloadUrl || item.rawUrl;
  if (!url) return { success: false, error: "该条目缺少可下载地址" };

  const { text } = await requestText(url);
  if (!text.trim()) return { success: false, error: "下载内容为空" };
  if (/^<!doctype|^<html/i.test(text.trimStart())) {
    return { success: false, error: "该链接返回的是网页而不是技能文件" };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-market-"));
  const tempFile = path.join(tempDir, `${sanitizeRelativePath(item.name) || "skill"}.md`);
  try {
    fs.writeFileSync(tempFile, text, "utf-8");
    return await storageService.importSkill(tempFile, { overwrite });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function downloadGitHubSkill(item, overwrite) {
  const repo = String(item.repo || "").trim();
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { success: false, error: "该条目缺少有效的 GitHub 仓库信息" };
  }
  const [owner, name] = repo.split("/");
  const info = {
    owner,
    repo: name,
    ref: item.ref || "",
    dirPath: String(item.dirPath || "").replace(/^\/+|\/+$/g, ""),
    isBlob: item.installKind === "github-file",
    blobName: item.installKind === "github-file" ? path.basename(item.filePath || "") : "",
  };

  const index = await loadGitHubSkillIndex(info);
  const branch = item.ref || index.branch;

  let blobs = [];
  if (item.installKind === "github-file" && item.filePath) {
    blobs = [{ path: item.filePath }];
  } else {
    const treeRes = await requestJson(
      `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(
        branch
      )}?recursive=1`,
      githubHeaders()
    );
    const tree = Array.isArray(treeRes.json?.tree) ? treeRes.json.tree : [];
    const prefix = `${item.dirPath || ""}`.replace(/^\/+|\/+$/g, "");
    const scoped = tree.filter(
      (node) =>
        node.type === "blob" &&
        (prefix
          ? node.path === prefix || node.path.startsWith(`${prefix}/`)
          : !node.path.includes("/"))
    );
    blobs = scoped.slice(0, INSTALL_MAX_FILES);
  }

  if (blobs.length === 0) {
    return { success: false, error: "未在该目录下找到可下载的技能文件" };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-market-"));
  let totalBytes = 0;
  try {
    const base = item.installKind === "github-file" ? "" : `${item.dirPath || ""}`.replace(/^\/+|\/+$/g, "");
    for (const blob of blobs) {
      const rel =
        item.installKind === "github-file"
          ? sanitizeRelativePath(path.basename(blob.path))
          : sanitizeRelativePath(
              base && blob.path.startsWith(`${base}/`) ? blob.path.slice(base.length + 1) : blob.path
            );
      if (!rel) continue;
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(
        branch
      )}/${blob.path.split("/").map(encodeURIComponent).join("/")}`;
      let text = "";
      try {
        text = (await requestText(rawUrl)).text;
      } catch {
        continue;
      }
      const size = Buffer.byteLength(text, "utf-8");
      if (size > INSTALL_MAX_FILE_BYTES) continue;
      if (totalBytes + size > INSTALL_MAX_TOTAL_BYTES) break;
      totalBytes += size;
      const target = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, "utf-8");
    }

    return await storageService.importSkill(tempDir, { overwrite });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function installSkill(item, options = {}) {
  const overwrite = Boolean(options?.overwrite);
  if (!item || typeof item !== "object") {
    return { success: false, error: "缺少技能信息" };
  }

  try {
    const kind = item.installKind || (item.downloadUrl ? "raw" : item.repo ? "github" : "unknown");
    if (kind === "github" || kind === "github-file") {
      return await downloadGitHubSkill({ ...item, installKind: kind }, overwrite);
    }
    if (kind === "raw" || item.downloadUrl) {
      return await downloadRawSkill(item, overwrite);
    }
    return { success: false, error: "该市场条目暂不支持直接下载" };
  } catch (err) {
    return { success: false, error: err.message || "下载技能失败" };
  }
}

module.exports = {
  fetchMarketPage,
  installSkill,
};
