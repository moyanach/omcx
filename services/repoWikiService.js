/**
 * RepoWikiService — 基于仓库索引自动生成可缓存的 Repo Wiki
 *
 * 产物默认保存在 <workDir>/.omcx/wiki/，跟随项目一起归档；
 * 可通过 artifact_scope_wiki=global 回退到 <OMCX_HOME>/wiki/<workDirHash>/。
 * 生成输入由 Repo Map + README + 包清单组成，避免把整个仓库塞进上下文。
 */

const fs = require("fs");
const path = require("path");
const { buildRepoMapAsync, scanRepoAsync } = require("./repoIndexService");
const projectArtifactService = require("./projectArtifactService");
const { isAnthropicProvider, completeAnthropicMessage } = require("./anthropicClient");

const KIND = projectArtifactService.KIND.WIKI;
const MAX_INPUT_CHARS = 18000;
const DEFAULT_WIKI_CONTEXT_MAX_CHARS = 12000;

function wikiDir(workDir) {
  return projectArtifactService.resolveDir(KIND, workDir).dir;
}

function resolveWorkspaceWikiDirs(workDirs = [], primaryWorkDir = null) {
  const seen = new Set();
  const ordered = [];
  const pushDir = (dir) => {
    if (!dir || typeof dir !== "string" || !dir.trim()) return;
    const resolved = path.resolve(dir.trim());
    if (seen.has(resolved)) return;
    seen.add(resolved);
    ordered.push(resolved);
  };
  if (primaryWorkDir) pushDir(primaryWorkDir);
  if (Array.isArray(workDirs)) {
    for (const dir of workDirs) pushDir(dir);
  }
  return ordered;
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

async function buildWikiPrompt(workDir) {
  const repoMap = await buildRepoMapAsync(workDir, { maxChars: 9000, force: true });
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
  const index = await scanRepoAsync(workDir, { force: true });

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

  const prompt = await buildWikiPrompt(workDir);
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

  const index = await scanRepoAsync(workDir, { force: false });
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
  if (!dir) {
    return { success: false, error: "无法解析 Wiki 落盘目录" };
  }
  projectArtifactService.prepareDir(KIND, workDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wiki.md"), content, "utf-8");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  return { success: true, content, meta, path: path.join(dir, "wiki.md") };
}

function getRepoWiki(workDir) {
  if (!workDir) return { success: false, error: "缺少工作目录" };
  // 项目内优先，读不到时回退到升级前的全局目录，避免历史 Wiki 失效
  const candidates = projectArtifactService
    .readCandidates(KIND, workDir)
    .map((dir) => path.join(dir, "wiki.md"));
  const mdPath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  if (!mdPath) {
    return { success: true, exists: false, content: "", meta: null };
  }
  const metaPath = path.join(path.dirname(mdPath), "meta.json");
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

function getWorkspaceRepoWikis(workDirs = [], primaryWorkDir = null) {
  const dirs = resolveWorkspaceWikiDirs(workDirs, primaryWorkDir);
  const resolvedPrimary = primaryWorkDir ? path.resolve(primaryWorkDir) : dirs[0] || null;
  const items = dirs.map((dir) => {
    const res = getRepoWiki(dir);
    return {
      workDir: dir,
      name: path.basename(dir) || dir,
      isPrimary: Boolean(resolvedPrimary && dir === resolvedPrimary),
      success: Boolean(res?.success),
      exists: Boolean(res?.exists),
      content: res?.content || "",
      meta: res?.meta || null,
      path: res?.path || "",
      error: res?.error || undefined,
    };
  });
  return {
    success: true,
    primaryWorkDir: resolvedPrimary,
    totalCount: items.length,
    existingCount: items.filter((item) => item.exists).length,
    items,
  };
}

/**
 * 汇总多目录工作空间的 Repo Wiki，总预算默认控制在 12000 字符内，
 * 且优先保证主目录获得更多摘要篇幅，未用完的额度自动回拨给其他已生成目录。
 */
function buildWorkspaceRepoWikiContext({
  workDirs = [],
  primaryWorkDir = null,
  maxTotalChars = DEFAULT_WIKI_CONTEXT_MAX_CHARS,
} = {}) {
  const totalBudget = Math.max(500, Number(maxTotalChars) || DEFAULT_WIKI_CONTEXT_MAX_CHARS);
  const workspaceData = getWorkspaceRepoWikis(workDirs, primaryWorkDir);
  const available = workspaceData.items.filter(
    (item) => item.exists && typeof item.content === "string" && item.content.trim().length > 0
  );

  if (available.length === 0) {
    return {
      text: "",
      primaryPath: "",
      isMulti: workspaceData.totalCount > 1,
      generatedCount: 0,
      totalCount: workspaceData.totalCount,
      items: workspaceData.items,
    };
  }

  // 单目录或当前工作空间仅挂载 1 个目录时，沿用简洁单目录模式并给足预算
  if (workspaceData.totalCount <= 1 && available.length === 1) {
    const only = available[0];
    const trimmed = only.content.trim();
    const truncationNotice = `\n\n…(已按 ${totalBudget} 字符预算截断，完整内容请使用 read_file 读取 ${only.path || "wiki.md"})`;
    const body =
      trimmed.length > totalBudget
        ? `${trimmed.slice(0, Math.max(200, totalBudget - truncationNotice.length))}${truncationNotice}`
        : trimmed;
    return {
      text: body,
      primaryPath: only.path || "",
      isMulti: false,
      generatedCount: 1,
      totalCount: workspaceData.totalCount,
      items: workspaceData.items,
    };
  }

  // 多目录预算分配：先预留每个目录小标题与路径元信息开销，剩余全部按权重分给正文
  const buildHeader = (item) =>
    [
      `### ${item.name}${item.isPrimary ? "（主目录）" : "（次级目录）"}`,
      `- 仓库目录: ${item.workDir}`,
      item.path ? `- 完整文档路径: ${item.path}（需要细节时可用 read_file 查看）` : "",
    ]
      .filter(Boolean)
      .join("\n");

  const headers = available.map(buildHeader);
  const separatorOverhead = Math.max(0, available.length - 1) * 2;
  const headerTotalChars = headers.reduce((sum, h) => sum + h.length + 2, 0) + separatorOverhead;
  const contentBudget = Math.max(available.length * 160, totalBudget - headerTotalChars);

  const weights = available.map((item) => {
    if (item.isPrimary) {
      return available.length === 1 ? 1 : 0.55;
    }
    const hasPrimary = available.some((entry) => entry.isPrimary);
    const secondaryCount = available.length - (hasPrimary ? 1 : 0);
    return (hasPrimary ? 0.45 : 1) / Math.max(1, secondaryCount);
  });

  const allocations = new Array(available.length).fill(0);
  const fullLengths = available.map((item) => item.content.trim().length);
  let remainingBudget = contentBudget;
  let activeIndices = available.map((_, idx) => idx);

  // 迭代将短目录未耗尽的配额回拨给仍需篇幅的目录（主目录维持更高权重）
  while (remainingBudget > 0 && activeIndices.length > 0) {
    const activeWeightSum = activeIndices.reduce((sum, idx) => sum + weights[idx], 0) || 1;
    let consumedThisRound = 0;
    const nextActive = [];

    for (const idx of activeIndices) {
      const share = Math.max(1, Math.floor((remainingBudget * weights[idx]) / activeWeightSum));
      const needed = fullLengths[idx] - allocations[idx];
      const grant = Math.min(needed, share);
      allocations[idx] += grant;
      consumedThisRound += grant;
      if (allocations[idx] < fullLengths[idx]) {
        nextActive.push(idx);
      }
    }

    if (consumedThisRound <= 0) {
      // 剩余零头依次补给权重最高且仍未完整的目录（主目录优先）
      for (const idx of nextActive) {
        if (remainingBudget <= 0) break;
        allocations[idx] += 1;
        remainingBudget -= 1;
      }
      break;
    }
    remainingBudget -= consumedThisRound;
    activeIndices = nextActive;
  }

  const blocks = available.map((item, idx) => {
    const trimmed = item.content.trim();
    const limit = Math.max(80, allocations[idx]);
    let body = trimmed;
    if (trimmed.length > limit) {
      const suffix = `\n…(已按总预算截断，完整内容请 read_file ${item.path || "wiki.md"})`;
      const cut = Math.max(60, limit - suffix.length);
      body = `${trimmed.slice(0, cut)}${suffix}`;
    }
    return `${headers[idx]}\n\n${body}`;
  });

  const joined = blocks.join("\n\n");
  const primaryItem = available.find((item) => item.isPrimary) || available[0];
  return {
    text: joined.length > totalBudget ? joined.slice(0, totalBudget) : joined,
    primaryPath: primaryItem?.path || "",
    isMulti: true,
    generatedCount: available.length,
    totalCount: workspaceData.totalCount,
    items: workspaceData.items,
  };
}

module.exports = {
  generateRepoWiki,
  getRepoWiki,
  getWorkspaceRepoWikis,
  buildWorkspaceRepoWikiContext,
  resolveWorkspaceWikiDirs,
  buildWikiPrompt,
  wikiDir,
  DEFAULT_WIKI_CONTEXT_MAX_CHARS,
  WIKI_ROOT: projectArtifactService.globalDir(KIND),
};
