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
  Save,
  XCircle,
  X,
} from "lucide-react";

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
  const previewRef = useRef<HTMLDivElement | null>(null);

  const refreshState = useCallback(async () => {
    if (!window.electronAPI?.browserAutoState) return;
    try {
      const state = await window.electronAPI.browserAutoState();
      setOpen(Boolean(state?.open));
      setTitle(state?.title || "");
      setCurrentUrl(state?.url || "");
      setBaselines(Array.isArray(state?.baselines) ? state.baselines : []);
      if (state?.lastError) setError(state.lastError);
    } catch {}
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

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
    try {
      const result = await window.electronAPI.browserAutoOpen(target);
      if (result?.ok) {
        setOpen(true);
        setTitle(result.title || "");
        setCurrentUrl(result.url || target);
        setSnapshot(null);
        await takeSnapshot({ silent: true });
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
      });
      if (result?.ok) {
        setSnapshot(result);
        setOpen(true);
        setTitle(result.title || "");
        setCurrentUrl(result.url || "");
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
      });
      if (result?.ok) {
        setSnapshot(result);
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

  const navigate = async (direction: "back" | "forward") => {
    if (busy) return;
    const fn =
      direction === "back"
        ? window.electronAPI?.browserAutoBack
        : window.electronAPI?.browserAutoForward;
    if (!fn) return;
    setBusy(direction);
    try {
      const result = await fn();
      if (result?.ok) {
        setCurrentUrl(result.url || currentUrl);
        setTitle(result.title || title);
        await takeSnapshot({ silent: true });
      }
    } finally {
      setBusy("");
    }
  };

  const closeBrowser = async () => {
    if (!window.electronAPI?.browserAutoClose) return;
    await window.electronAPI.browserAutoClose();
    setOpen(false);
    setSnapshot(null);
    setTitle("");
    setCurrentUrl("");
    await refreshState();
  };

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
        <div className="flex-1 h-7 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] flex items-center px-2.5 gap-1.5 focus-within:border-[color:var(--ui-accent-blue-border)] transition-colors">
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
            open ? "text-[var(--ui-accent-emerald)]" : "text-[var(--ui-text-faint)]"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${open ? "bg-[var(--ui-accent-emerald)]" : "bg-[var(--ui-text-faint)]"}`} />
          {open ? "自动化会话运行中" : "未启动"}
        </span>
        <span className="text-[10px] font-mono text-[var(--ui-text-muted)] truncate flex-1">
          {title || currentUrl || "内置 Chromium 隐藏窗口 · 仅支持 http/https"}
        </span>
      </div>

      {/* 截图区 */}
      <div ref={previewRef} className="flex-1 min-h-0 overflow-auto custom-scrollbar p-3">
        {snapshot?.dataUrl ? (
          <img
            src={snapshot.dataUrl}
            alt="浏览器自动化截图"
            className="w-full rounded-xl border border-[color:var(--ui-border-hairline)] bg-white"
          />
        ) : (
          <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-2 text-[var(--ui-text-faint)]">
            <Monitor size={28} className="opacity-40" />
            <span className="text-[11px]">
              {open ? "点击下方「截图」获取当前页面" : "输入 URL 打开页面，Agent 也可直接调用 browser_open 工具"}
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

        <div className="w-[1px] h-3.5 bg-[var(--ui-divider-hairline)] mx-0.5" />

        <input
          value={baselineName}
          onChange={(e) => setBaselineName(e.target.value)}
          list="omcx-baseline-list"
          placeholder="基线名称"
          className="h-7 w-28 px-2 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] outline-none"
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
