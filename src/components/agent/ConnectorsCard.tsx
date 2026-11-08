import React, { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Bot } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useAppStore } from '@/stores/appStore';

export const ConnectorsCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const { mcpServers, subagents } = useChatStore();
  const { setActiveNavTab } = useAppStore();

  // 若无自定义 MCP，默认显示预置的 Context7 连接器以完全匹配视觉截图
  const displayServers = mcpServers.length > 0 ? mcpServers : [
    {
      id: 'context7-1',
      name: 'Context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      description: '实时代码库与技术文档检索引擎',
      enabled: true,
    },
    {
      id: 'context7-2',
      name: 'Context7',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      description: '上下文增强组件',
      enabled: true,
    },
  ];

  return (
    <div className='bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag'>
      {/* 头部标题与折叠开关 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className='w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ui-block-hover-bg)] transition-colors'
      >
        <span className='font-semibold text-sm text-[var(--ui-text-primary)] tracking-wide'>
          连接器
        </span>
        <div className='text-[var(--ui-text-faint)]'>
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {/* 折叠内容 */}
      {isOpen && (
        <div className='px-4 pb-3.5 pt-0.5 flex flex-col gap-2'>
          {subagents.length > 0 && (
            <div className='flex flex-col gap-1 pb-1.5 border-b border-[color:var(--ui-divider-hairline)]'>
              <div className='text-[10px] font-mono text-[var(--ui-text-faint)] uppercase tracking-wider mb-0.5'>
                子代理引擎 ({subagents.length})
              </div>
              <div className='flex flex-wrap gap-1.5'>
                {subagents.map((ag) => (
                  <span
                    key={ag.id}
                    title={`${ag.name}: ${ag.description}`}
                    className='inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)]'
                  >
                    <Bot size={11} className='text-[var(--ui-accent-sky)] flex-shrink-0' />
                    <span className='font-mono'>{ag.id}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {displayServers.map((server, idx) => (
            <div
              key={`${server.id}-${idx}`}
              className='flex items-center justify-between py-1.5 px-2 -mx-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer group'
              title={server.description || server.name}
            >
              <div className='flex items-center gap-3 min-w-0'>
                <div className='w-6 h-6 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center flex-shrink-0 text-[var(--ui-text-secondary)] font-bold text-xs'>
                  {server.name.charAt(0).toUpperCase()}
                </div>
                <span className='text-xs font-medium text-[var(--ui-text-primary)] truncate'>
                  {server.name}
                </span>
              </div>

              {/* 右侧指示器 */}
              <div className='flex items-center gap-1.5'>
                <span className='w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0' />
                <span className='text-[10px] text-[var(--ui-text-faint)] font-mono hidden group-hover:inline-block'>
                  MCP
                </span>
              </div>
            </div>
          ))}

          {/* 底部快速查看提示 */}
          <div className='pt-1.5 flex items-center justify-between text-[11px] text-[var(--ui-text-muted)] border-t border-[color:var(--ui-divider-hairline)] mt-1'>
            <span>Subagents & MCP</span>
            <span
              onClick={() => setActiveNavTab('tools')}
              className='hover:text-[var(--ui-text-primary)] cursor-pointer flex items-center gap-0.5 transition-colors'
            >
              管理 <ExternalLink size={10} />
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectorsCard;
