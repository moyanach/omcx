import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Camera,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Monitor,
  RefreshCw,
  RotateCw,
  Save,
  XCircle,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface CompareResult {
  match?: boolean;
  diffRatio?: number;
  baselineName?: string;
  baselinePath?: string;
  diffPath?: string;
  note?: string;
  error?: string;
}

interface SnapshotState {
  ok?: boolean;
  shotPath?: string;
  dataUrl?: string;
  url?: string;
  title?: string;
  compare?: CompareResult | null;
  error?: string;
}

export const BrowserAutomationView: React.FC = () => {
  const { sessions, activeSessionId } = useChatStore();
  // 截图与基线跟随当前会话绑定的工作目录落盘到 <workDir>/.omcx/browser-shots/
  const activeWorkDir = sessions.find((s) => s.id === activeSessionId)?.workDir || "";
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null);
  const [fullPage, setFullPage] = useState(false);
  const [baselineName, setBaselineName] = useState("default");
  const [baselines, setBaselines] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [liveShot, setLiveShot] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [busySeconds, setBusySeconds] = useState(0);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef("");
  const liveInFlightRef = useRef(false);
  const liveFailRef = useRef(0);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // 加载/截图计时，既让用户看到进展，也作为前端超时兜底的可视信号
  useEffect(() => {
    if (!busy) {
      setBusySeconds(0);
      return;
    }
    const startedAt = Date.now();
    setBusySeconds(0);
    const timer = setInterval(() => {
      setBusySeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [busy]);

  const refreshState = useCallback(async () => {
    if (!window.electronAPI?.browserAutoState) return;
    try {
      const state = await window.electronAPI.browserAutoState();
      setOpen(Boolean(state?.open));
      setRemoteBusy(Boolean(state?.loading));
      setTitle(state?.title || "");
      setCurrentUrl(state?.url || "");
      const nextBaselines = Array.isArray(state?.baselines) ? state.baselines : [];
      setBaselines((prev) =>
        prev.length === nextBaselines.length && prev.every((name, i) => name === nextBaselines[i])
          ? prev
          : nextBaselines
      );
      if (state?.lastError) setError(state.lastError);
    } catch {}
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  // 未启动时轮询状态，确保 Agent 或其他入口触发的 browser_open 也能被这里感知
  useEffect(() => {
    if (open) return;
    const timer = setInterval(refreshState, 1500);
    return () => clearInterval(timer);
  }, [open, refreshState]);

  // 打开后默认每 2s 拉一张低清预览，页面变化能实时看到；切走标签页自动停止
  useEffect(() => {
    if (!open || !autoRefresh) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || liveInFlightRef.current || busyRef.current) return;
      liveInFlightRef.current = true;
      try {
        const result = await window.electronAPI?.browserAutoSnapshot?.({ live: true, settleMs: 0 });
        if (!cancelled && result?.ok && result?.dataUrl) {
          liveFailRef.current = 0;
          setError("");
          setLiveShot(result.dataUrl);
          setTitle((prev) => (result.title && result.title !== prev ? result.title : prev));
          setCurrentUrl((prev) => (result.url && result.url !== prev ? result.url : prev));
        } else if (!cancelled) {
          // 连续失败通常意味着窗口被 Agent/其他入口关闭，回到状态轮询
          liveFailRef.current += 1;
          if (liveFailRef.current >= 3) {
            liveFailRef.current = 0;
            refreshState();
          }
        }
      } catch {
        // 预览轮询失败静默处理，避免每 2s 刷一条错误
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
  }, [open, autoRefresh, refreshState]);

  const handleOpen = async () => {
    if (!window.electronAPI?.browserAutoOpen || busy) return;
    const target = url.trim();
    if (!target) {
      setError("请输入要打开的 URL");
      return;
    }
    setBusy("open");
    setError("");
    setNotice("");
    setLiveShot("");
    try {
      const result = await window.electronAPI.browserAutoOpen(target, activeWorkDir || undefined);
      if (result?.ok) {
        setOpen(true);
        setTitle(result.title || "");
        setCurrentUrl(result.url || target);
        setSnapshot(null);
        setLiveShot("");
        if (result.warning) setNotice(result.warning);
        if (!autoRefresh) await takeSnapshot({ silent: true });
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

  const takeSnapshot = async (options: { silent?: boolean } = {}) => {
    if (!window.electronAPI?.browserAutoSnapshot || busy) return;
    setBusy("snapshot");
    if (!options.silent) setError("");
    try {
      const result = await window.electronAPI.browserAutoSnapshot({
        fullPage,
        baseline: "",
        workDir: activeWorkDir || undefined,
      });
      if (result?.ok) {
        setSnapshot(result);
        setLiveShot("");
        setOpen(true);
        setTitle(result.title || "");
        setCurrentUrl(result.url || "");
        if (!options.silent) {
          // 手动截图/对比时暂停自动刷新，避免 2s 后被低清预览覆盖
          setAutoRefresh(false);
          setNotice("已暂停自动刷新，以保留当前高质量截图");
        }
      } else if (!options.silent) {
        setError(result?.error || "截图失败");
      }
    } catch (err: any) {
      if (!options.silent) setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  };

  const saveBaseline = async () => {
    if (!window.electronAPI?.browserAutoSaveBaseline) return;
    setBusy("baseline");
    try {
      const result = await window.electronAPI.browserAutoSaveBaseline({
        name: baselineName || "default",
        shotPath: snapshot?.shotPath,
      });
      if (result?.ok) {
        setNotice(`已保存基线：${result.baselineName}`);
        await refreshState();
      } else {
        setError(result?.error || "保存基线失败");
      }
    } finally {
      setBusy("");
    }
  };

  const compareBaseline = async () => {
    if (!window.electronAPI?.browserAutoSnapshot) return;
    setBusy("compare");
    setError("");
    try {
      const result = await window.electronAPI.browserAutoSnapshot({
        fullPage,
        baseline: baselineName || "default",
        threshold: 0.001,
        workDir: activeWorkDir || undefined,
      });
      if (result?.ok) {
        setSnapshot(result);
        setLiveShot("");
        setAutoRefresh(false);
        setNotice(
          result.compare?.match
            ? `与基线一致（差异 ${((result.compare.diffRatio || 0) * 100).toFixed(3)}%）`
            : result.compare?.error || `存在视觉差异（${((result.compare?.diffRatio || 0) * 100).toFixed(3)}%）`
        );
      } else {
        setError(result?.error || "对比失败");
      }
    } finally {
      setBusy("");
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
        await takeSnapshot({ silent: true });
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

  const closeBrowser = async () => {
    if (!window.electronAPI?.browserAutoClose) return;
    await window.electronAPI.browserAutoClose();
    setOpen(false);
    setSnapshot(null);
    setLiveShot("");
    setTitle("");
    setCurrentUrl("");
    await refreshState();
  };

  const previewSrc = liveShot || snapshot?.dataUrl || "";
  const loadingNow = Boolean(busy) || remoteBusy;

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden bg-[var(--ui-stage-bg)] select-none">
      {/* 地址栏 */}
      <div className="h-10 px-3 flex items-center gap-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] flex-shrink-0">
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
          title="刷新当前页面"
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
            placeholder="输入 http/https 地址，例如 https://example.com"
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
        {open && (
          <button
            onClick={closeBrowser}
            className="p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-red-400 hover:bg-[var(--ui-block-hover-bg)] transition-colors"
            title="关闭自动化浏览器"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* 状态栏 */}
      <div className="px-3 py-1.5 flex items-center gap-3 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex-shrink-0">
        <span
          className={`flex items-center gap-1 text-[10px] font-mono ${
            open
              ? "text-[var(--ui-accent-emerald)]"
              : remoteBusy
              ? "text-[var(--ui-accent-sky)]"
              : "text-[var(--ui-text-faint)]"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              open
                ? "bg-[var(--ui-accent-emerald)]"
                : remoteBusy
                ? "bg-[var(--ui-accent-sky)] animate-pulse"
                : "bg-[var(--ui-text-faint)]"
            }`}
          />
          {remoteBusy ? "正在加载页面…" : open ? "自动化会话运行中" : "未启动"}
        </span>
        <span className="text-[10px] font-mono text-[var(--ui-text-muted)] truncate flex-1">
          {title || currentUrl || "内置 Chromium 隐藏窗口 · 仅支持 http/https"}
        </span>
      </div>

      {/* 截图区 */}
      <div ref={previewRef} className="relative flex-1 min-h-0 overflow-auto custom-scrollbar p-3">
        {previewSrc ? (
          <img
            src={previewSrc}
            alt="浏览器自动化截图"
            className="w-full rounded-xl border border-[color:var(--ui-border-hairline)] bg-white"
          />
        ) : (
          <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-2 text-[var(--ui-text-faint)]">
            {loadingNow ? (
              <Loader2 size={26} className="animate-spin text-[var(--ui-accent-sky)]" />
            ) : (
              <Monitor size={28} className="opacity-40" />
            )}
            <span className="text-[11px]">
              {busy
                ? `正在加载页面… ${busySeconds}s`
                : remoteBusy
                ? "正在加载页面…"
                : open
                ? "正在等待页面渲染，也可点击下方「截图」"
                : "输入 URL 打开页面，Agent 也可直接调用 browser_open 工具"}
            </span>
          </div>
        )}
        {(remoteBusy ||
          busy === "open" ||
          busy === "reload" ||
          busy === "back" ||
          busy === "forward") && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--ui-stage-bg)]/85 backdrop-blur-[2px]">
            <Loader2 size={22} className="animate-spin text-[var(--ui-accent-sky)]" />
            <span className="text-[11px] font-mono text-[var(--ui-text-muted)]">
              {busy ? `正在加载页面… ${busySeconds}s` : "正在加载页面…"}
            </span>
            <span className="text-[10px] text-[var(--ui-text-faint)]">
              最长等待 30s，超时后保留当前页面内容
            </span>
          </div>
        )}
      </div>

      {/* 工具条 */}
      <div className="px-3 py-2 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] flex flex-wrap items-center gap-2 flex-shrink-0">
        <button
          onClick={() => takeSnapshot()}
          disabled={!open || Boolean(busy)}
          className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] disabled:opacity-40 transition-colors"
        >
          {busy === "snapshot" ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
          截图
        </button>
        <label className="flex items-center gap-1.5 text-[10.5px] text-[var(--ui-text-muted)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={fullPage}
            onChange={(e) => setFullPage(e.target.checked)}
            className="accent-sky-500 cursor-pointer"
          />
          整页
        </label>
        <label
          className="flex items-center gap-1.5 text-[10.5px] text-[var(--ui-text-muted)] cursor-pointer select-none"
          title="开启后每 2 秒自动截取一张低清预览，实时观察页面变化"
        >
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="accent-sky-500 cursor-pointer"
          />
          自动刷新
        </label>

        <div className="w-[1px] h-3.5 bg-[var(--ui-divider-hairline)] mx-0.5" />

        <input
          value={baselineName}
          onChange={(e) => setBaselineName(e.target.value)}
          list="omcx-baseline-list"
          placeholder="基线名称"
          className="ui-focus-ring h-7 w-28 px-2 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] outline-none transition-colors focus:bg-[var(--ui-input-hover-bg)]"
        />
        <datalist id="omcx-baseline-list">
          {baselines.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button
          onClick={saveBaseline}
          disabled={!snapshot?.shotPath || Boolean(busy)}
          className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] disabled:opacity-40 transition-colors"
          title="把当前截图保存为视觉基线"
        >
          {busy === "baseline" ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          保存基线
        </button>
        <button
          onClick={compareBaseline}
          disabled={!open || Boolean(busy)}
          className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] disabled:opacity-40 transition-colors"
          title="与同名基线做像素级对比"
        >
          {busy === "compare" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          对比基线
        </button>

        {snapshot?.compare && (
          <span
            className={`ml-auto flex items-center gap-1 text-[10.5px] font-mono ${
              snapshot.compare.match ? "text-[var(--ui-accent-emerald)]" : "text-red-400"
            }`}
          >
            {snapshot.compare.match ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
            {snapshot.compare.error
              ? snapshot.compare.error
              : `${((snapshot.compare.diffRatio || 0) * 100).toFixed(3)}% 差异`}
          </span>
        )}
        {!snapshot?.compare && notice && (
          <span className="ml-auto text-[10.5px] font-mono text-[var(--ui-text-muted)] truncate max-w-[280px]">
            {notice}
          </span>
        )}
      </div>

      {(error || notice) && (
        <div
          className={`px-3 py-1.5 text-[10.5px] font-mono truncate flex-shrink-0 ${
            error ? "text-red-400 bg-red-500/10" : "text-[var(--ui-text-muted)]"
          }`}
          title={error || notice}
        >
          {error || notice}
        </div>
      )}
    </div>
  );
};

export default BrowserAutomationView;
