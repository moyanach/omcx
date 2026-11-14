/**
 * ReasoningPolicy — 思考内容（Reasoning / Thinking）分层策略模块
 *
 * 纯函数模块，零副作用，便于单测。回答两个正交问题：
 * 1. 落盘策略（persistence）：思考文本是否写盘、写多少（full / truncated / off）；
 * 2. 协议回传策略（replay）：当前请求是否需要把推理回传给上游，以及用哪种字段
 *    （Anthropic 的 thinking block / OpenAI 兼容的 reasoning_content / 不回传）。
 *
 * 关键约束（来自厂商官方文档）：
 * - Anthropic：assistant turn 内的 thinking block 必须连同 signature 原样回传，
 *   否则工具循环会掉质量甚至 400；
 * - DeepSeek：请求带 tools 时，历史 reasoning_content 应回传并拼入上下文；
 *   不带 tools 时回传会被忽略；
 * - 其余 OpenAI 兼容端点：默认不回传，避免未知字段导致 400。
 */

const PERSISTENCE_MODES = ["full", "truncated", "off"];
const REPLAY_SCOPES = ["current-run", "window", "off"];

const DEFAULT_PERSISTENCE = "full";
// 默认取向由用户确认：窗口 = 3（额外回传最近 3 个用户轮次的思考）
const DEFAULT_REPLAY_SCOPE = "window";
const DEFAULT_REPLAY_WINDOW = 3;

// truncated 档保留头尾，中间以标记替代
const TRUNCATED_HEAD_CHARS = 8000;
const TRUNCATED_TAIL_CHARS = 2000;
// full 档单条思考的硬性体积上限，超出后强制降级为 truncated 行为
const MAX_FULL_CHARS = 200000;
// 单个轮次回传的历史思考长度上限，避免窗口回传把上下文与成本推爆
const MAX_REPLAY_CHARS = 20000;

const TRUNCATED_MARKER = (original) => `\n\n…[思考已截断，原始 ${original} 字符]\n\n`;

function normalizePersistence(mode) {
  const value = String(mode || "").trim().toLowerCase();
  return PERSISTENCE_MODES.includes(value) ? value : DEFAULT_PERSISTENCE;
}

function normalizeReplayScope(scope) {
  const value = String(scope || "").trim().toLowerCase();
  if (value === "current_run") return "current-run";
  return REPLAY_SCOPES.includes(value) ? value : DEFAULT_REPLAY_SCOPE;
}

function normalizeReplayWindow(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_REPLAY_WINDOW;
  return Math.min(20, Math.max(1, Math.floor(num)));
}

/**
 * 判定当前请求应采用的推理回传方式。
 * 与 services/anthropicClient.js 的 isAnthropicProvider 保持同一判定口径，
 * 但在此本地实现以避免 storageService → reasoningPolicy → anthropicClient 的耦合。
 */
function matchesAnthropicProvider(provider, baseUrl) {
  const p = String(provider || "").trim().toLowerCase();
  const url = String(baseUrl || "").trim().toLowerCase();
  return p === "anthropic" || p === "claude" || /anthropic\.com|\/anthropic|claude/.test(url);
}

/**
 * @returns {{ mode: 'none'|'openai-field'|'anthropic-block', field: string|null,
 *             includeHistory: boolean, scope: string, window: number }}
 */
function resolveReplayPolicy({ provider, baseUrl, modelId, hasTools, scope, window } = {}) {
  const resolvedScope = normalizeReplayScope(scope);
  const resolvedWindow = normalizeReplayWindow(window);

  // Anthropic：thinking block 属于协议必需项，工具循环不回传会导致质量下降或直接 400，
  // 因此不受 reasoning_replay_scope=off 影响；但历史轮次缺 signature 无法回传，
  // 故恒为 includeHistory=false（仅同一 run 内回传）。
  if (matchesAnthropicProvider(provider, baseUrl)) {
    return {
      mode: "anthropic-block",
      field: "reasoning",
      includeHistory: false,
      scope: resolvedScope,
      window: resolvedWindow,
    };
  }

  if (resolvedScope === "off") {
    return {
      mode: "none",
      field: null,
      includeHistory: false,
      scope: resolvedScope,
      window: resolvedWindow,
    };
  }

  // DeepSeek 等 OpenAI 兼容推理端点：仅在请求携带 tools 时回传 reasoning_content，
  // 不带 tools 时官方明确忽略该字段，回传只会浪费带宽。
  if (hasTools) {
    return {
      mode: "openai-field",
      field: "reasoning_content",
      includeHistory: resolvedScope === "window",
      scope: resolvedScope,
      window: resolvedWindow,
    };
  }

  return {
    mode: "none",
    field: null,
    includeHistory: false,
    scope: resolvedScope,
    window: resolvedWindow,
  };
}

/**
 * 按落盘策略裁剪思考文本。
 *
 * @returns {{ text: string, chars: number, truncated: boolean }}
 *   - text：真正允许落盘（或进入内存行）的内容，off 档恒为空串；
 *   - chars：**原始**字符数，用于 UI 折叠条计数；off 档同样返回原始值，
 *     调用方需按 off 语义把它落成 0；
 *   - truncated：是否发生了裁剪。
 */
function shapeForPersistence(text, mode) {
  const raw = typeof text === "string" ? text : "";
  const chars = raw.length;
  const resolvedMode = normalizePersistence(mode);

  if (!raw) return { text: "", chars: 0, truncated: false };
  if (resolvedMode === "off") return { text: "", chars, truncated: true };

  // full 档的异常体积护栏：单条超过 200k 字符时按 truncated 行为降级
  if (resolvedMode === "full" && chars <= MAX_FULL_CHARS) {
    return { text: raw, chars, truncated: false };
  }

  if (chars <= TRUNCATED_HEAD_CHARS + TRUNCATED_TAIL_CHARS) {
    return { text: raw, chars, truncated: false };
  }

  const head = raw.slice(0, TRUNCATED_HEAD_CHARS);
  const tail = raw.slice(-TRUNCATED_TAIL_CHARS);
  return {
    text: `${head}${TRUNCATED_MARKER(chars)}${tail}`,
    chars,
    truncated: true,
  };
}

/**
 * 从一条 assistant 消息中提取可回传的推理文本。
 * 绝不解析 <think> 字面量：v2.1.9 起思考走独立通道，正文中出现同名标签属正常文本。
 */
function extractReplayReasoning(message) {
  if (!message || typeof message !== "object") return null;
  const candidates = [message.reasoning, message.reasoning_content, message.reasoningContent];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * 构造可回传的推理载荷（含长度护栏）。
 * @returns {{ field: string, value: string } | null}
 */
function buildReplayPayload(policy, message, maxChars = MAX_REPLAY_CHARS) {
  if (!policy || policy.mode === "none") return null;
  const reasoning = extractReplayReasoning(message);
  if (!reasoning) return null;
  const limit = Number(maxChars) > 0 ? Number(maxChars) : MAX_REPLAY_CHARS;
  const value =
    reasoning.length > limit
      ? `${reasoning.slice(0, limit)}\n\n…[回传截断，原始 ${reasoning.length} 字符]`
      : reasoning;
  return { field: policy.field, value };
}

module.exports = {
  PERSISTENCE_MODES,
  REPLAY_SCOPES,
  DEFAULT_PERSISTENCE,
  DEFAULT_REPLAY_SCOPE,
  DEFAULT_REPLAY_WINDOW,
  MAX_FULL_CHARS,
  MAX_REPLAY_CHARS,
  normalizePersistence,
  normalizeReplayScope,
  normalizeReplayWindow,
  matchesAnthropicProvider,
  resolveReplayPolicy,
  shapeForPersistence,
  extractReplayReasoning,
  buildReplayPayload,
};
