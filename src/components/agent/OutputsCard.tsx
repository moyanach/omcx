import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Globe, FileText, Code, File, FolderOpen } from 'lucide-react';
import { useChatStore, SessionOutput } from '@/stores/chatStore';

export const OutputsCard: React.FC = () => {
  const [isOpen, setIsOpen] = useState(true);
  const { outputs } = useChatStore();

  // 若当前会话尚未写出文件，提供匹配截图 2 的示例与提示
  const displayOutputs: SessionOutput[] = outputs.length > 0 ? outputs : [
    {
      id: 'demo-1',
      name: 'test_sender.html',
      filePath: 'test_sender.html',
      fileType: 'html',
      createdAt: Date.now() - 3600000,
    },
    {
      id: 'demo-2',
      name: '测试场景与测试案例指导_P0_P5.md',
      filePath: '测试场景与测试案例指导_P0_P5.md',
      fileType: 'markdown',
      createdAt: Date.now() - 7200000,
    },
  ];

  const renderIcon = (name: string, type: string) => {
    if (name.endsWith('.html') || type === 'html') {
      return <Globe size={15} className='text-neutral-400' />;
    }
    if (name.endsWith('.md') || type === 'markdown') {
      return <FileText size={15} className='text-neutral-400' />;
    }
    if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.json')) {
      return <Code size={15} className='text-neutral-400' />;
    }
    return <File size={15} className='text-neutral-400' />;
  };

  const handleOpenFile = (filePath: string) => {
    if (window.electronAPI?.showInFolder) {
      window.electronAPI.showInFolder(filePath);
    }
  };

  return (
    <div className='bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl overflow-hidden transition-all duration-200 select-none titlebar-no-drag'>
      {/* 头部标题与折叠开关 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className='w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors'
      >
        <span className='font-semibold text-sm text-neutral-200 tracking-wide'>
          Outputs
        </span>
        <div className='text-neutral-400'>
          {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </div>
      </button>

      {/* 折叠内容 (支持产物较多时的局部顺畅滚动) */}
      {isOpen && (
        <div className='px-4 pb-3.5 pt-0.5 flex flex-col gap-1.5 max-h-[140px] overflow-y-auto custom-scrollbar pr-1 overscroll-contain'>
          {displayOutputs.map((item) => (
            <div
              key={item.id}
              onClick={() => handleOpenFile(item.filePath)}
              className='flex items-center justify-between py-1.5 px-2 -mx-1.5 rounded-lg hover:bg-white/[0.04] transition-colors cursor-pointer group'
              title={`点击在访达/资源管理器中查看: ${item.filePath}`}
            >
              <div className='flex items-center gap-2.5 min-w-0 pr-2'>
                <span className='flex-shrink-0'>
                  {renderIcon(item.name, item.fileType)}
                </span>
                <span className='text-xs font-normal text-neutral-300 truncate group-hover:text-white transition-colors'>
                  {item.name}
                </span>
              </div>

              <div className='text-neutral-400 group-hover:text-neutral-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0'>
                <FolderOpen size={13} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default OutputsCard;
