import React, { useRef, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Send,
  FolderGit2,
  ChevronDown,
  Paperclip,
  X,
  Square,
  FileSpreadsheet,
  FileCode,
  FileText,
  FileArchive,
  File as GenericFileIcon,
  Compass,
  ShieldCheck,
  ShieldQuestion,
  ShieldAlert,
  Check,
  Brain,
  Zap,
  Sparkles,
  Flame,
  Rocket,
  Cpu,
  CornerDownRight,
} from "lucide-react";
import { useChatStore, type PermissionMode, type ReasoningEffort, type QueuedPrompt } from "@/stores/chatStore";
import MentionPopover, { type MentionPosition } from "@/pages/chat/MentionPopover";
import PromptQueueBar from "@/pages/chat/PromptQueueBar";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  classifyAttachment,
  formatFileSize,
  getFileExtension,
  type DraftChatAttachment,
} from "@/lib/chatAttachment";
import {
  filterUnifiedMentions,
  getCaretCoordinates,
  loadWorkspaceFileIndex,
  type FileIndexEntry,
  type UnifiedMentionItem,
} from "@/lib/fileMention";

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
}

const PERMISSION_MODE_OPTIONS: Array<{
  id: PermissionMode;
  label: string;
  shortLabel: string;
  sandboxTag: string;
  recommended?: boolean;
  description: string;
  icon: React.FC<{ size?: number; className?: string }>;
  badgeClass: string;
  iconClass: string;
}> = [
  {
    id: "plan",
    label: "只读规划",
    shortLabel: "只读规划",
    sandboxTag: "Seatbelt 只读沙箱",
    description: "仅允许检索、阅读代码与架构规划，隐藏写文件工具并锁定只读命令沙箱",
    icon: Compass,
    badgeClass:
      "bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] border-[color:var(--ui-accent-sky-border)]",
    iconClass: "text-[var(--ui-accent-sky)]",
  },
  {
    id: "auto-sandbox",
    label: "工作区沙箱",
    shortLabel: "工作区沙箱",
    sandboxTag: "Seatbelt 写隔离",
    recommended: true,
    description: "工作区内文件读写与常规命令自动放行，内核级拦截越界写入与敏感凭据读取",
    icon: ShieldCheck,
    badgeClass:
      "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]",
    iconClass: "text-[var(--ui-accent-emerald)]",
  },
  {
    id: "ask",
    label: "询问确认",
    shortLabel: "询问确认",
    sandboxTag: "Seatbelt 写隔离",
    description: "每次修改文件或执行命令前请求确认，命令同样受工作区沙箱边界保护",
    icon: ShieldQuestion,
    badgeClass:
      "bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border-[color:var(--ui-accent-amber-border)]",
    iconClass: "text-[var(--ui-accent-amber)]",
  },
  {
    id: "full-access",
    label: "完全访问",
    shortLabel: "完全访问",
    sandboxTag: "关闭命令沙箱",
    description: "解除命令级 OS 沙箱限制，仅对高危破坏性命令与工作区外写入请求确认",
    icon: ShieldAlert,
    badgeClass:
      "bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)] border-[color:var(--ui-accent-rose-border)]",
    iconClass: "text-[var(--ui-accent-rose)]",
  },
];

export interface ReasoningOption {
  id: ReasoningEffort;
  level: number;
  label: string;
  shortLabel: string;
  badge: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  colorClass: string;
  bgClass: string;
  recommended?: boolean;
}

export const REASONING_OPTIONS: ReasoningOption[] = [
  {
    id: "off",
    level: 0,
    label: "关闭 (Off)",
    shortLabel: "极速响应",
    badge: "常规",
    description: "无显式思考过程，直接生成答复，响应最快且不消耗额外思考 Token",
    icon: Zap,
    colorClass: "text-neutral-400",
    bgClass: "bg-neutral-500/10 text-neutral-300 border-neutral-700/50",
  },
  {
    id: "low",
    level: 1,
    label: "低 (Low)",
    shortLabel: "轻量思考",
    badge: "轻快",
    description: "约 2k tokens 思考预算，适合简单语法查错、函数注释生成与概念解释",
    icon: Sparkles,
    colorClass: "text-sky-400",
    bgClass: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  },
  {
    id: "medium",
    level: 2,
    label: "中 (Medium)",
    shortLabel: "推荐思考",
    badge: "推荐",
    recommended: true,
    description: "约 4k tokens 思考预算，平衡响应速度与逻辑严密性，适合日常工程开发",
    icon: Brain,
    colorClass: "text-emerald-400",
    bgClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  },
  {
    id: "high",
    level: 3,
    label: "高 (High)",
    shortLabel: "深度思考",
    badge: "深度",
    description: "约 8k tokens 思考预算，适合疑难 Bug 排查、跨模块重构与算法推演",
    icon: Flame,
    colorClass: "text-amber-400",
    bgClass: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  },
  {
    id: "max",
    level: 4,
    label: "极高 (Max)",
    shortLabel: "极限深思",
    badge: "极高",
    description: "16k+ tokens 极限深度演算，针对大型工程系统架构设计与极复杂数学证明",
    icon: Rocket,
    colorClass: "text-rose-400",
    bgClass: "bg-rose-500/10 text-rose-400 border-rose-500/30",
  },
];

const MENTION_TRIGGER = /(?:^|[\s(（[【"'`\u4e00-\u9fa5])@([^\s@]*)$/;

const MessageInput: React.FC<Props> = ({
  value,
  onChange,
  onSend,
  isGenerating,
  disabled,
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
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const permBtnRef = useRef<HTMLButtonElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const {
    activeSessionId,
    sessions,
    setSessionReasoningEffort,
    workspaces,
    skills,
    mcpServers,
    subagents,
  } = useChatStore();

  const [dragging, setDragging] = useState(false);
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [permMenuPos, setPermMenuPos] = useState({ left: 24, bottom: 60 });

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState({ left: 160, bottom: 60 });

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const currentEffortId = activeSession?.reasoningEffort || "medium";
  const currentEffortOption =
    REASONING_OPTIONS.find((opt) => opt.id === currentEffortId) || REASONING_OPTIONS[2];

  const currentModelObj = chatModels?.find((m) => m.id === selectedModel);
  const currentModelName = currentModelObj?.name || currentModelObj?.model_id || selectedModel || "选择模型";

  const activePermOption =
    PERMISSION_MODE_OPTIONS.find((item) => item.id === permissionMode) ||
    PERMISSION_MODE_OPTIONS[1];
  const ActivePermIcon = activePermOption.icon;

  const [fileIndex, setFileIndex] = useState<FileIndexEntry[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionPos, setMentionPos] = useState<MentionPosition>({
    top: 0,
    left: 0,
    above: true,
    listMaxHeight: 260,
  });

  // 匹配绑定的多目录工作空间项目名称
  const matchedWs = workspaces.find((w) =>
    w.folders.some((f) => f.path === workDir) || w.id === workDir
  );
  const workspaceDisplayName = matchedWs?.name || (workDir ? workDir.split(/[\\/]/).filter(Boolean).pop() : "选择工作空间目录");

  const { items: mentionItems, grouped: mentionGrouped } = useMemo(
    () =>
      mention
        ? filterUnifiedMentions(mention.query, fileIndex, skills, mcpServers, subagents)
        : { items: [], grouped: { subagents: [], skills: [], mcps: [], files: [] } },
    [mention, fileIndex, skills, mcpServers, subagents]
  );

  const resizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
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
    const inserted = item.insertText;
    const nextValue = value.slice(0, mention.start) + inserted + value.slice(caret);
    const nextCaret = mention.start + inserted.length;

    onChange(nextValue);
    setMention(item.isDir ? { start: mention.start, query: item.insertText.slice(1) } : null);
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
        const matched = item.placeholder.match(/#(d+)/);
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

    const el = textareaRef.current;
    if (!el) return;

    const currentValue = el.value;
    const caret = el.selectionStart ?? currentValue.length;
    const inserted = drafts.map((draft) => `${draft.placeholder} `).join("");
    const nextValue = currentValue.slice(0, caret) + inserted + currentValue.slice(caret);
    const nextCaret = caret + inserted.length;

    onChange(nextValue);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      resizeTextarea(el);
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

    if (target.placeholder && value.includes(target.placeholder)) {
      onChange(value.replace(`${target.placeholder} `, "").replace(target.placeholder, ""));
    }
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

    if (match) {
      const query = match[1];
      setMention({ start: caret - query.length - 1, query });
      setMentionIndex(0);
      updateMentionPosition(el, caret);
    } else if (mention) {
      setMention(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

    if (e.key === "Escape" && mention) {
      e.preventDefault();
      setMention(null);
      return;
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
      onSend();
    }
  };

  // 工作目录变化时加载文件索引
  useEffect(() => {
    let alive = true;
    setMention(null);

    if (!workDir) {
      setFileIndex([]);
      return;
    }

    loadWorkspaceFileIndex(workDir)
      .then((index) => {
        if (alive) setFileIndex(index.files || []);
      })
      .catch(() => {
        if (alive) setFileIndex([]);
      });

    return () => {
      alive = false;
    };
  }, [workDir]);

  useEffect(() => {
    if (mentionIndex >= mentionItems.length) {
      setMentionIndex(0);
    }
  }, [mentionItems.length, mentionIndex]);

  const updatePermMenuPos = () => {
    if (!permBtnRef.current) return;
    const rect = permBtnRef.current.getBoundingClientRect();
    const menuWidth = 340;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    setPermMenuPos({ left, bottom });
  };

  const updateModelMenuPos = () => {
    if (!modelBtnRef.current) return;
    const rect = modelBtnRef.current.getBoundingClientRect();
    const menuWidth = 380;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    setModelMenuPos({ left, bottom });
  };

  useEffect(() => {
    if (!permMenuOpen && !modelMenuOpen) return;
    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (
        permMenuOpen &&
        permMenuRef.current &&
        !permMenuRef.current.contains(target) &&
        permBtnRef.current &&
        !permBtnRef.current.contains(target)
      ) {
        setPermMenuOpen(false);
      }
      if (
        modelMenuOpen &&
        modelMenuRef.current &&
        !modelMenuRef.current.contains(target) &&
        modelBtnRef.current &&
        !modelBtnRef.current.contains(target)
      ) {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [permMenuOpen, modelMenuOpen]);

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
        className={`w-full bg-[var(--ui-input-bg)] hover:bg-[var(--ui-input-hover-bg)] border rounded-xl shadow-sm transition-all duration-200 overflow-hidden flex flex-col ${
          dragging
            ? "border-blue-500/70 ring-2 ring-blue-500/20"
            : "border-[color:var(--ui-border-subtle)] focus-within:border-[color:var(--ui-accent-blue-border)]"
        }`}
      >
        {/* 多类型附件预览条 (支持图片缩略图与多样化文件胶囊卡片) */}
        {attachments.length > 0 && (
          <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto custom-scrollbar">
            {attachments.map((item) => (
              <div
                key={item.id}
                className="relative flex-shrink-0 group rounded-xl overflow-hidden border border-[color:var(--ui-border-hairline)] bg-[var(--ui-card-inner-bg)]"
                title={`${item.name} (${formatFileSize(item.size)}) · ${item.placeholder}`}
              >
                {item.category === "image" && item.previewUrl ? (
                  <div className="relative w-16 h-16">
                    <img src={item.previewUrl} alt={item.name} className="w-full h-full object-cover" />
                    <span className="absolute bottom-0 left-0 right-0 text-[9px] leading-4 bg-black/70 text-white text-center font-mono truncate px-1">
                      {item.placeholder}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 h-14 max-w-[200px] select-none">
                    <div className="w-8 h-8 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center flex-shrink-0">
                      {item.category === "spreadsheet" && (
                        <FileSpreadsheet size={16} className="text-[var(--ui-accent-emerald)]" />
                      )}
                      {item.category === "text" && (
                        <FileCode size={16} className="text-[var(--ui-accent-blue)]" />
                      )}
                      {item.category === "document" && (
                        <FileText size={16} className="text-[var(--ui-accent-rose)]" />
                      )}
                      {item.category === "archive" && (
                        <FileArchive size={16} className="text-[var(--ui-accent-amber)]" />
                      )}
                      {item.category === "binary" && (
                        <GenericFileIcon size={16} className="text-[var(--ui-accent-purple)]" />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0 pr-4">
                      <span className="text-xs font-medium text-[var(--ui-text-primary)] truncate" title={item.name}>
                        {item.name}
                      </span>
                      <span className="text-[10px] text-[var(--ui-text-faint)] font-mono">
                        {formatFileSize(item.size)}
                      </span>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => removeAttachment(item.id)}
                  className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/75 text-white hover:bg-rose-600 flex items-center justify-center transition-colors shadow-sm"
                  title="移除此附件"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 文本输入区 (绝对无边框、无内发光、无任何独立框线) */}
        <div className="px-4 pt-3.5 pb-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => window.setTimeout(() => setMention(null), 150)}
            placeholder={
              isGenerating
                ? "Agent 执行中：Enter 加入任务队列，⌘ + Enter 追加上下文，Esc 停止生成..."
                : "输入消息或任务，输入 @ 引用资源，粘贴或拖入图片、表格、文档，Enter 发送，Shift + Enter 换行..."
            }
            style={{ border: 'none', outline: 'none', boxShadow: 'none' }}
            className="chat-textarea-seamless w-full max-h-44 min-h-[46px] bg-transparent text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] resize-none border-none outline-none ring-0 focus:ring-0 focus:outline-none focus:border-none shadow-none text-sm leading-relaxed scroll-smooth"
            rows={1}
          />
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
              <div className="relative">
                <button
                  ref={permBtnRef}
                  type="button"
                  onClick={() => {
                    if (!permMenuOpen) updatePermMenuPos();
                    setPermMenuOpen((prev) => !prev);
                  }}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors select-none border cursor-pointer ${activePermOption.badgeClass}`}
                  title={`当前权限模式: ${activePermOption.label} (${activePermOption.sandboxTag})\n${activePermOption.description}\n快捷键: Shift + Tab 切换`}
                >
                  <ActivePermIcon size={13} className="flex-shrink-0" />
                  <span className="font-medium whitespace-nowrap">{activePermOption.shortLabel}</span>
                  <ChevronDown
                    size={11}
                    className={`opacity-75 transition-transform duration-150 ${
                      permMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {permMenuOpen &&
                  typeof document !== "undefined" &&
                  createPortal(
                    <div
                      ref={permMenuRef}
                      className="fixed z-[99999] w-[340px] rounded-xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-2xl backdrop-blur-2xl p-1.5 select-none"
                      style={{
                        left: permMenuPos.left,
                        bottom: permMenuPos.bottom,
                      }}
                    >
                      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[color:var(--ui-divider-hairline)] mb-1">
                        <span className="text-[11px] font-semibold text-[var(--ui-text-secondary)]">
                          Agent 权限与沙箱模式
                        </span>
                        <span className="text-[10px] font-mono text-[var(--ui-text-faint)] bg-[var(--ui-chip-bg)] px-1.5 py-0.5 rounded border border-[color:var(--ui-border-hairline)]">
                          Shift + Tab 切换
                        </span>
                      </div>

                      <div className="flex flex-col gap-0.5">
                        {PERMISSION_MODE_OPTIONS.map((opt) => {
                          const Icon = opt.icon;
                          const isSelected = opt.id === permissionMode;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => {
                                onChangePermissionMode(opt.id);
                                setPermMenuOpen(false);
                              }}
                              className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors flex items-start gap-2.5 cursor-pointer ${
                                isSelected
                                  ? "bg-[var(--ui-block-hover-bg)]"
                                  : "hover:bg-[var(--ui-block-bg)]"
                              }`}
                            >
                              <div className="mt-0.5 flex-shrink-0">
                                <Icon size={14} className={opt.iconClass} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-medium text-[var(--ui-text-primary)]">
                                    {opt.label}
                                  </span>
                                  {opt.recommended && (
                                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)] font-medium">
                                      推荐
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-[var(--ui-text-faint)] ml-auto">
                                    {opt.sandboxTag}
                                  </span>
                                </div>
                                <p className="text-[11px] text-[var(--ui-text-muted)] leading-snug mt-0.5">
                                  {opt.description}
                                </p>
                              </div>
                              <div className="w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">
                                {isSelected && (
                                  <Check size={13} className="text-[var(--ui-accent-blue)]" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>,
                    document.body
                  )}
              </div>
            )}

            {/* 模型与推理强度一体化选择器 */}
            {chatModels && chatModels.length > 0 && onChangeModel && (
              <div className="relative">
                <button
                  ref={modelBtnRef}
                  type="button"
                  onClick={() => {
                    if (!modelMenuOpen) updateModelMenuPos();
                    setModelMenuOpen((prev) => !prev);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors select-none border border-[color:var(--ui-border-hairline)] bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-primary)] cursor-pointer"
                  title={`当前模型: ${currentModelName}\n推理强度: ${currentEffortOption.label}\n点击配置模型与滑动调节推理强度`}
                >
                  <Cpu size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                  <span className="font-medium truncate max-w-[150px]">{currentModelName}</span>
                  <span className={`px-1.5 py-0.2 rounded text-[10px] font-mono border ${currentEffortOption.bgClass}`}>
                    {currentEffortOption.badge}
                  </span>
                  <ChevronDown
                    size={11}
                    className={`opacity-75 transition-transform duration-150 ${
                      modelMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {modelMenuOpen &&
                  typeof document !== "undefined" &&
                  createPortal(
                    <div
                      ref={modelMenuRef}
                      className="fixed z-[99999] w-[380px] rounded-2xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-2xl backdrop-blur-2xl p-3.5 select-none flex flex-col gap-3"
                      style={{
                        left: modelMenuPos.left,
                        bottom: modelMenuPos.bottom,
                      }}
                    >
                      {/* 1. 推理强度调节头部 */}
                      <div className="flex items-center justify-between pb-2 border-b border-[color:var(--ui-divider-hairline)]">
                        <div className="flex items-center gap-1.5">
                          <Brain size={14} className="text-emerald-400" />
                          <span className="text-xs font-semibold text-[var(--ui-text-primary)]">
                            推理强度调节 (Reasoning)
                          </span>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono border font-medium ${currentEffortOption.bgClass}`}>
                          {currentEffortOption.label}
                        </span>
                      </div>

                      {/* 当前档位说明卡片 */}
                      <div className="p-2.5 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-1">
                        <div className="flex items-center justify-between text-xs font-medium">
                          <span className="text-[var(--ui-text-primary)] flex items-center gap-1.5">
                            <currentEffortOption.icon size={13} className={currentEffortOption.colorClass} />
                            <span>{currentEffortOption.shortLabel}</span>
                          </span>
                          {currentEffortOption.recommended && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-medium">
                              推荐档位
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--ui-text-muted)] leading-relaxed">
                          {currentEffortOption.description}
                        </p>
                      </div>

                      {/* 5 档平滑滑动条 */}
                      <div className="flex flex-col gap-2 px-1">
                        <input
                          type="range"
                          min={0}
                          max={4}
                          step={1}
                          value={currentEffortOption.level}
                          onChange={(e) => {
                            const level = Number(e.target.value);
                            const targetOpt =
                              REASONING_OPTIONS.find((opt) => opt.level === level) ||
                              REASONING_OPTIONS[2];
                            if (activeSessionId) {
                              setSessionReasoningEffort(activeSessionId, targetOpt.id);
                              onNotify?.(`已动态调整推理强度：${targetOpt.label}`);
                            }
                          }}
                          className="w-full h-1.5 bg-[var(--ui-chip-hover-bg)] rounded-lg appearance-none cursor-pointer accent-emerald-500"
                        />
                        {/* 5 档刻度标签 (点击刻度快速直达) */}
                        <div className="flex justify-between items-center text-[10px] text-[var(--ui-text-faint)] font-mono px-0.5">
                          {REASONING_OPTIONS.map((opt) => {
                            const isCur = opt.id === currentEffortId;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => {
                                  if (activeSessionId) {
                                    setSessionReasoningEffort(activeSessionId, opt.id);
                                    onNotify?.(`已动态调整推理强度：${opt.label}`);
                                  }
                                }}
                                className={`transition-all cursor-pointer hover:text-[var(--ui-text-primary)] ${
                                  isCur
                                    ? "text-emerald-400 font-bold scale-110 underline underline-offset-4"
                                    : ""
                                }`}
                                title={opt.description}
                              >
                                {opt.badge}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* 2. 模型切换列表 */}
                      <div className="pt-2 border-t border-[color:var(--ui-divider-hairline)] flex flex-col gap-1.5">
                        <div className="flex items-center justify-between px-0.5">
                          <span className="text-[11px] font-semibold text-[var(--ui-text-secondary)]">
                            切换对话模型 ({chatModels.length})
                          </span>
                        </div>
                        <div className="max-h-[170px] overflow-y-auto custom-scrollbar flex flex-col gap-0.5 pr-0.5">
                          {chatModels.map((m) => {
                            const isSel = m.id === selectedModel;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => {
                                  onChangeModel(m.id);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between cursor-pointer ${
                                  isSel
                                    ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium border border-[color:var(--ui-accent-blue-border)]"
                                    : "text-[var(--ui-text-secondary)] hover:bg-[var(--ui-block-bg)] hover:text-[var(--ui-text-primary)]"
                                }`}
                              >
                                <span className="truncate">{m.name || m.model_id}</span>
                                {isSel && (
                                  <Check size={13} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}
              </div>
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
                    className="h-8 px-2 rounded-xl flex items-center gap-1 justify-center bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/35 shadow-sm active:scale-95 cursor-pointer transition-all"
                    title="追加至当前执行（中途补充背景/澄清细节/纠偏，⌘ + Enter）"
                  >
                    <CornerDownRight size={13} />
                    <span className="text-[11px] font-medium whitespace-nowrap">追加</span>
                  </button>
                )}
                {value.trim() && (
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
                disabled={!value.trim() || disabled}
                className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
                  value.trim() && !disabled
                    ? "bg-blue-600 hover:bg-blue-500 text-white shadow-sm active:scale-95 cursor-pointer"
                    : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-faint)] cursor-not-allowed border border-[color:var(--ui-border-hairline)]"
                }`}
                title="发送 (Enter)"
              >
                <Send size={14} className={value.trim() ? "translate-x-0.5 -translate-y-0.5" : ""} />
              </button>
            )}
          </div>
        </div>
      </div>

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
