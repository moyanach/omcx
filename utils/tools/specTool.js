const { z } = require("zod");
const { StructuredTool } = require("./baseTool");
const specService = require("../../services/specService");

/**
 * spec_write — 保存 Quest / 规格模式生成的结构化规格文档。
 * 只写 <workDir>/.omcx/specs/，因此在只读规划模式下也可安全使用。
 */
class SpecWriteTool extends StructuredTool {
  constructor() {
    super();
    this.name = "spec_write";
    this.description =
      "保存结构化规格文档（Quest/规格模式）到当前工作区的 .omcx/specs/ 目录。仅写入该目录，不修改任何源码，因此在只读规划模式下也可调用。文档应包含：目标与范围、需求与约束、技术方案、验收标准、实施步骤。保存后应停止修改并等待用户确认。";
    this.schema = z.object({
      title: z.string().min(1).describe("规格标题，例如「多目录工作空间增量索引」"),
      content: z
        .string()
        .min(1)
        .describe(
          "规格正文 Markdown。必须包含 5 个章节：## 目标与范围 / ## 需求与约束 / ## 技术方案 / ## 验收标准 / ## 实施步骤"
        ),
      slug: z
        .string()
        .optional()
        .describe("可选文件名 slug（小写英文/数字/连字符）；省略时由标题自动生成"),
    });
  }

  async _call({ title, content, slug, __workDir }) {
    if (!__workDir) {
      return JSON.stringify({ success: false, error: "当前会话未绑定工作目录" });
    }
    try {
      const result = specService.saveSpec(__workDir, {
        title,
        content,
        slug,
        status: "draft",
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message || String(err) });
    }
  }
}

module.exports = { SpecWriteTool };
