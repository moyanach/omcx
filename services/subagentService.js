const fs = require("fs");
const path = require("path");
const os = require("os");
const { isAnthropicProvider, streamAnthropicMessage } = require("./anthropicClient");
const reasoningPolicy = require("./reasoningPolicy");
const {
  isRetriableModelError,
  attachModelErrorContext,
  createHttpModelError,
  formatModelErrorText,
} = require("./modelErrorService");

function isTransientSubagentError(err) {
  if (!err) return false;
  if (err.code === "SUBAGENT_IDLE_TIMEOUT" || err.name === "SubagentIdleTimeoutError") {
    return true;
  }
  return isRetriableModelError(err);
}

function createLinkedAbortController(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const onParentAbort = () => {
    controller.abort(parentSignal?.reason || new Error("Aborted"));
  };
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason || new Error("Aborted"));
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      const err = new Error(`Subagent 请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`);
      err.name = "SubagentIdleTimeoutError";
      err.code = "SUBAGENT_IDLE_TIMEOUT";
      controller.abort(err);
    }, timeoutMs);
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  };
  return { signal: controller.signal, controller, cleanup };
}

async function readSubagentOpenAIResponse(response, idleTimeoutMs, abortSig) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  const hasStreamReader = response.body && typeof response.body.getReader === "function";

  // 兼容非流式 JSON 端点或测试 mock 返回
  if (contentType.includes("application/json") || !hasStreamReader) {
    let timer = null;
    try {
      const data = await Promise.race([
        response.json(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(
              `Subagent 响应体读取超时（${Math.round(idleTimeoutMs / 1000)} 秒）`
            );
            err.name = "SubagentIdleTimeoutError";
            err.code = "SUBAGENT_IDLE_TIMEOUT";
            reject(err);
          }, idleTimeoutMs);
        }),
      ]);
      const choice = data?.choices?.[0]?.message;
      if (!choice) return null;
      return {
        rawContent: choice.content || "",
        reasoning: choice.reasoning_content || choice.reasoning || "",
        toolCalls: Array.isArray(choice.tool_calls) ? choice.tool_calls : [],
        usage: data?.usage || null,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullReasoning = "";
  const toolCalls = [];
  let usage = null;
  let streamFinished = false;
  let hasChoiceOrData = false;

  const readChunkWithIdleGuard = () =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error(
          `Subagent 上游连接已连续 ${Math.round(idleTimeoutMs / 1000)} 秒未返回任何数据`
        );
        err.name = "SubagentIdleTimeoutError";
        err.code = "SUBAGENT_IDLE_TIMEOUT";
        reject(err);
      }, idleTimeoutMs);
      reader.read().then(
        (chunk) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(chunk);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });

  try {
    while (!streamFinished) {
      if (abortSig?.aborted) break;
      const { done, value } = await readChunkWithIdleGuard();
      if (done) break;
      if (!value || !value.byteLength) continue;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          streamFinished = true;
          break;
        }
        try {
          const json = JSON.parse(payload);
          if (json.usage) usage = json.usage;
          const choice = json.choices?.[0];
          if (!choice) continue;
          hasChoiceOrData = true;
          const delta = choice.delta || choice.message || {};
          const reasoningDelta = delta.reasoning_content || delta.reasoning;
          if (reasoningDelta) fullReasoning += reasoningDelta;
          if (delta.content) fullContent += delta.content;
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = Number.isInteger(tc.index) ? tc.index : toolCalls.length;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  index: idx,
                  id: tc.id || "",
                  type: tc.type || "function",
                  function: { name: "", arguments: "" },
                };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.type) toolCalls[idx].type = tc.type;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {
          // 忽略非 JSON SSE 片段
        }
      }
    }
  } catch (readErr) {
    if (
      !abortSig?.aborted &&
      isTransientSubagentError(readErr) &&
      (streamFinished || fullContent.trim().length > 0)
    ) {
      console.warn(
        `[subagent] 忽略流尾部的对端 Socket 提前关闭 (${readErr.cause?.code || readErr.message})`
      );
    } else {
      throw readErr;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  // 部分中转即使传入 stream:true 仍直接返一段无 data: 前缀的 JSON
  if (!hasChoiceOrData && !fullContent && buffer.trim().startsWith("{")) {
    try {
      const fallbackJson = JSON.parse(buffer.trim());
      if (fallbackJson.usage) usage = fallbackJson.usage;
      const choice = fallbackJson.choices?.[0]?.message;
      if (choice) {
        return {
          rawContent: choice.content || "",
          reasoning: choice.reasoning_content || choice.reasoning || "",
          toolCalls: Array.isArray(choice.tool_calls) ? choice.tool_calls : [],
          usage,
        };
      }
    } catch {}
  }

  const validTools = toolCalls.filter(Boolean);
  if (!hasChoiceOrData && !fullContent && !fullReasoning && validTools.length === 0) {
    return null;
  }
  return {
    rawContent: fullContent,
    reasoning: fullReasoning,
    toolCalls: validTools,
    usage,
  };
}

const READ_ONLY_TOOL_LIST = [
  "read_file",
  "read_document",
  "list_directory",
  "search_code",
  "repo_map",
  "search_symbols",
  "find_references",
  "web_search",
  "web_fetch",
];

const PLANNER_TOOL_LIST = [...READ_ONLY_TOOL_LIST, "spec_write"];

const FULL_CODING_TOOL_LIST = [
  ...READ_ONLY_TOOL_LIST,
  "write_file",
  "edit_file",
  "generate_document",
  "run_command",
  "run_skill_script",
];

const PARALLEL_READ_ONLY_TOOLS = new Set([
  ...READ_ONLY_TOOL_LIST,
  "browser_logs",
]);

const WRITE_CAPABLE_TOOL_SET = new Set([
  "write_file",
  "edit_file",
  "generate_document",
  "run_command",
  "run_skill_script",
  "browser_interact",
]);

const BUILTIN_SUBAGENTS = [
  {
    id: "explore",
    name: "Explore (代码探索专家)",
    description:
      "高速只读代码库检索与调研子代理。优先使用 repo_map、search_symbols、find_references 定位符号定义与调用图，再按需精准读取源码，将海量中间输出隔离在子上下文之外。",
    tools: READ_ONLY_TOOL_LIST,
    readOnly: true,
    modelTier: "lite",
    maxRounds: 10,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 Explore (代码探索与检索) 子代理。
你的任务是针对主代理委派的调研问题，快速、精准地检索代码库并返回高密度的结构化证据报告。

# 核心准则
1. **只读边界**: 你只能使用只读检索与读取工具（repo_map / search_symbols / find_references / search_code / list_directory / read_file / web_search / web_fetch），绝对不要尝试修改文件。
2. **符号优先与并发检索**: 面对未知模块先调用 \`repo_map\` 或 \`search_symbols\` 建立定位，涉及影响面用 \`find_references\` 追踪调用点，再用 \`read_file\` 分段读取关键段落；尽可能在同一轮中并发发起多个只读调用。
3. **证据导向**: 回复必须包含精确的 \`文件路径:行号\`、核心函数/类签名、调用链与关键代码逻辑摘要，不要输出空泛套话或臆造未读取的内容。`,
  },
  {
    id: "planner",
    name: "Planner (架构规划专家)",
    description:
      "只读架构分析与实施方案设计子代理。结合符号地图与调用引用梳理上下游影响面，识别边界条件与破坏性风险，必要时可用 spec_write 将结构化规格落盘至 .omcx/specs/。",
    tools: PLANNER_TOOL_LIST,
    readOnly: true,
    modelTier: "inherit",
    maxRounds: 10,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 Planner (架构分析与方案设计) 子代理。
你的职责是在不修改任何源码的前提下，深入调查现有工程结构与依赖调用链，为主代理制定严密、可直接落地的技术实施计划。

# 调研方式与输出要求
1. **符号与影响面排查**: 先通过 \`repo_map\`、\`search_symbols\` 与 \`find_references\` 摸清模块边界与上下游调用方，再 \`read_file\` 核对真实实现。
2. **规格落盘边界**: 除主代理明确要求输出到 \`.omcx/specs/\` 时才调用 \`spec_write\`，否则只返回文本规划，禁止修改任何项目源码。
3. **输出结构**:
   - **现状与根因分析**: 结合精确的 \`文件路径:行号\` 说明现有架构与关键数据流；
   - **涉及文件清单**: 明确列出需要新增、修改或删除的文件及各自职责；
   - **分步实施步骤**: 给出清晰的接口定义、函数签名、兼容性约束与改动逻辑；
   - **潜在风险与验证方案**: 指出可能受影响的上下游模块及验证命令。`,
  },
  {
    id: "reviewer",
    name: "Reviewer (代码审查与安全专家)",
    description:
      "以 P0/P1/P2 工业级标准开展只读代码审查与安全审计。结合调用引用分析排查功能缺陷、并发竞态、跨平台/Headless 边界破坏与安全漏洞。",
    tools: READ_ONLY_TOOL_LIST,
    readOnly: true,
    modelTier: "inherit",
    maxRounds: 8,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 Reviewer (代码审查与质量把关) 子代理。
请以严苛的工业级标准只读审查目标代码或近期改动，重点排查：
1. 逻辑漏洞、空指针/未定义边界、异步竞态、资源/监听器泄漏与异常静默吞没；
2. 安全隐患（命令注入、路径穿越、敏感信息泄露、越权访问）；
3. 公共接口与上下游调用破坏（主动用 \`find_references\` 核对调用方，结合 \`read_file\` 验证契约一致性）。

# 输出标准（与 /review 命令保持一致）
- 仅报告真实存在、可复现的问题，不报纯风格问题、不臆测未读到的代码；
- 严格按 **P0（致命/安全/数据丢失） / P1（高：功能错误/卡死/越权） / P2（中：性能/健壮性）** 分级；
- 每条给出 \`文件路径:行号\`、问题机制、触发条件、实际影响与最小修复建议，并在末尾给出简短结论（可合并 / 修复后合并 / 阻断）。`,
  },
  {
    id: "general",
    name: "General (独立模块开发专家)",
    description:
      "具备完整读写、命令与技能脚本执行权限的通用工程子代理。适用于边界清晰、模块解耦的子任务（编写独立组件、补齐单元测试、局部重构与闭环验证）。",
    tools: FULL_CODING_TOOL_LIST,
    readOnly: false,
    modelTier: "inherit",
    maxRounds: 15,
    scope: "builtin",
    systemPrompt: `你是 OMCX 的 General (通用工程执行) 子代理。
你拥有独立的上下文窗口与完整工程工具链，负责闭环完成主代理委派的独立子任务。

# 执行铁律
1. **先查后改**: 先通过 \`search_symbols\` / \`find_references\` / \`search_code\` / \`read_file\` 摸清上下文与调用影响面，再使用 \`edit_file\` 进行微创修改（\`write_file\` 仅用于新建文件）。
2. **文件边界隔离**: 严格遵守主代理划定的文件范围与当前沙箱权限，严禁触碰未授权的其他模块文件，避免与并行任务产生写冲突。
3. **验证闭环**: 完成代码修改后，主动运行 \`run_command\` 执行对应范围的语法检查、单测或最小验证命令（如适用可用 \`run_skill_script\`），禁止谎称未验证的通过状态。
4. **结构化汇报**: 向主代理汇报改动文件路径（含行号）、核心改动逻辑以及实际验证命令与输出摘要。`,
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
          : !tools.some((t) => WRITE_CAPABLE_TOOL_SET.has(t)),
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
  const effectiveTools = effectiveReadOnly
    ? Array.isArray(baseProfile.tools)
      ? baseProfile.tools.filter((t) => !WRITE_CAPABLE_TOOL_SET.has(t))
      : READ_ONLY_TOOL_LIST
    : matched && !matched.readOnly
    ? matched.tools
    : FULL_CODING_TOOL_LIST;
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
    const allModels = storageService?.getModels?.() || [];
    if (modelTier === "lite" && allModels.length > 0) {
      const selector =
        typeof storageService?.selectExplicitLiteModel === "function"
          ? storageService.selectExplicitLiteModel
          : require("./storage/configWorkspaceStorage").selectExplicitLiteModel;
      const lite = selector(allModels, parentModel);
      if (lite) {
        return {
          baseUrl: lite.base_url || lite.baseUrl || parentModel.baseUrl,
          apiKey: lite.api_key || lite.apiKey || "",
          provider: lite.provider || parentModel.provider || "openai",
          modelName: lite.model_id || lite.modelName || lite.id || parentModel.modelName,
          maxOutputTokens: Number(lite.max_output_tokens) || parentModel.maxOutputTokens || 8192,
          inputPrice: Number(lite.input_price) || 0,
          outputPrice: Number(lite.output_price) || 0,
          cacheReadPrice: Number(lite.cache_read_price) || 0,
          cacheWritePrice: Number(lite.cache_write_price) || 0,
        };
      }
    }
  } catch {}
  return parentModel;
}

function buildSubagentSystemPrompt(agentDef, workDir, dateStr = new Date().toISOString().slice(0, 10)) {
  const workspaceDesc = workDir ? `\n当前工作空间主目录: ${workDir}` : "";
  return `${agentDef.systemPrompt}${workspaceDesc}\n当前日期: ${dateStr}`;
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
  const baseUrl = String(targetModel.baseUrl || "").trim().replace(/\/+$/, "");
  const provider = targetModel.provider || "openai";
  const isAnthropic = isAnthropicProvider(provider, baseUrl);
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

  const replayScope = storageService?.getConfig?.("reasoning_replay_scope");
  const replayPolicy = reasoningPolicy.resolveReplayPolicy({
    provider,
    baseUrl,
    modelId: targetModel.modelName,
    hasTools: openAITools.length > 0,
    scope: replayScope || "current-run",
  });

  const stripLegacyThinking = (rawText) => {
    const raw = String(rawText || "");
    if (!raw.includes("<think")) return raw.trim();
    if (typeof storageService?.extractLegacyThinking === "function") {
      return storageService.extractLegacyThinking(raw).content.trim();
    }
    return raw
      .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
      .replace(/<(?:think|thinking)>[\s\S]*$/i, "")
      .trim();
  };

  const normalizeSubagentUsage = (rawUsage) => {
    if (!rawUsage || typeof rawUsage !== "object") return null;
    if (isAnthropic && rawUsage.raw && typeof rawUsage.prompt_tokens === "number") {
      return rawUsage;
    }
    if (isAnthropic && typeof rawUsage.input_tokens === "number") {
      const { normalizeAnthropicUsage } = require("./anthropicClient");
      return normalizeAnthropicUsage(rawUsage);
    }
    const prompt = Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens) || 0;
    const completion = Number(rawUsage.completion_tokens ?? rawUsage.output_tokens) || 0;
    const cached =
      Number(rawUsage.prompt_tokens_details?.cached_tokens) ||
      Number(rawUsage.cached_tokens) ||
      Number(rawUsage.cache_read_input_tokens) ||
      0;
    const cacheCreation = Number(rawUsage.cache_creation_input_tokens) || 0;
    if (!prompt && !completion && !rawUsage.total_tokens) return null;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Number(rawUsage.total_tokens) || prompt + completion,
      cached_tokens: cached,
      cache_creation_tokens: cacheCreation,
      raw: rawUsage,
    };
  };

  const sysContent = buildSubagentSystemPrompt(agentDef, workDir);

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
  let totalUsage = null;
  let totalCostUsd = 0;
  const READ_ONLY_SET = PARALLEL_READ_ONLY_TOOLS;
  const configuredMaxTokens = Number(targetModel.maxOutputTokens) || 8192;

  const recordSubUsage = (rawUsage) => {
    const normalized = normalizeSubagentUsage(rawUsage);
    if (!normalized) return;
    if (!totalUsage) {
      totalUsage = {
        prompt_tokens: normalized.prompt_tokens,
        completion_tokens: normalized.completion_tokens,
        total_tokens: normalized.total_tokens,
        cached_tokens: normalized.cached_tokens || 0,
        cache_creation_tokens: normalized.cache_creation_tokens || 0,
      };
    } else {
      totalUsage.prompt_tokens += normalized.prompt_tokens;
      totalUsage.completion_tokens += normalized.completion_tokens;
      totalUsage.total_tokens += normalized.total_tokens;
      totalUsage.cached_tokens += normalized.cached_tokens || 0;
      totalUsage.cache_creation_tokens += normalized.cache_creation_tokens || 0;
    }
    const inputPrice = Number(targetModel.inputPrice) || 0;
    const outputPrice = Number(targetModel.outputPrice) || 0;
    const cacheReadPrice =
      Number(targetModel.cacheReadPrice) || (inputPrice > 0 ? inputPrice * 0.1 : 0);
    const cacheWritePrice =
      Number(targetModel.cacheWritePrice) || (inputPrice > 0 ? inputPrice * 1.25 : 0);
    const cached = Math.min(normalized.cached_tokens || 0, normalized.prompt_tokens);
    const cacheCreation = normalized.cache_creation_tokens || 0;
    const normalPrompt = Math.max(0, normalized.prompt_tokens - cached - cacheCreation);
    totalCostUsd +=
      (normalPrompt * inputPrice +
        cached * cacheReadPrice +
        cacheCreation * cacheWritePrice +
        normalized.completion_tokens * outputPrice) /
      1_000_000;
  };

  const buildSubAssistantReplay = (turnResult, toolCalls) => {
    const msg = {
      role: "assistant",
      content: turnResult.rawContent || "",
    };
    if (replayPolicy.mode === "openai-field") {
      const replay = reasoningPolicy.buildReplayPayload(replayPolicy, turnResult);
      if (replay) msg[replay.field] = replay.value;
    } else if (replayPolicy.mode === "anthropic-block") {
      const rawReasoning = reasoningPolicy.extractReplayReasoning(turnResult);
      const signatures = Array.isArray(turnResult.reasoningMeta?.signatures)
        ? turnResult.reasoningMeta.signatures
        : [];
      if (rawReasoning && signatures.some(Boolean)) {
        msg.reasoning = rawReasoning;
        msg.reasoningSignatures = signatures;
      }
    }
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    return msg;
  };

  const callSubagentModelOnce = async (toolsForTurn) => {
    const abortSig =
      parentToolContext?.abortSignal ||
      parentToolContext?.sessionAbort?.abortController?.signal ||
      parentToolContext?.sessionAbort?.controller?.signal;

    const idleTimeoutSec = Math.max(
      30,
      Number(storageService?.getConfig?.("stream_idle_timeout")) || 180
    );
    const idleTimeoutMs = idleTimeoutSec * 1000;

    const runAttempt = async () => {
      if (isAnthropic) {
        const anthropicRes = await streamAnthropicMessage({
          baseUrl,
          apiKey: targetModel.apiKey,
          model: targetModel.modelName,
          messages,
          tools: toolsForTurn,
          maxTokens: configuredMaxTokens,
          temperature: 0.2,
          signal: abortSig,
        });
        recordSubUsage(anthropicRes.usage);
        return {
          rawContent: anthropicRes.content || "",
          cleanContent: stripLegacyThinking(anthropicRes.content || ""),
          reasoning: anthropicRes.reasoning || "",
          reasoningMeta: anthropicRes.reasoningMeta || null,
          toolCalls: Array.isArray(anthropicRes.toolCalls) ? anthropicRes.toolCalls : [],
        };
      }

      const headers = { "Content-Type": "application/json" };
      if (targetModel.apiKey) {
        headers.Authorization = `Bearer ${targetModel.apiKey}`;
      }

      const buildBody = (includeMaxTokens) => {
        const body = {
          model: targetModel.modelName,
          messages,
          temperature: 0.2,
          stream: true,
        };
        if (includeMaxTokens && configuredMaxTokens > 0) {
          body.max_tokens = configuredMaxTokens;
        }
        if (Array.isArray(toolsForTurn) && toolsForTurn.length > 0) {
          body.tools = toolsForTurn;
          body.tool_choice = "auto";
        }
        return body;
      };

      const subErrCtx = {
        provider: targetModel.provider || "",
        model: targetModel.modelName,
        baseUrl,
        endpoint: chatUrl,
      };

      const fetchWithTimeout = async (bodyObj) => {
        const linked = createLinkedAbortController(abortSig, idleTimeoutMs);
        try {
          return await fetch(chatUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(bodyObj),
            signal: linked.signal,
          });
        } catch (fetchErr) {
          throw attachModelErrorContext(fetchErr, subErrCtx);
        } finally {
          linked.cleanup();
        }
      };

      let response = await fetchWithTimeout(buildBody(true));

      if (!response.ok && response.status === 400) {
        const errProbe = await response.text().catch(() => "");
        if (/max_tokens|max_completion_tokens|unsupported parameter/i.test(errProbe)) {
          response = await fetchWithTimeout(buildBody(false));
        } else {
          throw createHttpModelError({
            status: 400,
            statusText: response.statusText,
            rawBody: errProbe,
            ...subErrCtx,
            prefix: "Subagent API 请求失败",
          });
        }
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw createHttpModelError({
          status: response.status,
          statusText: response.statusText,
          rawBody: errText,
          ...subErrCtx,
          prefix: "Subagent API 请求失败",
        });
      }

      const parsed = await readSubagentOpenAIResponse(response, idleTimeoutMs, abortSig);
      if (!parsed) return null;
      recordSubUsage(parsed.usage);

      return {
        rawContent: parsed.rawContent || "",
        cleanContent: stripLegacyThinking(parsed.rawContent || ""),
        reasoning: parsed.reasoning || "",
        reasoningMeta: null,
        toolCalls: parsed.toolCalls || [],
      };
    };

    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (abortSig?.aborted || parentToolContext?.sessionAbort?.cancelled) break;
      try {
        return await runAttempt();
      } catch (err) {
        lastErr = err;
        if (
          abortSig?.aborted ||
          parentToolContext?.sessionAbort?.cancelled ||
          !isTransientSubagentError(err) ||
          attempt === maxAttempts
        ) {
          if (abortSig?.aborted || parentToolContext?.sessionAbort?.cancelled) {
            throw err;
          }
          const subErr = new Error(
            formatModelErrorText(err, {
              provider: targetModel.provider || "",
              model: targetModel.modelName,
              baseUrl,
              endpoint: chatUrl,
            })
          );
          subErr.cause = err;
          throw subErr;
        }
        const delayMs = attempt * 400;
        console.warn(
          `[subagent] 遇到瞬时网络/超时中断 (${err.cause?.code || err.message})，${delayMs}ms 后进行第 ${
            attempt + 1
          }/${maxAttempts} 次重试...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  };

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
        usage: totalUsage,
        costUsd: Math.round(totalCostUsd * 100_000_000) / 100_000_000,
      };
    }

    const turnResult = await callSubagentModelOnce(openAITools);
    if (!turnResult) {
      break;
    }

    if (turnResult.cleanContent) {
      lastAssistantText = turnResult.cleanContent;
    }

    const toolCalls = turnResult.toolCalls || [];
    if (toolCalls.length === 0) {
      break;
    }

    round++;
    messages.push(buildSubAssistantReplay(turnResult, toolCalls));

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
    const finalTurn = await callSubagentModelOnce([]).catch(() => null);
    if (finalTurn?.cleanContent) {
      lastAssistantText = finalTurn.cleanContent;
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
    usage: totalUsage,
    costUsd: Math.round(totalCostUsd * 100_000_000) / 100_000_000,
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
          agentId: item.agent,
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

  const totalCostUsd = results.reduce((sum, r) => sum + (Number(r?.costUsd) || 0), 0);
  let aggregatedUsage = null;
  for (const r of results) {
    if (!r?.usage) continue;
    if (!aggregatedUsage) {
      aggregatedUsage = {
        prompt_tokens: Number(r.usage.prompt_tokens) || 0,
        completion_tokens: Number(r.usage.completion_tokens) || 0,
        total_tokens: Number(r.usage.total_tokens) || 0,
        cached_tokens: Number(r.usage.cached_tokens) || 0,
        cache_creation_tokens: Number(r.usage.cache_creation_tokens) || 0,
      };
    } else {
      aggregatedUsage.prompt_tokens += Number(r.usage.prompt_tokens) || 0;
      aggregatedUsage.completion_tokens += Number(r.usage.completion_tokens) || 0;
      aggregatedUsage.total_tokens += Number(r.usage.total_tokens) || 0;
      aggregatedUsage.cached_tokens += Number(r.usage.cached_tokens) || 0;
      aggregatedUsage.cache_creation_tokens += Number(r.usage.cache_creation_tokens) || 0;
    }
  }

  return {
    success: results.every((r) => r?.success),
    parallelTasksCount: tasks.length,
    totalToolCallsCount: mergedStepsByTask.flat().length,
    usage: aggregatedUsage,
    costUsd: Math.round(totalCostUsd * 100_000_000) / 100_000_000,
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
  READ_ONLY_TOOL_LIST,
  PLANNER_TOOL_LIST,
  FULL_CODING_TOOL_LIST,
  discoverSubagents,
  resolveSubagentProfile,
  selectSubagentModel,
  buildSubagentSystemPrompt,
  isTransientSubagentError,
  readSubagentOpenAIResponse,
  runSubagentLoop,
  runSubagentBatch,
};
