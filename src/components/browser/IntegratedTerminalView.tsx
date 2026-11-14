import React, { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Terminal as TerminalIcon,
  RotateCcw,
  Trash2,
  Folder,
  Bot,
  ChevronRight,
  Circle,
  ClipboardList,
  Info,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";
import { useChatStore } from "@/stores/chatStore";
import {
  buildTerminalFontFamily,
  getFontSettings,
  subscribeFontSettings,
} from "@/lib/fontSettings";
import {
  TerminalQueryResponder,
  measureCellSize,
  measureScreenSize,
} from "@/lib/terminalQueryResponder";

interface AgentCommandEntry {
  id: string;
  command: string;
  output: string;
  status: "running" | "done" | "error";
}

const TERMINAL_THEME = {
  background: "#0e0e0e",
  foreground: "#e4e4e7",
  cursor: "#34d399",
  cursorAccent: "#0e0e0e",
  selectionBackground: "#334155",
  black: "#18181b",
  red: "#fb7185",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fda4af",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

function stripAnsi(str: string): string {
  if (!str) return "";
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
}

export const IntegratedTerminalView: React.FC = () => {
  const { sessions, activeSessionId, workspaces, toolCallsBySession } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      workspaces: s.workspaces,
      toolCallsBySession: s.toolCallsBySession,
    }))
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || "";

  const [cwd, setCwd] = useState(workDir);
  const [viewMode, setViewMode] = useState<"pty" | "agent">("pty");
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [statusText, setStatusText] = useState("正在启动交互式终端…");
  const [restartKey, setRestartKey] = useState(0);
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const [runtimeStats, setRuntimeStats] = useState({ bytes: 0, firstByteMs: 0 });
  const [copied, setCopied] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string>("");
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const statsRef = useRef({ bytes: 0, firstByteMs: 0, startedAt: 0 });

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

  useEffect(() => {
    if (workDir) setCwd(workDir);
  }, [workDir]);

  const agentEntries = useMemo<AgentCommandEntry[]>(() => {
    if (!activeSessionId) return [];
    const list = toolCallsBySession[activeSessionId] || [];
    return list
      .filter((tc: any) => tc.tool === "run_command")
      .map((tc: any, idx: number) => {
        const cmd =
          typeof tc.args === "object" && tc.args
            ? tc.args.command || JSON.stringify(tc.args)
            : String(tc.args || "");
        let output = "";
        const result = tc.result?.data ?? tc.result;
        if (typeof result === "string") {
          output = stripAnsi(result);
        } else if (result && typeof result === "object") {
          output = stripAnsi(
            [result.stdout, result.stderr, result.output, result.error]
              .filter((part) => typeof part === "string" && part)
              .join("\n") || JSON.stringify(result, null, 2)
          );
        }
        return {
          id: tc.callId || `agent_cmd_${idx}`,
          command: cmd,
          output,
          status:
            tc.status === "running"
              ? "running"
              : result?.success === false || (result?.exitCode && result.exitCode !== 0)
              ? "error"
              : "done",
        };
      });
  }, [activeSessionId, toolCallsBySession]);

  // 诊断计数每秒刷新一次，避免逐字节触发 React 渲染
  useEffect(() => {
    const timer = setInterval(() => {
      const stats = statsRef.current;
      setRuntimeStats({ bytes: stats.bytes, firstByteMs: stats.firstByteMs });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const buildDiagnosticText = () => {
    const stats = statsRef.current;
    const term = termRef.current;
    return [
      "OMCX 终端诊断",
      `时间: ${new Date().toISOString()}`,
      `会话: ${activeSessionId || "-"}`,
      `terminalId: ${ptyIdRef.current || "-"}`,
      `状态: ${status} / ${statusText}`,
      `shell: ${sessionInfo?.shell || "-"}`,
      `pid: ${sessionInfo?.pid ?? "-"}`,
      `cwd: ${sessionInfo?.cwd || cwd || workDir || "-"}`,
      `pty 尺寸: ${sessionInfo?.cols ?? "?"}x${sessionInfo?.rows ?? "?"}`,
      `xterm 尺寸: ${term?.cols ?? "?"}x${term?.rows ?? "?"}`,
      `PATH: ${sessionInfo?.pathHead || "-"}`,
      `已接收字节: ${stats.bytes}`,
      `首帧延迟: ${stats.firstByteMs ? `${stats.firstByteMs}ms` : "未收到数据"}`,
      `运行环境: ${navigator.userAgent}`,
    ].join("\n");
  };

  const copyDiagnostics = async () => {
    const text = buildDiagnosticText();
    // 同时打到 Renderer Log，剪贴板不可用时也能从日志里取到
    console.log(`[OMCX Terminal Diagnostic]\n${text}`);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {}
    if (!ok) {
      // app:// 协议下 navigator.clipboard 可能不可用，退回 execCommand
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand("copy");
        document.body.removeChild(area);
      } catch {}
    }
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    const api = window.electronAPI;
    const container = containerRef.current;
    if (!api?.createTerminalSession || !container) {
      setStatus("error");
      setStatusText("当前环境未暴露 PTY 终端接口");
      return;
    }

    const initialFont = getFontSettings();
    const term = new Terminal({
      fontFamily: buildTerminalFontFamily(initialFont.terminalFamily),
      fontSize: initialFont.terminalFontSize,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 8000,
      theme: TERMINAL_THEME,
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // 原生贴图：yazi / viu / imgcat 等通过 iTerm2 内联图片协议（OSC 1337）或 sixel
    // 输出图片，xterm 本身不认任何图形协议，必须由 addon-image 直接绘制到画布。
    // enableSizeReports 必须关闭：终端像素尺寸统一由 TerminalQueryResponder 应答，
    // 否则同一查询会收到两份回复。
    const imageAddon = new ImageAddon({ enableSizeReports: false });
    term.loadAddon(imageAddon);

    termRef.current = term;
    fitRef.current = fit;

    // TUI 能力探测应答：yazi / lazygit 等启动前会查询终端能力，
    // 无人应答就会一直等到超时，表现为进入备用屏后长时间黑屏
    const responder = new TerminalQueryResponder({
      getCellSize: () => measureCellSize(term),
      getScreenSize: () => measureScreenSize(term),
    });

    let disposed = false;
    let opened = false;
    let offData: (() => void) | null | undefined = null;
    let offExit: (() => void) | null | undefined = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let openFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

    const terminalId = `pty_${activeSessionId || "global"}_${Date.now()}`;
    ptyIdRef.current = terminalId;
    statsRef.current = { bytes: 0, firstByteMs: 0, startedAt: Date.now() };
    setSessionInfo(null);
    setRuntimeStats({ bytes: 0, firstByteMs: 0 });
    setStatus("connecting");
    setStatusText("正在启动交互式终端…");

    const refreshScreen = () => {
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {}
    };

    const syncSize = () => {
      // 隐藏态（display:none）下 fit 会算出 0 行列，必须跳过
      if (container.offsetParent) {
        try {
          fit.fit();
        } catch {}
        try {
          api.resizeTerminalSession?.(terminalId, term.cols, term.rows);
        } catch {}
      }
      refreshScreen();
    };

    const boot = async () => {
      try {
        const result = await api.createTerminalSession({
          terminalId,
          cwd: cwd || workDir || undefined,
          workDir: workDir || undefined,
          cols: Math.max(20, term.cols || 100),
          rows: Math.max(5, term.rows || 28),
        });
        if (disposed) {
          if (result?.success) api.disposeTerminalSession?.(terminalId);
          return;
        }
        if (!result?.success) {
          setStatus("error");
          setStatusText(result?.error || "启动终端失败");
          term.writeln(`\x1b[31m[终端启动失败] ${result?.error || "未知错误"}\x1b[0m`);
          return;
        }
        setSessionInfo(result);
        setStatus("ready");
        setStatusText(`${result.shell || "shell"} · PID ${result.pid || "-"}`);
        requestAnimationFrame(() => {
          if (disposed) return;
          syncSize();
        });
        term.focus();
        // 兜底诊断：创建成功却一直没有输出，说明 PTY 或 shell 侧卡住了
        watchdogTimer = setTimeout(() => {
          if (disposed) return;
          if (statsRef.current.bytes === 0) {
            setStatus("error");
            setStatusText("PTY 未返回数据（点右侧信息按钮复制诊断）");
          }
        }, 3000);
      } catch (err: any) {
        if (disposed) return;
        setStatus("error");
        setStatusText(err?.message || String(err));
        term.writeln(`\x1b[31m[终端启动异常] ${err?.message || err}\x1b[0m`);
      }
    };

    const doOpen = () => {
      if (disposed || opened) return;
      opened = true;
      if (openFallbackTimer) {
        clearTimeout(openFallbackTimer);
        openFallbackTimer = null;
      }
      try {
        term.open(container);
      } catch (err: any) {
        setStatus("error");
        setStatusText(`终端初始化失败: ${err?.message || err}`);
        return;
      }
      inputDisposable = term.onData((data) => {
        api.writeTerminalSession?.(terminalId, data);
      });
      requestAnimationFrame(() => {
        if (disposed) return;
        syncSize();
        boot();
      });
    };

    offData = api.onTerminalPtyData?.((payload: any) => {
      if (!payload || payload.terminalId !== terminalId) return;
      const data = payload.data || "";
      if (data) {
        const stats = statsRef.current;
        stats.bytes += data.length;
        if (!stats.firstByteMs) stats.firstByteMs = Date.now() - stats.startedAt;
      }
      // feed 会剔除 xterm 6.0.0 处理 DECRQM 时会抛异常的序列，并生成终端能力应答
      const { data: output, replies } = responder.feed(data);
      if (output) term.write(output);
      if (replies) api.writeTerminalSession?.(terminalId, replies);
    });
    offExit = api.onTerminalPtyExit?.((payload: any) => {
      if (!payload || payload.terminalId !== terminalId) return;
      setStatus("exited");
      setStatusText(`进程已退出 (code=${payload.exitCode ?? "-"})`);
      term.writeln(
        `\r\n\x1b[90m[进程已退出，退出码 ${payload.exitCode ?? "-"}${
          payload.signal ? `，信号 ${payload.signal}` : ""
        }]\x1b[0m`
      );
    });

    // 字体设置实时生效：重设字体后重新测量并同步 PTY 行列数
    const unsubscribeFonts = subscribeFontSettings((settings) => {
      if (disposed || !opened) return;
      try {
        term.options.fontFamily = buildTerminalFontFamily(settings.terminalFamily);
        term.options.fontSize = settings.terminalFontSize;
        requestAnimationFrame(() => {
          if (disposed) return;
          syncSize();
        });
      } catch {}
    });

    // 拖拽改变抽屉宽度时 ResizeObserver 会逐帧触发，fit + IPC 开销较大，做 120ms 防抖
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      // 容器可能一开始没有尺寸（抽屉动画 / 隐藏 Tab）：先等尺寸再 open，
      // 否则 xterm 会按 0 单元格测量，之后容易出现整块空白
      if (!opened) {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) doOpen();
        return;
      }
      // 切到 Agent 子视图时终端容器被隐藏（display:none），此时 fit 会算出 0 行列，必须跳过
      if (!container.offsetParent) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (disposed) return;
        syncSize();
      }, 120);
    });
    observer.observe(container);
    resizeObserverRef.current = observer;

    // 容器一开始就有尺寸时立即 open；否则等 ResizeObserver，最多等 1.2s 后按默认尺寸兜底
    const initialRect = container.getBoundingClientRect();
    if (initialRect.width > 0 && initialRect.height > 0) {
      doOpen();
    } else {
      openFallbackTimer = setTimeout(() => doOpen(), 1200);
    }

    return () => {
      disposed = true;
      responder.reset();
      if (openFallbackTimer) clearTimeout(openFallbackTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      inputDisposable?.dispose();
      unsubscribeFonts();
      offData?.();
      offExit?.();
      observer.disconnect();
      resizeObserverRef.current = null;
      api.disposeTerminalSession?.(terminalId);
      try {
        term.dispose();
      } catch {}
      termRef.current = null;
      fitRef.current = null;
      ptyIdRef.current = "";
    };
  }, [activeSessionId, cwd, workDir, restartKey]);

  // 从 Agent 子视图切回交互终端时重新测量尺寸（隐藏期间 cols/rows 会失效）
  useEffect(() => {
    if (viewMode !== "pty") return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      // 尚未 open（element 未挂载）或容器隐藏时不做测量
      if (!term || !term.element || !fit || !containerRef.current?.offsetParent) return;
      try {
        fit.fit();
        window.electronAPI?.resizeTerminalSession?.(
          ptyIdRef.current,
          term.cols,
          term.rows
        );
        // 隐藏期间（display:none）内容不会重绘，切回来要强制刷新一屏
        term.refresh(0, Math.max(0, term.rows - 1));
        term.focus();
      } catch {}
    });
    return () => cancelAnimationFrame(raf);
  }, [viewMode]);

  const sendQuickCommand = (command: string) => {
    if (!ptyIdRef.current || !termRef.current?.element) return;
    window.electronAPI?.writeTerminalSession?.(ptyIdRef.current, `${command}\r`);
    termRef.current?.focus();
  };

  const shortCwd = useMemo(() => {
    const target = cwd || workDir;
    if (!target) return "~";
    const parts = target.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : target;
  }, [cwd, workDir]);

  return (
    <div className="flex-1 h-full min-h-0 bg-[var(--ui-stage-bg)] flex flex-col overflow-hidden text-[var(--ui-text-primary)]">
      {/* 顶部状态与视图切换栏 */}
      <div className="h-10 px-3 flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex-shrink-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon size={13.5} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />
          {workspaceRoots.length > 1 ? (
            <select
              value={cwd || workDir}
              onChange={(e) => setCwd(e.target.value)}
              className="ui-focus-ring h-6 px-2 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] font-mono text-[var(--ui-text-primary)] outline-none transition-colors focus:bg-[var(--ui-input-hover-bg)]"
              title="切换终端所在的工作空间 Root 目录"
            >
              {workspaceRoots.map((root) => (
                <option key={root.path} value={root.path}>
                  {root.name} ({root.path})
                </option>
              ))}
            </select>
          ) : (
            <span
              className="text-[11px] font-mono text-[var(--ui-text-secondary)] truncate max-w-[220px]"
              title={cwd || workDir}
            >
              {shortCwd}
            </span>
          )}

          <span
            className={`flex items-center gap-1 text-[10px] font-sans ${
              status === "ready"
                ? "text-[var(--ui-accent-emerald)]"
                : status === "error"
                ? "text-[var(--ui-accent-rose)]"
                : "text-[var(--ui-accent-amber)]"
            }`}
            title={
              sessionInfo
                ? `${sessionInfo.shell || "shell"} · ${sessionInfo.cols}x${sessionInfo.rows} · 已接收 ${
                    runtimeStats.bytes
                  } 字节${runtimeStats.firstByteMs ? ` · 首帧 ${runtimeStats.firstByteMs}ms` : ""}`
                : undefined
            }
          >
            <Circle size={7} className="fill-current" />
            {statusText}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)] text-[10px]">
            <button
              onClick={() => setViewMode("pty")}
              className={`px-2 py-0.5 rounded-md transition-colors flex items-center gap-1 ${
                viewMode === "pty"
                  ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              <TerminalIcon size={10} />
              交互终端
            </button>
            <button
              onClick={() => setViewMode("agent")}
              className={`px-2 py-0.5 rounded-md transition-colors flex items-center gap-1 ${
                viewMode === "agent"
                  ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              <Bot size={10} />
              Agent ({agentEntries.length})
            </button>
          </div>

          <button
            onClick={copyDiagnostics}
            className={`p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] transition-colors ${
              copied
                ? "text-[var(--ui-accent-emerald)]"
                : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
            }`}
            title={copied ? "诊断信息已复制" : "复制终端诊断信息（shell / PATH / 尺寸 / 首帧延迟）"}
          >
            <Info size={12.5} />
          </button>
          <button
            onClick={() => setRestartKey((value) => value + 1)}
            className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
            title="重启终端"
          >
            <RotateCcw size={12.5} />
          </button>
          <button
            onClick={() => termRef.current?.clear()}
            className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
            title="清屏"
          >
            <Trash2 size={12.5} />
          </button>
        </div>
      </div>

      {/* 交互终端与 Agent 视图始终保留 DOM，仅切换显示：切到 Agent 不得销毁 PTY 会话 */}
      <div
        className={`flex-1 min-h-0 flex-col ${
          viewMode === "pty" ? "flex" : "hidden"
        }`}
      >
          {/* 快捷命令胶囊栏 */}
          <div className="px-3 py-1.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] flex items-center gap-1.5 overflow-x-auto flex-shrink-0 select-none">
            <span className="text-[10px] text-[var(--ui-text-faint)] mr-0.5 flex-shrink-0">
              快捷命令:
            </span>
            {["ls -la", "git status -sb", "pwd", "git log -n 5 --oneline"].map((preset) => (
              <button
                key={preset}
                onClick={() => sendQuickCommand(preset)}
                className="px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] transition-colors whitespace-nowrap"
              >
                {preset}
              </button>
            ))}
          </div>

          {/* xterm 挂载区 */}
          <div className="flex-1 min-h-0 bg-[var(--ui-terminal-bg)] p-2">
            <div ref={containerRef} className="w-full h-full" />
          </div>

          {/* 底部路径提示 */}
          <div className="px-3 py-1.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center gap-1.5 text-[11px] font-mono text-[var(--ui-text-muted)] flex-shrink-0 select-none">
            <Folder size={12} />
            <span className="truncate">{cwd || workDir || "~"}</span>
            <ChevronRight size={12} />
            <span className="text-[var(--ui-text-faint)]">
              支持 REPL / vim / ssh / Ctrl+C / 窗口自适应
            </span>
          </div>
      </div>

      <div
        className={`flex-1 overflow-y-auto p-3 flex-col gap-2.5 font-mono text-xs custom-scrollbar select-text bg-[var(--ui-terminal-bg)] ${
          viewMode === "agent" ? "flex" : "hidden"
        }`}
      >
          {agentEntries.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-12 select-none">
              <ClipboardList size={28} className="text-[var(--ui-text-faint)] mb-2 opacity-50" />
              <div className="text-xs font-medium text-[var(--ui-text-secondary)] mb-1">
                当前会话还没有 Agent 命令记录
              </div>
              <div className="text-[11px] text-[var(--ui-text-muted)] max-w-[280px]">
                Agent 调用 run_command 时，命令、输出与退出码会实时汇总到这里；日常交互请切换到「交互终端」。
              </div>
            </div>
          ) : (
            agentEntries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] overflow-hidden"
              >
                <div className="px-3 py-1.5 bg-[var(--ui-card-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Bot size={11} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                    <span className="text-xs font-semibold text-[var(--ui-text-primary)] truncate">
                      {entry.command}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-sans ${
                      entry.status === "running"
                        ? "text-[var(--ui-accent-amber)]"
                        : entry.status === "error"
                        ? "text-[var(--ui-accent-rose)]"
                        : "text-[var(--ui-accent-emerald)]"
                    }`}
                  >
                    {entry.status === "running" ? "运行中" : entry.status === "error" ? "失败" : "完成"}
                  </span>
                </div>
                {entry.output ? (
                  <pre className="p-3 text-[11.5px] leading-[1.6] text-[var(--ui-text-primary)] whitespace-pre-wrap break-all max-h-[340px] overflow-y-auto custom-scrollbar bg-[var(--ui-code-bg)]">
                    {entry.output}
                  </pre>
                ) : (
                  <div className="px-3 py-2 text-[11px] text-[var(--ui-text-faint)] font-sans">
                    {entry.status === "running" ? "等待输出…" : "该命令未产生输出"}
                  </div>
                )}
              </div>
            ))
          )}
      </div>
    </div>
  );
};

export default IntegratedTerminalView;
