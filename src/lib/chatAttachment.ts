export const MAX_CHAT_ATTACHMENTS = 6;
export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 单文件最大 20MB

export type AttachmentFileType =
  | "image"
  | "text"
  | "spreadsheet"
  | "document"
  | "archive"
  | "binary";

export interface DraftChatAttachment {
  id: string;
  file: File;
  name: string;
  mime: string;
  size: number;
  previewUrl: string;
  placeholder: string;
  category: AttachmentFileType;
  extension: string;
}

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "svg", "tiff", "avif"
]);

const SPREADSHEET_EXTS = new Set(["xlsx", "xls", "csv", "tsv", "parquet"]);

const DOCUMENT_EXTS = new Set([
  "pdf", "docx", "doc", "pptx", "ppt", "epub", "rtf", "odt"
]);

const ARCHIVE_EXTS = new Set([
  "zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"
]);

const TEXT_LIKE_EXTS = new Set([
  "md", "markdown", "txt", "text", "log", "json", "json5", "jsonl",
  "yaml", "yml", "toml", "xml", "html", "htm", "css", "scss", "less",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "pyw", "java", "go", "rs", "c", "h", "cpp", "hpp", "cc", "cxx",
  "cs", "php", "rb", "swift", "kt", "kts", "dart", "scala",
  "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1",
  "sql", "env", "ini", "conf", "config", "dockerfile", "makefile", "gemfile"
]);

export function getFileExtension(filename: string): string {
  const parts = filename.split(".");
  if (parts.length <= 1) return "";
  return (parts.pop() || "").toLowerCase();
}

export function classifyAttachment(filename: string, mime = ""): AttachmentFileType {
  const ext = getFileExtension(filename);
  const lowerMime = (mime || "").toLowerCase();

  if (lowerMime.startsWith("image/") || IMAGE_EXTS.has(ext)) {
    return "image";
  }
  if (SPREADSHEET_EXTS.has(ext) || lowerMime.includes("spreadsheet") || lowerMime.includes("excel")) {
    return "spreadsheet";
  }
  if (DOCUMENT_EXTS.has(ext) || lowerMime.includes("pdf") || lowerMime.includes("word") || lowerMime.includes("presentation")) {
    return "document";
  }
  if (ARCHIVE_EXTS.has(ext) || lowerMime.includes("zip") || lowerMime.includes("tar") || lowerMime.includes("compressed")) {
    return "archive";
  }
  if (TEXT_LIKE_EXTS.has(ext) || lowerMime.startsWith("text/") || lowerMime.includes("json") || lowerMime.includes("javascript")) {
    return "text";
  }
  return "binary";
}

export function isImageAttachment(filename: string, mime = ""): boolean {
  return classifyAttachment(filename, mime) === "image";
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const commaIndex = dataUrl.indexOf(",");
      resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "");
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}
