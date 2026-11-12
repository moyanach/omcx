import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/stores/appStore';
import SettingsView from '@/pages/SettingsView';

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
      className='fixed inset-0 z-[99999] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4 select-none animate-in fade-in duration-150'
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
        className='relative w-full max-w-5xl h-[86vh] max-h-[900px] rounded-2xl overflow-hidden border border-[color:var(--ui-border-subtle)] bg-[var(--ui-panel-bg)] shadow-[0_32px_80px_rgba(0,0,0,0.55)] outline-none animate-in zoom-in-95 duration-150'
      >
        <SettingsView variant='modal' onClose={closeSettings} />
      </div>
    </div>,
    document.body
  );
};

export default SettingsModal;
