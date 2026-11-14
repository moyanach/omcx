import React, { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Monitor,
  RotateCw,
  Square,
  AlertTriangle,
  XCircle,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface OperationLogItem {
  id: string;
  time: number;
  action: string;
  target: string;
  status: "ok" | "warn" | "error";
  detail: string;
  durationMs: number;
}

function formatOpTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

export const BrowserAutomationView: React.FC = () => {
  const { sessions, activeSessionId } = useChatStore(
    useShallow((s) => ({ sessions: s.sessions, activeSessionId: s.activeSessionId }))
  );
  const activeWorkDir = sessions.find((s) => s.id === activeSessionId)?.workDir || "";

  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [liveShot, setLiveShot] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [runningAction, setRunningAction] = useState("");
  const [operationLogs, setOperationLogs] = useState<OperationLogItem[]>([]);
  const [consoleErrorCount, setConsoleErrorCount] = useState(0);
  const [networkErrorCount, setNetworkErrorCount] = useState(0);

  const busyRef = useRef("");
  const liveInFlightRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const refreshState = useCallback(async () => {
    if (!window.electronAPI?.browserAutoState) return;
    try {
      const state = await window.electronAPI.browserAutoState();
      setOpen(Boolean(state?.open));
      setRemoteBusy(Boolean(state?.loading));
      setRunningAction(state?.runningAction || "");
      setTitle(state?.title || "");
      setCurrentUrl(state?.url || "");
      setConsoleErrorCount(Number(state?.consoleErrorCount) || 0);
      setNetworkErrorCount(Number(state?.networkErrorCount) || 0);
      if (Array.isArray(state?.operationLogs)) {
        setOperationLogs(state.operationLogs);
      }
      if (state?.lastError) setError(state.lastError);
    } catch {}
  }, []);

  useEffect(() => {
    refreshState();
    const timer = setInterval(refreshState, 1000);
    return () => clearInterval(timer);
  }, [refreshState]);

  // 会话开启时每 2s 拉取一次低清实时预览，同步展示自动化操作画面
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || liveInFlightRef.current || busyRef.current) return;
      liveInFlightRef.current = true;
      try {
        const result = await window.electronAPI?.browserAutoSnapshot?.({ live: true, settleMs: 0 });
        if (!cancelled && result?.ok && result?.dataUrl) {
          setLiveShot(result.dataUrl);
          if (result.title) setTitle(result.title);
          if (result.url) setCurrentUrl(result.url);
        }
      } catch {
      } finally {
        liveInFlightRef.current = false;
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  const handleOpen = async () => {
    if (!window.electronAPI?.browserAutoOpen || busy) return;
    const target = url.trim();
    if (!target) {
      setError("请输入要打开的 URL");
      return;
    }
    setBusy("open");
    setError("");
    setLiveShot("");
    try {
      const result = await window.electronAPI.browserAutoOpen(target, activeWorkDir || undefined);
      if (result?.ok) {
        setOpen(true);
        setTitle(result.title || "");
        setCurrentUrl(result.url || target);
        if (result.warning) setError(result.warning);
      } else {
        setError(result?.error || "打开失败");
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
      refreshState();
    }
  };

  const navigate = async (direction: "back" | "forward" | "reload") => {
    if (busy) return;
    const fn =
      direction === "back"
        ? window.electronAPI?.browserAutoBack
        : direction === "forward"
        ? window.electronAPI?.browserAutoForward
        : window.electronAPI?.browserAutoReload;
    if (!fn) return;
    setBusy(direction);
    setError("");
    try {
      const result = await fn();
      if (result?.ok) {
        setCurrentUrl(result.url || currentUrl);
        setTitle(result.title || title);
      } else if (result?.error) {
        setError(result.error);
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
      refreshState();
    }
  };

  const handleStopAutomation = async () => {
    if (!window.electronAPI?.browserAutoStop) return;
    try {
      await window.electronAPI.browserAutoStop();
      setBusy("");
      setError("已手动停止当前自动化操作");
      await refreshState();
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  };

  const closeBrowser = async () => {
    if (!window.electronAPI?.browserAutoClose) return;
    await window.electronAPI.browserAutoClose();
    setOpen(false);
    setLiveShot("");
    setTitle("");
    setCurrentUrl("");
    setRunningAction("");
    setError("");
    await refreshState();
  };

  const isRunning = Boolean(busy || remoteBusy || runningAction);
  const newestLogs = [...operationLogs].reverse();

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden bg-[var(--ui-stage-bg)] select-none">
      {/* 顶部控制栏 */}
      <div className="h-10 px-3 flex items-center gap-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] backdrop-blur-md flex-shrink-0">
        <button
          onClick={() => navigate("back")}
          disabled={!open || Boolean(busy)}
          className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] disabled:opacity-40 transition-colors"
          title="后退"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          onClick={() => navigate("forward")}
          disabled={!open || Boolean(busy)}
          className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] disabled:opacity-40 transition-colors"
          title="前进"
        >
          <ArrowRight size={13} />
        </button>
        <button
          onClick={() => navigate("reload")}
          disabled={!open || Boolean(busy)}
          className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] disabled:opacity-40 transition-colors"
          title="刷新"
        >
          <RotateCw size={13} className={busy === "reload" ? "animate-spin" : ""} />
        </button>

        <div className="ui-focus-ring flex-1 h-7 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] flex items-center px-2.5 gap-1.5 focus-within:bg-[var(--ui-input-hover-bg)] transition-colors">
          <Globe size={12} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleOpen();
            }}
            placeholder="输入 http/https 地址，或直接让 Agent 驱动浏览器"
            className="flex-1 bg-transparent outline-none text-[11px] font-mono text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
          />
          {currentUrl && (
            <button
              onClick={() => window.electronAPI?.openExternalUrl?.(currentUrl)}
              className="text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] flex-shrink-0"
              title="在系统浏览器中打开"
            >
              <ExternalLink size={11} />
            </button>
          )}
        </div>

        <button
          onClick={handleOpen}
          disabled={Boolean(busy)}
          className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--ui-accent-sky-soft)] border border-[color:var(--ui-accent-sky-border)] text-[11px] text-[var(--ui-accent-sky)] hover:brightness-110 disabled:opacity-50 transition-all flex-shrink-0"
        >
          {busy === "open" ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />}
          打开
        </button>

        {(open || isRunning) && (
          <button
            onClick={handleStopAutomation}
            className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg bg-rose-500/15 border border-rose-500/35 text-[11px] text-rose-400 hover:bg-rose-500/25 transition-colors flex-shrink-0 font-medium"
            title="立即中止正在执行的浏览器自动化操作"
          >
            <Square size={10} className="fill-current" />
            停止
          </button>
        )}

        {open && (
          <button
            onClick={closeBrowser}
            className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-rose-400 hover:bg-[var(--ui-block-hover-bg)] transition-colors"
            title="关闭自动化浏览器"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* 状态栏 */}
      <div className="px-3 py-1.5 flex items-center gap-2.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex-shrink-0">
        <span
          className={`flex items-center gap-1.5 text-[10.5px] font-mono flex-shrink-0 ${
            isRunning
              ? "text-[var(--ui-accent-sky)]"
              : open
              ? "text-[var(--ui-accent-emerald)]"
              : "text-[var(--ui-text-faint)]"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isRunning
                ? "bg-[var(--ui-accent-sky)] animate-pulse"
                : open
                ? "bg-[var(--ui-accent-emerald)]"
                : "bg-[var(--ui-text-faint)]"
            }`}
          />
          {runningAction
            ? `执行中: ${runningAction}`
            : remoteBusy
            ? "正在加载页面…"
            : open
            ? "自动化就绪"
            : "未启动"}
        </span>

        <span className="text-[10px] font-mono text-[var(--ui-text-muted)] truncate flex-1">
          {title || currentUrl || "内置自动化窗口 · 支持元素探测、控制台/网络捕获与多模态视觉"}
        </span>

        {consoleErrorCount > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 text-[10px] font-mono flex-shrink-0">
            Console {consoleErrorCount}
          </span>
        )}
        {networkErrorCount > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/25 text-[10px] font-mono flex-shrink-0">
            Network {networkErrorCount}
          </span>
        )}
      </div>

      {/* 主体：实时画面 + 自动化操作信息流 */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* 实时画面 */}
        <div className="relative flex-1 min-h-[160px] overflow-auto custom-scrollbar p-3 bg-[var(--ui-app-bg)]/40">
          {liveShot ? (
            <img
              src={liveShot}
              alt="自动化实时画面"
              className="w-full rounded-xl border border-[color:var(--ui-border-subtle)] bg-white shadow-sm"
            />
          ) : (
            <div className="h-full min-h-[160px] flex flex-col items-center justify-center gap-2 text-[var(--ui-text-faint)]">
              {isRunning ? (
                <Loader2 size={24} className="animate-spin text-[var(--ui-accent-sky)]" />
              ) : (
                <Monitor size={26} className="opacity-40" />
              )}
              <span className="text-[11px]">
                {isRunning
                  ? runningAction || "正在执行自动化操作…"
                  : open
                  ? "等待页面渲染画面…"
                  : "Agent 触发浏览器自动化后，这里会实时显示画面与每步操作记录"}
              </span>
            </div>
          )}
        </div>

        {/* 自动化操作信息流 */}
        <div className="h-[190px] flex-shrink-0 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] backdrop-blur-md flex flex-col">
          <div className="px-3 py-1.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-[10.5px] font-mono text-[var(--ui-text-muted)]">
            <span>自动化操作信息 ({operationLogs.length})</span>
            {error && (
              <span className="text-rose-400 truncate max-w-[260px]" title={error}>
                {error}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar px-2.5 py-1.5 space-y-1">
            {newestLogs.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[11px] text-[var(--ui-text-faint)]">
                暂无自动化操作记录
              </div>
            ) : (
              newestLogs.map((item) => (
                <div
                  key={item.id}
                  className="px-2 py-1.5 rounded-lg bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] flex items-start gap-2 text-[11px]"
                >
                  {item.status === "error" ? (
                    <XCircle size={13} className="text-rose-400 flex-shrink-0 mt-0.5" />
                  ) : item.status === "warn" ? (
                    <AlertTriangle size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle2 size={13} className="text-[var(--ui-accent-emerald)] flex-shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 font-mono">
                      <span className="text-[10px] text-[var(--ui-text-faint)]">
                        {formatOpTime(item.time)}
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-[var(--ui-chip-bg)] text-[10px] font-semibold text-[var(--ui-accent-sky)]">
                        {item.action}
                      </span>
                      {item.target && (
                        <span className="text-[10.5px] text-[var(--ui-text-primary)] truncate">
                          {item.target}
                        </span>
                      )}
                      {item.durationMs > 0 && (
                        <span className="ml-auto text-[10px] text-[var(--ui-text-faint)] flex-shrink-0">
                          {item.durationMs}ms
                        </span>
                      )}
                    </div>
                    {item.detail && (
                      <div className="text-[10.5px] text-[var(--ui-text-muted)] truncate mt-0.5">
                        {item.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BrowserAutomationView;
