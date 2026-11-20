import React, { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { OmcxMascotIcon, type MascotState } from "@/components/common/OmcxMascotIcon";
import { useAppStore, type MascotPosition } from "@/stores/appStore";
import type { Message } from "@/stores/chatStore";

const MASCOT_WIDTH = 38;
const MASCOT_HEIGHT = 30;
const EDGE_MARGIN = 8;
const DEFAULT_RIGHT = 22;

export interface ChatMascotProps {
  containerRef: React.RefObject<HTMLDivElement>;
  inputAnchorRef: React.RefObject<HTMLDivElement>;
  mode: "code" | "work";
  sessionId: string | null;
  isGenerating: boolean;
  messages: Message[];
  toolCalls: any[];
  hasPendingAttention: boolean;
  onNotify?: (msg: string, duration?: number) => void;
}

const STATE_LABELS: Record<MascotState, string> = {
  idle: "待命中 · 随时响应指令",
  thinking: "思考推演中…",
  tool: "正在调用工具…",
  streaming: "正在组织回复…",
  attention: "等待你的确认",
  done: "本轮任务已完成",
};

function hasOpenThinkTag(text: string): boolean {
  if (!text) return false;
  const lastOpen = text.lastIndexOf("<think");
  if (lastOpen === -1) return false;
  const lastClose = text.lastIndexOf("</think>");
  return lastClose < lastOpen;
}

function clampPosition(
  pos: MascotPosition,
  containerWidth: number,
  containerHeight: number
): MascotPosition {
  const maxRight = Math.max(EDGE_MARGIN, containerWidth - MASCOT_WIDTH - EDGE_MARGIN);
  const maxBottom = Math.max(EDGE_MARGIN, containerHeight - MASCOT_HEIGHT - EDGE_MARGIN);
  return {
    right: Math.round(Math.min(maxRight, Math.max(EDGE_MARGIN, pos.right))),
    bottom: Math.round(Math.min(maxBottom, Math.max(EDGE_MARGIN, pos.bottom))),
  };
}

export const ChatMascot: React.FC<ChatMascotProps> = ({
  containerRef,
  inputAnchorRef,
  mode,
  sessionId,
  isGenerating,
  messages,
  toolCalls,
  hasPendingAttention,
  onNotify,
}) => {
  const mascotEnabled = useAppStore((s) => s.mascotEnabled);
  const setMascotEnabled = useAppStore((s) => s.setMascotEnabled);
  const mascotPosition = useAppStore((s) => s.mascotPosition);
  const setMascotPosition = useAppStore((s) => s.setMascotPosition);
  const resetMascotPosition = useAppStore((s) => s.resetMascotPosition);

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [inputHeight, setInputHeight] = useState(118);
  const [dragPos, setDragPos] = useState<MascotPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [justDone, setJustDone] = useState(false);

  const prevGeneratingRef = useRef<{ sessionId: string | null; active: boolean }>({
    sessionId,
    active: isGenerating,
  });
  const doneTimerRef = useRef<number | null>(null);
  const bubbleTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    moved: boolean;
    lastPos: MascotPosition | null;
  } | null>(null);

  // 监测对话阶段容器与输入框锚点尺寸变化，保证默认停靠贴合及自由拖拽不越界
  useEffect(() => {
    const containerEl = containerRef.current;
    const inputEl = inputAnchorRef.current;
    if (!containerEl) return;

    const syncSizes = () => {
      setContainerSize({
        width: containerEl.clientWidth,
        height: containerEl.clientHeight,
      });
      if (inputEl) {
        setInputHeight(inputEl.offsetHeight);
      }
    };

    syncSizes();
    const ro = new ResizeObserver(syncSizes);
    ro.observe(containerEl);
    if (inputEl) ro.observe(inputEl);
    return () => ro.disconnect();
  }, [containerRef, inputAnchorRef, mascotEnabled, sessionId]);

  // 监听生成由 true -> false（同会话内）进入短暂完成庆祝态
  useEffect(() => {
    const prev = prevGeneratingRef.current;
    prevGeneratingRef.current = { sessionId, active: isGenerating };

    if (prev.sessionId !== sessionId) {
      if (doneTimerRef.current) {
        window.clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      setJustDone(false);
      return;
    }

    if (isGenerating) {
      if (doneTimerRef.current) {
        window.clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      setJustDone(false);
      return;
    }

    if (prev.active && !isGenerating && messages.length > 0) {
      setJustDone(true);
      if (doneTimerRef.current) window.clearTimeout(doneTimerRef.current);
      doneTimerRef.current = window.setTimeout(() => {
        setJustDone(false);
        doneTimerRef.current = null;
      }, 2500);
    }
  }, [sessionId, isGenerating, messages.length]);

  useEffect(() => {
    return () => {
      if (doneTimerRef.current) window.clearTimeout(doneTimerRef.current);
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
    };
  }, []);

  // 点击外部自动收起状态气泡
  useEffect(() => {
    if (!bubbleOpen) return;
    const handlePointerDownOutside = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setBubbleOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDownOutside);
    return () => window.removeEventListener("pointerdown", handlePointerDownOutside);
  }, [bubbleOpen]);

  // 气泡打开后自动定时收起（未拖动时）
  useEffect(() => {
    if (!bubbleOpen) return;
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = window.setTimeout(() => {
      setBubbleOpen(false);
    }, 4500);
    return () => {
      if (bubbleTimerRef.current) {
        window.clearTimeout(bubbleTimerRef.current);
        bubbleTimerRef.current = null;
      }
    };
  }, [bubbleOpen]);

  // 派生当前吉祥物状态与详情标签
  const runningTool = useMemo(() => {
    if (!Array.isArray(toolCalls)) return null;
    for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
      const step = toolCalls[i];
      if (step && step.status === "running" && step.tool !== "todo_write") {
        return step;
      }
    }
    return null;
  }, [toolCalls]);

  const mascotState: MascotState = useMemo(() => {
    if (hasPendingAttention) return "attention";
    if (isGenerating) {
      if (runningTool) return "tool";
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") return "thinking";
      if (!lastMsg.content && lastMsg.reasoning) return "thinking";
      if (hasOpenThinkTag(lastMsg.content)) return "thinking";
      if (lastMsg.content && lastMsg.content.length > 0) return "streaming";
      return "thinking";
    }
    if (justDone) return "done";
    return "idle";
  }, [hasPendingAttention, isGenerating, runningTool, messages, justDone]);

  const statusText = useMemo(() => {
    if (mascotState === "tool" && runningTool?.tool) {
      return `正在执行 ${runningTool.tool}`;
    }
    return STATE_LABELS[mascotState];
  }, [mascotState, runningTool]);

  if (!mascotEnabled || !sessionId) return null;

  // 计算最终定位（优先拖拽中的临时坐标 -> 已保存的自定义坐标 -> 默认贴合输入框右上角外沿）
  const defaultPos: MascotPosition = {
    right: DEFAULT_RIGHT,
    bottom: Math.max(EDGE_MARGIN, inputHeight - 3),
  };

  const rawPos = dragPos ?? mascotPosition ?? defaultPos;
  const resolvedPos =
    containerSize.width > 0 && containerSize.height > 0
      ? clampPosition(rawPos, containerSize.width, containerSize.height)
      : rawPos;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-mascot-action='true']")) return;

    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startRight: resolvedPos.right,
      startBottom: resolvedPos.bottom,
      moved: false,
      lastPos: null,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;

    if (!drag.moved) {
      drag.moved = true;
      setIsDragging(true);
      setBubbleOpen(false);
    }

    const nextRaw: MascotPosition = {
      right: drag.startRight - dx,
      bottom: drag.startBottom - dy,
    };
    const nextClamped =
      containerSize.width > 0 && containerSize.height > 0
        ? clampPosition(nextRaw, containerSize.width, containerSize.height)
        : nextRaw;
    drag.lastPos = nextClamped;
    setDragPos(nextClamped);
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}

    setIsDragging(false);
    if (!cancelled && drag.moved) {
      if (drag.lastPos) {
        setMascotPosition(drag.lastPos);
      }
    } else if (!cancelled && !drag.moved) {
      setBubbleOpen((prev) => !prev);
    }
    setDragPos(null);
  };

  const handleCloseMascot = (e: React.MouseEvent) => {
    e.stopPropagation();
    setBubbleOpen(false);
    setMascotEnabled(false);
    onNotify?.("已关闭对话状态吉祥物，可在 设置 → 外观 中重新开启", 3200);
  };

  const handleResetPosition = (e: React.MouseEvent) => {
    e.stopPropagation();
    resetMascotPosition();
    setBubbleOpen(false);
    onNotify?.("已复位至输入框右上角", 2000);
  };

  // 根据所处位置决定状态小气泡水平与垂直弹出方向，避免贴边裁切
  const popBelow =
    containerSize.height > 0 && resolvedPos.bottom > containerSize.height - 90;
  const alignLeft =
    containerSize.width > 0 && resolvedPos.right > containerSize.width - 180;

  return (
    <div
      ref={rootRef}
      style={{
        right: `${resolvedPos.right}px`,
        bottom: `${resolvedPos.bottom}px`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => finishDrag(e, false)}
      onPointerCancel={(e) => finishDrag(e, true)}
      title={`${statusText}（可拖拽移动，点击查看状态）`}
      className={`group absolute z-20 select-none touch-none ${
        isDragging ? "cursor-grabbing scale-105" : "cursor-grab"
      } transition-transform duration-150`}
    >
      {/* 悬停浮现的右上角关闭按钮 */}
      <button
        type="button"
        data-mascot-action="true"
        onClick={handleCloseMascot}
        aria-label="关闭对话状态吉祥物"
        title="关闭吉祥物"
        className="absolute -top-1.5 -right-1.5 z-10 w-4 h-4 rounded-full bg-[var(--ui-dropdown-solid-bg)] border border-[color:var(--ui-dropdown-solid-border)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:border-[color:var(--ui-accent-rose-border)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 shadow-sm cursor-pointer"
      >
        <X size={9} strokeWidth={2.5} />
      </button>

      {/* 纯矢量小机器人本体（无多余底框，保证通透不遮挡输入输出） */}
      <div className="px-0.5 pt-0.5 drop-shadow-[0_2px_6px_rgba(0,0,0,0.22)]">
        <OmcxMascotIcon
          mode={mode}
          state={mascotState}
          width={MASCOT_WIDTH}
          height={MASCOT_HEIGHT}
        />
      </div>

      {/* 点击展开的轻量状态气泡 */}
      {bubbleOpen && !isDragging && (
        <div
          data-mascot-action="true"
          onPointerDown={(e) => e.stopPropagation()}
          className={`absolute ${popBelow ? "top-full mt-1.5" : "bottom-full mb-1.5"} ${
            alignLeft ? "left-0" : "right-0"
          } z-30 min-w-[168px] max-w-[240px] px-2.5 py-2 rounded-xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] text-[11px] text-[var(--ui-text-primary)] flex flex-col gap-1.5`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium truncate">{statusText}</span>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1 border-t border-[color:var(--ui-divider-hairline)] text-[10px]">
            {mascotPosition && (
              <button
                type="button"
                data-mascot-action="true"
                onClick={handleResetPosition}
                className="inline-flex items-center gap-1 text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors cursor-pointer"
              >
                <RotateCcw size={10} />
                <span>复位</span>
              </button>
            )}
            <button
              type="button"
              data-mascot-action="true"
              onClick={handleCloseMascot}
              className="text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-rose)] transition-colors cursor-pointer"
            >
              隐藏吉祥物
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
