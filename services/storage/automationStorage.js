/**
 * automationStorage.js — 定时任务规则、运行收件箱记录与 Webhook 凭据持久化
 *
 * 1. 规则与运行记录走 memoryState O(1) 内存快照 + dbWorker SQLite 异步落盘；
 * 2. Outbound Webhook URL / Secret 与 Inbound Bearer Token 均通过 secretStorage 加密存储；
 * 3. 对外提供 *ForRenderer 脱敏方法，禁止将明文凭据直接下发到渲染层。
 */

const crypto = require("crypto");
const {
  encryptSecret,
  decryptSecret,
  isMaskedSecret,
  maskSecret,
} = require("../secretStorage");
const { computeNextRunAt, validateCronExpression } = require("../../utils/cronParser");

const MAX_MEMORY_RUNS = 300;
const WEBHOOK_TARGETS_KEY = "webhook_targets";
const WEBHOOK_INBOUND_KEY = "webhook_inbound_config";

function generateRandomId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function generateInboundToken() {
  return `omcx_hook_${crypto.randomBytes(20).toString("hex")}`;
}

function parseJsonSafe(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mapAutomationRow(r) {
  if (!r || typeof r !== "object") return null;
  const scheduleType =
    r.schedule_type === "cron" || r.schedule_type === "manual" ? r.schedule_type : "interval";
  return {
    id: String(r.id),
    name: String(r.name || "未命名定时任务"),
    description: String(r.description || ""),
    enabled: r.enabled === true || r.enabled === 1,
    schedule_type: scheduleType,
    interval_minutes: Math.max(1, Number(r.interval_minutes ?? r.intervalMinutes ?? 60) || 60),
    cron_expr: String(r.cron_expr ?? r.cronExpr ?? "0 9 * * *"),
    prompt: String(r.prompt || ""),
    work_dir: r.work_dir ?? r.workDir ?? null,
    agent_mode: (r.agent_mode ?? r.agentMode) === "code" ? "code" : "work",
    permission_mode: r.permission_mode === "plan" ? "plan" : "auto",
    model: String(r.model || ""),
    webhook_target_id: r.webhook_target_id ?? r.webhookTargetId ?? null,
    notify_on:
      r.notify_on === "on_error" || r.notify_on === "never" ? r.notify_on : "always",
    next_run_at:
      r.next_run_at !== null && r.next_run_at !== undefined && Number.isFinite(Number(r.next_run_at))
        ? Number(r.next_run_at)
        : null,
    last_run_at:
      r.last_run_at !== null && r.last_run_at !== undefined && Number.isFinite(Number(r.last_run_at))
        ? Number(r.last_run_at)
        : null,
    last_status: r.last_status || null,
    created_at: Number(r.created_at) || Date.now(),
    updated_at: Number(r.updated_at) || Date.now(),
  };
}

function mapAutomationRunRow(r) {
  if (!r || typeof r !== "object") return null;
  const outputs = parseJsonSafe(r.outputs_json ?? r.outputs, []);
  return {
    id: String(r.id),
    automation_id: String(r.automation_id || r.automationId || ""),
    automation_name: String(r.automation_name || r.automationName || "定时任务"),
    trigger_source:
      r.trigger_source === "manual" || r.trigger_source === "webhook"
        ? r.trigger_source
        : "schedule",
    status:
      r.status === "success" || r.status === "failed" || r.status === "cancelled"
        ? r.status
        : "running",
    triage_state:
      r.triage_state === "read" || r.triage_state === "archived" ? r.triage_state : "unread",
    session_id: r.session_id || r.sessionId || null,
    summary: String(r.summary || ""),
    error: r.error ? String(r.error) : null,
    outputs: Array.isArray(outputs) ? outputs : [],
    duration_ms: Number(r.duration_ms ?? r.durationMs ?? 0) || 0,
    started_at: Number(r.started_at ?? r.startedAt) || Date.now(),
    finished_at:
      r.finished_at !== null && r.finished_at !== undefined && Number.isFinite(Number(r.finished_at))
        ? Number(r.finished_at)
        : null,
  };
}

function createAutomationStorage({ memoryState, getConfig, setConfig, dbEngine }) {
  const { sendToWorker, loadInitialSnapshot, hasLoadedSnapshot } = dbEngine;

  function ensureSnapshot() {
    if (!hasLoadedSnapshot()) {
      loadInitialSnapshot();
    }
  }

  function getAutomations() {
    ensureSnapshot();
    return memoryState.getAutomations().map(mapAutomationRow).filter(Boolean);
  }

  function getAutomation(id) {
    if (!id) return null;
    return getAutomations().find((a) => a.id === id) || null;
  }

  function saveAutomation(input = {}) {
    ensureSnapshot();
    const now = Date.now();
    const list = memoryState.getAutomations();
    const existing = input.id ? list.find((a) => a.id === input.id) : null;

    const name = String(input.name ?? existing?.name ?? "").trim();
    const prompt = String(input.prompt ?? existing?.prompt ?? "").trim();
    if (!name) throw new Error("定时任务名称不能为空");
    if (!prompt) throw new Error("执行提示词 (Prompt) 不能为空");

    const scheduleTypeRaw = input.schedule_type ?? input.scheduleType ?? existing?.schedule_type ?? "interval";
    const scheduleType =
      scheduleTypeRaw === "cron" || scheduleTypeRaw === "manual" ? scheduleTypeRaw : "interval";
    const cronExpr = String(input.cron_expr ?? input.cronExpr ?? existing?.cron_expr ?? "0 9 * * *").trim();
    if (scheduleType === "cron") {
      const check = validateCronExpression(cronExpr);
      if (!check.valid) {
        throw new Error(`Cron 表达式无效: ${check.error}`);
      }
    }

    const enabled =
      input.enabled !== undefined ? Boolean(input.enabled) : existing ? Boolean(existing.enabled) : true;
    const intervalMinutes = Math.max(
      1,
      Number(input.interval_minutes ?? input.intervalMinutes ?? existing?.interval_minutes ?? 60) || 60
    );

    const shouldRecomputeNext =
      input.next_run_at === undefined &&
      (input.recomputeNext !== false ||
        !existing ||
        Boolean(existing.enabled) !== enabled ||
        existing.schedule_type !== scheduleType ||
        existing.cron_expr !== cronExpr ||
        Number(existing.interval_minutes) !== intervalMinutes);

    const nextRunAt =
      input.next_run_at !== undefined
        ? input.next_run_at
        : shouldRecomputeNext
        ? computeNextRunAt(
            {
              enabled,
              schedule_type: scheduleType,
              interval_minutes: intervalMinutes,
              cron_expr: cronExpr,
            },
            now
          )
        : existing?.next_run_at ?? null;

    const record = {
      id: existing?.id || input.id || generateRandomId("auto"),
      name,
      description: String(input.description ?? existing?.description ?? "").trim(),
      enabled: enabled ? 1 : 0,
      schedule_type: scheduleType,
      interval_minutes: intervalMinutes,
      cron_expr: cronExpr,
      prompt,
      work_dir:
        input.work_dir !== undefined
          ? input.work_dir || null
          : input.workDir !== undefined
          ? input.workDir || null
          : existing?.work_dir || null,
      agent_mode:
        (input.agent_mode ?? input.agentMode ?? existing?.agent_mode) === "code" ? "code" : "work",
      permission_mode:
        (input.permission_mode ?? input.permissionMode ?? existing?.permission_mode) === "plan"
          ? "plan"
          : "auto",
      model: String(input.model ?? existing?.model ?? ""),
      webhook_target_id:
        input.webhook_target_id !== undefined
          ? input.webhook_target_id || null
          : input.webhookTargetId !== undefined
          ? input.webhookTargetId || null
          : existing?.webhook_target_id || null,
      notify_on:
        input.notify_on === "on_error" || input.notify_on === "never" || input.notify_on === "always"
          ? input.notify_on
          : existing?.notify_on || "always",
      next_run_at: nextRunAt,
      last_run_at:
        input.last_run_at !== undefined ? input.last_run_at : existing?.last_run_at ?? null,
      last_status:
        input.last_status !== undefined ? input.last_status : existing?.last_status ?? null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    const nextList = existing
      ? list.map((item) => (item.id === record.id ? record : item))
      : [record, ...list];
    memoryState.setAutomations(nextList);
    sendToWorker("UPSERT_AUTOMATION", record);
    return mapAutomationRow(record);
  }

  function deleteAutomation(id) {
    if (!id) return false;
    ensureSnapshot();
    memoryState.setAutomations(memoryState.getAutomations().filter((a) => a.id !== id));
    memoryState.setAutomationRuns(
      memoryState.getAutomationRuns().filter((r) => r.automation_id !== id)
    );
    sendToWorker("DELETE_AUTOMATION", id);
    return true;
  }

  function getAutomationRuns({ automationId = null, triageState = null, status = null, limit = 200 } = {}) {
    ensureSnapshot();
    let list = memoryState.getAutomationRuns().map(mapAutomationRunRow).filter(Boolean);
    if (automationId) {
      list = list.filter((r) => r.automation_id === automationId);
    }
    if (triageState && triageState !== "all") {
      list = list.filter((r) => r.triage_state === triageState);
    }
    if (status && status !== "all") {
      list = list.filter((r) => r.status === status);
    }
    const max = Math.max(1, Math.min(500, Number(limit) || 200));
    return list.sort((a, b) => (b.started_at || 0) - (a.started_at || 0)).slice(0, max);
  }

  function getAutomationRun(runId) {
    if (!runId) return null;
    ensureSnapshot();
    const raw = memoryState.getAutomationRuns().find((r) => r.id === runId);
    return raw ? mapAutomationRunRow(raw) : null;
  }

  function getUnreadAutomationRunCount() {
    ensureSnapshot();
    return memoryState
      .getAutomationRuns()
      .filter((r) => (r.triage_state || "unread") === "unread").length;
  }

  function saveAutomationRun(run = {}) {
    ensureSnapshot();
    const list = memoryState.getAutomationRuns();
    const existing = run.id ? list.find((r) => r.id === run.id) : null;
    const outputsArr = Array.isArray(run.outputs)
      ? run.outputs
      : existing
      ? parseJsonSafe(existing.outputs_json, [])
      : [];

    const record = {
      id: existing?.id || run.id || generateRandomId("run"),
      automation_id: String(run.automation_id || run.automationId || existing?.automation_id || ""),
      automation_name: String(
        run.automation_name || run.automationName || existing?.automation_name || "定时任务"
      ),
      trigger_source:
        run.trigger_source === "manual" || run.trigger_source === "webhook"
          ? run.trigger_source
          : existing?.trigger_source || "schedule",
      status:
        run.status === "success" || run.status === "failed" || run.status === "cancelled"
          ? run.status
          : run.status === "running"
          ? "running"
          : existing?.status || "running",
      triage_state:
        run.triage_state === "read" || run.triage_state === "archived" || run.triage_state === "unread"
          ? run.triage_state
          : existing?.triage_state || "unread",
      session_id:
        run.session_id !== undefined
          ? run.session_id
          : run.sessionId !== undefined
          ? run.sessionId
          : existing?.session_id || null,
      summary: String(run.summary !== undefined ? run.summary : existing?.summary || ""),
      error: run.error !== undefined ? (run.error ? String(run.error) : null) : existing?.error || null,
      outputs_json: JSON.stringify(outputsArr),
      duration_ms: Number(run.duration_ms ?? run.durationMs ?? existing?.duration_ms ?? 0) || 0,
      started_at: Number(run.started_at ?? run.startedAt ?? existing?.started_at) || Date.now(),
      finished_at:
        run.finished_at !== undefined
          ? run.finished_at
          : existing?.finished_at ?? null,
    };

    const nextList = existing
      ? list.map((item) => (item.id === record.id ? record : item))
      : [record, ...list];
    if (nextList.length > MAX_MEMORY_RUNS) {
      nextList.length = MAX_MEMORY_RUNS;
    }
    memoryState.setAutomationRuns(nextList);
    sendToWorker("UPSERT_AUTOMATION_RUN", record);
    return mapAutomationRunRow(record);
  }

  function updateAutomationRunTriage(runId, triageState) {
    if (!runId) return false;
    const valid =
      triageState === "unread" || triageState === "read" || triageState === "archived"
        ? triageState
        : "read";
    ensureSnapshot();
    const next = memoryState
      .getAutomationRuns()
      .map((r) => (r.id === runId ? { ...r, triage_state: valid } : r));
    memoryState.setAutomationRuns(next);
    sendToWorker("UPDATE_AUTOMATION_RUN_TRIAGE", { id: runId, triage_state: valid });
    return true;
  }

  function markAllAutomationRunsRead() {
    ensureSnapshot();
    const next = memoryState
      .getAutomationRuns()
      .map((r) => (r.triage_state === "unread" ? { ...r, triage_state: "read" } : r));
    memoryState.setAutomationRuns(next);
    sendToWorker("MARK_ALL_AUTOMATION_RUNS_READ", {});
    return true;
  }

  function deleteAutomationRun(runId) {
    if (!runId) return false;
    ensureSnapshot();
    memoryState.setAutomationRuns(memoryState.getAutomationRuns().filter((r) => r.id !== runId));
    sendToWorker("DELETE_AUTOMATION_RUN", runId);
    return true;
  }

  // ─── Outbound Webhook 通道存储（URL / Secret 加密落盘，渲染层脱敏） ───
  function getWebhookTargets() {
    const raw = getConfig(WEBHOOK_TARGETS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t && typeof t === "object")
      .map((t) => ({
        id: String(t.id),
        name: String(t.name || "Webhook 通道"),
        provider:
          t.provider === "feishu" || t.provider === "dingtalk" || t.provider === "wecom"
            ? t.provider
            : "generic",
        url: decryptSecret(String(t.url || "")),
        secret: decryptSecret(String(t.secret || "")),
        enabled: t.enabled !== false,
        created_at: Number(t.created_at) || Date.now(),
        updated_at: Number(t.updated_at) || Date.now(),
      }));
  }

  function redactWebhookTarget(t) {
    const urlPlain = String(t.url || "").trim();
    const secretPlain = String(t.secret || "").trim();
    let urlMasked = "";
    if (urlPlain) {
      try {
        const parsed = new URL(urlPlain);
        urlMasked = `${parsed.protocol}//${parsed.host}/••••${urlPlain.slice(-6)}`;
      } catch {
        urlMasked = maskSecret(urlPlain);
      }
    }
    return {
      id: t.id,
      name: t.name,
      provider: t.provider,
      enabled: t.enabled !== false,
      has_url: Boolean(urlPlain),
      url_masked: urlMasked,
      has_secret: Boolean(secretPlain),
      secret_masked: secretPlain ? maskSecret(secretPlain) : "",
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  function getWebhookTargetsForRenderer() {
    return getWebhookTargets().map(redactWebhookTarget);
  }

  function saveWebhookTarget(input = {}) {
    const list = getWebhookTargets();
    const existing = input.id ? list.find((t) => t.id === input.id) : null;
    const name = String(input.name ?? existing?.name ?? "").trim();
    if (!name) throw new Error("推送通道名称不能为空");

    const rawUrl = String(input.url ?? "").trim();
    const finalUrl =
      (!rawUrl || isMaskedSecret(rawUrl) || input.preserveUrl) && existing
        ? existing.url
        : decryptSecret(rawUrl);
    if (!finalUrl) throw new Error("Webhook 地址不能为空");
    let parsedUrl;
    try {
      parsedUrl = new URL(finalUrl);
    } catch {
      throw new Error("Webhook 地址格式无效");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Webhook 地址仅支持 http:// 或 https://");
    }

    const rawSecret = input.secret !== undefined ? String(input.secret).trim() : "";
    let finalSecret = "";
    if (input.clearSecret) {
      finalSecret = "";
    } else if ((!rawSecret && input.preserveSecret) || isMaskedSecret(rawSecret)) {
      finalSecret = existing?.secret || "";
    } else if (input.secret === undefined && existing) {
      finalSecret = existing.secret || "";
    } else {
      finalSecret = decryptSecret(rawSecret);
    }

    const now = Date.now();
    const target = {
      id: existing?.id || input.id || generateRandomId("wh"),
      name,
      provider:
        input.provider === "feishu" || input.provider === "dingtalk" || input.provider === "wecom"
          ? input.provider
          : existing?.provider || "generic",
      url: finalUrl,
      secret: finalSecret,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : existing ? existing.enabled : true,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    const nextList = existing
      ? list.map((t) => (t.id === target.id ? target : t))
      : [target, ...list];

    const stored = nextList.map((t) => ({
      ...t,
      url: encryptSecret(t.url),
      secret: encryptSecret(t.secret || ""),
    }));
    setConfig(WEBHOOK_TARGETS_KEY, stored);
    return redactWebhookTarget(target);
  }

  function deleteWebhookTarget(id) {
    if (!id) return false;
    const list = getWebhookTargets().filter((t) => t.id !== id);
    const stored = list.map((t) => ({
      ...t,
      url: encryptSecret(t.url),
      secret: encryptSecret(t.secret || ""),
    }));
    setConfig(WEBHOOK_TARGETS_KEY, stored);
    return true;
  }

  // ─── Inbound 本地触发器配置（Token 加密落盘，仅在主动旋转时返回一次新明文） ───
  function getInboundWebhookConfig() {
    const raw = getConfig(WEBHOOK_INBOUND_KEY);
    const stored = raw && typeof raw === "object" ? raw : {};
    let token = stored.token ? decryptSecret(String(stored.token)) : "";
    if (!token) {
      token = generateInboundToken();
      setConfig(WEBHOOK_INBOUND_KEY, {
        enabled: Boolean(stored.enabled),
        port: Number(stored.port) || 17890,
        token: encryptSecret(token),
      });
    }
    return {
      enabled: Boolean(stored.enabled),
      port: Math.max(1024, Math.min(65535, Number(stored.port) || 17890)),
      token,
    };
  }

  function getInboundWebhookConfigForRenderer() {
    const cfg = getInboundWebhookConfig();
    return {
      enabled: cfg.enabled,
      port: cfg.port,
      has_token: Boolean(cfg.token),
      token_masked: maskSecret(cfg.token),
    };
  }

  function saveInboundWebhookConfig(input = {}) {
    const cur = getInboundWebhookConfig();
    const port =
      input.port !== undefined
        ? Math.max(1024, Math.min(65535, Number(input.port) || 17890))
        : cur.port;
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : cur.enabled;
    setConfig(WEBHOOK_INBOUND_KEY, {
      enabled,
      port,
      token: encryptSecret(cur.token),
    });
    return getInboundWebhookConfigForRenderer();
  }

  function rotateInboundWebhookToken() {
    const cur = getInboundWebhookConfig();
    const newToken = generateInboundToken();
    setConfig(WEBHOOK_INBOUND_KEY, {
      enabled: cur.enabled,
      port: cur.port,
      token: encryptSecret(newToken),
    });
    return {
      ...getInboundWebhookConfigForRenderer(),
      plain_token: newToken,
    };
  }

  return {
    getAutomations,
    getAutomation,
    saveAutomation,
    deleteAutomation,
    getAutomationRuns,
    getAutomationRun,
    getUnreadAutomationRunCount,
    saveAutomationRun,
    updateAutomationRunTriage,
    markAllAutomationRunsRead,
    deleteAutomationRun,
    getWebhookTargets,
    getWebhookTargetsForRenderer,
    saveWebhookTarget,
    deleteWebhookTarget,
    getInboundWebhookConfig,
    getInboundWebhookConfigForRenderer,
    saveInboundWebhookConfig,
    rotateInboundWebhookToken,
  };
}

module.exports = {
  createAutomationStorage,
  mapAutomationRow,
  mapAutomationRunRow,
};
