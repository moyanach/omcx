import React, { useMemo, useState } from 'react';
import {
  ListTodo,
  CheckCircle2,
  Circle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoListCardProps {
  todos: TodoItem[];
  isActive?: boolean;
}

/**
 * TodoListCard — 紧凑型可折叠任务规划进度条卡片 (ZCode / DSH 风格)
 * 存在任务规划时默认展开清单，直观呈现各阶段状态与进度；支持点击顶栏手动折叠
 */
export const TodoListCard: React.FC<TodoListCardProps> = ({ todos, isActive = false }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  // 历史持久化数据可能包含 null / 非字符串字段，统一做安全归一化，杜绝渲染期 TypeError 击穿整棵 React 树
  const safeTodos: TodoItem[] = useMemo(() => {
    if (!Array.isArray(todos)) return [];
    return todos
      .filter((item) => item && typeof item === 'object')
      .map((item: any, index) => ({
        id: item.id ? String(item.id) : `td_fallback_${index + 1}`,
        text:
          typeof item.text === 'string'
            ? item.text
            : String(item.text ?? item.content ?? ''),
        status:
          item.status === 'completed' || item.status === 'in_progress'
            ? item.status
            : 'pending',
      }))
      .filter((item) => item.text.trim().length > 0);
  }, [todos]);

  if (safeTodos.length === 0) return null;

  const completedCount = safeTodos.filter((t) => t.status === 'completed').length;
  const totalCount = safeTodos.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const activeTodo = safeTodos.find((t) => t.status === 'in_progress');
  const allCompleted = completedCount === totalCount;

  return (
    <div className='mb-1.5 w-full max-w-full select-none'>
      {/* 紧凑单行顶栏 */}
      <div
        onClick={() => setIsExpanded((v) => !v)}
        className='py-1 flex items-center justify-between gap-3 cursor-pointer text-[var(--ui-text-muted)] hover:text-[var(--ui-text-secondary)] transition-colors'
      >
        <div className='flex items-center gap-2 min-w-0'>
          <div
            className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${
              allCompleted
                ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]'
                : 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'
            }`}
          >
            {allCompleted ? (
              <CheckCircle2 size={11} />
            ) : activeTodo && isActive ? (
              <Loader2 size={11} className='animate-spin' />
            ) : (
              <ListTodo size={11} />
            )}
          </div>

          <span className='text-xs font-semibold text-[var(--ui-text-secondary)] flex-shrink-0'>
            任务规划
          </span>

          <span className='text-[11px] text-[var(--ui-text-muted)] truncate'>
            {activeTodo
              ? `当前: ${activeTodo.text}`
              : allCompleted
              ? '全部任务已完成'
              : `待执行 (${totalCount - completedCount} 项)`}
          </span>
        </div>

        <div className='flex items-center gap-2 flex-shrink-0'>
          <span className='text-[10px] font-mono text-[var(--ui-text-muted)]'>
            {completedCount}/{totalCount}
          </span>
          <div className='w-14 h-1.5 rounded-full bg-[var(--ui-chip-bg)] overflow-hidden'>
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                allCompleted ? 'bg-emerald-500' : 'bg-blue-500'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className='text-[var(--ui-text-faint)]'>
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </div>
        </div>
      </div>

      {/* 展开后的详细清单 */}
      {isExpanded && (
        <div className='py-1 border-t border-[color:var(--ui-divider-hairline)] flex flex-col gap-1'>
          {safeTodos.map((item, idx) => {
            const isDone = item.status === 'completed';
            const isRunning = item.status === 'in_progress';

            return (
              <div
                key={item.id || idx}
                className={`flex items-center justify-between py-1 px-2 rounded-lg text-xs transition-colors ${
                  isRunning
                    ? 'bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)]'
                    : 'hover:bg-[var(--ui-block-hover-bg)]'
                }`}
              >
                <div className='flex items-center gap-2 min-w-0 pr-2'>
                  {isDone ? (
                    <CheckCircle2 size={12} className='text-[var(--ui-accent-emerald)] flex-shrink-0' />
                  ) : isRunning && isActive ? (
                    <Loader2 size={12} className='text-[var(--ui-accent-blue)] animate-spin flex-shrink-0' />
                  ) : (
                    <Circle size={12} className='text-[var(--ui-text-faint)] flex-shrink-0' />
                  )}

                  <span
                    className={`truncate ${
                      isDone
                        ? 'text-[var(--ui-text-faint)] line-through'
                        : isRunning
                        ? 'text-[var(--ui-accent-blue)] font-medium'
                        : 'text-[var(--ui-text-secondary)]'
                    }`}
                  >
                    {item.text}
                  </span>
                </div>

                <span
                  className={`text-[10px] font-mono px-1.5 py-0.2 rounded flex-shrink-0 ${
                    isDone
                      ? 'text-[var(--ui-accent-emerald)]'
                      : isRunning
                      ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'
                      : 'text-[var(--ui-text-faint)]'
                  }`}
                >
                  {isDone ? '已完成' : isRunning ? '进行中' : '待办'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TodoListCard;
