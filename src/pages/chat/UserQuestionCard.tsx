import React, { useEffect, useState } from "react";
import { HelpCircle, Check, SkipForward, Send, ChevronLeft, ChevronRight } from "lucide-react";
import type { PendingUserQuestion, UserQuestionItem } from "@/stores/chatStore";

interface UserQuestionCardProps {
  question: PendingUserQuestion;
  onSubmit: (payload: {
    submitted: boolean;
    skipped?: boolean;
    answers: Record<string, any>;
  }) => void;
}

export const UserQuestionCard: React.FC<UserQuestionCardProps> = ({ question, onSubmit }) => {
  const items: UserQuestionItem[] = Array.isArray(question.questions) ? question.questions : [];
  const [activeIdx, setActiveIdx] = useState(0);
  const [singleMap, setSingleMap] = useState<Record<string, string>>({});
  const [multiMap, setMultiMap] = useState<Record<string, string[]>>({});
  const [textMap, setTextMap] = useState<Record<string, string>>({});

  useEffect(() => {
    setActiveIdx(0);
    setSingleMap({});
    setMultiMap({});
    setTextMap({});
  }, [question.id]);

  if (items.length === 0) return null;

  const safeIdx = Math.min(activeIdx, items.length - 1);
  const current = items[safeIdx];
  const hasOptions = Array.isArray(current.options) && current.options.length > 0;
  const effectiveType: "single" | "multi" | "text" =
    current.type === "text" || !hasOptions ? "text" : current.type;

  const isAnswered = (item: UserQuestionItem) => {
    const itemHasOptions = Array.isArray(item.options) && item.options.length > 0;
    const itemType = item.type === "text" || !itemHasOptions ? "text" : item.type;
    const note = (textMap[item.id] || "").trim();
    if (itemType === "text") return Boolean(note);
    if (itemType === "multi") return (multiMap[item.id]?.length || 0) > 0 || Boolean(note);
    return Boolean(singleMap[item.id]) || Boolean(note);
  };

  const buildAnswers = () => {
    const answers: Record<string, any> = {};
    for (const item of items) {
      const itemHasOptions = Array.isArray(item.options) && item.options.length > 0;
      const itemType = item.type === "text" || !itemHasOptions ? "text" : item.type;
      const note = (textMap[item.id] || "").trim();

      if (itemType === "text") {
        if (note) answers[item.id] = note;
      } else if (itemType === "multi") {
        const picked = multiMap[item.id] || [];
        if (picked.length > 0 && note) {
          answers[item.id] = { choices: picked, note };
        } else if (picked.length > 0) {
          answers[item.id] = picked;
        } else if (note) {
          answers[item.id] = { custom: note };
        }
      } else {
        const picked = singleMap[item.id] || "";
        if (picked && note) {
          answers[item.id] = { choice: picked, note };
        } else if (picked) {
          answers[item.id] = picked;
        } else if (note) {
          answers[item.id] = { custom: note };
        }
      }
    }
    return answers;
  };

  const anyAnswered = items.some(isAnswered);

  const toggleMultiOption = (qId: string, label: string) => {
    setMultiMap((prev) => {
      const cur = prev[qId] || [];
      const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
      return { ...prev, [qId]: next };
    });
  };

  const handleSubmit = () => {
    const answers = buildAnswers();
    onSubmit({
      submitted: true,
      skipped: false,
      answers,
    });
  };

  const handleSkip = () => {
    onSubmit({
      submitted: false,
      skipped: true,
      answers: {},
    });
  };

  return (
    <div className="px-3 mb-2 w-full flex-shrink-0">
      <div className="w-full p-3.5 rounded-2xl bg-[var(--ui-composer-bg)] border border-[color:var(--ui-accent-blue)]/35 shadow-sm select-none">
        {/* 头部标题 + 多题导航 */}
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] flex items-center justify-center flex-shrink-0">
              <HelpCircle size={14} />
            </div>
            <span className="text-xs font-semibold text-[var(--ui-text-primary)] truncate">
              {question.title || "需要你的确认"}
            </span>
            {items.length > 1 && (
              <span className="px-1.5 py-0.5 rounded-md bg-[var(--ui-chip-bg)] text-[10px] font-mono text-[var(--ui-text-muted)] flex-shrink-0">
                {safeIdx + 1} / {items.length}
              </span>
            )}
          </div>

          {items.length > 1 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {items.map((item, idx) => {
                const answered = isAnswered(item);
                const active = idx === safeIdx;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveIdx(idx)}
                    className={`h-5 px-1.5 rounded-md text-[10px] font-mono flex items-center gap-1 transition-colors cursor-pointer ${
                      active
                        ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-semibold"
                        : answered
                        ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]"
                        : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)]"
                    }`}
                    title={item.question}
                  >
                    <span>Q{idx + 1}</span>
                    {answered && <Check size={9} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 当前问题正文 */}
        <div className="text-xs font-medium text-[var(--ui-text-primary)] mb-2.5 leading-relaxed select-text">
          {current.question}
          {effectiveType === "multi" && (
            <span className="ml-1.5 text-[10px] font-normal text-[var(--ui-text-faint)]">
              (可多选)
            </span>
          )}
        </div>

        {/* 选项列表 */}
        {effectiveType !== "text" && current.options && current.options.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mb-2.5">
            {current.options.map((opt, oIdx) => {
              const isSelected =
                effectiveType === "multi"
                  ? (multiMap[current.id] || []).includes(opt.label)
                  : singleMap[current.id] === opt.label;
              return (
                <button
                  key={`${current.id}-${oIdx}`}
                  type="button"
                  onClick={() => {
                    if (effectiveType === "multi") {
                      toggleMultiOption(current.id, opt.label);
                    } else {
                      setSingleMap((prev) => ({
                        ...prev,
                        [current.id]: prev[current.id] === opt.label ? "" : opt.label,
                      }));
                    }
                  }}
                  className={`text-left px-2.5 py-2 rounded-xl border transition-all cursor-pointer flex items-start gap-2 ${
                    isSelected
                      ? "bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue)]/60 text-[var(--ui-text-primary)]"
                      : "bg-[var(--ui-input-bg)] hover:bg-[var(--ui-block-hover-bg)] border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)]"
                  }`}
                >
                  <span
                    className={`mt-0.5 w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center border text-[9px] ${
                      effectiveType === "multi" ? "rounded" : "rounded-full"
                    } ${
                      isSelected
                        ? "bg-[var(--ui-accent-blue)] border-[color:var(--ui-accent-blue)] text-white"
                        : "border-[color:var(--ui-border-subtle)] bg-transparent"
                    }`}
                  >
                    {isSelected && <Check size={9} strokeWidth={3} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] font-medium leading-snug break-words">
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div className="text-[10.5px] text-[var(--ui-text-muted)] mt-0.5 leading-snug break-words">
                        {opt.description}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* 文本输入 / 可选自定义补充 */}
        {(effectiveType === "text" || current.allowCustom !== false) && (
          <div className="mb-2.5">
            <input
              type="text"
              value={textMap[current.id] || ""}
              onChange={(e) =>
                setTextMap((prev) => ({
                  ...prev,
                  [current.id]: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (safeIdx < items.length - 1) {
                    setActiveIdx(safeIdx + 1);
                  } else if (anyAnswered) {
                    handleSubmit();
                  }
                }
              }}
              placeholder={
                current.placeholder ||
                (effectiveType === "text"
                  ? "请输入你的答复..."
                  : "或输入补充说明 / 自定义答案（可选）...")
              }
              className="w-full h-8 px-2.5 rounded-xl bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] focus:border-[color:var(--ui-accent-blue)]/60 text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none transition-colors select-text"
            />
          </div>
        )}

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex items-center gap-1.5">
            {items.length > 1 && (
              <>
                <button
                  type="button"
                  disabled={safeIdx === 0}
                  onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
                  className="px-2 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[11px] text-[var(--ui-text-secondary)] disabled:opacity-40 flex items-center gap-0.5 transition-colors cursor-pointer disabled:cursor-default"
                >
                  <ChevronLeft size={12} />
                  <span>上一题</span>
                </button>
                <button
                  type="button"
                  disabled={safeIdx >= items.length - 1}
                  onClick={() => setActiveIdx((i) => Math.min(items.length - 1, i + 1))}
                  className="px-2 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[11px] text-[var(--ui-text-secondary)] disabled:opacity-40 flex items-center gap-0.5 transition-colors cursor-pointer disabled:cursor-default"
                >
                  <span>下一题</span>
                  <ChevronRight size={12} />
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSkip}
              className="px-2.5 py-1.5 rounded-xl bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-subtle)] text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer"
              title="跳过当前提问，让 Agent 基于最佳实践自行决策"
            >
              <SkipForward size={11.5} />
              <span>跳过 / AI 自定</span>
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!anyAnswered}
              className="px-3 py-1.5 rounded-xl bg-[var(--ui-accent-blue)] hover:brightness-110 disabled:opacity-40 text-white text-[11px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:cursor-not-allowed shadow-sm"
            >
              <Send size={11.5} />
              <span>提交回答</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserQuestionCard;
