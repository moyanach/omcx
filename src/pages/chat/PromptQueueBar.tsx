import React, { useState } from "react";
import {
  Zap,
  Pencil,
  ArrowUp,
  X,
  Clock,
  ChevronDown,
  ChevronUp,
  Paperclip,
  Trash2,
  CornerDownRight,
} from "lucide-react";
import type { QueuedPrompt } from "@/stores/chatStore";

interface Props {
  queue: QueuedPrompt[];
  onRunNow: (prompt: QueuedPrompt) => void;
  onSteerNow?: (prompt: QueuedPrompt) => void;
  onEdit: (prompt: QueuedPrompt) => void;
  onMoveToTop: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onClearAll: () => void;
}

export const PromptQueueBar: React.FC<Props> = ({
  queue,
  onRunNow,
  onSteerNow,
  onEdit,
  onMoveToTop,
  onRemove,
  onClearAll,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!queue || queue.length === 0) return null;

  return (
    <div className="mx-3.5 mb-2 rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] shadow-lg backdrop-blur-md overflow-hidden transition-all duration-200 select-none">
      {/* 队列头部状态条 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--ui-block-bg)] border-b border-[color:var(--ui-divider-hairline)] text-xs">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-amber-400 font-medium">
            <Clock size={13} className="animate-pulse" />
            <span>任务队列中</span>
          </div>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
            {queue.length} 项待执行
          </span>
          <span className="text-[11px] text-[var(--ui-text-faint)] hidden sm:inline">
            · 当前 Agent 完成后将自动按序接力执行
          </span>
        </div>

        <div className="flex items-center gap-1">
          {queue.length > 1 && (
            <button
              type="button"
              onClick={onClearAll}
              className="px-2 py-0.5 rounded text-[11px] text-[var(--ui-text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors flex items-center gap-1"
              title="清空所有排队任务"
            >
              <Trash2 size={11} />
              <span>清空</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            className="p-1 rounded text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors"
            title={isExpanded ? "收起队列" : "展开队列"}
          >
            {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {/* 展开的排队列表 */}
      {isExpanded && (
        <div className="max-h-48 overflow-y-auto custom-scrollbar divide-y divide-[color:var(--ui-divider-hairline)]">
          {queue.map((item, index) => {
            const hasAttachments = Array.isArray(item.attachments) && item.attachments.length > 0;
            return (
              <div
                key={item.id}
                className="group flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-[var(--ui-block-hover-bg)] transition-colors"
              >
                {/* 序号与内容摘要 */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <span className="font-mono text-[11px] text-[var(--ui-text-faint)] w-4 flex-shrink-0 text-center font-semibold">
                    #{index + 1}
                  </span>
                  <p
                    className="truncate text-[var(--ui-text-primary)] font-normal text-xs leading-relaxed"
                    title={item.content}
                  >
                    {item.content}
                  </p>
                  {hasAttachments && (
                    <span
                      className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)]"
                      title={`包含 ${item.attachments?.length} 个附件`}
                    >
                      <Paperclip size={10} />
                      <span>{item.attachments?.length}</span>
                    </span>
                  )}
                </div>

                {/* 悬浮操作按钮组 */}
                <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  {onSteerNow && (
                    <button
                      type="button"
                      onClick={() => onSteerNow(item)}
                      className="px-2 py-1 rounded-md text-[11px] font-medium text-sky-400 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 flex items-center gap-1 transition-colors cursor-pointer"
                      title="合并追加至当前执行流程（中途补充背景/澄清细节/纠偏，不打断已有进度）"
                    >
                      <CornerDownRight size={11} />
                      <span className="hidden sm:inline">追加</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onRunNow(item)}
                    className="px-2 py-1 rounded-md text-[11px] font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 flex items-center gap-1 transition-colors cursor-pointer"
                    title="立即打断当前执行并优先运行此任务"
                  >
                    <Zap size={11} fill="currentColor" />
                    <span className="hidden sm:inline">立即执行</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onEdit(item)}
                    className="p-1 rounded text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors"
                    title="撤回编辑（移出队列并填入输入框）"
                  >
                    <Pencil size={12} />
                  </button>

                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => onMoveToTop(item.id)}
                      className="p-1 rounded text-[var(--ui-text-muted)] hover:text-amber-400 hover:bg-[var(--ui-chip-hover-bg)] transition-colors"
                      title="置顶（优先执行）"
                    >
                      <ArrowUp size={12} />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className="p-1 rounded text-[var(--ui-text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                    title="移除此任务"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PromptQueueBar;
