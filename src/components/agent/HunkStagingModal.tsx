import React, { useCallback, useEffect, useState } from "react";
import { X, Loader2, RefreshCw, Trash2 } from "lucide-react";

interface Hunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface Props {
  workDir: string;
  filePath: string;
  onClose: () => void;
  onChanged: () => void;
}

const HunkStagingModal: React.FC<Props> = ({ workDir, filePath, onClose, onChanged }) => {
  const [tab, setTab] = useState<"unstaged" | "staged">("unstaged");
  const [hunks, setHunks] = useState<Hunk[]>([]);
  const [untracked, setUntracked] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState("");

  // Esc 关闭（与其它弹窗交互保持一致）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const load = useCallback(async () => {
    if (!window.electronAPI?.getGitFileHunks) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await window.electronAPI.getGitFileHunks(
        workDir,
        filePath,
        tab === "staged"
      );
      if (!result?.success) {
        setHunks([]);
        setUntracked(false);
        setMessage(result?.error || "读取 Diff 失败");
        return;
      }
      setUntracked(Boolean(result.untracked));
      setHunks(Array.isArray(result.hunks) ? result.hunks : []);
      setSelected(new Set());
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [workDir, filePath, tab]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleHunk = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applySelected = async () => {
    if (!window.electronAPI?.applyGitHunks) return;
    if (selected.size === 0) {
      setMessage("请先勾选要处理的 Hunk");
      return;
    }
    setApplying(true);
    try {
      const result = await window.electronAPI.applyGitHunks(
        workDir,
        filePath,
        [...selected],
        { staged: tab === "staged", reverse: tab === "staged" }
      );
      if (!result?.success) {
        setMessage(result?.error || "应用失败");
        return;
      }
      setMessage(
        tab === "staged"
          ? `已取消暂存 ${result.count} 个 Hunk`
          : `已暂存 ${result.count} 个 Hunk`
      );
      setSelected(new Set());
      onChanged();
      await load();
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setApplying(false);
    }
  };

  const applyWholeFile = async () => {
    if (!window.electronAPI) return;
    setApplying(true);
    try {
      const result =
        tab === "staged"
          ? await window.electronAPI.unstageGitFile(workDir, filePath)
          : await window.electronAPI.stageGitFile(workDir, filePath);
      if (!result?.success) {
        setMessage(result?.error || "操作失败");
        return;
      }
      setMessage(tab === "staged" ? "已取消暂存整个文件" : "已暂存整个文件");
      onChanged();
      await load();
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setApplying(false);
    }
  };

  const discardSelected = async () => {
    if (!window.electronAPI?.discardGitHunks) return;
    if (tab !== "unstaged") {
      setMessage("仅未暂存变更支持丢弃；已暂存变更请先取消暂存");
      return;
    }
    if (selected.size === 0) {
      setMessage("请先勾选要丢弃的 Hunk");
      return;
    }
    const confirmed = window.confirm(
      `确认丢弃选中的 ${selected.size} 个 Hunk？\n\n该操作会直接还原工作区文件内容，无法通过 Git 暂存区恢复。`
    );
    if (!confirmed) return;
    setApplying(true);
    try {
      const result = await window.electronAPI.discardGitHunks(
        workDir,
        filePath,
        [...selected]
      );
      if (!result?.success) {
        setMessage(result?.error || "丢弃失败");
        return;
      }
      setMessage(`已丢弃 ${result.count} 个 Hunk`);
      setSelected(new Set());
      onChanged();
      await load();
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setApplying(false);
    }
  };

  const discardWholeFile = async () => {
    if (!window.electronAPI?.discardGitFile) return;
    const confirmed = window.confirm(
      tab === "staged"
        ? `确认丢弃整个文件的全部变更（含已暂存内容）？\n\n文件将还原到 HEAD 版本。`
        : `确认丢弃整个文件的工作区变更？\n\n文件将还原到暂存区版本。`
    );
    if (!confirmed) return;
    setApplying(true);
    try {
      const result = await window.electronAPI.discardGitFile(
        workDir,
        filePath,
        tab === "staged"
      );
      if (!result?.success) {
        setMessage(result?.error || "丢弃失败");
        return;
      }
      setMessage(result.action === "removed" ? "已删除未跟踪文件" : "已丢弃整个文件的变更");
      onChanged();
      await load();
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setApplying(false);
    }
  };

  const selectAll = () => {
    if (selected.size === hunks.length) setSelected(new Set());
    else setSelected(new Set(hunks.map((h) => h.id)));
  };

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-[860px] max-w-full max-h-[82vh] bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xs font-bold text-[var(--ui-text-primary)]">
              Hunk 级变更暂存
            </h3>
            <p className="text-[11px] text-[var(--ui-text-muted)] font-mono truncate" title={filePath}>
              {filePath}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={load}
              disabled={loading || applying}
              className="p-1.5 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] disabled:opacity-50"
              title="刷新 Diff"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)]"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="px-4 py-2 flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)]">
          <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)] text-[11px]">
            {(["unstaged", "staged"] as const).map((key) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  tab === key
                    ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]"
                    : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                }`}
              >
                {key === "unstaged" ? "未暂存" : "已暂存"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {hunks.length > 0 && (
              <button
                onClick={selectAll}
                className="px-2 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)]"
              >
                {selected.size === hunks.length ? "取消全选" : "全选"}
              </button>
            )}
            <button
              onClick={applyWholeFile}
              disabled={applying}
              className="px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] disabled:opacity-50"
            >
              {tab === "staged" ? "取消暂存整个文件" : "暂存整个文件"}
            </button>
            {hunks.length > 0 && (
              <button
                onClick={discardWholeFile}
                disabled={applying}
                className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-[11px] text-rose-300 disabled:opacity-50 flex items-center gap-1"
                title={tab === "staged" ? "丢弃索引与工作区的全部变更" : "丢弃工作区中该文件的全部变更"}
              >
                <Trash2 size={11} />
                丢弃文件
              </button>
            )}
            <button
              onClick={applySelected}
              disabled={applying || selected.size === 0}
              className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
            >
              {applying ? <Loader2 size={12} className="animate-spin" /> : null}
              {tab === "staged" ? "取消暂存选中 Hunk" : "暂存选中 Hunk"}
            </button>
            {tab === "unstaged" && (
              <button
                onClick={discardSelected}
                disabled={applying || selected.size === 0}
                className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
                title="丢弃选中的未暂存 Hunk（直接还原工作区）"
              >
                {applying ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={11} />}
                丢弃选中
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-2 bg-[var(--ui-stage-bg)]">
          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-xs text-[var(--ui-text-muted)]">
              <Loader2 size={14} className="animate-spin" /> 正在读取 Diff…
            </div>
          ) : untracked ? (
            <div className="py-12 text-center text-xs text-[var(--ui-text-muted)]">
              未跟踪文件不支持逐 Hunk 暂存，请使用「暂存整个文件」。
            </div>
          ) : hunks.length === 0 ? (
            <div className="py-12 text-center text-xs text-[var(--ui-text-muted)]">
              {message || (tab === "staged" ? "当前没有已暂存变更" : "当前没有未暂存变更")}
            </div>
          ) : (
            hunks.map((hunk, index) => {
              const checked = selected.has(hunk.id);
              return (
                <div
                  key={hunk.id}
                  className={`rounded-xl border overflow-hidden transition-colors ${
                    checked
                      ? "border-blue-500/70 bg-blue-500/5"
                      : "border-[color:var(--ui-border-hairline)] bg-[var(--ui-card-inner-bg)]"
                  }`}
                >
                  <label className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--ui-block-hover-bg)]">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleHunk(hunk.id)}
                      className="accent-blue-600 cursor-pointer"
                    />
                    <span className="text-[11px] font-mono text-[var(--ui-text-secondary)]">
                      Hunk {index + 1}
                    </span>
                    <span className="text-[10px] font-mono text-[var(--ui-text-faint)]">
                      {hunk.header}
                    </span>
                  </label>
                  <pre className="px-2 pb-2 text-[11px] leading-[1.5] font-mono overflow-x-auto max-h-[220px] custom-scrollbar">
                    {hunk.lines.slice(1).map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.startsWith("+")
                            ? "text-emerald-400 bg-emerald-500/10"
                            : line.startsWith("-")
                            ? "text-rose-400 bg-rose-500/10"
                            : "text-[var(--ui-text-muted)]"
                        }
                      >
                        {line || " "}
                      </div>
                    ))}
                  </pre>
                </div>
              );
            })
          )}
        </div>

        {message && (
          <div className="px-4 py-2 border-t border-[color:var(--ui-divider-hairline)] text-[11px] text-[var(--ui-text-secondary)]">
            {message}
          </div>
        )}
      </div>
    </div>
  );
};

export default HunkStagingModal;
