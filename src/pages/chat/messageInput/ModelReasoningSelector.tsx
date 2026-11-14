import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Brain, Check, ChevronDown, Cpu } from "lucide-react";
import { type ReasoningEffort } from "@/stores/chatStore";
import { REASONING_OPTIONS } from "./constants";

interface ModelReasoningSelectorProps {
  selectedModel?: string;
  chatModels: any[];
  onChangeModel: (modelId: string) => void;
  currentEffortId: ReasoningEffort;
  activeSessionId?: string | null;
  onChangeEffort: (sessionId: string, effort: ReasoningEffort) => void;
  onNotify?: (message: string) => void;
}

export const ModelReasoningSelector: React.FC<ModelReasoningSelectorProps> = ({
  selectedModel,
  chatModels,
  onChangeModel,
  currentEffortId,
  activeSessionId,
  onChangeEffort,
  onNotify,
}) => {
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState({ left: 160, bottom: 60 });

  const currentEffortOption =
    REASONING_OPTIONS.find((opt) => opt.id === currentEffortId) || REASONING_OPTIONS[2];
  const currentModelObj = chatModels?.find((m) => m.id === selectedModel);
  const currentModelName =
    currentModelObj?.name || currentModelObj?.model_id || selectedModel || "选择模型";

  const updateModelMenuPos = () => {
    if (!modelBtnRef.current) return;
    const rect = modelBtnRef.current.getBoundingClientRect();
    const menuWidth = 380;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    setModelMenuPos({ left, bottom });
  };

  useEffect(() => {
    if (!modelMenuOpen) return;
    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(target) &&
        modelBtnRef.current &&
        !modelBtnRef.current.contains(target)
      ) {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [modelMenuOpen]);

  return (
              <div className="relative">
                <button
                  ref={modelBtnRef}
                  type="button"
                  onClick={() => {
                    if (!modelMenuOpen) updateModelMenuPos();
                    setModelMenuOpen((prev) => !prev);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors select-none border border-[color:var(--ui-border-hairline)] bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-primary)] cursor-pointer"
                  title={`当前模型: ${currentModelName}\n推理强度: ${currentEffortOption.label}\n点击配置模型与滑动调节推理强度`}
                >
                  <Cpu size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                  <span className="font-medium truncate max-w-[150px]">{currentModelName}</span>
                  <span className={`px-1.5 py-0.2 rounded text-[10px] font-mono border ${currentEffortOption.bgClass}`}>
                    {currentEffortOption.badge}
                  </span>
                  <ChevronDown
                    size={11}
                    className={`opacity-75 transition-transform duration-150 ${
                      modelMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {modelMenuOpen &&
                  typeof document !== "undefined" &&
                  createPortal(
                    <div
                      ref={modelMenuRef}
                      className="fixed z-[99999] w-[380px] rounded-2xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-2xl backdrop-blur-2xl p-3.5 select-none flex flex-col gap-3"
                      style={{
                        left: modelMenuPos.left,
                        bottom: modelMenuPos.bottom,
                      }}
                    >
                      {/* 1. 推理强度调节头部 */}
                      <div className="flex items-center justify-between pb-2 border-b border-[color:var(--ui-divider-hairline)]">
                        <div className="flex items-center gap-1.5">
                          <Brain size={14} className="text-emerald-400" />
                          <span className="text-xs font-semibold text-[var(--ui-text-primary)]">
                            推理强度调节 (Reasoning)
                          </span>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono border font-medium ${currentEffortOption.bgClass}`}>
                          {currentEffortOption.label}
                        </span>
                      </div>

                      {/* 当前档位说明卡片 */}
                      <div className="p-2.5 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1">
                        <div className="flex items-center justify-between text-xs font-medium">
                          <span className="text-[var(--ui-text-primary)] flex items-center gap-1.5">
                            <currentEffortOption.icon size={13} className={currentEffortOption.colorClass} />
                            <span>{currentEffortOption.shortLabel}</span>
                          </span>
                          {currentEffortOption.recommended && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-medium">
                              推荐档位
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--ui-text-muted)] leading-relaxed">
                          {currentEffortOption.description}
                        </p>
                      </div>

                      {/* 5 档平滑滑动条 */}
                      <div className="flex flex-col gap-2 px-1">
                        <input
                          type="range"
                          min={0}
                          max={4}
                          step={1}
                          value={currentEffortOption.level}
                          onChange={(e) => {
                            const level = Number(e.target.value);
                            const targetOpt =
                              REASONING_OPTIONS.find((opt) => opt.level === level) ||
                              REASONING_OPTIONS[2];
                            if (activeSessionId) {
                              onChangeEffort(activeSessionId, targetOpt.id);
                              onNotify?.(`已动态调整推理强度：${targetOpt.label}`);
                            }
                          }}
                          className="w-full h-1.5 bg-[var(--ui-chip-hover-bg)] rounded-lg appearance-none cursor-pointer accent-emerald-500"
                        />
                        {/* 5 档刻度标签 (点击刻度快速直达) */}
                        <div className="flex justify-between items-center text-[10px] text-[var(--ui-text-faint)] font-mono px-0.5">
                          {REASONING_OPTIONS.map((opt) => {
                            const isCur = opt.id === currentEffortId;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => {
                                  if (activeSessionId) {
                                    onChangeEffort(activeSessionId, opt.id);
                                    onNotify?.(`已动态调整推理强度：${opt.label}`);
                                  }
                                }}
                                className={`transition-all cursor-pointer hover:text-[var(--ui-text-primary)] ${
                                  isCur
                                    ? "text-emerald-400 font-bold scale-110 underline underline-offset-4"
                                    : ""
                                }`}
                                title={opt.description}
                              >
                                {opt.badge}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* 2. 模型切换列表 */}
                      <div className="pt-2 border-t border-[color:var(--ui-divider-hairline)] flex flex-col gap-1.5">
                        <div className="flex items-center justify-between px-0.5">
                          <span className="text-[11px] font-semibold text-[var(--ui-text-secondary)]">
                            切换对话模型 ({chatModels.length})
                          </span>
                        </div>
                        <div className="max-h-[170px] overflow-y-auto custom-scrollbar flex flex-col gap-0.5 pr-0.5">
                          {chatModels.map((m) => {
                            const isSel = m.id === selectedModel;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => {
                                  onChangeModel(m.id);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between cursor-pointer ${
                                  isSel
                                    ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium border border-[color:var(--ui-accent-blue-border)]"
                                    : "text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-bg)] hover:text-[var(--ui-text-primary)]"
                                }`}
                              >
                                <span className="truncate">{m.name || m.model_id}</span>
                                {isSel && (
                                  <Check size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}
              </div>
  );
};
