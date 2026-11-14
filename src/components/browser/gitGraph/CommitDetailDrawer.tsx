import React from "react";
import { GitCommitHorizontal, Loader2, X } from "lucide-react";
import { CommitDetail } from "./graphLayout";

interface CommitDetailDrawerProps {
  selectedHash: string;
  detail: CommitDetail | null;
  loadingDetail: boolean;
  onClose: () => void;
}

export const CommitDetailDrawer: React.FC<CommitDetailDrawerProps> = ({
  selectedHash,
  detail,
  loadingDetail,
  onClose,
}) => (
        <div className="h-[190px] flex-shrink-0 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] backdrop-blur-md flex flex-col overflow-hidden">
          <div className="px-3 py-1.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-1.5 font-mono text-[var(--ui-text-primary)] min-w-0">
              <GitCommitHorizontal size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
              <span className="truncate font-semibold">{detail?.shortHash || selectedHash.slice(0, 7)}</span>
              {detail?.author && (
                <span className="text-[10.5px] text-[var(--ui-text-muted)] truncate">
                  · {detail.author} · {detail.date}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={onClose}
                className="p-1 rounded text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                title="关闭提交详情"
              >
                <X size={12} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-3 text-[11px] select-text">
            {loadingDetail ? (
              <div className="flex items-center gap-1.5 text-[var(--ui-text-muted)]">
                <Loader2 size={12} className="animate-spin" />
                <span>正在读取提交详情...</span>
              </div>
            ) : detail?.ok ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-[var(--ui-text-primary)]">
                  {detail.subject}
                </div>
                {detail.body && (
                  <pre className="whitespace-pre-wrap text-[11px] text-[var(--ui-text-secondary)] font-sans">
                    {detail.body}
                  </pre>
                )}
                {detail.stat && (
                  <pre className="p-2 rounded-lg bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] whitespace-pre-wrap overflow-x-auto">
                    {detail.stat}
                  </pre>
                )}
              </div>
            ) : (
              <span className="text-rose-400">{detail?.error || "无法加载提交详情"}</span>
            )}
          </div>
        </div>
);
