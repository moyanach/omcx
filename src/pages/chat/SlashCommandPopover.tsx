import React, { useEffect, useRef } from "react";
import { Terminal, Sparkles, Folder } from "lucide-react";
import type { MentionPosition } from "@/pages/chat/MentionPopover";

export interface SlashCommandItem {
  name: string;
  description: string;
  argumentHint?: string;
  scope: "builtin" | "global" | "project";
  builtin?: boolean;
}

interface Props {
  items: SlashCommandItem[];
  activeIndex: number;
  query: string;
  position: MentionPosition;
  onSelect: (item: SlashCommandItem) => void;
  onHover: (index: number) => void;
}

const SlashCommandPopover: React.FC<Props> = ({
  items,
  activeIndex,
  query,
  position,
  onSelect,
  onHover,
}) => {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: 460,
        maxWidth: "calc(100vw - 16px)",
        transform: position.above ? "translateY(-100%)" : "none",
      }}
      className="z-[100] bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] rounded-xl shadow-[var(--ui-popover-shadow)] overflow-hidden select-none"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-3 py-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-code-header-bg)] flex items-center justify-between">
        <span className="text-[11px] text-[var(--ui-text-muted)] font-semibold tracking-wide">
          斜杠命令 (工作流 / 自定义 Prompt)
        </span>
        <span className="text-[10px] text-[var(--ui-text-faint)] font-mono truncate max-w-[220px]">
          /{query || "全部命令"}
        </span>
      </div>

      <div className="py-1 overflow-y-auto custom-scrollbar" style={{ maxHeight: position.listMaxHeight }}>
        {items.length === 0 ? (
          <div className="px-3 py-6 text-[11px] text-[var(--ui-text-faint)] text-center">
            没有匹配的斜杠命令
          </div>
        ) : (
          items.map((item, index) => {
            const active = index === activeIndex;
            const Icon = item.builtin ? Terminal : item.scope === "project" ? Folder : Sparkles;
            return (
              <button
                key={`${item.scope}:${item.name}`}
                ref={active ? activeRef : null}
                type="button"
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(index)}
                className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                  active ? "bg-[var(--ui-accent-blue-soft)]" : "hover:bg-[var(--ui-block-hover-bg)]"
                }`}
              >
                <Icon
                  size={13}
                  className={`mt-0.5 flex-shrink-0 ${
                    item.builtin
                      ? "text-[var(--ui-accent-emerald)]"
                      : item.scope === "project"
                      ? "text-[var(--ui-accent-emerald)]"
                      : "text-[var(--ui-accent-amber)]"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-mono font-semibold truncate ${
                        active ? "text-[var(--ui-accent-blue)]" : "text-[var(--ui-text-primary)]"
                      }`}
                    >
                      /{item.name}
                    </span>
                    {item.argumentHint && (
                      <span className="text-[10px] text-[var(--ui-text-faint)] font-mono truncate">
                        {item.argumentHint}
                      </span>
                    )}
                    <span
                      className={`ml-auto px-1.5 py-0.2 rounded text-[9px] font-mono uppercase tracking-wide border flex-shrink-0 ${
                        item.scope === "project"
                          ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]"
                          : item.scope === "builtin"
                          ? "bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] border-[color:var(--ui-accent-sky-border)]"
                          : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)]"
                      }`}
                    >
                      {item.scope}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10.5px] text-[var(--ui-text-muted)] leading-relaxed truncate">
                    {item.description || "自定义命令"}
                  </p>
                </div>
              </button>
            );
          })
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-code-header-bg)] flex items-center justify-between text-[10px] text-[var(--ui-text-faint)] font-mono">
        <div className="flex items-center gap-3">
          <span>↑↓ 选择</span>
          <span>Enter 补全</span>
          <span>Esc 关闭</span>
        </div>
        <span>自定义命令: ~/.omcx/commands</span>
      </div>
    </div>
  );
};

export default SlashCommandPopover;
