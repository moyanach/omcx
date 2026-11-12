/**
 * AnthropicClient — 原生 Anthropic Messages API 适配层
 *
 * 与 OpenAI 兼容端点并存：
 * - provider=anthropic 或 base_url 命中 api.anthropic.com 时启用；
 * - 负责 OpenAI 风格消息/工具 → Messages API 的转换；
 * - 解析 Anthropic SSE 事件，输出与现有 Agent 循环一致的结果结构；
 * - 在 system / tools / 最后一条消息上打 prompt caching 断点。
 */

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

// adaptive thinking 的 effort 档位映射（Anthropic 官方：output_config.effort）
const ADAPTIVE_EFFORT_MAP = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

function isAnthropicProvider(provider, baseUrl) {
  const p = String(provider || "").toLowerCase();
  const url = String(baseUrl || "").toLowerCase();
  return p === "anthropic" || p === "claude" || /anthropic\.com|\/anthropic|claude/.test(url);
}

function buildMessagesEndpoint(baseUrl) {
  const base = String(baseUrl || "https://api.anthropic.com").trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text") return part.text || "";
        return "";
      })
      .join("");
  }
  return content === undefined || content === null ? "" : String(content);
}

function contentToBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null
      ? []
      : [{ type: "text", text: String(content) }];
  }

  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") {
      blocks.push({ type: "text", text: part });
      continue;
    }
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text || "" });
      continue;
    }
    if (part.type === "image_url") {
      const url = part.image_url?.url || part.image_url || "";
      const match = String(url).match(/^data:([^;]+);base64,(.*)$/s);
      if (match) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] },
        });
      } else if (url) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
      continue;
    }
    if (part.type === "image" && part.source) {
      blocks.push(part);
      continue;
    }
    if (part.text) {
      blocks.push({ type: "text", text: String(part.text) });
    }
  }
  return blocks;
}

function safeToolInput(rawArguments) {
  if (!rawArguments) return {};
  if (typeof rawArguments === "object") return rawArguments;
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 将 OpenAI 风格 messages 转换为 Anthropic 的 system + messages。
 */
function convertMessages(messages = []) {
  const systemParts = [];
  const converted = [];

  const append = (role, blocks) => {
    if (!blocks || blocks.length === 0) return;
    const last = converted[converted.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    converted.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (!message) continue;

    if (message.role === "system") {
      const text = extractText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === "tool") {
      const toolContent =
        typeof message.content === "string"
          ? message.content
          : message.content === undefined || message.content === null
          ? ""
          : JSON.stringify(message.content);
      append("user", [
        {
          type: "tool_result",
          tool_use_id: String(message.tool_call_id || ""),
          content: toolContent,
        },
      ]);
      continue;
    }

    if (message.role === "assistant") {
      const blocks = contentToBlocks(message.content);
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call?.function?.name) continue;
          blocks.push({
            type: "tool_use",
            id: String(call.id || `toolu_${Date.now()}_${blocks.length}`),
            name: String(call.function.name),
            input: safeToolInput(call.function.arguments),
          });
        }
      }
      // Anthropic 要求 thinking block 必须排在 text / tool_use 之前，
      // 且多轮与工具循环中必须连同 signature 原样回传，否则上游会拒绝或显著掉质量。
      if (typeof message.reasoning === "string" && message.reasoning.trim()) {
        const signatures = Array.isArray(message.reasoningSignatures)
          ? message.reasoningSignatures
          : [];
        const thinkBlock = { type: "thinking", thinking: message.reasoning };
        if (signatures[0]) {
          thinkBlock.signature = String(signatures[0]);
        } else {
          console.warn("[anthropic] 回传 thinking 缺少 signature（上游可能忽略该块）");
        }
        blocks.unshift(thinkBlock);
      }
      if (blocks.length === 0) continue;
      append("assistant", blocks);
      continue;
    }

    append("user", contentToBlocks(message.content));
  }

  return {
    system: systemParts.join("\n\n"),
    messages: converted,
  };
}

function convertTools(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .filter((tool) => tool?.function?.name)
    .map((tool) => ({
      name: String(tool.function.name),
      description: String(tool.function.description || ""),
      input_schema:
        tool.function.parameters && typeof tool.function.parameters === "object"
          ? tool.function.parameters
          : { type: "object", properties: {}, required: [] },
    }));
}

function applyCacheControl(system, tools, messages) {
  // 最多 4 个缓存断点：system、tools 末尾、对话最后一条消息
  if (system) {
    system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  if (Array.isArray(tools) && tools.length > 0) {
    tools = tools.map((tool, index) =>
      index === tools.length - 1
        ? { ...tool, cache_control: { type: "ephemeral" } }
        : tool
    );
  }
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && Array.isArray(last.content) && last.content.length > 0) {
      const cloned = last.content.map((block) => ({ ...block }));
      const lastBlock = cloned[cloned.length - 1];
      // tool_result 与文本块均支持 cache_control
      lastBlock.cache_control = { type: "ephemeral" };
      messages = [...messages.slice(0, -1), { ...last, content: cloned }];
    }
  }
  return { system, tools, messages };
}

function buildAnthropicPayload({
  model,
  messages = [],
  tools = [],
  maxTokens,
  temperature = 0.2,
  reasoningEffort,
}) {
  const { system, messages: converted } = convertMessages(messages);
  const anthropicTools = convertTools(tools);
  const cached = applyCacheControl(system, anthropicTools, converted);

  const effort = String(reasoningEffort || "").toLowerCase();
  const thinkingEnabled = effort && effort !== "off";

  const payload = {
    model,
    max_tokens: Number(maxTokens) || DEFAULT_MAX_TOKENS,
    messages: cached.messages,
    stream: true,
  };
  if (cached.system) payload.system = cached.system;
  if (cached.tools.length > 0) {
    payload.tools = cached.tools;
    payload.tool_choice = { type: "auto" };
  }
  if (thinkingEnabled) {
    // extended thinking 的 thinking.type="enabled" + budget_tokens 已是 legacy 协议，
    // Claude 4.7+ 直接 400。统一迁移到 adaptive thinking：由模型自行决定是否思考与深度，
    // 通过 output_config.effort 表达意图（官方推荐做法）。
    payload.thinking = { type: "adaptive" };
    payload.output_config = { effort: ADAPTIVE_EFFORT_MAP[effort] || "high" };
    // 开启思考时上游要求 temperature=1，显式下发避免网关默认值冲突
    payload.temperature = 1;
  } else if (Number.isFinite(Number(temperature))) {
    payload.temperature = Number(temperature);
  }
  return payload;
}

function normalizeAnthropicUsage(raw = {}) {
  const input = Number(raw.input_tokens) || 0;
  const cacheRead = Number(raw.cache_read_input_tokens) || 0;
  const cacheCreation = Number(raw.cache_creation_input_tokens) || 0;
  const output = Number(raw.output_tokens) || 0;
  return {
    prompt_tokens: input + cacheRead + cacheCreation,
    completion_tokens: output,
    total_tokens: input + cacheRead + cacheCreation + output,
    cached_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    raw,
  };
}

function anthropicHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

/**
 * 发起流式 Messages 请求并消费 SSE。
 * 返回结构与 OpenAI 分支保持一致，便于 Agent 循环直接复用。
 */
async function streamAnthropicMessage({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  maxTokens,
  temperature,
  reasoningEffort,
  signal,
  onText,
  onReasoning,
}) {
  const payload = buildAnthropicPayload({
    model,
    messages,
    tools,
    maxTokens,
    temperature,
    reasoningEffort,
  });

  // 连接阶段超时：上游只建立连接却不返回响应头时不能无限等待
  const connectController = new AbortController();
  const connectTimer = setTimeout(() => connectController.abort(), 60 * 1000);
  const combinedSignal =
    signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, connectController.signal])
      : signal || connectController.signal;
  let response;
  try {
    response = await fetch(buildMessagesEndpoint(baseUrl), {
      method: "POST",
      headers: anthropicHeaders(apiKey),
      signal: combinedSignal,
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(connectTimer);
  }

  // 兼容性安全退避：老模型或第三方 Anthropic 兼容网关可能不认识 adaptive thinking /
  // output_config，返回 400 时剥离思考参数重试一次，避免思考能力把整个请求打死。
  if (!response.ok && response.status === 400 && payload.thinking) {
    const errProbe = await response.text().catch(() => "");
    const lowerProbe = errProbe.toLowerCase();
    if (
      lowerProbe.includes("thinking") ||
      lowerProbe.includes("output_config") ||
      lowerProbe.includes("effort") ||
      lowerProbe.includes("unrecognized") ||
      lowerProbe.includes("extra fields") ||
      lowerProbe.includes("not supported")
    ) {
      console.warn(
        `[anthropic] 端点不接受 adaptive thinking (${errProbe.slice(0, 160)})，剥离思考参数重试...`
      );
      const retryPayload = { ...payload };
      delete retryPayload.thinking;
      delete retryPayload.output_config;
      retryPayload.temperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2;
      response = await fetch(buildMessagesEndpoint(baseUrl), {
        method: "POST",
        headers: anthropicHeaders(apiKey),
        signal: combinedSignal,
        body: JSON.stringify(retryPayload),
      });
    } else {
      throw new Error(`Anthropic API 请求失败 (400): ${errProbe.slice(0, 1200)}`);
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API 请求失败 (${response.status}): ${errText.slice(0, 1200)}`);
  }
  if (!response.body) {
    throw new Error("Anthropic API 未返回可读取的响应流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let finishReason = null;
  let hitLengthLimit = false;
  let receivedBytes = 0;
  let eventName = "";
  let dataLines = [];
  const toolCallsByBlock = new Map();
  // 思考块采集：Anthropic 要求把 assistant turn 内的 thinking block 连同 signature
  // 原样回传（工具循环尤其如此），因此必须按产出顺序完整保留，不能只留文本。
  const thinkingBlocksByIndex = new Map();
  const orderedReasoningBlocks = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    dataLines = [];
    if (!raw) return;
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const type = json.type || eventName;
    if (type === "message_start") {
      usage = normalizeAnthropicUsage(json.message?.usage || {});
      return;
    }
    if (type === "content_block_start") {
      const block = json.content_block || {};
      if (block.type === "tool_use") {
        toolCallsByBlock.set(json.index, {
          index: json.index,
          id: block.id || `toolu_${Date.now()}_${json.index}`,
          type: "function",
          function: { name: block.name || "", arguments: "" },
        });
      } else if (block.type === "thinking") {
        thinkingBlocksByIndex.set(json.index, {
          index: json.index,
          thinking: block.thinking || "",
          signature: block.signature || "",
        });
      }
      return;
    }
    if (type === "content_block_delta") {
      const delta = json.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        content += delta.text;
        onText?.(delta.text);
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        reasoning += delta.thinking;
        const holder = thinkingBlocksByIndex.get(json.index);
        if (holder) holder.thinking += delta.thinking;
        onReasoning?.(delta.thinking);
      } else if (delta.type === "signature_delta" && delta.signature) {
        // signature 是加密推理副本，必须按块累积，禁止写日志或进入 Markdown 导出
        const holder = thinkingBlocksByIndex.get(json.index);
        if (holder) holder.signature += delta.signature;
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        const tool = toolCallsByBlock.get(json.index);
        if (tool) tool.function.arguments += delta.partial_json;
      }
      return;
    }
    if (type === "content_block_stop") {
      const tool = toolCallsByBlock.get(json.index);
      if (tool && !tool.function.arguments) tool.function.arguments = "{}";
      const thinkingBlock = thinkingBlocksByIndex.get(json.index);
      if (thinkingBlock) {
        orderedReasoningBlocks.push(thinkingBlock);
        thinkingBlocksByIndex.delete(json.index);
      }
      return;
    }
    if (type === "message_delta") {
      const stopReason = json.delta?.stop_reason;
      if (stopReason) {
        if (stopReason === "max_tokens") {
          hitLengthLimit = true;
          finishReason = "length";
        } else if (stopReason === "tool_use") {
          finishReason = "tool_calls";
        } else {
          finishReason = "stop";
        }
      }
      if (json.usage) {
        const next = normalizeAnthropicUsage({ ...(usage?.raw || {}), ...json.usage });
        usage = next;
      }
      return;
    }
    if (type === "error") {
      const message = json.error?.message || "Anthropic 流式响应返回错误";
      throw new Error(message);
    }
    // message_stop / ping 无需额外处理
  };

  // 流读取空闲超时：Anthropic 通道此前没有 watchdog，上游静默挂起会让 Agent 永久卡住
  const STREAM_IDLE_TIMEOUT_MS = 90 * 1000;
  const readWithIdleTimeout = () =>
    new Promise((resolve, reject) => {
      const idleTimer = setTimeout(() => {
        reject(
          new Error(
            `Anthropic 流式响应空闲超时（${Math.round(
              STREAM_IDLE_TIMEOUT_MS / 1000
            )} 秒未收到任何数据）`
          )
        );
      }, STREAM_IDLE_TIMEOUT_MS);
      reader.read().then(
        (chunk) => {
          clearTimeout(idleTimer);
          resolve(chunk);
        },
        (err) => {
          clearTimeout(idleTimer);
          reject(err);
        }
      );
    });

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout();
      if (done) break;
      if (value?.byteLength) {
        receivedBytes += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line === "") {
          flushEvent();
          eventName = "";
        }
      }
    }
    if (buffer.trim()) {
      if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
      flushEvent();
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 忽略释放 reader 异常
    }
  }

  const toolCalls = Array.from(toolCallsByBlock.values())
    .filter((tool) => tool.function.name)
    .sort((a, b) => a.index - b.index);

  // 流意外中断时 content_block_stop 可能缺失：把残留思考块按 index 顺序补收，
  // 避免 signature 与文本错位。
  if (thinkingBlocksByIndex.size > 0) {
    const leftovers = Array.from(thinkingBlocksByIndex.values()).sort((a, b) => a.index - b.index);
    orderedReasoningBlocks.push(...leftovers);
    thinkingBlocksByIndex.clear();
  }

  if (!finishReason && toolCalls.length > 0) finishReason = "tool_calls";

  // 按产出顺序输出 signature 列表，供下一轮请求原样回传 thinking block
  const reasoningSignatures = orderedReasoningBlocks.map((block) => block.signature || "");

  return {
    content,
    reasoning,
    reasoningSignatures,
    reasoningMeta: {
      provider: "anthropic",
      signatures: reasoningSignatures,
      blockCount: orderedReasoningBlocks.length,
    },
    toolCalls,
    usage,
    hitLengthLimit,
    finishReason,
    receivedBytes,
  };
}

/**
 * 非流式补全（Repo Wiki、标题生成等旁路任务使用）
 */
async function completeAnthropicMessage({
  baseUrl,
  apiKey,
  model,
  system = "",
  messages = [],
  maxTokens = 2048,
  temperature = 0.3,
  signal,
}) {
  const converted = convertMessages(
    system ? [{ role: "system", content: system }, ...messages] : messages
  );
  const payload = {
    model,
    max_tokens: Number(maxTokens) || 2048,
    messages: converted.messages,
    stream: false,
  };
  if (converted.system) {
    payload.system = [{ type: "text", text: converted.system, cache_control: { type: "ephemeral" } }];
  }
  if (Number.isFinite(Number(temperature))) payload.temperature = Number(temperature);

  const response = await fetch(buildMessagesEndpoint(baseUrl), {
    method: "POST",
    headers: {
      ...anthropicHeaders(apiKey),
      Accept: "application/json",
    },
    signal,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API 请求失败 (${response.status}): ${errText.slice(0, 800)}`);
  }
  const data = await response.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((block) => block?.type === "text")
        .map((block) => block.text || "")
        .join("")
    : "";
  return {
    content: text,
    usage: normalizeAnthropicUsage(data?.usage || {}),
    raw: data,
  };
}

module.exports = {
  isAnthropicProvider,
  buildMessagesEndpoint,
  buildAnthropicPayload,
  convertMessages,
  convertTools,
  normalizeAnthropicUsage,
  streamAnthropicMessage,
  completeAnthropicMessage,
};
