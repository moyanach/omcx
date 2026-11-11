/**
 * telemetryService — Agent 调用链 trace 与成本/成功率观测
 *
 * 存储：<OMCX_HOME>/telemetry/runs.jsonl（追加写，按行 JSON）
 * 每次 Agent run 结束时落盘一条完整记录：
 *   { id, sessionId, runId, source, model, provider, startedAt, endedAt,
 *     durationMs, success, cancelled, error, rounds, contentChars,
 *     toolCalls: [{ name, status, durationMs, at, summary }],
 *     usage: {...}, costUsd }
 *
 * 该服务只做本地统计，不发起任何网络请求。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_RUNS = 2000;
const MAX_TOOL_CALLS_PER_RUN = 200;

function omcxHome() {
  return process.env.OMCX_HOME || path.join(os.homedir(), ".omcx");
}

function telemetryDir() {
  return path.join(omcxHome(), "telemetry");
}

function runsFile() {
  return path.join(telemetryDir(), "runs.jsonl");
}

let cache = null; // Map<id, run>
const activeRuns = new Map();

function ensureDir() {
  try {
    fs.mkdirSync(telemetryDir(), { recursive: true });
  } catch {}
}

function loadCache() {
  if (cache) return cache;
  cache = new Map();
  ensureDir();
  const file = runsFile();
  if (!fs.existsSync(file)) return cache;
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return cache;
  }
  const lines = raw.split("\n");
  const start = Math.max(0, lines.length - MAX_MEMORY_RUNS);
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const run = JSON.parse(line);
      if (run?.id) cache.set(run.id, run);
    } catch {}
  }
  return cache;
}

function rotateIfNeeded() {
  try {
    const file = runsFile();
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) {
      fs.renameSync(file, path.join(telemetryDir(), "runs.1.jsonl"));
      cache = null;
    }
  } catch {}
}

function makeId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 开始一次运行记录（内存态，结束时才落盘）
 */
function startRun({ sessionId, runId, model, provider, source = "chat", meta = {} } = {}) {
  const record = {
    id: makeId(),
    sessionId: sessionId || "",
    runId: runId || "",
    source,
    model: model || "",
    provider: provider || "",
    startedAt: Date.now(),
    endedAt: null,
    durationMs: 0,
    success: false,
    cancelled: false,
    error: "",
    rounds: 0,
    contentChars: 0,
    toolCalls: [],
    usage: null,
    costUsd: 0,
    meta,
  };
  activeRuns.set(record.id, record);
  return record;
}

/**
 * 记录一次工具调用
 * @param {string} telemetryRunId
 * @param {{name:string,status?:string,durationMs?:number,summary?:string,args?:any}} tool
 */
function recordToolCall(telemetryRunId, tool = {}) {
  const record = activeRuns.get(telemetryRunId);
  if (!record) return;
  if (record.toolCalls.length >= MAX_TOOL_CALLS_PER_RUN) return;
  let summary = typeof tool.summary === "string" ? tool.summary : "";
  if (!summary && tool.args && typeof tool.args === "object") {
    try {
      summary = JSON.stringify(tool.args).slice(0, 240);
    } catch {
      summary = "";
    }
  }
  record.toolCalls.push({
    name: tool.name || "unknown",
    status: tool.status || "ok",
    durationMs: Math.max(0, Math.round(Number(tool.durationMs) || 0)),
    at: Date.now(),
    summary,
  });
}

/**
 * 结束运行并落盘
 */
function finishRun(telemetryRunId, patch = {}) {
  const record = activeRuns.get(telemetryRunId);
  if (!record) return null;
  activeRuns.delete(telemetryRunId);

  const endedAt = Date.now();
  record.endedAt = endedAt;
  record.durationMs = Math.max(0, endedAt - record.startedAt);
  record.success = Boolean(patch.success);
  record.cancelled = Boolean(patch.cancelled);
  record.error = patch.error ? String(patch.error).slice(0, 1200) : "";
  record.rounds = Math.max(0, Number(patch.rounds) || 0);
  record.contentChars = Math.max(0, Number(patch.contentChars) || 0);
  record.usage = patch.usage || record.usage || null;
  record.costUsd = Math.max(0, Number(patch.costUsd) || 0);
  if (Array.isArray(patch.toolCalls)) record.toolCalls = patch.toolCalls.slice(0, MAX_TOOL_CALLS_PER_RUN);

  ensureDir();
  rotateIfNeeded();
  try {
    fs.appendFileSync(runsFile(), `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    console.warn("[telemetry] 写入运行记录失败:", err.message);
  }
  const map = loadCache();
  map.set(record.id, record);
  while (map.size > MAX_MEMORY_RUNS) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  return record;
}

function summarize(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    runId: run.runId,
    source: run.source,
    model: run.model,
    provider: run.provider,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    success: run.success,
    cancelled: run.cancelled,
    error: run.error,
    rounds: run.rounds,
    toolCallCount: Array.isArray(run.toolCalls) ? run.toolCalls.length : 0,
    usage: run.usage,
    costUsd: run.costUsd,
  };
}

function listRuns({ limit = 50, offset = 0, source = null, sinceMs = 0 } = {}) {
  const map = loadCache();
  const all = Array.from(map.values())
    .filter((run) => (!source || run.source === source) && (run.startedAt || 0) >= sinceMs)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return {
    total: all.length,
    runs: all.slice(safeOffset, safeOffset + safeLimit).map(summarize),
  };
}

function getRun(id) {
  const map = loadCache();
  return map.get(id) || null;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function getStats({ sinceMs = 0, source = null } = {}) {
  const map = loadCache();
  const runs = Array.from(map.values()).filter(
    (run) => (run.startedAt || 0) >= sinceMs && (!source || run.source === source)
  );

  const totals = {
    runs: runs.length,
    success: 0,
    failed: 0,
    cancelled: 0,
    costUsd: 0,
    durationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    creationTokens: 0,
  };
  const byModel = new Map();
  const byDay = new Map();
  const byTool = new Map();
  const byProvider = new Map();

  for (const run of runs) {
    if (run.cancelled) totals.cancelled += 1;
    else if (run.success) totals.success += 1;
    else totals.failed += 1;

    totals.costUsd += Number(run.costUsd) || 0;
    totals.durationMs += Number(run.durationMs) || 0;
    const usage = run.usage || {};
    totals.promptTokens += Number(usage.prompt_tokens) || 0;
    totals.completionTokens += Number(usage.completion_tokens) || 0;
    totals.cachedTokens += Number(usage.cached_tokens) || 0;
    totals.creationTokens += Number(usage.cache_creation_tokens) || 0;

    const modelKey = `${run.provider || "?"}/${run.model || "?"}`;
    const m = byModel.get(modelKey) || {
      key: modelKey,
      provider: run.provider || "",
      model: run.model || "",
      runs: 0,
      success: 0,
      cancelled: 0,
      failed: 0,
      costUsd: 0,
      durationMs: 0,
      tokens: 0,
    };
    m.runs += 1;
    if (run.cancelled) m.cancelled += 1;
    else if (run.success) m.success += 1;
    else m.failed += 1;
    m.costUsd += Number(run.costUsd) || 0;
    m.durationMs += Number(run.durationMs) || 0;
    m.tokens +=
      (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
    byModel.set(modelKey, m);

    const pKey = run.provider || "unknown";
    byProvider.set(pKey, (byProvider.get(pKey) || 0) + 1);

    const day = new Date(run.startedAt || Date.now());
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
      day.getDate()
    ).padStart(2, "0")}`;
    const d = byDay.get(dayKey) || { date: dayKey, runs: 0, success: 0, failed: 0, costUsd: 0 };
    d.runs += 1;
    if (run.success) d.success += 1;
    else d.failed += 1;
    d.costUsd += Number(run.costUsd) || 0;
    byDay.set(dayKey, d);

    for (const tool of run.toolCalls || []) {
      const t = byTool.get(tool.name) || { name: tool.name, calls: 0, failures: 0, durationMs: 0 };
      t.calls += 1;
      if (tool.status && tool.status !== "ok" && tool.status !== "success") t.failures += 1;
      t.durationMs += Number(tool.durationMs) || 0;
      byTool.set(tool.name, t);
    }
  }

  return {
    generatedAt: Date.now(),
    sinceMs,
    totals: {
      ...totals,
      successRate: pct(totals.success, totals.runs),
      failureRate: pct(totals.failed, totals.runs),
      cancelRate: pct(totals.cancelled, totals.runs),
      avgDurationMs: totals.runs ? Math.round(totals.durationMs / totals.runs) : 0,
      cacheHitRate: pct(totals.cachedTokens, totals.promptTokens || 1),
      costUsd: Math.round(totals.costUsd * 1e8) / 1e8,
    },
    byModel: Array.from(byModel.values())
      .sort((a, b) => b.runs - a.runs)
      .map((m) => ({
        ...m,
        costUsd: Math.round(m.costUsd * 1e8) / 1e8,
        avgDurationMs: m.runs ? Math.round(m.durationMs / m.runs) : 0,
        successRate: pct(m.success, m.runs),
      })),
    byDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byProvider: Object.fromEntries(byProvider),
    topTools: Array.from(byTool.values())
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 12)
      .map((t) => ({
        ...t,
        avgDurationMs: t.calls ? Math.round(t.durationMs / t.calls) : 0,
      })),
  };
}

function clearAll() {
  activeRuns.clear();
  cache = new Map();
  try {
    const file = runsFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
  return { success: true };
}

module.exports = {
  startRun,
  recordToolCall,
  finishRun,
  listRuns,
  getRun,
  getStats,
  clearAll,
  runsFile,
  telemetryDir,
};
