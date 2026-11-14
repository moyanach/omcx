import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import { Message } from '../../stores/chatStore';
import BtwSelectionMenu, { BtwSelectionPayload } from '@/pages/chat/BtwSelectionMenu';
import { MessageListProps } from './messageList/types';
import {
  AgentLiveStatusBar,
  MessageBubble,
  MessageNavigator,
} from './messageList/MessageBubble';

type Props = MessageListProps;

export const MessageList: React.FC<Props> = ({
  messages,
  isGenerating,
  activeToolCalls,
  activeTodos = [],
  onCopy,
  onRetry,
  onSideChatSelection,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // ─── 选中文本 → 右键「旁路会话」 ───
  const selectionCacheRef = useRef<{ text: string; messageId?: string; at: number } | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    text: string;
    messageId?: string;
  } | null>(null);

  const captureSelection = useCallback((): { text: string; messageId?: string } | null => {
    const container = scrollRef.current;
    if (!container) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().replace(/\r\n/g, '\n').trim();
    if (!text) return null;

    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const node =
      common.nodeType === Node.ELEMENT_NODE
        ? (common as HTMLElement)
        : common.parentElement;
    if (!node || !container.contains(node)) return null;

    // 跨消息选择时 commonAncestor 是滚动容器本身，此时不归属单条消息
    const bubble = node.closest('[id^="msg-bubble-"]') as HTMLElement | null;
    const messageId = bubble?.id.replace('msg-bubble-', '') || undefined;
    return { text, messageId };
  }, []);

  const rememberSelection = useCallback(() => {
    const captured = captureSelection();
    if (captured) selectionCacheRef.current = { ...captured, at: Date.now() };
  }, [captureSelection]);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onSideChatSelection) return;
      const fresh = captureSelection();
      const cached = selectionCacheRef.current;
      const targetBubble = (event.target as HTMLElement)?.closest?.(
        '[id^="msg-bubble-"]'
      ) as HTMLElement | null;
      const targetMessageId = targetBubble?.id.replace('msg-bubble-', '') || undefined;
      // 部分平台右键会清空选区：5 秒内且仍落在同一消息上时复用缓存的选区
      const usableCache =
        cached && Date.now() - cached.at < 5000 && (!cached.messageId || cached.messageId === targetMessageId)
          ? cached
          : null;
      const selection = fresh || usableCache;
      if (!selection) return;

      event.preventDefault();
      selectionCacheRef.current = { ...selection, at: Date.now() };
      setSelectionMenu({
        x: event.clientX,
        y: event.clientY,
        text: selection.text,
        messageId: selection.messageId,
      });
    },
    [captureSelection, onSideChatSelection]
  );

  const handleSideChat = useCallback(
    (payload: BtwSelectionPayload) => {
      window.getSelection()?.removeAllRanges();
      onSideChatSelection?.(payload);
    },
    [onSideChatSelection]
  );

  // 智能防抢焦滚动：用户是否处于底部偏差范围内
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false);
  const [activeNavMsgId, setActiveNavMsgId] = useState<string | null>(null);
  const navCalcRafRef = useRef<number | null>(null);

  // ─── 视口动态虚拟窗口化 (Virtual Message Windowing) ───
  // 当会话历史消息突破 20 条时自动启用，将非视口历史消息卸载为轻量等高占位节点
  // 无论会话对话 50 轮还是 1000 轮，真实 DOM 节点数恒定保持在 2000 个以内，杜绝内存与合成层雪崩
  const VIRTUAL_THRESHOLD = 20;
  const heightMapRef = useRef<Map<string, number>>(new Map());

  // 实测高度必须回灌 offset 计算，否则长历史会一直使用估算值，滚动窗口与真实内容错位
  const [heightVersion, setHeightVersion] = useState(0);
  const heightRafRef = useRef<number | null>(null);
  const handleReportHeight = useCallback((id: string, h: number) => {
    const prev = heightMapRef.current.get(id);
    if (prev !== undefined && Math.abs(prev - h) < 2) return;
    heightMapRef.current.set(id, h);
    if (heightRafRef.current === null) {
      heightRafRef.current = requestAnimationFrame(() => {
        heightRafRef.current = null;
        setHeightVersion((v) => v + 1);
      });
    }
  }, []);

  const estimateHeight = useCallback((m: Message) => {
    const cached = heightMapRef.current.get(m.id);
    if (cached) return cached;
    if (m.role === 'user') {
      const hasAtt = Array.isArray(m.metadata?.attachments) && m.metadata.attachments.length > 0;
      return hasAtt ? 140 : 54;
    }
    // 思考内容与正文已物理分离，正文长度可直接用于估算；折叠思考条按固定高度计
    const rawContent = String(m.content || '');
    const visibleLen = rawContent.length;
    const reasoningChars = Number(m.reasoningChars || m.metadata?.reasoningChars) || 0;
    const thinkingHeight = reasoningChars > 0 ? 40 : 0;
    const toolCount = Array.isArray(m.metadata?.toolSteps) ? m.metadata.toolSteps.length : 0;
    return Math.min(
      800,
      Math.max(80, Math.round(visibleLen * 0.4) + thinkingHeight + toolCount * 36)
    );
  }, []);

  const [visibleIndices, setVisibleIndices] = useState<{ start: number; end: number }>(() => ({
    start: Math.max(0, messages.length - 15),
    end: Math.max(0, messages.length - 1),
  }));

  // 预计算每条消息的累计顶部/底部偏移，滚动时用二分查找替代 O(n) 全量遍历
  const virtualOffsets = useMemo(() => {
    const tops = new Array<number>(messages.length);
    const bottoms = new Array<number>(messages.length);
    let accumulatedY = 0;
    for (let i = 0; i < messages.length; i++) {
      tops[i] = accumulatedY;
      accumulatedY += estimateHeight(messages[i]) + 14;
      bottoms[i] = accumulatedY;
    }
    return { tops, bottoms };
    // heightVersion 仅用于在实测高度变化时使缓存失效
  }, [messages, estimateHeight, heightVersion]);

  const lowerBound = (arr: number[], value: number, length: number): number => {
    let lo = 0;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const virtualRafRef = useRef<number | null>(null);

  const updateVirtualRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el || messages.length <= VIRTUAL_THRESHOLD) return;

    const scrollTop = el.scrollTop;
    const clientHeight = el.clientHeight;
    const viewTop = Math.max(0, scrollTop - 700);
    const viewBottom = scrollTop + clientHeight + 700;
    const { tops, bottoms } = virtualOffsets;
    const len = messages.length;

    const firstVisible = lowerBound(bottoms, viewTop, len);
    const start = Math.max(0, firstVisible - 2);

    const firstAfter = lowerBound(tops, viewBottom, len);
    let end = firstAfter >= len ? len - 1 : Math.min(len - 1, firstAfter + 2);

    // 生成中或粘底状态下，末尾活跃消息永久处于挂载窗口内
    if (isGenerating || isPinnedToBottom) {
      end = len - 1;
    }

    setVisibleIndices((prev) => {
      if (prev.start === start && prev.end === end) return prev;
      return { start, end };
    });
  }, [messages.length, virtualOffsets, isGenerating, isPinnedToBottom]);

  const scheduleVirtualRange = useCallback(() => {
    if (virtualRafRef.current !== null) return;
    virtualRafRef.current = requestAnimationFrame(() => {
      virtualRafRef.current = null;
      updateVirtualRange();
    });
  }, [updateVirtualRange]);

  // 监听滚动位置：判定是否吸底，并计算当前视口展示的消息节点
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceToBottom <= 70;
    setIsPinnedToBottom(atBottom);
    setShowScrollBottomBtn(!atBottom && el.scrollHeight > el.clientHeight + 120);

    if (messages.length > VIRTUAL_THRESHOLD) {
      scheduleVirtualRange();
    }

    // 性能优化：当处于吸底状态时（如流式生成期间），当前活跃节点必然是最后一条消息，
    // 严禁在此高频路径下对整个消息列表做 getBoundingClientRect 循环测量，消除强制同步回流风暴
    if (atBottom) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg) {
        setActiveNavMsgId((prev) => (prev === lastMsg.id ? prev : lastMsg.id));
      }
      return;
    }

    // 用户向上翻阅时，通过 rAF 节流单帧计算视口顶部节点
    if (navCalcRafRef.current === null) {
      navCalcRafRef.current = requestAnimationFrame(() => {
        navCalcRafRef.current = null;
        if (!scrollRef.current) return;
        const containerTop = scrollRef.current.getBoundingClientRect().top;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const bubbleEl = document.getElementById(`msg-bubble-${msg.id}`);
          if (bubbleEl) {
            const rect = bubbleEl.getBoundingClientRect();
            if (rect.top <= containerTop + 240) {
              setActiveNavMsgId((prev) => (prev === msg.id ? prev : msg.id));
              break;
            }
          }
        }
      });
    }
  }, [messages, scheduleVirtualRange]);

  // 监听用户向上滚轮：明确意图向上阅读，立即解除吸底锁定！
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      setIsPinnedToBottom(false);
    }
  }, []);

  // 仅在粘底状态下，模型吐字或工具执行才跟随滚动到最后；用户向上翻阅时绝对不自动滚到底部！
  useEffect(() => {
    // 用户正在选中文本、或右键菜单已打开时暂停吸底：
    // 否则流式输出的程序化滚动会把选区滚走，并让菜单看起来“自己消失了”。
    const selection = window.getSelection();
    const hasSelection = Boolean(
      selection && !selection.isCollapsed && selection.rangeCount > 0
    );
    if (isPinnedToBottom && scrollRef.current && !hasSelection && !selectionMenu) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isGenerating, activeToolCalls, isPinnedToBottom, selectionMenu]);

  // 会话切换或消息数量变动时，重新计算视口虚拟范围
  useEffect(() => {
    if (messages.length > VIRTUAL_THRESHOLD) {
      updateVirtualRange();
    }
  }, [messages.length, updateVirtualRange]);

  // 架构对齐：切换会话时重置虚拟窗口至最新底部，杜绝前序会话滚动区间残留引发的画面闪跳
  const firstMsgId = messages[0]?.id;
  useEffect(() => {
    setVisibleIndices({
      start: Math.max(0, messages.length - 15),
      end: Math.max(0, messages.length - 1),
    });
    setIsPinnedToBottom(true);
  }, [firstMsgId]);

  // 点击回到底部
  const handleScrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
      setIsPinnedToBottom(true);
      setShowScrollBottomBtn(false);
    }
  };

  // 左侧点位导航点击跳转
  const handleNavigateToMessage = (id: string) => {
    const targetIdx = messages.findIndex((m) => m.id === id);
    if (messages.length > VIRTUAL_THRESHOLD && targetIdx >= 0) {
      // 虚拟窗口下目标消息可能尚未挂载，先扩展窗口再在下一帧定位
      setVisibleIndices({
        start: Math.max(0, targetIdx - 3),
        end: Math.min(messages.length - 1, targetIdx + 3),
      });
      requestAnimationFrame(() => {
        document
          .getElementById(`msg-bubble-${id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } else {
      const el = document.getElementById(`msg-bubble-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    setActiveNavMsgId(id);
    setIsPinnedToBottom(false);
  };

  // 卸载时取消尚未执行的滚动调度帧，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (virtualRafRef.current !== null) cancelAnimationFrame(virtualRafRef.current);
      if (navCalcRafRef.current !== null) cancelAnimationFrame(navCalcRafRef.current);
    };
  }, []);

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

  // 当前正在推进的 assistant 回合：以「最后一条 assistant 消息」为准，而不是「数组最后一条」。
  // 用户中途 steer 追加的 user 消息会排在 assistant 占位气泡之后；若仍按最后一条判定，
  // 会让仍在执行工具循环的回合失去活跃身份，误渲染"本次请求未收到模型返回内容"。
  const activeAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i];
    }
    return null;
  }, [messages]);
  const activeAssistantId = isGenerating ? activeAssistantMessage?.id ?? null : null;

  const hasStreamingText = Boolean(
    isGenerating && activeAssistantMessage?.content?.trim()
  );

  return (
    <div className='flex-1 min-h-0 relative flex flex-col overflow-hidden'>
      {/* 1. 左侧垂直消息定位轨 (对标截图快速点位) */}
      <MessageNavigator
        messages={messages}
        activeId={activeNavMsgId}
        onNavigate={handleNavigateToMessage}
      />

      {/* 2. 聊天正文主滚动容器 (边距收紧优化，左侧留出 24px 供超窄胶囊悬浮) */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onMouseUp={rememberSelection}
        onContextMenu={handleContextMenu}
        className='flex-1 overflow-y-auto pl-8 pr-7 pt-3 pb-3.5 flex flex-col gap-3.5 custom-scrollbar min-h-0 relative'
      >
        {(() => {
          const virtualActive = messages.length > VIRTUAL_THRESHOLD;
          const clampedStart = virtualActive
            ? Math.max(0, Math.min(visibleIndices.start, messages.length - 1))
            : 0;
          const clampedEnd = virtualActive
            ? Math.max(clampedStart, Math.min(visibleIndices.end, messages.length - 1))
            : messages.length - 1;

          // 仅挂载视口附近的消息，上下各用一个 spacer 撑起被卸载区域的总高度，
          // 避免为全量历史消息创建占位 DOM 节点（长会话下是主要渲染开销）。
          const leadingHeight =
            virtualActive && clampedStart > 0
              ? Math.max(0, virtualOffsets.tops[clampedStart] - 14)
              : 0;
          const trailingHeight =
            virtualActive && clampedEnd < messages.length - 1
              ? Math.max(
                  0,
                  virtualOffsets.bottoms[messages.length - 1] -
                    virtualOffsets.bottoms[clampedEnd] -
                    28
                )
              : 0;

          const renderedMessages = virtualActive
            ? messages.slice(clampedStart, clampedEnd + 1)
            : messages;

          return (
            <>
              {leadingHeight > 0 && (
                <div
                  style={{ height: leadingHeight, contain: 'strict' }}
                  className='w-full flex-shrink-0 pointer-events-none'
                  aria-hidden='true'
                />
              )}
              {renderedMessages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  isActiveTurn={Boolean(activeAssistantId && msg.id === activeAssistantId)}
                  activeToolCalls={
                    activeAssistantId && msg.id === activeAssistantId ? activeToolCalls : []
                  }
                  activeTodos={activeAssistantId && msg.id === activeAssistantId ? activeTodos : []}
                  containerWidth={containerWidth}
                  onCopy={onCopy}
                  onRetry={onRetry}
                  isGenerating={isGenerating}
                  onReportHeight={handleReportHeight}
                />
              ))}
              {trailingHeight > 0 && (
                <div
                  style={{ height: trailingHeight, contain: 'strict' }}
                  className='w-full flex-shrink-0 pointer-events-none'
                  aria-hidden='true'
                />
              )}
            </>
          );
        })()}

        {/* 会话最下方：实时任务执行状态条 */}
        {isGenerating && (
          <AgentLiveStatusBar
            activeToolCalls={activeToolCalls}
            activeTodos={activeTodos}
            hasStreamingText={hasStreamingText}
          />
        )}
      </div>

      {/* 2.5 选中文本后的自定义右键菜单（旁路会话 / 复制） */}
      {selectionMenu && (
        <BtwSelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          text={selectionMenu.text}
          messageId={selectionMenu.messageId}
          onClose={() => setSelectionMenu(null)}
          onSideChat={handleSideChat}
        />
      )}

      {/* 3. 智能平滑回到底部悬浮小按钮 (当用户向上查看且离开底部时浮现) */}
      {showScrollBottomBtn && (
        <button
          type='button'
          onClick={handleScrollToBottom}
          className='absolute right-6 bottom-5 z-20 px-3 py-1.5 rounded-full bg-[var(--ui-card-bg)] hover:bg-[var(--ui-card-hover-bg)] text-[var(--ui-text-primary)] border border-[color:var(--ui-border-subtle)] shadow-sm flex items-center gap-1.5 text-xs font-medium cursor-pointer transition-all active:scale-95 animate-in fade-in zoom-in-95 duration-150 select-none'
          title='回到底部'
        >
          <ArrowDown size={13} className='text-[var(--ui-accent-blue,#3b82f6)]' />
          <span>回到底部</span>
          {isGenerating && (
            <span className='w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping' />
          )}
        </button>
      )}
    </div>
  );
};

export default MessageList;
