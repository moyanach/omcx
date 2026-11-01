import React from 'react';
import { ListTodo, CheckCircle2, Circle, Loader2 } from 'lucide-react';

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoListCardProps {
  todos: TodoItem[];
}

/**
 * TodoListCard — 任务规划待办清单卡片
 * 始终锚定在执行步骤列表 (ToolStepList) 的正下方，随步骤滚动始终处于视野下方，实时呈现任务规划与阶段进度
 */
export const TodoListCard: React.FC<TodoListCardProps> = ({ todos }) => {
  if (!todos || todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  return (
    <div className='mb-4 w-full max-w-full bg-[#1c1c1c] border border-[#2d2d2d] rounded-xl overflow-hidden select-none shadow-md transition-all animate-in fade-in duration-200'>
      {/* 头部状态与进度 */}
      <div className='px-4 py-2.5 bg-[#202020] border-b border-[#282828] flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <div className='w-5 h-5 rounded-md bg-blue-500/15 text-blue-400 flex items-center justify-center flex-shrink-0'>
            <ListTodo size={13} />
          </div>
          <span className='text-xs font-bold text-neutral-200 tracking-wide'>
            任务规划待办清单 (Todo List)
          </span>
        </div>

        <div className='flex items-center gap-2'>
          <span className='text-[11px] font-mono text-neutral-400'>
            {completedCount}/{totalCount}
          </span>
          <div className='w-16 h-1.5 rounded-full bg-[#2a2a2a] overflow-hidden'>
            <div
              className='h-full bg-blue-500 rounded-full transition-all duration-300'
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* 待办事项逐条展示 */}
      <div className='p-3 flex flex-col gap-2'>
        {todos.map((item, idx) => {
          const isDone = item.status === 'completed';
          const isRunning = item.status === 'in_progress';

          return (
            <div
              key={item.id || idx}
              className={`flex items-center justify-between py-1.5 px-2.5 rounded-lg text-xs transition-colors ${
                isRunning
                  ? 'bg-blue-500/10 border border-blue-500/25 shadow-sm'
                  : 'hover:bg-white/[0.02] border border-transparent'
              }`}
            >
              <div className='flex items-center gap-2.5 min-w-0 pr-2'>
                {/* 状态图标 */}
                {isDone ? (
                  <CheckCircle2 size={13} className='text-emerald-400 flex-shrink-0' />
                ) : isRunning ? (
                  <Loader2 size={13} className='text-blue-400 animate-spin flex-shrink-0' />
                ) : (
                  <Circle size={13} className='text-neutral-500 flex-shrink-0' />
                )}

                {/* 任务文本 */}
                <span
                  className={`truncate font-medium transition-colors ${
                    isDone
                      ? 'text-neutral-400 line-through opacity-85'
                      : isRunning
                      ? 'text-blue-300 font-bold'
                      : 'text-neutral-200'
                  }`}
                >
                  {item.text}
                </span>
              </div>

              {/* 右侧阶段状态指示 */}
              <span
                className={`text-[10px] font-mono px-1.5 py-0.2 rounded flex-shrink-0 ${
                  isDone
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : isRunning
                    ? 'bg-blue-500/20 text-blue-400 font-bold'
                    : 'text-neutral-400'
                }`}
              >
                {isDone ? '已完成' : isRunning ? '进行中' : '待办'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TodoListCard;
