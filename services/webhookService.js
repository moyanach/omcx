/**
 * webhookService.js — Outbound IM/Webhook 通知推送 & Inbound 本地 HTTP 触发器
 *
 * Outbound 支持：飞书 (Feishu/Lark)、钉钉 (DingTalk)、企业微信 (WeCom)、通用 JSON Webhook；
 * Inbound 支持：默认关闭；开启后仅监听 127.0.0.1，强制 Bearer Token 恒等校验 + 请求体上限 + 速率限制。
 */

const http = require("http");
const crypto = require("crypto");

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQ = 30;

let inboundServer = null;
let inboundBoundPort = null;
let inboundLastError = null;
let triggerHandler = null;
const requestTimestamps = [];

function truncateText(text, maxChars) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n…（内容已截断，完整报告请在 OMCX「定时任务」查看）`;
}

function formatDurationShort(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function getStatusBadgeText(status) {
  if (status === "success") return "✅ 执行成功";
  if (status === "cancelled") return "⏹️ 已取消";
  if (status === "failed") return "❌ 执行失败";
  return "⏳ 运行中";
}

function getTriggerLabel(source) {
  if (source === "manual") return "手动试跑";
  if (source === "webhook") return "Webhook 触发";
  return "定时调度";
}

function buildFeishuPayload(run, secret) {
  const isFailed = run.status === "failed";
  const headerTemplate = isFailed ? "red" : run.status === "cancelled" ? "orange" : "blue";
  const summaryText = truncateText(run.error || run.summary || "任务已完成，暂无正文输出。", 1800);
  const outputsList = Array.isArray(run.outputs) && run.outputs.length > 0
    ? `\n\n**产出文件 (${run.outputs.length})**:\n${run.outputs
        .slice(0, 8)
        .map((o) => `- \`${o.name || o.filePath}\``)
        .join("\n")}`
    : "";

  const payload = {
    msg_type: "interactive",
    card: {
      header: {
        template: headerTemplate,
        title: {
          tag: "plain_text",
          content: `OMCX 定时任务 · ${run.automation_name || "未命名"}`,
        },
      },
      elements: [
        {
          tag: "markdown",
          content: [
            `**状态**: ${getStatusBadgeText(run.status)}　|　**触发**: ${getTriggerLabel(run.trigger_source)}　|　**耗时**: ${formatDurationShort(run.duration_ms)}`,
            "",
            summaryText + outputsList,
          ].join("\n"),
        },
      ],
    },
  };

  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac("sha256", stringToSign).update("").digest("base64");
    payload.timestamp = timestamp;
    payload.sign = sign;
  }
  return { url: null, body: payload, headers: {} };
}

function buildDingTalkRequest(run, baseUrl, secret) {
  let finalUrl = baseUrl;
  if (secret) {
    const timestamp = String(Date.now());
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = encodeURIComponent(
      crypto.createHmac("sha256", secret).update(stringToSign).digest("base64")
    );
    const sep = finalUrl.includes("?") ? "&" : "?";
    finalUrl = `${finalUrl}${sep}timestamp=${timestamp}&sign=${sign}`;
  }

  const summaryText = truncateText(run.error || run.summary || "任务已完成，暂无正文输出。", 1800);
  const outputsLine =
    Array.isArray(run.outputs) && run.outputs.length > 0
      ? `\n\n**产出文件**: ${run.outputs.slice(0, 6).map((o) => o.name || o.filePath).join("、")}`
      : "";

  const body = {
    msgtype: "markdown",
    markdown: {
      title: `OMCX 定时任务: ${run.automation_name || "通知"}`,
      text: [
        `### OMCX 定时任务 · ${run.automation_name || "未命名"}`,
        `- **状态**: ${getStatusBadgeText(run.status)}`,
        `- **触发**: ${getTriggerLabel(run.trigger_source)}`,
        `- **耗时**: ${formatDurationShort(run.duration_ms)}`,
        "",
        summaryText + outputsLine,
      ].join("\n"),
    },
  };

  return { url: finalUrl, body, headers: {} };
}

function buildWeComPayload(run) {
  const summaryText = truncateText(run.error || run.summary || "任务已完成，暂无正文输出。", 1400);
  const outputsLine =
    Array.isArray(run.outputs) && run.outputs.length > 0
      ? `\n> 产出文件: ${run.outputs.slice(0, 5).map((o) => o.name || o.filePath).join("、")}`
      : "";

  return {
    url: null,
    body: {
      msgtype: "markdown",
      markdown: {
        content: [
          `### OMCX 定时任务 · ${run.automation_name || "未命名"}`,
          `> 状态: ${getStatusBadgeText(run.status)} | 触发: ${getTriggerLabel(run.trigger_source)} | 耗时: ${formatDurationShort(run.duration_ms)}`,
          "",
          summaryText + outputsLine,
        ].join("\n"),
      },
    },
    headers: {},
  };
}

function buildGenericPayload(run, secret) {
  const body = {
    event: "automation.run.completed",
    timestamp: Date.now(),
    run: {
      id: run.id,
      automationId: run.automation_id,
      automationName: run.automation_name,
      triggerSource: run.trigger_source,
      status: run.status,
      sessionId: run.session_id,
      summary: truncateText(run.summary || "", 4000),
      error: run.error || null,
      outputs: Array.isArray(run.outputs) ? run.outputs : [],
      durationMs: run.duration_ms || 0,
      costUsd: run.cost_usd || 0,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    },
  };
  const headers = {};
  if (secret) {
    const raw = JSON.stringify(body);
    const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    headers["X-OMCX-Signature"] = `sha256=${sig}`;
  }
  return { url: null, body, headers };
}

function buildWebhookRequest(target, run) {
  if (target.provider === "feishu") {
    const built = buildFeishuPayload(run, target.secret);
    return { url: target.url, body: built.body, headers: built.headers };
  }
  if (target.provider === "dingtalk") {
    return buildDingTalkRequest(run, target.url, target.secret);
  }
  if (target.provider === "wecom") {
    const built = buildWeComPayload(run);
    return { url: target.url, body: built.body, headers: built.headers };
  }
  const built = buildGenericPayload(run, target.secret);
  return { url: target.url, body: built.body, headers: built.headers };
}

async function sendWebhookNotification(target, run, { fetchImpl = globalThis.fetch } = {}) {
  if (!target || !target.url) {
    throw new Error("推送通道地址为空");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境不支持 fetch");
  }

  const { url, body, headers } = buildWebhookRequest(target, run);
  const rawBody = JSON.stringify(body);
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: rawBody,
    signal: AbortSignal.timeout(12000),
  });

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 240) || resp.statusText}`);
  }

  // 飞书 / 钉钉 / 企业微信即使 HTTP 200 也可能通过 JSON code/errcode 返回业务拒绝
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.code === "number" && parsed.code !== 0) {
        throw new Error(`通道返回错误 (${parsed.code}): ${parsed.msg || parsed.message || text}`);
      }
      if (typeof parsed.errcode === "number" && parsed.errcode !== 0) {
        throw new Error(`通道返回错误 (${parsed.errcode}): ${parsed.errmsg || text}`);
      }
      if (typeof parsed.StatusCode === "number" && parsed.StatusCode !== 0) {
        throw new Error(`通道返回错误 (${parsed.StatusCode}): ${parsed.StatusMessage || text}`);
      }
    } catch (err) {
      if (err.message.startsWith("通道返回错误")) throw err;
    }
  }

  return { ok: true, status: resp.status };
}

async function sendTestWebhook(target, opts = {}) {
  const sampleRun = {
    id: `test_${Date.now()}`,
    automation_id: "test_rule",
    automation_name: "测试通知连通性",
    trigger_source: "manual",
    status: "success",
    session_id: null,
    summary: "这是一条来自 **OMCX 定时任务** 的测试推送消息，当前 Webhook 通道配置有效。",
    error: null,
    outputs: [],
    duration_ms: 1200,
    cost_usd: 0,
    started_at: Date.now() - 1200,
    finished_at: Date.now(),
  };
  return sendWebhookNotification(target, sampleRun, opts);
}

async function notifyAutomationRun(storageService, targetId, notifyOn, run) {
  if (!targetId || notifyOn === "never") return { skipped: true };
  if (notifyOn === "on_error" && run.status === "success") return { skipped: true };
  const target = storageService.getWebhookTargets().find((t) => t.id === targetId);
  if (!target || target.enabled === false) return { skipped: true };
  return sendWebhookNotification(target, run);
}

// ─── Inbound 本地触发器（127.0.0.1 + Bearer Token） ─────────────────

function timingSafeMatch(expected, actual) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(actual || ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isRateLimited() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_MAX_REQ) {
    return true;
  }
  requestTimestamps.push(now);
  return false;
}

function setAutomationTriggerHandler(fn) {
  triggerHandler = typeof fn === "function" ? fn : null;
}

function getInboundServerStatus() {
  return {
    listening: Boolean(inboundServer && inboundServer.listening),
    host: "127.0.0.1",
    port: inboundBoundPort,
    error: inboundLastError,
  };
}

function stopInboundServer() {
  return new Promise((resolve) => {
    if (!inboundServer) {
      inboundBoundPort = null;
      resolve();
      return;
    }
    const srv = inboundServer;
    inboundServer = null;
    inboundBoundPort = null;
    try {
      srv.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function startInboundServer(storageService, port = 17890) {
  return new Promise(async (resolve) => {
    await stopInboundServer();
    inboundLastError = null;
    const safePort = Math.max(1024, Math.min(65535, Number(port) || 17890));

    const server = http.createServer(async (req, res) => {
      const writeJson = (statusCode, obj) => {
        if (res.writableEnded) return;
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
      };

      try {
        const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
        const pathname = parsedUrl.pathname;

        if (req.method === "GET" && pathname === "/health") {
          writeJson(200, { ok: true, service: "omcx-automation-inbound" });
          return;
        }

        const match = pathname.match(/^\/hooks\/(?:automation|trigger)\/([a-zA-Z0-9_-]+)$/);
        if (req.method !== "POST" || !match) {
          writeJson(404, { ok: false, error: "Not found" });
          return;
        }

        if (isRateLimited()) {
          writeJson(429, { ok: false, error: "Too many requests" });
          return;
        }

        const inboundCfg = storageService.getInboundWebhookConfig();
        const authHeader = String(req.headers.authorization || "");
        const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
        if (!timingSafeMatch(inboundCfg.token, bearerToken)) {
          writeJson(401, { ok: false, error: "Unauthorized" });
          return;
        }

        const bodyChunks = [];
        let totalBytes = 0;
        let aborted = false;
        req.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_BODY_BYTES) {
            aborted = true;
            writeJson(413, { ok: false, error: "Payload too large (max 64KB)" });
            req.destroy();
            return;
          }
          bodyChunks.push(chunk);
        });

        await new Promise((done) => {
          req.on("end", done);
          req.on("close", done);
        });
        if (aborted) return;

        let parsedBody = {};
        const rawText = Buffer.concat(bodyChunks).toString("utf8").trim();
        if (rawText) {
          try {
            parsedBody = JSON.parse(rawText);
          } catch {
            writeJson(400, { ok: false, error: "Invalid JSON body" });
            return;
          }
        }

        const automationId = match[1];
        if (!triggerHandler) {
          writeJson(503, { ok: false, error: "Automation runtime unavailable" });
          return;
        }

        const extraInput =
          typeof parsedBody.input === "string"
            ? parsedBody.input
            : parsedBody && Object.keys(parsedBody).length > 0
            ? JSON.stringify(parsedBody)
            : "";

        const result = await triggerHandler(automationId, {
          triggerSource: "webhook",
          extraInput,
        });

        if (!result || !result.ok) {
          writeJson(result?.notFound ? 404 : 409, {
            ok: false,
            error: result?.error || "Failed to trigger automation",
          });
          return;
        }

        writeJson(202, {
          ok: true,
          automationId,
          runId: result.runId,
          status: result.queued ? "queued" : "running",
        });
      } catch (err) {
        writeJson(500, { ok: false, error: err?.message || "Internal error" });
      }
    });

    server.on("error", (err) => {
      inboundLastError = err.message;
      console.warn("[webhookService] Inbound HTTP 服务监听失败:", err.message);
      resolve(getInboundServerStatus());
    });

    server.listen(safePort, "127.0.0.1", () => {
      inboundServer = server;
      inboundBoundPort = server.address()?.port || safePort;
      inboundLastError = null;
      server.unref?.();
      console.log(`[webhookService] Inbound 触发器已监听: http://127.0.0.1:${inboundBoundPort}`);
      resolve(getInboundServerStatus());
    });
  });
}

async function syncInboundServerState(storageService) {
  const cfg = storageService.getInboundWebhookConfig();
  if (!cfg.enabled) {
    await stopInboundServer();
    return getInboundServerStatus();
  }
  if (inboundServer && inboundServer.listening && inboundBoundPort === cfg.port) {
    return getInboundServerStatus();
  }
  return startInboundServer(storageService, cfg.port);
}

module.exports = {
  buildWebhookRequest,
  sendWebhookNotification,
  sendTestWebhook,
  notifyAutomationRun,
  setAutomationTriggerHandler,
  getInboundServerStatus,
  startInboundServer,
  stopInboundServer,
  syncInboundServerState,
};
