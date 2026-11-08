import React, { useEffect, useRef } from "react";
import { FileText, Folder, Sparkles, Network, Bot } from "lucide-react";
import type { UnifiedMentionItem } from "@/lib/fileMention";

export interface MentionPosition {
  top: number;
  left: number;
  above: boolean;
  listMaxHeight: number;
}

interface Props {
  items: UnifiedMentionItem[];
  grouped: {
    subagents?: UnifiedMentionItem[];
    skills: UnifiedMentionItem[];
    mcps: UnifiedMentionItem[];
    files: UnifiedMentionItem[];
  };
  activeIndex: number;
  query: string;
  position: MentionPosition;
  onSelect: (item: UnifiedMentionItem) => void;
  onHover: (index: number) => void;
}

const MentionPopover: React.FC<Props> = ({
  items,
  grouped,
  activeIndex,
  query,
  position,
  onSelect,
  onHover,
}) => {
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (activeBtnRef.current) {
      activeBtnRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const renderItem = (item: UnifiedMentionItem) => {
    const itemIndex = items.findIndex((it) => it.id === item.id);
    const active = itemIndex === activeIndex;

    return (
      <button
        key={item.id}
        ref={active ? activeBtnRef : null}
        type="button"
        onClick={() => onSelect(item)}
        onMouseEnter={() => onHover(itemIndex)}
        className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
          active ? "bg-[var(--ui-accent-blue-soft)]" : "hover:bg-[var(--ui-block-hover-bg)]"
        }`}
      >
        {/* 分类图标 */}
        {item.category === "subagent" && (
          <Bot size={13} className="text-[var(--ui-accent-sky)] flex-shrink-0" />
        )}
        {item.category === "skill" && (
          <Sparkles size={13} className="text-[var(--ui-accent-amber)] flex-shrink-0" />
        )}
        {item.category === "mcp" && (
          <Network size={13} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />
        )}
        {item.category === "file" && (
          item.isDir ? (
            <Folder size={13} className={active ? "text-[var(--ui-accent-blue)]" : "text-[var(--ui-accent-amber)] flex-shrink-0"} />
          ) : (
            <FileText size={13} className={active ? "text-[var(--ui-accent-blue)]" : "text-[var(--ui-text-muted)] flex-shrink-0"} />
          )
        )}

        <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            <span
              className={`text-xs font-medium truncate ${
                active ? "text-[var(--ui-accent-blue)] font-semibold" : "text-[var(--ui-text-primary)]"
              }`}
            >
              {item.title}
              {item.isDir ? "/" : ""}
            </span>

            {/* 来源徽标 (针对 Skills / Subagents) */}
            {(item.category === "skill" || item.category === "subagent") && item.scope && (
              <span
                className={`px-1.5 py-0.2 rounded text-[9px] font-mono uppercase tracking-wide border flex-shrink-0 ${
                  item.scope === "project"
                    ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]"
                    : item.scope === "builtin"
                    ? "bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] border-[color:var(--ui-accent-sky-border)]"
                    : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)]"
                }`}
              >
                {item.scope}
              </span>
            )}
          </div>

          {/* 副标题或路径说明 */}
          {item.subtitle && (
            <span className="text-[10px] text-[var(--ui-text-faint)] truncate max-w-[200px] font-mono">
              {item.subtitle}
            </span>
          )}
        </div>
      </button>
    );
  };

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
      {/* 顶部标题与筛选指示器 */}
      <div className="px-3 py-2 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-code-header-bg)] flex items-center justify-between">
        <span className="text-[11px] text-[var(--ui-text-muted)] font-semibold tracking-wide">
          引用上下文资源 (Skills / MCP / Files)
        </span>
        <span className="text-[10px] text-[var(--ui-text-faint)] font-mono truncate max-w-[220px]">
          @{query || "所有可用资源"}
        </span>
      </div>

      <div className="py-1 overflow-y-auto custom-scrollbar" style={{ maxHeight: position.listMaxHeight }}>
        {items.length === 0 ? (
          <div className="px-3 py-6 text-[11px] text-[var(--ui-text-faint)] text-center">
            没有匹配的技能、连接器或文件
          </div>
        ) : (
          <div className="divide-y ui-divide-hairline">
            {/* 0. 专家子代理组 */}
            {grouped.subagents && grouped.subagents.length > 0 && (
              <div>
                <div className="px-3 py-1 text-[10px] font-bold text-[var(--ui-text-faint)] uppercase tracking-wider bg-[var(--ui-block-bg)] flex items-center gap-1.5">
                  <Bot size={11} className="text-[var(--ui-accent-sky)]" />
                  <span>专家子代理 (Subagents · 亦可由主 Agent 自动判断调用)</span>
                </div>
                {grouped.subagents.map(renderItem)}
              </div>
            )}

            {/* 1. 技能扩展组 */}
            {grouped.skills.length > 0 && (
              <div>
                <div className="px-3 py-1 text-[10px] font-bold text-[var(--ui-text-faint)] uppercase tracking-wider bg-[var(--ui-block-bg)] flex items-center gap-1.5">
                  <Sparkles size={11} className="text-[var(--ui-accent-amber)]" />
                  <span>技能扩展 (Skills)</span>
                </div>
                {grouped.skills.map(renderItem)}
              </div>
            )}

            {/* 2. MCP 外部连接器组 */}
            {grouped.mcps.length > 0 && (
              <div>
                <div className="px-3 py-1 text-[10px] font-bold text-[var(--ui-text-faint)] uppercase tracking-wider bg-[var(--ui-block-bg)] flex items-center gap-1.5">
                  <Network size={11} className="text-[var(--ui-accent-emerald)]" />
                  <span>外部连接器 (MCP Servers)</span>
                </div>
                {grouped.mcps.map(renderItem)}
              </div>
            )}

            {/* 3. 工作空间文件与目录组 */}
            {grouped.files.length > 0 && (
              <div>
                <div className="px-3 py-1 text-[10px] font-bold text-[var(--ui-text-faint)] uppercase tracking-wider bg-[var(--ui-block-bg)] flex items-center gap-1.5">
                  <Folder size={11} className="text-[var(--ui-accent-blue)]" />
                  <span>工作空间文件与目录</span>
                </div>
                {grouped.files.map(renderItem)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部键盘导航提示 */}
      <div className="px-3 py-1.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-code-header-bg)] flex items-center justify-between text-[10px] text-[var(--ui-text-faint)] font-mono">
        <div className="flex items-center gap-3">
          <span>↑↓ 选择</span>
          <span>Enter 补全</span>
          <span>Esc 关闭</span>
        </div>
        <span>支持 @skill: 或 @mcp:</span>
      </div>
    </div>
  );
};

export default MentionPopover;
