import React, { useState } from 'react';
import {
  Globe,
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  MoreHorizontal,
  SplitSquareVertical,
  Maximize2,
  Terminal,
  FileDiff,
  FolderTree,
} from 'lucide-react';
import BrowserNewTabTools from './BrowserNewTabTools';
import FileExplorerView from './FileExplorerView';

interface TabItem {
  id: string;
  title: string;
  type: 'newtab' | 'url' | 'files' | 'changes' | 'terminal';
  url?: string;
}

interface WebWorkspaceDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WebWorkspaceDrawer: React.FC<WebWorkspaceDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const [tabs, setTabs] = useState<TabItem[]>([
    { id: 't1', title: '新标签页', type: 'newtab' },
  ]);
  const [activeTabId, setActiveTabId] = useState('t1');
  const [inputUrl, setInputUrl] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  if (!isOpen) return null;

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // 新增标签页
  const handleNewTab = () => {
    const newId = `t_${Date.now()}`;
    const newTab: TabItem = { id: newId, title: '新标签页', type: 'newtab' };
    setTabs([...tabs, newTab]);
    setActiveTabId(newId);
    setInputUrl('');
  };

  // 关闭标签页
  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) {
      onClose();
      return;
    }
    const filtered = tabs.filter((t) => t.id !== id);
    setTabs(filtered);
    if (activeTabId === id) {
      setActiveTabId(filtered[filtered.length - 1].id);
    }
  };

  // 导航到指定 URL
  const handleNavigate = (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    let finalUrl = targetUrl.trim();
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://') && !finalUrl.startsWith('local-media://') && !finalUrl.startsWith('app://')) {
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = `https://${finalUrl}`;
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
      }
    }

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, title: finalUrl.replace(/^https?:\/\//, ''), type: 'url', url: finalUrl }
          : t
      )
    );
    setInputUrl(finalUrl);
  };

  const handleKeyDownUrl = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleNavigate(inputUrl);
    }
  };

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const handleOpenTool = (toolId: 'changes' | 'terminal' | 'files') => {
    const toolTitleMap = {
      changes: '代码变更 (Changes)',
      terminal: '集成终端 (Terminal)',
      files: '工作区文件 (Files)',
    };
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, title: toolTitleMap[toolId], type: toolId }
          : t
      )
    );
  };

  return (
    <aside className='w-[500px] h-full flex flex-col flex-shrink-0 bg-[#161616] border-l border-[#262626] z-20 select-none'>
      {/* ─── 1. 顶部标签栏 (Tab bar，精准还原图 3) ─── */}
      <div className='h-9 bg-[#1a1a1a] border-b border-[#262626] flex items-center px-2 gap-1 overflow-x-auto flex-shrink-0'>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => {
                setActiveTabId(tab.id);
                setInputUrl(tab.url || '');
              }}
              className={`h-7 px-2.5 flex items-center gap-2 rounded-t-lg text-xs cursor-pointer transition-colors max-w-[160px] group ${
                isActive
                  ? 'bg-[#161616] text-neutral-200 border-t border-x border-[#2c2c2c] font-medium'
                  : 'text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-300'
              }`}
            >
              {tab.type === 'files' ? (
                <FolderTree size={12} className='text-blue-400 flex-shrink-0' />
              ) : tab.type === 'terminal' ? (
                <Terminal size={12} className='text-emerald-400 flex-shrink-0' />
              ) : tab.type === 'changes' ? (
                <FileDiff size={12} className='text-orange-400 flex-shrink-0' />
              ) : (
                <Globe size={12} className='text-neutral-400 flex-shrink-0' />
              )}
              <span className='truncate text-[11px]'>{tab.title}</span>
              <button
                onClick={(e) => handleCloseTab(tab.id, e)}
                className='w-3.5 h-3.5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-white/[0.1] text-neutral-400 hover:text-white transition-opacity'
              >
                <X size={10} />
              </button>
            </div>
          );
        })}

        {/* [+] 新建标签按钮 */}
        <button
          onClick={handleNewTab}
          className='w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.06] text-neutral-400 hover:text-white transition-colors'
          title='新建标签页'
        >
          <Plus size={13} />
        </button>

        <div className='flex-grow' />

        {/* 窗口拆分与关闭 */}
        <div className='flex items-center gap-1 text-neutral-400'>
          <button
            onClick={onClose}
            className='w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06] hover:text-white transition-colors'
            title='收起面板'
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ─── 2. 导航与地址栏 (Navigation bar，精准还原图 3) ─── */}
      <div className='h-10 px-3 flex items-center gap-2 border-b border-[#262626] bg-[#161616] flex-shrink-0'>
        {/* 前进后退按钮 */}
        <button
          className='p-1 rounded text-neutral-600 hover:text-neutral-400 transition-colors disabled:opacity-40'
          disabled
          title='后退'
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className='p-1 rounded text-neutral-600 hover:text-neutral-400 transition-colors disabled:opacity-40'
          disabled
          title='前进'
        >
          <ChevronRight size={16} />
        </button>

        {/* 竖线分隔 */}
        <div className='w-[1px] h-3.5 bg-[#2d2d2d] mx-0.5' />

        {/* 刷新图标 */}
        <button
          onClick={handleRefresh}
          className='p-1 rounded text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors'
          title='刷新'
        >
          <RotateCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
        </button>

        {/* 地址输入框 (对应图 3 的搜索或输入网址) */}
        <div className='flex-1 h-7 rounded-lg bg-[#222222] border border-[#2f2f2f] flex items-center px-2.5 focus-within:border-blue-500/80 transition-colors'>
          <input
            type='text'
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDownUrl}
            placeholder='搜索或输入网址'
            className='w-full bg-transparent text-xs text-neutral-200 placeholder-neutral-500 outline-none font-sans'
          />
        </div>

        {/* 右侧更多菜单 */}
        <button
          className='p-1 rounded text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors'
          title='更多选项'
        >
          <MoreHorizontal size={15} />
        </button>
      </div>

      {/* ─── 3. 主内容渲染区 (Main Content) ─── */}
      <div className='flex-1 overflow-hidden relative bg-[#131313]'>
        {activeTab.type === 'newtab' ? (
          <BrowserNewTabTools
            onOpenTool={handleOpenTool}
            onOpenUrl={handleNavigate}
          />
        ) : activeTab.type === 'files' ? (
          <FileExplorerView />
        ) : activeTab.type === 'changes' ? (
          <div className='p-6 flex flex-col gap-3 text-neutral-300'>
            <h3 className='font-semibold text-sm text-neutral-100 flex items-center gap-2'>
              <FileDiff size={16} className='text-orange-400' />
              代码变更 (Git Diff)
            </h3>
            <p className='text-xs text-neutral-400'>
              已对接当前工作区代码追踪器，您可以在左侧 Changes 卡片查看具体增删行并提交。
            </p>
          </div>
        ) : activeTab.type === 'terminal' ? (
          <div className='p-6 flex flex-col gap-3 text-neutral-300'>
            <h3 className='font-semibold text-sm text-neutral-100 flex items-center gap-2'>
              <Terminal size={16} className='text-emerald-400' />
              集成终端 (Terminal)
            </h3>
            <p className='text-xs text-neutral-400'>
              Agent 正在主进程终端池中执行命令，所有输出已与会话工具状态完全同步。
            </p>
          </div>
        ) : (
          /* Web 网页 / 测试场景实际渲染容器 */
          <iframe
            key={activeTab.url}
            src={activeTab.url}
            className='w-full h-full border-0 bg-white'
            title='Web Preview'
            sandbox='allow-scripts allow-same-origin allow-forms allow-popups'
          />
        )}
      </div>
    </aside>
  );
};

export default WebWorkspaceDrawer;
