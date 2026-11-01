const { estimateTokens } = require("./contextCalculator");

const DEFAULTS = {
  outputReserve: 4096,
  keepTokens: 20000,
  microRatio: 0.9,
  keepRecentToolResults: 5,
  toolResultMaxChars: 8000,
  summaryMaxTokens: 4096,
  maxConsecutiveFailures: 3,
};

const OVERFLOW_PATTERNS = [
  "context_length_exceeded",
  "maximum context length",
  "model_context_window_exceeded",
  "prompt is too long",
  "too many tokens",
  "input length",
];

const SUMMARY_PROMPT = `你的任务是把以上对话压缩成一份结构化摘要，供另一个 Agent 继续工作。只总结用户和助手说过、做过的事；不要复述系统提示、项目规则、环境信息（这些会重新注入）。不要调用任何工具，只输出纯文本。

严格按以下格式输出（不适用的段落写“无”）：
## 目标
- 用 1-2 句话说明用户要完成什么
## 需求与约束
- 用户明确提出的要求、偏好、范围边界
## 已做出的决定
- 已确定的方案及原因
## 工作进展
### 已完成
- ...
### 进行中
- ...
### 阻塞
- ...
## 下一步
1. 按顺序列出接下来要做的动作
## 相关文件
- \`路径\`: 为什么重要（最多 15 个，按重要性排序）
## 重要上下文
- 下一个 Agent 无法从代码或文件自行恢复的事实、报错原文、命令、标识符

规则：
- 每条尽量一行，简洁，不要嵌套列表。
- 保留精确的文件路径、函数名、命令、报错字符串、URL。
- 已被后续对话解决的问题不要重复。
- 不要提及“上下文被压缩”这件事。`;

function estimateContentTokens(content) {
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const part of content) {
      if (!part) continue;
      if (part.type === "text") {
        tokens += estimateTokens(part.text || "");
      } else if (part.type === "image_url") {
        tokens += 1500;
      }
    }
    return tokens;
  }
  return estimateTokens(content);
}

function estimateMessagesTokens(messages = []) {
  let tokens = 0;
  for (const message of messages) {
    if (!message) continue;
    tokens += estimateContentTokens(message.content);
    if (message.tool_calls) {
      try {
        tokens += estimateTokens(JSON.stringify(message.tool_calls));
      } catch {
        // 忽略无法序列化的 tool_calls
      }
    }
  }
  return tokens;
}

function getThresholds(contextLimit, cfg = {}) {
  const outputReserve = Number(cfg.outputReserve) || DEFAULTS.outputReserve;
  const percent = Number(cfg.thresholdPercent) || 85;
  const effective = Math.max(1, Number(contextLimit) - outputReserve);
  const buffer = Math.max(1000, Math.min(13000, effective * 0.1));
  const bufferThreshold = Math.max(1, effective - buffer);
  const percentThreshold = Math.max(1, effective * (percent / 100));
  const threshold = Math.max(1, Math.min(bufferThreshold, percentThreshold));
  return {
    effective,
    buffer,
    threshold,
    microThreshold: threshold * (Number(cfg.microRatio) || DEFAULTS.microRatio),
  };
}

function shouldMicroCompact(tokens, thresholds) {
  return tokens > thresholds.microThreshold;
}

function microCompact(messages, cfg = {}) {
  const keepRecent = Number(cfg.keepRecentToolResults) || DEFAULTS.keepRecentToolResults;
  const toolIndexes = [];
  messages.forEach((message, index) => {
    if (message.role === "tool") toolIndexes.push(index);
  });
  const keepSet = new Set(toolIndexes.slice(-keepRecent));

  let saved = 0;
  let cleared = 0;
  const next = messages.map((message, index) => {
    if (message.role !== "tool" || keepSet.has(index)) return message;
    const original = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    if (!original || original.startsWith("[旧工具输出已清理")) return message;
    const replacement = `[旧工具输出已清理，原始 ${original.length} 字符]`;
    saved += Math.max(0, original.length - replacement.length);
    cleared += 1;
    return { ...message, content: replacement };
  });

  return { messages: next, saved, cleared };
}

function truncateToolResult(content, maxChars = DEFAULTS.toolResultMaxChars) {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (text.length <= maxChars) return text;

  const head = 5000;
  const tail = 2000;
  if (maxChars < head + tail) {
    return `${text.slice(0, maxChars)}\n…[已截断，原始 ${text.length} 字符]`;
  }
  return `${text.slice(0, head)}\n…[已截断，原始 ${text.length} 字符]…\n${text.slice(-tail)}`;
}

function truncateMiddle(text, maxChars) {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? "");
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head);
  return `${value.slice(0, head)}\n…[已截断]…\n${value.slice(-tail)}`;
}

function buildGroups(messages) {
  const groups = [];
  let current = null;

  for (const message of messages) {
    if (!message || message.role === "system") continue;

    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      current = { messages: [message], tokens: estimateMessagesTokens([message]) };
      groups.push(current);
    } else if (message.role === "tool" && current) {
      current.messages.push(message);
      current.tokens += estimateMessagesTokens([message]);
    } else {
      current = { messages: [message], tokens: estimateMessagesTokens([message]) };
      groups.push(current);
    }
  }

  return groups;
}

function selectKeepWindow(messages, keepTokens = DEFAULTS.keepTokens) {
  const groups = buildGroups(messages);
  if (groups.length === 0) {
    return { keepMessages: [], summarizeMessages: [] };
  }

  let startIndex = groups.length;
  let accumulated = 0;

  for (let i = groups.length - 1; i >= 0; i -= 1) {
    accumulated += groups[i].tokens;
    startIndex = i;
    if (accumulated >= keepTokens) break;
  }

  let lastUserIndex = -1;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (groups[i].messages.some((message) => message.role === "user")) {
      lastUserIndex = i;
      break;
    }
  }

  const keepGroups = groups.slice(startIndex);
  let summarizeGroups = groups.slice(0, startIndex);

  if (lastUserIndex >= 0 && lastUserIndex < startIndex) {
    keepGroups.unshift(groups[lastUserIndex]);
    summarizeGroups = summarizeGroups.filter((_, index) => index !== lastUserIndex);
  }

  return {
    keepMessages: keepGroups.flatMap((group) => group.messages),
    summarizeMessages: summarizeGroups.flatMap((group) => group.messages),
  };
}

function buildSummaryPrompt() {
  return SUMMARY_PROMPT;
}

function buildTranscript(messages, maxChars) {
  const blocks = [];

  for (const message of messages) {
    if (!message || message.role === "system") continue;

    let content = "";
    if (Array.isArray(message.content)) {
      content = message.content
        .map((part) => (part?.type === "text" ? part.text || "" : "[图片]"))
        .join("\n");
    } else if (typeof message.content === "string") {
      content = message.content;
    } else {
      content = JSON.stringify(message.content || "");
    }

    content = truncateMiddle(content, 2000);

    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const calls = message.tool_calls
        .map((call) => `${call.function?.name || "tool"}(${truncateMiddle(call.function?.arguments || "", 300)})`)
        .join(", ");
      content = `${content}${content ? "\n" : ""}[调用工具: ${calls}]`;
    }

    blocks.push(`### ${message.role}\n${content}`);
  }

  let transcript = blocks.join("\n\n");
  while (blocks.length > 1 && transcript.length > maxChars) {
    blocks.shift();
    transcript = blocks.join("\n\n");
  }
  if (transcript.length > maxChars) {
    transcript = transcript.slice(-maxChars);
  }
  return transcript;
}

async function summarizeMessages({
  messages,
  modelBaseUrl,
  modelApiKey,
  apiModelId,
  headers = {},
  maxTokens = DEFAULTS.summaryMaxTokens,
  maxChars = 120000,
}) {
  const transcript = buildTranscript(messages, maxChars);
  const prompt = buildSummaryPrompt();

  const response = await fetch(`${modelBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: JSON.stringify({
      model: apiModelId,
      messages: [
        {
          role: "user",
          content: `以下是需要压缩的对话记录：\n\n${transcript}\n\n---\n\n${prompt}`,
        },
      ],
      stream: false,
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`摘要请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error("摘要请求返回为空");
  }
  return String(content).trim();
}

async function compactMessages({ messages, systemMessage, thresholds, modelCfg, cfg = {} }) {
  const systemTokens = estimateTokens(systemMessage?.content || "");
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const before = estimateMessagesTokens(nonSystemMessages) + systemTokens;

  const keepTokens = Number(cfg.keepTokens) || DEFAULTS.keepTokens;
  const { keepMessages, summarizeMessages: toSummarize } = selectKeepWindow(messages, keepTokens);

  if (toSummarize.length === 0) {
    return { messages, summaryBlock: "", before, after: before, kept: keepMessages.length, summarized: 0 };
  }

  const summary = await summarizeMessages({
    messages: toSummarize,
    modelBaseUrl: modelCfg.baseUrl,
    modelApiKey: modelCfg.apiKey,
    apiModelId: modelCfg.modelId,
    headers: modelCfg.headers,
    maxTokens: DEFAULTS.summaryMaxTokens,
    maxChars: Math.max(20000, thresholds.threshold * 3.5),
  });

  const summaryBlock = `【会话压缩摘要（早期对话已压缩）】\n${summary}`;
  const nextMessages = systemMessage ? [systemMessage, ...keepMessages] : [...keepMessages];
  const after =
    estimateMessagesTokens(keepMessages) + systemTokens + estimateTokens(summaryBlock);

  return {
    messages: nextMessages,
    summaryBlock,
    before,
    after,
    kept: keepMessages.length,
    summarized: toSummarize.length,
  };
}

function hardTruncate(messages, threshold) {
  const systemMessage = messages.find((message) => message.role === "system");
  const groups = buildGroups(messages);

  let start = 0;
  let total = estimateMessagesTokens(messages);

  while (start < groups.length - 1 && total > threshold) {
    const group = groups[start];
    const hasLaterUser = groups
      .slice(start + 1)
      .some((item) => item.messages.some((message) => message.role === "user"));
    const isLastUserGroup = group.messages.some((message) => message.role === "user") && !hasLaterUser;
    if (isLastUserGroup) break;

    total -= group.tokens;
    start += 1;
  }

  const kept = groups.slice(start).flatMap((group) => group.messages);
  return systemMessage ? [systemMessage, ...kept] : kept;
}

function isContextOverflowError(errText) {
  const text = String(errText || "").toLowerCase();
  return OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern));
}

module.exports = {
  estimateMessagesTokens,
  getThresholds,
  shouldMicroCompact,
  microCompact,
  truncateToolResult,
  selectKeepWindow,
  buildSummaryPrompt,
  summarizeMessages,
  compactMessages,
  hardTruncate,
  isContextOverflowError,
};
