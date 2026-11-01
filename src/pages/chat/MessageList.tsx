import React, { useRef, useEffect, useState } from 'react';
import {
  Copy,
  RotateCw,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronRight,
  ChevronDown,
  Globe,
  FileCode,
  FolderTree,
  Terminal,
  Edit3,
  Search,
  Check,
  Loader2,
} from 'lucide-react';
import { Message, useChatStore } from '../../stores/chatStore';
import MarkdownContent from '@/components/common/MarkdownContent';
import TodoListCard, { TodoItem } from '@/components/agent/TodoListCard';

interface ToolStatusEvent {
  tool: string;
  status: 'running' | 'done';
  args: any;
  result?: any;
  callId?: string;
}

interface Props {
  messages: Message[];
  isGenerating: boolean;
  activeSearchProgress: any;
  activeToolCalls: ToolStatusEvent[];
  activeTodos?: TodoItem[];
  onCopy: (text: string) => void;
  onRetry: (msg: Message) => void;
}

const WaitingMessage: React.FC = () => (
  <div className='flex items-center gap-2 text-xs text-neutral-400 py-1'>
    <div className='h-3.5 w-3.5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin' />
    <span>正在深入思考并组织方案...</span>
  </div>
);

/**
 * 提取工具调用的自然语言关键语义 (入参提取)
 */
function getToolStepSummary(tool: string, args: any) {
  if (!args) return { title: tool, subtitle: '' };

  switch (tool) {
    case 'read_file':
      return {
        title: `读取文件 ${args.path ? args.path.split(/[\\/]/).pop() : ''}`,
        subtitle: args.path || '',
        icon: FileCode,
      };
    case 'edit_file':
      return {
        title: `修改代码 ${args.path ? args.path.split(/[\\/]/).pop() : ''}`,
        subtitle: args.path || '',
        icon: Edit3,
      };
    case 'write_file':
      return {
        title: `创建文件 ${args.path ? args.path.split(/[\\/]/).pop() : ''}`,
        subtitle: args.path || '',
        icon: FileCode,
      };
    case 'search_code':
      return {
        title: `搜索代码 "${args.query || args.pattern || ''}"`,
        subtitle: args.path ? `在 ${args.path} 中` : '',
        icon: Search,
      };
    case 'list_directory':
      return {
        title: `浏览项目目录`,
        subtitle: args.path || '.',
        icon: FolderTree,
      };
    case 'run_command':
      return {
        title: `执行命令`,
        subtitle: args.command ? args.command.slice(0, 80) : '',
        icon: Terminal,
      };
    case 'web_search':
      return {
        title: `联网检索`,
        subtitle: args.query || '',
        icon: Globe,
      };
    case 'web_fetch':
      return {
        title: `抓取网页正文`,
        subtitle: args.url ? args.url.replace(/^https?:\/\//, '').slice(0, 60) : '',
        icon: Globe,
      };
    default:
      return {
        title: `调用工具 ${tool}`,
        subtitle: '',
        icon: Terminal,
      };
  }
}

/**
 * 提取工具返回的关键输出摘要 (不展示裸长 JSON)
 */
function getToolOutputSummary(result: any) {
  if (!result) return '';
  if (result.error) return `失败: ${result.error}`;
  if (result.data) {
    const d = result.data;
    if (d.replacedOccurrences) return `成功替换 ${d.replacedOccurrences} 处代码片段 (${d.lineDelta || '0'})`;
    if (d.totalLines) return `共 ${d.totalLines} 行`;
    if (d.matchesCount !== undefined) return `找到 ${d.matchesCount} 处匹配`;
    if (d.entries) return `共 ${d.entries.length} 个文件/子目录`;
    if (d.stdout) return d.stdout.trim().split('\n').pop() || '执行完成';
    if (typeof d === 'string') return d.slice(0, 100);
  }
  if (result.success) return '执行完成';
  return '';
}

/**
 * 现代化可折叠 Step List (默认展开，支持详细/简略双模式设置)
 */
const ToolStepList: React.FC<{ events: ToolStatusEvent[] }> = ({ events }) => {
  const [isExpanded, setIsExpanded] = useState(true); // 默认整体展开
  const stepDisplayStyle = useChatStore((s) => s.stepDisplayStyle) || 'detailed';

  // 记录用户手动折叠的步骤下标 (当为 detailed 模式时默认不折叠)
  const [toggledStepMap, setToggledStepMap] = useState<Record<number, boolean>>({});

  if (events.length === 0) return null;

  const runningCount = events.filter((e) => e.status === 'running').length;

  const toggleStep = (idx: number) => {
    setToggledStepMap((prev) => ({
      ...prev,
      [idx]: !prev[idx],
    }));
  };

  return (
    <div className='mb-3 w-full max-w-full bg-[#1a1a1a] border border-[#2b2b2b] rounded-xl overflow-hidden select-none shadow-sm'>
      {/* 步进列表总状态栏 (默认展开，可一键全收起/全展开) */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className='px-3.5 py-2 flex items-center justify-between cursor-pointer hover:bg-white/[0.02] transition-colors border-b border-[#242424]'
      >
        <div className='flex items-center gap-2'>
          {runningCount > 0 ? (
            <Loader2 size={13} className='text-blue-400 animate-spin' />
          ) : (
            <CheckCircle2 size={13} className='text-emerald-400' />
          )}
          <span className='text-xs font-semibold text-neutral-300'>
            {runningCount > 0 ? `正在执行工具操作 (${events.length} 步)...` : `已执行 ${events.length} 个步骤`}
          </span>
          <span className='text-[10px] px-1.5 py-0.2 rounded bg-[#252525] text-neutral-400 border border-[#333] font-mono'>
            {stepDisplayStyle === 'detailed' ? '详细模式' : '简略模式'}
          </span>
        </div>

        <div className='flex items-center gap-1 text-[11px] text-neutral-500 font-mono'>
          <span>{isExpanded ? '收起全部' : '展开全部'}</span>
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </div>

      {/* 展开的精巧步骤列表 (默认展开全部步骤详细信息) */}
      {isExpanded && (
        <div className='p-2 flex flex-col gap-1.5 divide-y divide-[#242424]'>
          {events.map((ev, idx) => {
            const isRunning = ev.status === 'running';
            const isDone = ev.status === 'done';
            const isSuccess = ev.result?.success !== false;
            const { title, subtitle, icon: StepIcon } = getToolStepSummary(ev.tool, ev.args);
            const outputSummary = getToolOutputSummary(ev.result);

            // 用户要求：每一步调用信息展示先默认折叠起来，点击该步骤才展开详情
            const isStepOpen = Boolean(toggledStepMap[idx]);

            return (
              <div key={`${ev.tool}-${ev.callId || idx}`} className='pt-1.5 first:pt-0'>
                <div
                  onClick={() => toggleStep(idx)}
                  className='flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.03] cursor-pointer transition-colors text-xs'
                >
                  {/* 左侧图标与主要意图标题 */}
                  <div className='flex items-center gap-2.5 min-w-0 pr-2'>
                    {isRunning ? (
                      <Loader2 size={12} className='text-blue-400 animate-spin flex-shrink-0' />
                    ) : isSuccess ? (
                      <CheckCircle2 size={12} className='text-emerald-400 flex-shrink-0' />
                    ) : (
                      <XCircle size={12} className='text-rose-400 flex-shrink-0' />
                    )}

                    <div className='flex items-center gap-2 min-w-0'>
                      <span className='font-medium text-neutral-200 truncate'>{title}</span>
                      {subtitle && (
                        <span className='text-[10px] text-neutral-500 font-mono truncate max-w-[220px]'>
                          {subtitle}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 右侧输出摘要与折叠箭头 */}
                  <div className='flex items-center gap-2 flex-shrink-0'>
                    {outputSummary && !isStepOpen && (
                      <span className='text-[10px] font-mono text-neutral-400 bg-[#222] px-1.5 py-0.5 rounded border border-[#2e2e2e] truncate max-w-[160px]'>
                        {outputSummary}
                      </span>
                    )}
                    <div className='text-neutral-500'>
                      {isStepOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </div>
                  </div>
                </div>

                {/* 每一步调用的详细信息 (默认展示，详尽参数与输出结果) */}
                {isStepOpen && (
                  <div className='mt-1 mb-2 mx-2 p-2.5 rounded-xl bg-[#141414] border border-[#282828] text-[11px] font-mono text-neutral-300 flex flex-col gap-2'>
                    {/* 输入参数详情 */}
                    {ev.args && (
                      <div className='flex flex-col gap-1'>
                        <span className='text-neutral-500 font-sans text-[10px] font-semibold uppercase tracking-wider'>
                          输入参数 (Arguments):
                        </span>
                        <pre className='p-2 rounded-lg bg-[#0e0e0e] border border-[#222] text-neutral-300 text-[10.5px] leading-relaxed max-h-32 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-all'>
                          {typeof ev.args === 'object'
                            ? JSON.stringify(ev.args, null, 2)
                            : String(ev.args)}
                        </pre>
                      </div>
                    )}

                    {/* 执行输出结果 */}
                    {ev.result && (
                      <div className='flex flex-col gap-1 pt-1 border-t border-[#222]'>
                        <span className='text-neutral-500 font-sans text-[10px] font-semibold uppercase tracking-wider'>
                          执行反馈 (Result):
                        </span>
                        <div
                          className={`p-2 rounded-lg bg-[#0e0e0e] border border-[#222] text-[10.5px] leading-relaxed max-h-32 overflow-y-auto custom-scrollbar break-all ${
                            isSuccess ? 'text-neutral-300' : 'text-rose-400'
                          }`}
                        >
                          {ev.result.error ? (
                            <span className='text-rose-400 font-medium'>{ev.result.error}</span>
                          ) : typeof ev.result.data === 'object' ? (
                            <pre className='whitespace-pre-wrap'>
                              {JSON.stringify(ev.result.data, null, 2)}
                            </pre>
                          ) : (
                            String(ev.result.data || outputSummary || '成功完成')
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * 网页引用来源折叠卡片
 */
const ReferenceLinks: React.FC<{ metadata: any[] }> = ({ metadata }) => (
  <div className='mb-3 w-full max-w-full'>
    <details className='group bg-[#1c1c1c] rounded-xl border border-[#2a2a2a] text-xs overflow-hidden transition-all'>
      <summary className='flex items-center justify-between p-2.5 font-medium text-neutral-400 cursor-pointer hover:bg-white/[0.02] outline-none select-none transition-colors'>
        <div className='flex items-center gap-1.5'>
          <Globe size={13} className='text-blue-400' />
          <span>参考权威来源 ({metadata.length})</span>
        </div>
        <span className='text-[10px] text-neutral-500 transition-transform duration-200 group-open:rotate-180'>
          ▼
        </span>
      </summary>
      <div className='p-2.5 border-t border-[#262626] space-y-1.5 bg-[#171717]'>
        {metadata.map((ref: any, idx: number) => {
          let hostname = '';
          try {
            hostname = new URL(ref.url).hostname;
          } catch {
            hostname = 'link';
          }
          return (
            <a
              key={idx}
              href={ref.url}
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center justify-between hover:bg-blue-500/10 p-1.5 rounded-lg text-neutral-300 hover:text-blue-400 transition-all font-medium border border-transparent hover:border-blue-500/20 group/link'
            >
              <span className='truncate max-w-[80%] flex items-center gap-1.5'>
                <span className='w-4 h-4 rounded-full bg-[#202020] text-[10px] flex items-center justify-center font-bold text-blue-400 flex-shrink-0'>
                  {idx + 1}
                </span>
                <span className='truncate font-sans text-xs'>{ref.title || ref.url}</span>
              </span>
              <span className='text-[10px] text-neutral-500 font-mono group-hover/link:text-blue-400'>
                {hostname} ↗
              </span>
            </a>
          );
        })}
      </div>
    </details>
  </div>
);

const MessageBubble: React.FC<{
  msg: Message;
  isLast: boolean;
  activeToolCalls: ToolStatusEvent[];
  activeTodos?: TodoItem[];
  containerWidth: number;
  onCopy: (text: string) => void;
  onRetry: (msg: Message) => void;
  isGenerating: boolean;
}> = ({
  msg,
  isLast,
  activeToolCalls,
  activeTodos,
  containerWidth,
  onCopy,
  onRetry,
  isGenerating,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyText = () => {
    onCopy(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isUser = msg.role === 'user';
  const durationFormatted = msg.metadata?.durationFormatted;
  const hasContent = Boolean(msg.content && msg.content.trim().length > 0);

  // 既支持正在执行的活跃步骤，也支持切菜单或重启后从持久化 metadata.toolSteps 还原的历史步骤
  const displayToolEvents =
    !isUser && activeToolCalls.length > 0 && isLast
      ? activeToolCalls
      : Array.isArray(msg.metadata?.toolSteps)
      ? msg.metadata.toolSteps
      : [];

  // 待办任务规划清单：支持实时生成流转与历史从 metadata.todos 还原
  const displayTodos: TodoItem[] =
    !isUser && activeTodos && activeTodos.length > 0 && isLast
      ? activeTodos
      : Array.isArray(msg.metadata?.todos)
      ? msg.metadata.todos
      : [];

  return (
    <div className={`group flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} w-full max-w-full min-w-0`}>
        {/* Assistant 回复顶端：用时展示指示条 (100% 还原图 15 的 "用时 1m 23s >") */}
        {!isUser && durationFormatted && (
          <div className='flex items-center gap-1 text-[11px] text-neutral-500 font-mono mb-1.5 px-1 select-none hover:text-neutral-400 transition-colors'>
            <Clock size={11} className='text-neutral-500' />
            <span>用时 {durationFormatted}</span>
            <ChevronRight size={11} className='text-neutral-600' />
          </div>
        )}

        {/* 等待中动画 (仅在工具尚未执行且无文字时显示) */}
        {!isUser && isGenerating && isLast && !hasContent && displayToolEvents.length === 0 && (
          <div className='mb-2'>
            <WaitingMessage />
          </div>
        )}

        {/* 工具执行步进可折叠列表 (实时与历史全量留存还原) */}
        {!isUser && displayToolEvents.length > 0 && (
          <ToolStepList events={displayToolEvents} />
        )}

        {/* 任务规划待办清单 (TodoListCard) 始终严格锚定在步骤列表正下方！ */}
        {!isUser && displayTodos.length > 0 && (
          <TodoListCard todos={displayTodos} />
        )}

        {/* 网页权威引用来源 */}
        {!isUser && Array.isArray(msg.metadata?.sources) && msg.metadata.sources.length > 0 && (
          <ReferenceLinks metadata={msg.metadata.sources} />
        )}

        {/* 用户消息附带的图片缩略图 */}
        {isUser && Array.isArray(msg.metadata?.attachments) && msg.metadata.attachments.length > 0 && (
          <div className='flex flex-wrap gap-2 justify-end mb-2 max-w-[85%]'>
            {msg.metadata.attachments.map((att: any) => (
              <button
                key={att.id || att.path}
                onClick={() => window.electronAPI?.showInFolder?.(att.path)}
                className='w-24 h-24 rounded-xl overflow-hidden border border-[#353535] bg-[#1a1a1a] hover:border-blue-500/50 transition-colors cursor-pointer'
                title={`${att.name || "图片"} · 点击在 Finder 中显示`}
              >
                <img
                  src={`local-media://${encodeURI(att.path)}`}
                  alt={att.name || "图片"}
                  className='w-full h-full object-cover'
                />
              </button>
            ))}
          </div>
        )}

        {/* 气泡本体（胶囊包裹）：
            - 用户气泡：全圆角质感胶囊（rounded-2xl），靠右停靠，max-w-[85%]
            - 助手气泡：圆润大卡片（rounded-2xl），宽度 w-full 自然占满，内边距丰满舒适
        */}
        {isUser ? (
          <div className='px-4 py-2.5 text-sm leading-relaxed shadow-sm break-words bg-[#282828] text-neutral-200 border border-[#383838] rounded-2xl whitespace-pre-wrap font-sans max-w-[85%]'>
            {msg.content}
          </div>
        ) : hasContent ? (
          <div className='px-5 py-3.5 text-sm leading-relaxed shadow-sm break-words bg-[#1e1e1e] text-neutral-100 border border-[#2c2c2c] rounded-2xl w-full'>
            <MarkdownContent content={msg.content} />
          </div>
        ) : null}

        {/* 悬浮操作栏 (仅在有内容时展现) */}
        {(hasContent || isUser) && (
          <div className='flex gap-1.5 mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity'>
            <button
              onClick={handleCopyText}
              className='p-1 hover:bg-white/[0.06] rounded-md text-neutral-500 hover:text-neutral-300 transition-colors flex items-center gap-1 text-[11px]'
              title='复制内容'
            >
              {copied ? <Check size={11} className='text-emerald-400' /> : <Copy size={11} />}
              {copied && <span className='text-[10px] text-emerald-400'>已复制</span>}
            </button>
            {!isUser && (
              <button
                onClick={() => onRetry(msg)}
                className='p-1 hover:bg-white/[0.06] rounded-md text-neutral-500 hover:text-neutral-300 transition-colors'
                title='重新生成'
              >
                <RotateCw size={11} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const MessageList: React.FC<Props> = ({
  messages,
  isGenerating,
  activeToolCalls,
  activeTodos = [],
  onCopy,
  onRetry,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isGenerating, activeToolCalls]);

  useEffect(() => {
    if (!scrollRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      className='flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5 custom-scrollbar min-h-0'
    >
      {messages.map((msg, idx) => (
        <MessageBubble
          key={msg.id}
          msg={msg}
          isLast={idx === messages.length - 1}
          activeToolCalls={idx === messages.length - 1 ? activeToolCalls : []}
          activeTodos={idx === messages.length - 1 ? activeTodos : []}
          containerWidth={containerWidth}
          onCopy={onCopy}
          onRetry={onRetry}
          isGenerating={isGenerating}
        />
      ))}
    </div>
  );
};

export default MessageList;
