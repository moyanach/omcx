const { z } = require("zod");
const { StructuredTool } = require("./baseTool");

const QuestionOptionSchema = z.object({
  label: z.string().min(1).describe("选项展示名称，简洁明了"),
  description: z.string().optional().describe("可选补充说明（如适用场景或优缺点）"),
});

const QuestionItemSchema = z.object({
  id: z.string().min(1).describe("问题唯一标识，如 format / scope"),
  question: z.string().min(1).describe("面向用户的提问正文"),
  type: z
    .enum(["single", "multi", "text"])
    .default("single")
    .describe("single=单选, multi=多选, text=自由文本输入"),
  options: z
    .array(QuestionOptionSchema)
    .optional()
    .describe("single/multi 类型的预设选项列表（建议 2~5 项）"),
  allowCustom: z
    .boolean()
    .optional()
    .describe("选择式问题是否同时允许用户输入自定义补充说明（默认 true）"),
  placeholder: z.string().optional().describe("文本输入或自定义补充输入框占位提示"),
});

/**
 * ask_user_question — 向用户发起结构化交互式提问（单选/多选/文本输入）。
 * 在规划或执行遇到关键歧义时挂起当前工具轮并等待用户卡片响应。
 */
class AskUserQuestionTool extends StructuredTool {
  constructor() {
    super();
    this.name = "ask_user_question";
    this.description =
      "向用户发起结构化交互式提问（支持单选、多选或文本输入），用于澄清歧义需求、选择方案或补充关键参数。仅在确实需要用户拍板时调用，调用后会等待用户确认卡片回复（无交互环境会自动跳过并由你自主决策）。";
    this.schema = z.object({
      title: z.string().optional().describe("提问卡片标题，如「确认报告输出格式」"),
      questions: z
        .array(QuestionItemSchema)
        .min(1)
        .max(5)
        .describe("向用户提出的问题列表（1~5 题）"),
    });
  }

  async _call({ title, questions, __toolContext }) {
    const askUser = __toolContext?.askUser;
    if (typeof askUser !== "function") {
      return JSON.stringify({
        success: true,
        headlessFallback: true,
        skipped: true,
        answers: {},
        note: "当前处于无交互终端环境，无法弹窗向用户提问，请基于已有信息与最佳实践自主做出合理决策并继续执行。",
      });
    }

    const normalizedQuestions = (questions || []).map((q, idx) => ({
      id: String(q.id || `q_${idx + 1}`).trim(),
      question: String(q.question || "").trim(),
      type: q.type === "multi" || q.type === "text" ? q.type : "single",
      options: Array.isArray(q.options)
        ? q.options
            .filter((o) => o && String(o.label || "").trim())
            .map((o) => ({
              label: String(o.label).trim(),
              ...(o.description ? { description: String(o.description).trim() } : {}),
            }))
        : [],
      allowCustom: q.allowCustom !== false,
      placeholder: q.placeholder ? String(q.placeholder) : "",
    }));

    try {
      const resp = await askUser({
        title: title ? String(title).trim() : "需要你的确认",
        questions: normalizedQuestions,
      });
      return JSON.stringify({
        success: true,
        ...resp,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err?.message || String(err),
      });
    }
  }
}

module.exports = { AskUserQuestionTool };
