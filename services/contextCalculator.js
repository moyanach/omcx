/**
 * ContextCalculator — 上下文预算与占用分解计算器
 *
 * 计算维度（完全对标 Claude Code / Codex Inspector）：
 * 1. Messages: 用户消息、助手消息、工具调用、工具返回
 * 2. System tools: 原生工具与 MCP 工具的 Function Calling Schema 定义
 * 3. System prompt: 系统基座提示词
 * 4. Skills: 已挂载技能的 Markdown 提示词说明
 * 5. Free space: 模型最大上下文限制减去以上占用
 */

/**
 * 估算字符串的 Token 数量 (按中英混合规则，约 3.5 字符 ~ 1 Token)
 */
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== "string") {
    try {
      text = JSON.stringify(text);
    } catch {
      return 0;
    }
  }
  // 简单快速且平滑的 token 估算
  return Math.ceil(text.length / 3.5);
}

/**
 * 估算消息内容 Token（兼容 OpenAI 多模态 content 数组）
 */
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

/**
 * 计算完整的上下文分布数据
 * @param {object} params
 * @param {Array} params.messages - 历史对话消息
 * @param {Array} params.tools - 工具定义列表
 * @param {string} params.systemPrompt - 核心系统提示词
 * @param {Array} params.activeSkills - 激活的技能列表
 * @param {number} [params.maxTokensLimit=1000000] - 默认 1M 上下文上限 (1,000,000)
 */
function calculateContextMetrics({
  messages = [],
  tools = [],
  systemPrompt = "",
  activeSkills = [],
  maxTokensLimit = 1000000,
}) {
  // 1. Messages Token
  let messagesTokens = 0;
  for (const msg of messages) {
    messagesTokens += estimateContentTokens(msg.content);
    if (msg.tool_calls) {
      messagesTokens += estimateTokens(msg.tool_calls);
    }
  }

  // 2. System tools Token
  let systemToolsTokens = 0;
  if (tools && tools.length > 0) {
    systemToolsTokens = estimateTokens(tools);
  }

  // 3. System prompt Token
  const systemPromptTokens = estimateTokens(systemPrompt);

  // 4. Skills Token
  let skillsTokens = 0;
  for (const skill of activeSkills) {
    skillsTokens += estimateTokens(skill.prompt || skill.description || "");
  }

  // 总已用与剩余
  const usedTokens = messagesTokens + systemToolsTokens + systemPromptTokens + skillsTokens;
  const freeSpaceTokens = Math.max(0, maxTokensLimit - usedTokens);
  const usedPercent = Math.min(100, (usedTokens / maxTokensLimit) * 100);

  const calcPct = (tokens) => ((tokens / maxTokensLimit) * 100).toFixed(1);

  return {
    totalLimit: maxTokensLimit,
    totalLimitFormatted: formatTokenCount(maxTokensLimit),
    usedTokens,
    usedTokensFormatted: formatTokenCount(usedTokens),
    usedPercent: parseFloat(usedPercent.toFixed(1)),
    breakdown: {
      messages: {
        tokens: messagesTokens,
        formatted: formatTokenCount(messagesTokens),
        percent: parseFloat(calcPct(messagesTokens)),
        color: "#3b82f6", // blue-500
        label: "Messages",
      },
      systemTools: {
        tokens: systemToolsTokens,
        formatted: formatTokenCount(systemToolsTokens),
        percent: parseFloat(calcPct(systemToolsTokens)),
        color: "#f97316", // orange-500
        label: "System tools",
      },
      systemPrompt: {
        tokens: systemPromptTokens,
        formatted: formatTokenCount(systemPromptTokens),
        percent: parseFloat(calcPct(systemPromptTokens)),
        color: "#22c55e", // green-500
        label: "System prompt",
      },
      skills: {
        tokens: skillsTokens,
        formatted: formatTokenCount(skillsTokens),
        percent: parseFloat(calcPct(skillsTokens)),
        color: "#eab308", // yellow-500
        label: "Skills",
      },
      freeSpace: {
        tokens: freeSpaceTokens,
        formatted: formatTokenCount(freeSpaceTokens),
        percent: parseFloat(((freeSpaceTokens / maxTokensLimit) * 100).toFixed(1)),
        color: "#404040", // neutral-700
        label: "Free space",
      },
    },
  };
}

function formatTokenCount(count) {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(count % 1000000 === 0 ? 0 : 1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

module.exports = {
  calculateContextMetrics,
  estimateTokens,
};
