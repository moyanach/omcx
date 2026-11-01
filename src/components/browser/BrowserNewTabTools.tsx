import React from 'react';
import { PlusSquare, Terminal, Folder, ExternalLink } from 'lucide-react';

interface BrowserNewTabToolsProps {
  onOpenTool: (toolId: 'changes' | 'terminal' | 'files') => void;
  onOpenUrl: (url: string) => void;
}

export const BrowserNewTabTools: React.FC<BrowserNewTabToolsProps> = ({
  onOpenTool,
  onOpenUrl,
}) => {
  return (
    <div className='flex-1 h-full bg-[#181818] p-8 flex flex-col overflow-y-auto select-none'>
      {/* 大标题：工具 (精准对应参考图 3) */}
      <h2 className='text-lg font-bold text-neutral-100 mb-5 tracking-tight'>
        工具
      </h2>

      {/* 3 个圆角卡片列表 (精准对应参考图 3) */}
      <div className='flex flex-col gap-2.5 max-w-[420px]'>
        {/* 卡片 1: 变更 (快捷键: ^⇧G) */}
        <div
          onClick={() => onOpenTool('changes')}
          className='flex items-center justify-between p-3.5 rounded-xl bg-[#202020] hover:bg-[#272727] active:bg-[#1d1d1d] border border-[#2f2f2f] shadow-sm cursor-pointer transition-all duration-150 group'
        >
          <div className='flex items-center gap-3.5'>
            <div className='w-7 h-7 rounded-lg bg-[#2a2a2a] flex items-center justify-center text-neutral-300 group-hover:text-white transition-colors border border-[#383838]'>
              <PlusSquare size={16} />
            </div>
            <span className='font-semibold text-sm text-neutral-200 group-hover:text-white transition-colors'>
              变更
            </span>
          </div>
          <span className='px-2 py-0.5 rounded-md bg-[#2a2a2a] text-neutral-400 font-mono text-xs border border-[#383838]'>
            ^⇧G
          </span>
        </div>

        {/* 卡片 2: 终端 (快捷键: ^ `) */}
        <div
          onClick={() => onOpenTool('terminal')}
          className='flex items-center justify-between p-3.5 rounded-xl bg-[#202020] hover:bg-[#272727] active:bg-[#1d1d1d] border border-[#2f2f2f] shadow-sm cursor-pointer transition-all duration-150 group'
        >
          <div className='flex items-center gap-3.5'>
            <div className='w-7 h-7 rounded-lg bg-[#2a2a2a] flex items-center justify-center text-neutral-300 group-hover:text-white transition-colors border border-[#383838]'>
              <Terminal size={16} />
            </div>
            <span className='font-semibold text-sm text-neutral-200 group-hover:text-white transition-colors'>
              终端
            </span>
          </div>
          <span className='px-2 py-0.5 rounded-md bg-[#2a2a2a] text-neutral-400 font-mono text-xs border border-[#383838]'>
            ^ `
          </span>
        </div>

        {/* 卡片 3: 文件 (快捷键: ⌘P) */}
        <div
          onClick={() => onOpenTool('files')}
          className='flex items-center justify-between p-3.5 rounded-xl bg-[#202020] hover:bg-[#272727] active:bg-[#1d1d1d] border border-[#2f2f2f] shadow-sm cursor-pointer transition-all duration-150 group'
        >
          <div className='flex items-center gap-3.5'>
            <div className='w-7 h-7 rounded-lg bg-[#2a2a2a] flex items-center justify-center text-neutral-300 group-hover:text-white transition-colors border border-[#383838]'>
              <Folder size={16} />
            </div>
            <span className='font-semibold text-sm text-neutral-200 group-hover:text-white transition-colors'>
              文件
            </span>
          </div>
          <span className='px-2 py-0.5 rounded-md bg-[#2a2a2a] text-neutral-400 font-mono text-xs border border-[#383838]'>
            ⌘P
          </span>
        </div>
      </div>

      {/* 快捷测试场景与站点推荐 */}
      <div className='mt-8 pt-6 border-t border-[#262626] max-w-[420px]'>
        <h3 className='text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3'>
          快速预览
        </h3>
        <div className='flex flex-col gap-2'>
          <button
            onClick={() => onOpenUrl('http://localhost:5173')}
            className='w-full text-left p-2.5 rounded-lg bg-[#1f1f1f] hover:bg-[#262626] border border-[#2c2c2c] text-xs text-neutral-300 flex items-center justify-between transition-colors'
          >
            <span>本地前端开发服务 (localhost:5173)</span>
            <ExternalLink size={12} className='text-neutral-500' />
          </button>
          <button
            onClick={() => onOpenUrl('https://github.com')}
            className='w-full text-left p-2.5 rounded-lg bg-[#1f1f1f] hover:bg-[#262626] border border-[#2c2c2c] text-xs text-neutral-300 flex items-center justify-between transition-colors'
          >
            <span>GitHub 项目站点</span>
            <ExternalLink size={12} className='text-neutral-500' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default BrowserNewTabTools;
