import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

const SettingsView = lazy(() => import('@/pages/SettingsView'));

/**
 * 覆盖式设置弹出层：
 * - 不切换 activeNavTab，背后的会话视图 / 流式输出保持挂载，关闭后原地继续
 * - Esc、点击遮罩、右上角关闭按钮均可关闭
 */
export const SettingsModal: React.FC = () => {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!settingsOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeSettings();
    };

    // 捕获阶段监听：即使焦点在输入框内，Esc 也能关闭弹层
    window.addEventListener('keydown', handleKeyDown, true);

    // 锁定背景滚动，避免弹层打开时底层列表跟随滚动
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 弹层获得焦点，保证键盘操作（含 Esc）立即可用
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      window.cancelAnimationFrame(frame);
      previouslyFocused?.focus?.();
    };
  }, [settingsOpen, closeSettings]);

  if (!settingsOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-testid='settings-modal-backdrop'
      className='fixed inset-0 z-[99999] bg-[var(--ui-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-4 select-none animate-in fade-in duration-150'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSettings();
      }}
    >
      <div
        ref={panelRef}
        role='dialog'
        aria-modal='true'
        aria-label='系统设置'
        tabIndex={-1}
        data-testid='settings-modal-panel'
        className='relative w-full max-w-5xl h-[86vh] max-h-[900px] rounded-2xl overflow-hidden border border-[color:var(--ui-border-subtle)] bg-[var(--ui-modal-bg)] backdrop-blur-2xl backdrop-saturate-150 shadow-[var(--ui-popover-shadow)] outline-none animate-in zoom-in-95 duration-150'
      >
        <Suspense
          fallback={
            <div className='w-full h-full flex items-center justify-center gap-2 text-xs text-[var(--ui-text-muted)]'>
              <Loader2 size={15} className='animate-spin text-[var(--ui-accent-blue)]' />
              <span>正在加载设置面板...</span>
            </div>
          }
        >
          <SettingsView variant='modal' onClose={closeSettings} />
        </Suspense>
      </div>
    </div>,
    document.body
  );
};

export default SettingsModal;
