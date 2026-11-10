import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  GitBranch,
  Search,
  Check,
  Plus,
  Loader2,
  X,
  AlertCircle,
} from 'lucide-react';

export interface BranchItem {
  name: string;
  isCurrent: boolean;
}

interface Props {
  workDir: string;
  folderName: string;
  currentBranch?: string;
  anchorEl: HTMLElement | null;
  isOpen: boolean;
  onClose: () => void;
  onBranchSwitched: (newBranch: string) => void;
}

export const BranchSwitchPopover: React.FC<Props> = ({
  workDir,
  folderName,
  currentBranch,
  anchorEl,
  isOpen,
  onClose,
  onBranchSwitched,
}) => {
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // 新建分支模式
  const [isCreating, setIsCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [creatingLoading, setCreatingLoading] = useState(false);

  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  // 1. 加载分支列表
  useEffect(() => {
    let alive = true;
    if (isOpen && workDir && window.electronAPI?.getWorkspaceBranches) {
      setLoading(true);
      setErrorMsg('');
      setSearchQuery('');
      setIsCreating(false);
      setNewBranchName('');

      window.electronAPI
        .getWorkspaceBranches(workDir)
        .then((res: any) => {
          if (!alive) return;
          if (res?.success && Array.isArray(res.branches)) {
            setBranches(res.branches);
          } else {
            setErrorMsg(res?.error || '无法获取分支列表');
          }
        })
        .catch((err: any) => {
          if (!alive) return;
          setErrorMsg(err?.message || '读取分支失败');
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }
    return () => {
      alive = false;
    };
  }, [isOpen, workDir]);

  // 2. 自动聚焦搜索框
  useEffect(() => {
    if (isOpen && !loading) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen, loading]);

  // 3. 点击外部或按 Esc 自动关闭
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorEl &&
        !anchorEl.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, anchorEl]);

  // 4. 计算浮层自适应绝对像素位置
  const coords = useMemo(() => {
    if (!anchorEl || !isOpen) return null;
    const rect = anchorEl.getBoundingClientRect();
    const width = 290;
    const margin = 12;
    const gap = 6;
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    let left = rect.right - width;
    if (left < margin) left = margin;
    if (left + width > vw - margin) left = vw - margin - width;

    const spaceBelow = vh - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    const placement: 'below' | 'above' = spaceBelow < 280 && spaceAbove > spaceBelow ? 'above' : 'below';

    return {
      left,
      placement,
      top: placement === 'below' ? rect.bottom + gap : undefined,
      bottom: placement === 'above' ? vh - rect.top + gap : undefined,
    };
  }, [anchorEl, isOpen]);

  // 过滤后的分支列表
  const filteredBranches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, searchQuery]);

  // 切换已有分支
  const handleCheckout = async (branchName: string) => {
    if (switchingBranch || creatingLoading || !workDir) return;
    if (branchName === currentBranch) {
      onClose();
      return;
    }

    setSwitchingBranch(branchName);
    setErrorMsg('');

    try {
      const res = await window.electronAPI.checkoutWorkspaceBranch(workDir, branchName, false);
      if (res?.success) {
        onBranchSwitched(branchName);
        onClose();
      } else {
        setErrorMsg(res?.error || `切换到 ${branchName} 失败`);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || '执行切换失败');
    } finally {
      setSwitchingBranch(null);
    }
  };

  // 创建并检出新分支
  const handleCreateAndCheckout = async () => {
    const target = newBranchName.trim();
    if (!target || creatingLoading || !workDir) return;

    setCreatingLoading(true);
    setErrorMsg('');

    try {
      const res = await window.electronAPI.checkoutWorkspaceBranch(workDir, target, true);
      if (res?.success) {
        onBranchSwitched(target);
        onClose();
      } else {
        setErrorMsg(res?.error || `创建分支 ${target} 失败`);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || '创建分支失败');
    } finally {
      setCreatingLoading(false);
    }
  };

  if (!isOpen || !coords || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        left: coords.left,
        top: coords.top,
        bottom: coords.bottom,
        width: 290,
      }}
      className='z-[99999] rounded-2xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-2xl backdrop-blur-2xl flex flex-col overflow-hidden text-xs select-none animate-in fade-in zoom-in-95 duration-150'
    >
      {/* 1. 顶部搜索框 (完全对齐参考截图) */}
      <div className='p-2.5 border-b border-[color:var(--ui-divider-hairline)]'>
        <div className='relative flex items-center'>
          <Search size={13} className='absolute left-2.5 text-[var(--ui-text-muted)] pointer-events-none' />
          <input
            ref={searchInputRef}
            type='text'
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filteredBranches.length > 0) {
                handleCheckout(filteredBranches[0].name);
              }
            }}
            placeholder={`搜索 ${folderName} 分支`}
            className='w-full pl-8 pr-7 py-1.5 rounded-lg bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] text-xs outline-none focus:border-[color:var(--ui-accent-blue-border)] transition-colors'
          />
          {searchQuery && (
            <button
              type='button'
              onClick={() => setSearchQuery('')}
              className='absolute right-2 text-[var(--ui-text-faint)] hover:text-[var(--ui-text-primary)] p-0.5'
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 错误提示小横条 */}
      {errorMsg && (
        <div className='px-3 py-1.5 bg-rose-500/10 border-b border-rose-500/20 text-[11px] text-rose-400 flex items-start gap-1.5 leading-snug'>
          <AlertCircle size={12} className='flex-shrink-0 mt-0.5' />
          <span className='break-all'>{errorMsg}</span>
        </div>
      )}

      {/* 2. 分支列表区域 */}
      <div className='p-1.5 flex flex-col gap-0.5 max-h-[220px] overflow-y-auto custom-scrollbar'>
        <div className='px-2.5 pt-1 pb-1 text-[10px] font-semibold text-[var(--ui-text-faint)] uppercase tracking-wider flex items-center justify-between'>
          <span>分支</span>
          {!loading && <span className='font-mono'>{filteredBranches.length}</span>}
        </div>

        {loading ? (
          <div className='flex items-center justify-center py-6 text-[var(--ui-text-muted)] gap-2'>
            <Loader2 size={14} className='animate-spin text-[var(--ui-accent-blue)]' />
            <span>读取分支中...</span>
          </div>
        ) : filteredBranches.length === 0 ? (
          <div className='py-6 text-center text-[var(--ui-text-faint)] text-xs'>
            {searchQuery ? '未找到匹配分支' : '暂无可用分支'}
          </div>
        ) : (
          filteredBranches.map((item) => {
            const isCur = item.isCurrent || item.name === currentBranch;
            const isSwitching = switchingBranch === item.name;

            return (
              <button
                key={item.name}
                type='button'
                onClick={() => handleCheckout(item.name)}
                disabled={Boolean(switchingBranch || creatingLoading)}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer group ${
                  isCur
                    ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium'
                    : 'text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-hover-bg)] hover:text-[var(--ui-text-primary)]'
                }`}
                title={item.name}
              >
                <div className='flex items-center gap-2 min-w-0 pr-2'>
                  <GitBranch
                    size={13}
                    className={`flex-shrink-0 ${
                      isCur ? 'text-[var(--ui-accent-blue)]' : 'text-[var(--ui-text-muted)] group-hover:text-[var(--ui-text-primary)]'
                    }`}
                  />
                  <span className='truncate font-mono text-xs'>{item.name}</span>
                </div>

                <div className='flex items-center flex-shrink-0'>
                  {isSwitching ? (
                    <Loader2 size={13} className='animate-spin text-[var(--ui-accent-blue)]' />
                  ) : isCur ? (
                    <Check size={14} className='text-[var(--ui-accent-blue)]' />
                  ) : null}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* 3. 底部操作区：创建并检出新分支 (完全对齐截图) */}
      <div className='p-2 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)]'>
        {isCreating ? (
          <div className='flex flex-col gap-2'>
            <input
              ref={createInputRef}
              type='text'
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateAndCheckout();
                if (e.key === 'Escape') setIsCreating(false);
              }}
              placeholder='输入新分支名称...'
              className='w-full px-2.5 py-1.5 rounded-lg bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] text-xs font-mono outline-none focus:border-[color:var(--ui-accent-blue-border)]'
            />
            <div className='flex items-center justify-end gap-1.5'>
              <button
                type='button'
                onClick={() => setIsCreating(false)}
                className='px-2.5 py-1 rounded-md text-[11px] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors'
              >
                取消
              </button>
              <button
                type='button'
                onClick={handleCreateAndCheckout}
                disabled={!newBranchName.trim() || creatingLoading}
                className='px-3 py-1 rounded-md text-[11px] font-medium bg-[var(--ui-accent-blue)] text-white hover:opacity-90 disabled:opacity-40 transition-all flex items-center gap-1 shadow-sm'
              >
                {creatingLoading && <Loader2 size={11} className='animate-spin' />}
                <span>创建并检出</span>
              </button>
            </div>
          </div>
        ) : (
          <button
            type='button'
            onClick={() => {
              setIsCreating(true);
              setTimeout(() => createInputRef.current?.focus(), 50);
            }}
            className='w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors cursor-pointer text-left'
          >
            <Plus size={13} className='text-[var(--ui-text-muted)]' />
            <span className='font-medium text-xs'>创建并检出新分支...</span>
          </button>
        )}
      </div>
    </div>,
    document.body
  );
};

export default BranchSwitchPopover;
