import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  FileSpreadsheet,
  FileCode,
  FileText,
  FileArchive,
  File as GenericFileIcon,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
} from "lucide-react";
import { formatFileSize, type DraftChatAttachment } from "@/lib/chatAttachment";

export interface PreviewImageItem {
  src: string;
  name: string;
  size?: number;
  filePath?: string;
}

interface ImagePreviewLightboxProps {
  images: PreviewImageItem[];
  initialIndex: number;
  onClose: () => void;
}

/**
 * 通用图片高清放大预览弹窗（挂载于 body 顶层，支持缩放、多图切换与 Finder 定位）
 */
export const ImagePreviewLightbox: React.FC<ImagePreviewLightboxProps> = ({
  images,
  initialIndex,
  onClose,
}) => {
  const [currentIndex, setCurrentIndex] = useState(() =>
    Math.max(0, Math.min(initialIndex, images.length - 1))
  );
  const [zoom, setZoom] = useState(1);

  const current = images[currentIndex];
  const hasMultiple = images.length > 1;

  const goPrev = () => {
    if (!hasMultiple) return;
    setCurrentIndex((i) => (i - 1 + images.length) % images.length);
    setZoom(1);
  };

  const goNext = () => {
    if (!hasMultiple) return;
    setCurrentIndex((i) => (i + 1) % images.length);
    setZoom(1);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && hasMultiple) {
        e.preventDefault();
        setCurrentIndex((i) => (i - 1 + images.length) % images.length);
        setZoom(1);
      } else if (e.key === "ArrowRight" && hasMultiple) {
        e.preventDefault();
        setCurrentIndex((i) => (i + 1) % images.length);
        setZoom(1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [images.length, hasMultiple, onClose]);

  if (!current || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex flex-col select-none"
      onClick={onClose}
      onWheel={(e) => {
        if (Math.abs(e.deltaY) < 4) return;
        setZoom((z) => {
          const delta = e.deltaY < 0 ? 0.15 : -0.15;
          return Math.max(0.5, Math.min(3, Number((z + delta).toFixed(2))));
        });
      }}
    >
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between px-5 py-3.5 text-white/90 bg-gradient-to-b from-black/55 to-transparent flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-sm font-medium truncate max-w-[45vw]" title={current.name}>
            {current.name || "图片预览"}
          </span>
          {typeof current.size === "number" && current.size > 0 && (
            <span className="text-xs text-white/55 font-mono flex-shrink-0">
              {formatFileSize(current.size)}
            </span>
          )}
          {hasMultiple && (
            <span className="px-2 py-0.5 rounded-full bg-white/10 text-[11px] font-mono text-white/80 flex-shrink-0">
              {currentIndex + 1} / {images.length}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors cursor-pointer"
            title="缩小 (-)"
          >
            <ZoomOut size={15} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="h-8 px-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-mono flex items-center gap-1 transition-colors cursor-pointer"
            title="重置为 100% (0)"
          >
            <RotateCcw size={12} />
            <span>{Math.round(zoom * 100)}%</span>
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors cursor-pointer"
            title="放大 (+)"
          >
            <ZoomIn size={15} />
          </button>
          {current.filePath && (
            <button
              type="button"
              onClick={() => window.electronAPI?.showInFolder?.(current.filePath!)}
              className="h-8 px-2.5 ml-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
              title="在文件夹中显示"
            >
              <FolderOpen size={14} />
              <span>打开所在文件夹</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 ml-1 rounded-lg bg-white/10 hover:bg-rose-500/80 flex items-center justify-center transition-colors cursor-pointer"
            title="关闭预览 (Esc)"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* 主大图展示区 */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden p-4">
        {hasMultiple && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            className="absolute left-5 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/75 border border-white/15 text-white flex items-center justify-center transition-colors cursor-pointer"
            title="上一张 (←)"
          >
            <ChevronLeft size={20} />
          </button>
        )}

        <img
          src={current.src}
          alt={current.name || "图片预览"}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setZoom((z) => (z === 1 ? 1.75 : 1));
          }}
          style={{ transform: `scale(${zoom})` }}
          className="max-w-[88vw] max-h-[82vh] object-contain rounded-lg shadow-2xl transition-transform duration-150 cursor-grab active:cursor-grabbing"
          draggable={false}
        />

        {hasMultiple && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            className="absolute right-5 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/75 border border-white/15 text-white flex items-center justify-center transition-colors cursor-pointer"
            title="下一张 (→)"
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>
    </div>,
    document.body
  );
};

interface AttachmentPreviewStripProps {
  attachments: DraftChatAttachment[];
  onRemove: (id: string) => void;
}

export const AttachmentPreviewStrip: React.FC<AttachmentPreviewStripProps> = ({
  attachments,
  onRemove,
}) => {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  if (attachments.length === 0) return null;

  const previewableImages: Array<{ attachmentId: string; item: PreviewImageItem }> = attachments
    .filter((att) => att.category === "image" && att.previewUrl)
    .map((att) => ({
      attachmentId: att.id,
      item: {
        src: att.previewUrl,
        name: att.name,
        size: att.size,
        filePath: (att.file as any)?.path || undefined,
      },
    }));

  return (
    <>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[color:var(--ui-divider-hairline)] overflow-x-auto custom-scrollbar">
        {attachments.map((item) => {
          const isPreviewableImage = item.category === "image" && Boolean(item.previewUrl);
          const imgIdx = isPreviewableImage
            ? previewableImages.findIndex((p) => p.attachmentId === item.id)
            : -1;

          return (
            <div
              key={item.id}
              className="relative flex-shrink-0 group"
              title={
                isPreviewableImage
                  ? `${item.name} (${formatFileSize(item.size)}) · 点击放大预览`
                  : `${item.name} (${formatFileSize(item.size)})`
              }
            >
              {isPreviewableImage ? (
                <button
                  type="button"
                  onClick={() => {
                    if (imgIdx >= 0) setPreviewIndex(imgIdx);
                  }}
                  className="block w-12 h-12 rounded-lg overflow-hidden border border-[color:var(--ui-border-subtle)] bg-[var(--ui-card-inner-bg)] hover:border-[color:var(--ui-accent-blue-border)] transition-all cursor-zoom-in focus:outline-none"
                >
                  <img
                    src={item.previewUrl}
                    alt={item.name}
                    className="w-full h-full object-cover"
                  />
                </button>
              ) : (
                <div className="flex items-center gap-2 px-2.5 h-12 max-w-[200px] rounded-lg border border-[color:var(--ui-border-subtle)] bg-[var(--ui-card-inner-bg)] select-none">
                  <div className="w-7 h-7 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-center flex-shrink-0">
                    {item.category === "spreadsheet" && (
                      <FileSpreadsheet size={15} className="text-[var(--ui-accent-emerald)]" />
                    )}
                    {item.category === "text" && (
                      <FileCode size={15} className="text-[var(--ui-accent-blue)]" />
                    )}
                    {item.category === "document" && (
                      <FileText size={15} className="text-[var(--ui-accent-rose)]" />
                    )}
                    {item.category === "archive" && (
                      <FileArchive size={15} className="text-[var(--ui-accent-amber)]" />
                    )}
                    {item.category === "binary" && (
                      <GenericFileIcon size={15} className="text-[var(--ui-accent-purple)]" />
                    )}
                  </div>
                  <div className="flex flex-col min-w-0 pr-1">
                    <span
                      className="text-xs font-medium text-[var(--ui-text-primary)] truncate"
                      title={item.name}
                    >
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
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item.id);
                }}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-neutral-900/90 text-white hover:bg-rose-600 border border-white/20 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all shadow-sm cursor-pointer"
                title="移除此附件"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
      </div>

      {previewIndex !== null && previewableImages.length > 0 && (
        <ImagePreviewLightbox
          images={previewableImages.map((p) => p.item)}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </>
  );
};
