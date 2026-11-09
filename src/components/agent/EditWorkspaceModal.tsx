import React, { useState } from 'react';
import { X, Folder, FolderPlus, Star } from 'lucide-react';

export interface WorkspaceFolder {
  path: string;
  name: string;
  isPrimary?: boolean;
}

export interface WorkspaceData {
  id: string;
  name: string;
  folders: WorkspaceFolder[];
}

interface EditWorkspaceModalProps {
  isOpen: boolean;
  workspace: WorkspaceData | null;
  onClose: () => void;
  onSave: (updated: WorkspaceData) => Promise<void>;
  onDelete?: (workspaceId: string) => Promise<void>;
}

export const EditWorkspaceModal: React.FC<EditWorkspaceModalProps> = ({
  isOpen,
  workspace,
  onClose,
  onSave,
  onDelete,
}) => {
  const [name, setName] = useState(workspace?.name || '');
  const [folders, setFolders] = useState<WorkspaceFolder[]>(workspace?.folders || []);
  const [isSaving, setIsSaving] = useState(false);

  // 弹窗打开或切换目标工作空间时同步表单初始值
  React.useEffect(() => {
    if (!isOpen || !workspace) return;
    setName(workspace.name || '');
    setFolders(workspace.folders || []);
    setIsSaving(false);
  }, [isOpen, workspace?.id, workspace?.name]);

  // ⚠️ 守卫必须置于所有 Hook 之后，保证 Hook 调用数量恒定（杜绝打开弹窗时 Hook 顺序变化白屏）
  if (!isOpen || !workspace) return null;

  // 添加文件夹 (调用系统原生选择目录对话框)
  const handleAddFolder = async () => {
    if (window.electronAPI?.dialogSelectWorkDirectory) {
      const dir = await window.electronAPI.dialogSelectWorkDirectory();
      if (dir) {
        // 防止重复添加相同路径
        if (folders.some((f) => f.path === dir)) return;

        const folderName = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
        const isFirst = folders.length === 0;
        setFolders((prev) => [
          ...prev,
          {
            path: dir,
            name: folderName,
            isPrimary: isFirst,
          },
        ]);
      }
    }
  };

  // 移除某个文件夹
  const handleRemoveFolder = (index: number) => {
    const updated = folders.filter((_, idx) => idx !== index);
    // 如果删除了主要文件夹，自动将剩余的第一个设为主文件夹
    if (updated.length > 0 && !updated.some((f) => f.isPrimary)) {
      updated[0].isPrimary = true;
    }
    setFolders(updated);
  };

  // 设为主要文件夹
  const handleSetPrimary = (index: number) => {
    setFolders((prev) =>
      prev.map((f, idx) => ({
        ...f,
        isPrimary: idx === index,
      }))
    );
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        ...workspace,
        name: name.trim() || '未命名工作空间',
        folders,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (window.confirm(`确定要移除工作空间 "${workspace.name}" 吗？此操作不会删除本地物理文件。`)) {
      await onDelete(workspace.id);
      onClose();
    }
  };

  return (
    <div className='fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4 select-none animate-in fade-in duration-150'>
      {/* 弹窗主体卡片 (100% 还原参考图 8 结构与排版) */}
      <div className='w-full max-w-[520px] bg-[#1e1e1e] border border-[#2f2f2f] rounded-2xl shadow-2xl flex flex-col overflow-hidden text-neutral-200'>
        {/* 1. Header: 标题 + 关闭按钮 */}
        <div className='px-6 pt-5 pb-3 flex items-center justify-between'>
          <h2 className='text-base font-bold text-neutral-100 tracking-tight'>
            编辑项目
          </h2>
          <button
            onClick={onClose}
            className='w-7 h-7 flex items-center justify-center rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.08] transition-colors'
          >
            <X size={16} />
          </button>
        </div>

        {/* 2. Body: 工作空间名称输入框 + 源文件夹列表卡片 */}
        <div className='px-6 py-2 flex flex-col gap-4'>
          {/* 项目名称输入框 (左侧带独立方块 📁 图标) */}
          <div className='flex items-center h-11 rounded-xl bg-[#171717] border-2 border-blue-500/80 focus-within:border-blue-500 overflow-hidden shadow-sm transition-colors'>
            <div className='w-11 h-full border-r border-[#2d2d2d] bg-[#1d1d1d] flex items-center justify-center text-neutral-300 flex-shrink-0'>
              <Folder size={18} />
            </div>
            <input
              type='text'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='工作空间名称'
              className='flex-1 h-full bg-transparent px-3 text-sm font-medium text-neutral-100 outline-none'
            />
          </div>

          {/* 源文件夹列表区块 (完全对应图 8) */}
          <div className='flex flex-col gap-2'>
            <span className='text-xs font-semibold text-neutral-400'>
              源文件夹
            </span>

            <div className='rounded-xl border border-[#2f2f2f] bg-[#171717] divide-y divide-[#262626] overflow-hidden'>
              {/* 各文件夹列表项 */}
              {folders.map((folder, idx) => (
                <div
                  key={`${folder.path}-${idx}`}
                  className='h-11 px-3.5 flex items-center justify-between group hover:bg-white/[0.02] transition-colors'
                >
                  <div className='flex items-center gap-3 min-w-0 pr-2'>
                    <Folder size={16} className='text-neutral-400 flex-shrink-0' />
                    <span
                      className='text-xs font-medium text-neutral-200 truncate cursor-pointer hover:text-blue-400'
                      title={folder.path}
                    >
                      {folder.name}
                    </span>
                    {/* 主要 (Primary) 胶囊徽章 */}
                    {folder.isPrimary ? (
                      <span className='px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#2c2c2c] text-neutral-300 border border-[#3a3a3a] flex-shrink-0'>
                        主要
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSetPrimary(idx)}
                        className='text-[10px] text-neutral-500 hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity'
                        title='设为主要文件夹'
                      >
                        设为主目录
                      </button>
                    )}
                  </div>

                  {/* 移除该文件夹按钮 ✕ */}
                  <button
                    onClick={() => handleRemoveFolder(idx)}
                    className='w-6 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors flex-shrink-0'
                    title='从工作空间移除此目录'
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              {/* 底部最后一行: 📁⁺ 添加文件夹 (精准还原图 8) */}
              <div
                onClick={handleAddFolder}
                className='h-11 px-3.5 flex items-center gap-3 text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.03] transition-colors cursor-pointer group'
              >
                <FolderPlus size={16} className='text-neutral-400 group-hover:text-blue-400' />
                <span className='text-xs font-medium'>
                  添加文件夹
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Footer: 底部操作栏 (左侧危险移除，右侧取消与保存) */}
        <div className='px-6 py-4 mt-2 border-t border-[#282828] bg-[#191919] flex items-center justify-between'>
          {/* 左侧：移除本地项目 (浅粉/红字按钮，对应图 8) */}
          {onDelete ? (
            <button
              onClick={handleDelete}
              className='px-3.5 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 active:bg-rose-500/30 text-rose-400 border border-rose-500/30 text-xs font-semibold transition-colors'
            >
              移除本地项目
            </button>
          ) : (
            <div />
          )}

          {/* 右侧：取消 与 保存按钮 */}
          <div className='flex items-center gap-2.5'>
            <button
              onClick={onClose}
              disabled={isSaving}
              className='px-4 py-1.5 rounded-xl text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.05] text-xs font-semibold transition-colors'
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className='px-5 py-1.5 rounded-xl bg-neutral-100 hover:bg-white active:bg-neutral-200 text-neutral-900 text-xs font-bold shadow-md transition-all'
            >
              {isSaving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EditWorkspaceModal;
