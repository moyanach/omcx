/**
 * webTools — 基于 LangChain StructuredTool 的互联网搜索工具
 *
 * 支持多搜索引擎自动 fallback、网页内容抓取、结构化输出。
 * 搜索函数从 main.js 迁出以支持 LangChain Agent 复用。
 */

const dns = require("dns");
const net = require("net");
const { z } = require("zod");
const { StructuredTool } = require("./baseTool");
const cheerio = require("cheerio");

const MAX_SCRAPE_BYTES = 2 * 1024 * 1024;

function isPrivateOrRestrictedIp(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^::ffff:/i, "");
  if (net.isIPv4(clean)) {
    const parts = clean.split(".").map((n) => parseInt(n, 10));
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 链路本地 & 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  if (net.isIPv6(clean)) {
    const lower = clean.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
    if (lower.startsWith("ff")) return true;
    return false;
  }
  return true;
}

async function validatePublicFetchUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("URL 格式无效");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`不支持的抓取协议: ${parsed.protocol}`);
  }
  const host = (parsed.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`出于安全策略，禁止抓取本机或内网域名: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateOrRestrictedIp(host)) {
      throw new Error(`出于安全策略，禁止抓取内网/回环/元数据 IP: ${host}`);
    }
    return parsed.toString();
  }
  try {
    const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (Array.isArray(addrs) && addrs.some((entry) => isPrivateOrRestrictedIp(entry.address))) {
      throw new Error(`目标域名解析到内网或保留 IP，已拦截抓取: ${host}`);
    }
  } catch (err) {
    if (err?.message?.includes("已拦截")) throw err;
  }
  return parsed.toString();
}

async function readResponseTextBounded(response, maxBytes = MAX_SCRAPE_BYTES) {
  const ctype = (response.headers.get("content-type") || "").toLowerCase();
  if (ctype && !/(text\/|html|xml|json|xhtml|javascript)/i.test(ctype)) {
    throw new Error(`不支持的响应内容类型: ${ctype.split(";")[0]}`);
  }
  const contentLen = Number(response.headers.get("content-length") || 0);
  if (contentLen > maxBytes) {
    throw new Error(`网页体积过大 (${Math.round(contentLen / 1024)} KB)，已超过 ${Math.round(maxBytes / 1024)} KB 安全上限`);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const remaining = maxBytes - total;
        if (remaining <= 0) break;
        if (value.byteLength > remaining) {
          chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
          total += remaining;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf-8");
}

// ─── 通用 fetch 封装（带超时、abort 控制） ───────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── 搜索引擎实现 ────────────────────────────────────────────

async function searchGoogleHtml(query, maxResults) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  }, 6000);
  if (!response.ok) throw new Error(`Google HTTP Error: ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];
  $("div.g").each((i, el) => {
    if (results.length >= maxResults) return false;
    const titleEl = $(el).find("h3").first();
    const linkEl = $(el).find("a").first();
    const snippetEl = $(el).find("span.aCOpRe, div.VwiC3b, span.st").first();
    const title = titleEl.text().trim();
    let href = linkEl.attr("href") || "";
    let realUrl = href;
    if (href.startsWith("/url?q=")) {
      try { realUrl = decodeURIComponent(href.replace("/url?q=", "").split("&")[0]); } catch (e) {}
    }
    if (title && realUrl.startsWith("http")) {
      results.push({ title, url: realUrl, snippet: snippetEl.text().trim().substring(0, 300) });
    }
  });
  return results;
}

async function searchMojeek(query, maxResults) {
  const mojeekApiKey = process.env.MOJEEK_API_KEY || "";
  if (!mojeekApiKey) throw new Error("MOJEEK_API_KEY not configured");
  const url = `https://api.mojeek.com/search?q=${encodeURIComponent(query)}&fmt=json&t=${Math.min(maxResults, 10)}&api_key=${mojeekApiKey}`;
  const response = await fetchWithTimeout(url, {}, 6000);
  if (!response.ok) throw new Error(`Mojeek API Error: ${response.status}`);
  const data = await response.json();
  return (data.results || []).map((r) => ({ title: r.title || "", url: r.url, snippet: r.desc || "" }));
}

async function searchDuckDuckGo(query, maxResults) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  }, 6000);
  if (!response.ok) throw new Error(`DuckDuckGo Lite HTTP Error: ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const links = [];
  $("a.result-link").each((i, el) => links.push({ title: $(el).text().trim(), url: $(el).attr("href") }));
  const snippets = [];
  $("td.result-snippet").each((i, el) => snippets.push($(el).text().trim()));
  const results = [];
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    let finalUrl = links[i].url;
    if (finalUrl.startsWith("//")) finalUrl = "https:" + finalUrl;
    if (finalUrl.includes("duckduckgo.com/l/?")) {
      try {
        const urlObj = new URL(finalUrl);
        const uParam = urlObj.searchParams.get("uddg");
        if (uParam) finalUrl = decodeURIComponent(uParam);
      } catch (e) {}
    }
    results.push({ title: links[i].title, url: finalUrl, snippet: snippets[i] || "" });
  }
  return results;
}

// ─── 组合搜索：多引擎自动 fallback ──────────────────────────

async function performWebSearch(query, searchConfig) {
  const { provider = "duckduckgo", apiKey = "", maxResults = 3 } = searchConfig || {};

  // 1. Tavily API
  if (provider === "tavily" && apiKey) {
    try {
      const resp = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", include_answer: false, max_results: maxResults }),
      }, 8000);
      if (resp.ok) {
        const data = await resp.json();
        return { results: (data.results || []).map(r => ({ title: r.title || "未知网页", url: r.url, snippet: r.content || "" })), engine: "tavily" };
      }
    } catch (e) { /* fall through */ }
  }

  // 2. Mojeek
  try {
    const results = await searchMojeek(query, maxResults);
    if (results.length > 0) return { results, engine: "mojeek" };
  } catch (e) { /* fall through */ }

  // 3. DuckDuckGo
  try {
    const results = await searchDuckDuckGo(query, maxResults);
    if (results.length > 0) return { results, engine: "duckduckgo" };
  } catch (e) { /* fall through */ }

  // 4. Google HTML
  try {
    const results = await searchGoogleHtml(query, maxResults);
    if (results.length > 0) return { results, engine: "google" };
  } catch (e) { /* fall through */ }

  return { results: [], engine: "none" };
}

// ─── 网页内容抓取 ───────────────────────────────────────────

async function scrapePageContent(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const safeUrl = await validatePublicFetchUrl(url);
    const response = await fetch(safeUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!response.ok) throw new Error(`HTTP 错误 ${response.status}`);
    if (response.url && response.url !== safeUrl) {
      await validatePublicFetchUrl(response.url);
    }
    const html = await readResponseTextBounded(response, MAX_SCRAPE_BYTES);
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, iframe, noscript, svg, form, aside, link").remove();
    const title = $("title").text().trim() || "";
    let bodyText = $("body").text() || "";
    bodyText = bodyText.replace(/\r/g, "\n").replace(/\n\s*\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    return { title, cleanText: bodyText.substring(0, 4000), success: true };
  } catch (err) {
    return { title: "", cleanText: "", success: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── 工具: web_search ────────────────────────────────────────

class WebSearchTool extends StructuredTool {
  constructor(searchConfig) {
    super();
    this.name = "web_search";
    this.description = "搜索互联网获取实时信息。适合查询新闻、最新动态、专业知识、技术文档、实时数据等。搜索后自动爬取前3个结果返回正文摘要。";
    this.schema = z.object({
      query: z.string().describe("搜索关键词，越具体越好。支持中文、英文等任意语言。"),
    });
    this.searchConfig = searchConfig;
  }

  async _call({ query }) {
    const searchResult = await performWebSearch(query, this.searchConfig);
    const results = searchResult.results || [];
    const engine = searchResult.engine || "none";

    // 爬取前 3 个结果
    const crawlPromises = results.slice(0, 3).map(async (r) => {
      const scrapeRes = await scrapePageContent(r.url);
      return {
        title: scrapeRes.title || r.title || "",
        url: r.url,
        snippet: r.snippet || "",
        content: scrapeRes.cleanText || "",
        success: scrapeRes.success,
      };
    });
    const crawled = await Promise.all(crawlPromises);

    return JSON.stringify({
      success: true,
      query,
      engine,
      totalResults: results.length,
      results: crawled,
    });
  }
}

// ─── 工具: web_fetch ────────────────────────────────────────

class WebFetchTool extends StructuredTool {
  constructor() {
    super();
    this.name = "web_fetch";
    this.description = "抓取指定网页的内容并返回文本摘要。适合阅读在线文档、博客文章、新闻等。配合 web_search 使用效果更佳。";
    this.schema = z.object({
      url: z.string().describe("要抓取的网页完整 URL（需包含 http:// 或 https:// 协议头）"),
    });
  }

  async _call({ url }) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return JSON.stringify({ success: false, error: "URL 需包含 http:// 或 https:// 协议头" });
    }
    const result = await scrapePageContent(url);
    return JSON.stringify({
      success: result.success,
      url,
      title: result.title || "",
      content: result.cleanText || "",
      error: result.error || undefined,
    });
  }
}

module.exports = {
  performWebSearch,
  scrapePageContent,
  WebSearchTool,
  WebFetchTool,
};