const { z } = require("zod");
const { StructuredTool } = require("@langchain/core/tools");

const TODO_STATUSES = ["pending", "in_progress", "completed"];
const MAX_TODOS = 50;

class TodoWriteTool extends StructuredTool {
  constructor() {
    super();
    this.name = "todo_write";
    this.description =
      "用于创建、更新会话的任务待办清单 (Todo List)。当面对复杂工程、多文件改动或多步骤修复时，你应当在开始前调用此工具制定计划，并在每一步完成时更新状态。每次调用必须传入完整的最新任务数组。";
    this.schema = z.object({
      todos: z
        .array(
          z.object({
            id: z.string().describe("任务唯一 ID，如 td_1, td_2"),
            text: z.string().describe("具体的任务描述，需包含具体模块或目标"),
            status: z.enum(["pending", "in_progress", "completed"]).describe("任务状态"),
          })
        )
        .describe("当前会话完整的任务列表，按执行顺序排列"),
    });
  }

  async _call({ todos, __onTodosUpdate }) {
    if (!Array.isArray(todos) || todos.length < 1 || todos.length > MAX_TODOS) {
      return JSON.stringify({
        success: false,
        error: `todos 必须是 1~${MAX_TODOS} 条的数组`,
      });
    }

    const normalized = todos
      .map((todo, index) => ({
        id: String(todo?.id || `td_${index + 1}`).trim(),
        text: String(todo?.text || todo?.content || "").trim(),
        status: TODO_STATUSES.includes(todo?.status) ? todo.status : "pending",
      }))
      .filter((todo) => todo.text.length > 0);

    if (normalized.length === 0) {
      return JSON.stringify({ success: false, error: "工单内容不能为空" });
    }

    const inProgressCount = normalized.filter((todo) => todo.status === "in_progress").length;
    if (inProgressCount > 1) {
      return JSON.stringify({
        success: false,
        error: "同一时间只能有一个任务处于 in_progress 状态",
      });
    }

    if (typeof __onTodosUpdate === "function") {
      __onTodosUpdate(normalized);
    }

    const completed = normalized.filter((todo) => todo.status === "completed").length;
    return JSON.stringify({
      success: true,
      total: normalized.length,
      completed,
      message: `待办清单已更新：共 ${normalized.length} 项，已完成 ${completed} 项`,
    });
  }
}

module.exports = { TodoWriteTool };
