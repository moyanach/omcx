/**
 * documentTools — 办公文档原生解析与结构化生成工具
 *
 * 1. read_document: 支持 PDF / DOCX / DOC / XLSX / XLSM / CSV / TSV / PPTX 的大纲、分页、按表、关键词检索及全表聚合统计
 * 2. generate_document: 支持生成专业排版的 DOCX / XLSX / PPTX 交付物
 */

const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { StructuredTool } = require("./baseTool");
const { checkSafePath } = require("./fileTools");
const { fileLockService } = require("../../services/fileLockService");
const documentService = require("../../services/documentService");

const WhereConditionSchema = z.object({
  column: z.string().describe("要过滤的列名"),
  op: z
    .enum([
      "eq",
      "neq",
      "contains",
      "not_contains",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "is_empty",
      "not_empty",
    ])
    .optional()
    .default("eq")
    .describe("过滤操作符"),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ])
    .optional()
    .describe("比较值（in 操作符传数组，is_empty/not_empty 可省略）"),
});

const AggregateMetricSchema = z.object({
  column: z.string().optional().describe("要聚合的列名（op 为 count 时可省略）"),
  op: z
    .enum(["count", "count_distinct", "sum", "avg", "min", "max", "median"])
    .describe("聚合函数：count / count_distinct / sum / avg / min / max / median"),
  as: z.string().optional().describe("输出指标字段名（省略时自动生成）"),
});

class ReadDocumentTool extends StructuredTool {
  constructor() {
    super();
    this.name = "read_document";
    this.description =
      "原生读取、检索与统计办公文档内容，支持 .pdf / .docx / .doc / .xlsx / .xlsm / .csv / .tsv / .pptx。支持四种模式：outline（查看页数/工作表/列名）、read（按页码或工作表行范围分页读取）、search（跨页/跨表关键词搜索）、aggregate（针对 XLSX/XLSM/CSV/TSV 的全表精确过滤、多维分组交叉汇总、计数/去重计数/求和/均值/中位数及列分布画像）。分析大表格统计数据时应直接调用 aggregate 模式，无需用 run_command 写 Python 脚本。";
    this.schema = z.object({
      path: z.string().describe("文档路径，相对于工作目录或绝对路径"),
      mode: z
        .enum(["outline", "read", "search", "aggregate"])
        .optional()
        .default("read")
        .describe(
          "读取模式：outline（查目录/页数/工作表）、read（分页读取）、search（全文检索）、aggregate（表格全量过滤与分组聚合统计）"
        ),
      sheet: z.string().optional().describe("XLSX/XLSM 指定工作表名称（省略时读取首个工作表）"),
      startPage: z.number().optional().describe("PDF / PPTX 起始页码（从 1 开始，默认 1）"),
      endPage: z.number().optional().describe("PDF / PPTX 结束页码（默认每次最多读取 10~20 页）"),
      startRow: z.number().optional().describe("表格或 DOCX 起始行号（从 0 开始，默认 0）"),
      maxRows: z.number().optional().describe("表格或 DOCX 最多读取行数（默认表格 120 行、DOCX 400 行）"),
      query: z.string().optional().describe("search 模式下的搜索关键词"),
      headerRow: z
        .number()
        .optional()
        .describe("aggregate 模式下表头所在行号（从 1 开始，默认第 1 行；若前几行为说明文字可指定实际表头行）"),
      where: z
        .array(WhereConditionSchema)
        .optional()
        .describe("aggregate 模式下的行过滤条件列表（AND 关系）"),
      groupBy: z
        .array(z.string())
        .optional()
        .describe("aggregate 模式下的分组列名数组（可单维或多维交叉分组；省略且无 metrics 时返回全表列画像）"),
      metrics: z
        .array(AggregateMetricSchema)
        .optional()
        .describe("aggregate 模式下要计算的聚合指标列表"),
      sortBy: z.string().optional().describe("aggregate 结果排序字段名（如 count 或指标别名 as，默认按第一指标或 count 降序）"),
      sortOrder: z.enum(["asc", "desc"]).optional().default("desc").describe("排序方向"),
      limit: z.number().optional().default(50).describe("aggregate 返回分组行数上限（默认 50，最大 500）"),
      maxChars: z.number().optional().default(24000).describe("返回文本最大字符数上限（默认 24000）"),
    });
  }

  async _call(rawArgs) {
    const {
      path: filePath,
      mode = "read",
      sheet,
      startPage,
      endPage,
      startRow,
      maxRows,
      query,
      headerRow,
      where,
      groupBy,
      metrics,
      sortBy,
      sortOrder,
      limit,
      maxChars = 24000,
      __workDir,
      __allowedFolders,
      __checkPermission,
      __toolContext,
    } = rawArgs || {};

    const targetFilePath = filePath ?? rawArgs?.filepath ?? rawArgs?.file_path ?? rawArgs?.file;
    if (!targetFilePath || typeof targetFilePath !== "string" || !targetFilePath.trim()) {
      return JSON.stringify({ success: false, error: "read_document 调用失败: 缺少有效的文档路径 path 参数" });
    }

    let targetPath;
    try {
      targetPath = await checkSafePath(
        targetFilePath,
        __workDir,
        __allowedFolders,
        __checkPermission,
        "读取文档",
        { mode: "read", toolContext: __toolContext }
      );
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }

    if (!fs.existsSync(targetPath)) {
      return JSON.stringify({ success: false, error: `文档不存在: ${targetFilePath}` });
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return JSON.stringify({ success: false, error: `路径不是文件: ${targetFilePath}` });
    }

    try {
      const result = await documentService.readDocument(targetPath, {
        mode,
        sheet,
        startPage,
        endPage,
        startRow,
        maxRows,
        query,
        headerRow,
        where,
        groupBy,
        metrics,
        sortBy,
        sortOrder,
        limit,
        maxChars,
      });
      return JSON.stringify({
        success: true,
        path: targetFilePath,
        size: stat.size,
        ...result,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: `读取文档失败: ${err.message}`,
      });
    }
  }
}

const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

class GenerateDocumentTool extends StructuredTool {
  constructor() {
    super();
    this.name = "generate_document";
    this.description =
      "直接生成结构化办公交付文档（支持 .docx Word 文档、.xlsx 多表 Excel 表格、.pptx 幻灯片演示文稿），无需临时脚本即可产出规范排版文件。注意：写操作需遵循当前工作区权限策略。";
    this.schema = z.object({
      path: z.string().describe("输出文件路径（必须以 .docx、.xlsx 或 .pptx 结尾）"),
      title: z.string().optional().describe("文档主标题 / 工作簿名称 / PPT 封面标题"),
      subtitle: z.string().optional().describe("副标题或作者/日期说明"),
      markdown: z
        .string()
        .optional()
        .describe("生成 .docx 时可直接传入 Markdown 正文自动转换为 Word 排版（与 blocks 二选一）"),
      blocks: z
        .array(
          z.object({
            type: z
              .enum(["heading", "paragraph", "bullet_list", "numbered_list", "quote", "table", "page_break"])
              .describe("区块类型"),
            level: z.number().optional().describe("heading 级别 1-6"),
            text: z.string().optional().describe("段落、标题或引用文本"),
            items: z.array(z.string()).optional().describe("列表条目数组"),
            headers: z.array(z.string()).optional().describe("表格表头数组"),
            rows: z.array(z.array(CellValueSchema)).optional().describe("表格数据行二维数组"),
          })
        )
        .optional()
        .describe("生成 .docx 时的结构化内容区块数组"),
      sheets: z
        .array(
          z.object({
            name: z.string().optional().describe("工作表名称（最多 31 字符）"),
            headers: z.array(z.string()).optional().describe("表头列名数组"),
            rows: z.array(z.array(CellValueSchema)).optional().describe("数据行二维数组（支持字符串或数值）"),
            columnWidths: z.array(z.number()).optional().describe("可选列宽数组"),
          })
        )
        .optional()
        .describe("生成 .xlsx 时的多工作表数组"),
      headers: z.array(z.string()).optional().describe("生成单表 .xlsx 时的表头数组（未传 sheets 时使用）"),
      rows: z
        .array(z.array(CellValueSchema))
        .optional()
        .describe("生成单表 .xlsx 时的数据行数组（未传 sheets 时使用）"),
      theme: z
        .enum(["slate", "blue", "dark", "warm"])
        .optional()
        .default("slate")
        .describe("生成 .pptx 时的配色主题"),
      slides: z
        .array(
          z.object({
            title: z.string().optional().describe("幻灯片标题"),
            subtitle: z.string().optional().describe("幻灯片副标题"),
            bullets: z.array(z.string()).optional().describe("要点列表"),
            text: z.string().optional().describe("正文文本（无 bullets 时使用）"),
            table: z
              .object({
                headers: z.array(z.string()).optional(),
                rows: z.array(z.array(CellValueSchema)).optional(),
              })
              .optional()
              .describe("幻灯片内嵌表格"),
            notes: z.string().optional().describe("演讲者备注"),
          })
        )
        .optional()
        .describe("生成 .pptx 时的幻灯片数组"),
    });
  }

  async _call(rawArgs) {
    const {
      path: filePath,
      title,
      subtitle,
      markdown,
      blocks,
      sheets,
      headers,
      rows,
      theme = "slate",
      slides,
      __workDir,
      __allowedFolders,
      __checkPermission,
      __toolContext,
    } = rawArgs || {};

    const targetFilePath = filePath ?? rawArgs?.filepath ?? rawArgs?.file_path ?? rawArgs?.file;
    if (!targetFilePath || typeof targetFilePath !== "string" || !targetFilePath.trim()) {
      return JSON.stringify({ success: false, error: "generate_document 调用失败: 缺少输出路径 path 参数" });
    }
    if (!documentService.isSupportedGenerateDocument(targetFilePath)) {
      return JSON.stringify({
        success: false,
        error: `generate_document 仅支持生成 .docx / .xlsx / .pptx 文件，当前后缀不受支持: ${targetFilePath}`,
      });
    }

    let targetPath;
    try {
      targetPath = await checkSafePath(
        targetFilePath,
        __workDir,
        __allowedFolders,
        __checkPermission,
        "生成文档",
        { mode: "write", toolContext: __toolContext }
      );
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }

    const action = fs.existsSync(targetPath) ? "modified" : "created";
    try {
      const result = await fileLockService.withLock(targetPath, () =>
        documentService.generateDocument(targetPath, {
          title,
          subtitle,
          markdown,
          blocks,
          sheets,
          headers,
          rows,
          theme,
          slides,
        })
      );
      return JSON.stringify({
        success: true,
        path: targetFilePath,
        absPath: targetPath,
        action,
        ...result,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: `生成文档失败: ${err.message}`,
      });
    }
  }
}

module.exports = {
  ReadDocumentTool,
  GenerateDocumentTool,
};
