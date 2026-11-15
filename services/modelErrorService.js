// 模型请求错误诊断与可重试判定（纯 JS，Headless CLI / Worker 安全，禁止引入 electron）

const RETRIABLE_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "ERR_STREAM_PREMATURE_CLOSE",
  "PREMATURE_CLOSE",
]);

const NON_RETRIABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EACCES",
  "EPERM",
  "ERR_INVALID_URL",
  "ERR_UNSUPPORTED_PROTOCOL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function sanitizeUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";
  try {
    const u = new URL(input);
    for (const key of Array.from(u.searchParams.keys())) {
      if (/key|token|secret|auth|password/i.test(key)) {
        u.searchParams.set(key, "***");
      }
    }
    return u.toString();
  } catch {
    return input.replace(/([?&](?:api_?key|key|token|secret)=)[^&\s]+/gi, "$1***");
  }
}

function extractHostPortFromUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    if (!u.hostname) return "";
    if (u.port) return `${u.hostname}:${u.port}`;
    return u.hostname;
  } catch {
    return "";
  }
}

function collectErrorChain(err) {
  const nodes = [];
  const visited = new Set();
  const queue = [err];

  while (queue.length > 0 && nodes.length < 16) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;
    if (visited.has(cur)) continue;
    visited.add(cur);
    nodes.push(cur);

    if (cur.cause) queue.push(cur.cause);
    if (Array.isArray(cur.errors)) {
      for (const sub of cur.errors) queue.push(sub);
    }
  }
  return nodes;
}

function extractNetworkDetails(err, fallbackUrl = "") {
  const chain = collectErrorChain(err);
  let code = "";
  let address = "";
  let port = "";
  let hostname = "";
  let syscall = "";
  const causeMessages = [];

  for (const node of chain) {
    const nodeCode = node.code ? String(node.code).toUpperCase() : "";
    if (!code && nodeCode) {
      code = nodeCode;
    } else if (
      nodeCode &&
      nodeCode !== code &&
      (NON_RETRIABLE_CODES.has(nodeCode) || RETRIABLE_CODES.has(nodeCode) || /^UND_ERR_|^ERR_TLS_|^ERR_SSL_/.test(nodeCode))
    ) {
      code = nodeCode;
    }

    if (!address && node.address) address = String(node.address);
    if (!port && node.port !== undefined && node.port !== null && node.port !== "") {
      port = String(node.port);
    }
    if (!hostname && node.hostname) hostname = String(node.hostname);
    if (!syscall && node.syscall) syscall = String(node.syscall);

    const msg = String(node.message || "").trim();
    if (msg && !causeMessages.includes(msg)) {
      causeMessages.push(msg);
    }
  }

  let target = "";
  if (address && port) {
    target = address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
  } else if (address) {
    target = address;
  } else if (hostname && port) {
    target = `${hostname}:${port}`;
  } else if (hostname) {
    target = hostname;
  } else if (fallbackUrl) {
    target = extractHostPortFromUrl(fallbackUrl);
  }

  // 若 AggregateError 未在顶层留下单个 address/port，尝试从 causeMessages 里兜底提取
  if (!target) {
    for (const msg of causeMessages) {
      const m = msg.match(/(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\s+([^\s)]+)/i);
      if (m && m[1]) {
        target = m[1];
        break;
      }
    }
  }

  return {
    code,
    address,
    port,
    hostname,
    syscall,
    target,
    causeMessages,
  };
}

function isTlsErrorCode(code) {
  if (!code) return false;
  return (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  );
}

/**
 * 精准判定网络层错误是否为可安全重试的瞬时故障。
 * 确定性错误（ECONNREFUSED、ENOTFOUND、URL 非法、TLS 校验失败、HTTP 4xx/5xx）一律不重试。
 */
function isRetriableModelError(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.code === "ABORT_ERR") return false;
  if (Number.isFinite(Number(err.status)) && Number(err.status) > 0) return false;

  const { code, causeMessages } = extractNetworkDetails(err);
  if (code) {
    if (NON_RETRIABLE_CODES.has(code) || isTlsErrorCode(code)) return false;
    if (RETRIABLE_CODES.has(code)) return true;
    if (code === "UND_ERR_BODY_TIMEOUT") return true;
    if (code === "STREAM_IDLE_TIMEOUT" || code === "SUBAGENT_IDLE_TIMEOUT") return false;
  }

  const combined = [String(err.message || ""), ...causeMessages].join(" ").toLowerCase();
  if (
    combined.includes("econnrefused") ||
    combined.includes("enotfound") ||
    combined.includes("invalid url") ||
    combined.includes("certificate") ||
    combined.includes("self signed") ||
    combined.includes("400 bad request")
  ) {
    return false;
  }

  return (
    combined.includes("terminated") ||
    combined.includes("other side closed") ||
    combined.includes("socket hang up") ||
    combined.includes("econnreset") ||
    combined.includes("epipe") ||
    combined.includes("premature close")
  );
}

function attachModelErrorContext(err, context = {}) {
  if (!err || typeof err !== "object") return err;
  const prev = err.modelErrorContext && typeof err.modelErrorContext === "object"
    ? err.modelErrorContext
    : {};
  const merged = { ...prev };
  if (context.provider && !merged.provider) merged.provider = String(context.provider);
  if (context.model && !merged.model) merged.model = String(context.model);
  if (context.baseUrl && !merged.baseUrl) merged.baseUrl = sanitizeUrl(context.baseUrl);
  if (context.endpoint && !merged.endpoint) merged.endpoint = sanitizeUrl(context.endpoint);
  if (context.phase && !merged.phase) merged.phase = String(context.phase);
  if (Number.isFinite(Number(context.toolRound)) && merged.toolRound === undefined) {
    merged.toolRound = Number(context.toolRound);
  }
  err.modelErrorContext = merged;
  return err;
}

function extractUpstreamErrorMessage(rawBody) {
  const text = String(rawBody || "").trim();
  if (!text) return "";

  try {
    const parsed = JSON.parse(text);
    const errObj = parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
    const candidate =
      errObj?.gateway_error?.readable_summary ||
      errObj?.readable_summary ||
      errObj?.message ||
      parsed?.message ||
      parsed?.detail ||
      (typeof parsed?.error === "string" ? parsed.error : "");
    if (candidate && typeof candidate === "string") {
      return candidate.trim().slice(0, 600);
    }
  } catch {}

  if (/<!doctype|<html/i.test(text)) {
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 300);
    }
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  return text.slice(0, 600);
}

function createHttpModelError({
  status,
  statusText = "",
  rawBody = "",
  provider = "",
  model = "",
  baseUrl = "",
  endpoint = "",
  prefix = "API 请求失败",
} = {}) {
  const numStatus = Number(status) || 0;
  const upstreamMsg = extractUpstreamErrorMessage(rawBody);
  const label = upstreamMsg
    ? `${prefix} (${numStatus}): ${upstreamMsg}`
    : `${prefix} (${numStatus}${statusText ? ` ${statusText}` : ""})`;
  const err = new Error(label);
  err.name = "ModelHttpError";
  err.status = numStatus;
  err.statusText = String(statusText || "");
  err.rawBody = String(rawBody || "").slice(0, 4000);
  return attachModelErrorContext(err, { provider, model, baseUrl, endpoint });
}

function buildHttpDiagnostics(status, statusText, upstreamMessage, target) {
  const codeLabel = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  switch (status) {
    case 400:
      return {
        summary: `请求参数被模型接口拒绝 (${codeLabel})`,
        reason: upstreamMessage || "服务端返回 400 Bad Request，请求体字段或参数不被支持。",
        suggestions: [
          "检查所选模型 ID 是否正确，或当前网关是否支持所请求的扩展参数（如思考模式/工具调用）",
          "若模型为自定义兼容接口，确认其完整支持 OpenAI / Anthropic 协议格式",
        ],
      };
    case 401:
      return {
        summary: `模型 API Key 认证失败或已失效 (${codeLabel})`,
        reason: upstreamMessage || "服务端拒绝认证（401 Unauthorized）。",
        suggestions: [
          "前往【设置 -> 模型】检查该模型的 API Key 是否填写正确、是否已过期或包含多余空格",
          "确认所选 Provider 与当前 Key 所属平台一致",
        ],
      };
    case 403:
      return {
        summary: `无权访问该模型或接口被拒绝 (${codeLabel})`,
        reason: upstreamMessage || "服务端返回 403 Forbidden。",
        suggestions: [
          "确认当前账户有权限调用该模型、账户余额充足或未触发地区/IP 限制",
          "若使用中转网关，检查令牌分组权限与白名单模型配置",
        ],
      };
    case 404:
      return {
        summary: `模型接口路径或模型不存在 (${codeLabel})`,
        reason: upstreamMessage || `目标接口 ${target || ""} 返回 404 Not Found。`,
        suggestions: [
          "检查【设置 -> 模型】中的 Base URL 是否正确（如是否需要或误加了 /v1 后缀）",
          "确认模型 ID 拼写与服务端模型列表一致",
        ],
      };
    case 408:
      return {
        summary: `模型网关等待请求超时 (${codeLabel})`,
        reason: upstreamMessage || "上游网关返回 408 Request Timeout。",
        suggestions: ["当前网络或上游网关响应较慢，请稍后重试"],
      };
    case 413:
      return {
        summary: `请求内容过大，超出模型接口限制 (${codeLabel})`,
        reason: upstreamMessage || "单次请求体积（上下文或图片附件）超过网关上限。",
        suggestions: [
          "建议压缩上下文、移除大体积附件或新开会话后继续",
        ],
      };
    case 429:
      return {
        summary: `触发模型接口速率或并发限流 (${codeLabel})`,
        reason: upstreamMessage || "请求频率（RPM/TPM）或并发数超出配额上限。",
        suggestions: [
          "等待几十秒后重试，或降低并发子代理/工具调用频率",
          "检查账户剩余额度与 API Key 限流配额",
        ],
      };
    default:
      if (status >= 500) {
        return {
          summary: `模型服务端或网关异常 (${codeLabel})`,
          reason: upstreamMessage || `上游服务返回 ${status} 错误，属于服务端或网关临时故障。`,
          suggestions: [
            "若为 504/502，通常是上游模型生成过慢触及网关超时预算或节点重启，可稍后重试",
            "如持续出现，尝试切换其他可用模型、降低思考深度或更换备用网关节点",
          ],
        };
      }
      return {
        summary: `模型接口返回异常 (${codeLabel})`,
        reason: upstreamMessage || `服务端返回状态码 ${status}。`,
        suggestions: ["请查看下方响应详情排查配置或服务端状态"],
      };
  }
}

function diagnoseModelError(err, extraContext = {}) {
  const mergedCtx = {
    ...(err?.modelErrorContext || {}),
    ...(extraContext || {}),
  };
  const provider = String(mergedCtx.provider || "").trim();
  const model = String(mergedCtx.model || "").trim();
  const baseUrl = sanitizeUrl(mergedCtx.baseUrl || "");
  const endpoint = sanitizeUrl(mergedCtx.endpoint || baseUrl);
  const toolRound = Number.isFinite(Number(mergedCtx.toolRound))
    ? Number(mergedCtx.toolRound)
    : null;

  const status = Number.isFinite(Number(err?.status)) && Number(err.status) > 0
    ? Number(err.status)
    : null;

  if (!status) {
    // 尝试从传统格式错误消息中提取 HTTP 状态码（兼容未走 createHttpModelError 的旧调用方）
    const rawMsg = String(err?.message || "");
    const httpMatch = rawMsg.match(/(?:API\s*请求失败|HTTP)\s*\(?(\d{3})\)?\s*[:：]?\s*([\s\S]*)/i);
    if (httpMatch) {
      const parsedStatus = Number(httpMatch[1]);
      if (parsedStatus >= 400 && parsedStatus < 600) {
        const bodyPart = String(httpMatch[2] || "").trim();
        const upstreamMessage = extractUpstreamErrorMessage(bodyPart);
        const target = extractHostPortFromUrl(endpoint || baseUrl);
        const diag = buildHttpDiagnostics(parsedStatus, "", upstreamMessage, target);
        return {
          type: "MODEL_REQUEST_ERROR",
          category: "http_error",
          code: `HTTP_${parsedStatus}`,
          status: parsedStatus,
          summary: diag.summary,
          reason: diag.reason,
          target,
          endpoint,
          model,
          provider,
          toolRound,
          suggestions: diag.suggestions,
          upstreamMessage,
          rawDetails: bodyPart.slice(0, 1500),
        };
      }
    }
  }

  if (status) {
    const upstreamMessage = extractUpstreamErrorMessage(err?.rawBody || err?.message || "");
    const target = extractHostPortFromUrl(endpoint || baseUrl);
    const diag = buildHttpDiagnostics(status, err?.statusText || "", upstreamMessage, target);
    const rawBody = String(err?.rawBody || "").trim();
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "http_error",
      code: `HTTP_${status}`,
      status,
      summary: diag.summary,
      reason: diag.reason,
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: diag.suggestions,
      upstreamMessage,
      rawDetails: rawBody && rawBody !== upstreamMessage ? rawBody.slice(0, 1500) : "",
    };
  }

  const net = extractNetworkDetails(err, endpoint || baseUrl);
  const code = net.code;
  const target = net.target;
  const isLocal = /^(?:127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0)(?::\d+)?$/i.test(target);
  const combinedRaw = [String(err?.message || "").trim(), ...net.causeMessages]
    .filter(Boolean)
    .filter((v, idx, arr) => arr.indexOf(v) === idx)
    .join("\n");

  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(combinedRaw)) {
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "connection_refused",
      code: "ECONNREFUSED",
      status: null,
      summary: `无法连接到模型服务：${target || "目标地址"} 拒绝连接 (ECONNREFUSED)`,
      reason: `向 ${target || endpoint || "模型接口"} 建立 TCP 连接时被目标端口主动拒绝。`,
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: isLocal
        ? [
            `确认本地模型服务或 API 代理（${target}）已启动并正在监听该端口`,
            "检查【设置 -> 模型】中的 Base URL、端口号是否填写有误",
            "若该模型配置指向本地代理网关，请先启动对应代理或切换至直连模型",
          ]
        : [
            `确认目标服务端（${target || endpoint}）已启动且端口对外开放`,
            "检查【设置 -> 模型】中的 Base URL 域名与端口配置是否正确",
            "检查本地代理、VPN 或防火墙是否拦截了该端口连接",
          ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /ENOTFOUND|EAI_AGAIN/i.test(combinedRaw)) {
    const hostLabel = net.hostname || extractHostPortFromUrl(endpoint || baseUrl) || target;
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "dns_not_found",
      code: code || "ENOTFOUND",
      status: null,
      summary: `无法解析模型服务域名${hostLabel ? `（${hostLabel}）` : ""} (${code || "ENOTFOUND"})`,
      reason: `DNS 无法解析目标主机 ${hostLabel || ""}，请求未能发出。`,
      target: hostLabel,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: [
        "检查【设置 -> 模型】中的 Base URL 域名拼写是否正确",
        "检查当前本机网络连接、DNS 解析或系统代理/VPN 状态",
      ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  if (
    code === "MODEL_CONNECT_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    /connect timeout|ETIMEDOUT/i.test(combinedRaw)
  ) {
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "connect_timeout",
      code: code || "ETIMEDOUT",
      status: null,
      summary: `连接模型服务超时${target ? `（${target}）` : ""} (${code || "TIMEOUT"})`,
      reason: `在规定时间内未收到 ${target || endpoint || "目标服务"} 的连接或响应头回复。`,
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: [
        "检查网络连通性以及系统代理/VPN 是否能正常访问该接口",
        "确认目标网关未过载或被防火墙静默丢包，可稍后重试或切换可用节点",
      ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  if (
    code === "STREAM_IDLE_TIMEOUT" ||
    code === "SUBAGENT_IDLE_TIMEOUT" ||
    /空闲超时|未返回任何数据/i.test(combinedRaw)
  ) {
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "idle_timeout",
      code: code || "STREAM_IDLE_TIMEOUT",
      status: null,
      summary: "模型响应空闲超时，长时间未返回新数据",
      reason: String(err?.message || "连接建立后上游长时间未推送任何流式片段。"),
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: [
        "模型深度思考或上游网关排队时间过长触发了流式空闲保护",
        "可在【设置】调大流式空闲超时时间、降低思考强度或切换响应更快的模型",
      ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  if (isTlsErrorCode(code) || /certificate|self[- ]signed|unable to verify/i.test(combinedRaw)) {
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "tls_error",
      code: code || "TLS_ERROR",
      status: null,
      summary: `HTTPS / TLS 证书校验失败 (${code || "TLS_ERROR"})`,
      reason: "建立加密连接时未能验证对端证书有效性。",
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: [
        "确认 Base URL 的 HTTPS 证书有效且未过期",
        "若处于企业代理/抓包代理环境，确认代理根证书已受系统信任或改用有效证书端点",
      ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  if (
    code === "ERR_INVALID_URL" ||
    code === "ERR_UNSUPPORTED_PROTOCOL" ||
    /invalid url|failed to parse url/i.test(combinedRaw)
  ) {
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "invalid_url",
      code: code || "ERR_INVALID_URL",
      status: null,
      summary: "模型接口地址 (Base URL) 格式无效",
      reason: `无法解析请求地址${endpoint ? `：${endpoint}` : ""}。`,
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: [
        "打开【设置 -> 模型】检查 Base URL 是否包含 http:// 或 https:// 协议头，且无多余空格或非法字符",
      ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  if (
    RETRIABLE_CODES.has(code) ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    /terminated|other side closed|socket hang up|econnreset/i.test(combinedRaw)
  ) {
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "socket_closed",
      code: code || "SOCKET_CLOSED",
      status: null,
      summary: `与模型服务的连接意外断开 (${code || "SOCKET_CLOSED"})`,
      reason: "请求或流式传输过程中对端提前关闭了网络连接（已尝试自动重试仍失败）。",
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: [
        "检查网络连接、代理稳定性或上游网关的请求时长/包体限制",
        "稍后重试，或切换更稳定的接口节点",
      ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EACCES") {
    return {
      type: "MODEL_REQUEST_ERROR",
      category: "network_unreachable",
      code,
      status: null,
      summary: `目标网络不可达或访问受限 (${code})`,
      reason: `无法路由到目标地址 ${target || endpoint || ""}。`,
      target,
      endpoint,
      model,
      provider,
      toolRound,
      suggestions: [
        "检查本机网络、VPN 或代理配置是否允许访问该地址",
      ],
      upstreamMessage: "",
      rawDetails: combinedRaw,
    };
  }

  const concise = String(err?.message || "未知网络异常").trim();
  return {
    type: "MODEL_REQUEST_ERROR",
    category: "unknown",
    code: code || "",
    status: null,
    summary: concise.length > 140 ? `${concise.slice(0, 140)}…` : concise,
    reason: combinedRaw || concise,
    target,
    endpoint,
    model,
    provider,
    toolRound,
    suggestions: [
      "检查【设置 -> 模型】中的 Base URL、API Key 与模型 ID 配置",
    ],
    upstreamMessage: "",
    rawDetails: combinedRaw !== concise ? combinedRaw : "",
  };
}

function serializeModelErrorPayload(err, extraContext = {}) {
  return JSON.stringify(diagnoseModelError(err, extraContext));
}

function formatModelErrorText(err, extraContext = {}) {
  const diag = diagnoseModelError(err, extraContext);
  const parts = [diag.summary];
  if (diag.reason && diag.reason !== diag.summary) {
    parts.push(diag.reason);
  }
  if (Array.isArray(diag.suggestions) && diag.suggestions.length > 0) {
    parts.push(`建议：${diag.suggestions[0]}`);
  }
  return parts.join(" ");
}

module.exports = {
  sanitizeUrl,
  extractHostPortFromUrl,
  extractNetworkDetails,
  isRetriableModelError,
  attachModelErrorContext,
  extractUpstreamErrorMessage,
  createHttpModelError,
  diagnoseModelError,
  serializeModelErrorPayload,
  formatModelErrorText,
};
