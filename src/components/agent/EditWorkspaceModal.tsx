import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Folder, FolderPlus } from 'lucide-react';

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

  // 守卫必须置于所有 Hook 之后
  if (!isOpen || !workspace || typeof document === 'undefined') return null;

  // 添加文件夹 (调用系统原生选择目录对话框)
  const handleAddFolder = async () => {
    if (window.electronAPI?.dialogSelectWorkDirectory) {
      const dir = await window.electronAPI.dialogSelectWorkDirectory();
      if (dir) {
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

  const handleRemoveFolder = (index: number) => {
    setFolders((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      if (prev[index]?.isPrimary && next.length > 0) {
        next[0].isPrimary = true;
      }
      return next;
    });
  };

  const handleSetPrimary = (index: number) => {
    setFolders((prev) =>
      prev.map((f, idx) => ({
        ...f,
        isPrimary: idx === index,
      }))
    );
  };

  const handleSave = async () => {
    if (isSaving) return;
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

  // 通过 createPortal 挂载至 document.body 顶层，使用 z-[99999] 彻底杜绝任何头部与侧边栏穿透
  return createPortal(
    <div className='fixed inset-0 z-[99999] bg-black/65 backdrop-blur-sm flex items-center justify-center p-4 select-none animate-in fade-in duration-150'>
      {/* 弹窗主体卡片 (双主题原生适配) */}
      <div className='w-full max-w-[520px] bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl flex flex-col overflow-hidden text-[var(--ui-text-primary)]'>
        {/* 1. Header: 标题 + 关闭按钮 */}
        <div className='px-6 pt-5 pb-3 flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)]'>
          <h2 className='text-base font-bold text-[var(--ui-text-primary)] tracking-tight'>
            编辑项目
          </h2>
          <button
            onClick={onClose}
            className='w-7 h-7 flex items-center justify-center rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors'
          >
            <X size={16} />
          </button>
        </div>

        {/* 2. Body: 工作空间名称输入框 + 源文件夹列表卡片 */}
        <div className='px-6 py-4 flex flex-col gap-4'>
          {/* 项目名称输入框 (左侧带独立方块 📁 图标) */}
          <div className='flex items-center h-11 rounded-xl bg-[var(--ui-card-inner-bg)] border-2 border-[color:var(--ui-accent-blue-border)] focus-within:border-[color:var(--ui-accent-blue)] overflow-hidden shadow-sm transition-colors'>
            <div className='w-11 h-full border-r border-[color:var(--ui-border-hairline)] bg-[var(--ui-chip-bg)] flex items-center justify-center text-[var(--ui-text-secondary)] flex-shrink-0'>
              <Folder size={18} />
            </div>
            <input
              type='text'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='工作空间名称'
              className='flex-1 h-full bg-transparent px-3 text-sm font-medium text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none'
            />
          </div>

          {/* 源文件夹列表区块 */}
          <div className='flex flex-col gap-2'>
            <span className='text-xs font-semibold text-[var(--ui-text-muted)]'>
              源文件夹
            </span>

            <div className='rounded-xl border border-[color:var(--ui-border-hairline)] bg-[var(--ui-card-inner-bg)] divide-y divide-[color:var(--ui-divider-hairline)] overflow-hidden'>
              {/* 各文件夹列表项 */}
              {folders.map((folder, idx) => (
                <div
                  key={`${folder.path}-${idx}`}
                  className='h-11 px-3.5 flex items-center justify-between group hover:bg-[var(--ui-block-hover-bg)] transition-colors'
                >
                  <div className='flex items-center gap-3 min-w-0 pr-2'>
                    <Folder size={16} className='text-[var(--ui-text-muted)] flex-shrink-0' />
                    <span
                      className='text-xs font-medium text-[var(--ui-text-primary)] truncate cursor-pointer hover:text-[var(--ui-accent-blue)]'
                      title={folder.path}
                    >
                      {folder.name}
                    </span>
                    {/* 主要 (Primary) 胶囊徽章 */}
                    {folder.isPrimary ? (
                      <span className='px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-hairline)] flex-shrink-0'>
                        主要
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSetPrimary(idx)}
                        className='text-[10px] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-blue)] opacity-0 group-hover:opacity-100 transition-opacity'
                        title='设为主要文件夹'
                      >
                        设为主目录
                      </button>
                    )}
                  </div>

                  {/* 移除该文件夹按钮 ✕ */}
                  <button
                    onClick={() => handleRemoveFolder(idx)}
                    className='w-6 h-6 flex items-center justify-center rounded text-[var(--ui-text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors flex-shrink-0'
                    title='从工作空间移除此目录'
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              {/* 底部最后一行: 📁⁺ 添加文件夹 */}
              <div
                onClick={handleAddFolder}
                className='h-11 px-3.5 flex items-center gap-3 text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer group'
              >
                <FolderPlus size={16} className='text-[var(--ui-text-muted)] group-hover:text-[var(--ui-accent-blue)]' />
                <span className='text-xs font-medium'>
                  添加文件夹
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Footer: 底部操作栏 (左侧危险移除，右侧取消与保存) */}
        <div className='px-6 py-4 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between'>
          {/* 左侧：移除本地项目 */}
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
              className='px-4 py-1.5 rounded-xl text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] text-xs font-semibold transition-colors'
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className='px-5 py-1.5 rounded-xl bg-[var(--ui-text-primary)] text-[var(--ui-app-bg)] hover:opacity-90 active:scale-95 text-xs font-bold shadow-md transition-all'
            >
              {isSaving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default EditWorkspaceModal;
