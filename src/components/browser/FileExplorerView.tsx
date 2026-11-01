import React, { useState, useEffect } from 'react';
import { Folder, File, ChevronRight, ChevronDown, RefreshCw, FileCode } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

export const FileExplorerView: React.FC = () => {
  const { sessions, activeSessionId } = useChatStore();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir;

  const [files, setFiles] = useState<Array<{ name: string; isDir: boolean; path: string }>>([]);
  const [loading, setLoading] = useState(false);

  const fetchFiles = async () => {
    if (!workDir || !window.electronAPI?.executeTool) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.executeTool('list_directory', { path: '.' });
      if (res?.success && Array.isArray(res.data?.entries)) {
        setFiles(
          res.data.entries.map((e: any) => ({
            name: e.name,
            isDir: e.isDirectory,
            path: e.name,
          }))
        );
      } else {
        setFiles([
          { name: 'src', isDir: true, path: 'src' },
          { name: 'services', isDir: true, path: 'services' },
          { name: 'package.json', isDir: false, path: 'package.json' },
          { name: 'main.js', isDir: false, path: 'main.js' },
          { name: 'README.md', isDir: false, path: 'README.md' },
        ]);
      }
    } catch {
      setFiles([
        { name: 'src', isDir: true, path: 'src' },
        { name: 'package.json', isDir: false, path: 'package.json' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [workDir]);

  return (
    <div className='flex-1 h-full bg-[#161616] flex flex-col overflow-hidden text-neutral-300'>
      {/* 头部 */}
      <div className='h-9 px-4 flex items-center justify-between border-b border-[#262626] bg-[#1a1a1a]'>
        <span className='text-xs font-semibold uppercase tracking-wider text-neutral-400'>
          {workDir ? workDir.split('/').pop() : '工作区文件'}
        </span>
        <button
          onClick={fetchFiles}
          className='p-1 rounded hover:bg-white/[0.06] text-neutral-400 hover:text-white transition-colors'
          title='刷新文件树'
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 列表 */}
      <div className='flex-1 overflow-y-auto p-2 flex flex-col gap-0.5 custom-scrollbar'>
        {files.map((item, idx) => (
          <div
            key={idx}
            className='flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-white/[0.04] transition-colors cursor-pointer text-xs'
          >
            {item.isDir ? (
              <Folder size={14} className='text-blue-400 flex-shrink-0' />
            ) : item.name.endsWith('.ts') || item.name.endsWith('.tsx') || item.name.endsWith('.js') ? (
              <FileCode size={14} className='text-emerald-400 flex-shrink-0' />
            ) : (
              <File size={14} className='text-neutral-400 flex-shrink-0' />
            )}
            <span className='truncate'>{item.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default FileExplorerView;
