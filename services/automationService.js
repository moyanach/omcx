/**
 * automationService.js — 定时任务调度与后台无头执行引擎
 *
 * 1. 纯 JS 定时 Tick 扫描（15s 周期，timer.unref() 防阻塞进程退出）；
 * 2. 防重入 + 全局最大并发上限 (MAX_CONCURRENT_RUNS = 2) 队列调度；
 * 3. 复用 runAgentTurn 后台无头执行（隐藏会话 session_type='automation'，支持进入会话追问转正）；
 * 4. 完成后写入 automation_runs 收件箱、触发桌面系统通知及 Outbound Webhook 推送，并向窗口广播更新。
 */

const crypto = require("crypto");
let BrowserWindow = null;
try {
  const loaded = require("electron");
  if (loaded && typeof loaded === "object") {
    BrowserWindow = loaded.BrowserWindow || null;
  }
} catch {}

const {
  activeStreamSessions,
  notifyDesktopIfBackground,
  getStorageService,
} = require("../main/shared");
const { computeNextRunAt } = require("../utils/cronParser");
const webhookService = require("./webhookService");

const SCHEDULER_INTERVAL_MS = 15 * 1000;
const MAX_CONCURRENT_RUNS = 2;

let schedulerTimer = null;
let initialized = false;
let customRunAgentTurn = null;

const runningByRule = new Set();
const activeRuns = new Map(); // runId -> { automationId, sessionId, abort }
const pendingQueue = [];

function broadcastAutomationUpdated(detail = {}) {
  try {
    const wins = BrowserWindow?.getAllWindows?.() || [];
    for (const win of wins) {
      if (!win || win.isDestroyed()) continue;
      win.webContents.send("automation-updated", {
        at: Date.now(),
        ...detail,
      });
    }
  } catch {}
}

function getAgentTurnRunner() {
  if (customRunAgentTurn) return customRunAgentTurn;
  return require("../main/agentRunner").runAgentTurn;
}

function setAgentTurnRunner(fn) {
  customRunAgentTurn = typeof fn === "function" ? fn : null;
}

function resolveDefaultModelForAutomation(storageService, requestedModel) {
  const clean = String(requestedModel || "").trim();
  const models = storageService.getModels();
  if (clean && models.some((m) => m.id === clean || m.model_id === clean)) {
    return clean;
  }
  const usable = models.find(
    (m) => m.api_key || m.provider === "ollama" || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(m.base_url || "")
  );
  if (usable) return usable.id;
  return storageService.getConfig("default_model") || models[0]?.id || "gpt-4o";
}

function createSilentPermissionChecker(rule) {
  return async () => {
    // 后台自动任务无人工交互弹窗：plan 只读，auto-sandbox 已在 toolExecutor 放行工作区内写入；
    // 一旦越界访问工作区外敏感路径或危险系统命令，直接拒绝防止无限挂起。
    if (rule.permission_mode === "plan") return false;
    return false;
  };
}

async function executeRunJob(job) {
  const storageService = getStorageService();
  const { automationId, runId, triggerSource, extraInput } = job;
  const rule = storageService.getAutomation(automationId);
  if (!rule) {
    runningByRule.delete(automationId);
    activeRuns.delete(runId);
    return;
  }

  const startedAt = Date.now();
  const sessionId = `auto_sess_${startedAt}_${crypto.randomBytes(3).toString("hex")}`;
  const modelId = resolveDefaultModelForAutomation(storageService, rule.model);
  const effectivePrompt = extraInput
    ? `${rule.prompt}\n\n[外部触发附加输入]\n${extraInput}`
    : rule.prompt;

  // 1. 创建后台隔离会话（session_type='automation'，默认不在左侧日常任务列表刷屏）
  storageService.saveSession({
    id: sessionId,
    title: `[定时] ${rule.name}`,
    title_source: "custom",
    model: modelId,
    work_dir: rule.work_dir || null,
    permission_mode: rule.permission_mode || "auto-sandbox",
    reasoning_effort: "medium",
    agent_mode: rule.agent_mode || "work",
    session_type: "automation",
    archived: false,
    created_at: startedAt,
    updated_at: startedAt,
  });

  storageService.addMessage(sessionId, {
    id: `msg_u_${startedAt}`,
    role: "user",
    content: effectivePrompt,
    createdAt: startedAt,
  });

  // 2. 写入 running 状态记录
  let runRecord = storageService.saveAutomationRun({
    id: runId,
    automation_id: rule.id,
    automation_name: rule.name,
    trigger_source: triggerSource || "schedule",
    status: "running",
    triage_state: "unread",
    session_id: sessionId,
    summary: "",
    error: null,
    outputs: [],
    duration_ms: 0,
    started_at: startedAt,
    finished_at: null,
  });

  activeRuns.set(runId, {
    automationId: rule.id,
    sessionId,
    cancelled: false,
  });
  broadcastAutomationUpdated({ type: "run_started", runId, automationId: rule.id });

  const collectedOutputs = [];
  let streamErrorMsg = null;

  try {
    const runAgentTurn = getAgentTurnRunner();
    const assistantMsgId = `msg_a_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;

    const turnResult = await runAgentTurn(
      {
        sessionId,
        runId: `turn_${runId}`,
        messages: [{ role: "user", content: effectivePrompt }],
        model: modelId,
        enableTools: true,
        workDir: rule.work_dir || null,
        assistantMsgId,
        permissionMode: rule.permission_mode || "auto-sandbox",
        reasoningEffort: "medium",
        agentMode: rule.agent_mode || "work",
      },
      {
        skipTitleSidecar: true,
        checkPermission: createSilentPermissionChecker(rule),
        onEvent: (type, data) => {
          if (type === "outputs" && Array.isArray(data)) {
            for (const item of data) {
              if (item?.filePath && !collectedOutputs.some((o) => o.filePath === item.filePath)) {
                collectedOutputs.push(item);
              }
            }
          } else if (type === "error" && typeof data === "string") {
            try {
              const parsed = JSON.parse(data);
              streamErrorMsg = parsed?.summary || data;
            } catch {
              streamErrorMsg = data;
            }
          }
        },
      }
    );

    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - startedAt);
    const activeState = activeRuns.get(runId);
    const wasCancelled = Boolean(turnResult?.cancelled || activeState?.cancelled);
    const ok = Boolean(turnResult?.ok) && !wasCancelled;
    const summaryText = String(turnResult?.content || "").trim();
    const errorText = ok
      ? null
      : wasCancelled
      ? "定时任务已被手动取消"
      : String(turnResult?.error || streamErrorMsg || "执行未返回成功结果");

    const dbOutputs = storageService.getSessionOutputs(sessionId);
    const finalOutputs = dbOutputs.length > 0 ? dbOutputs : collectedOutputs;

    // 落库助手结果消息，支持用户在收件箱点击「进入会话追问」时接续完整上下文
    storageService.addMessage(sessionId, {
      id: assistantMsgId,
      role: "assistant",
      content: summaryText || (errorText ? `执行异常：${errorText}` : "定时任务已完成。"),
      reasoning: String(turnResult?.reasoning || ""),
      createdAt: finishedAt,
      metadata: {
        ...(turnResult?.metadata || {}),
        automationId: rule.id,
        automationRunId: runId,
        durationMs,
      },
    });

    const finalStatus = wasCancelled ? "cancelled" : ok ? "success" : "failed";
    runRecord = storageService.saveAutomationRun({
      id: runId,
      status: finalStatus,
      triage_state: "unread",
      summary: summaryText || (wasCancelled ? "任务已取消。" : "执行完成，无文本输出。"),
      error: errorText,
      outputs: finalOutputs,
      duration_ms: durationMs,
      finished_at: finishedAt,
    });

    storageService.saveAutomation({
      id: rule.id,
      last_run_at: finishedAt,
      last_status: finalStatus,
      recomputeNext: false,
    });

    if (finalStatus === "failed") {
      notifyDesktopIfBackground({
        title: `定时任务失败 · ${rule.name}`,
        body: errorText || "请打开「定时任务」查看详情",
      });
    } else if (finalStatus === "success") {
      notifyDesktopIfBackground({
        title: `定时任务完成 · ${rule.name}`,
        body: summaryText.slice(0, 90) || "结果已写入收件箱",
      });
    }

    if (rule.webhook_target_id) {
      webhookService
        .notifyAutomationRun(storageService, rule.webhook_target_id, rule.notify_on, runRecord)
        .catch((err) => {
          console.warn(`[automationService] Webhook 推送失败 (${rule.name}):`, err.message);
        });
    }
  } catch (err) {
    const finishedAt = Date.now();
    const errorMsg = err?.message || "后台执行异常";
    runRecord = storageService.saveAutomationRun({
      id: runId,
      status: "failed",
      triage_state: "unread",
      summary: "",
      error: errorMsg,
      outputs: collectedOutputs,
      duration_ms: Math.max(0, finishedAt - startedAt),
      finished_at: finishedAt,
    });
    storageService.saveAutomation({
      id: rule.id,
      last_run_at: finishedAt,
      last_status: "failed",
      recomputeNext: false,
    });
    notifyDesktopIfBackground({
      title: `定时任务异常 · ${rule.name}`,
      body: errorMsg,
    });
    if (rule.webhook_target_id) {
      webhookService
        .notifyAutomationRun(storageService, rule.webhook_target_id, rule.notify_on, runRecord)
        .catch(() => {});
    }
  } finally {
    runningByRule.delete(automationId);
    activeRuns.delete(runId);
    broadcastAutomationUpdated({ type: "run_finished", runId, automationId: rule.id });
    drainQueue();
  }
}

function drainQueue() {
  while (activeRuns.size < MAX_CONCURRENT_RUNS && pendingQueue.length > 0) {
    const nextJob = pendingQueue.shift();
    if (!nextJob) continue;
    executeRunJob(nextJob).catch((err) => {
      console.error("[automationService] 执行任务未捕获异常:", err);
      runningByRule.delete(nextJob.automationId);
      activeRuns.delete(nextJob.runId);
    });
  }
}

function enqueueAutomationRun(automationId, { triggerSource = "manual", extraInput = "" } = {}) {
  const storageService = getStorageService();
  const rule = storageService.getAutomation(automationId);
  if (!rule) {
    return { ok: false, notFound: true, error: "定时任务规则不存在" };
  }
  if (runningByRule.has(automationId)) {
    return { ok: false, busy: true, error: "该定时任务正在运行中，已跳过重复触发" };
  }

  const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  runningByRule.add(automationId);

  const queued = activeRuns.size >= MAX_CONCURRENT_RUNS;
  pendingQueue.push({
    automationId,
    runId,
    triggerSource,
    extraInput: String(extraInput || "").trim(),
  });
  drainQueue();
  return { ok: true, runId, queued };
}

function cancelAutomationRun(runId) {
  if (!runId) return false;
  // 若还在等待队列里，直接移出队列
  const qIdx = pendingQueue.findIndex((j) => j.runId === runId);
  if (qIdx >= 0) {
    const [removed] = pendingQueue.splice(qIdx, 1);
    runningByRule.delete(removed.automationId);
    return true;
  }

  const active = activeRuns.get(runId);
  if (!active) return false;
  active.cancelled = true;
  const sessAbort = activeStreamSessions.get(active.sessionId);
  if (sessAbort) {
    sessAbort.cancelled = true;
    try {
      sessAbort.abortController.abort();
    } catch {}
  }
  return true;
}

function tickScheduler(now = Date.now()) {
  const storageService = getStorageService();
  const rules = storageService.getAutomations();
  for (const rule of rules) {
    if (!rule.enabled || rule.schedule_type === "manual") continue;
    if (!rule.next_run_at) {
      const nextAt = computeNextRunAt(rule, now);
      if (nextAt) {
        storageService.saveAutomation({ id: rule.id, next_run_at: nextAt, recomputeNext: false });
      }
      continue;
    }
    if (rule.next_run_at <= now) {
      // 提前推进 next_run_at 防止下一轮 tick 重入
      const nextAt = computeNextRunAt(rule, now + 1000);
      storageService.saveAutomation({ id: rule.id, next_run_at: nextAt, recomputeNext: false });
      if (!runningByRule.has(rule.id)) {
        enqueueAutomationRun(rule.id, { triggerSource: "schedule" });
      }
    }
  }
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    try {
      tickScheduler();
    } catch (err) {
      console.warn("[automationService] 调度扫描异常:", err.message);
    }
  }, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref?.();
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

async function initAutomationRuntime() {
  if (initialized) return;
  initialized = true;
  const storageService = getStorageService();

  // 将应用崩溃前遗留的 running 状态修正为 failed，避免收件箱永久卡在运行中
  try {
    const staleRuns = storageService.getAutomationRuns({ status: "running", limit: 100 });
    for (const run of staleRuns) {
      if (!activeRuns.has(run.id)) {
        storageService.saveAutomationRun({
          id: run.id,
          status: "failed",
          error: "应用重启或异常中断，运行未完成",
          finished_at: Date.now(),
        });
      }
    }
  } catch {}

  webhookService.setAutomationTriggerHandler((automationId, opts) =>
    enqueueAutomationRun(automationId, opts)
  );
  startScheduler();
  await webhookService.syncInboundServerState(storageService).catch((err) => {
    console.warn("[automationService] 启动 Inbound Webhook 失败:", err.message);
  });
}

async function shutdownAutomationRuntime() {
  stopScheduler();
  webhookService.setAutomationTriggerHandler(null);
  await webhookService.stopInboundServer().catch(() => {});
  initialized = false;
}

function getRuntimeSnapshot() {
  return {
    activeRunIds: Array.from(activeRuns.keys()),
    queuedCount: pendingQueue.length,
    inbound: webhookService.getInboundServerStatus(),
  };
}

module.exports = {
  initAutomationRuntime,
  shutdownAutomationRuntime,
  startScheduler,
  stopScheduler,
  tickScheduler,
  enqueueAutomationRun,
  cancelAutomationRun,
  getRuntimeSnapshot,
  setAgentTurnRunner,
};
