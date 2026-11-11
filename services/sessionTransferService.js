/**
 * 会话分支与导出服务
 *
 * - forkSession: 复制会话元数据、消息（可截断到指定消息）、产物与会话附件目录
 * - buildSessionMarkdown: 生成可读的 Markdown 会话记录
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const storageService = require("./storageService");

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function rewriteAttachmentPaths(metadata, fromSessionId, toSessionId) {
  if (!metadata || typeof metadata !== "object") return metadata;
  const list = Array.isArray(metadata.attachments) ? metadata.attachments : null;
  if (!list) return metadata;
  const fromDir = storageService.getSessionAttachmentsDir(fromSessionId);
  const toDir = storageService.getSessionAttachmentsDir(toSessionId);
  return {
    ...metadata,
    attachments: list.map((attachment) => {
      if (!attachment || typeof attachment.path !== "string") return attachment;
      if (!attachment.path.startsWith(fromDir)) return attachment;
      return { ...attachment, path: attachment.path.replace(fromDir, toDir) };
    }),
  };
}

function copyAttachments(fromSessionId, toSessionId) {
  const fromDir = storageService.getSessionAttachmentsDir(fromSessionId);
  const toDir = storageService.getSessionAttachmentsDir(toSessionId);
  if (!fs.existsSync(fromDir)) return;
  try {
    fs.cpSync(fromDir, toDir, { recursive: true, force: true });
  } catch (err) {
    console.error("[sessionTransfer] 复制附件失败:", err.message);
  }
}

/**
 * @param {string} sessionId
 * @param {{upToMessageId?: string}} options
 */
function forkSession(sessionId, options = {}) {
  const session = storageService.getSession(sessionId);
  if (!session) return { success: false, error: "源会话不存在" };

  const allMessages = storageService.getMessages(sessionId);
  let selected = allMessages;
  if (options.upToMessageId) {
    const idx = allMessages.findIndex((m) => m.id === options.upToMessageId);
    if (idx < 0) return { success: false, error: "未找到指定的分支消息" };
    selected = allMessages.slice(0, idx + 1);
  }

  const newSessionId = newId("session");
  const now = Date.now();
  const saved = storageService.saveSession({
    id: newSessionId,
    title: `${session.title || "未命名会话"} (分支)`,
    title_source: "custom",
    model: session.model,
    workspace_id: session.workspace_id,
    work_dir: session.work_dir,
    permission_mode: session.permission_mode,
    reasoning_effort: session.reasoning_effort,
    created_at: now,
    updated_at: now,
  });
  if (!saved.success) return saved;

  copyAttachments(sessionId, newSessionId);

  for (const msg of selected) {
    storageService.addMessage(newSessionId, {
      id: newId("msg"),
      role: msg.role,
      content: msg.content,
      tool_calls: msg.tool_calls,
      tool_call_id: msg.tool_call_id,
      metadata: rewriteAttachmentPaths(msg.metadata, sessionId, newSessionId),
      created_at: msg.created_at,
    });
  }

  const outputs = storageService.getSessionOutputs(sessionId);
  for (const output of outputs) {
    storageService.addSessionOutput(newSessionId, {
      name: output.name,
      filePath: output.filePath,
      fileType: output.fileType,
      action: output.action,
    });
  }

  return {
    success: true,
    session: saved.session,
    sessionId: newSessionId,
    messageCount: selected.length,
  };
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(value || "");
  }
}

function truncate(text, max) {
  const str = String(text || "");
  return str.length > max ? `${str.slice(0, max)}\n\n…[内容过长已截断，原文 ${str.length} 字符]` : str;
}

function buildSessionMarkdown(sessionId) {
  const session = storageService.getSession(sessionId);
  if (!session) return { success: false, error: "会话不存在" };
  const messages = storageService.getMessages(sessionId);
  const lines = [];

  lines.push(`# ${session.title || "Agent 会话"}`);
  lines.push("");
  lines.push(`- **会话 ID**：\`${session.id}\``);
  lines.push(`- **模型**：${session.model || "-"}`);
  lines.push(`- **工作目录**：\`${session.work_dir || "-"}\``);
  lines.push(`- **权限模式**：${session.permission_mode || "-"}`);
  lines.push(`- **创建时间**：${formatTime(session.created_at)}`);
  lines.push(`- **导出时间**：${formatTime(Date.now())}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") {
      const name = msg.metadata?.toolName || msg.tool_call_id || "tool";
      lines.push(`<details><summary>工具结果 · ${name}</summary>`);
      lines.push("");
      lines.push("```text");
      lines.push(truncate(msg.content, 4000));
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
      continue;
    }

    const roleLabel = msg.role === "user" ? "用户" : msg.role === "assistant" ? "Agent" : msg.role;
    lines.push(`## ${roleLabel} · ${formatTime(msg.created_at)}`);
    lines.push("");
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      lines.push(
        `> 调用工具：${msg.tool_calls
          .map((tc) => `\`${tc.function?.name || "tool"}\``)
          .join("、")}`
      );
      lines.push("");
    }
    lines.push(truncate(msg.content, 20000) || "（空）");
    lines.push("");
  }

  return {
    success: true,
    markdown: lines.join("\n"),
    suggestedFileName: `${(session.title || "session").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.md`,
  };
}

module.exports = { forkSession, buildSessionMarkdown };
