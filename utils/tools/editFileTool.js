/**
 * EditFileTool — 工业级精准局部代码编辑工具 (对标 Claude Code / OpenHands 的 str_replace)
 *
 * 核心机制：
 * 1. 精确匹配：在目标文件中定位唯一匹配的 old_string，执行原子化替换
 * 2. 唯一性防呆：若 old_string 匹配到多处且未开启 replace_all，抛出警告要求提供更多上下文
 * 3. 容错诊断：若未找到匹配，诊断并提示就近行号与内容，指导 Agent 快速自我修复
 * 4. 沙箱与权限联动：遵循 plan 只读拦截、ask 写入确认、受保护配置拦截与 realpath 校验
 */

const fs = require("fs");
const { z } = require("zod");
const { StructuredTool } = require("@langchain/core/tools");
const { checkSafePath } = require("./fileTools");

class EditFileTool extends StructuredTool {
  constructor() {
    super();
    this.name = "edit_file";
    this.description = "精准局部修改已有文件的指定代码块。必须提供在文件中唯一匹配的 old_string 以及替换后的 new_string。避免全量重写，确保高成功率。";
    this.schema = z.object({
      path: z.string().describe("文件路径，相对于工作空间根目录"),
      old_string: z.string().describe("必须在文件中唯一匹配的现有代码片段（包含足够的上下文行以确保唯一性）"),
      new_string: z.string().describe("用于替换 old_string 的新代码片段"),
      replace_all: z.boolean().optional().default(false).describe("是否替换所有匹配项，默认 false（要求严格唯一匹配）"),
    });
  }

  async _call({
    path: filePath,
    old_string,
    new_string,
    replace_all = false,
    __workDir,
    __allowedFolders,
    __checkPermission,
    __toolContext,
  }) {
    let targetPath;
    try {
      targetPath = await checkSafePath(
        filePath,
        __workDir,
        __allowedFolders,
        __checkPermission,
        "精准修改",
        {
          mode: "write",
          toolContext: __toolContext,
        }
      );
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err.message,
      });
    }

    if (!fs.existsSync(targetPath)) {
      return JSON.stringify({
        success: false,
        error: `目标文件不存在: ${filePath}。如果是新建文件，请改用 write_file 工具。`,
      });
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return JSON.stringify({
        success: false,
        error: `目标路径不是文件: ${filePath}`,
      });
    }

    const content = fs.readFileSync(targetPath, "utf-8");

    // 检查 old_string 是否存在
    if (!content.includes(old_string)) {
      // 容错诊断：尝试寻找部分匹配或行匹配
      const lines = content.split("\n");
      const oldFirstLine = old_string.split("\n")[0].trim();
      let matchedLineIdx = -1;
      if (oldFirstLine) {
        matchedLineIdx = lines.findIndex((l) => l.includes(oldFirstLine));
      }

      let hint = "";
      if (matchedLineIdx >= 0) {
        hint = `提示：首行匹配在第 ${matchedLineIdx + 1} 行附近，但完整多行未完全匹配。请使用 read_file 重新核对该范围的代码缩进与换行。`;
      } else {
        hint = `提示：文件中未找到对应文本。请先调用 read_file 重新确认最新代码。`;
      }

      return JSON.stringify({
        success: false,
        error: `在 ${filePath} 中未找到指定的 old_string。\n${hint}`,
      });
    }

    // 检查唯一性
    const occurrences = content.split(old_string).length - 1;
    if (occurrences > 1 && !replace_all) {
      return JSON.stringify({
        success: false,
        error: `old_string 在文件 ${filePath} 中出现了 ${occurrences} 次。为了防止误修改，请在 old_string 中包含更多前后上下文行以确保匹配的唯一性，或显式设置 replace_all: true。`,
      });
    }

    // 执行精确替换
    let newContent = "";
    if (replace_all) {
      newContent = content.replaceAll(old_string, new_string);
    } else {
      newContent = content.replace(old_string, new_string);
    }

    fs.writeFileSync(targetPath, newContent, "utf-8");

    const oldLinesCount = old_string.split("\n").length;
    const newLinesCount = new_string.split("\n").length;
    const lineDelta = newLinesCount - oldLinesCount;

    return JSON.stringify({
      success: true,
      path: filePath,
      replacedOccurrences: replace_all ? occurrences : 1,
      lineDelta: lineDelta >= 0 ? `+${lineDelta}` : `${lineDelta}`,
      message: `成功更新 ${filePath} (替换 ${replace_all ? occurrences : 1} 处代码片段)`,
    });
  }
}

module.exports = {
  EditFileTool,
};
