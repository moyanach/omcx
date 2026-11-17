import React, { useEffect, useState } from "react";
import {
  FileSpreadsheet,
  FileText,
  Presentation,
  FileType2,
  Loader2,
  AlertCircle,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { CsvTablePreview } from "./CsvTablePreview";

export interface DocumentPreviewPayload {
  kind: "spreadsheet" | "docx" | "doc" | "presentation" | "pdf";
  format: string;
  sheets?: Array<{
    name: string;
    totalRows: number;
    totalCols: number;
    headers: string[];
    rows: string[][];
    truncated?: boolean;
  }>;
  html?: string;
  warnings?: string[];
  text?: string;
  truncated?: boolean;
  slides?: Array<{
    index: number;
    title: string;
    texts: string[];
    notes?: string;
  }>;
  pageCount?: number;
  previewText?: string;
}

interface DocumentRichPreviewProps {
  workDir: string;
  absPath: string;
  fileName: string;
  ext: string;
  refreshKey?: number;
}

export const DocumentRichPreview: React.FC<DocumentRichPreviewProps> = ({
  workDir,
  absPath,
  fileName,
  ext,
  refreshKey,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreviewPayload | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [pdfRenderMode, setPdfRenderMode] = useState<"native" | "text">("native");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setActiveSheetIndex(0);

    if (!window.electronAPI?.previewWorkspaceDocument) {
      setLoading(false);
      setError("当前环境不支持文档预览接口");
      return;
    }

    window.electronAPI
      .previewWorkspaceDocument(workDir, absPath)
      .then((res) => {
        if (cancelled) return;
        if (!res?.success || !res.preview) {
          setError(res?.error || "解析文档失败");
        } else {
          setPreview(res.preview);
        }
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workDir, absPath, refreshKey]);

  if (loading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-xs text-[var(--ui-text-muted)]">
        <Loader2 size={18} className="animate-spin text-[var(--ui-accent-blue)]" />
        <span>正在解析 {fileName} ...</span>
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="p-6 flex flex-col items-center justify-center gap-2 text-center">
        <AlertCircle size={20} className="text-[var(--ui-accent-rose)]" />
        <div className="text-xs font-medium text-[var(--ui-text-primary)]">
          文档预览解析失败
        </div>
        <div className="text-[11px] text-[var(--ui-text-muted)] max-w-md">
          {error || "无法识别文档内容"}
        </div>
      </div>
    );
  }

  if (preview.kind === "spreadsheet") {
    const sheets = preview.sheets || [];
    const current = sheets[activeSheetIndex] || sheets[0];
    if (!current) {
      return (
        <div className="p-8 text-center text-xs text-[var(--ui-text-faint)]">
          工作簿不包含任何工作表
        </div>
      );
    }
    return (
      <div className="w-full h-full flex flex-col overflow-hidden bg-[var(--ui-stage-bg)]">
        {sheets.length > 0 && (
          <div className="px-3 py-1.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center gap-1.5 overflow-x-auto custom-scrollbar flex-shrink-0">
            <FileSpreadsheet size={13} className="text-[var(--ui-accent-emerald)] flex-shrink-0 mr-1" />
            {sheets.map((s, idx) => (
              <button
                key={`${s.name}-${idx}`}
                onClick={() => setActiveSheetIndex(idx)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  idx === activeSheetIndex
                    ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border border-[color:var(--ui-accent-emerald-border)]"
                    : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]"
                }`}
              >
                {s.name} ({s.totalRows})
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-hidden">
          <CsvTablePreview
            key={`${absPath}-${activeSheetIndex}`}
            ext={ext}
            structuredData={{
              headers: current.headers,
              rows: current.rows,
              totalRows: current.totalRows,
              truncated: current.truncated,
            }}
          />
        </div>
      </div>
    );
  }

  if (preview.kind === "docx") {
    return (
      <div className="w-full h-full overflow-auto custom-scrollbar bg-[var(--ui-stage-bg)] p-6">
        <div className="max-w-3xl mx-auto rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-card-bg)] p-6 shadow-sm">
          <div className="flex items-center gap-2 pb-3 mb-4 border-b border-[color:var(--ui-divider-hairline)] text-xs text-[var(--ui-text-muted)]">
            <FileText size={14} className="text-[var(--ui-accent-blue)]" />
            <span className="font-medium text-[var(--ui-text-primary)]">{fileName}</span>
            <span>· Word 文档排版预览</span>
          </div>
          <div
            className="omcx-docx-preview text-[13.5px] leading-relaxed text-[var(--ui-text-primary)] space-y-3 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:w-full [&_table]:border-collapse [&_table]:my-3 [&_th]:border [&_th]:border-[color:var(--ui-border-subtle)] [&_th]:bg-[var(--ui-chip-bg)] [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_td]:border [&_td]:border-[color:var(--ui-border-subtle)] [&_td]:px-2.5 [&_td]:py-1.5"
            dangerouslySetInnerHTML={{ __html: preview.html || "<p>（空文档）</p>" }}
          />
        </div>
      </div>
    );
  }

  if (preview.kind === "doc") {
    return (
      <div className="w-full h-full overflow-auto custom-scrollbar bg-[var(--ui-stage-bg)] p-6">
        <div className="max-w-3xl mx-auto rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-card-bg)] p-6 shadow-sm">
          <div className="flex items-center gap-2 pb-3 mb-4 border-b border-[color:var(--ui-divider-hairline)] text-xs text-[var(--ui-text-muted)]">
            <FileText size={14} className="text-[var(--ui-accent-blue)]" />
            <span className="font-medium text-[var(--ui-text-primary)]">{fileName}</span>
            <span>· 旧版 Word (.doc) 文本预览</span>
          </div>
          <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-[var(--ui-text-primary)]">
            {preview.text || "（未提取到文本内容）"}
          </pre>
        </div>
      </div>
    );
  }

  if (preview.kind === "presentation") {
    const slides = preview.slides || [];
    return (
      <div className="w-full h-full overflow-auto custom-scrollbar bg-[var(--ui-stage-bg)] p-5">
        <div className="max-w-3xl mx-auto flex flex-col gap-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--ui-text-muted)] px-1">
            <div className="flex items-center gap-2">
              <Presentation size={14} className="text-[var(--ui-accent-amber)]" />
              <span className="font-medium text-[var(--ui-text-primary)]">{fileName}</span>
            </div>
            <span className="font-mono">共 {slides.length} 页幻灯片</span>
          </div>

          {slides.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--ui-text-faint)] rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-card-bg)]">
              演示文稿不包含可提取文本的幻灯片
            </div>
          ) : (
            slides.map((slide) => (
              <div
                key={slide.index}
                className="rounded-xl border border-[color:var(--ui-border-subtle)] bg-[var(--ui-card-bg)] p-4 shadow-sm flex flex-col gap-2"
              >
                <div className="flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] pb-2">
                  <span className="text-xs font-semibold text-[var(--ui-text-primary)]">
                    {slide.title}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-[var(--ui-chip-bg)] text-[10px] font-mono text-[var(--ui-text-muted)]">
                    Slide {slide.index}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-[var(--ui-text-secondary)]">
                  {slide.texts.slice(1).length > 0 ? (
                    slide.texts.slice(1).map((line, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-[var(--ui-accent-blue)] mt-1 text-[10px]">•</span>
                        <span>{line}</span>
                      </div>
                    ))
                  ) : (
                    <div className="text-[11px] text-[var(--ui-text-faint)]">（仅标题页）</div>
                  )}
                </div>
                {slide.notes && (
                  <div className="mt-1 pt-2 border-t border-dashed border-[color:var(--ui-divider-hairline)] flex items-start gap-1.5 text-[11px] text-[var(--ui-text-muted)]">
                    <MessageSquare size={12} className="mt-0.5 flex-shrink-0 text-[var(--ui-accent-amber)]" />
                    <span className="whitespace-pre-wrap">{slide.notes}</span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // PDF 预览：原生内嵌阅读器 + 文本提取双视图切换
  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-[var(--ui-stage-bg)]">
      <div className="px-3 py-1.5 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-2 text-[11px] text-[var(--ui-text-muted)]">
          <FileType2 size={13} className="text-[var(--ui-accent-rose)]" />
          <span className="font-mono">共 {preview.pageCount || "?"} 页</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)]">
            <button
              onClick={() => setPdfRenderMode("native")}
              className={`px-2 py-0.5 rounded-md text-[11px] cursor-pointer transition-colors ${
                pdfRenderMode === "native"
                  ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              原生阅读器
            </button>
            <button
              onClick={() => setPdfRenderMode("text")}
              className={`px-2 py-0.5 rounded-md text-[11px] cursor-pointer transition-colors ${
                pdfRenderMode === "text"
                  ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
            >
              提取文本
            </button>
          </div>
          <button
            onClick={() => window.electronAPI?.openPath?.(absPath)}
            className="px-2 py-0.5 rounded-md text-[11px] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] flex items-center gap-1 cursor-pointer"
            title="使用系统默认应用打开 PDF"
          >
            <ExternalLink size={11} />
            <span>外部打开</span>
          </button>
        </div>
      </div>

      {pdfRenderMode === "native" ? (
        <iframe
          key={`${absPath}_${refreshKey || 0}`}
          src={`local-media://local${encodeURI(absPath)}`}
          className="w-full flex-1 border-0 bg-white"
          title={fileName}
        />
      ) : (
        <div className="flex-1 overflow-auto custom-scrollbar p-5">
          <pre className="max-w-3xl mx-auto whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-[var(--ui-text-primary)]">
            {preview.previewText || "（未提取到纯文本，可能是扫描件图片型 PDF，请切回原生阅读器或外部打开）"}
          </pre>
        </div>
      )}
    </div>
  );
};
