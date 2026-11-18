const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

const {
  sanitizeUrl,
  isRetriableModelError,
  createHttpModelError,
  diagnoseModelError,
  serializeModelErrorPayload,
  formatModelErrorText,
} = require("../services/modelErrorService");
const { isTransientSocketError } = require("../main/runner/streamTransport");

test("modelErrorService 精准识别 ECONNREFUSED / AggregateError 且禁止无效重试", () => {
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3425"), {
    code: "ECONNREFUSED",
    errno: -61,
    syscall: "connect",
    address: "127.0.0.1",
    port: 3425,
  });
  const fetchErr = new TypeError("fetch failed", { cause: inner });

  assert.equal(isRetriableModelError(fetchErr), false);
  assert.equal(isTransientSocketError(fetchErr), false);

  const diag = diagnoseModelError(fetchErr, {
    provider: "openai",
    model: "gpt-4o",
    baseUrl: "http://127.0.0.1:3425/v1",
    endpoint: "http://127.0.0.1:3425/v1/chat/completions",
  });
  assert.equal(diag.type, "MODEL_REQUEST_ERROR");
  assert.equal(diag.category, "connection_refused");
  assert.equal(diag.code, "ECONNREFUSED");
  assert.equal(diag.target, "127.0.0.1:3425");
  assert.match(diag.summary, /127\.0\.0\.1:3425/);
  assert.match(diag.summary, /拒绝连接/);
  assert.ok(diag.suggestions.some((s) => s.includes("127.0.0.1:3425")));

  // 双栈 localhost AggregateError
  const v6Err = Object.assign(new Error("connect ECONNREFUSED ::1:11434"), {
    code: "ECONNREFUSED",
    address: "::1",
    port: 11434,
  });
  const v4Err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
    code: "ECONNREFUSED",
    address: "127.0.0.1",
    port: 11434,
  });
  const agg = new AggregateError([v6Err, v4Err], "");
  const aggFetch = new TypeError("fetch failed", { cause: agg });
  const aggDiag = diagnoseModelError(aggFetch, { baseUrl: "http://localhost:11434/v1" });
  assert.equal(aggDiag.category, "connection_refused");
  assert.equal(isRetriableModelError(aggFetch), false);
});

test("modelErrorService 区分 DNS/TLS/URL/超时与瞬时 Socket 错误", () => {
  const dnsErr = new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.bad-host.local"), {
      code: "ENOTFOUND",
      hostname: "api.bad-host.local",
    }),
  });
  assert.equal(isRetriableModelError(dnsErr), false);
  const dnsDiag = diagnoseModelError(dnsErr);
  assert.equal(dnsDiag.category, "dns_not_found");
  assert.match(dnsDiag.summary, /api\.bad-host\.local/);

  const tlsErr = new TypeError("fetch failed", {
    cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
  });
  assert.equal(isRetriableModelError(tlsErr), false);
  assert.equal(diagnoseModelError(tlsErr).category, "tls_error");

  const urlErr = Object.assign(new TypeError("Failed to parse URL from not-a-url"), {
    code: "ERR_INVALID_URL",
  });
  assert.equal(isRetriableModelError(urlErr), false);
  assert.equal(diagnoseModelError(urlErr).category, "invalid_url");

  const connectTimeoutErr = Object.assign(new Error("连接 Anthropic 接口超时"), {
    name: "ModelConnectTimeoutError",
    code: "MODEL_CONNECT_TIMEOUT",
  });
  assert.equal(diagnoseModelError(connectTimeoutErr, { baseUrl: "https://api.anthropic.com" }).category, "connect_timeout");

  // 瞬时断流才允许重试
  const socketErr = new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
  assert.equal(isRetriableModelError(socketErr), true);
  assert.equal(isTransientSocketError(socketErr), true);
  assert.equal(diagnoseModelError(socketErr).category, "socket_closed");
});

test("modelErrorService 提取 HTTP JSON/HTML 错误摘要并脱敏 URL 查询密钥", () => {
  assert.equal(
    sanitizeUrl("https://example.com/v1/models?key=secret123&foo=1"),
    "https://example.com/v1/models?key=***&foo=1"
  );

  const err504 = createHttpModelError({
    status: 504,
    statusText: "Gateway Timeout",
    rawBody: JSON.stringify({
      error: {
        message: "Gateway global request budget (270s) exhausted",
        gateway_error: { readable_summary: "【上游错误 HTTP 504】网关请求超时" },
      },
    }),
    provider: "custom",
    model: "gemini-pro",
    baseUrl: "https://gw.example.com/v1",
    endpoint: "https://gw.example.com/v1/chat/completions",
  });
  assert.equal(isRetriableModelError(err504), false);
  const diag504 = diagnoseModelError(err504);
  assert.equal(diag504.category, "http_error");
  assert.equal(diag504.status, 504);
  assert.match(diag504.summary, /504/);
  assert.match(diag504.reason, /上游错误 HTTP 504/);

  const err502Html = createHttpModelError({
    status: 502,
    rawBody: "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
    endpoint: "https://gw.example.com/v1/chat/completions",
  });
  const diag502 = diagnoseModelError(err502Html);
  assert.equal(diag502.upstreamMessage, "502 Bad Gateway");
  assert.match(formatModelErrorText(err502Html), /502 Bad Gateway/);
});

test("前端 formatErrorContent 正确渲染 MODEL_REQUEST_ERROR 且不对纯文本重复代码块", () => {
  const entryPath = path.resolve(__dirname, "../src/hooks/useStreamChat.ts");
  const built = esbuild.buildSync({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { "@": path.resolve(__dirname, "../src") },
    external: ["react", "zustand", "zustand/*"],
  });
  const mod = new Module(entryPath);
  mod.filename = entryPath;
  mod.paths = Module._nodeModulePaths(path.dirname(entryPath));
  mod._compile(built.outputFiles[0].text, entryPath);

  const { formatErrorContent } = mod.exports;
  assert.equal(typeof formatErrorContent, "function");

  const payload = serializeModelErrorPayload(
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3425"), {
        code: "ECONNREFUSED",
        address: "127.0.0.1",
        port: 3425,
      }),
    }),
    {
      provider: "openai",
      model: "gpt-4o",
      endpoint: "http://127.0.0.1:3425/v1/chat/completions",
    }
  );
  const rendered = formatErrorContent(payload);
  assert.match(rendered, /127\.0\.0\.1:3425/);
  assert.match(rendered, /排查建议/);
  assert.match(rendered, /<details>/);
  assert.doesNotMatch(rendered, /<details open>/);

  // 普通文本错误不再附带重复的 ```text 代码块
  const plainRendered = formatErrorContent("请先在【设置】中配置该模型的 API Key");
  assert.match(plainRendered, /请先在【设置】中配置该模型的 API Key/);
  assert.doesNotMatch(plainRendered, /```text/);
});
