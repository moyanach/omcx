/**
 * MCP OAuth 2.1 授权服务（授权码 + PKCE + 动态客户端注册）
 *
 * 支持：
 * - RFC 9728 Protected Resource Metadata 自动发现授权服务器；
 * - RFC 8414 / OIDC 授权服务器元数据发现；
 * - RFC 7591 动态客户端注册（配置了 clientId 时直接复用）；
 * - RFC 7636 PKCE (S256) 与 loopback 回调；
 * - RFC 8707 resource indicator；
 * - refresh_token 自动续期与本地加密落盘（<OMCX_HOME>/mcp-oauth.json）。
 *
 * 配置示例（~/.omcx/mcp.json）：
 *   {
 *     "mcpServers": {
 *       "remote": {
 *         "url": "https://example.com/mcp",
 *         "oauth": {
 *           "scopes": ["mcp.read", "mcp.write"],
 *           "clientId": "可选，预先注册的客户端",
 *           "clientSecret": "可选",
 *           "redirectPort": 33418
 *         }
 *       }
 *     }
 *   }
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_PORTS = [33418, 33419, 33420, 0];

function omcxHomeDir() {
  return process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
}

function storePath() {
  return path.join(omcxHomeDir(), "mcp-oauth.json");
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf-8"));
    return {
      version: 1,
      tokens: raw && typeof raw.tokens === "object" ? raw.tokens : {},
      clients: raw && typeof raw.clients === "object" ? raw.clients : {},
    };
  } catch {
    return { version: 1, tokens: {}, clients: {} };
  }
}

function writeStore(store) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp_${process.pid}_${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function tokenKey(server) {
  return String(server?.id || server?.url || "").trim();
}

function oauthConfig(server) {
  const raw = server?.oauth && typeof server.oauth === "object" ? server.oauth : {};
  return {
    scopes: Array.isArray(raw.scopes)
      ? raw.scopes.join(" ")
      : typeof raw.scopes === "string"
      ? raw.scopes
      : "",
    clientId: typeof raw.clientId === "string" ? raw.clientId : "",
    clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : "",
    clientAuthMethod:
      typeof raw.clientAuthMethod === "string" ? raw.clientAuthMethod : "",
    authorizationEndpoint:
      typeof raw.authorizationEndpoint === "string" ? raw.authorizationEndpoint : "",
    tokenEndpoint: typeof raw.tokenEndpoint === "string" ? raw.tokenEndpoint : "",
    registrationEndpoint:
      typeof raw.registrationEndpoint === "string" ? raw.registrationEndpoint : "",
    issuer: typeof raw.issuer === "string" ? raw.issuer : "",
    redirectPort: Number(raw.redirectPort) || 0,
  };
}

function isOAuthEnabled(server) {
  return Boolean(
    server &&
      server.url &&
      (server.oauth === true ||
        (server.oauth && typeof server.oauth === "object") ||
        server.auth?.type === "oauth")
  );
}

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function assertHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} 不是有效的 URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} 仅支持 http/https`);
  }
  return parsed;
}

function normalizeServerUrl(value) {
  try {
    return assertHttpUrl(value, "MCP 服务地址").toString();
  } catch {
    return "";
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    if (!text.trim()) return {};
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function discoverProtectedResource(serverUrl) {
  const target = assertHttpUrl(serverUrl, "MCP 服务地址");
  const candidates = [
    new URL("/.well-known/oauth-protected-resource", target.origin).toString(),
    new URL(
      `/.well-known/oauth-protected-resource${target.pathname.replace(/\/$/, "")}`,
      target.origin
    ).toString(),
  ];
  for (const candidate of candidates) {
    try {
      const data = await fetchJson(candidate);
      if (data && (data.authorization_servers?.length || data.resource)) return data;
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

async function discoverAuthorizationServer(issuer, config) {
  if (config.authorizationEndpoint && config.tokenEndpoint) {
    return {
      issuer: config.issuer || issuer,
      authorization_endpoint: config.authorizationEndpoint,
      token_endpoint: config.tokenEndpoint,
      registration_endpoint: config.registrationEndpoint || "",
    };
  }

  const base = assertHttpUrl(issuer || "", "OAuth 授权服务器");
  const pathSuffix = base.pathname && base.pathname !== "/" ? base.pathname.replace(/\/$/, "") : "";
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${pathSuffix}`, base.origin).toString(),
    new URL(`/.well-known/openid-configuration${pathSuffix}`, base.origin).toString(),
    new URL("/.well-known/oauth-authorization-server", base.origin).toString(),
    new URL("/.well-known/openid-configuration", base.origin).toString(),
  ];

  for (const candidate of candidates) {
    try {
      const meta = await fetchJson(candidate);
      if (meta?.authorization_endpoint && meta?.token_endpoint) {
        return { ...meta, issuer: meta.issuer || issuer };
      }
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error("未能发现 OAuth 授权服务器元数据，请在 MCP 配置的 oauth 中手动填写 authorizationEndpoint / tokenEndpoint");
}

async function resolveMetadata(server, config) {
  let issuer = config.issuer || "";
  let scopes = config.scopes;
  if (!config.authorizationEndpoint || !config.tokenEndpoint) {
    const prm = await discoverProtectedResource(server.url);
    if (prm) {
      issuer = prm.authorization_servers?.[0] || issuer;
      if (!scopes && Array.isArray(prm.scopes_supported)) {
        scopes = prm.scopes_supported.join(" ");
      }
    }
    if (!issuer) {
      issuer = new URL(server.url).origin;
    }
  }
  const meta = await discoverAuthorizationServer(issuer, config);
  return {
    ...meta,
    scope: scopes || (Array.isArray(meta.scopes_supported) ? meta.scopes_supported.join(" ") : ""),
  };
}

async function registerClient(server, meta, redirectUri, config, store) {
  const key = tokenKey(server);
  if (config.clientId) {
    return {
      client_id: config.clientId,
      client_secret: config.clientSecret || "",
      token_endpoint_auth_method:
        config.clientAuthMethod || (config.clientSecret ? "client_secret_basic" : "none"),
    };
  }

  const cacheKey = `${key}|${redirectUri}`;
  const cached = store.clients[cacheKey];
  if (cached?.client_id) return cached;

  if (!meta.registration_endpoint) {
    throw new Error(
      "授权服务器未提供动态客户端注册端点，请在 MCP 配置的 oauth 中填写 clientId / clientSecret"
    );
  }

  const payload = {
    client_name: "OMCX Desktop",
    application_type: "native",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(meta.scope ? { scope: meta.scope } : {}),
  };
  const data = await fetchJson(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 20000,
  });
  if (!data?.client_id) {
    throw new Error("动态客户端注册失败：授权服务器未返回 client_id");
  }
  const client = {
    client_id: data.client_id,
    client_secret: data.client_secret || "",
    token_endpoint_auth_method:
      data.token_endpoint_auth_method || (data.client_secret ? "client_secret_basic" : "none"),
    registered_at: Date.now(),
    redirect_uri: redirectUri,
    registration_endpoint: meta.registration_endpoint,
  };
  store.clients[cacheKey] = client;
  writeStore(store);
  return client;
}

function listenLoopback(preferredPort, context) {
  return new Promise((resolve, reject) => {
    const ports = Array.from(
      new Set([Number(preferredPort) || 0, ...DEFAULT_PORTS].filter((p) => p >= 0))
    );
    let index = 0;
    const tryNext = () => {
      if (index >= ports.length) {
        reject(new Error("无法启动 OAuth 本地回调端口"));
        return;
      }
      const port = ports[index++];
      const server = http.createServer((req, res) => {
        handleCallback(req, res, context);
      });
      server.once("error", () => {
        try {
          server.close();
        } catch {}
        tryNext();
      });
      server.listen(port, "127.0.0.1", () => {
        const actualPort = server.address().port;
        resolve({
          server,
          port: actualPort,
          redirectUri: `http://127.0.0.1:${actualPort}/callback`,
          close: () => {
            try {
              server.close();
            } catch {}
          },
        });
      });
    };
    tryNext();
  });
}

function handleCallback(req, res, context) {
  let parsed;
  try {
    parsed = new URL(req.url, "http://127.0.0.1");
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("无效回调地址");
    return;
  }
  if (parsed.pathname !== "/callback") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const error = parsed.searchParams.get("error");
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state") || "";

  const reply = (status, title, detail) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
      <style>body{background:#111;color:#e5e5e5;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .card{background:#1c1c1c;border:1px solid #2e2e2e;border-radius:16px;padding:32px 40px;max-width:520px;text-align:center}
      h1{font-size:18px;margin:0 0 12px}p{font-size:13px;color:#a3a3a3;line-height:1.6;margin:0}</style></head>
      <body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`
    );
  };

  if (error) {
    const detail = parsed.searchParams.get("error_description") || error;
    context.reject(new Error(`授权被拒绝：${detail}`));
    reply(400, "授权失败", detail);
    return;
  }
  if (!code) {
    context.reject(new Error("OAuth 回调缺少 authorization code"));
    reply(400, "授权失败", "回调缺少 authorization code");
    return;
  }
  if (!context.state || state !== context.state) {
    context.reject(new Error("OAuth state 校验失败，可能存在 CSRF 风险"));
    reply(400, "授权失败", "state 校验失败");
    return;
  }

  context.resolve(code);
  reply(200, "授权完成", "OMCX Desktop 已获得访问令牌，可以关闭此页面并返回应用。");
}

async function exchangeToken(meta, client, { code, verifier, redirectUri, resource }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
  });
  if (resource) body.set("resource", resource);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (client.client_secret) {
    if (client.token_endpoint_auth_method === "client_secret_basic") {
      headers.Authorization = `Basic ${Buffer.from(
        `${client.client_id}:${client.client_secret}`
      ).toString("base64")}`;
    } else {
      body.set("client_secret", client.client_secret);
    }
  }

  const data = await fetchJson(meta.token_endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
    timeoutMs: 20000,
  });
  if (!data?.access_token) {
    throw new Error("OAuth 令牌交换失败：授权服务器未返回 access_token");
  }
  return data;
}

async function refreshAccessToken(record) {
  if (!record?.refresh_token || !record.token_endpoint) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refresh_token,
    client_id: record.client_id || "",
  });
  if (record.resource) body.set("resource", record.resource);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (record.client_secret) {
    if (record.token_endpoint_auth_method === "client_secret_basic") {
      headers.Authorization = `Basic ${Buffer.from(
        `${record.client_id}:${record.client_secret}`
      ).toString("base64")}`;
    } else {
      body.set("client_secret", record.client_secret);
    }
  }
  const data = await fetchJson(record.token_endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
    timeoutMs: 20000,
  });
  if (!data?.access_token) return null;
  return {
    ...record,
    access_token: data.access_token,
    refresh_token: data.refresh_token || record.refresh_token,
    token_type: data.token_type || record.token_type || "Bearer",
    scope: data.scope || record.scope || "",
    expires_at: data.expires_in
      ? Date.now() + Number(data.expires_in) * 1000
      : record.expires_at,
    refreshed_at: Date.now(),
  };
}

async function getAccessToken(server) {
  if (!isOAuthEnabled(server)) return null;
  const key = tokenKey(server);
  const serverUrl = normalizeServerUrl(server.url);
  const store = readStore();
  const record = store.tokens[key];
  if (!record || record.server_url !== serverUrl) return null;

  const expired =
    record.expires_at && Date.now() >= Number(record.expires_at) - TOKEN_REFRESH_SKEW_MS;
  if (!expired) return record.access_token || null;
  if (!record.refresh_token) return record.access_token || null;

  try {
    const refreshed = await refreshAccessToken(record);
    if (!refreshed) return record.access_token || null;
    store.tokens[key] = refreshed;
    writeStore(store);
    return refreshed.access_token;
  } catch {
    return record.access_token || null;
  }
}

function getStatus(server) {
  if (!isOAuthEnabled(server)) {
    return { enabled: false, authorized: false };
  }
  const store = readStore();
  const record = store.tokens[tokenKey(server)];
  const serverUrl = normalizeServerUrl(server.url);
  const validUrl = record && record.server_url === serverUrl;
  return {
    enabled: true,
    authorized: Boolean(validUrl && record.access_token),
    serverUrl: server.url,
    scope: validUrl ? record.scope || "" : "",
    expiresAt: validUrl ? record.expires_at || null : null,
    expired:
      validUrl && record.expires_at ? Date.now() >= Number(record.expires_at) : false,
    hasRefreshToken: Boolean(validUrl && record.refresh_token),
  };
}

async function authorize(server, options = {}) {
  if (!isOAuthEnabled(server)) {
    return { success: false, error: "该 MCP 服务器未启用 OAuth（请在配置中添加 oauth 字段）" };
  }
  const serverUrl = assertHttpUrl(server.url, "MCP 服务地址").toString();
  const config = oauthConfig(server);
  const store = readStore();

  let callback = null;
  let context = null;
  let timer = null;
  try {
    const metadata = await resolveMetadata(server, config);
    context = { state: "", resolve: null, reject: null, settled: false };
    callback = await listenLoopback(config.redirectPort, context);

    const codePromise = new Promise((resolve, reject) => {
      context.resolve = (code) => {
        if (context.settled) return;
        context.settled = true;
        resolve(code);
      };
      context.reject = (err) => {
        if (context.settled) return;
        context.settled = true;
        reject(err);
      };
      timer = setTimeout(() => {
        context.reject(new Error("OAuth 授权超时（5 分钟），请重试"));
      }, CALLBACK_TIMEOUT_MS);
    });
    // 避免未立即 await 时产生 unhandled rejection
    codePromise.catch(() => {});

    const client = await registerClient(server, metadata, callback.redirectUri, config, store);
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));

    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", callback.redirectUri);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    if (metadata.scope) authUrl.searchParams.set("scope", metadata.scope);
    authUrl.searchParams.set("resource", serverUrl);

    context.state = state;

    const openExternal =
      typeof options.openExternal === "function"
        ? options.openExternal
        : (url) => require("electron").shell.openExternal(url);
    await openExternal(authUrl.toString());

    const code = await codePromise;
    const token = await exchangeToken(metadata, client, {
      code,
      verifier,
      redirectUri: callback.redirectUri,
      resource: serverUrl,
    });

    store.tokens[tokenKey(server)] = {
      server_url: serverUrl,
      access_token: token.access_token,
      refresh_token: token.refresh_token || "",
      token_type: token.token_type || "Bearer",
      scope: token.scope || metadata.scope || "",
      expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
      token_endpoint: metadata.token_endpoint,
      client_id: client.client_id,
      client_secret: client.client_secret || "",
      token_endpoint_auth_method: client.token_endpoint_auth_method || "none",
      resource: serverUrl,
      authorized_at: Date.now(),
    };
    writeStore(store);
    return {
      success: true,
      serverId: server.id,
      scope: store.tokens[tokenKey(server)].scope,
      expiresAt: store.tokens[tokenKey(server)].expires_at,
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    if (callback) callback.close();
  }
}

function logout(server) {
  const key = tokenKey(server);
  const store = readStore();
  if (store.tokens[key]) {
    delete store.tokens[key];
    writeStore(store);
  }
  return { success: true, serverId: server?.id || key };
}

module.exports = {
  isOAuthEnabled,
  getAccessToken,
  getStatus,
  authorize,
  logout,
  storePath,
};
