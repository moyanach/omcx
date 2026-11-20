import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

interface ThemedSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  compact?: boolean;
  align?: 'left' | 'right';
  menuMinWidth?: number;
  prefixIcon?: React.ReactNode;
  zIndexClass?: string;
}

interface MenuCoords {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  listMaxHeight: number;
}

export const ThemedSelect: React.FC<ThemedSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = '请选择',
  className = '',
  disabled = false,
  searchable = false,
  searchPlaceholder = '搜索分支...',
  compact = false,
  align = 'left',
  menuMinWidth = 0,
  prefixIcon,
  zIndexClass = 'z-[100001]',
}) => {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const updateCoords = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const maxAllowedWidth = Math.max(140, vw - margin * 2);
    const width = Math.min(maxAllowedWidth, Math.max(rect.width, menuMinWidth));
    let left = align === 'right' ? rect.right - width : rect.left;
    if (left + width > vw - margin) left = vw - margin - width;
    if (left < margin) left = margin;

    const spaceBelow = Math.max(0, vh - rect.bottom - gap - margin);
    const spaceAbove = Math.max(0, rect.top - gap - margin);
    const placement: 'below' | 'above' =
      spaceBelow < 180 && spaceAbove > spaceBelow ? 'above' : 'below';

    const availableHeight = placement === 'below' ? spaceBelow : spaceAbove;
    const headerReserve = searchable ? 42 : 8;
    const listMaxHeight = Math.max(88, Math.min(240, availableHeight - headerReserve));

    setCoords({
      left,
      width,
      listMaxHeight,
      top: placement === 'below' ? rect.bottom + gap : undefined,
      bottom: placement === 'above' ? vh - rect.top + gap : undefined,
    });
  }, [align, menuMinWidth, searchable]);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      return;
    }
    updateCoords();
    if (searchable) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [open, searchable, updateCoords]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onScrollOrResize = (e: Event) => {
      if (e.type === 'scroll' && menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      updateCoords();
    };

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updateCoords]);

  const current = options.find((opt) => opt.value === value);

  const filteredOptions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q)
    );
  }, [options, searchQuery]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type='button'
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((v) => !v);
        }}
        title={current?.label || placeholder}
        className={
          compact
            ? 'h-6 px-2 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-accent-blue-border)] text-[10px] font-mono text-[var(--ui-accent-blue)] flex items-center justify-between gap-1 transition-colors outline-none disabled:opacity-50 max-w-full'
            : 'w-full h-7 px-2 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-accent-blue-border)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] flex items-center justify-between gap-1.5 transition-colors outline-none disabled:opacity-50'
        }
      >
        <span className='flex items-center gap-1 min-w-0'>
          {prefixIcon && <span className='flex-shrink-0 flex items-center'>{prefixIcon}</span>}
          <span className='truncate'>{current?.label || placeholder}</span>
        </span>
        <ChevronDown
          size={compact ? 10 : 11}
          className={`text-[var(--ui-text-faint)] flex-shrink-0 transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open &&
        coords &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: coords.left,
              top: coords.top,
              bottom: coords.bottom,
              width: coords.width,
            }}
            className={`${zIndexClass} rounded-xl bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] overflow-hidden`}
          >
            {searchable && (
              <div className='p-1.5 border-b border-[color:var(--ui-divider-hairline)]'>
                <div className='relative flex items-center'>
                  <Search
                    size={11}
                    className='absolute left-2 text-[var(--ui-text-faint)] pointer-events-none'
                  />
                  <input
                    ref={searchInputRef}
                    type='text'
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && filteredOptions.length > 0) {
                        e.preventDefault();
                        onChange(filteredOptions[0].value);
                        setOpen(false);
                      }
                    }}
                    placeholder={searchPlaceholder}
                    className='w-full pl-6 pr-6 py-1 rounded-md bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-[10.5px] font-mono text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)] outline-none focus:border-[color:var(--ui-accent-blue-border)]'
                  />
                  {searchQuery && (
                    <button
                      type='button'
                      onClick={() => setSearchQuery('')}
                      className='absolute right-1.5 text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] p-0.5'
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div
              style={{ maxHeight: coords.listMaxHeight }}
              className='overflow-y-auto overscroll-contain custom-scrollbar py-1'
            >
              {filteredOptions.length === 0 ? (
                <div className='px-2.5 py-2 text-[10px] text-[var(--ui-text-faint)] text-center'>
                  {searchQuery ? '未找到匹配分支' : '暂无可选项'}
                </div>
              ) : (
                filteredOptions.map((opt) => {
                  const selected = opt.value === value;
                  return (
                    <button
                      key={opt.value}
                      type='button'
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                      }}
                      title={opt.label}
                      className={`w-full px-2.5 py-1.5 text-left text-[10.5px] font-mono flex items-center justify-between gap-2 transition-colors ${
                        selected
                          ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'
                          : 'text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)]'
                      }`}
                    >
                      <span className='truncate'>{opt.label}</span>
                      {selected && <Check size={11} className='flex-shrink-0' />}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default ThemedSelect;
