/**
 * ToolRegistry — 主进程工具注册与执行层
 *
 * 设计原则：
 * 1. 松耦合：通过统一的 name/description/parameters/execute 四元组抽象
 * 2. 安全：工具执行带有效范围限制（cwd 限定在项目目录内）
 * 3. 增强：基于 LangChain StructuredTool 构建，支持 schema 校验、结构化输出
 *
 * 所有工具的云原生定义、schema 校验、exec 逻辑均封装在 utils/tools/ 下。
 * 本模块负责集中注册并提供统一的 Function Calling 接口。
 */

const { ReadFileTool, WriteFileTool, ListDirectoryTool, SearchCodeTool } = require("./tools/fileTools");
const { EditFileTool } = require("./tools/editFileTool");
const { WebSearchTool, WebFetchTool } = require("./tools/webTools");
const { RunCommandTool } = require("./tools/shellTools");
const { TodoWriteTool } = require("./tools/todoTool");
const { DispatchSubagentTool } = require("./tools/subagentTool");
const { getPermissionModePolicy } = require("../services/sandboxPolicyService");

const WRITE_FILE_TOOL_NAMES = new Set(["write_file", "edit_file"]);

class ToolRegistry {
  constructor() {
    /** @type {Map<string, {name:string, description:string, parameters:object, execute:Function}>} */
    this._tools = new Map();
    /** @type {Record<string, any>} */
    this._context = {};
  }

  /**
   * 设置工具执行上下文
   */
  setContext(key, value) {
    this._context[key] = value;
  }

  /**
   * 获取工具执行上下文
   */
  getContext() {
    return { ...this._context };
  }

  /**
   * 注册一个工具
   */
  register(tool) {
    if (!tool.name || !tool.description || !tool.execute) {
      throw new Error(
        `工具注册失败: 需要 name, description, execute (got: ${Object.keys(tool).join(", ")})`,
      );
    }
    this._tools.set(tool.name, tool);
  }

  /**
   * 检查指定工具是否已注册
   */
  has(name) {
    return this._tools.has(name);
  }

  /**
   * 获取 LLM Function Calling 所需的工具定义列表 (OpenAI-compatible)
   * @param {Array<{name:string, description:string, parameters:object}>} [extraTools]
   * @param {Set<string>|null} [allowedToolNames] 可选工具白名单（用于 Subagent 权限收敛）
   * @param {object} [options] 可选过滤配置（如 permissionMode）
   * @returns {Array<{type:string, function:{name:string, description:string, parameters:object}}>}
   */
  getToolDefinitions(extraTools = [], allowedToolNames = null, options = {}) {
    const defs = [];
    const policy = options?.permissionMode
      ? getPermissionModePolicy(options.permissionMode)
      : null;
    const blockFileWrite = policy ? !policy.allowFileWrite : false;
    const allTools = [...this._tools.values(), ...(Array.isArray(extraTools) ? extraTools : [])];
    for (const tool of allTools) {
      if (blockFileWrite && WRITE_FILE_TOOL_NAMES.has(tool.name)) {
        continue;
      }
      // 白名单对内置工具与 MCP 工具一视同仁，Subagent 权限收敛不允许出现 mcp__ 旁路
      if (allowedToolNames && !allowedToolNames.has(tool.name)) {
        continue;
      }
      defs.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return defs;
  }

  getOpenAIToolDefinitions(extraTools = [], allowedToolNames = null, options = {}) {
    return this.getToolDefinitions(extraTools, allowedToolNames, options);
  }

  /**
   * 获取工具列表摘要（用于 system prompt 描述）
   */
  getToolSummaries() {
    return Array.from(this._tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /**
   * 生成紧凑的工具手册（参数签名 + 描述），用于 system prompt
   * @param {Array<{name:string, description:string, parameters:object}>} [extraTools]
   * @param {object} [options]
   */
  getToolPromptDocs(extraTools = [], options = {}) {
    const docs = [];
    const policy = options?.permissionMode
      ? getPermissionModePolicy(options.permissionMode)
      : null;
    const blockFileWrite = policy ? !policy.allowFileWrite : false;
    const allTools = [...this._tools.values(), ...(Array.isArray(extraTools) ? extraTools : [])];
    for (const tool of allTools) {
      if (blockFileWrite && WRITE_FILE_TOOL_NAMES.has(tool.name)) {
        continue;
      }
      const properties = tool.parameters?.properties || {};
      const required = new Set(tool.parameters?.required || []);

      const params = Object.entries(properties)
        .map(([paramName, prop]) => {
          const isRequired = required.has(paramName);
          let signature = `${paramName}${isRequired ? "" : "?"}: ${prop?.type || "any"}`;
          if (prop?.default !== undefined) {
            signature += ` = ${JSON.stringify(prop.default)}`;
          }
          return signature;
        })
        .join(", ");

      const description = String(tool.description || "").slice(0, 160);
      docs.push(`- ${tool.name}(${params}): ${description}`);
    }
    return docs;
  }

  /**
   * 执行指定工具（支持会话级隔离上下文与动态扩展工具）
   * @param {string} name
   * @param {object} args
   * @param {object} [context]
   * @param {Array<{name:string, execute:Function}>} [extraTools]
   * @returns {Promise<{success:boolean, data?:any, error?:string}>}
   */
  async execute(name, args, context = {}, extraTools = []) {
    let tool = this._tools.get(name);
    if (!tool && Array.isArray(extraTools)) {
      tool = extraTools.find((t) => t && t.name === name);
    }
    if (!tool) {
      return { success: false, error: `未找到工具: ${name}` };
    }
    try {
      const resolvedContext = { ...this.getContext(), ...context };
      const result = await tool.execute(args, resolvedContext);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * 获取所有注册的工具数量
   */
  get size() {
    return this._tools.size;
  }
}

// ─── 实例化全局单例 ──────────────────────────────────────────

const toolRegistry = new ToolRegistry();

// ─── 转换 LangChain StructuredTool 为 OpenAI 函数定义 ──────

function unwrapZodField(field) {
  let current = field;
  let optional = false;
  let defaultValue;
  let guard = 0;

  while (current && guard < 10) {
    const typeName = current._def?.typeName;
    if (typeName === "ZodOptional" || typeName === "ZodNullable") {
      optional = true;
      current = current._def.innerType;
    } else if (typeName === "ZodDefault") {
      optional = true;
      defaultValue = current._def.defaultValue();
      current = current._def.innerType;
    } else {
      break;
    }
    guard += 1;
  }

  return { inner: current, optional, defaultValue };
}

function zodFieldToJson(field) {
  const { inner, optional, defaultValue } = unwrapZodField(field);
  const typeName = inner?._def?.typeName;
  let schema;

  switch (typeName) {
    case "ZodNumber":
      schema = { type: "number" };
      break;
    case "ZodBoolean":
      schema = { type: "boolean" };
      break;
    case "ZodEnum":
      schema = { type: "string", enum: inner._def.values };
      break;
    case "ZodArray":
      schema = { type: "array", items: zodFieldToJson(inner._def.type).schema };
      break;
    case "ZodObject": {
      const shape = typeof inner._def.shape === "function" ? inner._def.shape() : {};
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        const converted = zodFieldToJson(value);
        properties[key] = converted.schema;
        if (!converted.optional) required.push(key);
      }
      schema = { type: "object", properties, required };
      break;
    }
    case "ZodString":
    default:
      schema = { type: "string" };
      break;
  }

  const description = field?.description || inner?.description;
  if (description) schema.description = description;
  if (defaultValue !== undefined) schema.default = defaultValue;

  return { schema, optional: optional || defaultValue !== undefined };
}

function zodShapeToJsonSchema(zodObj) {
  // StructuredTool.schema 是 @standard-schema/spec 兼容对象，有 toJSONSchema() 方法
  if (typeof zodObj?.toJSONSchema === "function") {
    const jsonSchema = zodObj.toJSONSchema();
    const rawRequired = Array.isArray(jsonSchema.required) ? new Set(jsonSchema.required) : null;
    // 转换：将有 default 值的参数从 required 中移除（LLM 不填也会用默认值）
    const properties = {};
    const required = [];
    if (jsonSchema.properties) {
      for (const [key, prop] of Object.entries(jsonSchema.properties)) {
        properties[key] = {
          ...prop,
          type: prop.type || "string",
          description: prop.description || "",
        };
        if (prop.default !== undefined) {
          properties[key].default = prop.default;
        }
        // 只有没有 default 值且原本为必填的参数才标记为 required
        const isReq = rawRequired ? rawRequired.has(key) : prop.default === undefined;
        if (isReq && prop.default === undefined) {
          required.push(key);
        }
      }
    }
    return {
      type: jsonSchema.type || "object",
      properties,
      required,
    };
  }

  // zod v3 fallback: 直接读取 _def.shape
  if (zodObj?._def?.typeName === "ZodObject" && typeof zodObj._def.shape === "function") {
    const shape = zodObj._def.shape();
    const properties = {};
    const required = [];
    for (const [key, field] of Object.entries(shape)) {
      const converted = zodFieldToJson(field);
      properties[key] = converted.schema;
      if (!converted.optional) required.push(key);
    }
    return { type: "object", properties, required };
  }

  // Fallback: 返回空 schema
  return { type: "object", properties: {}, required: [] };
}

/**
 * 从 LangChain StructuredTool 创建注册条目
 */
function fromLangChainTool(lcTool) {
  const parameters = zodShapeToJsonSchema(lcTool.schema);
  return {
    name: lcTool.name,
    description: lcTool.description,
    parameters,
    execute: async (args, context = {}) => {
      // StructuredTool 的 _call 方法直接处理参数并返回 JSON string
      const workDir = context?.workDir || null;
      const allowedFolders = context?.allowedFolders || [];
      const checkPermission = context?.checkPermission || null;
      const onTodosUpdate = context?.onTodosUpdate || null;
      const abortSignal = context?.abortSignal || null;
      const resultStr = await lcTool._call({
        ...args,
        __workDir: workDir,
        __allowedFolders: allowedFolders,
        __checkPermission: checkPermission,
        __onTodosUpdate: onTodosUpdate,
        __abortSignal: abortSignal,
        __toolContext: context,
        __toolRegistry: toolRegistry,
      });
      try {
        return JSON.parse(resultStr);
      } catch {
        return { data: resultStr };
      }
    },
  };
}

// ─── 注册所有增强工具 ────────────────────────────────────────

const ALL_TOOLS = [
  fromLangChainTool(new ReadFileTool()),
  fromLangChainTool(new EditFileTool()),
  fromLangChainTool(new WriteFileTool()),
  fromLangChainTool(new ListDirectoryTool()),
  fromLangChainTool(new SearchCodeTool()),
  fromLangChainTool(new RunCommandTool()),
  fromLangChainTool(new WebFetchTool()),
  fromLangChainTool(new TodoWriteTool()),
  fromLangChainTool(new DispatchSubagentTool({}, toolRegistry)),
];

// web_search 需要一个可选的 searchConfig，注册时不传参使用默认配置
ALL_TOOLS.push(fromLangChainTool(new WebSearchTool()));

for (const tool of ALL_TOOLS) {
  toolRegistry.register(tool);
}

console.log(`[toolRegistry] 已注册 ${toolRegistry.size} 个工具: ${ALL_TOOLS.map(t => t.name).join(", ")}`);

module.exports = { toolRegistry };