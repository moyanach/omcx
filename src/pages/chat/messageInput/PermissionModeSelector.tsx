import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { type PermissionMode } from "@/stores/chatStore";
import { PERMISSION_MODE_OPTIONS } from "./constants";

interface PermissionModeSelectorProps {
  permissionMode: PermissionMode;
  onChangePermissionMode: (mode: PermissionMode) => void;
}

export const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  permissionMode,
  onChangePermissionMode,
}) => {
  const permBtnRef = useRef<HTMLButtonElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [permMenuPos, setPermMenuPos] = useState({ left: 24, bottom: 60 });

  const activePermOption =
    PERMISSION_MODE_OPTIONS.find((opt) => opt.id === permissionMode) ||
    PERMISSION_MODE_OPTIONS[1];
  const ActivePermIcon = activePermOption.icon;

  const updatePermMenuPos = () => {
    if (!permBtnRef.current) return;
    const rect = permBtnRef.current.getBoundingClientRect();
    const menuWidth = 340;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    setPermMenuPos({ left, bottom });
  };

  useEffect(() => {
    if (!permMenuOpen) return;
    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (
        permMenuRef.current &&
        !permMenuRef.current.contains(target) &&
        permBtnRef.current &&
        !permBtnRef.current.contains(target)
      ) {
        setPermMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [permMenuOpen]);

  return (
              <div className="relative">
                <button
                  ref={permBtnRef}
                  type="button"
                  onClick={() => {
                    if (!permMenuOpen) updatePermMenuPos();
                    setPermMenuOpen((prev) => !prev);
                  }}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors select-none border cursor-pointer ${activePermOption.badgeClass}`}
                  title={`当前权限模式: ${activePermOption.label} (${activePermOption.sandboxTag})\n${activePermOption.description}\n快捷键: Shift + Tab 切换`}
                >
                  <ActivePermIcon size={13} className="flex-shrink-0" />
                  <span className="font-medium whitespace-nowrap">{activePermOption.shortLabel}</span>
                  <ChevronDown
                    size={11}
                    className={`opacity-75 transition-transform duration-150 ${
                      permMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {permMenuOpen &&
                  typeof document !== "undefined" &&
                  createPortal(
                    <div
                      ref={permMenuRef}
                      className="fixed z-[99999] w-[340px] rounded-xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-2xl backdrop-blur-2xl p-1.5 select-none"
                      style={{
                        left: permMenuPos.left,
                        bottom: permMenuPos.bottom,
                      }}
                    >
                      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[color:var(--ui-divider-hairline)] mb-1">
                        <span className="text-[11px] font-semibold text-[var(--ui-text-secondary)]">
                          Agent 权限与沙箱模式
                        </span>
                        <span className="text-[10px] font-mono text-[var(--ui-text-faint)] bg-[var(--ui-chip-bg)] px-1.5 py-0.5 rounded border border-[color:var(--ui-border-hairline)]">
                          Shift + Tab 切换
                        </span>
                      </div>

                      <div className="flex flex-col gap-0.5">
                        {PERMISSION_MODE_OPTIONS.map((opt) => {
                          const Icon = opt.icon;
                          const isSelected = opt.id === permissionMode;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => {
                                onChangePermissionMode(opt.id);
                                setPermMenuOpen(false);
                              }}
                              className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors flex items-start gap-2.5 cursor-pointer ${
                                isSelected
                                  ? "bg-[var(--ui-block-hover-bg)]"
                                  : "hover:bg-[var(--ui-block-bg)]"
                              }`}
                            >
                              <div className="mt-0.5 flex-shrink-0">
                                <Icon size={14} className={opt.iconClass} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-medium text-[var(--ui-text-primary)]">
                                    {opt.label}
                                  </span>
                                  {opt.recommended && (
                                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)] font-medium">
                                      推荐
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-[var(--ui-text-faint)] ml-auto">
                                    {opt.sandboxTag}
                                  </span>
                                </div>
                                <p className="text-[11px] text-[var(--ui-text-muted)] leading-snug mt-0.5">
                                  {opt.description}
                                </p>
                              </div>
                              <div className="w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">
                                {isSelected && (
                                  <Check size={13} className="text-[var(--ui-accent-blue)]" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>,
                    document.body
                  )}
              </div>
  );
};
