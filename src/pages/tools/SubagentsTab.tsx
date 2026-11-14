import React from 'react';
import { Bot, Shield } from 'lucide-react';
import { SubagentItem } from '@/stores/chatStore';

interface SubagentsTabProps {
  subagents: SubagentItem[];
  onInspectSubagent: (ag: SubagentItem) => void;
}

export const SubagentsTab: React.FC<SubagentsTabProps> = ({
  subagents,
  onInspectSubagent,
}) => (
  <div className='flex flex-col gap-4'>
    {/* 顶部说明横幅：与面板背景融为一体的微透表面 */}
    <div className='px-4 py-3 rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] shadow-sm flex items-center justify-between gap-4'>
      <div className='flex items-center gap-3 min-w-0'>
        <div className='w-8 h-8 rounded-xl bg-[var(--ui-accent-sky-soft)] border border-[color:var(--ui-accent-sky-border)] flex items-center justify-center text-[var(--ui-accent-sky)] flex-shrink-0'>
          <Bot size={16} />
        </div>
        <div className='min-w-0'>
          <div className='text-xs font-semibold text-[var(--ui-text-primary)]'>
            支持「主 Agent 自主判断 + 零预设动态生成 + 多路并行 Fan-out」
          </div>
          <div className='text-[11px] text-[var(--ui-text-muted)] truncate mt-0.5'>
            复杂检索或多模块任务时，主 Agent 会自动通过 dispatch_subagent 单路或多路并发委派；你也可在 ~/.omcx/agents/*.md 定义专属模板或在输入框用 @agent: 点名。
          </div>
        </div>
      </div>
      <span className='text-[11px] text-[var(--ui-text-muted)] flex-shrink-0'>
        点击卡片查看系统提示词
      </span>
    </div>

    <div className='grid grid-cols-1 md:grid-cols-2 gap-3.5'>
      {subagents.map((ag) => (
        <div
          key={ag.id}
          onClick={() => onInspectSubagent(ag)}
          className='p-4 rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] hover:bg-[var(--ui-card-hover-bg)] hover:border-[color:var(--ui-accent-sky-border)] hover:shadow-md transition-all duration-150 cursor-pointer flex flex-col justify-between gap-3 group shadow-sm'
        >
          <div className='flex flex-col gap-2.5'>
            <div className='flex items-center justify-between gap-2'>
              <div className='flex items-center gap-2 min-w-0'>
                <Bot size={15} className='text-[var(--ui-accent-sky)] flex-shrink-0' />
                <span className='font-bold text-sm text-[var(--ui-text-primary)] group-hover:text-[var(--ui-accent-sky)] transition-colors truncate'>
                  {ag.name}
                </span>
                <code className='text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] border border-[color:var(--ui-accent-sky-border)]'>
                  @{ag.id}
                </code>
              </div>

              <div className='flex items-center gap-1.5 flex-shrink-0'>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono border flex items-center gap-1 ${
                    ag.readOnly
                      ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]'
                      : 'bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border-[color:var(--ui-accent-amber-border)]'
                  }`}
                >
                  <Shield size={10} />
                  <span>{ag.readOnly ? '只读安全' : '完整读写'}</span>
                </span>
                <span className='px-2 py-0.5 rounded-full text-[10px] font-mono uppercase bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-hairline)]'>
                  {ag.scope || 'builtin'}
                </span>
              </div>
            </div>

            <p className='text-xs text-[var(--ui-text-secondary)] line-clamp-2 leading-relaxed'>
              {ag.description}
            </p>
          </div>

          <div className='space-y-2 pt-2.5 border-t border-[color:var(--ui-divider-hairline)]'>
            <div className='flex items-center justify-between text-[10.5px] font-mono text-[var(--ui-text-muted)]'>
              <span>模型策略: {ag.modelTier === 'lite' ? 'Lite (高速轻量优先)' : 'Inherit (继承主模型)'}</span>
              <span>最大轮次: {ag.maxRounds || 10} 轮</span>
            </div>
            <div className='flex items-center gap-1.5 flex-wrap'>
              {(ag.tools || []).map((t) => (
                <span
                  key={t}
                  className='px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] font-mono text-[var(--ui-text-secondary)]'
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
);
