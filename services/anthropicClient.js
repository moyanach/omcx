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
}) {
  const { system, messages: converted } = convertMessages(messages);
  const anthropicTools = convertTools(tools);
  const cached = applyCacheControl(system, anthropicTools, converted);

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
  if (Number.isFinite(Number(temperature))) {
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
  });

  const response = await fetch(buildMessagesEndpoint(baseUrl), {
    method: "POST",
    headers: anthropicHeaders(apiKey),
    signal,
    body: JSON.stringify(payload),
  });

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
        onReasoning?.(delta.thinking);
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        const tool = toolCallsByBlock.get(json.index);
        if (tool) tool.function.arguments += delta.partial_json;
      }
      return;
    }
    if (type === "content_block_stop") {
      const tool = toolCallsByBlock.get(json.index);
      if (tool && !tool.function.arguments) tool.function.arguments = "{}";
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

  try {
    while (true) {
      const { done, value } = await reader.read();
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

  if (!finishReason && toolCalls.length > 0) finishReason = "tool_calls";

  return {
    content,
    reasoning,
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
