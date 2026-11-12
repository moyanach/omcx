const fs = require("fs");
const path = require("path");
const os = require("os");

const READ_ONLY_TOOL_LIST = [
  "read_file",
  "list_directory",
  "search_code",
  "web_search",
  "web_fetch",
];

const FULL_CODING_TOOL_LIST = [
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "search_code",
  "run_command",
  "web_search",
  "web_fetch",
];

const BUILTIN_SUBAGENTS = [
  {
    id: "explore",
    name: "Explore (代码探索专家)",
    description:
      "高速只读代码库检索与调研子代理。擅长跨目录定位实现逻辑、梳理调用链、查找配置与外部文档，将海量中间文件内容隔离在子上下文之外。",
    tools: READ_ONLY_TOOL_LIST,
    readOnly: true,
    modelTier: "lite",
    maxRounds: 10,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 Explore (代码探索与检索) 子代理。
你的任务是针对主代理委派的调研问题，快速、精准地检索代码库并返回高密度的结构化证据报告。

# 核心准则
1. **只读边界**: 你只能使用检索和读取工具（search_code / list_directory / read_file / web_search / web_fetch），绝对不要尝试修改文件。
2. **并发检索**: 尽可能在同一轮中并发发起多个 search_code 或 read_file 调用以提升速度。
3. **证据导向**: 回复必须包含精确的 \`文件路径:行号\`、核心函数/类签名以及关键代码逻辑摘要，不要输出空泛套话。`,
  },
  {
    id: "planner",
    name: "Planner (架构规划专家)",
    description:
      "只读架构分析与实施方案设计子代理。用于在复杂功能改动前深入阅读相关模块，识别边界条件与破坏性风险，输出分步改造蓝图。",
    tools: READ_ONLY_TOOL_LIST,
    readOnly: true,
    modelTier: "inherit",
    maxRounds: 10,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 Planner (架构分析与方案设计) 子代理。
你的职责是在不修改任何代码的前提下，深入调查现有工程结构，为主代理制定严密、可直接落地的技术实施计划。

# 输出结构要求
1. **现状与根因分析**: 结合精确的 \`文件路径:行号\` 说明现有架构与关键数据流。
2. **涉及文件清单**: 明确列出需要新增、修改或删除的文件及各自职责。
3. **分步实施步骤**: 给出清晰的接口定义、函数签名与改动逻辑。
4. **潜在风险与验证方案**: 指出可能受影响的上下游模块及验证命令。`,
  },
  {
    id: "reviewer",
    name: "Reviewer (代码审查与安全专家)",
    description:
      "专注于代码质量、潜在 Bug、并发竞态、未处理异常及安全漏洞的只读审查子代理。",
    tools: READ_ONLY_TOOL_LIST,
    readOnly: true,
    modelTier: "inherit",
    maxRounds: 8,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 Reviewer (代码审查与质量把关) 子代理。
请以严苛的工业级标准审查目标代码或近期改动，重点排查：
1. 逻辑漏洞、空指针/未定义边界、异步竞态与内存泄漏；
2. 安全隐患（命令注入、路径穿越、敏感信息泄露、越权访问）；
3. 与现有工程规范不一致或破坏公共接口的改动。
请按「高危 / 中危 / 建议」分级输出具体位置（\`文件路径:行号\`）与修复建议。`,
  },
  {
    id: "general",
    name: "General (独立模块开发专家)",
    description:
      "具备完整读写与命令执行权限的通用工程子代理。适用于边界清晰、模块解耦的子任务（如编写独立组件、补齐单元测试、修复局部模块）。",
    tools: FULL_CODING_TOOL_LIST,
    readOnly: false,
    modelTier: "inherit",
    maxRounds: 15,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 General (通用工程执行) 子代理。
你拥有独立的上下文窗口与完整工程工具链，负责闭环完成主代理委派的独立子任务。

# 执行铁律
1. 先通过 search_code / read_file 摸清上下文，再使用 edit_file / write_file 进行微创修改。
2. 严格遵守主代理划定的文件修改范围，严禁触碰主代理未授权的其他模块文件，避免并行冲突。
3. 完成后向主代理汇报修改了哪些文件（含行号）、核心改动逻辑以及验证结果。`,
  },
];

function parseAgentMarkdown(filePath, scope) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const baseName = path
      .basename(filePath, path.extname(filePath))
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");
    let meta = {};
    let body = raw;

    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (fmMatch) {
      const yamlText = fmMatch[1];
      body = fmMatch[2].trim();
      for (const line of yamlText.split(/\r?\n/)) {
        const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
        if (m) {
          const key = m[1].trim();
          let val = m[2].trim().replace(/^["']|["']$/g, "");
          if (key === "tools") {
            meta.tools = val
              .replace(/^\[|\]$/g, "")
              .split(",")
              .map((s) => s.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean);
          } else if (key === "maxRounds") {
            meta.maxRounds = parseInt(val, 10) || 10;
          } else if (key === "readOnly") {
            meta.readOnly = val === "true";
          } else {
            meta[key] = val;
          }
        }
      }
    }

    const tools =
      Array.isArray(meta.tools) && meta.tools.length > 0
        ? meta.tools
        : meta.readOnly
        ? READ_ONLY_TOOL_LIST
        : FULL_CODING_TOOL_LIST;

    return {
      id: meta.id || baseName,
      name: meta.name || baseName,
      description: meta.description || body.split("\n")[0]?.slice(0, 120) || "自定义子代理",
      tools,
      readOnly:
        typeof meta.readOnly === "boolean"
          ? meta.readOnly
          : !tools.some((t) => ["write_file", "edit_file", "run_command"].includes(t)),
      modelTier: meta.model || meta.modelTier || "inherit",
      maxRounds: meta.maxRounds || 10,
      scope,
      filePath,
      systemPrompt: body || `你是 ${meta.name || baseName} 子代理，请高效完成主代理委派的任务。`,
    };
  } catch (e) {
    return null;
  }
}

function discoverSubagents(workDir) {
  const map = new Map();
  for (const agent of BUILTIN_SUBAGENTS) {
    map.set(agent.id, { ...agent });
  }

  const globalDirs = [
    path.join(os.homedir(), ".omcx", "agents"),
    path.join(os.homedir(), ".agents", "agents"),
  ];
  for (const dir of globalDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
        for (const f of files) {
          const parsed = parseAgentMarkdown(path.join(dir, f), "global");
          if (parsed) map.set(parsed.id, parsed);
        }
      } catch {}
    }
  }

  if (workDir) {
    const projectDirs = [
      path.join(workDir, ".omcx", "agents"),
      path.join(workDir, ".agents", "agents"),
    ];
    for (const dir of projectDirs) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
          for (const f of files) {
            const parsed = parseAgentMarkdown(path.join(dir, f), "project");
            if (parsed) map.set(parsed.id, parsed);
          }
        } catch {}
      }
    }
  }

  return Array.from(map.values());
}

/**
 * 支持「预设模板」与「零预设动态角色 (Ad-hoc Role)」双模式解析
 */
function resolveSubagentProfile({ agentId, role, readOnly, workDir, permissionMode }) {
  const all = discoverSubagents(workDir);
  const normalizedId = String(agentId || "").trim().toLowerCase();
  const matched = all.find((a) => a.id.toLowerCase() === normalizedId);

  const forceReadOnlyByPlan = permissionMode === "plan";

  const baseProfile =
    matched ||
    all.find((a) => a.id === (!forceReadOnlyByPlan && readOnly === false ? "general" : "explore")) ||
    BUILTIN_SUBAGENTS[0];

  const effectiveReadOnly = forceReadOnlyByPlan
    ? true
    : typeof readOnly === "boolean"
    ? readOnly
    : baseProfile.readOnly;
  const effectiveTools = effectiveReadOnly ? READ_ONLY_TOOL_LIST : baseProfile.tools;
  const customRoleTitle = role && role.trim() ? role.trim() : null;

  return {
    ...baseProfile,
    id: matched ? matched.id : customRoleTitle ? `dynamic:${customRoleTitle}` : baseProfile.id,
    name: customRoleTitle ? `${customRoleTitle}` : baseProfile.name,
    readOnly: effectiveReadOnly,
    tools: effectiveTools,
    systemPrompt: customRoleTitle
      ? `${baseProfile.systemPrompt}\n\n# 本次动态专家角色设定\n你当前被主代理动态赋予的专项角色为：【${customRoleTitle}】。请严格围绕该角色职责与任务边界高效执行。`
      : baseProfile.systemPrompt,
  };
}

function selectSubagentModel(parentModel, modelTier, storageService) {
  if (!modelTier || modelTier === "inherit") return parentModel;
  try {
    const allModels = storageService.getModels() || [];
    if (modelTier === "lite" && allModels.length > 1) {
      const lite = allModels.find((m) =>
        /mini|flash|haiku|lite|fast|small|v3|turbo/i.test(
          `${m.name || ""} ${m.model_id || ""} ${m.id || ""} ${m.modelName || ""}`
        )
      );
      if (lite) {
        return {
          baseUrl: lite.base_url || lite.baseUrl || parentModel.baseUrl,
          apiKey: lite.api_key || lite.apiKey || parentModel.apiKey,
          modelName: lite.model_id || lite.modelName || lite.id || parentModel.modelName,
        };
      }
    }
  } catch {}
  return parentModel;
}

/**
 * 运行单个独立上下文的 Subagent 执行循环（内部支持只读工具 Promise.all 并发）
 */
async function runSubagentLoop({
  agentId,
  role,
  readOnly,
  taskPrompt,
  contextHint,
  parentToolContext,
  toolRegistry,
  storageService,
  onSubStep,
  subagentLabel,
}) {
  const workDir = parentToolContext?.workDir || null;
  const permissionMode = parentToolContext?.permissionMode || "auto-sandbox";
  const agentDef = resolveSubagentProfile({
    agentId,
    role,
    readOnly,
    workDir,
    permissionMode,
  });
  const parentModel = parentToolContext?.modelConfig;
  if (!parentModel || !parentModel.baseUrl) {
    return {
      success: false,
      error: "未找到有效的模型配置，无法启动 Subagent",
    };
  }

  const targetModel = selectSubagentModel(parentModel, agentDef.modelTier, storageService);
  const baseUrl = targetModel.baseUrl.replace(/\/+$/, "");
  const chatUrl = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const allowedSet = new Set(
    (agentDef.tools || []).filter((t) => t !== "dispatch_subagent" && t !== "todo_write")
  );
  const openAITools = toolRegistry.getOpenAIToolDefinitions(
    parentToolContext?.mcpTools || [],
    allowedSet
  );

  const workspaceDesc = workDir ? `\n当前工作空间主目录: ${workDir}` : "";
  const sysContent = `${agentDef.systemPrompt}${workspaceDesc}\n当前系统时间: ${new Date().toLocaleString("zh-CN")}`;

  const userContent = contextHint
    ? `【主代理补充背景】\n${contextHint}\n\n【委派子任务】\n${taskPrompt}`
    : taskPrompt;

  const messages = [
    { role: "system", content: sysContent },
    { role: "user", content: userContent },
  ];

  const maxRounds = agentDef.maxRounds || 10;
  let round = 0;
  const subSteps = [];
  let lastAssistantText = "";
  const READ_ONLY_SET = new Set(READ_ONLY_TOOL_LIST);

  const childToolContext = {
    ...parentToolContext,
    isSubagent: true,
    subagentId: agentDef.id,
  };

  while (round < maxRounds) {
    if (parentToolContext?.sessionAbort?.cancelled) {
      return {
        success: false,
        agentId: agentDef.id,
        agentName: agentDef.name,
        error: "任务已被用户取消",
        subSteps,
      };
    }

    const reqBody = {
      model: targetModel.modelName,
      messages,
      temperature: 0.2,
      stream: false,
    };
    if (openAITools.length > 0) {
      reqBody.tools = openAITools;
      reqBody.tool_choice = "auto";
    }

    const headers = { "Content-Type": "application/json" };
    if (targetModel.apiKey) {
      headers.Authorization = `Bearer ${targetModel.apiKey}`;
    }

    const abortSig =
      parentToolContext?.abortSignal ||
      parentToolContext?.sessionAbort?.abortController?.signal ||
      parentToolContext?.sessionAbort?.controller?.signal;

    const response = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: abortSig,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Subagent API 请求失败 (${response.status}): ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0]?.message;
    if (!choice) {
      break;
    }

    const content = (choice.content || "")
      .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
      .trim();
    if (content) {
      lastAssistantText = content;
    }

    const toolCalls = choice.tool_calls || [];
    if (toolCalls.length === 0) {
      break;
    }

    round++;
    messages.push({
      role: "assistant",
      content: choice.content || "",
      tool_calls: toolCalls,
    });

    const prepared = toolCalls.map((tc, idx) => {
      const subCallId = tc.id || `subcall_${Date.now()}_${round}_${idx}`;
      const toolName = tc.function?.name;
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        toolArgs = {};
      }
      const stepRecord = {
        callId: subCallId,
        tool: toolName,
        args: toolArgs,
        status: "running",
        agentName: subagentLabel || agentDef.name,
      };
      subSteps.push(stepRecord);
      return { tc, subCallId, toolName, toolArgs, stepRecord };
    });

    if (typeof onSubStep === "function") {
      onSubStep([...subSteps]);
    }

    const executeSubTool = async ({ subCallId, toolName, toolArgs, stepRecord }) => {
      let execResult;
      // 严格按子代理工具白名单执行：MCP 工具并未提供给子代理，模型幻觉出的 mcp__* 必须拒绝，
      // 否则只读子代理可借父会话凭据调用有副作用的远端工具。
      if (!allowedSet.has(toolName)) {
        execResult = {
          success: false,
          error: `子代理 [${agentDef.name}] 无权调用工具 ${toolName}`,
        };
      } else {
        execResult = await toolRegistry.execute(
          toolName,
          toolArgs,
          childToolContext,
          parentToolContext?.mcpTools || []
        );
        if (
          (toolName === "write_file" || toolName === "edit_file") &&
          execResult?.success &&
          typeof parentToolContext?.onFileOutput === "function"
        ) {
          parentToolContext.onFileOutput(toolArgs.path);
        }
      }

      stepRecord.status = "done";
      stepRecord.summary =
        toolArgs.path || toolArgs.pattern || toolArgs.query || toolArgs.command || "";
      if (typeof onSubStep === "function") {
        onSubStep([...subSteps]);
      }
      return { subCallId, execResult };
    };

    const allReadOnly =
      prepared.length > 1 && prepared.every((p) => READ_ONLY_SET.has(p.toolName));

    let completed = [];
    if (allReadOnly) {
      completed = await Promise.all(prepared.map((item) => executeSubTool(item)));
    } else {
      for (const item of prepared) {
        if (parentToolContext?.sessionAbort?.cancelled) break;
        const res = await executeSubTool(item);
        completed.push(res);
      }
    }

    for (const { subCallId, execResult } of completed) {
      const serialized = JSON.stringify(execResult);
      const truncated =
        serialized.length > 10000
          ? `${serialized.slice(0, 10000)}\n...(子代理工具结果已截断)`
          : serialized;
      messages.push({
        role: "tool",
        tool_call_id: subCallId,
        content: truncated,
      });
    }
  }

  if (!lastAssistantText && round > 0 && !parentToolContext?.sessionAbort?.cancelled) {
    messages.push({
      role: "user",
      content: "请立即汇总以上工具执行获取到的事实与代码结论，向主代理输出精炼完整的总结报告（不要再调用工具）。",
    });
    const headers = { "Content-Type": "application/json" };
    if (targetModel.apiKey) headers.Authorization = `Bearer ${targetModel.apiKey}`;
    const abortSig =
      parentToolContext?.abortSignal ||
      parentToolContext?.sessionAbort?.abortController?.signal ||
      parentToolContext?.sessionAbort?.controller?.signal;
    const res = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: targetModel.modelName,
        messages,
        temperature: 0.2,
        stream: false,
      }),
      signal: abortSig,
    });
    if (res.ok) {
      const data = await res.json();
      lastAssistantText = (data.choices?.[0]?.message?.content || "")
        .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
        .trim();
    }
  }

  return {
    success: true,
    agentId: agentDef.id,
    agentName: agentDef.name,
    rounds: round,
    toolCallsCount: subSteps.length,
    report: lastAssistantText || "子代理已完成执行，但未返回额外文本摘要。",
    subSteps,
  };
}

/**
 * 批量并发执行多个 Subagent 任务（第一级 Fan-out / Map-Reduce 并行加速，带并发池上限）
 */
async function runSubagentBatch({
  tasks,
  maxConcurrency = 4,
  parentToolContext,
  toolRegistry,
  storageService,
  onSubStep,
}) {
  const mergedStepsByTask = tasks.map(() => []);
  const emitAggregatedSteps = () => {
    if (typeof onSubStep === "function") {
      onSubStep(mergedStepsByTask.flat());
    }
  };

  const results = new Array(tasks.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const item = tasks[idx];
      if (parentToolContext?.sessionAbort?.cancelled) {
        results[idx] = {
          success: false,
          agentName: item.role || item.agent || `Task #${idx + 1}`,
          error: "已取消",
        };
        continue;
      }
      const label = item.role || item.agent || `并行子代理 #${idx + 1}`;
      try {
        results[idx] = await runSubagentLoop({
          agentId: item.agent || "explore",
          role: item.role,
          readOnly: item.readOnly,
          taskPrompt: item.task,
          contextHint: item.contextHint,
          parentToolContext,
          toolRegistry,
          storageService,
          subagentLabel: label,
          onSubStep: (steps) => {
            mergedStepsByTask[idx] = steps;
            emitAggregatedSteps();
          },
        });
      } catch (err) {
        results[idx] = {
          success: false,
          agentName: label,
          error: err.message || "子代理执行异常",
        };
      }
    }
  };

  const workerCount = Math.min(maxConcurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    success: results.every((r) => r?.success),
    parallelTasksCount: tasks.length,
    totalToolCallsCount: mergedStepsByTask.flat().length,
    results: results.map((r, i) => ({
      index: i + 1,
      agentName: r.agentName,
      success: r.success,
      rounds: r.rounds || 0,
      toolCallsCount: r.toolCallsCount || 0,
      report: r.report || r.error || "",
    })),
  };
}

module.exports = {
  BUILTIN_SUBAGENTS,
  discoverSubagents,
  runSubagentLoop,
  runSubagentBatch,
};
