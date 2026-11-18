import React from "react";
import { ChevronDown, ChevronRight, Loader2, Minus, Plus, Undo2 } from "lucide-react";
import { LANE_COLORS, ROW_HEIGHT, WorkingTreeChanges } from "./graphLayout";

interface UncommittedChangesRowProps {
  graphWidth: number;
  laneX: (lane: number) => number;
  midY: number;
  changesOpen: boolean;
  setChangesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  uncommittedCount: number;
  wtChanges: WorkingTreeChanges;
  opBusy: string;
  commitMsg: string;
  setCommitMsg: React.Dispatch<React.SetStateAction<string>>;
  handleStageAll: () => void;
  handleStageFile: (path: string) => void;
  handleUnstageFile: (path: string) => void;
  handleDiscardFile: (path: string) => void;
  handleCommit: (pushAfter: boolean) => void;
}

export const UncommittedChangesRow: React.FC<UncommittedChangesRowProps> = ({
  graphWidth,
  laneX,
  midY,
  changesOpen,
  setChangesOpen,
  uncommittedCount,
  wtChanges,
  opBusy,
  commitMsg,
  setCommitMsg,
  handleStageAll,
  handleStageFile,
  handleUnstageFile,
  handleDiscardFile,
  handleCommit,
}) => (
          <div className="border-b border-[color:var(--ui-divider-hairline)]/60">
            <div
              onClick={() => setChangesOpen((v) => !v)}
              style={{ height: ROW_HEIGHT }}
              className="flex items-center justify-between px-2 hover:bg-[var(--ui-block-hover-bg)] cursor-pointer text-[11.5px] text-[var(--ui-text-secondary)]"
            >
              <div className="flex items-center min-w-0">
                <svg width={graphWidth} height={ROW_HEIGHT} className="flex-shrink-0">
                  <line
                    x1={laneX(0)}
                    y1={midY + 4}
                    x2={laneX(0)}
                    y2={ROW_HEIGHT}
                    stroke={LANE_COLORS[0]}
                    strokeWidth={1.6}
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={laneX(0)}
                    cy={midY}
                    r={4}
                    fill="var(--ui-stage-bg)"
                    stroke="var(--ui-accent-blue)"
                    strokeWidth={1.6}
                  />
                </svg>
                <span className="truncate font-medium">
                  Uncommitted Changes ({wtChanges.staged.length + wtChanges.unstaged.length || uncommittedCount})
                </span>
                {wtChanges.staged.length > 0 && (
                  <span className="ml-2 px-1.5 py-0 rounded text-[9.5px] font-mono bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]">
                    已暂存 {wtChanges.staged.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 pr-1 text-[10.5px] text-[var(--ui-text-faint)]">
                <span>{changesOpen ? "收起" : "Add / Commit"}</span>
                {changesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </div>
            </div>

            {changesOpen && (
              <div className="px-3 py-2.5 bg-[var(--ui-block-bg)]/80 border-t border-[color:var(--ui-divider-hairline)] space-y-2.5 select-text">
                {wtChanges.staged.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-semibold text-[var(--ui-accent-emerald)] uppercase tracking-wider">
                      已暂存更改 (Staged · {wtChanges.staged.length})
                    </div>
                    <div className="max-h-28 overflow-y-auto custom-scrollbar space-y-0.5">
                      {wtChanges.staged.map((f) => (
                        <div
                          key={`staged-${f.path}`}
                          className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-[var(--ui-block-hover-bg)] text-[11px] font-mono group"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[10px] text-[var(--ui-accent-emerald)] w-3 text-center flex-shrink-0">
                              {f.status}
                            </span>
                            <span className="truncate text-[var(--ui-text-primary)]" title={f.path}>
                              {f.path}
                            </span>
                          </div>
                          <button
                            onClick={() => handleUnstageFile(f.path)}
                            disabled={Boolean(opBusy)}
                            className="p-0.5 rounded text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] flex-shrink-0"
                            title="取消暂存 (Unstage)"
                          >
                            <Minus size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {wtChanges.unstaged.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-[var(--ui-text-muted)] uppercase tracking-wider">
                        未暂存更改 (Unstaged · {wtChanges.unstaged.length})
                      </span>
                      <button
                        onClick={handleStageAll}
                        disabled={Boolean(opBusy)}
                        className="px-2 py-0.5 rounded bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] text-[var(--ui-text-secondary)] flex items-center gap-1"
                      >
                        <Plus size={10} />
                        全部 Add
                      </button>
                    </div>
                    <div className="max-h-28 overflow-y-auto custom-scrollbar space-y-0.5">
                      {wtChanges.unstaged.map((f) => (
                        <div
                          key={`unstaged-${f.path}`}
                          className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-[var(--ui-block-hover-bg)] text-[11px] font-mono group"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[10px] text-amber-400 w-3 text-center flex-shrink-0">
                              {f.status}
                            </span>
                            <span className="truncate text-[var(--ui-text-secondary)]" title={f.path}>
                              {f.path}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => handleDiscardFile(f.path)}
                              disabled={Boolean(opBusy)}
                              className="p-0.5 rounded text-[var(--ui-text-faint)] hover:text-rose-400 hover:bg-rose-500/10"
                              title="丢弃改动 (Discard)"
                            >
                              <Undo2 size={11} />
                            </button>
                            <button
                              onClick={() => handleStageFile(f.path)}
                              disabled={Boolean(opBusy)}
                              className="p-0.5 rounded text-[var(--ui-text-faint)] hover:text-[var(--ui-accent-emerald)] hover:bg-[var(--ui-accent-emerald-soft)]"
                              title="暂存文件 (git add)"
                            >
                              <Plus size={11} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-1.5 pt-1 border-t border-[color:var(--ui-divider-hairline)]">
                  <input
                    type="text"
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleCommit(false);
                      }
                    }}
                    placeholder={
                      wtChanges.staged.length > 0
                        ? "输入 Commit 信息（将提交已暂存文件）..."
                        : "输入 Commit 信息（无已暂存文件时将自动 Add 全部后提交）..."
                    }
                    className="flex-1 min-w-0 h-7 px-2.5 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] outline-none focus:border-[var(--ui-accent-blue-border)]"
                  />
                  <button
                    onClick={() => handleCommit(false)}
                    disabled={!commitMsg.trim() || Boolean(opBusy)}
                    className="h-7 px-2.5 rounded-lg bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[10.5px] font-medium text-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-45 flex items-center gap-1 flex-shrink-0"
                  >
                    {opBusy === "commit" && <Loader2 size={11} className="animate-spin" />}
                    Commit
                  </button>
                  <button
                    onClick={() => handleCommit(true)}
                    disabled={!commitMsg.trim() || Boolean(opBusy)}
                    className="h-7 px-2.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-medium text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] disabled:opacity-45 flex items-center gap-1 flex-shrink-0"
                    title="提交并立即 Push 到远端"
                  >
                    Commit & Push
                  </button>
                </div>
              </div>
            )}
          </div>
);
