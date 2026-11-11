import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCheck,
  Copy,
  Loader2,
  MessageSquareText,
  Quote,
  Send,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useChatStore, type BtwThread, type BtwToolStep } from '@/stores/chatStore';
import { useBtwChat } from '@/hooks/useBtwChat';
import MarkdownContent from '@/components/common/MarkdownContent';

const EMPTY_THREADS: BtwThread[] = [];

function summarizeToolArgs(step: BtwToolStep): string {
  const args = step.args || {};
  const value =
    args.path ||
    args.query ||
    args.symbol ||
    args.include ||
    (args.maxChars ? `maxChars=${args.maxChars}` : '');
  if (!value) return '';
  const text = String(value);
  return text.length > 46 ? `${text.slice(0, 46)}…` : text;
}

const ToolStepRow: React.FC<{ step: BtwToolStep }> = ({ step }) => {
  const running = step.status === 'running';
  const failed = step.status === 'done' && step.success === false;
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--ui-block-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] font-mono text-[var(--ui-text-muted)]">
      {running ? (
        <Loader2 size={10} className="text-[var(--ui-accent-blue)] animate-spin flex-shrink-0" />
      ) : failed ? (
        <AlertCircle size={10} className="text-[var(--ui-accent-rose)] flex-shrink-0" />
      ) : (
        <Check size={10} className="text-[var(--ui-accent-emerald)] flex-shrink-0" />
      )}
      <Wrench size={9.5} className="text-[var(--ui-text-faint)] flex-shrink-0" />
      <span className="text-[var(--ui-text-secondary)] flex-shrink-0">{step.tool}</span>
      {summarizeToolArgs(step) && (
        <span className="truncate text-[var(--ui-text-faint)]">{summarizeToolArgs(step)}</span>
      )}
      {failed && step.error && (
        <span className="truncate text-[var(--ui-accent-rose)]" title={step.error}>
          {step.error}
        </span>
      )}
    </div>
  );
};

export const BtwPanel: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const threads = useChatStore(
    (state) => state.btwThreadsBySession[sessionId] || EMPTY_THREADS
  );
  const runningBtwId = useChatStore(
    (state) => state.btwRunningBySession[sessionId] || null
  );
  const clearBtwThreads = useChatStore((state) => state.clearBtwThreads);
  const pendingQuote = useChatStore(
    (state) => state.btwQuoteBySession[sessionId] || null
  );
  const clearBtwQuote = useChatStore((state) => state.clearBtwQuote);
  const { askBtw, cancelBtw } = useBtwChat();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const sendFollowUp = () => {
    const question = draft.trim();
    if (!question || !sessionId) return;
    setDraft('');
    void askBtw(question, { sessionId });
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [threads]);

  const handleCopy = async (thread: BtwThread) => {
    if (!thread.answer) return;
    try {
      await navigator.clipboard.writeText(thread.answer);
      setCopiedId(thread.id);
      window.setTimeout(() => setCopiedId((current) => (current === thread.id ? null : current)), 1400);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  };

  const handleClear = () => {
    if (runningBtwId) cancelBtw(runningBtwId);
    clearBtwThreads(sessionId);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--ui-stage-bg)]">
      <div className="h-10 px-3.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between flex-shrink-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquareText size={13} className="text-[var(--ui-accent-sky)] flex-shrink-0" />
          <span className="text-[11px] font-medium text-[var(--ui-text-primary)]">旁路问答</span>
          <span className="px-1.5 py-0.5 rounded bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] text-[9px] font-medium border border-[color:var(--ui-accent-sky-border)]">
            不写入主会话
          </span>
          {runningBtwId && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--ui-accent-blue)]">
              <Loader2 size={9.5} className="animate-spin" />
              生成中
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {threads.length > 0 && (
            <button
              onClick={handleClear}
              className="h-6 px-1.5 rounded-md flex items-center gap-1 text-[10px] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-rose)] hover:bg-[var(--ui-block-hover-bg)] transition-colors"
              title="清空当前会话的旁路问答"
            >
              <Trash2 size={10.5} />
              清空
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 space-y-4">
        {threads.length === 0 ? (
          <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-8 select-none">
            <div className="w-10 h-10 rounded-xl bg-[var(--ui-accent-sky-soft)] border border-[color:var(--ui-accent-sky-border)] flex items-center justify-center mb-3">
              <MessageSquareText size={18} className="text-[var(--ui-accent-sky)]" />
            </div>
            <div className="text-[12px] font-medium text-[var(--ui-text-secondary)] mb-1.5">
              旁路提问，不打断主任务
            </div>
            <div className="text-[11px] leading-relaxed text-[var(--ui-text-faint)]">
              在下方输入框直接提问，或在主输入框发送{' '}
              <span className="font-mono text-[var(--ui-accent-sky)]">/btw &lt;问题&gt;</span>
              。也可以选中主会话内容后右键「旁路会话」，把选中的片段作为只读引用。回答只会出现在这里，不会写入会话历史。
            </div>
          </div>
        ) : (
          threads.map((thread) => {
            const streaming = thread.status === 'streaming';
            const failed = thread.status === 'error';
            const cancelled = thread.status === 'cancelled';
            return (
              <div key={thread.id} className="space-y-2">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 w-4 h-4 rounded bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] text-[9px] font-bold flex items-center justify-center flex-shrink-0 select-none">
                    Q
                  </span>
                  <div className="text-[12px] leading-relaxed text-[var(--ui-text-primary)] whitespace-pre-wrap break-words select-text flex-1">
                    {thread.question}
                  </div>
                </div>

                {thread.quotedText && (
                  <div
                    data-testid="btw-thread-quote"
                    className="ml-6 rounded-lg border-l-2 border-[color:var(--ui-accent-sky-border)] bg-[var(--ui-accent-sky-soft)] px-2.5 py-1.5"
                  >
                    <div className="flex items-center gap-1 text-[9.5px] text-[var(--ui-accent-sky)] mb-0.5 select-none">
                      <Quote size={9} />
                      引用主会话选中内容
                    </div>
                    <div className="text-[10.5px] leading-relaxed text-[var(--ui-text-muted)] whitespace-pre-wrap break-words line-clamp-4">
                      {thread.quotedText}
                    </div>
                  </div>
                )}

                <div className="ml-6 rounded-xl border border-[color:var(--ui-border-hairline)] bg-[var(--ui-block-bg)] overflow-hidden">
                  {thread.toolSteps.length > 0 && (
                    <div className="px-2.5 pt-2.5 space-y-1.5">
                      {thread.toolSteps.slice(0, 8).map((step) => (
                        <ToolStepRow key={step.id} step={step} />
                      ))}
                      {thread.toolSteps.length > 8 && (
                        <div className="text-[10px] text-[var(--ui-text-faint)] pl-1">
                          其余 {thread.toolSteps.length - 8} 次工具调用已省略
                        </div>
                      )}
                    </div>
                  )}

                  <div className="px-3 py-2.5 min-h-[38px] select-text">
                    {thread.answer ? (
                      <MarkdownContent content={thread.answer} className="text-[12px]" />
                    ) : streaming ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-[var(--ui-text-muted)]">
                        <Loader2 size={11} className="animate-spin text-[var(--ui-accent-blue)]" />
                        正在分析并查证代码…
                      </div>
                    ) : failed ? (
                      <div className="flex items-start gap-1.5 text-[11px] text-[var(--ui-accent-rose)]">
                        <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
                        <span className="break-words">{thread.error || '旁路提问失败'}</span>
                      </div>
                    ) : cancelled ? (
                      <div className="text-[11px] text-[var(--ui-text-faint)]">已停止生成。</div>
                    ) : (
                      <div className="text-[11px] text-[var(--ui-text-faint)]">未返回内容。</div>
                    )}
                    {thread.hitRoundLimit && (
                      <div className="mt-2 text-[10px] text-[var(--ui-accent-amber)]">
                        已达到 20 轮只读工具上限，回答可能不完整。
                      </div>
                    )}
                  </div>

                  <div className="h-8 px-2.5 border-t border-[color:var(--ui-divider-hairline)] flex items-center justify-between text-[10px] text-[var(--ui-text-faint)]">
                    <div className="flex items-center gap-2 font-mono">
                      <span>
                        {thread.status === 'done'
                          ? '完成'
                          : streaming
                          ? '生成中'
                          : cancelled
                          ? '已停止'
                          : '失败'}
                      </span>
                      {thread.usage?.total_tokens ? (
                        <span>
                          {thread.usage.prompt_tokens || 0} → {thread.usage.completion_tokens || 0} tokens
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      {streaming && (
                        <button
                          onClick={() => cancelBtw(thread.id)}
                          className="h-6 px-1.5 rounded-md flex items-center gap-1 hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)] transition-colors"
                          title="停止这条旁路提问"
                        >
                          <Square size={9.5} />
                          停止
                        </button>
                      )}
                      <button
                        onClick={() => handleCopy(thread)}
                        disabled={!thread.answer}
                        className="h-6 px-1.5 rounded-md flex items-center gap-1 hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                        title="复制回答"
                      >
                        {copiedId === thread.id ? (
                          <>
                            <CheckCheck size={10} className="text-[var(--ui-accent-emerald)]" />
                            已复制
                          </>
                        ) : (
                          <>
                            <Copy size={10} />
                            复制
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-3 py-2 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] flex-shrink-0">
        {pendingQuote && (
          <div
            data-testid="btw-quote-card"
            className="mb-2 rounded-lg border border-[color:var(--ui-accent-sky-border)] bg-[var(--ui-accent-sky-soft)] px-2.5 py-1.5"
          >
            <div className="flex items-center justify-between gap-2 select-none">
              <span className="flex items-center gap-1 text-[9.5px] text-[var(--ui-accent-sky)]">
                <Quote size={9} />
                已引用主会话选中内容
              </span>
              <button
                onClick={() => clearBtwQuote(sessionId)}
                className="text-[9.5px] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-rose)] transition-colors"
                title="移除引用"
              >
                移除
              </button>
            </div>
            <div className="mt-0.5 max-h-16 overflow-y-auto custom-scrollbar text-[10.5px] leading-relaxed text-[var(--ui-text-secondary)] whitespace-pre-wrap break-words">
              {pendingQuote.text}
            </div>
          </div>
        )}
        <div className="flex items-end gap-1.5 rounded-xl border border-[color:var(--ui-border-hairline)] bg-[var(--ui-input-bg)] px-2 py-1.5 focus-within:border-[color:var(--ui-accent-sky-border)] transition-colors">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
                e.preventDefault();
                sendFollowUp();
              }
            }}
            rows={1}
            placeholder={
              runningBtwId
                ? '继续提问（发送后将替换当前旁路问题）…'
                : '继续旁路提问…（Enter 发送）'
            }
            className="flex-1 min-h-[20px] max-h-24 py-0.5 bg-transparent outline-none resize-none text-[12px] leading-relaxed text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] custom-scrollbar"
          />
          <button
            onClick={sendFollowUp}
            disabled={!draft.trim()}
            className="w-6 h-6 rounded-lg flex items-center justify-center text-[var(--ui-accent-sky)] hover:bg-[var(--ui-accent-sky-soft)] disabled:opacity-35 disabled:hover:bg-transparent transition-colors flex-shrink-0"
            title="发送旁路提问"
          >
            <Send size={12.5} />
          </button>
        </div>
        <div className="mt-1 px-0.5 flex items-center justify-between text-[9.5px] text-[var(--ui-text-faint)] select-none">
          <span>不写入主会话 · 只读工具最多 20 轮</span>
          <span className="font-mono">Enter 发送 · Shift+Enter 换行</span>
        </div>
      </div>
    </div>
  );
};

export default BtwPanel;
