import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  FileWarning,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface ProjectTask {
  id: string;
  label: string;
  kind: string;
  command: string;
}

interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  code: string;
  message: string;
}

interface RunResult {
  success: boolean;
  summary?: string;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  diagnostics?: Diagnostic[];
  task?: ProjectTask;
}

export const ChecksCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [runningId, setRunningId] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState("");

  const { sessions, activeSessionId } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || "";

  const loadTasks = useCallback(async () => {
    if (!workDir || !window.electronAPI?.getProjectTasks) {
      setTasks([]);
      return;
    }
    setLoadingTasks(true);
    setError("");
    try {
      const list = await window.electronAPI.getProjectTasks(workDir);
      setTasks(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoadingTasks(false);
    }
  }, [workDir]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const runTask = async (task: ProjectTask) => {
    if (!window.electronAPI?.runProjectTask || !workDir) return;
    setRunningId(task.id);
    setResult(null);
    setError("");
    try {
      const res = await window.electronAPI.runProjectTask(workDir, task.id, 180000);
      setResult(res);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setRunningId("");
    }
  };

  const diagnostics = result?.diagnostics || [];
  const output = `${result?.stdout || ""}${result?.stderr ? `\n${result.stderr}` : ""}`.trim();
  const durationText =
    typeof result?.durationMs === "number" ? `${(result.durationMs / 1000).toFixed(1)}s` : "";

  return (
    <div className="bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <FlaskConical size={14} className="text-[var(--ui-accent-sky)]" />
          <span className="font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide">
            Checks (诊断与测试)
          </span>
        </div>
        <div className="text-[var(--ui-text-faint)]">
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {isOpen && (
        <div className="px-4 pb-3.5 pt-0.5 flex flex-col gap-2">
          {!workDir ? (
            <div className="py-3 text-center text-xs text-[var(--ui-text-faint)]">
              请先绑定工作空间目录
            </div>
          ) : loadingTasks ? (
            <div className="py-3 flex items-center justify-center gap-1.5 text-xs text-[var(--ui-text-muted)]">
              <Loader2 size={13} className="animate-spin" /> 正在识别项目任务…
            </div>
          ) : tasks.length === 0 ? (
            <div className="py-3 text-center text-xs text-[var(--ui-text-faint)]">
              未识别到可运行的测试 / 类型检查 / Lint 任务
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => runTask(task)}
                  disabled={Boolean(runningId)}
                  title={task.command}
                  className="px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                >
                  {runningId === task.id ? (
                    <Loader2 size={11} className="animate-spin text-[var(--ui-accent-sky)]" />
                  ) : (
                    <FlaskConical size={11} className="text-[var(--ui-accent-sky)]" />
                  )}
                  <span>{task.label}</span>
                </button>
              ))}
              <button
                onClick={loadTasks}
                disabled={Boolean(runningId) || loadingTasks}
                className="px-2 py-1 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] disabled:opacity-50"
                title="重新识别任务"
              >
                <RefreshCw size={11} />
              </button>
            </div>
          )}

          {error && <div className="text-[11px] text-[var(--ui-accent-rose)]">{error}</div>}

          {result && (
            <div className="flex flex-col gap-2">
              <div
                className={`flex items-center gap-1.5 text-[11px] font-medium ${
                  result.success
                    ? "text-[var(--ui-accent-emerald)]"
                    : "text-[var(--ui-accent-rose)]"
                }`}
              >
                {result.success ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
                <span>{result.summary || (result.success ? "任务通过" : "任务失败")}</span>
                {durationText && (
                  <span className="text-[10px] text-[var(--ui-text-faint)] font-mono">
                    · {durationText}
                  </span>
                )}
              </div>

              {diagnostics.length > 0 && (
                <div className="rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] max-h-[180px] overflow-y-auto custom-scrollbar">
                  <div className="px-2.5 py-1.5 text-[10px] font-semibold text-[var(--ui-text-muted)] border-b border-[color:var(--ui-divider-hairline)] sticky top-0 bg-[var(--ui-card-inner-bg)]">
                    <FileWarning size={11} className="inline mr-1" />
                    {diagnostics.length} 条类型诊断
                  </div>
                  {diagnostics.slice(0, 80).map((item, idx) => (
                    <div
                      key={`${item.file}-${item.line}-${idx}`}
                      className="px-2.5 py-1 text-[10.5px] border-b border-[color:var(--ui-divider-hairline)] last:border-0"
                    >
                      <span className="font-mono text-[var(--ui-text-muted)]">
                        {item.file}:{item.line}:{item.column}
                      </span>
                      <span className="ml-1.5 text-[var(--ui-accent-rose)] font-mono">
                        {item.code}
                      </span>
                      <div className="text-[var(--ui-text-secondary)] leading-snug">
                        {item.message}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {output && (
                <pre className="rounded-xl bg-[var(--ui-code-bg)] border border-[color:var(--ui-border-hairline)] px-2.5 py-2 text-[10.5px] leading-relaxed font-mono text-[var(--ui-text-muted)] max-h-[200px] overflow-auto custom-scrollbar whitespace-pre-wrap break-words">
                  {output.slice(-6000)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChecksCard;
