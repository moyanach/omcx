import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

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
}

export const ThemedSelect: React.FC<ThemedSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = '请选择',
  className = '',
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const current = options.find((opt) => opt.value === value);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type='button'
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        className='w-full h-7 px-2 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] hover:border-[color:var(--ui-accent-blue-border)] text-[10.5px] font-mono text-[var(--ui-text-secondary)] flex items-center justify-between gap-1.5 transition-colors outline-none disabled:opacity-50'
      >
        <span className='truncate'>{current?.label || placeholder}</span>
        <ChevronDown
          size={11}
          className={`text-[var(--ui-text-faint)] flex-shrink-0 transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div className='absolute left-0 right-0 top-8 z-50 max-h-48 overflow-y-auto custom-scrollbar py-1 rounded-xl bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)]'>
          {options.length === 0 ? (
            <div className='px-2.5 py-1.5 text-[10px] text-[var(--ui-text-faint)]'>暂无可选项</div>
          ) : (
            options.map((opt) => {
              const selected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type='button'
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
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
      )}
    </div>
  );
};

export default ThemedSelect;
