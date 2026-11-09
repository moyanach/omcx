import { useCallback } from "react";
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
  const {
    activeSessionId,
    messages,
    generatingBySession,
    setSessionGenerating,
    upsertSessionToolCall,
    clearSessionToolCalls,
    setSessionTodos,
    setSessionPermission,
    addMessage,
    appendMessageDelta,
    saveMessageToDb,
    updateMessageMetadata,
    truncateMessages,
    setContextMetrics,
    refreshOutputs,
  } = useChatStore();

  const isGenerating = Boolean(activeSessionId && generatingBySession[activeSessionId]);

  const sendMessage = useCallback(
    async (
      text: string,
      selectedModel: string,
      enableTools: boolean,
      callbacks?: StreamCallbacks,
      attachments?: ChatAttachment[],
    ) => {
      if (!activeSessionId || !text.trim()) return;
      const targetSessionId = activeSessionId;

      setSessionGenerating(targetSessionId, true);
      clearSessionToolCalls(targetSessionId);
      setSessionTodos(targetSessionId, []);
      setSessionPermission(targetSessionId, null);

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
      await addMessage(targetSessionId, userMsg);

      const assistantMsgId = crypto.randomUUID();
      const assistantMsg = {
        id: assistantMsgId,
        role: "assistant" as const,
        content: "",
        createdAt: Date.now(),
      };
      await addMessage(targetSessionId, assistantMsg, true);

      const currentMsgs = useChatStore.getState().messages[targetSessionId] || [];
      const contextMsgs = currentMsgs
        .filter((m) => m.id !== assistantMsgId)
        .map((m) => {
          const attachmentList = m.metadata?.attachments;
          return Array.isArray(attachmentList) && attachmentList.length > 0
            ? { role: m.role, content: m.content, attachments: attachmentList }
            : { role: m.role, content: m.content };
        });

      let accumulatedContent = "";
      const currentSession = useChatStore.getState().sessions.find((s) => s.id === targetSessionId);
      const currentWorkDir = currentSession?.workDir || null;
      const currentPermissionMode = currentSession?.permissionMode || "auto-sandbox";
      const currentReasoningEffort = currentSession?.reasoningEffort || "medium";

      if (window.electronAPI?.streamChat) {
        window.electronAPI.streamChat(
          targetSessionId,
          contextMsgs,
          selectedModel,
          enableTools,
          currentWorkDir,
          (delta: string) => {
            accumulatedContent += delta;
            appendMessageDelta(targetSessionId, assistantMsgId, delta);
          },
          (endPayload: any) => {
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            const durationMs = Date.now() - startTime;
            const durationFormatted = formatDuration(durationMs);
            const endMeta = endPayload?.metadata || (typeof endPayload === "object" ? endPayload : null);
            const finalContent =
              accumulatedContent ||
              endPayload?.content ||
              (endPayload?.metadata?.cancelled ? "已停止生成。" : "");

            const finalMeta = {
              ...(typeof endMeta === "object" && endMeta ? endMeta : {}),
              durationMs,
              durationFormatted,
            };

            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: finalContent,
              createdAt: Date.now(),
              metadata: finalMeta,
            });
            updateMessageMetadata(targetSessionId, assistantMsgId, finalMeta);
          },
          (err: string) => {
            const errorContent = formatErrorContent(err);
            accumulatedContent += errorContent;
            appendMessageDelta(targetSessionId, assistantMsgId, errorContent);
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: accumulatedContent,
              createdAt: Date.now(),
            });
          },
          (statusData: any) => {
            upsertSessionToolCall(targetSessionId, statusData);
            callbacks?.onToolStatus?.(statusData);
          },
          (metrics: any) => {
            setContextMetrics(metrics, targetSessionId);
          },
          (outputItem?: any) => {
            const store = useChatStore.getState();
            if (store.activeSessionId === targetSessionId) {
              refreshOutputs(targetSessionId);
              const sess = store.sessions.find((s) => s.id === targetSessionId);
              store.refreshGitStatus(sess?.workDir);

              // 当 Agent 创建或修改了 HTML / SVG 等可视化产物且开启了自动预览时，自动在右侧工作台打开或热刷新
              if (outputItem?.filePath) {
                const ext = String(outputItem.fileType || "").toLowerCase();
                if (
                  store.autoOpenHtmlOutputs &&
                  (ext === "html" || ext === "htm" || ext === "svg")
                ) {
                  const localUrl = `local-media://local${encodeURI(outputItem.filePath)}`;
                  store.openUrlInWorkbench(localUrl, outputItem.name, outputItem.filePath);
                } else {
                  // 若该文件已在工作台打开，触发热刷新
                  const openFileTab = store.workbenchTabs.find(
                    (t) =>
                      t.filePath &&
                      (t.filePath === outputItem.filePath ||
                        outputItem.filePath.endsWith(`/${t.filePath}`))
                  );
                  if (openFileTab) {
                    store.updateWorkbenchTab(openFileTab.id, { refreshKey: Date.now() });
                  }
                }
              }
            }
          },
          (permData: any) => {
            setSessionPermission(targetSessionId, permData);
            callbacks?.onPermissionRequest?.(permData);
          },
          (todos: any) => {
            setSessionTodos(targetSessionId, todos);
            callbacks?.onTodosUpdate?.(todos);
          },
          (data: any) => {
            callbacks?.onCompaction?.(data);
          },
          currentPermissionMode,
          currentReasoningEffort
        );
      } else {
        setSessionGenerating(targetSessionId, false);
      }
    },
    [
      activeSessionId,
      messages,
      setSessionGenerating,
      clearSessionToolCalls,
      setSessionTodos,
      setSessionPermission,
      upsertSessionToolCall,
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
      const targetSessionId = activeSessionId;

      setSessionGenerating(targetSessionId, true);
      clearSessionToolCalls(targetSessionId);
      setSessionTodos(targetSessionId, []);
      setSessionPermission(targetSessionId, null);

      const startTime = Date.now();

      try {
        await truncateMessages(targetSessionId, msgId);

        const assistantMsgId = crypto.randomUUID();
        const assistantMsg = {
          id: assistantMsgId,
          role: "assistant" as const,
          content: "",
          createdAt: Date.now(),
        };
        await addMessage(targetSessionId, assistantMsg, true);

        const keptMsgs = (useChatStore.getState().messages[targetSessionId] || [])
          .filter((m) => m.id !== assistantMsgId)
          .map((m) => {
            const attachmentList = m.metadata?.attachments;
            return Array.isArray(attachmentList) && attachmentList.length > 0
              ? { role: m.role, content: m.content, attachments: attachmentList }
              : { role: m.role, content: m.content };
          });

        let accumulatedContent = "";
        const currentSession = useChatStore.getState().sessions.find((s) => s.id === targetSessionId);
        const currentWorkDir = currentSession?.workDir || null;
        const currentPermissionMode = currentSession?.permissionMode || "auto-sandbox";
        const currentReasoningEffort = currentSession?.reasoningEffort || "medium";

        window.electronAPI.streamChat(
          targetSessionId,
          keptMsgs,
          selectedModel,
          enableTools,
          currentWorkDir,
          (delta: string) => {
            accumulatedContent += delta;
            appendMessageDelta(targetSessionId, assistantMsgId, delta);
          },
          (endPayload: any) => {
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            const durationMs = Date.now() - startTime;
            const durationFormatted = formatDuration(durationMs);
            const endMeta = endPayload?.metadata || (typeof endPayload === "object" ? endPayload : null);
            const finalContent =
              accumulatedContent ||
              endPayload?.content ||
              (endPayload?.metadata?.cancelled ? "已停止生成。" : "");

            const finalMeta = {
              ...(typeof endMeta === "object" && endMeta ? endMeta : {}),
              durationMs,
              durationFormatted,
            };

            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: finalContent,
              createdAt: Date.now(),
              metadata: finalMeta,
            });
            updateMessageMetadata(targetSessionId, assistantMsgId, finalMeta);
          },
          (err: string) => {
            const errorContent = formatErrorContent(err);
            accumulatedContent += errorContent;
            appendMessageDelta(targetSessionId, assistantMsgId, errorContent);
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: accumulatedContent,
              createdAt: Date.now(),
            });
          },
          (statusData: any) => {
            upsertSessionToolCall(targetSessionId, statusData);
            callbacks?.onToolStatus?.(statusData);
          },
          (metrics: any) => {
            setContextMetrics(metrics, targetSessionId);
          },
          (outputItem?: any) => {
            const store = useChatStore.getState();
            if (store.activeSessionId === targetSessionId) {
              refreshOutputs(targetSessionId);
              const sess = store.sessions.find((s) => s.id === targetSessionId);
              store.refreshGitStatus(sess?.workDir);

              // 当 Agent 创建或修改了 HTML / SVG 等可视化产物且开启了自动预览时，自动在右侧工作台打开或热刷新
              if (outputItem?.filePath) {
                const ext = String(outputItem.fileType || "").toLowerCase();
                if (
                  store.autoOpenHtmlOutputs &&
                  (ext === "html" || ext === "htm" || ext === "svg")
                ) {
                  const localUrl = `local-media://local${encodeURI(outputItem.filePath)}`;
                  store.openUrlInWorkbench(localUrl, outputItem.name, outputItem.filePath);
                } else {
                  // 若该文件已在工作台打开，触发热刷新
                  const openFileTab = store.workbenchTabs.find(
                    (t) =>
                      t.filePath &&
                      (t.filePath === outputItem.filePath ||
                        outputItem.filePath.endsWith(`/${t.filePath}`))
                  );
                  if (openFileTab) {
                    store.updateWorkbenchTab(openFileTab.id, { refreshKey: Date.now() });
                  }
                }
              }
            }
          },
          (permData: any) => {
            setSessionPermission(targetSessionId, permData);
            callbacks?.onPermissionRequest?.(permData);
          },
          (todos: any) => {
            setSessionTodos(targetSessionId, todos);
            callbacks?.onTodosUpdate?.(todos);
          },
          (data: any) => {
            callbacks?.onCompaction?.(data);
          },
          currentPermissionMode,
          currentReasoningEffort
        );
      } catch (err) {
        console.error("重试失败:", err);
        setSessionGenerating(targetSessionId, false);
      }
    },
    [
      activeSessionId,
      messages,
      setSessionGenerating,
      clearSessionToolCalls,
      setSessionTodos,
      setSessionPermission,
      upsertSessionToolCall,
      addMessage,
      appendMessageDelta,
      saveMessageToDb,
      updateMessageMetadata,
      truncateMessages,
      setContextMetrics,
      refreshOutputs,
    ],
  );

  const cancelMessage = useCallback(() => {
    if (!activeSessionId) return;
    if (window.electronAPI?.cancelChat) {
      window.electronAPI.cancelChat(activeSessionId);
    }
  }, [activeSessionId]);

  return { isGenerating, sendMessage, retryMessage, cancelMessage };
}
