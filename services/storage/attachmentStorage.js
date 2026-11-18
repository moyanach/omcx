const fs = require("fs");
const path = require("path");

// 会话 ID / 附件名必须锁定为单层安全段，杜绝 ../../ 路径穿越改写/删除会话外文件
const SAFE_SESSION_ID = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ATTACHMENT_EXT = /^[A-Za-z0-9]{1,12}$/;

function createAttachmentStorage({ getPaths, ensureDir }) {
  function isSafeSessionId(sessionId) {
    const value = String(sessionId || "");
    if (!SAFE_SESSION_ID.test(value)) return false;
    const { SESSIONS_DIR } = getPaths();
    const root = path.resolve(SESSIONS_DIR);
    const resolved = path.resolve(root, value);
    const relative = path.relative(root, resolved);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  function getSessionAttachmentsDir(sessionId) {
    if (!isSafeSessionId(sessionId)) {
      throw new Error("非法会话 ID");
    }
    const { SESSIONS_DIR } = getPaths();
    return path.join(SESSIONS_DIR, sessionId, "attachments");
  }

  function saveAttachmentBuffer(sessionId, id, ext, buffer) {
    const safeId = String(id || "");
    const rawExt = String(ext || "").replace(/^\./, "");
    // 扩展名来自原始文件名，可能超长或含特殊字符：截断/降级而不是让整次上传失败
    const safeExt = SAFE_ATTACHMENT_EXT.test(rawExt)
      ? rawExt
      : rawExt.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "bin";
    if (!SAFE_ATTACHMENT_ID.test(safeId)) {
      throw new Error("非法附件标识");
    }
    const dir = getSessionAttachmentsDir(sessionId);
    ensureDir(dir);
    const filePath = path.join(dir, `${safeId}.${safeExt}`);
    fs.writeFileSync(filePath, buffer);
    return { id: safeId, path: filePath, size: buffer.length };
  }

  function isSessionAttachmentPath(filePath) {
    if (!filePath || typeof filePath !== "string") return false;
    const { SESSIONS_DIR } = getPaths();
    const resolved = path.resolve(filePath);
    const root = path.resolve(SESSIONS_DIR);

    const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
    const compareRoot = isCaseInsensitive ? root.toLowerCase() : root;
    const compareResolved = isCaseInsensitive ? resolved.toLowerCase() : resolved;

    const relative = path.relative(compareRoot, compareResolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    const segments = relative.split(path.sep);
    return segments.length >= 3 && segments[1] === "attachments";
  }

  function deleteAttachmentFile(filePath) {
    if (!isSessionAttachmentPath(filePath)) {
      return { success: false, error: "非法附件路径" };
    }
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function deleteSessionAttachments(sessionId) {
    if (!isSafeSessionId(sessionId)) {
      console.warn(`[storageService] 拒绝删除非法会话目录: ${sessionId}`);
      return { success: false, error: "非法会话 ID" };
    }
    const { SESSIONS_DIR } = getPaths();
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[storageService] 删除会话附件目录失败: ${err.message}`);
    }
  }

  return {
    getSessionAttachmentsDir,
    saveAttachmentBuffer,
    isSessionAttachmentPath,
    deleteAttachmentFile,
    deleteSessionAttachments,
  };
}

module.exports = { createAttachmentStorage };
