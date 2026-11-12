import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

export const ContextCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const { contextMetrics, messages, activeSessionId, lastCompaction } = useChatStore();

  const activeMsgs = activeSessionId ? messages[activeSessionId] || [] : [];

  // 如果主进程尚未推送指标，提供基于当前消息数量的初始默认估算
  const metrics = contextMetrics || {
    totalLimit: 1000000,
    totalLimitFormatted: '1M',
    usedTokens: Math.max(120, activeMsgs.length * 80),
    usedTokensFormatted: activeMsgs.length > 0 ? `${(activeMsgs.length * 0.1).toFixed(1)}k` : '0.1k',
    usedPercent: activeMsgs.length > 0 ? Math.min(100, parseFloat(((activeMsgs.length * 80 / 1000000) * 100).toFixed(1))) : 0.1,
    breakdown: {
      messages: {
        tokens: activeMsgs.length * 60,
        formatted: `${(activeMsgs.length * 0.06).toFixed(1)}k`,
        percent: 0.1,
        color: '#3b82f6',
        label: 'Messages',
      },
      systemTools: {
        tokens: 15100,
        formatted: '15.1k',
        percent: 1.5,
        color: '#f97316',
        label: 'System tools',
      },
      systemPrompt: {
        tokens: 6300,
        formatted: '6.3k',
        percent: 0.6,
        color: '#22c55e',
        label: 'System prompt',
      },
      skills: {
        tokens: 5600,
        formatted: '5.6k',
        percent: 0.6,
        color: '#eab308',
        label: 'Skills',
      },
      freeSpace: {
        tokens: 973000,
        formatted: '973.0k',
        percent: 97.2,
        color: '#404040',
        label: 'Free space',
      },
    },
  };

  const { breakdown } = metrics;
  const items = [
    { ...breakdown.messages, isFree: false },
    { ...breakdown.systemTools, isFree: false },
    { ...breakdown.systemPrompt, isFree: false },
    { ...breakdown.skills, isFree: false },
    { ...breakdown.freeSpace, isFree: true },
  ];

  return (
    <div className='border-b border-[color:var(--ui-divider-hairline)] transition-colors select-none titlebar-no-drag last:border-b-0'>
      {/* 头部标题与折叠开关 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className='w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors'
      >
        <span className='flex items-center gap-2 min-w-0'>
          <span className='font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide'>
            上下文
          </span>
          {lastCompaction && (
            <span
              className='px-1.5 py-0.2 rounded-full text-[10px] bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)] font-mono flex-shrink-0'
              title={`上次压缩：${lastCompaction.beforeTokens.toLocaleString()} → ${lastCompaction.afterTokens.toLocaleString()} tokens · ${new Date(lastCompaction.at).toLocaleTimeString()}`}
            >
              已压缩
            </span>
          )}
        </span>
        <div className='text-[var(--ui-text-faint)]'>
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {/* 折叠内容 */}
      {isOpen && (
        <div className='px-4 pb-4 pt-1 flex flex-col gap-3.5'>
          {/* 使用比例与容量指示 */}
          <div className='flex items-center justify-between text-xs'>
            <span className='font-medium text-[var(--ui-text-primary)]'>
              {metrics.usedPercent}% used
            </span>
            <span className='text-[var(--ui-text-muted)] font-mono'>
              {metrics.usedTokensFormatted} / {metrics.totalLimitFormatted}
            </span>
          </div>

          {/* 五彩分段进度条 */}
          <div className='w-full h-2 rounded-full overflow-hidden flex bg-[var(--ui-chip-bg)]'>
            {items.map((item, idx) => {
              if (item.percent <= 0) return null;
              return (
                <div
                  key={idx}
                  style={{
                    width: `${item.percent}%`,
                    backgroundColor: item.isFree ? 'transparent' : item.color,
                  }}
                  title={`${item.label}: ${item.formatted} (${item.percent}%)`}
                  className='h-full transition-all duration-300'
                />
              );
            })}
          </div>

          {/* 细分项列表 */}
          <div className='flex flex-col gap-2 pt-1'>
            {items.map((item, idx) => (
              <div
                key={idx}
                className='flex items-center justify-between text-xs text-[var(--ui-text-secondary)]'
              >
                <div className='flex items-center gap-2.5'>
                  <span
                    className='w-2.5 h-2.5 rounded-sm flex-shrink-0'
                    style={{
                      backgroundColor: item.isFree ? 'var(--ui-chip-hover-bg)' : item.color,
                      border: item.isFree ? '1px solid var(--ui-border-subtle)' : undefined,
                    }}
                  />
                  <span className='text-[var(--ui-text-secondary)] font-medium'>
                    {item.label}
                  </span>
                </div>
                <div className='flex items-center gap-3 font-mono text-[11px] text-[var(--ui-text-muted)]'>
                  <span>{item.formatted}</span>
                  <span className='w-11 text-right text-[var(--ui-text-muted)]'>
                    {item.percent}%
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* 本轮模型用量与成本 (原生 Anthropic/兼容端点 usage 归一化后) */}
          {metrics.usage && (
            <div className='flex flex-col gap-1 pt-2.5 border-t border-[color:var(--ui-divider-hairline)] text-[10.5px] font-mono text-[var(--ui-text-muted)]'>
              <div className='flex items-center justify-between'>
                <span>本轮 Tokens</span>
                <span className='text-[var(--ui-text-secondary)]'>
                  ↑{metrics.usage.prompt_tokens.toLocaleString()} / ↓
                  {metrics.usage.completion_tokens.toLocaleString()}
                </span>
              </div>
              {metrics.usage.cached_tokens > 0 && (
                <div className='flex items-center justify-between'>
                  <span>Prompt Cache 命中</span>
                  <span className='text-[var(--ui-accent-emerald)]'>
                    {metrics.usage.cached_tokens.toLocaleString()} tokens
                  </span>
                </div>
              )}
              {typeof metrics.costUsd === 'number' && metrics.costUsd > 0 && (
                <div className='flex items-center justify-between'>
                  <span>本轮成本</span>
                  <span className='text-[var(--ui-accent-amber)]'>
                    ${metrics.costUsd.toFixed(4)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ContextCard;
