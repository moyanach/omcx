import React, { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useAppStore } from '@/stores/appStore';

export const ConnectorsCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const mcpServers = useChatStore((s) => s.mcpServers);
  const setActiveNavTab = useAppStore((s) => s.setActiveNavTab);

  // 仅显示当前已启用的可用 MCP
  const activeServers = mcpServers.filter((s) => s.enabled !== false);

  return (
    <div className='border-b border-[color:var(--ui-divider-hairline)] transition-colors select-none titlebar-no-drag last:border-b-0'>
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
          {activeServers.length === 0 ? (
            <div className='py-2 text-xs text-[var(--ui-text-faint)]'>
              暂无可用 MCP 服务器
            </div>
          ) : (
            activeServers.map((server, idx) => (
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
            ))
          )}

          {/* 底部快速查看提示 */}
          <div className='pt-1.5 flex items-center justify-between text-[11px] text-[var(--ui-text-muted)] border-t border-[color:var(--ui-divider-hairline)] mt-1'>
            <span>MCP 连接器 ({activeServers.length})</span>
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
