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
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
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

  // 图片附件
  attachments?: DraftChatAttachment[];
  onChangeAttachments?: (next: DraftChatAttachment[]) => void;
  onNotify?: (message: string) => void;

  // 中断当前生成任务
  onCancel?: () => void;
}

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
  attachments = [] as DraftChatAttachment[],
  onChangeAttachments,
  onNotify,
  onCancel,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { workspaces, skills, mcpServers } = useChatStore();

  const [dragging, setDragging] = useState(false);

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
        ? filterUnifiedMentions(mention.query, fileIndex, skills, mcpServers)
        : { items: [], grouped: { skills: [], mcps: [], files: [] } },
    [mention, fileIndex, skills, mcpServers]
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
        className={`w-full bg-[#1e1e1e] hover:bg-[#202020] focus-within:bg-[#1f1f1f] border rounded-xl shadow-lg transition-all duration-200 overflow-hidden flex flex-col ${
          dragging
            ? "border-blue-500/70 ring-2 ring-blue-500/20"
            : "border-[#2d2d2d] focus-within:border-[#3e3e3e]"
        }`}
      >
        {/* 多类型附件预览条 (支持图片缩略图与多样化文件胶囊卡片) */}
        {attachments.length > 0 && (
          <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto custom-scrollbar">
            {attachments.map((item) => (
              <div
                key={item.id}
                className="relative flex-shrink-0 group rounded-xl overflow-hidden border border-[#353535] bg-[#141414]"
                title={`${item.name} (${formatFileSize(item.size)}) · ${item.placeholder}`}
              >
                {item.category === "image" && item.previewUrl ? (
                  <div className="relative w-16 h-16">
                    <img src={item.previewUrl} alt={item.name} className="w-full h-full object-cover" />
                    <span className="absolute bottom-0 left-0 right-0 text-[9px] leading-4 bg-black/70 text-neutral-300 text-center font-mono truncate px-1">
                      {item.placeholder}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 h-14 max-w-[200px] select-none">
                    <div className="w-8 h-8 rounded-lg bg-[#222222] border border-[#333333] flex items-center justify-center flex-shrink-0">
                      {item.category === "spreadsheet" && (
                        <FileSpreadsheet size={16} className="text-emerald-400" />
                      )}
                      {item.category === "text" && (
                        <FileCode size={16} className="text-blue-400" />
                      )}
                      {item.category === "document" && (
                        <FileText size={16} className="text-rose-400" />
                      )}
                      {item.category === "archive" && (
                        <FileArchive size={16} className="text-amber-400" />
                      )}
                      {item.category === "binary" && (
                        <GenericFileIcon size={16} className="text-purple-400" />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0 pr-4">
                      <span className="text-xs font-medium text-neutral-200 truncate" title={item.name}>
                        {item.name}
                      </span>
                      <span className="text-[10px] text-neutral-500 font-mono">
                        {formatFileSize(item.size)}
                      </span>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => removeAttachment(item.id)}
                  className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/80 text-neutral-300 hover:text-white hover:bg-rose-600 flex items-center justify-center transition-colors shadow-sm"
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
            className="chat-textarea-seamless w-full max-h-44 min-h-[46px] bg-transparent text-neutral-100 placeholder-neutral-500 resize-none border-none outline-none ring-0 focus:ring-0 focus:outline-none focus:border-none shadow-none text-sm leading-relaxed scroll-smooth"
            rows={1}
          />
        </div>

        {/* 底部功能栏 (彻底移除 border-t 割裂线条，自然与文本区融为一体) */}
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
              className="flex items-center justify-center w-7 h-7 rounded-lg text-neutral-400 hover:text-white bg-[#161616] hover:bg-[#222222] border border-[#2d2d2d] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={`添加附件 (支持图片、代码、表格、文档等，最多 ${MAX_CHAT_ATTACHMENTS} 个)`}
            >
              <Paperclip size={13} />
            </button>
            {/* 工作空间目录按钮 (优先展示项目工作空间名称) */}
            {onSelectWorkDir && (
              <button
                onClick={onSelectWorkDir}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors select-none shadow-sm group border ${
                  workDir
                    ? "bg-blue-500/10 text-blue-300 border-blue-500/20 hover:bg-blue-500/20"
                    : "text-neutral-300 hover:text-white bg-[#161616] hover:bg-[#222222] border-[#2d2d2d]"
                }`}
                title={
                  matchedWs
                    ? `工作空间: ${matchedWs.name}\n包含 ${matchedWs.folders.length} 个源目录\n点击编辑工作空间`
                    : workDir
                    ? `工作目录: ${workDir}\n点击配置多源文件夹工作空间`
                    : "未指定工作空间，点击选择本地项目目录"
                }
              >
                <FolderGit2 size={13} className="text-blue-400 group-hover:scale-105 transition-transform flex-shrink-0" />
                <span className="max-w-[200px] truncate font-medium">
                  {workspaceDisplayName}
                </span>
              </button>
            )}

            {/* 模型下拉选择器 */}
            {chatModels && chatModels.length > 0 && onChangeModel && (
              <div className="relative">
                <select
                  value={selectedModel}
                  onChange={(e) => onChangeModel(e.target.value)}
                  className="appearance-none bg-[#161616] hover:bg-[#222222] border border-[#2d2d2d] rounded-lg pl-2.5 pr-7 py-1 text-xs font-medium text-neutral-300 hover:text-white outline-none focus:border-blue-500/50 transition-colors cursor-pointer"
                >
                  {chatModels.map((m) => (
                    <option key={m.id} value={m.id} className="bg-[#1c1c1c] text-neutral-200">
                      {m.name || m.model_id}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={12}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
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
                className="w-8 h-8 rounded-xl flex items-center justify-center bg-rose-500/15 hover:bg-rose-600 text-rose-400 hover:text-white border border-rose-500/30 hover:border-rose-500 transition-all shadow-md shadow-rose-600/10 active:scale-95 cursor-pointer"
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
                    ? "bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/30 active:scale-95 cursor-pointer"
                    : "bg-[#252525] text-neutral-500 cursor-not-allowed border border-[#303030]"
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
