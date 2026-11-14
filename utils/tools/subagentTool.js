const { StructuredTool } = require("./baseTool");
const { z } = require("zod");
const subagentService = require("../../services/subagentService");
const storageService = require("../../services/storageService");

const SingleSubTaskSchema = z.object({
  agent: z
    .string()
    .optional()
    .describe("预设子代理类型 ID（'explore' | 'planner' | 'reviewer' | 'general'），默认 'explore'"),
  role: z
    .string()
    .optional()
    .describe("动态专家角色名称（如 '前端状态流排查专家'、'IPC 协议审计员'），可无需预先配置动态生成"),
  readOnly: z
    .boolean()
    .optional()
    .describe("是否限制为只读安全模式（探索/分析/审查设为 true，独立模块修改设为 false）"),
  task: z
    .string()
    .describe("委派给该子代理的具体、闭环任务指令"),
  contextHint: z
    .string()
    .optional()
    .describe("可选背景提示（如已知相关目录或约束）"),
});

class DispatchSubagentTool extends StructuredTool {
  name = "dispatch_subagent";
  description =
    "启动一个或多个拥有独立上下文窗口的专家子代理 (Subagent) 自主执行复杂子任务，仅向主会话返回精炼结论报告。\n" +
    "【自主调用判断准则】：\n" +
    "1. 简单任务不调用：若已知确切文件路径且预计 1~3 次 read_file/edit_file 即可完成，主代理直接执行，不要启动子代理。\n" +
    "2. 复杂探索与上下文隔离必调：当需要跨多个目录搜索未知实现、阅读超过 4 个文件或进行专项代码审查时，调用本工具将海量中间搜索输出隔离在子代理中。\n" +
    "3. 大型任务并行加速 (Fan-out)：当任务涉及多个互不依赖的子模块/目录时，优先传入 tasks 数组一次性并行启动 2~4 个子代理同时作业，大幅加快执行速度！\n" +
    "4. 支持零预设动态角色：除了使用预设 agent ('explore'|'planner'|'reviewer'|'general')，你也可以直接传入自定义 role 和 readOnly 动态生成专项子代理。";

  schema = z.object({
    agent: z
      .string()
      .optional()
      .describe(
        "单任务模式下的子代理 ID：'explore' (只读探索) | 'planner' (架构规划) | 'reviewer' (代码审查) | 'general' (通用读写)，默认 'explore'"
      ),
    role: z
      .string()
      .optional()
      .describe(
        "单任务模式下的动态自定义角色名称（如 'React 性能分析专家'），无需预先配置即可按需创建"
      ),
    readOnly: z
      .boolean()
      .optional()
      .describe("单任务模式下是否强制只读（默认根据 agent 类型自动决定）"),
    task: z
      .string()
      .optional()
      .describe("单任务模式下委派给子代理的具体任务描述（若使用 tasks 批量并行模式则可省略）"),
    contextHint: z
      .string()
      .optional()
      .describe("单任务模式下的补充上下文提示"),
    tasks: z
      .array(SingleSubTaskSchema)
      .optional()
      .describe(
        "【并行加速模式】当遇到大型跨模块任务时，传入 2~6 个独立子任务数组，系统将使用并发池同时并行运行所有子代理并汇总返回结果"
      ),
  });

  constructor(toolContext = {}, toolRegistryRef = null) {
    super();
    this.toolContext = toolContext;
    this.toolRegistryRef = toolRegistryRef;
  }

  async _call({
    agent,
    role,
    readOnly,
    task,
    contextHint,
    tasks,
    __toolContext,
    __toolRegistry,
  }) {
    const activeContext = __toolContext || this.toolContext || {};
    const activeRegistry = __toolRegistry || this.toolRegistryRef;

    if (activeContext?.isSubagent) {
      return JSON.stringify({
        success: false,
        error: "禁止在子代理内部递归调用 dispatch_subagent",
      });
    }

    try {
      // 模式 A：批量多 Subagent 并行扇出 (Fan-out / Map-Reduce)
      if (Array.isArray(tasks) && tasks.length > 0) {
        const batchResult = await subagentService.runSubagentBatch({
          tasks,
          maxConcurrency: 4,
          parentToolContext: activeContext,
          toolRegistry: activeRegistry,
          storageService,
          onSubStep: (subSteps) => {
            if (typeof activeContext?.onSubagentProgress === "function") {
              activeContext.onSubagentProgress(subSteps);
            }
          },
        });
        return JSON.stringify(batchResult);
      }

      // 模式 B：单个 Subagent 委派（支持预设 ID 或动态 role）
      if (!task || !String(task).trim()) {
        return JSON.stringify({
          success: false,
          error: "参数错误：必须提供 task（单任务）或 tasks（并行多任务数组）",
        });
      }

      const result = await subagentService.runSubagentLoop({
        agentId: agent || "explore",
        role,
        readOnly,
        taskPrompt: task,
        contextHint,
        parentToolContext: activeContext,
        toolRegistry: activeRegistry,
        storageService,
        onSubStep: (subSteps) => {
          if (typeof activeContext?.onSubagentProgress === "function") {
            activeContext.onSubagentProgress(subSteps);
          }
        },
      });

      return JSON.stringify({
        success: result.success,
        agentId: result.agentId,
        agentName: result.agentName,
        rounds: result.rounds,
        toolCallsCount: result.toolCallsCount,
        report: result.report,
        error: result.error,
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error.message || "Subagent 执行异常",
      });
    }
  }
}

module.exports = { DispatchSubagentTool };
