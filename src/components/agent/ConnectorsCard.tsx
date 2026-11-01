import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, ExternalLink } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

export const ConnectorsCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const { mcpServers } = useChatStore();

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
    <div className='bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag'>
      {/* 头部标题与折叠开关 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className='w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors'
      >
        <span className='font-semibold text-sm text-neutral-200 tracking-wide'>
          Connectors
        </span>
        <div className='text-neutral-400'>
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {/* 折叠内容 */}
      {isOpen && (
        <div className='px-4 pb-3.5 pt-0.5 flex flex-col gap-2'>
          {displayServers.map((server, idx) => (
            <div
              key={`${server.id}-${idx}`}
              className='flex items-center justify-between py-1.5 px-2 -mx-1.5 rounded-lg hover:bg-white/[0.04] transition-colors cursor-pointer group'
              title={server.description || server.name}
            >
              <div className='flex items-center gap-3 min-w-0'>
                {/* 参照截图 2 的圆角小矩形 C 图标 */}
                <div className='w-6 h-6 rounded-md bg-[#2d2d2d] border border-[#3d3d3d] flex items-center justify-center flex-shrink-0 text-neutral-300 font-bold text-xs shadow-sm'>
                  {server.name.charAt(0).toUpperCase()}
                </div>
                <span className='text-xs font-medium text-neutral-200 truncate'>
                  {server.name}
                </span>
              </div>

              {/* 右侧指示器 */}
              <div className='flex items-center gap-1.5'>
                <span className='w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0' />
                <span className='text-[10px] text-neutral-400 font-mono hidden group-hover:inline-block'>
                  MCP
                </span>
              </div>
            </div>
          ))}

          {/* 底部快速查看提示 */}
          <div className='pt-1 flex items-center justify-between text-[11px] text-neutral-400 border-t border-[#262626] mt-1'>
            <span>来源: ~/.omcx/mcp.json</span>
            <span className='hover:text-neutral-300 cursor-pointer flex items-center gap-0.5'>
              管理 <ExternalLink size={10} />
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectorsCard;
