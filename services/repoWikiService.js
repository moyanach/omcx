/**
 * RepoWikiService — 基于仓库索引自动生成可缓存的 Repo Wiki
 *
 * 产物保存在 ~/.omcx/wiki/<workDirHash>/wiki.md，不污染用户仓库；
 * 生成输入由 Repo Map + README + 包清单组成，避免把整个仓库塞进上下文。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { buildRepoMap, scanRepo } = require("./repoIndexService");
const { isAnthropicProvider, completeAnthropicMessage } = require("./anthropicClient");

const WIKI_ROOT = path.join(
  process.env.OMCX_HOME || path.join(os.homedir(), ".omcx"),
  "wiki"
);
const MAX_INPUT_CHARS = 18000;

function hashWorkDir(workDir) {
  return crypto.createHash("sha1").update(path.resolve(workDir)).digest("hex").slice(0, 20);
}

function wikiDir(workDir) {
  return path.join(WIKI_ROOT, hashWorkDir(workDir));
}

function readFirstExisting(workDir, names, maxChars) {
  for (const name of names) {
    try {
      const filePath = path.join(workDir, name);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      return { name, content: content.slice(0, maxChars) };
    } catch {
      // 继续尝试下一个候选文件
    }
  }
  return null;
}

function buildWikiPrompt(workDir) {
  const repoMap = buildRepoMap(workDir, { maxChars: 9000, force: true });
  const readme = readFirstExisting(
    workDir,
    ["README.md", "README.zh-CN.md", "README_EN.md", "readme.md", "Readme.md"],
    6000
  );
  const manifest = readFirstExisting(
    workDir,
    ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"],
    4000
  );
  const index = scanRepo(workDir, { force: true });

  const parts = [
    `仓库根目录: ${workDir}`,
    `文件规模: ${index.stats.fileCount} 个含符号文件 / ${index.stats.symbolCount} 个符号`,
    `语言分布: ${JSON.stringify(index.stats.languages)}`,
    "",
    "## Repo Map",
    repoMap || "(未扫描到符号)",
  ];
  if (readme) parts.push("", `## ${readme.name}`, readme.content);
  if (manifest) parts.push("", `## ${manifest.name}`, manifest.content);

  const input = parts.join("\n").slice(0, MAX_INPUT_CHARS);
  return [
    "你是资深软件架构师。请仅根据以下仓库索引、README 与构建清单，生成一份中文 Repo Wiki。",
    "要求：",
    "1. 使用 Markdown，二级标题分节；",
    "2. 必含章节：项目概览、技术栈、目录结构、核心模块与职责、关键数据流/调用链、构建与运行、开发约定与风险点；",
    "3. 只陈述有证据的内容，无法确认的部分明确标注“待确认”，严禁编造不存在的模块；",
    "4. 关键模块尽量使用 `路径:行号` 或 `路径` 引用；",
    "5. 控制在 1500-3000 字，避免空话。",
    "",
    "仓库资料：",
    input,
  ].join("\n");
}

async function completeWithOpenAI({ baseUrl, apiKey, model, prompt, maxTokens, signal }) {
  const base = String(baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "你是严谨的软件架构文档生成器，只输出 Markdown 正文，不要添加任何解释性前后缀。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Wiki 生成接口返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  return {
    content: data?.choices?.[0]?.message?.content || "",
    usage: data?.usage || null,
  };
}

async function generateRepoWiki({ workDir, modelConfig, signal } = {}) {
  if (!workDir || !fs.existsSync(workDir)) {
    return { success: false, error: "工作目录不存在" };
  }
  if (!modelConfig || !modelConfig.model_id) {
    return { success: false, error: "缺少可用模型配置" };
  }

  const prompt = buildWikiPrompt(workDir);
  const maxTokens = Number(modelConfig.max_output_tokens) || 4096;

  let result;
  if (isAnthropicProvider(modelConfig.provider, modelConfig.base_url)) {
    result = await completeAnthropicMessage({
      baseUrl: modelConfig.base_url,
      apiKey: modelConfig.api_key,
      model: modelConfig.model_id,
      system:
        "你是严谨的软件架构文档生成器，只输出 Markdown 正文，不要添加任何解释性前后缀。",
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      temperature: 0.2,
      signal,
    });
  } else {
    result = await completeWithOpenAI({
      baseUrl: modelConfig.base_url,
      apiKey: modelConfig.api_key,
      model: modelConfig.model_id,
      prompt,
      maxTokens,
      signal,
    });
  }

  const content = String(result.content || "").trim();
  if (!content) {
    return { success: false, error: "模型未返回 Wiki 内容" };
  }

  const index = scanRepo(workDir, { force: false });
  const meta = {
    workDir: path.resolve(workDir),
    generatedAt: Date.now(),
    model: modelConfig.model_id,
    fileCount: index.stats.fileCount,
    symbolCount: index.stats.symbolCount,
    languages: index.stats.languages,
    usage: result.usage || null,
  };

  const dir = wikiDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wiki.md"), content, "utf-8");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  return { success: true, content, meta, path: path.join(dir, "wiki.md") };
}

function getRepoWiki(workDir) {
  if (!workDir) return { success: false, error: "缺少工作目录" };
  const dir = wikiDir(workDir);
  const mdPath = path.join(dir, "wiki.md");
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(mdPath)) {
    return { success: true, exists: false, content: "", meta: null };
  }
  try {
    const content = fs.readFileSync(mdPath, "utf-8");
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch {}
    return { success: true, exists: true, content, meta, path: mdPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  generateRepoWiki,
  getRepoWiki,
  buildWikiPrompt,
  WIKI_ROOT,
};
