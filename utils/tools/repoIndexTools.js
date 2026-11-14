const { z } = require("zod");
const { StructuredTool } = require("./baseTool");
const { buildRepoMap, searchSymbols, getRepoStats, findReferences } = require("../../services/repoIndexService");

class RepoMapTool extends StructuredTool {
  constructor() {
    super();
    this.name = "repo_map";
    this.description =
      "获取当前工作区的仓库符号地图 (Repo Map)：按目录列出高价值源码文件及其类/函数/接口/类型符号与行号。适用于快速建立大型仓库的整体认知，避免盲目逐文件读取。参数 refresh=true 可强制重建索引。";
    this.schema = z.object({
      maxChars: z
        .number()
        .int()
        .min(800)
        .max(20000)
        .optional()
        .describe("Repo Map 最大字符数，默认 6000"),
      refresh: z.boolean().optional().describe("是否强制重新扫描仓库索引"),
    });
  }

  async _call({ maxChars, refresh, __workDir }) {
    if (!__workDir) {
      return JSON.stringify({ success: false, error: "当前会话未绑定工作目录" });
    }
    try {
      const map = buildRepoMap(__workDir, {
        maxChars: maxChars || 6000,
        force: Boolean(refresh),
      });
      const stats = getRepoStats(__workDir, { force: false });
      return JSON.stringify({
        success: true,
        map: map || "(未扫描到可索引的源码符号)",
        stats,
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }
  }
}

class SearchSymbolsTool extends StructuredTool {
  constructor() {
    super();
    this.name = "search_symbols";
    this.description =
      "按名称检索仓库中的类、函数、接口、类型、方法等符号，返回 `文件:行号` 与符号类型。适合已知符号名但不知道定义位置时使用；纯文本内容检索请继续使用 search_code。";
    this.schema = z.object({
      query: z.string().describe("符号名称或片段，例如 AgentLoop、createWindow、parseConfig"),
      limit: z.number().int().min(1).max(200).optional().describe("返回数量上限，默认 40"),
    });
  }

  async _call({ query, limit, __workDir }) {
    if (!__workDir) {
      return JSON.stringify({ success: false, error: "当前会话未绑定工作目录" });
    }
    try {
      const results = searchSymbols(__workDir, query, { limit: limit || 40 });
      return JSON.stringify({
        success: true,
        query,
        count: results.length,
        results: results.map((item) => ({
          name: item.name,
          kind: item.kind,
          path: item.path,
          line: item.line,
          language: item.language,
          location: `${item.path}:${item.line}`,
        })),
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }
  }
}

class FindReferencesTool extends StructuredTool {
  constructor() {
    super();
    this.name = "find_references";
    this.description =
      "检索某个符号在仓库中的定义、调用点与普通引用，返回 `文件:行号` 与分类（definition/call/reference）。用于评估改动影响面、定位调用图上下游；纯文本模式检索请使用 search_code。";
    this.schema = z.object({
      symbol: z.string().describe("要检索的符号名，例如 buildSystemContext、storageService"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("返回的引用数量上限，默认 60"),
    });
  }

  async _call({ symbol, limit, __workDir }) {
    if (!__workDir) {
      return JSON.stringify({ success: false, error: "当前会话未绑定工作目录" });
    }
    try {
      const result = findReferences(__workDir, symbol, { limit: limit || 60 });
      return JSON.stringify({ success: true, ...result });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }
  }
}

module.exports = {
  RepoMapTool,
  SearchSymbolsTool,
  FindReferencesTool,
};
