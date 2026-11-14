import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface PanelResizeOptions {
  /** 拖拽的是面板的哪一侧边缘：右侧面板拖左缘，左侧面板拖右缘 */
  edge: "left" | "right";
  min: number;
  max: number;
  /** 拖拽开始时的当前宽度 */
  getWidth: () => number;
  /** 首次真正发生位移时调用（可用于退出最大化等一次性动作） */
  onStart?: () => void;
  /** 松手后只提交一次最终宽度 */
  onCommit: (width: number) => void;
}

/**
 * 通用面板宽度拖拽 Hook。
 *
 * 性能约定：
 * - 拖拽过程只通过 rAF 直接写目标元素的 style.width，不触发 React 状态更新；
 * - 松手 / pointercancel / 窗口失焦时才向 store 提交一次最终宽度；
 * - 组件若在拖拽期间因其它状态被动重渲染，可用 isResizingRef + widthRef 保持实时宽度。
 */
export function usePanelResize(options: PanelResizeOptions) {
  const targetRef = useRef<HTMLElement | null>(null);
  const widthRef = useRef<number | null>(null);
  const frameRef = useRef(0);
  const resizingRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !targetRef.current) return;
    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget;
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {}

    const startX = event.clientX;
    const startWidth = optionsRef.current.getWidth();
    let moved = false;
    let finalWidth = startWidth;

    resizingRef.current = true;
    widthRef.current = startWidth;
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const applyWidth = () => {
      frameRef.current = 0;
      const el = targetRef.current;
      if (el && widthRef.current != null) {
        el.style.width = `${widthRef.current}px`;
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return;
      const delta =
        optionsRef.current.edge === "left"
          ? startX - moveEvent.clientX
          : moveEvent.clientX - startX;

      if (!moved) {
        if (Math.abs(delta) < 1) return;
        moved = true;
        optionsRef.current.onStart?.();
      }

      const next = Math.round(
        Math.max(
          optionsRef.current.min,
          Math.min(optionsRef.current.max, startWidth + delta)
        )
      );
      widthRef.current = next;
      finalWidth = next;

      if (!frameRef.current) {
        frameRef.current = requestAnimationFrame(applyWidth);
      }
    };

    const finish = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;

      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }

      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);

      try {
        handle.releasePointerCapture?.(event.pointerId);
      } catch {}

      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      widthRef.current = null;
      setIsDragging(false);

      if (moved) {
        optionsRef.current.onCommit(Math.round(finalWidth));
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  }, []);

  return {
    targetRef,
    onPointerDown,
    widthRef,
    isResizingRef: resizingRef,
    isDragging,
  };
}
