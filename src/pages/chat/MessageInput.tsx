import React, { useRef, useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { useChatStore, type PermissionMode } from "@/stores/chatStore";
import MentionPopover, { type MentionPosition } from "@/pages/chat/MentionPopover";
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
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const { workspaces, skills, mcpServers, subagents } = useChatStore();

  const [dragging, setDragging] = useState(false);
  const [permMenuOpen, setPermMenuOpen] = useState(false);

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

  useEffect(() => {
    if (!permMenuOpen) return;
    const handleClickOutside = (ev: MouseEvent) => {
      if (permMenuRef.current && !permMenuRef.current.contains(ev.target as Node)) {
        setPermMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [permMenuOpen]);

  // 重置高度当 value 清空时
  useEffect(() => {
    if (!value && textareaRef.current) {
      textareaRef.current.style.height = "auto";
      setMention(null);
    }
  }, [value]);

  return (
    <div className="w-full px-5 pb-4 pt-1.5 bg-transparent flex-shrink-0">
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
            placeholder="输入消息或任务，输入 @ 引用资源，粘贴或拖入图片、表格、文档，Enter 发送，Shift + Enter 换行..."
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
              <div ref={permMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setPermMenuOpen((prev) => !prev)}
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

                {permMenuOpen && (
                  <div className="fixed z-[160] w-[340px] rounded-xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] p-1.5 select-none"
                    style={{
                      left: Math.max(
                        12,
                        Math.min(
                          (permMenuRef.current?.getBoundingClientRect().left ?? 24),
                          window.innerWidth - 356
                        )
                      ),
                      bottom:
                        window.innerHeight -
                        (permMenuRef.current?.getBoundingClientRect().top ?? window.innerHeight - 60) +
                        8,
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
                  </div>
                )}
              </div>
            )}

            {/* 模型下拉选择器 */}
            {chatModels && chatModels.length > 0 && onChangeModel && (
              <div className="relative">
                <select
                  value={selectedModel}
                  onChange={(e) => onChangeModel(e.target.value)}
                  className="appearance-none bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] border border-[color:var(--ui-border-hairline)] rounded-lg pl-2.5 pr-7 py-1 text-xs font-medium text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] outline-none focus:border-[color:var(--ui-accent-blue-border)] transition-colors cursor-pointer"
                >
                  {chatModels.map((m) => (
                    <option key={m.id} value={m.id} className="bg-[var(--ui-popover-bg)] text-[var(--ui-text-primary)]">
                      {m.name || m.model_id}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={12}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ui-text-faint)] pointer-events-none"
                />
              </div>
            )}
          </div>

          {/* 右侧发送 / 停止按钮 */}
          <div>
            {isGenerating ? (
              <button
                type="button"
                onClick={() => onCancel?.()}
                className="w-8 h-8 rounded-xl flex items-center justify-center bg-[var(--ui-accent-rose-soft)] hover:bg-rose-600 text-[var(--ui-accent-rose)] hover:text-white border border-[color:var(--ui-accent-rose-border)] hover:border-rose-500 transition-all shadow-sm active:scale-95 cursor-pointer"
                title="停止生成 (Esc)"
              >
                <Square size={11} fill="currentColor" />
              </button>
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
