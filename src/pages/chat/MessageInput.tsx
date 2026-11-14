import React, { useRef, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Send,
  FolderGit2,
  Paperclip,
  Square,
  CornerDownRight,
  FileCode2,
  Folder,
} from "lucide-react";
import { useChatStore, type PermissionMode, type QueuedPrompt } from "@/stores/chatStore";
import MentionPopover, { type MentionPosition } from "@/pages/chat/MentionPopover";
import SlashCommandPopover, {
  type SlashCommandItem,
} from "@/pages/chat/SlashCommandPopover";
import PromptQueueBar from "@/pages/chat/PromptQueueBar";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  classifyAttachment,
  getFileExtension,
  type DraftChatAttachment,
} from "@/lib/chatAttachment";
import {
  filterUnifiedMentions,
  getCaretCoordinates,
  loadWorkspaceFileIndex,
  getShortFileMentionToken,
  findMatchedFileMention,
  tokenizeTextWithMentions,
  compactFileMentionsInText,
  type FileIndexEntry,
  type UnifiedMentionItem,
} from "@/lib/fileMention";
import {
  MENTION_TRIGGER,
  PERMISSION_MODE_OPTIONS,
  REASONING_OPTIONS,
  type ReasoningOption,
} from "./messageInput/constants";
import { AttachmentPreviewStrip } from "./messageInput/AttachmentPreviewStrip";
import { PermissionModeSelector } from "./messageInput/PermissionModeSelector";
import { ModelReasoningSelector } from "./messageInput/ModelReasoningSelector";

export { REASONING_OPTIONS, type ReasoningOption };

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  containerWidth: number;

  // 工作目录
  workDir?: string | null;
  onSelectWorkDir?: () => void;

  // 底部栏控件
  selectedModel?: string;
  chatModels?: any[];
  onChangeModel?: (modelId: string) => void;

  // 权限与沙箱模式
  permissionMode?: PermissionMode;
  onChangePermissionMode?: (mode: PermissionMode) => void;

  // 图片附件
  attachments?: DraftChatAttachment[];
  onChangeAttachments?: (next: DraftChatAttachment[]) => void;
  onNotify?: (message: string) => void;

  // 中断当前生成任务
  onCancel?: () => void;

  // 任务排队支持
  promptQueue?: QueuedPrompt[];
  onRunQueuedNow?: (prompt: QueuedPrompt) => void;
  onSteerQueuedNow?: (prompt: QueuedPrompt) => void;
  onEditQueued?: (prompt: QueuedPrompt) => void;
  onMoveQueuedToTop?: (promptId: string) => void;
  onRemoveQueued?: (promptId: string) => void;
  onClearQueue?: () => void;

  // 直接将当前输入框内容注入执行中的 Agent（中途纠偏，不入队）
  onSteerCurrent?: () => void;

  // @文件短名映射与索引联动
  mentionMap?: Record<string, string>;
  onChangeMentionMap?: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onFileIndexChange?: (files: FileIndexEntry[]) => void;
}

const MessageInput: React.FC<Props> = ({
  value,
  onChange,
  onSend,
  isGenerating,
  disabled,
  containerWidth,
  workDir,
  onSelectWorkDir,
  selectedModel,
  chatModels,
  onChangeModel,
  permissionMode = "auto-sandbox",
  onChangePermissionMode,
  attachments = [] as DraftChatAttachment[],
  onChangeAttachments,
  onNotify,
  onCancel,
  promptQueue,
  onRunQueuedNow,
  onSteerQueuedNow,
  onEditQueued,
  onMoveQueuedToTop,
  onRemoveQueued,
  onClearQueue,
  onSteerCurrent,
  mentionMap,
  onChangeMentionMap,
  onFileIndexChange,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [internalMentionMap, setInternalMentionMap] = useState<Record<string, string>>({});
  const activeMentionMap = mentionMap ?? internalMentionMap;
  const setActiveMentionMap = onChangeMentionMap ?? setInternalMentionMap;
  const [isComposing, setIsComposing] = useState(false);

  const {
    activeSessionId,
    sessions,
    setSessionReasoningEffort,
    workspaces,
    skills,
    mcpServers,
    subagents,
  } = useChatStore(
    useShallow((s) => ({
      activeSessionId: s.activeSessionId,
      sessions: s.sessions,
      setSessionReasoningEffort: s.setSessionReasoningEffort,
      workspaces: s.workspaces,
      skills: s.skills,
      mcpServers: s.mcpServers,
      subagents: s.subagents,
    }))
  );

  const [dragging, setDragging] = useState(false);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const currentEffortId = activeSession?.reasoningEffort || "medium";

  const [fileIndex, setFileIndex] = useState<FileIndexEntry[]>([]);
  const [mention, setMention] = useState<{
    start: number;
    query: string;
    dirPrefix?: { short: string; full: string };
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionPos, setMentionPos] = useState<MentionPosition>({
    top: 0,
    left: 0,
    above: true,
    listMaxHeight: 260,
  });

  // 斜杠命令补全
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashCommands, setSlashCommands] = useState<SlashCommandItem[]>([]);

  const filteredSlashCommands = useMemo(() => {
    const query = (slash?.query || "").toLowerCase();
    return slashCommands
      .filter(
        (cmd) =>
          !query ||
          cmd.name.toLowerCase().includes(query) ||
          (cmd.description || "").toLowerCase().includes(query)
      )
      .slice(0, 12);
  }, [slash?.query, slashCommands]);

  useEffect(() => {
    let alive = true;
    if (!window.electronAPI?.getSlashCommands) return;
    window.electronAPI
      .getSlashCommands(workDir || null)
      .then((list: SlashCommandItem[]) => {
        if (alive) setSlashCommands(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setSlashCommands([]);
      });
    return () => {
      alive = false;
    };
  }, [workDir]);

  // 匹配绑定的多目录工作空间项目名称
  const matchedWs = workspaces.find((w) =>
    w.folders.some((f) => f.path === workDir) || w.id === workDir
  );
  const workspaceDisplayName = matchedWs?.name || (workDir ? workDir.split(/[\\/]/).filter(Boolean).pop() : "选择工作空间目录");

  const effectiveMentionQuery = useMemo(() => {
    if (!mention) return "";
    if (mention.dirPrefix && mention.query.startsWith(mention.dirPrefix.short)) {
      return mention.dirPrefix.full + mention.query.slice(mention.dirPrefix.short.length);
    }
    return mention.query;
  }, [mention]);

  const { items: mentionItems, grouped: mentionGrouped } = useMemo(
    () =>
      mention
        ? filterUnifiedMentions(
            effectiveMentionQuery,
            fileIndex,
            // 已停用的技能不再出现在 @ 引用候选里
            (skills || []).filter((skill) => skill.enabled !== false),
            mcpServers,
            subagents
          )
        : { items: [], grouped: { subagents: [], skills: [], mcps: [], files: [] } },
    [mention, effectiveMentionQuery, fileIndex, skills, mcpServers, subagents]
  );

  const syncOverlayLayout = (el?: HTMLTextAreaElement | null) => {
    const node = el || textareaRef.current;
    const overlay = overlayRef.current;
    if (!node || !overlay) return;
    overlay.style.width = `${node.clientWidth}px`;
    overlay.scrollTop = node.scrollTop;
  };

  const resizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    syncOverlayLayout(el);
  };

  const updateMentionPosition = (el: HTMLTextAreaElement, caret: number) => {
    const coords = getCaretCoordinates(el, caret);
    const rect = el.getBoundingClientRect();
    const anchorTop = rect.top + coords.top;
    const availableAbove = anchorTop - 16;
    const availableBelow = window.innerHeight - rect.bottom - 16;
    const above = availableAbove >= 240 || availableAbove >= availableBelow;
    const maxHeight = Math.max(150, Math.min(400, above ? availableAbove : availableBelow));
    const left = Math.max(8, Math.min(rect.left + coords.left, window.innerWidth - 452));

    setMentionPos({
      top: above ? anchorTop - 8 : rect.bottom + 8,
      left,
      above,
      listMaxHeight: Math.max(110, maxHeight - 74),
    });
  };

  const selectMention = (item: UnifiedMentionItem) => {
    const el = textareaRef.current;
    if (!el || !mention) return;

    const caret = el.selectionStart ?? value.length;
    let inserted = item.insertText;
    let nextDirPrefix: { short: string; full: string } | undefined;

    if (item.category === "file" && item.filePath) {
      const shortToken = getShortFileMentionToken(
        item.filePath,
        Boolean(item.isDir),
        activeMentionMap
      );
      setActiveMentionMap((prev) => ({
        ...prev,
        [shortToken]: item.filePath!,
      }));
      inserted = item.isDir ? `@${shortToken}` : `@${shortToken} `;
      if (item.isDir) {
        nextDirPrefix = { short: shortToken, full: item.filePath };
      }
    }

    const nextValue = value.slice(0, mention.start) + inserted + value.slice(caret);
    const nextCaret = mention.start + inserted.length;

    onChange(nextValue);
    setMention(
      item.isDir
        ? {
            start: mention.start,
            query: inserted.slice(1),
            dirPrefix: nextDirPrefix,
          }
        : null
    );
    setMentionIndex(0);

    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
      resizeTextarea(node);
      if (item.isDir) updateMentionPosition(node, nextCaret);
    });
  };

  const addFiles = (files: File[]) => {
    if (!onChangeAttachments) return;

    if (files.length === 0) return;

    const remaining = MAX_CHAT_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      onNotify?.(`单条消息最多只能添加 ${MAX_CHAT_ATTACHMENTS} 个附件`);
      return;
    }

    const accepted: File[] = [];
    for (const file of files) {
      if (accepted.length >= remaining) {
        onNotify?.(`最多只能添加 ${MAX_CHAT_ATTACHMENTS} 个附件，其余文件已忽略`);
        break;
      }
      if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
        onNotify?.(`文件 ${file.name || ""} 超过 20MB 限制，已跳过`);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length === 0) return;

    const usedNumbers = new Set(
      attachments.map((item) => {
        const matched = item.placeholder.match(/#(\d+)/);
        return matched ? Number(matched[1]) : 0;
      })
    );

    let nextNumber = 1;
    const drafts: DraftChatAttachment[] = accepted.map((file) => {
      while (usedNumbers.has(nextNumber)) nextNumber += 1;
      const category = classifyAttachment(file.name, file.type);
      const extension = getFileExtension(file.name);
      const placeholder =
        category === "image"
          ? `[image #${nextNumber}]`
          : `[file #${nextNumber}: ${file.name}]`;
      usedNumbers.add(nextNumber);

      return {
        id: crypto.randomUUID(),
        file,
        name: file.name || `file-${nextNumber}`,
        mime: file.type || "application/octet-stream",
        size: file.size,
        previewUrl: category === "image" ? URL.createObjectURL(file) : "",
        placeholder,
        category,
        extension,
      };
    });

    onChangeAttachments([...attachments, ...drafts]);

    // 不再向输入框正文注入 [image #1] / [file #1: xxx] 占位符，保持输入区纯净，附件统一展示在顶部栏
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const removeAttachment = (id: string) => {
    if (!onChangeAttachments) return;
    const target = attachments.find((item) => item.id === id);
    if (!target) return;

    if (target.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
    }
    onChangeAttachments(attachments.filter((item) => item.id !== id));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of Array.from(items as DataTransferItemList)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
      return;
    }

    // 粘贴纯文本中若包含 @path/to/file 完整路径，自动紧凑为短文件名胶囊并记录完整路径映射
    const pastedText = e.clipboardData?.getData("text/plain");
    if (pastedText && pastedText.includes("@")) {
      const { text: compacted, mentionMap: nextMap } = compactFileMentionsInText(
        pastedText,
        fileIndex,
        activeMentionMap
      );
      if (compacted !== pastedText) {
        e.preventDefault();
        setActiveMentionMap(nextMap);
        const el = e.currentTarget;
        const start = el.selectionStart ?? value.length;
        const end = el.selectionEnd ?? start;
        const nextValue = value.slice(0, start) + compacted + value.slice(end);
        const nextCaret = start + compacted.length;
        onChange(nextValue);
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          node.focus();
          node.setSelectionRange(nextCaret, nextCaret);
          resizeTextarea(node);
        });
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const fileList = e.dataTransfer?.files;
    const files: File[] = fileList ? Array.from(fileList) : [];
    if (files.length > 0) addFiles(files);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const nextValue = el.value;

    onChange(nextValue);
    resizeTextarea(el);

    const caret = el.selectionStart ?? nextValue.length;
    const match = nextValue.slice(0, caret).match(MENTION_TRIGGER);
    const slashMatch = nextValue.slice(0, caret).match(/^\/([a-zA-Z0-9_-]*)$/);

    if (slashMatch) {
      setSlash({ start: 0, query: slashMatch[1] });
      setSlashIndex(0);
      setMention(null);
      updateMentionPosition(el, caret);
    } else if (slash) {
      setSlash(null);
    }

    if (match) {
      const query = match[1];
      const nextStart = caret - query.length - 1;
      const keepDirPrefix =
        mention?.dirPrefix &&
        nextStart === mention.start &&
        query.startsWith(mention.dirPrefix.short)
          ? mention.dirPrefix
          : undefined;
      setMention({ start: nextStart, query, dirPrefix: keepDirPrefix });
      setMentionIndex(0);
      setSlash(null);
      updateMentionPosition(el, caret);
    } else if (mention) {
      setMention(null);
    }
  };

  const selectSlashCommand = (item: SlashCommandItem) => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const inserted = `/${item.name} `;
    const nextValue = inserted + value.slice(caret);
    onChange(nextValue);
    setSlash(null);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(inserted.length, inserted.length);
      resizeTextarea(node);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法组合态下的 Enter 只是确认候选词，绝不能触发送信
    if ((e.nativeEvent as any).isComposing || (e as any).keyCode === 229) {
      return;
    }
    if (slash && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSlashCommand(filteredSlashCommands[slashIndex]);
        return;
      }
    }

    if (mention && mentionItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(mentionItems[mentionIndex]);
        return;
      }
    }

    // Shift + Tab 快捷循环切换 Agent 权限与沙箱模式（对齐主流 Agent CLI/IDE 交互）
    if (e.key === "Tab" && e.shiftKey && onChangePermissionMode) {
      e.preventDefault();
      const idx = PERMISSION_MODE_OPTIONS.findIndex((item) => item.id === permissionMode);
      const next = PERMISSION_MODE_OPTIONS[(idx + 1) % PERMISSION_MODE_OPTIONS.length];
      onChangePermissionMode(next.id);
      onNotify?.(`已切换权限模式：${next.label} (${next.sandboxTag})`);
      return;
    }

    if (e.key === "Escape" && (mention || slash)) {
      e.preventDefault();
      setMention(null);
      setSlash(null);
      return;
    }

    // 退格整块删除已识别的 @文件 胶囊（当弹窗未打开且光标紧贴在 @文件 末尾时）
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !mention && !slash) {
      const el = textareaRef.current;
      if (el && el.selectionStart === el.selectionEnd) {
        const caret = el.selectionStart ?? 0;
        const beforeCaret = value.slice(0, caret);
        const trailingMention = beforeCaret.match(
          /(^|[\s(（[【"'`\u4e00-\u9fa5])(@[^\s@`"'<>|]+)$/
        );
        if (trailingMention) {
          const tokenWithAt = trailingMention[2];
          const tokenBody = tokenWithAt.slice(1);
          if (findMatchedFileMention(tokenBody, activeMentionMap, fileIndex)) {
            e.preventDefault();
            const deleteFrom = caret - tokenWithAt.length;
            const nextValue = value.slice(0, deleteFrom) + value.slice(caret);
            onChange(nextValue);
            requestAnimationFrame(() => {
              const node = textareaRef.current;
              if (!node) return;
              node.focus();
              node.setSelectionRange(deleteFrom, deleteFrom);
              resizeTextarea(node);
            });
            return;
          }
        }
      }
    }

    // 生成中按 Esc 直接中断当前任务
    if (e.key === "Escape" && isGenerating) {
      e.preventDefault();
      onCancel?.();
      return;
    }

    if (e.key === "Enter") {
      if (e.shiftKey) return;
      e.preventDefault();
      // 生成中按 Cmd/Ctrl + Enter：直接注入当前执行流程（中途纠偏），不进入排队
      if (isGenerating && (e.metaKey || e.ctrlKey) && value.trim() && onSteerCurrent) {
        onSteerCurrent();
        return;
      }
      if ((value.trim() || attachments.length > 0) && !disabled) {
        onSend();
      }
    }
  };

  // 工作目录变化时加载文件索引
  useEffect(() => {
    let alive = true;
    setMention(null);

    if (!workDir) {
      setFileIndex([]);
      onFileIndexChange?.([]);
      return;
    }

    loadWorkspaceFileIndex(workDir)
      .then((index) => {
        if (alive) {
          const files = index.files || [];
          setFileIndex(files);
          onFileIndexChange?.(files);
        }
      })
      .catch(() => {
        if (alive) {
          setFileIndex([]);
          onFileIndexChange?.([]);
        }
      });

    return () => {
      alive = false;
    };
  }, [workDir]);

  // 同步富文本镜像层：将输入框内的 @文件 识别为「文件图标 + 文件名」胶囊，不展示完整路径
  const overlayRenderData = useMemo(() => {
    if (!value || !value.includes("@")) {
      return { hasFileMentions: false, nodes: null as React.ReactNode };
    }
    const segments = tokenizeTextWithMentions(value);
    let hasFileMentions = false;
    const nodes = segments.map((seg, idx) => {
      if (seg.type === "text") {
        return <React.Fragment key={idx}>{seg.value}</React.Fragment>;
      }
      const matched = findMatchedFileMention(seg.token, activeMentionMap, fileIndex);
      if (!matched) {
        return <React.Fragment key={idx}>{seg.raw}</React.Fragment>;
      }
      hasFileMentions = true;
      return (
        <span
          key={idx}
          className="rounded-[4px] bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] py-[1px] shadow-[0_0_0_1px_var(--ui-accent-blue-border)] box-decoration-clone"
        >
          <span className="relative inline-block">
            <span className="opacity-0">@</span>
            {matched.isDir ? (
              <Folder
                size={11}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[var(--ui-accent-blue)]"
              />
            ) : (
              <FileCode2
                size={11}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[var(--ui-accent-blue)]"
              />
            )}
          </span>
          <span>{seg.token}</span>
        </span>
      );
    });
    return { hasFileMentions, nodes };
  }, [value, activeMentionMap, fileIndex]);

  const showOverlay = overlayRenderData.hasFileMentions && !isComposing;

  useEffect(() => {
    if (showOverlay) {
      requestAnimationFrame(() => syncOverlayLayout());
    }
  }, [value, showOverlay, containerWidth]);

  const hasInputOrAttachment = Boolean(value.trim() || attachments.length > 0);
  const canSend = hasInputOrAttachment && !disabled;

  useEffect(() => {
    if (mentionIndex >= mentionItems.length) {
      setMentionIndex(0);
    }
  }, [mentionItems.length, mentionIndex]);


  // 重置高度当 value 清空时
  useEffect(() => {
    if (!value && textareaRef.current) {
      textareaRef.current.style.height = "auto";
      setMention(null);
    }
  }, [value]);

  return (
    <div className="w-full px-3 pb-1.5 pt-0.5 bg-transparent flex-shrink-0">
      {/* 吸附在输入框上方的任务排队栏 */}
      {promptQueue && promptQueue.length > 0 && (
        <PromptQueueBar
          queue={promptQueue}
          onRunNow={(p) => onRunQueuedNow?.(p)}
          onSteerNow={(p) => onSteerQueuedNow?.(p)}
          onEdit={(p) => onEditQueued?.(p)}
          onMoveToTop={(id) => onMoveQueuedToTop?.(id)}
          onRemove={(id) => onRemoveQueued?.(id)}
          onClearAll={() => onClearQueue?.()}
        />
      )}

      {/* 现代化输入卡片 (全宽 100% 铺满大 Card 底部，与上方消息区边缘保持垂直对齐线) */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`w-full bg-[var(--ui-composer-bg)] hover:bg-[var(--ui-composer-hover-bg)] border rounded-xl transition-all duration-200 overflow-hidden flex flex-col ${
          dragging
            ? "border-blue-500/70 ring-2 ring-blue-500/20"
            : "border-[color:var(--ui-border-subtle)] focus-within:border-[color:var(--ui-accent-blue-border)]"
        }`}
      >
        <AttachmentPreviewStrip attachments={attachments} onRemove={removeAttachment} />

        {/* 文本输入区 (绝对无边框、无内发光、无任何独立框线) */}
        <div className="px-4 pt-3.5 pb-2">
          <div className="relative w-full">
            {showOverlay && (
              <div
                ref={overlayRef}
                aria-hidden="true"
                className="pointer-events-none absolute top-0 left-0 bottom-0 overflow-hidden whitespace-pre-wrap break-words font-sans text-sm leading-relaxed tracking-normal text-[var(--ui-text-primary)] select-none p-0 m-0"
              >
                {overlayRenderData.nodes}
                {value.endsWith("\n") ? " " : null}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleInputChange}
              onScroll={(e) => syncOverlayLayout(e.currentTarget)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onBlur={() => window.setTimeout(() => setMention(null), 150)}
              placeholder={
                isGenerating
                  ? "Agent 执行中：Enter 加入任务队列，⌘ + Enter 追加上下文，Esc 停止生成..."
                  : "输入消息或任务，输入 @ 引用资源，粘贴或拖入图片、表格、文档，Enter 发送，Shift + Enter 换行..."
              }
              style={{ border: 'none', outline: 'none', boxShadow: 'none' }}
              className={`chat-textarea-seamless relative z-10 block w-full max-h-44 min-h-[46px] bg-transparent placeholder-[var(--ui-text-faint)] resize-none border-none outline-none ring-0 focus:ring-0 focus:outline-none focus:border-none shadow-none font-sans text-sm leading-relaxed tracking-normal break-words p-0 m-0 ${
                showOverlay
                  ? "text-transparent caret-[var(--ui-text-primary)] selection:bg-blue-500/25"
                  : "text-[var(--ui-text-primary)]"
              }`}
              rows={1}
            />
          </div>
        </div>

        {/* 底部功能栏 */}
        <div className="flex items-center justify-between px-4 pb-3 pt-0">
          <div className="flex items-center gap-2">
            {/* 全格式文件上传按钮 */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                addFiles(files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!onChangeAttachments || attachments.length >= MAX_CHAT_ATTACHMENTS}
              className="flex items-center justify-center w-7 h-7 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={`添加附件 (支持图片、代码、表格、文档等，最多 ${MAX_CHAT_ATTACHMENTS} 个)`}
            >
              <Paperclip size={13} />
            </button>
            {/* 工作空间目录按钮 */}
            {onSelectWorkDir && (
              <button
                onClick={onSelectWorkDir}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors select-none group border ${
                  workDir
                    ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border-[color:var(--ui-accent-blue-border)] hover:opacity-90"
                    : "text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border-[color:var(--ui-border-hairline)]"
                }`}
                title={
                  matchedWs
                    ? `工作空间: ${matchedWs.name}\n包含 ${matchedWs.folders.length} 个源目录\n点击编辑工作空间`
                    : workDir
                    ? `工作目录: ${workDir}\n点击配置多源文件夹工作空间`
                    : "未指定工作空间，点击选择本地项目目录"
                }
              >
                <FolderGit2 size={13} className="text-[var(--ui-accent-blue)] group-hover:scale-105 transition-transform flex-shrink-0" />
                <span className="max-w-[200px] truncate font-medium">
                  {workspaceDisplayName}
                </span>
              </button>
            )}


            {/* 权限与沙箱模式选择器（对标 Claude Code / Cursor / Codex 主流 4 档沙箱权限） */}
            {onChangePermissionMode && (
              <PermissionModeSelector
                permissionMode={permissionMode}
                onChangePermissionMode={onChangePermissionMode}
              />
            )}

            {/* 模型与推理强度一体化选择器 */}
            {chatModels && chatModels.length > 0 && onChangeModel && (
              <ModelReasoningSelector
                selectedModel={selectedModel}
                chatModels={chatModels}
                onChangeModel={onChangeModel}
                currentEffortId={currentEffortId}
                activeSessionId={activeSessionId}
                onChangeEffort={setSessionReasoningEffort}
                onNotify={onNotify}
              />
            )}
          </div>

          {/* 右侧发送 / 停止 / 排队 / 纠偏按钮 */}
          <div className="flex items-center gap-1.5">
            {isGenerating ? (
              <>
                <button
                  type="button"
                  onClick={() => onCancel?.()}
                  className="w-8 h-8 rounded-xl flex items-center justify-center bg-[var(--ui-accent-rose-soft)] hover:bg-rose-600 text-[var(--ui-accent-rose)] hover:text-white border border-[color:var(--ui-accent-rose-border)] hover:border-rose-500 transition-all shadow-sm active:scale-95 cursor-pointer"
                  title="停止生成 (Esc)"
                >
                  <Square size={11} fill="currentColor" />
                </button>
                {value.trim() && onSteerCurrent && (
                  <button
                    type="button"
                    onClick={onSteerCurrent}
                    className="h-8 px-2 rounded-xl flex items-center gap-1 justify-center bg-[var(--ui-accent-blue-soft)] hover:opacity-90 text-[var(--ui-accent-blue)] border border-[color:var(--ui-accent-blue-border)] active:scale-95 cursor-pointer transition-all"
                    title="追加至当前执行（中途补充背景/澄清细节/纠偏，⌘ + Enter）"
                  >
                    <CornerDownRight size={13} />
                    <span className="text-[11px] font-medium whitespace-nowrap">追加</span>
                  </button>
                )}
                {hasInputOrAttachment && (
                  <button
                    type="button"
                    onClick={onSend}
                    className="w-8 h-8 rounded-xl flex items-center justify-center bg-amber-500 hover:bg-amber-400 text-black shadow-sm active:scale-95 cursor-pointer transition-all"
                    title="加入任务队列 (Enter)"
                  >
                    <Send size={13} className="translate-x-0.5 -translate-y-0.5" />
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={onSend}
                disabled={!canSend}
                className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
                  canSend
                    ? "bg-blue-600 hover:bg-blue-500 text-white shadow-sm active:scale-95 cursor-pointer"
                    : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] cursor-not-allowed border border-[color:var(--ui-border-hairline)]"
                }`}
                title="发送 (Enter)"
              >
                <Send size={14} className={hasInputOrAttachment ? "translate-x-0.5 -translate-y-0.5" : ""} />
              </button>
            )}
          </div>
        </div>
      </div>

      {slash && (
        <SlashCommandPopover
          items={filteredSlashCommands}
          activeIndex={Math.min(slashIndex, Math.max(0, filteredSlashCommands.length - 1))}
          query={slash.query}
          position={mentionPos}
          onSelect={selectSlashCommand}
          onHover={setSlashIndex}
        />
      )}

      {mention && (mentionItems.length > 0 || !mention.query) && (
        <MentionPopover
          items={mentionItems}
          grouped={mentionGrouped}
          activeIndex={mentionIndex}
          query={mention.query}
          position={mentionPos}
          onSelect={selectMention}
          onHover={setMentionIndex}
        />
      )}
    </div>
  );
};

export default MessageInput;
