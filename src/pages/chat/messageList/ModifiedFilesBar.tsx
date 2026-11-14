import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as Diff from 'diff';
import {
  XCircle,
  Edit3,
  Loader2,
  FilePlus2,
  FileDiff,
  Pin,
  X,
} from 'lucide-react';
import { SplitDiffViewer } from '@/components/common/CodeBlock';
import { ToolStatusEvent } from './types';
import { getBaseName } from './ToolSteps';

interface FileModificationItem {
  id: string;
  tool: 'edit_file' | 'write_file';
  filePath: string;
  fileName: string;
  status: 'running' | 'done';
  isError: boolean;
  errorMsg?: string;
  actionLabel: '修改' | '新建' | '覆写' | '写入';
  isNewFile: boolean;
  noSnapshot: boolean;
  oldText: string;
  newText: string;
  addedLines: number;
  removedLines: number;
  occurrenceTag?: string;
}

function countDiffLineStats(oldText: string, newText: string, isNewFile: boolean) {
  if (isNewFile) {
    const lines = newText ? newText.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : 0;
    return { addedLines: lines, removedLines: 0 };
  }
  const changes = Diff.diffLines(oldText || '', newText || '');
  let addedLines = 0;
  let removedLines = 0;
  for (const part of changes) {
    const clean = part.value.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const cnt = clean ? clean.split('\n').length : (part.value ? 1 : 0);
    if (part.added) addedLines += cnt;
    else if (part.removed) removedLines += cnt;
  }
  return { addedLines, removedLines };
}

function extractFileModifications(events: ToolStatusEvent[]): FileModificationItem[] {
  const rawItems: FileModificationItem[] = [];
  const pathCountMap = new Map<string, number>();

  events.forEach((ev, idx) => {
    if (ev.tool !== 'edit_file' && ev.tool !== 'write_file') return;
    const args = ev.args || {};
    const data = ev.result?.data || {};
    const filePath = String(args.path || data.path || '');
    const fileName = getBaseName(filePath) || '未命名文件';
    const isError =
      ev.status === 'done' &&
      (ev.result?.success === false || Boolean(ev.result?.error) || data?.success === false);
    const errorMsg = ev.result?.error || data?.error;

    let actionLabel: FileModificationItem['actionLabel'] = '修改';
    let isNewFile = false;
    let noSnapshot = false;
    let oldText = '';
    let newText = '';

    if (ev.tool === 'edit_file') {
      actionLabel = '修改';
      oldText = String(args.old_string ?? args.oldString ?? '');
      newText = String(args.new_string ?? args.newString ?? '');
    } else {
      newText = String(args.content ?? '');
      if (data?.action === 'created') {
        actionLabel = '新建';
        isNewFile = true;
      } else if (data?.action === 'modified') {
        actionLabel = '覆写';
        if (typeof data?.originalContent === 'string') {
          oldText = data.originalContent;
        } else {
          noSnapshot = true;
        }
      } else {
        actionLabel = '写入';
        isNewFile = true;
      }
    }

    const { addedLines, removedLines } = isError
      ? { addedLines: 0, removedLines: 0 }
      : countDiffLineStats(oldText, newText, isNewFile);

    const key = filePath || fileName;
    pathCountMap.set(key, (pathCountMap.get(key) || 0) + 1);

    rawItems.push({
      id: ev.callId || `mod_${idx}`,
      tool: ev.tool,
      filePath,
      fileName,
      status: ev.status,
      isError,
      errorMsg: errorMsg ? String(errorMsg) : undefined,
      actionLabel,
      isNewFile,
      noSnapshot,
      oldText,
      newText,
      addedLines,
      removedLines,
    });
  });

  // 同一个文件有多次局部修改时，标注 #1 / #2 便于分辨每一处变更
  const seenIndex = new Map<string, number>();
  return rawItems.map((item) => {
    const key = item.filePath || item.fileName;
    const total = pathCountMap.get(key) || 1;
    if (total <= 1) return item;
    const seq = (seenIndex.get(key) || 0) + 1;
    seenIndex.set(key, seq);
    return { ...item, occurrenceTag: `#${seq}` };
  });
}

interface PopoverCoords {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxBodyHeight: number;
  placement: 'above' | 'below';
  arrowLeft: number;
}

function computeAnchoredPopoverCoords(anchorEl: HTMLElement): PopoverCoords | null {
  const rect = anchorEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 14;
  const gap = 7;

  const width = Math.min(820, Math.max(460, vw - margin * 2));
  const spaceAbove = rect.top - margin - gap;
  const spaceBelow = vh - rect.bottom - margin - gap;
  const placement: 'above' | 'below' =
    spaceAbove >= 320 || spaceAbove >= spaceBelow ? 'above' : 'below';

  const availableVertical = placement === 'above' ? spaceAbove : spaceBelow;
  // 扣除弹出层头部/列头大约 82px，确保整体不溢出视口
  const totalHeightBudget = Math.max(200, Math.min(480, availableVertical));
  const maxBodyHeight = Math.max(120, totalHeightBudget - 82);

  let left = rect.left;
  if (left + width > vw - margin) {
    left = vw - margin - width;
  }
  if (left < margin) {
    left = margin;
  }

  const anchorCenter = rect.left + rect.width / 2;
  const arrowLeft = Math.max(18, Math.min(width - 18, anchorCenter - left));

  if (placement === 'above') {
    return {
      bottom: Math.max(margin, vh - rect.top + gap),
      left,
      width,
      maxBodyHeight,
      placement,
      arrowLeft,
    };
  }

  return {
    top: Math.max(margin, rect.bottom + gap),
    left,
    width,
    maxBodyHeight,
    placement,
    arrowLeft,
  };
}

/**
 * 独立外显的文件变更展示区 + 对应位置吸附悬浮弹出层（左右分块 Diff）
 * - 默认常驻展开可见，不被工具调用折叠列表隐藏
 * - 鼠标悬停在对应文件胶囊上时，吸附在该胶囊上方/下方弹出左右分块差异对比视图
 */
export const ModifiedFilesBar: React.FC<{ events: ToolStatusEvent[] }> = ({ events }) => {
  const modItems = useMemo(() => extractFileModifications(events), [events]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const anchorRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const updateCoordsForId = useCallback((id: string | null) => {
    if (!id) {
      setCoords(null);
      return;
    }
    const el = anchorRefs.current[id];
    if (!el) {
      setCoords(null);
      return;
    }
    const next = computeAnchoredPopoverCoords(el);
    setCoords(next);
  }, []);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  // 滚动或窗口缩放时实时重新吸附定位
  useEffect(() => {
    if (!activeId) return;
    updateCoordsForId(activeId);

    const handleReposition = () => {
      const el = anchorRefs.current[activeId];
      if (!el) {
        setActiveId(null);
        setIsPinned(false);
        return;
      }
      const rect = el.getBoundingClientRect();
      // 锚点滚出可视区域则自动关闭浮层，避免悬空
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setActiveId(null);
        setIsPinned(false);
        return;
      }
      updateCoordsForId(activeId);
    };

    window.addEventListener('scroll', handleReposition, true);
    window.addEventListener('resize', handleReposition);
    return () => {
      window.removeEventListener('scroll', handleReposition, true);
      window.removeEventListener('resize', handleReposition);
    };
  }, [activeId, updateCoordsForId]);

  // 固定模式下支持点击外部或按 Esc 关闭
  useEffect(() => {
    if (!activeId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearTimers();
        setActiveId(null);
        setIsPinned(false);
      }
    };
    const handlePointerDown = (e: MouseEvent) => {
      if (!isPinned) return;
      const target = e.target as Node;
      const insidePopover = popoverRef.current?.contains(target);
      const insideAnchor = Object.values(anchorRefs.current).some((el) => el?.contains(target));
      if (!insidePopover && !insideAnchor) {
        setActiveId(null);
        setIsPinned(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [activeId, isPinned, clearTimers]);

  const handleAnchorEnter = (id: string) => {
    if (isPinned && activeId !== id) return;
    clearTimers();
    if (activeId) {
      setActiveId(id);
      updateCoordsForId(id);
    } else {
      openTimerRef.current = window.setTimeout(() => {
        setActiveId(id);
        updateCoordsForId(id);
      }, 80);
    }
  };

  const handleAnchorLeave = () => {
    if (isPinned) return;
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      setActiveId(null);
    }, 180);
  };

  const handlePopoverEnter = () => {
    clearTimers();
  };

  const handlePopoverLeave = () => {
    if (isPinned) return;
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      setActiveId(null);
    }, 180);
  };

  const handleAnchorClick = (id: string) => {
    clearTimers();
    if (activeId === id && isPinned) {
      setIsPinned(false);
      setActiveId(null);
    } else {
      setActiveId(id);
      setIsPinned(true);
      updateCoordsForId(id);
    }
  };

  if (modItems.length === 0) return null;

  const activeItem = activeId ? modItems.find((m) => m.id === activeId) || null : null;

  return (
    <div className='mb-1.5 w-full max-w-full select-none'>
      <div className='flex items-center gap-2 flex-wrap py-1'>
        <div className='flex items-center gap-1.5 text-xs text-[var(--ui-text-secondary)] flex-shrink-0 mr-0.5'>
          <FileDiff size={13} className='text-[var(--ui-accent-amber)]' />
          <span className='font-semibold'>文件变更</span>
          <span className='text-[10px] font-mono text-[var(--ui-text-faint)]'>({modItems.length})</span>
        </div>

        <div className='flex items-center gap-1.5 flex-wrap flex-1 min-w-0'>
          {modItems.map((item) => {
            const isActive = activeId === item.id;
            const isRunning = item.status === 'running';

            return (
              <button
                key={item.id}
                ref={(el) => {
                  anchorRefs.current[item.id] = el;
                }}
                type='button'
                onMouseEnter={() => handleAnchorEnter(item.id)}
                onMouseLeave={handleAnchorLeave}
                onClick={() => handleAnchorClick(item.id)}
                className={`group/mod inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-all cursor-pointer max-w-[260px] ${
                  item.isError
                    ? 'bg-[var(--ui-accent-rose-soft)] border-[color:var(--ui-accent-rose-border)] text-[var(--ui-accent-rose)]'
                    : isActive
                    ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)]'
                    : 'bg-[var(--ui-chip-bg)] border-[color:var(--ui-border-hairline)] hover:bg-[var(--ui-chip-hover-bg)] hover:border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)]'
                }`}
                title={`${item.filePath || item.fileName} · 悬停或点击对比左右差异`}
              >
                {isRunning ? (
                  <Loader2 size={11} className='text-[var(--ui-accent-blue)] animate-spin flex-shrink-0' />
                ) : item.isError ? (
                  <XCircle size={11} className='text-[var(--ui-accent-rose)] flex-shrink-0' />
                ) : item.isNewFile ? (
                  <FilePlus2 size={11} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
                ) : (
                  <Edit3 size={11} className='text-[var(--ui-accent-amber)] flex-shrink-0' />
                )}

                <span
                  className={`text-[9.5px] px-1 py-0.2 rounded flex-shrink-0 font-medium ${
                    item.isError
                      ? 'bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)]'
                      : item.isNewFile
                      ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]'
                      : 'bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)]'
                  }`}
                >
                  {item.actionLabel}
                </span>

                <span className='truncate'>{item.fileName}</span>

                {item.occurrenceTag && (
                  <span className='text-[9.5px] text-[var(--ui-text-muted)] flex-shrink-0'>
                    {item.occurrenceTag}
                  </span>
                )}

                {!item.isError && !isRunning && (item.addedLines > 0 || item.removedLines > 0) && (
                  <span className='flex items-center gap-1 text-[10px] flex-shrink-0 ml-0.5 font-semibold'>
                    {item.addedLines > 0 && (
                      <span className='text-[var(--ui-accent-emerald)]'>+{item.addedLines}</span>
                    )}
                    {item.removedLines > 0 && (
                      <span className='text-[var(--ui-accent-rose)]'>-{item.removedLines}</span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <span className='hidden sm:inline text-[10px] text-[var(--ui-text-faint)] font-sans flex-shrink-0'>
          悬停对比差异 · 点击固定
        </span>
      </div>

      {/* 对应位置吸附悬浮弹出层：左右分块展示修改差异 */}
      {activeItem &&
        coords &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            onMouseEnter={handlePopoverEnter}
            onMouseLeave={handlePopoverLeave}
            style={{
              position: 'fixed',
              top: coords.top,
              bottom: coords.bottom,
              left: coords.left,
              width: coords.width,
              zIndex: 9999,
            }}
            className='rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 shadow-[var(--ui-popover-shadow)]'
          >
            {/* 位置吸附指示小三角 */}
            <div
              style={{ left: coords.arrowLeft }}
              className={`absolute -translate-x-1/2 w-2.5 h-2.5 rotate-45 border-[color:var(--ui-border-subtle)] pointer-events-none z-10 ${
                coords.placement === 'above'
                  ? '-bottom-1.5 border-r border-b bg-[var(--ui-code-bg)]'
                  : '-top-1.5 border-l border-t bg-[var(--ui-code-header-bg)]'
              }`}
            />

            <div className='rounded-xl overflow-hidden'>
              {/* 弹出层状态控制顶栏（当固定或需要快捷关闭时） */}
              {isPinned && (
                <div className='px-3 py-1 bg-[var(--ui-code-header-bg)] border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-[10.5px] text-[var(--ui-accent-blue)] select-none'>
                  <span className='flex items-center gap-1.5'>
                    <Pin size={11} />
                    <span>对比浮层已固定（按 Esc 或点击外部关闭）</span>
                  </span>
                  <button
                    type='button'
                    onClick={() => {
                      setIsPinned(false);
                      setActiveId(null);
                    }}
                    className='p-0.5 rounded hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors'
                    title='关闭'
                  >
                    <X size={12} />
                  </button>
                </div>
              )}

              {activeItem.isError ? (
                <div className='p-3.5 text-xs text-[var(--ui-accent-rose)] font-mono bg-[var(--ui-code-bg)]'>
                  <div className='font-semibold mb-1'>
                    {activeItem.filePath || activeItem.fileName} 执行失败
                  </div>
                  <div className='opacity-80 whitespace-pre-wrap'>
                    {activeItem.errorMsg || '未知修改错误'}
                  </div>
                </div>
              ) : (
                <SplitDiffViewer
                  oldText={activeItem.oldText}
                  newText={activeItem.newText}
                  filePath={activeItem.filePath || activeItem.fileName}
                  isNewFile={activeItem.isNewFile}
                  noSnapshot={activeItem.noSnapshot}
                  actionLabel={activeItem.actionLabel}
                  embedded
                  maxBodyHeightPx={coords.maxBodyHeight}
                />
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
