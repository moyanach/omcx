/**
 * 旁路问答服务 (/btw)
 *
 * 语义：回答用户此刻的侧边问题，不接管主任务、不写入主会话、不触发压缩/标题/产物/checkpoint。
 * 能力：只读工具子集（read_file / search_code / find_references / repo_map），最多 20 轮。
 *
 * 该服务刻意与 main.js 的 chat-request 主循环解耦：
 * - 独立 AbortSignal，取消旁路不会影响主任务；
 * - 独立消息数组，主任务完整历史不会进入旁路上下文；
 * - 不访问 storageService，从物理上杜绝污染会话持久化。
 */

const { isAnthropicProvider, streamAnthropicMessage } = require("./anthropicClient");

const MAX_TOOL_ROUNDS = 20;
const MAX_TOOL_RESULT_CHARS = 16000;
const MAX_TOTAL_TOOL_RESULT_CHARS = 60000;
const MAX_DIGEST_CHARS = 6000;
const MAX_QUESTION_CHARS = 12000;
const MAX_QUOTED_CHARS = 8000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function clampText(text, maxChars) {
  const raw = String(text ?? "");
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n\n…[内容过长，已截断]`;
}

function safeParseArgs(rawArguments) {
  if (!rawArguments) return {};
  if (typeof rawArguments === "object") return rawArguments;
  try {
    const parsed = JSON.parse(String(rawArguments));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  const total = Number(usage.total_tokens) || prompt + completion;
  if (!prompt && !completion && !total) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

function mergeUsage(prev, next) {
  const a = normalizeUsage(prev);
  const b = normalizeUsage(next);
  if (!a) return b;
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

function buildSystemPrompt({ workDir, digest }) {
  const digestText = String(digest || "").trim();
  return [
    "你是 OMCX Desktop 的旁路问答助手（/btw）。",
    "你的职责是回答用户此刻提出的侧边问题；不要接管、不要续写、不要打断主任务。",
    "你只能读取代码进行查证，禁止修改文件、执行命令或发起任何写操作。",
    "",
    `【当前工作目录】${workDir || "（未绑定工作目录）"}`,
    "【主任务背景（只读参考，不要执行或续写）】",
    digestText ? clampText(digestText, MAX_DIGEST_CHARS) : "（暂无主任务上下文）",
    "",
    "可用只读工具：read_file、search_code、find_references、repo_map。",
    "用户可能在问题前附带【用户从主会话中选中的内容】，那是用户主动圈选的只读引用，",
    "仅用于理解当前旁路问题；不要把它当成新任务，也不要续写或修改它。",
    "",
    "回答规则：",
    "1. 先给结论，再给必要依据；引用代码时使用 `文件:行号`。",
    "2. 信息不足时先调用只读工具查证；仍无法确定就明确说明，不要臆造。",
    "3. 不要输出与问题无关的长篇方案，不要假设未读到的代码。",
    "4. 使用中文回答，简洁直接。",
  ].join("\n");
}

/**
 * OpenAI 兼容端点的 SSE 流式请求（仅文本 + tool_calls，无 tools 时不传工具）。
 */
async function streamOpenAiCompatible({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  maxTokens,
  temperature = 0.2,
  signal,
  onText,
}) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("模型 Base URL 为空，请先在【设置】中配置该模型");

  const buildBody = (includeMaxTokens) => {
    const body = {
      model,
      messages,
      stream: true,
      temperature,
    };
    if (includeMaxTokens && maxTokens) body.max_tokens = maxTokens;
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    return body;
  };

  const request = async (includeMaxTokens) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(buildBody(includeMaxTokens)),
      signal,
    });

  let response = await request(true);
  if (!response.ok && response.status === 400) {
    const errText = await response.text().catch(() => "");
    // 部分网关不支持 max_tokens（如 o 系列要求 max_completion_tokens），自动剥离后重试一次
    if (/max_tokens|max_completion_tokens|unsupported parameter/i.test(errText)) {
      response = await request(false);
      if (response.ok) {
        // 已成功降级
      } else {
        const retryText = await response.text().catch(() => "");
        throw new Error(`API 请求失败 (${response.status}): ${retryText.slice(0, 1200)}`);
      }
    } else {
      throw new Error(`API 请求失败 (${response.status}): ${errText.slice(0, 1200)}`);
    }
  } else if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`API 请求失败 (${response.status}): ${errText.slice(0, 1200)}`);
  }

  if (!response.body) throw new Error("模型 API 未返回可读取的响应流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let finishReason = null;
  const toolCallsByIndex = new Map();

  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    if (json.usage) usage = json.usage;
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    const reasoningDelta = delta.reasoning_content || delta.reasoning;
    if (typeof reasoningDelta === "string" && reasoningDelta) {
      reasoning += reasoningDelta;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = Number.isInteger(part?.index) ? part.index : toolCallsByIndex.size;
        let item = toolCallsByIndex.get(index);
        if (!item) {
          item = {
            index,
            id: part.id || `call_${index}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
          toolCallsByIndex.set(index, item);
        }
        if (part.id) item.id = part.id;
        if (part.function?.name) item.function.name = part.function.name;
        if (typeof part.function?.arguments === "string") {
          item.function.arguments += part.function.arguments;
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 忽略流释放异常
    }
  }

  const toolCalls = Array.from(toolCallsByIndex.values())
    .filter((item) => item.function.name)
    .sort((a, b) => a.index - b.index);

  if (!finishReason && toolCalls.length > 0) finishReason = "tool_calls";

  return {
    content,
    reasoning,
    toolCalls,
    usage: normalizeUsage(usage),
    finishReason,
    hitLengthLimit: finishReason === "length" || finishReason === "max_tokens",
  };
}

async function streamModelOnce({
  baseUrl,
  apiKey,
  provider,
  model,
  messages,
  tools,
  maxTokens,
  signal,
  onText,
}) {
  if (isAnthropicProvider(provider, baseUrl)) {
    const result = await streamAnthropicMessage({
      baseUrl,
      apiKey,
      model,
      messages,
      tools,
      maxTokens,
      temperature: 0.2,
      signal,
      onText,
    });
    return {
      content: result.content || "",
      reasoning: result.reasoning || "",
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
      usage: normalizeUsage(result.usage),
      finishReason: result.finishReason || null,
      hitLengthLimit: Boolean(result.hitLengthLimit),
    };
  }

  return streamOpenAiCompatible({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    maxTokens,
    signal,
    onText,
  });
}

/**
 * 运行一次旁路问答（可能包含最多 20 轮只读工具调用）。
 *
 * @param {object} options
 * @param {string} options.question 已内联 @file/@dir 的用户问题
 * @param {string} [options.quotedText] 用户从主会话中选中的内容（右键“旁路会话”带入）
 * @param {string} options.digest 主任务摘要（单向注入）
 * @param {Array<{question:string, answer:string}>} [options.history] 当前会话此前的旁路问答（最多 3 轮）
 * @param {string|null} options.workDir
 * @param {{baseUrl:string, apiKey:string, provider:string, modelName:string, maxOutputTokens?:number}} options.modelConfig
 * @param {Array} options.toolDefinitions OpenAI 兼容工具定义（只读子集）
 * @param {object} options.toolContext 工具执行上下文（只读权限模式）
 * @param {Set<string>} [options.allowedToolNames] 只读工具白名单（模型幻觉调用其他工具时强制拒绝）
 * @param {{execute:Function}} options.toolRegistry
 * @param {AbortSignal} options.abortSignal
 * @param {(delta:string)=>void} [options.onDelta]
 * @param {(status:object)=>void} [options.onToolStatus]
 * @returns {Promise<{content:string, usage:object|null, rounds:number, cancelled:boolean, hitRoundLimit:boolean}>}
 */
async function runBtw({
  question,
  quotedText,
  digest,
  history,
  workDir,
  modelConfig,
  toolDefinitions,
  toolContext,
  allowedToolNames,
  toolRegistry,
  abortSignal,
  onDelta,
  onToolStatus,
}) {
  const userQuestion = clampText(String(question || "").trim(), MAX_QUESTION_CHARS);
  if (!userQuestion) throw new Error("旁路问题不能为空");

  // 用户从主会话中选中的片段：作为只读引用前置到问题里，不进入主会话历史
  const quoted = clampText(String(quotedText || "").trim(), MAX_QUOTED_CHARS);
  const userContent = quoted
    ? `【用户从主会话中选中的内容】\n${quoted}\n\n【旁路问题】\n${userQuestion}`
    : userQuestion;

  const modelName = modelConfig?.modelName;
  if (!modelName) throw new Error("未指定旁路问答模型");

  const maxTokens = Math.min(
    Number(modelConfig?.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS
  );

  // 抽屉内连续追问：带上此前已完成的旁路 Q/A，最多 3 轮，避免“还有别的吗”失去指代
  const historyMessages = [];
  if (Array.isArray(history)) {
    for (const item of history.slice(-3)) {
      const historyQuestion = clampText(String(item?.question || "").trim(), 2000);
      const historyAnswer = clampText(String(item?.answer || "").trim(), 3000);
      if (!historyQuestion || !historyAnswer) continue;
      historyMessages.push({
        role: "user",
        content: `【此前旁路提问】${historyQuestion}`,
      });
      historyMessages.push({ role: "assistant", content: historyAnswer });
    }
  }

  const messages = [
    { role: "system", content: buildSystemPrompt({ workDir, digest }) },
    ...historyMessages,
    { role: "user", content: userContent },
  ];

  let answer = "";
  let usage = null;
  let rounds = 0;
  let toolResultChars = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    if (abortSignal?.aborted) {
      return { content: answer, usage, rounds, cancelled: true, hitRoundLimit: false };
    }

    rounds += 1;
    // 最后一轮不再提供工具，强制模型基于已获取的只读结果直接收尾，避免 20 轮后没有答案
    const toolsForRound = rounds >= MAX_TOOL_ROUNDS ? [] : toolDefinitions;
    let result;
    try {
      result = await streamModelOnce({
        baseUrl: modelConfig?.baseUrl,
        apiKey: modelConfig?.apiKey,
        provider: modelConfig?.provider,
        model: modelName,
        messages,
        tools: toolsForRound,
        maxTokens,
        signal: abortSignal,
        onText: (delta) => {
          answer += delta;
          onDelta?.(delta);
        },
      });
    } catch (err) {
      if (abortSignal?.aborted) {
        return { content: answer, usage, rounds, cancelled: true, hitRoundLimit: false };
      }
      throw err;
    }

    usage = mergeUsage(usage, result.usage);

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        content: answer,
        usage,
        rounds,
        cancelled: Boolean(abortSignal?.aborted),
        hitRoundLimit: false,
      };
    }

    messages.push({
      role: "assistant",
      content: result.content || "",
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments:
            typeof call.function.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function.arguments || {}),
        },
      })),
    });

    for (const call of result.toolCalls) {
      if (abortSignal?.aborted) {
        return { content: answer, usage, rounds, cancelled: true, hitRoundLimit: false };
      }

      const toolName = call.function.name;
      const args = safeParseArgs(call.function.arguments);
      onToolStatus?.({ id: call.id, tool: toolName, status: "running", args });

      let execResult;
      if (allowedToolNames && !allowedToolNames.has(toolName)) {
        // 模型可能幻觉出不存在的工具名：旁路通道只允许白名单内的只读工具
        execResult = {
          success: false,
          error: `旁路问答仅允许调用只读工具 (${Array.from(allowedToolNames).join(", ")})，已拒绝: ${toolName}`,
        };
      } else {
        try {
          execResult = await toolRegistry.execute(toolName, args, toolContext, []);
        } catch (err) {
          execResult = { success: false, error: err?.message || String(err) };
        }
      }

      const payload = execResult?.success
        ? execResult.data
        : { success: false, error: execResult?.error || "工具执行失败" };
      let toolText;
      try {
        toolText = typeof payload === "string" ? payload : JSON.stringify(payload);
      } catch {
        toolText = String(payload);
      }

      const remainingBudget = MAX_TOTAL_TOOL_RESULT_CHARS - toolResultChars;
      const cappedText =
        remainingBudget <= 0
          ? JSON.stringify({
              success: false,
              error: "旁路工具结果预算已用尽，请基于已获取的信息直接回答。",
            })
          : clampText(toolText, Math.min(MAX_TOOL_RESULT_CHARS, remainingBudget));
      toolResultChars += cappedText.length;

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: cappedText,
      });

      onToolStatus?.({
        id: call.id,
        tool: toolName,
        status: "done",
        args,
        success: Boolean(execResult?.success),
        error: execResult?.success ? undefined : execResult?.error,
      });
    }
  }

  return {
    content: answer,
    usage,
    rounds,
    cancelled: Boolean(abortSignal?.aborted),
    hitRoundLimit: true,
  };
}

module.exports = {
  runBtw,
  buildSystemPrompt,
  streamOpenAiCompatible,
  MAX_TOOL_ROUNDS,
};
