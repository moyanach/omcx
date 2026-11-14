import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Copy,
  RotateCw,
  XCircle,
  Clock,
  ChevronRight,
  Globe,
  FileCode,
  FileCode2,
  Folder,
  Check,
  FileSpreadsheet,
  FileArchive,
  FileText,
  File as GenericFileIcon,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { Message, useChatStore } from '../../../stores/chatStore';
import MarkdownContent, { ThinkingBlock, LazyThinkingBlock } from '@/components/common/MarkdownContent';
import TodoListCard, { TodoItem } from '@/components/agent/TodoListCard';
import { parseMessageContent } from '@/lib/messageParser';
import { isImageAttachment, classifyAttachment, formatFileSize } from '@/lib/chatAttachment';
import { tokenizeTextWithMentions } from '@/lib/fileMention';
import {
  ImagePreviewLightbox,
  type PreviewImageItem,
} from '@/pages/chat/messageInput/AttachmentPreviewStrip';
import { ToolStatusEvent } from './types';
import { ToolStepList, getToolStepSummary } from './ToolSteps';
import { ModifiedFilesBar } from './ModifiedFilesBar';

function buildLocalMediaUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `local-media://local${encodeURI(prefixed).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

export const AgentLiveStatusBar: React.FC<{
  activeToolCalls: ToolStatusEvent[];
  activeTodos: TodoItem[];
  hasStreamingText: boolean;
}> = ({ activeToolCalls, activeTodos, hasStreamingText }) => {
  const { activeSessionId, sessionStartTimeBySession, waitingBySession } = useChatStore(
    useShallow((s) => ({
      activeSessionId: s.activeSessionId,
      sessionStartTimeBySession: s.sessionStartTimeBySession,
      waitingBySession: s.waitingBySession,
    }))
  );
  const sessionStartTime = activeSessionId ? sessionStartTimeBySession[activeSessionId] : null;
  const waitingSec = activeSessionId ? waitingBySession[activeSessionId] || 0 : 0;

  // 根据会话绝对启动时间戳计算物理流逝秒数：切换会话重新挂载时无缝继承真实时长，彻底杜绝归零重置
  const computeElapsedSec = () => {
    if (!sessionStartTime) return 0;
    return Math.max(0, Math.floor((Date.now() - sessionStartTime) / 1000));
  };

  const [elapsedSec, setElapsedSec] = useState<number>(computeElapsedSec);

  useEffect(() => {
    setElapsedSec(computeElapsedSec());
    const timer = setInterval(() => {
      setElapsedSec(computeElapsedSec());
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  const visibleSteps = activeToolCalls.filter((t) => t.tool !== 'todo_write');
  const runningStep = visibleSteps.slice().reverse().find((t) => t.status === 'running');
  const latestStep = visibleSteps[visibleSteps.length - 1];
  const currentTodo = activeTodos.find((t) => t.status === 'in_progress');

  let statusText = '正在深入思考与规划方案...';
  if (waitingSec >= 15 && !runningStep && !hasStreamingText) {
    statusText =
      waitingSec >= 120
        ? `上游模型已 ${Math.floor(waitingSec / 60)} 分钟无响应，仍在等待（可随时停止）...`
        : `等待上游模型响应 (${waitingSec}s)...`;
  } else if (runningStep) {
    const { title, subtitle } = getToolStepSummary(runningStep.tool, runningStep.args);
    statusText = `正在${title}${subtitle ? ` (${subtitle})` : ''}...`;
  } else if (hasStreamingText) {
    statusText = '正在流式生成分析与代码回复...';
  } else if (latestStep) {
    const { title } = getToolStepSummary(latestStep.tool, latestStep.args);
    statusText = `已完成${title}，正在推进下一步...`;
  }

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s < 10 ? '0' : ''}${s}s` : `${s}s`;
  };

  return (
    <div className='sticky bottom-0 z-10 pt-1 pb-0.5 w-full pointer-events-none'>
      <div className='relative w-full px-1 py-1.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between gap-3 text-xs select-none overflow-hidden'>
        {/* 左侧：微光呼吸图标 + 当前实时动作语义 (已移除雷达同心圆扩散) */}
        <div className='flex items-center gap-2.5 min-w-0 relative z-10'>
          <div className='relative flex items-center justify-center w-4 h-4 flex-shrink-0'>
            <Sparkles size={13} className='text-[var(--ui-accent-blue)] omcx-icon-pulse-glow' />
          </div>
          <span className='font-medium text-[var(--ui-text-primary)] truncate'>{statusText}</span>
        </div>

        {/* 右侧：当前 Todo 阶段 + 步骤计数 + 实时秒表 */}
        <div className='flex items-center gap-2 flex-shrink-0 font-mono text-[11px] relative z-10'>
          {currentTodo && (
            <span className='hidden sm:inline-block text-[var(--ui-accent-blue)] truncate max-w-[180px]'>
              阶段: {currentTodo.text}
            </span>
          )}
          {visibleSteps.length > 0 && (
            <span className='text-[var(--ui-text-muted)]'>
              步骤 {visibleSteps.length}
            </span>
          )}
          <span className='text-[var(--ui-accent-blue)] font-semibold min-w-[36px] text-right'>
            {formatTimer(elapsedSec)}
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * 网页引用来源折叠卡片
 */
export const ReferenceLinks: React.FC<{ metadata: any[] }> = ({ metadata }) => (
  <div className='mb-1.5 w-full max-w-full'>
    <details className='group text-xs'>
      <summary className='flex items-center justify-between py-1 font-medium text-[var(--ui-text-muted)] cursor-pointer hover:text-[var(--ui-text-secondary)] outline-none select-none transition-colors'>
        <div className='flex items-center gap-1.5'>
          <Globe size={13} className='text-[var(--ui-accent-blue)]' />
          <span>参考权威来源 ({metadata.length})</span>
        </div>
        <span className='text-[10px] text-[var(--ui-text-faint)] transition-transform duration-200 group-open:rotate-180'>
          ▼
        </span>
      </summary>
      <div className='py-1 border-t border-[color:var(--ui-divider-hairline)] space-y-0.5'>
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
              className='flex items-center justify-between hover:bg-[var(--ui-accent-blue-soft)] p-1.5 rounded-lg text-[var(--ui-text-secondary)] hover:text-[var(--ui-accent-blue)] transition-all font-medium border border-transparent hover:border-[color:var(--ui-accent-blue-border)] group/link'
            >
              <span className='truncate max-w-[80%] flex items-center gap-1.5'>
                <span className='w-4 h-4 rounded-full bg-[var(--ui-chip-bg)] text-[10px] flex items-center justify-center font-bold text-[var(--ui-accent-blue)] flex-shrink-0'>
                  {idx + 1}
                </span>
                <span className='truncate font-sans text-xs'>{ref.title || ref.url}</span>
              </span>
              <span className='text-[10px] text-[var(--ui-text-faint)] font-mono group-hover/link:text-[var(--ui-accent-blue)]'>
                {hostname} ↗
              </span>
            </a>
          );
        })}
      </div>
    </details>
  </div>
);

const FILE_EXTENSION_RE = /\.[a-zA-Z0-9]{1,8}$/;
const KNOWN_ROOT_FILE_NAMES = new Set([
  'Dockerfile',
  'Makefile',
  'LICENSE',
  'README',
  '.gitignore',
  '.env',
  '.npmrc',
  '.eslintrc',
  '.prettierrc',
]);

function isProbableFileMentionToken(token: string): boolean {
  if (!token) return false;
  if (
    token.startsWith('skill:') ||
    token.startsWith('mcp:') ||
    token.startsWith('agent:') ||
    token.startsWith('http://') ||
    token.startsWith('https://')
  ) {
    return false;
  }
  const clean = token.replace(/\/+$/, '');
  if (!clean || clean === '.' || clean === '..') return false;
  if (token.includes('/')) return true;
  if (KNOWN_ROOT_FILE_NAMES.has(clean)) return true;
  if (FILE_EXTENSION_RE.test(clean) && !/\.(com|cn|org|net|io|dev)$/i.test(clean)) {
    return true;
  }
  return false;
}

const UserFileMentionPill: React.FC<{ token: string; workDir?: string | null }> = ({
  token,
  workDir,
}) => {
  const isDir = token.endsWith('/');
  const cleanPath = token.replace(/\/+$/, '').replace(/^\.\//, '');
  const baseName = cleanPath.split('/').filter(Boolean).pop() || cleanPath;
  const displayLabel = isDir ? `${baseName}/` : baseName;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const isAbs = cleanPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cleanPath);
    const resolvedPath = isAbs
      ? cleanPath
      : workDir
      ? `${workDir.replace(/\/+$/, '')}/${cleanPath}`
      : cleanPath;

    if (isDir || e.metaKey || e.altKey) {
      if (window.electronAPI?.showInFolder && (isAbs || workDir)) {
        window.electronAPI.showInFolder(resolvedPath);
      }
      return;
    }

    if (isAbs || workDir) {
      useChatStore.getState().openFileInWorkbench(cleanPath);
    }
  };

  return (
    <button
      type='button'
      onClick={handleClick}
      className='inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-[var(--ui-accent-blue-soft)] hover:opacity-85 border border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)] font-mono text-[12px] leading-tight align-baseline transition-all cursor-pointer'
      title={
        isDir
          ? `${cleanPath}/（点击在 Finder 中定位）`
          : `${cleanPath}（点击在右侧工作台预览 · 按住 ⌘ 点击在 Finder 中定位）`
      }
    >
      {isDir ? (
        <Folder size={11} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
      ) : (
        <FileCode2 size={11} className='text-[var(--ui-accent-blue)] flex-shrink-0' />
      )}
      <span>{displayLabel}</span>
    </button>
  );
};

export const MessageBubble: React.FC<{
  msg: Message;
  isActiveTurn: boolean;
  activeToolCalls: ToolStatusEvent[];
  activeTodos?: TodoItem[];
  containerWidth: number;
  onCopy: (text: string) => void;
  onRetry: (msg: Message) => void;
  isGenerating: boolean;
  onReportHeight?: (id: string, height: number) => void;
}> = React.memo(
  ({
    msg,
    isActiveTurn,
    activeToolCalls,
    activeTodos,
    containerWidth,
    onCopy,
    onRetry,
    isGenerating,
    onReportHeight,
  }) => {
  const [copied, setCopied] = useState(false);
  const [previewImageIndex, setPreviewImageIndex] = useState<number | null>(null);
  const [brokenImageUrls, setBrokenImageUrls] = useState<Record<string, boolean>>({});
  const bubbleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBrokenImageUrls({});
  }, [msg.id]);
  const activeWorkDir = useChatStore(
    (s) => s.sessions.find((item) => item.id === s.activeSessionId)?.workDir
  );
  const lastReportedHeightRef = useRef(0);
  const reportHeightRef = useRef(onReportHeight);
  reportHeightRef.current = onReportHeight;

  // 测量物理真实高度并上报高度池，供离屏占位容器 1:1 精准对齐。
  // 必须显式声明依赖：此前无依赖数组会在每次渲染（含流式 delta）强制同步回流。
  useEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0 && Math.abs(h - lastReportedHeightRef.current) > 0.5) {
      lastReportedHeightRef.current = h;
      reportHeightRef.current?.(msg.id, h);
    }
  }, [msg.id, msg.content, msg.metadata, isActiveTurn, containerWidth]);

  const handleCopyText = () => {
    onCopy(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isUser = msg.role === 'user';
  const durationFormatted = msg.metadata?.durationFormatted;
  const hasContent = Boolean(msg.content && msg.content.trim().length > 0);

  const { markdownContent } = useMemo(
    () => (isUser ? { markdownContent: msg.content } : parseMessageContent(msg.content)),
    [isUser, msg.content]
  );
  const hasVisibleMarkdown = Boolean(markdownContent && markdownContent.trim().length > 0);

  const userAttachments =
    isUser && Array.isArray(msg.metadata?.attachments) ? msg.metadata.attachments : [];

  const previewableUserImages: Array<{ key: string; item: PreviewImageItem }> = useMemo(() => {
    if (!isUser || userAttachments.length === 0) return [];
    const list: Array<{ key: string; item: PreviewImageItem }> = [];
    userAttachments.forEach((att: any, idx: number) => {
      const attKey = String(att.id || att.path || idx);
      const isImg = isImageAttachment(att.name || '', att.mime || '');
      const imgUrl = att.path ? buildLocalMediaUrl(att.path) : '';
      if (isImg && att.path && !brokenImageUrls[imgUrl]) {
        list.push({
          key: attKey,
          item: {
            src: imgUrl,
            name: att.name || '图片',
            size: att.size,
            filePath: att.path,
          },
        });
      }
    });
    return list;
  }, [isUser, userAttachments, brokenImageUrls]);

  const renderedUserContent = useMemo(() => {
    if (!isUser || !hasContent) return null;
    if (!msg.content.includes('@')) return msg.content;
    const segments = tokenizeTextWithMentions(msg.content);
    return segments.map((seg, idx) => {
      if (seg.type === 'text') {
        return <React.Fragment key={idx}>{seg.value}</React.Fragment>;
      }
      if (!isProbableFileMentionToken(seg.token)) {
        return <React.Fragment key={idx}>{seg.raw}</React.Fragment>;
      }
      return <UserFileMentionPill key={idx} token={seg.token} workDir={activeWorkDir} />;
    });
  }, [isUser, hasContent, msg.content, activeWorkDir]);

  const displayToolEvents =
    !isUser && activeToolCalls.length > 0 && isActiveTurn
      ? activeToolCalls
      : Array.isArray(msg.metadata?.toolSteps)
      ? msg.metadata.toolSteps
      : [];

  const displayTodos: TodoItem[] =
    !isUser && activeTodos && activeTodos.length > 0 && isActiveTurn
      ? activeTodos
      : Array.isArray(msg.metadata?.todos)
      ? msg.metadata.todos
      : [];

  // 思考内容：当前回合来自独立 reasoning 通道，历史回合按需从 reasoning 表拉取
  const liveReasoning = !isUser && typeof msg.reasoning === 'string' ? msg.reasoning.trim() : '';
  const liveThinkingBlocks = liveReasoning ? [liveReasoning] : [];
  const lazyReasoningChars = Number(msg.reasoningChars) > 0 ? Number(msg.reasoningChars) : 0;
  const hasAnyReasoning = liveThinkingBlocks.length > 0 || lazyReasoningChars > 0;

  // 兜底：assistant 回合彻底空响应（无正文 / 无思考 / 无工具步骤），且已不在流式中
  // 关键：仅当整个会话停止生成后才允许判定为"空响应"，否则中途追加 steer 消息会让
  // 仍在工具循环中的 assistant 占位气泡失去 isLast 身份，被误判为请求失败。
  const isStreamingThis = Boolean(isGenerating && isActiveTurn);
  const isInterrupted = Boolean(!isUser && msg.metadata?.interrupted && !isGenerating);
  const isEmptyAssistantTurn =
    !isUser &&
    !isGenerating &&
    !isInterrupted &&
    !isStreamingThis &&
    !hasContent &&
    !hasAnyReasoning &&
    displayToolEvents.length === 0 &&
    displayTodos.length === 0;

  return (
    <div
      ref={bubbleRef}
      id={`msg-bubble-${msg.id}`}
      className={`group flex w-full scroll-mt-6 ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} w-full max-w-full min-w-0`}>
        {/* Assistant 回复顶端：用时展示指示条 */}
        {!isUser && durationFormatted && (
          <div className='flex items-center gap-1 text-[11px] text-[var(--ui-text-faint)] font-mono mb-1.5 px-1 select-none hover:text-[var(--ui-text-muted)] transition-colors'>
            <Clock size={11} className='text-[var(--ui-text-faint)]' />
            <span>用时 {durationFormatted}</span>
            <ChevronRight size={11} className='opacity-70' />
          </div>
        )}

        {/* 0. 中断恢复提示：应用退出/进程异常时主进程已保全部分正文与工具轨迹 */}
        {isInterrupted && (
          <div className='w-full mb-1.5 pl-3 pr-2 py-1.5 border-l-2 border-[color:var(--ui-accent-amber)] bg-[var(--ui-accent-amber-soft)] flex items-start gap-2 text-[11px] leading-relaxed text-[var(--ui-text-secondary)] select-none'>
            <AlertTriangle
              size={13}
              className='text-[var(--ui-accent-amber)] flex-shrink-0 mt-[1px]'
            />
            <span>
              上次执行在应用退出或进程中中断时尚未完成，已保留中断前的正文与工具执行轨迹。可继续追问，或重新执行该任务。
            </span>
          </div>
        )}

        {/* 1. 深度思考内容块（当前回合实时思考，独立通道流入） */}
        {!isUser && liveThinkingBlocks.length > 0 && (
          <ThinkingBlock
            thoughts={liveThinkingBlocks}
            isStreaming={Boolean(isGenerating && isActiveTurn)}
            className='mb-1.5'
          />
        )}

        {/* 1.1 历史思考块：正文已瘦身，展开时按需拉取 */}
        {!isUser && liveThinkingBlocks.length === 0 && lazyReasoningChars > 0 && (
          <LazyThinkingBlock
            messageId={msg.id}
            chars={lazyReasoningChars}
            className='mb-1.5'
          />
        )}

        {/* 1.2 上游截断提示：输出在代码块中途结束 */}
        {!isUser && msg.metadata?.truncated && !isGenerating && (
          <div
            data-testid='truncated-banner'
            className='w-full mb-1.5 pl-3 pr-2 py-1.5 border-l-2 border-[color:var(--ui-accent-amber)] bg-[var(--ui-accent-amber-soft)] flex items-center gap-1.5 text-[11px] text-[var(--ui-text-secondary)] select-none'
          >
            <AlertTriangle size={12} className='text-[var(--ui-accent-amber)] flex-shrink-0' />
            <span>本次输出在代码块中途结束，可能已被上游截断。可重新生成获取完整内容。</span>
          </div>
        )}

        {/* 2. 工具执行步进紧凑组件 */}
        {!isUser && displayToolEvents.length > 0 && (
          <ToolStepList events={displayToolEvents} />
        )}

        {/* 3. 独立外显的文件变更展示区（Hover 在对应位置吸附弹出左右分块 Diff） */}
        {!isUser && displayToolEvents.length > 0 && (
          <ModifiedFilesBar events={displayToolEvents} />
        )}

        {/* 4. 任务规划进度条面板（默认展开） */}
        {!isUser && displayTodos.length > 0 && (
          <TodoListCard todos={displayTodos} isActive={Boolean(isGenerating && isActiveTurn)} />
        )}

        {/* 5. 网页权威引用来源 */}
        {!isUser && Array.isArray(msg.metadata?.sources) && msg.metadata.sources.length > 0 && (
          <ReferenceLinks metadata={msg.metadata.sources} />
        )}

        {/* 用户消息附带的文件/图片附件展示（可实时预览图片点击放大，非图片保持在文件夹中打开） */}
        {isUser && userAttachments.length > 0 && (
          <div className={`flex flex-wrap gap-2 justify-end max-w-[85%] ${hasContent ? 'mb-2' : ''}`}>
            {userAttachments.map((att: any, idx: number) => {
              const attKey = String(att.id || att.path || idx);
              const isImg = isImageAttachment(att.name || '', att.mime || '');
              const category = classifyAttachment(att.name || '', att.mime || '');
              const imgUrl = att.path ? buildLocalMediaUrl(att.path) : '';
              const canPreviewImage = isImg && Boolean(att.path) && !brokenImageUrls[imgUrl];
              const previewIdx = canPreviewImage
                ? previewableUserImages.findIndex((p) => p.key === attKey)
                : -1;

              if (canPreviewImage) {
                return (
                  <button
                    key={attKey}
                    type='button'
                    onClick={() => {
                      if (previewIdx >= 0) {
                        setPreviewImageIndex(previewIdx);
                      } else if (att.path) {
                        window.electronAPI?.showInFolder?.(att.path);
                      }
                    }}
                    className='w-14 h-14 rounded-lg overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-card-inner-bg)] hover:border-[color:var(--ui-accent-blue-border)] transition-colors cursor-zoom-in flex-shrink-0 shadow-sm'
                    title={`${att.name || '图片'} (${formatFileSize(att.size)}) · 点击放大预览`}
                  >
                    <img
                      src={imgUrl}
                      alt={att.name || '图片'}
                      className='w-full h-full object-cover'
                      onError={() =>
                        setBrokenImageUrls((prev) => ({
                          ...prev,
                          [imgUrl]: true,
                        }))
                      }
                    />
                  </button>
                );
              }

              return (
                <button
                  key={attKey}
                  type='button'
                  onClick={() => att.path && window.electronAPI?.showInFolder?.(att.path)}
                  className='flex items-center gap-2.5 px-3 py-2 rounded-xl border border-[color:var(--ui-border-hairline)] bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] hover:border-[color:var(--ui-accent-blue-border)] transition-all cursor-pointer shadow-sm text-left max-w-[240px]'
                  title={`${att.name || '附件'} (${formatFileSize(att.size)}) · 点击在 Finder 中显示`}
                >
                  <div className='w-7 h-7 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center flex-shrink-0'>
                    {category === 'spreadsheet' && (
                      <FileSpreadsheet size={15} className='text-[var(--ui-accent-emerald)]' />
                    )}
                    {category === 'text' && (
                      <FileCode size={15} className='text-[var(--ui-accent-blue)]' />
                    )}
                    {category === 'document' && (
                      <FileText size={15} className='text-[var(--ui-accent-rose)]' />
                    )}
                    {category === 'archive' && (
                      <FileArchive size={15} className='text-[var(--ui-accent-amber)]' />
                    )}
                    {(category === 'binary' || category === 'image') && (
                      <GenericFileIcon size={15} className='text-[var(--ui-accent-purple)]' />
                    )}
                  </div>
                  <div className='flex flex-col min-w-0'>
                    <span className='text-xs font-medium text-[var(--ui-text-primary)] truncate'>
                      {att.name}
                    </span>
                    <span className='text-[10px] text-[var(--ui-text-faint)] font-mono'>
                      {formatFileSize(att.size)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* 气泡本体 */}
        {isUser ? (
          hasContent ? (
            <div className='px-4 py-2.5 text-sm leading-relaxed break-words bg-[var(--ui-bubble-user-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-primary)] rounded-2xl whitespace-pre-wrap font-sans max-w-[85%]'>
              {renderedUserContent}
            </div>
          ) : null
        ) : hasVisibleMarkdown ? (
          <div className='w-full text-sm leading-relaxed break-words text-[var(--ui-text-primary)]'>
            <MarkdownContent content={markdownContent} hideThinking />
          </div>
        ) : isEmptyAssistantTurn ? (
          <div className='w-full pl-3 pr-2 py-2 border-l-2 border-[color:var(--ui-accent-rose)] bg-[var(--ui-accent-rose-soft)] flex items-start gap-2.5'>
            <XCircle size={15} className='text-[var(--ui-accent-rose)] flex-shrink-0 mt-0.5' />
            <div className='flex flex-col gap-1.5 min-w-0'>
              <span className='text-xs font-medium text-[var(--ui-text-primary)]'>
                本次请求未收到模型返回内容
              </span>
              <span className='text-[11px] text-[var(--ui-text-muted)] leading-relaxed'>
                可能是上游网关超时、连接被中断或模型服务异常。可直接重试，或切换到其他模型继续。
              </span>
              <button
                onClick={() => onRetry(msg)}
                className='self-start mt-0.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-[var(--ui-text-primary)] bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] flex items-center gap-1.5 transition-colors cursor-pointer'
              >
                <RotateCw size={11} />
                重新生成
              </button>
            </div>
          </div>
        ) : null}

        {/* 悬浮操作栏：当前回合仍在执行时不提供复制/重试，避免复制到半截内容或误触发重跑 */}
        {hasContent && !(isGenerating && isActiveTurn) && (
          <div className='flex gap-1.5 mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity'>
            <button
              onClick={handleCopyText}
              className='p-1 hover:bg-[var(--ui-chip-hover-bg)] rounded-md text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)] transition-colors flex items-center gap-1 text-[11px]'
              title='复制内容'
            >
              {copied ? <Check size={11} className='text-[var(--ui-accent-emerald)]' /> : <Copy size={11} />}
              {copied && <span className='text-[10px] text-[var(--ui-accent-emerald)]'>已复制</span>}
            </button>
            {!isUser && (
              <button
                onClick={() => onRetry(msg)}
                className='p-1 hover:bg-[var(--ui-chip-hover-bg)] rounded-md text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)] transition-colors'
                title='重新生成'
              >
                <RotateCw size={11} />
              </button>
            )}
          </div>
        )}
      </div>

      {previewImageIndex !== null && previewableUserImages.length > 0 && (
        <ImagePreviewLightbox
          images={previewableUserImages.map((p) => p.item)}
          initialIndex={previewImageIndex}
          onClose={() => setPreviewImageIndex(null)}
        />
      )}
    </div>
  );
}, (prev, next) => {
  // 性能优化核心：当前活跃回合（处于活跃流式中）必须重新渲染
  if (prev.isActiveTurn !== next.isActiveTurn || next.isActiveTurn) {
    return false;
  }

  // 对已完成的历史消息，深度核验其关键字段，只要内容未变即 100% 命中缓存，直接 0ms 跳过内部庞大组件树与 Markdown 的全部 Diff
  if (
    prev.msg.id === next.msg.id &&
    prev.msg.content === next.msg.content &&
    prev.msg.metadata === next.msg.metadata &&
    prev.containerWidth === next.containerWidth &&
    prev.isGenerating === next.isGenerating
  ) {
    return true; // 缓存命中，跳过整个气泡的全部渲染
  }

  return false;
});

/**
 * 消息快速定位点位导航轨 (Message Navigator Track)
 * - 纯暗色工业级设计，对标参考图红框横杠点位
 * - 鼠标悬停展示提问内容摘要 Tooltip
 * - 点击平滑滚动至对应消息位置
 * - 随滚动自动高亮当前视口的消息横杠
 */
interface MessageNavProps {
  messages: Message[];
  activeId: string | null;
  onNavigate: (id: string) => void;
}

export const MessageNavigator: React.FC<MessageNavProps> = ({ messages, activeId, onNavigate }) => {
  // 筛选提问或对话节点 (至少 2 轮对话才展示导航轨，避免单条消息冗余)
  const navNodes = useMemo(() => {
    const userNodes = messages.filter((m) => m.role === 'user');
    if (userNodes.length >= 2) return userNodes;
    if (messages.length >= 3) return messages.filter((_, idx) => idx % 2 === 0);
    return [];
  }, [messages]);

  if (navNodes.length < 2) return null;

  return (
    <div className='absolute left-1.5 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1 px-0.5 py-1.5 rounded-full bg-[var(--ui-composer-bg)] hover:bg-[var(--ui-composer-hover-bg)] border border-[color:var(--ui-border-hairline)] select-none transition-all'>
      {navNodes.map((msg, idx) => {
        const isActive = activeId === msg.id || (idx === navNodes.length - 1 && !activeId);
        const snippet =
          (msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 36) ||
          `第 ${idx + 1} 轮会话`;

        return (
          <div
            key={msg.id}
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(msg.id);
            }}
            className='group/navdot relative flex items-center justify-center p-0.5 cursor-pointer'
            title={snippet}
          >
            {/* 极简超窄刻度小横杠 (7px-11px，亮/暗/壁纸下高对比清晰自适应) */}
            <div
              className={`h-[2px] rounded-full transition-all duration-200 ${
                isActive
                  ? 'w-[11px] bg-[var(--ui-accent-blue)] opacity-100 shadow-[0_0_6px_var(--ui-focus-ring)]'
                  : 'w-[7px] bg-[var(--ui-text-muted)] opacity-45 group-hover/navdot:w-[10px] group-hover/navdot:opacity-95 group-hover/navdot:bg-[var(--ui-text-primary)]'
              }`}
            />

            {/* Hover 浮出摘要 Tooltip */}
            <div className='absolute left-full ml-2 px-2.5 py-1 rounded-lg bg-[var(--ui-popover-bg)] backdrop-blur-xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] text-[11px] text-[var(--ui-text-primary)] whitespace-nowrap shadow-xl pointer-events-none opacity-0 translate-x-[-4px] group-hover/navdot:opacity-100 group-hover/navdot:translate-x-0 transition-all z-30 flex items-center gap-1.5'>
              <span className='w-1.5 h-1.5 rounded-full bg-[var(--ui-accent-blue,#3b82f6)] flex-shrink-0' />
              <span className='max-w-[220px] truncate'>{snippet}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
