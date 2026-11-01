import { useState, useCallback } from "react";
import { useChatStore, type ChatAttachment } from "../stores/chatStore";

interface StreamCallbacks {
  onToolStatus?: (status: {
    tool: string;
    status: "running" | "done";
    args: any;
    result?: any;
    callId?: string;
  }) => void;
  onPermissionRequest?: (perm: {
    id: string;
    path: string;
    action: string;
    reason: string;
  }) => void;
  onTodosUpdate?: (todos: any[]) => void;
  onCompaction?: (data: {
    beforeTokens: number;
    afterTokens: number;
    keptMessages: number;
    summarizedMessages: number;
    at: number;
  }) => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

function parseErrorDetails(err: string) {
  let parsed: any = null;
  try {
    parsed = JSON.parse(err);
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.type !== "HTTP_ERROR") {
    return {
      summary: err,
      details: `\`\`\`text\n${err}\n\`\`\``,
    };
  }

  const status = parsed.status || "未知状态";
  const statusText = parsed.statusText || "";
  const model = parsed.model || "未知模型";
  const toolRound = parsed.toolRound ?? "未知";
  const url = parsed.url || "";
  const roles = Array.isArray(parsed.requestBody?.messageRoles)
    ? parsed.requestBody.messageRoles.join(" → ")
    : "";
  const toolsCount = parsed.requestBody?.toolsCount ?? 0;
  const toolChoice = parsed.requestBody?.toolChoice ?? "未设置";
  const responseBody = parsed.responseBody || "";

  return {
    summary: statusText ? `HTTP 错误: ${status} ${statusText}` : `HTTP 错误: ${status}`,
    details: [
      `<details open>`,
      `<summary>查看错误详情</summary>`,
      "",
      `- 状态: ${status}`,
      statusText ? `- 状态说明: ${statusText}` : "",
      `- URL: ${url}`,
      `- 模型: ${model}`,
      `- 工具轮次: ${toolRound}`,
      `- 工具数量: ${toolsCount}`,
      `- tool_choice: ${toolChoice}`,
      roles ? `- 消息角色链: ${roles}` : "",
      "",
      "```json",
      responseBody,
      "```",
      "",
      "</details>",
    ].filter(Boolean).join("\n"),
  };
}

function formatErrorContent(err: string) {
  const { summary, details } = parseErrorDetails(err);
  return `\n\n[生成失败: ${summary}]\n\n${details}`;
}

export function useStreamChat() {
  const [isGenerating, setIsGenerating] = useState(false);
  const {
    activeSessionId,
    messages,
    addMessage,
    appendMessageDelta,
    saveMessageToDb,
    updateMessageMetadata,
    truncateMessages,
    setContextMetrics,
    refreshOutputs,
  } = useChatStore();

  const sendMessage = useCallback(
    async (
      text: string,
      selectedModel: string,
      enableTools: boolean,
      callbacks?: StreamCallbacks,
      attachments?: ChatAttachment[],
    ) => {
      if (!activeSessionId || !text.trim()) return;

      setIsGenerating(true);
      const startTime = Date.now();

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text.trim(),
        createdAt: startTime,
        ...(attachments && attachments.length > 0
          ? { metadata: { attachments } }
          : {}),
      };
      await addMessage(activeSessionId, userMsg);

      const assistantMsgId = crypto.randomUUID();
      const assistantMsg = {
        id: assistantMsgId,
        role: "assistant" as const,
        content: "",
        createdAt: Date.now(),
      };
      await addMessage(activeSessionId, assistantMsg, true);

      const currentMsgs = messages[activeSessionId] || [];
      const contextMsgs = [...currentMsgs, userMsg].map((m) => {
        const attachmentList = m.metadata?.attachments;
        return Array.isArray(attachmentList) && attachmentList.length > 0
          ? { role: m.role, content: m.content, attachments: attachmentList }
          : { role: m.role, content: m.content };
      });

      let accumulatedContent = "";
      const currentSession = useChatStore.getState().sessions.find((s) => s.id === activeSessionId);
      const currentWorkDir = currentSession?.workDir || null;

      if (window.electronAPI?.streamChat) {
        window.electronAPI.streamChat(
          activeSessionId,
          contextMsgs,
          selectedModel,
          enableTools,
          currentWorkDir,
          (delta: string) => {
            accumulatedContent += delta;
            appendMessageDelta(activeSessionId, assistantMsgId, delta);
          },
          (endPayload: any) => {
            setIsGenerating(false);
            const durationMs = Date.now() - startTime;
            const durationFormatted = formatDuration(durationMs);
            const endMeta = endPayload?.metadata || (typeof endPayload === "object" ? endPayload : null);
            const finalContent = accumulatedContent || endPayload?.content || "";

            const finalMeta = {
              ...(typeof endMeta === "object" && endMeta ? endMeta : {}),
              durationMs,
              durationFormatted,
            };

            saveMessageToDb(activeSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: finalContent,
              createdAt: Date.now(),
              metadata: finalMeta,
            });
            updateMessageMetadata(activeSessionId, assistantMsgId, finalMeta);
          },
          (err: string) => {
            const errorContent = formatErrorContent(err);
            accumulatedContent += errorContent;
            appendMessageDelta(activeSessionId, assistantMsgId, errorContent);
            setIsGenerating(false);
            saveMessageToDb(activeSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: accumulatedContent,
              createdAt: Date.now(),
            });
          },
          (statusData: any) => {
            callbacks?.onToolStatus?.(statusData);
          },
          (metrics: any) => {
            setContextMetrics(metrics);
          },
          () => {
            refreshOutputs(activeSessionId);
            const currentSession = useChatStore.getState().sessions.find((s) => s.id === activeSessionId);
            useChatStore.getState().refreshGitStatus(currentSession?.workDir);
          },
          (permData: any) => {
            callbacks?.onPermissionRequest?.(permData);
          },
          (todos: any) => {
            callbacks?.onTodosUpdate?.(todos);
          },
          (data: any) => {
            callbacks?.onCompaction?.(data);
          }
        );
      } else {
        setIsGenerating(false);
      }
    },
    [
      activeSessionId,
      messages,
      addMessage,
      appendMessageDelta,
      saveMessageToDb,
      updateMessageMetadata,
      setContextMetrics,
      refreshOutputs,
    ],
  );

  const retryMessage = useCallback(
    async (
      msgId: string,
      selectedModel: string,
      enableTools: boolean,
      callbacks?: StreamCallbacks,
    ) => {
      if (!activeSessionId || !window.electronAPI?.streamChat) return;
      setIsGenerating(true);
      const startTime = Date.now();

      try {
        await truncateMessages(activeSessionId, msgId);

        const assistantMsgId = crypto.randomUUID();
        const assistantMsg = {
          id: assistantMsgId,
          role: "assistant" as const,
          content: "",
          createdAt: Date.now(),
        };
        await addMessage(activeSessionId, assistantMsg, true);

        const keptMsgs = (messages[activeSessionId] || []).map((m) => {
          const attachmentList = m.metadata?.attachments;
          return Array.isArray(attachmentList) && attachmentList.length > 0
            ? { role: m.role, content: m.content, attachments: attachmentList }
            : { role: m.role, content: m.content };
        });

        let accumulatedContent = "";
        const currentSession = useChatStore.getState().sessions.find((s) => s.id === activeSessionId);
        const currentWorkDir = currentSession?.workDir || null;

        window.electronAPI.streamChat(
          activeSessionId,
          keptMsgs,
          selectedModel,
          enableTools,
          currentWorkDir,
          (delta: string) => {
            accumulatedContent += delta;
            appendMessageDelta(activeSessionId, assistantMsgId, delta);
          },
          (endPayload: any) => {
            setIsGenerating(false);
            const durationMs = Date.now() - startTime;
            const durationFormatted = formatDuration(durationMs);
            const endMeta = endPayload?.metadata || (typeof endPayload === "object" ? endPayload : null);
            const finalContent = accumulatedContent || endPayload?.content || "";

            const finalMeta = {
              ...(typeof endMeta === "object" && endMeta ? endMeta : {}),
              durationMs,
              durationFormatted,
            };

            saveMessageToDb(activeSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: finalContent,
              createdAt: Date.now(),
              metadata: finalMeta,
            });
            updateMessageMetadata(activeSessionId, assistantMsgId, finalMeta);
          },
          (err: string) => {
            const errorContent = formatErrorContent(err);
            accumulatedContent += errorContent;
            appendMessageDelta(activeSessionId, assistantMsgId, errorContent);
            setIsGenerating(false);
            saveMessageToDb(activeSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: accumulatedContent,
              createdAt: Date.now(),
            });
          },
          (statusData: any) => {
            callbacks?.onToolStatus?.(statusData);
          },
          (metrics: any) => {
            setContextMetrics(metrics);
          },
          () => {
            refreshOutputs(activeSessionId);
            const currentSession = useChatStore.getState().sessions.find((s) => s.id === activeSessionId);
            useChatStore.getState().refreshGitStatus(currentSession?.workDir);
          },
          (permData: any) => {
            callbacks?.onPermissionRequest?.(permData);
          },
          (todos: any) => {
            callbacks?.onTodosUpdate?.(todos);
          },
          (data: any) => {
            callbacks?.onCompaction?.(data);
          }
        );
      } catch (err) {
        console.error("重试失败:", err);
        setIsGenerating(false);
      }
    },
    [
      activeSessionId,
      messages,
      addMessage,
      appendMessageDelta,
      saveMessageToDb,
      updateMessageMetadata,
      truncateMessages,
      setContextMetrics,
      refreshOutputs,
    ],
  );

  return { isGenerating, sendMessage, retryMessage };
}
