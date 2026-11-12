import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy, MessageSquareText } from 'lucide-react';

export interface BtwSelectionPayload {
  text: string;
  messageId?: string;
}

interface Props {
  x: number;
  y: number;
  text: string;
  messageId?: string;
  onClose: () => void;
  onSideChat: (payload: BtwSelectionPayload) => void;
}

const MENU_WIDTH = 208;
const MENU_HEIGHT = 88;
const VIEWPORT_MARGIN = 8;

/**
 * 主会话文本选中后的自定义右键菜单
 * - 纯暗色工业级浮层，替代默认右键菜单
 * - 「旁路会话」把选中内容作为只读引用带入旁路问答抽屉
 */
export const BtwSelectionMenu: React.FC<Props> = ({
  x,
  y,
  text,
  messageId,
  onClose,
  onSideChat,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN)
  );
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(y, window.innerHeight - MENU_HEIGHT - VIEWPORT_MARGIN)
  );

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleDismiss = () => onClose();

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleDismiss);
    window.addEventListener('blur', handleDismiss);
    // 仅响应用户主动滚轮滚动；不能用 scroll 事件，否则流式输出触发的程序化吸底滚动
    // 会持续把右键菜单关掉（用户根本来不及点击）。
    window.addEventListener('wheel', handleDismiss, { capture: true });

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('blur', handleDismiss);
      window.removeEventListener('wheel', handleDismiss, { capture: true });
    };
  }, [onClose]);

  const handleSideChat = () => {
    onSideChat({ text, messageId });
    onClose();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时静默忽略
    }
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      data-testid='btw-selection-menu'
      style={{ position: 'fixed', left, top, width: MENU_WIDTH, zIndex: 9999 }}
      className='rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-popover-bg)] shadow-[var(--ui-popover-shadow)] p-1 select-none'
    >
      <div className='px-2 py-1 text-[9.5px] font-mono text-[var(--ui-text-faint)] truncate'>
        已选中 {text.length} 字符
      </div>

      <button
        type='button'
        data-testid='btw-selection-sidechat'
        onClick={handleSideChat}
        className='w-full h-7 px-2 rounded-lg flex items-center gap-2 text-[11.5px] text-[var(--ui-text-primary)] hover:bg-[var(--ui-accent-sky-soft)] hover:text-[var(--ui-accent-sky)] transition-colors'
        title='把选中内容作为引用，在旁路问答抽屉中提问'
      >
        <MessageSquareText size={12} className='flex-shrink-0' />
        <span className='flex-1 text-left'>旁路会话</span>
        <span className='text-[9.5px] font-mono text-[var(--ui-text-faint)]'>/btw</span>
      </button>

      <button
        type='button'
        data-testid='btw-selection-copy'
        onClick={handleCopy}
        className='w-full h-7 px-2 rounded-lg flex items-center gap-2 text-[11.5px] text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors'
      >
        <Copy size={12} className='flex-shrink-0' />
        <span className='flex-1 text-left'>复制选中内容</span>
      </button>
    </div>,
    document.body
  );
};

export default BtwSelectionMenu;
