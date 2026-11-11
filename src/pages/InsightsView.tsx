import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  DollarSign,
  FlaskConical,
  Gauge,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  XCircle,
  Zap,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface TelemetryRunSummary {
  id: string;
  sessionId: string;
  runId: string;
  source: string;
  model: string;
  provider: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  success: boolean;
  cancelled: boolean;
  error: string;
  rounds: number;
  toolCallCount: number;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
  } | null;
  costUsd: number;
}

interface TelemetryStats {
  totals: {
    runs: number;
    success: number;
    failed: number;
    cancelled: number;
    successRate: number;
    failureRate: number;
    cancelRate: number;
    avgDurationMs: number;
    cacheHitRate: number;
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
  };
  byModel: Array<{
    key: string;
    provider: string;
    model: string;
    runs: number;
    success: number;
    failed: number;
    cancelled: number;
    successRate: number;
    costUsd: number;
    avgDurationMs: number;
    tokens: number;
  }>;
  byDay: Array<{ date: string; runs: number; success: number; failed: number; costUsd: number }>;
  topTools: Array<{ name: string; calls: number; failures: number; avgDurationMs: number }>;
}

interface EvalItem {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  maxRounds: number;
  error: string | null;
}

interface EvalCheck {
  label: string;
  pass: boolean;
  detail?: string;
}

interface EvalResult {
  success: boolean;
  evalId: string;
  name: string;
  checks?: EvalCheck[];
  error?: string;
  response?: string;
  toolCalls?: Array<{ name: string; status: string; durationMs: number }>;
  costUsd?: number;
  durationMs?: number;
}

const RANGES = [
  { id: "24h", label: "24 小时", ms: 24 * 3600 * 1000 },
  { id: "7d", label: "7 天", ms: 7 * 24 * 3600 * 1000 },
  { id: "30d", label: "30 天", ms: 30 * 24 * 3600 * 1000 },
  { id: "all", label: "全部", ms: 0 },
];

const fmtCost = (value: number) => {
  const n = Number(value) || 0;
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(3)}`;
};

const fmtDuration = (ms: number) => {
  const n = Number(ms) || 0;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return `${m}m ${s}s`;
};

const fmtTokens = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
};

const fmtTime = (ts: number) => {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
};

const InsightsView: React.FC = () => {
  const models = useChatStore((s) => s.models);
  const chatModels = useMemo(
    () => (models || []).filter((m) => !m.type || m.type === "chat"),
    [models]
  );
  const [modelId, setModelId] = useState("");
  const [rangeId, setRangeId] = useState("7d");
  const [stats, setStats] = useState<TelemetryStats | null>(null);
  const [runs, setRuns] = useState<TelemetryRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedRun, setExpandedRun] = useState<string>("");
  const [runDetail, setRunDetail] = useState<any>(null);
  const [evals, setEvals] = useState<EvalItem[]>([]);
  const [evalResults, setEvalResults] = useState<Record<string, EvalResult>>({});
  const [runningEvalId, setRunningEvalId] = useState("");
  const [runningAll, setRunningAll] = useState(false);

  useEffect(() => {
    if (!modelId && chatModels.length > 0) setModelId(chatModels[0].id);
  }, [chatModels, modelId]);

  const sinceMs = useMemo(() => {
    const range = RANGES.find((r) => r.id === rangeId) || RANGES[1];
    return range.ms > 0 ? Date.now() - range.ms : 0;
  }, [rangeId]);

  const load = useCallback(async () => {
    if (!window.electronAPI?.telemetryGetStats) return;
    setLoading(true);
    setError("");
    try {
      const [nextStats, runList, evalList] = await Promise.all([
        window.electronAPI.telemetryGetStats({ sinceMs }),
        window.electronAPI.telemetryListRuns({ limit: 60, sinceMs }),
        window.electronAPI.listEvals(),
      ]);
      setStats(nextStats);
      setRuns(runList?.runs || []);
      setEvals(Array.isArray(evalList) ? evalList : []);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [sinceMs]);

  useEffect(() => {
    load();
  }, [load]);

  const openRun = async (id: string) => {
    if (expandedRun === id) {
      setExpandedRun("");
      setRunDetail(null);
      return;
    }
    setExpandedRun(id);
    setRunDetail(null);
    try {
      const detail = await window.electronAPI.telemetryGetRun(id);
      setRunDetail(detail);
    } catch {
      setRunDetail(null);
    }
  };

  const runOneEval = async (evalId: string) => {
    if (!window.electronAPI?.runEval || runningEvalId || runningAll) return;
    setRunningEvalId(evalId);
    try {
      const result = await window.electronAPI.runEval(evalId, modelId || undefined, undefined);
      setEvalResults((prev) => ({ ...prev, [evalId]: result }));
    } catch (err: any) {
      setEvalResults((prev) => ({
        ...prev,
        [evalId]: { success: false, evalId, name: evalId, error: err?.message || String(err) },
      }));
    } finally {
      setRunningEvalId("");
      load();
    }
  };

  const runAll = async () => {
    if (!window.electronAPI?.runAllEvals || runningAll || runningEvalId) return;
    setRunningAll(true);
    try {
      const result = await window.electronAPI.runAllEvals(modelId || undefined, undefined, undefined);
      const next: Record<string, EvalResult> = {};
      for (const item of result?.results || []) next[item.evalId] = item;
      setEvalResults(next);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setRunningAll(false);
      load();
    }
  };

  const totals = stats?.totals;
  const kpis = [
    {
      icon: <Activity size={14} />,
      label: "运行次数",
      value: totals ? String(totals.runs) : "-",
      hint: totals ? `成功 ${totals.success} · 取消 ${totals.cancelled}` : "",
      color: "text-[var(--ui-accent-sky)]",
    },
    {
      icon: <CheckCircle2 size={14} />,
      label: "成功率",
      value: totals ? `${totals.successRate}%` : "-",
      hint: totals ? `失败 ${totals.failed}` : "",
      color: "text-[var(--ui-accent-emerald)]",
    },
    {
      icon: <DollarSign size={14} />,
      label: "累计成本",
      value: totals ? fmtCost(totals.costUsd) : "-",
      hint: totals ? `${fmtTokens(totals.promptTokens)} 输入 / ${fmtTokens(totals.completionTokens)} 输出` : "",
      color: "text-[var(--ui-accent-amber)]",
    },
    {
      icon: <Clock size={14} />,
      label: "平均耗时",
      value: totals ? fmtDuration(totals.avgDurationMs) : "-",
      hint: "按运行结束时间统计",
      color: "text-[var(--ui-accent-blue)]",
    },
    {
      icon: <Zap size={14} />,
      label: "缓存命中",
      value: totals ? `${totals.cacheHitRate}%` : "-",
      hint: totals ? `${fmtTokens(totals.cachedTokens)} cached tokens` : "",
      color: "text-[var(--ui-accent-violet)]",
    },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto custom-scrollbar bg-[var(--ui-app-bg)] select-none">
      <div className="max-w-[1180px] mx-auto px-7 py-6 flex flex-col gap-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-[var(--ui-text-primary)] tracking-tight flex items-center gap-2">
              <Gauge size={17} className="text-[var(--ui-accent-sky)]" />
              用量与评测
            </h1>
            <p className="text-[11.5px] text-[var(--ui-text-muted)] mt-1">
              Agent 调用链 trace、Token 与成本、成功率看板，以及可复跑的评测集
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] p-0.5">
              {RANGES.map((range) => (
                <button
                  key={range.id}
                  onClick={() => setRangeId(range.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                    rangeId === range.id
                      ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium"
                      : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                  }`}
                >
                  {range.label}
                </button>
              ))}
            </div>
            <button
              onClick={load}
              className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
              title="刷新数据"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              刷新
            </button>
          </div>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-[11px] text-red-400">
            {error}
          </div>
        )}

        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] px-3.5 py-3"
            >
              <div className={`flex items-center gap-1.5 text-[10.5px] ${kpi.color}`}>
                {kpi.icon}
                <span className="font-medium tracking-wide">{kpi.label}</span>
              </div>
              <div className="mt-1.5 text-xl font-semibold text-[var(--ui-text-primary)] font-mono">
                {kpi.value}
              </div>
              <div className="mt-0.5 text-[10px] text-[var(--ui-text-faint)] truncate">{kpi.hint}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_1fr] gap-4 items-start">
          {/* 运行记录 */}
          <div className="rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between">
              <h2 className="text-xs font-bold text-[var(--ui-text-primary)] flex items-center gap-2">
                <Activity size={13} className="text-[var(--ui-accent-sky)]" />
                调用链 (Trace)
              </h2>
              <span className="text-[10px] text-[var(--ui-text-faint)] font-mono">
                {runs.length} 条记录
              </span>
            </div>
            {runs.length === 0 ? (
              <div className="py-12 text-center text-[11px] text-[var(--ui-text-faint)]">
                {loading ? "正在读取运行记录…" : "当前时间范围内暂无 Agent 运行记录"}
              </div>
            ) : (
              <div className="divide-y divide-[color:var(--ui-divider-hairline)] max-h-[520px] overflow-y-auto custom-scrollbar">
                {runs.map((run) => {
                  const expanded = expandedRun === run.id;
                  const statusColor = run.cancelled
                    ? "text-[var(--ui-text-faint)]"
                    : run.success
                    ? "text-[var(--ui-accent-emerald)]"
                    : "text-red-400";
                  return (
                    <div key={run.id}>
                      <button
                        onClick={() => openRun(run.id)}
                        className="w-full px-4 py-2.5 flex items-center gap-2.5 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors"
                      >
                        {expanded ? (
                          <ChevronDown size={12} className="text-[var(--ui-text-faint)] flex-shrink-0" />
                        ) : (
                          <ChevronRight size={12} className="text-[var(--ui-text-faint)] flex-shrink-0" />
                        )}
                        {run.cancelled ? (
                          <XCircle size={13} className={statusColor + " flex-shrink-0"} />
                        ) : run.success ? (
                          <CheckCircle2 size={13} className={statusColor + " flex-shrink-0"} />
                        ) : (
                          <XCircle size={13} className={statusColor + " flex-shrink-0"} />
                        )}
                        <span className="text-[11px] font-mono text-[var(--ui-text-secondary)] truncate flex-1">
                          {run.model || "未知模型"}
                          {run.source === "eval" ? (
                            <span className="ml-1.5 px-1 py-0.2 rounded bg-[var(--ui-accent-violet-soft)] text-[var(--ui-accent-violet)] text-[9px]">
                              EVAL
                            </span>
                          ) : null}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--ui-text-faint)] flex-shrink-0">
                          {run.toolCallCount} tools · {run.rounds} 轮
                        </span>
                        <span className="text-[10px] font-mono text-[var(--ui-text-faint)] w-14 text-right flex-shrink-0">
                          {fmtDuration(run.durationMs)}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--ui-accent-amber)] w-16 text-right flex-shrink-0">
                          {fmtCost(run.costUsd)}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--ui-text-faint)] w-16 text-right flex-shrink-0">
                          {fmtTime(run.startedAt)}
                        </span>
                      </button>
                      {expanded && (
                        <div className="px-9 pb-3">
                          {!runDetail ? (
                            <div className="py-3 flex items-center gap-1.5 text-[10.5px] text-[var(--ui-text-muted)]">
                              <Loader2 size={11} className="animate-spin" /> 读取调用链…
                            </div>
                          ) : (
                            <div className="rounded-xl bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] p-3 flex flex-col gap-2">
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-[var(--ui-text-muted)]">
                                <span>run: {runDetail.runId || "-"}</span>
                                <span>session: {runDetail.sessionId || "-"}</span>
                                <span>provider: {runDetail.provider || "-"}</span>
                                <span>
                                  tokens: {fmtTokens(runDetail.usage?.prompt_tokens)} /{" "}
                                  {fmtTokens(runDetail.usage?.completion_tokens)}
                                </span>
                                <span>cached: {fmtTokens(runDetail.usage?.cached_tokens)}</span>
                              </div>
                              {runDetail.error && (
                                <div className="text-[10.5px] text-red-400 break-all">
                                  {runDetail.error}
                                </div>
                              )}
                              {Array.isArray(runDetail.toolCalls) && runDetail.toolCalls.length > 0 ? (
                                <div className="flex flex-col gap-1">
                                  {runDetail.toolCalls.map((tool: any, index: number) => (
                                    <div
                                      key={`${tool.name}-${index}`}
                                      className="flex items-center gap-2 text-[10.5px] font-mono"
                                    >
                                      <span className="w-4 text-right text-[var(--ui-text-faint)]">
                                        {index + 1}
                                      </span>
                                      <span
                                        className={
                                          tool.status === "ok"
                                            ? "text-[var(--ui-accent-emerald)]"
                                            : tool.status === "blocked"
                                            ? "text-[var(--ui-accent-amber)]"
                                            : "text-red-400"
                                        }
                                      >
                                        {tool.status}
                                      </span>
                                      <span className="text-[var(--ui-text-primary)]">{tool.name}</span>
                                      <span className="text-[var(--ui-text-faint)] truncate flex-1">
                                        {tool.summary}
                                      </span>
                                      <span className="text-[var(--ui-text-faint)]">
                                        {fmtDuration(tool.durationMs)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-[10.5px] text-[var(--ui-text-faint)]">
                                  本次运行没有工具调用
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 模型与工具分布 */}
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[color:var(--ui-divider-hairline)]">
                <h2 className="text-xs font-bold text-[var(--ui-text-primary)] flex items-center gap-2">
                  <Cpu size={13} className="text-[var(--ui-accent-blue)]" />
                  模型分布
                </h2>
              </div>
              <div className="p-3 flex flex-col gap-1.5">
                {(stats?.byModel || []).length === 0 ? (
                  <div className="py-6 text-center text-[11px] text-[var(--ui-text-faint)]">
                    暂无数据
                  </div>
                ) : (
                  stats!.byModel.map((m) => (
                    <div
                      key={m.key}
                      className="rounded-xl bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-mono text-[var(--ui-text-primary)] truncate">
                          {m.model}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--ui-accent-emerald)] flex-shrink-0">
                          {m.successRate}%
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-[var(--ui-text-faint)]">
                        <span>{m.runs} 次 · {m.provider}</span>
                        <span>{fmtCost(m.costUsd)} · {fmtDuration(m.avgDurationMs)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[color:var(--ui-divider-hairline)]">
                <h2 className="text-xs font-bold text-[var(--ui-text-primary)] flex items-center gap-2">
                  <Zap size={13} className="text-[var(--ui-accent-amber)]" />
                  工具调用 Top
                </h2>
              </div>
              <div className="p-3 flex flex-col gap-1">
                {(stats?.topTools || []).length === 0 ? (
                  <div className="py-6 text-center text-[11px] text-[var(--ui-text-faint)]">
                    暂无工具调用
                  </div>
                ) : (
                  stats!.topTools.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-[var(--ui-block-hover-bg)]"
                    >
                      <span className="text-[10.5px] font-mono text-[var(--ui-text-primary)] flex-1 truncate">
                        {tool.name}
                      </span>
                      {tool.failures > 0 && (
                        <span className="text-[9px] font-mono text-red-400">{tool.failures} 失败</span>
                      )}
                      <span className="text-[10px] font-mono text-[var(--ui-text-faint)] w-12 text-right">
                        {tool.calls} 次
                      </span>
                      <span className="text-[10px] font-mono text-[var(--ui-text-faint)] w-14 text-right">
                        {fmtDuration(tool.avgDurationMs)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 评测集 */}
        <div className="rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xs font-bold text-[var(--ui-text-primary)] flex items-center gap-2">
                <FlaskConical size={13} className="text-[var(--ui-accent-violet)]" />
                评测集 (Evals)
              </h2>
              <p className="text-[10.5px] text-[var(--ui-text-muted)] mt-0.5">
                每个用例在独立临时工作区跑真实工具循环；用例文件位于 ~/.omcx/evals/*.json
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="h-7 px-2 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] outline-none max-w-[190px]"
                title="评测使用的模型"
              >
                {chatModels.length === 0 && <option value="">未配置模型</option>}
                {chatModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.model_id}
                  </option>
                ))}
              </select>
              <button
                onClick={runAll}
                disabled={runningAll || Boolean(runningEvalId) || chatModels.length === 0}
                className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--ui-accent-violet-soft)] border border-[color:var(--ui-accent-violet-border)] text-[11px] text-[var(--ui-accent-violet)] hover:brightness-110 disabled:opacity-50 transition-all"
              >
                {runningAll ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                运行全部
              </button>
            </div>
          </div>

          {evals.length === 0 ? (
            <div className="py-10 text-center text-[11px] text-[var(--ui-text-faint)]">
              暂无评测用例，首次加载会自动生成 3 个示例用例
            </div>
          ) : (
            <div className="divide-y divide-[color:var(--ui-divider-hairline)]">
              {evals.map((item) => {
                const result = evalResults[item.id];
                const running = runningEvalId === item.id;
                return (
                  <div key={item.id} className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <button
                        onClick={() => runOneEval(item.id)}
                        disabled={running || runningAll || chatModels.length === 0}
                        className="w-7 h-7 flex items-center justify-center rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-violet)] disabled:opacity-50 transition-colors flex-shrink-0"
                        title="运行该评测"
                      >
                        {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[11.5px] font-semibold text-[var(--ui-text-primary)] truncate">
                            {item.name}
                          </span>
                          <span className="text-[9px] font-mono text-[var(--ui-text-faint)]">
                            {item.id}
                          </span>
                          {item.tags.map((tag) => (
                            <span
                              key={tag}
                              className="px-1 py-0.2 rounded bg-[var(--ui-chip-bg)] text-[9px] font-mono text-[var(--ui-text-muted)]"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                        <div className="text-[10.5px] text-[var(--ui-text-muted)] truncate mt-0.5">
                          {item.description || item.prompt}
                        </div>
                      </div>
                      {result && (
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span
                            className={`text-[10px] font-mono ${
                              result.success ? "text-[var(--ui-accent-emerald)]" : "text-red-400"
                            }`}
                          >
                            {result.success ? "PASS" : "FAIL"}
                          </span>
                          {typeof result.durationMs === "number" && (
                            <span className="text-[10px] font-mono text-[var(--ui-text-faint)]">
                              {fmtDuration(result.durationMs)}
                            </span>
                          )}
                          {typeof result.costUsd === "number" && (
                            <span className="text-[10px] font-mono text-[var(--ui-accent-amber)]">
                              {fmtCost(result.costUsd)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {result && (result.error || (result.checks && result.checks.length > 0)) && (
                      <div className="mt-2 ml-9 rounded-xl bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] p-2.5 flex flex-col gap-1">
                        {result.error && (
                          <div className="text-[10.5px] text-red-400 break-all">{result.error}</div>
                        )}
                        {(result.checks || []).map((check, index) => (
                          <div key={index} className="flex items-start gap-1.5 text-[10.5px]">
                            {check.pass ? (
                              <CheckCircle2 size={11} className="text-[var(--ui-accent-emerald)] mt-0.5 flex-shrink-0" />
                            ) : (
                              <XCircle size={11} className="text-red-400 mt-0.5 flex-shrink-0" />
                            )}
                            <span
                              className={
                                check.pass
                                  ? "text-[var(--ui-text-muted)]"
                                  : "text-[var(--ui-text-secondary)]"
                              }
                            >
                              {check.label}
                              {!check.pass && check.detail ? (
                                <span className="ml-1 text-[10px] text-[var(--ui-text-faint)] break-all">
                                  {check.detail}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        ))}
                        {result.response && (
                          <div className="mt-1 text-[10px] text-[var(--ui-text-faint)] line-clamp-3 whitespace-pre-wrap">
                            {result.response}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-[10px] text-[var(--ui-text-faint)] font-mono pb-2">
          <span>数据来源：~/.omcx/telemetry/runs.jsonl（仅本地）</span>
          <button
            onClick={async () => {
              if (!window.electronAPI?.telemetryClear) return;
              await window.electronAPI.telemetryClear();
              load();
            }}
            className="flex items-center gap-1 hover:text-red-400 transition-colors"
            title="清空本地观测数据"
          >
            <RotateCcw size={10} />
            清空观测数据
          </button>
        </div>
      </div>
    </div>
  );
};

export default InsightsView;
