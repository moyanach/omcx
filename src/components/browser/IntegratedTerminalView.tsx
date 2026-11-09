import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Terminal as TerminalIcon,
  Play,
  Square,
  Trash2,
  Folder,
  Bot,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  Copy,
  Check,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface TerminalEntry {
  id: string;
  source: "user" | "agent";
  command: string;
  cwd: string;
  output: string;
  status: "running" | "done" | "error";
  exitCode?: number | null;
  timestamp: number;
}

// 去除常见 ANSI 控制字符，保持终端输出整洁可读
function stripAnsi(str: string): string {
  if (!str) return "";
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
}

export const IntegratedTerminalView: React.FC = () => {
  const { sessions, activeSessionId, workspaces, toolCallsBySession } =
    useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || "";

  // 支持多目录工作空间快速切换终端当前工作目录
  const workspaceRoots = useMemo(() => {
    if (!workDir) return [];
    const norm = workDir.replace(/\/+$/, "");
    const matchedWs = workspaces.find((ws) =>
      ws.folders?.some((f) => (f.path || "").replace(/\/+$/, "") === norm)
    );
    if (matchedWs && Array.isArray(matchedWs.folders) && matchedWs.folders.length > 0) {
      return matchedWs.folders.map((f) => ({
        name: f.name || f.path.split(/[\\/]/).pop() || f.path,
        path: f.path.replace(/\/+$/, ""),
      }));
    }
    return [{ name: norm.split(/[\\/]/).pop() || norm, path: norm }];
  }, [workDir, workspaces]);

  const [cwd, setCwd] = useState<string>(workDir);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [inputCmd, setInputCmd] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [runningCmdId, setRunningCmdId] = useState<string | null>(null);
  const [filterSource, setFilterSource] = useState<"all" | "user" | "agent">("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const outputEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (workDir) {
      setCwd(workDir);
    }
  }, [workDir]);

  // 同步当前会话中 Agent 调用的 run_command 工具记录
  const agentToolCalls = useMemo(() => {
    if (!activeSessionId) return [];
    const list = toolCallsBySession[activeSessionId] || [];
    return list.filter((tc: any) => tc.tool === "run_command");
  }, [activeSessionId, toolCallsBySession]);

  const mergedEntries = useMemo(() => {
    const agentMapped: TerminalEntry[] = agentToolCalls.map((tc: any, idx: number) => {
      const cmdStr =
        typeof tc.args === "object" && tc.args
          ? tc.args.command || JSON.stringify(tc.args)
          : String(tc.args || "");
      let outText = "";
      let isErr = false;
      let code: number | null = 0;

      if (tc.result) {
        if (typeof tc.result === "string") {
          try {
            const parsed = JSON.parse(tc.result);
            outText =
              parsed.stdout ||
              parsed.output ||
              parsed.stderr ||
              parsed.error ||
              tc.result;
            if (parsed.stderr && parsed.stdout) {
              outText = `${parsed.stdout}\n${parsed.stderr}`;
            }
            if (parsed.success === false || (parsed.exitCode && parsed.exitCode !== 0)) {
              isErr = true;
              code = parsed.exitCode ?? 1;
            }
          } catch {
            outText = tc.result;
          }
        } else if (typeof tc.result === "object") {
          outText =
            tc.result.stdout ||
            tc.result.output ||
            tc.result.stderr ||
            tc.result.error ||
            JSON.stringify(tc.result, null, 2);
          if (tc.result.success === false) {
            isErr = true;
            code = tc.result.exitCode ?? 1;
          }
        }
      }

      return {
        id: tc.callId || `agent_cmd_${idx}`,
        source: "agent" as const,
        command: cmdStr,
        cwd: workDir || "~",
        output: stripAnsi(outText).trimEnd(),
        status: tc.status === "running" ? "running" : isErr ? "error" : "done",
        exitCode: code,
        timestamp: idx,
      };
    });

    const combined = [...agentMapped, ...entries];
    if (filterSource === "user") return combined.filter((e) => e.source === "user");
    if (filterSource === "agent") return combined.filter((e) => e.source === "agent");
    return combined;
  }, [agentToolCalls, entries, filterSource, workDir]);

  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mergedEntries.length, runningCmdId]);

  const executeCommand = async (rawCommand?: string) => {
    const cmd = (rawCommand ?? inputCmd).trim();
    if (!cmd || runningCmdId) return;

    if (cmd === "clear" || cmd === "cls") {
      setEntries([]);
      setInputCmd("");
      return;
    }

    setCmdHistory((prev) => [cmd, ...prev.filter((item) => item !== cmd)].slice(0, 50));
    setHistoryIndex(-1);
    if (rawCommand === undefined) {
      setInputCmd("");
    }

    const cmdId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newEntry: TerminalEntry = {
      id: cmdId,
      source: "user",
      command: cmd,
      cwd: cwd || workDir || "~",
      output: "",
      status: "running",
      timestamp: Date.now(),
    };

    setEntries((prev) => [...prev, newEntry]);
    setRunningCmdId(cmdId);

    try {
      if (!window.electronAPI?.runTerminalCommand) {
        setEntries((prev) =>
          prev.map((item) =>
            item.id === cmdId
              ? {
                  ...item,
                  status: "error",
                  output: "当前环境未暴露 runTerminalCommand 接口",
                }
              : item
          )
        );
        return;
      }

      const res = await window.electronAPI.runTerminalCommand(
        {
          cmdId,
          command: cmd,
          cwd: cwd || workDir || undefined,
          workDir: workDir || undefined,
        },
        (streamPayload) => {
          const textChunk = streamPayload?.data ?? streamPayload?.chunk ?? "";
          if (textChunk) {
            const cleanChunk = stripAnsi(String(textChunk));
            setEntries((prev) =>
              prev.map((item) =>
                item.id === cmdId
                  ? {
                      ...item,
                      output: (item.output + cleanChunk).slice(-120000),
                    }
                  : item
              )
            );
          }
        }
      );

      if (res?.cwd) {
        setCwd(res.cwd);
      }

      const combinedFinalOutput = stripAnsi(
        [res?.stdout, res?.stderr, res?.output]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join("\n")
      ).trimEnd();

      setEntries((prev) =>
        prev.map((item) =>
          item.id === cmdId
            ? {
                ...item,
                status: res?.success ? "done" : "error",
                exitCode: res?.exitCode ?? (res?.success ? 0 : 1),
                output:
                  item.output.trimEnd() ||
                  combinedFinalOutput ||
                  (res?.success ? "" : "命令执行失败"),
              }
            : item
        )
      );

      if (workDir) {
        useChatStore.getState().refreshGitStatus(workDir);
      }
    } catch (err: any) {
      setEntries((prev) =>
        prev.map((item) =>
          item.id === cmdId
            ? {
                ...item,
                status: "error",
                exitCode: 1,
                output: `${item.output}\n${err?.message || String(err)}`.trim(),
              }
            : item
        )
      );
    } finally {
      setRunningCmdId(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKillRunning = async () => {
    if (!runningCmdId || !window.electronAPI?.killTerminalCommand) return;
    await window.electronAPI.killTerminalCommand(runningCmdId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistory.length === 0) return;
      const nextIdx = Math.min(historyIndex + 1, cmdHistory.length - 1);
      setHistoryIndex(nextIdx);
      setInputCmd(cmdHistory[nextIdx]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInputCmd("");
        return;
      }
      const nextIdx = historyIndex - 1;
      setHistoryIndex(nextIdx);
      setInputCmd(cmdHistory[nextIdx]);
    } else if (e.key === "c" && e.ctrlKey && runningCmdId) {
      e.preventDefault();
      handleKillRunning();
    }
  };

  const shortCwd = useMemo(() => {
    const target = cwd || workDir;
    if (!target) return "~";
    const parts = target.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : target;
  }, [cwd, workDir]);

  return (
    <div className="flex-1 h-full bg-[var(--ui-stage-bg)] flex flex-col overflow-hidden text-[var(--ui-text-primary)]">
      {/* 顶部状态与多目录切换栏 */}
      <div className="h-10 px-3 flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex-shrink-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon size={13.5} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />
          {workspaceRoots.length > 1 ? (
            <select
              value={cwd || workDir}
              onChange={(e) => setCwd(e.target.value)}
              className="h-6 px-2 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] font-mono text-[var(--ui-text-primary)] outline-none"
              title="切换当前终端所在的 Root 目录"
            >
              {workspaceRoots.map((root) => (
                <option key={root.path} value={root.path}>
                  {root.name} ({root.path})
                </option>
              ))}
              {!workspaceRoots.some((r) => r.path === cwd) && cwd && (
                <option value={cwd}>{shortCwd}</option>
              )}
            </select>
          ) : (
            <span
              className="text-[11px] font-mono text-[var(--ui-text-secondary)] truncate max-w-[220px]"
              title={cwd || workDir}
            >
              {shortCwd}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)] text-[10px]">
            <button
              onClick={() => setFilterSource("all")}
              className={`px-2 py-0.5 rounded-md transition-colors ${
                filterSource === "all"
                  ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              全部
            </button>
            <button
              onClick={() => setFilterSource("user")}
              className={`px-2 py-0.5 rounded-md transition-colors ${
                filterSource === "user"
                  ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              终端
            </button>
            <button
              onClick={() => setFilterSource("agent")}
              className={`px-2 py-0.5 rounded-md transition-colors flex items-center gap-1 ${
                filterSource === "agent"
                  ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              <Bot size={10} />
              <span>Agent ({agentToolCalls.length})</span>
            </button>
          </div>

          <button
            onClick={() => setEntries([])}
            className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
            title="清空终端记录"
          >
            <Trash2 size={12.5} />
          </button>
        </div>
      </div>

      {/* 快捷命令胶囊栏 */}
      <div className="px-3 py-1.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] flex items-center gap-1.5 overflow-x-auto flex-shrink-0 select-none">
        <span className="text-[10px] text-[var(--ui-text-faint)] mr-0.5 flex-shrink-0">
          快捷命令:
        </span>
        {["ls -la", "git status -sb", "pwd", "git log -n 5 --oneline"].map(
          (preset) => (
            <button
              key={preset}
              disabled={Boolean(runningCmdId)}
              onClick={() => executeCommand(preset)}
              className="px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] transition-colors disabled:opacity-40 whitespace-nowrap"
            >
              {preset}
            </button>
          )
        )}
      </div>

      {/* 终端输出流列表 */}
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5 font-mono text-xs custom-scrollbar select-text bg-[var(--ui-terminal-bg)]"
      >
        {mergedEntries.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-12 select-none">
            <TerminalIcon
              size={28}
              className="text-[var(--ui-text-faint)] mb-2 opacity-50"
            />
            <div className="text-xs font-medium text-[var(--ui-text-secondary)] mb-1">
              交互式工作区终端已就绪
            </div>
            <div className="text-[11px] text-[var(--ui-text-muted)] max-w-[280px]">
              支持直接执行 Shell 命令、切换目录 (
              <code className="text-[var(--ui-accent-emerald)]">cd</code>) 并实时同步
              Agent 的{" "}
              <code className="text-[var(--ui-accent-emerald)]">run_command</code>{" "}
              输出。
            </div>
          </div>
        ) : (
          mergedEntries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden"
            >
              <div className="px-3 py-1.5 bg-[var(--ui-card-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {entry.source === "agent" ? (
                    <span className="px-1.5 py-0.5 rounded bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] text-[10px] font-sans font-medium flex items-center gap-1 flex-shrink-0">
                      <Bot size={10} />
                      Agent
                    </span>
                  ) : (
                    <span className="text-[var(--ui-accent-emerald)] font-bold flex-shrink-0">
                      ❯
                    </span>
                  )}
                  <span className="text-xs font-semibold text-[var(--ui-text-primary)] truncate">
                    {entry.command}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {entry.output && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(entry.output);
                        setCopiedId(entry.id);
                        setTimeout(() => setCopiedId(null), 1200);
                      }}
                      className="p-1 rounded hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)]"
                      title="复制输出"
                    >
                      {copiedId === entry.id ? (
                        <Check size={11} className="text-[var(--ui-accent-emerald)]" />
                      ) : (
                        <Copy size={11} />
                      )}
                    </button>
                  )}

                  {entry.status === "running" ? (
                    <span className="flex items-center gap-1 text-[10px] text-[var(--ui-accent-amber)] font-sans">
                      <Loader2 size={11} className="animate-spin" />
                      运行中
                    </span>
                  ) : entry.status === "error" ? (
                    <span className="flex items-center gap-1 text-[10px] text-[var(--ui-accent-rose)] font-sans">
                      <XCircle size={11} />
                      退出码 {entry.exitCode ?? 1}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[10px] text-[var(--ui-accent-emerald)] font-sans">
                      <CheckCircle2 size={11} />
                      完成
                    </span>
                  )}
                </div>
              </div>

              {entry.output ? (
                <pre className="p-3 text-[11.5px] leading-[1.6] text-[var(--ui-text-primary)] whitespace-pre-wrap break-all max-h-[340px] overflow-y-auto custom-scrollbar bg-[var(--ui-code-bg)]">
                  {entry.output}
                </pre>
              ) : entry.status !== "running" ? (
                <div className="px-3 py-2 text-[11px] text-[var(--ui-text-faint)] font-sans">
                  命令已执行完成（该命令未产生标准输出）
                </div>
              ) : null}
            </div>
          ))
        )}
        <div ref={outputEndRef} />
      </div>

      {/* 底部命令行输入框 */}
      <div className="p-2.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-1 text-xs font-mono text-[var(--ui-accent-emerald)] flex-shrink-0">
          <Folder size={12.5} className="text-[var(--ui-text-muted)]" />
          <span className="text-[11px] text-[var(--ui-text-secondary)] max-w-[120px] truncate">
            {(cwd || workDir || "~").split(/[\\/]/).pop() || "~"}
          </span>
          <ChevronRight size={13} />
        </div>

        <input
          ref={inputRef}
          type="text"
          value={inputCmd}
          onChange={(e) => setInputCmd(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={Boolean(runningCmdId)}
          placeholder={
            runningCmdId
              ? "命令正在运行中 (可点击右侧停止)..."
              : "输入 Shell 命令并回车 (支持 cd、↑/↓ 历史、clear)..."
          }
          className="flex-1 h-8 px-2.5 rounded-xl bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-xs font-mono text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-emerald-border)] disabled:opacity-50"
        />

        {runningCmdId ? (
          <button
            onClick={handleKillRunning}
            className="h-8 px-3 rounded-xl bg-[var(--ui-accent-rose-soft)] hover:opacity-90 border border-[color:var(--ui-accent-rose-border)] text-[var(--ui-accent-rose)] text-xs font-medium flex items-center gap-1 transition-all flex-shrink-0 cursor-pointer"
            title="终止当前命令 (Ctrl+C)"
          >
            <Square size={11} className="fill-current" />
            <span>停止</span>
          </button>
        ) : (
          <button
            onClick={() => executeCommand()}
            disabled={!inputCmd.trim()}
            className="h-8 px-3 rounded-xl bg-[var(--ui-accent-emerald-soft)] hover:opacity-90 border border-[color:var(--ui-accent-emerald-border)] disabled:opacity-40 text-[var(--ui-accent-emerald)] text-xs font-medium flex items-center gap-1 transition-all flex-shrink-0 cursor-pointer"
            title="执行命令 (Enter)"
          >
            <Play size={11} className="fill-current" />
            <span>运行</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default IntegratedTerminalView;
