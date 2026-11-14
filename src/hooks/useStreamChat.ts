import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore, type ChatAttachment, type QueuedPrompt } from "../stores/chatStore";

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
  onSteered?: (steers: Array<{ id: string; content: string; at: number }>) => void;
}

// 队列自动接力的延迟定时器：按会话记录，便于用户手动发起新请求时取消接力，避免并发双跑
const autoRelayTimers = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; prompt: QueuedPrompt }
>();

function clearAutoRelayTimer(sessionId: string) {
  const pending = autoRelayTimers.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  autoRelayTimers.delete(sessionId);
}

function cancelPendingAutoRelay(sessionId: string) {
  const pending = autoRelayTimers.get(sessionId);
  if (!pending) return;
  clearAutoRelayTimer(sessionId);
  // 该排队项已被 dequeue 但还没执行：用户手动发送时要放回队首，避免消息丢失
  useChatStore.getState().enqueuePrompt(sessionId, pending.prompt);
  useChatStore.getState().moveQueuedPromptToTop(sessionId, pending.prompt.id);
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

/**
 * 将未被消费的纠偏指示（pendingSteers）回退为普通排队任务，插入队列最前。
 * 场景：用户在 Agent 收尾瞬间注入纠偏，主进程已退出循环未能注入上下文。
 */
function recoverPendingSteers(
  sessionId: string,
  pendingSteers: any,
  modelId?: string,
  enableTools?: boolean,
) {
  if (!sessionId || !Array.isArray(pendingSteers) || pendingSteers.length === 0) return;
  const store = useChatStore.getState();
  const existing = store.promptQueueBySession[sessionId] || [];
  const existingIds = new Set(existing.map((p) => p.id));
  const recovered: QueuedPrompt[] = pendingSteers
    .filter((s) => s && s.content && !existingIds.has(s.id))
    .map((s) => ({
      id: s.id || crypto.randomUUID(),
      sessionId,
      content: String(s.content),
      modelId,
      enableTools,
      createdAt: Date.now(),
    }));
  if (recovered.length === 0) return;
  useChatStore.setState((state) => ({
    promptQueueBySession: {
      ...state.promptQueueBySession,
      [sessionId]: [...recovered, ...(state.promptQueueBySession[sessionId] || [])],
    },
  }));
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
    appendMessageReasoning,
    saveMessageToDb,
    updateMessageMetadata,
    truncateMessages,
    setContextMetrics,
    refreshOutputs,
    setSessionStartTime,
    setSessionWaiting,
  } = useChatStore(
    useShallow((s) => ({
      activeSessionId: s.activeSessionId,
      messages: s.messages,
      generatingBySession: s.generatingBySession,
      setSessionGenerating: s.setSessionGenerating,
      upsertSessionToolCall: s.upsertSessionToolCall,
      clearSessionToolCalls: s.clearSessionToolCalls,
      setSessionTodos: s.setSessionTodos,
      setSessionPermission: s.setSessionPermission,
      addMessage: s.addMessage,
      appendMessageDelta: s.appendMessageDelta,
      appendMessageReasoning: s.appendMessageReasoning,
      saveMessageToDb: s.saveMessageToDb,
      updateMessageMetadata: s.updateMessageMetadata,
      truncateMessages: s.truncateMessages,
      setContextMetrics: s.setContextMetrics,
      refreshOutputs: s.refreshOutputs,
      setSessionStartTime: s.setSessionStartTime,
      setSessionWaiting: s.setSessionWaiting,
    }))
  );

  const isGenerating = Boolean(activeSessionId && generatingBySession[activeSessionId]);

  const sendMessage = useCallback(
    async (
      text: string,
      selectedModel: string,
      enableTools: boolean,
      callbacks?: StreamCallbacks,
      attachments?: ChatAttachment[],
      targetSessionIdOverride?: string,
    ) => {
      const targetSessionId = targetSessionIdOverride || activeSessionId;
      if (!targetSessionId || (!text.trim() && (!attachments || attachments.length === 0))) return;

      // 用户手动发起新请求时取消尚未触发的队列接力，防止同一会话并发启动两次 chat-request
      cancelPendingAutoRelay(targetSessionId);

      setSessionGenerating(targetSessionId, true);
      clearSessionToolCalls(targetSessionId);
      setSessionTodos(targetSessionId, []);
      setSessionPermission(targetSessionId, null);
      setSessionWaiting(targetSessionId, 0);

      const startTime = Date.now();
      setSessionStartTime(targetSessionId, startTime);

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
      // 保留 id 供主进程按需回填历史思考（window 回传模式），
      // 主进程会在组装请求体前剥离该字段，不会污染上游 protocol payload。
      const contextMsgs = currentMsgs
        .filter((m) => m.id !== assistantMsgId)
        .map((m) => {
          const attachmentList = m.metadata?.attachments;
          const base = { id: m.id, role: m.role, content: m.content };
          return Array.isArray(attachmentList) && attachmentList.length > 0
            ? { ...base, attachments: attachmentList }
            : base;
        });

      let accumulatedContent = "";
      let accumulatedReasoning = "";
      let deltaBuffer = "";
      let reasoningBuffer = "";
      let flushRafId: number | null = null;

      // 流式增量批处理节流：借助 rAF 合并微小 chunk，彻底消除高频 setState 导致的渲染进程 CPU 暴击
      const flushBuffer = () => {
        if (flushRafId !== null) {
          cancelAnimationFrame(flushRafId);
          flushRafId = null;
        }
        if (deltaBuffer) {
          const chunk = deltaBuffer;
          deltaBuffer = "";
          appendMessageDelta(targetSessionId, assistantMsgId, chunk);
        }
        if (reasoningBuffer) {
          const chunk = reasoningBuffer;
          reasoningBuffer = "";
          appendMessageReasoning(targetSessionId, assistantMsgId, chunk);
        }
      };

      const handleIncomingDelta = (delta: string) => {
        accumulatedContent += delta;
        deltaBuffer += delta;
        if (useChatStore.getState().waitingBySession[targetSessionId]) {
          setSessionWaiting(targetSessionId, 0);
        }
        if (flushRafId === null) {
          flushRafId = requestAnimationFrame(() => {
            flushRafId = null;
            flushBuffer();
          });
        }
      };

      const handleIncomingReasoning = (delta: string) => {
        if (!delta) return;
        accumulatedReasoning += delta;
        reasoningBuffer += delta;
        if (useChatStore.getState().waitingBySession[targetSessionId]) {
          setSessionWaiting(targetSessionId, 0);
        }
        if (flushRafId === null) {
          flushRafId = requestAnimationFrame(() => {
            flushRafId = null;
            flushBuffer();
          });
        }
      };

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
          assistantMsgId,
          handleIncomingDelta,
          (endPayload: any) => {
            flushBuffer();
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            setSessionStartTime(targetSessionId, null);
            setSessionWaiting(targetSessionId, 0);
            const durationMs = Date.now() - startTime;
            const durationFormatted = formatDuration(durationMs);
            const endMeta = endPayload?.metadata || (typeof endPayload === "object" ? endPayload : null);
            const finalContent =
              accumulatedContent ||
              endPayload?.content ||
              (endPayload?.metadata?.cancelled ? "已停止生成。" : "");
            const finalReasoning = accumulatedReasoning || endPayload?.reasoning || "";

            const finalMeta = {
              ...(typeof endMeta === "object" && endMeta ? endMeta : {}),
              durationMs,
              durationFormatted,
              ...(finalReasoning ? { reasoningChars: finalReasoning.length } : {}),
            };

            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: finalContent,
              createdAt: Date.now(),
              metadata: finalMeta,
              reasoning: finalReasoning || undefined,
            });
            updateMessageMetadata(targetSessionId, assistantMsgId, finalMeta);

            // 收尾瞬间注入但未被消费的纠偏指示 -> 回退为排队任务，插入队首
            recoverPendingSteers(
              targetSessionId,
              endPayload?.metadata?.pendingSteers,
              selectedModel,
              enableTools
            );

            // 若非主动取消，检查当前会话队列中是否有待执行任务，自动出队无缝接力
            const isCancelled = Boolean(endPayload?.metadata?.cancelled);
            if (!isCancelled) {
              const nextPrompt = useChatStore.getState().dequeuePrompt(targetSessionId);
              if (nextPrompt) {
                const timer = setTimeout(() => {
                  autoRelayTimers.delete(targetSessionId);
                  // 120ms 窗口内用户可能已手动发起新一轮：把队列项放回队首，绝不再开一条并发流
                  if (useChatStore.getState().generatingBySession[targetSessionId]) {
                    useChatStore.getState().enqueuePrompt(targetSessionId, nextPrompt);
                    useChatStore
                      .getState()
                      .moveQueuedPromptToTop(targetSessionId, nextPrompt.id);
                    return;
                  }
                  sendMessage(
                    nextPrompt.content,
                    nextPrompt.modelId || selectedModel,
                    nextPrompt.enableTools !== undefined ? nextPrompt.enableTools : enableTools,
                    callbacks,
                    nextPrompt.attachments,
                    targetSessionId
                  );
                }, 120);
                autoRelayTimers.set(targetSessionId, { timer, prompt: nextPrompt });
              }
            }
          },
          (err: string) => {
            flushBuffer();
            const errorContent = formatErrorContent(err);
            accumulatedContent += errorContent;
            appendMessageDelta(targetSessionId, assistantMsgId, errorContent);
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            setSessionStartTime(targetSessionId, null);
            setSessionWaiting(targetSessionId, 0);
            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: accumulatedContent,
              createdAt: Date.now(),
              reasoning: accumulatedReasoning || undefined,
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
          currentReasoningEffort,
          (steers: any[]) => {
            if (!Array.isArray(steers) || steers.length === 0) return;
            for (const steer of steers) {
              const content = String(steer?.content || "").trim();
              if (!content) continue;
              addMessage(targetSessionId, {
                id: crypto.randomUUID(),
                role: "user",
                content,
                createdAt: Date.now(),
                metadata: { steering: true, steerRef: steer?.id },
              });
            }
            callbacks?.onSteered?.(steers);
          },
          (info: any) => {
            const idleSec = Number(info?.idleSec) || 0;
            if (idleSec > 0) setSessionWaiting(targetSessionId, idleSec);
          },
          handleIncomingReasoning,
          (data: any) => {
            // 主进程侧自动作废审批（超时/被新请求接管）时同步关闭弹窗
            const current = useChatStore.getState().permissionBySession?.[targetSessionId];
            if (!current) return;
            if (!data?.id || current.id === data.id) {
              setSessionPermission(targetSessionId, null);
            }
          }
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
      appendMessageReasoning,
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
      setSessionWaiting(targetSessionId, 0);

      const startTime = Date.now();
      setSessionStartTime(targetSessionId, startTime);

      try {
        // 重新生成时目标消息本身也必须移除，否则旧回答会与新回答并存并污染上下文
        await truncateMessages(targetSessionId, msgId, false);

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
            // 同 sendMessage：携带 id 供主进程做 window 模式历史思考回填
            const base = { id: m.id, role: m.role, content: m.content };
            return Array.isArray(attachmentList) && attachmentList.length > 0
              ? { ...base, attachments: attachmentList }
              : base;
          });

        let accumulatedContent = "";
        let accumulatedReasoning = "";
        let deltaBuffer = "";
        let reasoningBuffer = "";
        let flushRafId: number | null = null;

        const flushBuffer = () => {
          if (flushRafId !== null) {
            cancelAnimationFrame(flushRafId);
            flushRafId = null;
          }
          if (deltaBuffer) {
            const chunk = deltaBuffer;
            deltaBuffer = "";
            appendMessageDelta(targetSessionId, assistantMsgId, chunk);
          }
          if (reasoningBuffer) {
            const chunk = reasoningBuffer;
            reasoningBuffer = "";
            appendMessageReasoning(targetSessionId, assistantMsgId, chunk);
          }
        };

        const handleIncomingDelta = (delta: string) => {
          accumulatedContent += delta;
          deltaBuffer += delta;
          if (useChatStore.getState().waitingBySession[targetSessionId]) {
            setSessionWaiting(targetSessionId, 0);
          }
          if (flushRafId === null) {
            flushRafId = requestAnimationFrame(() => {
              flushRafId = null;
              flushBuffer();
            });
          }
        };

        const handleIncomingReasoning = (delta: string) => {
          if (!delta) return;
          accumulatedReasoning += delta;
          reasoningBuffer += delta;
          if (useChatStore.getState().waitingBySession[targetSessionId]) {
            setSessionWaiting(targetSessionId, 0);
          }
          if (flushRafId === null) {
            flushRafId = requestAnimationFrame(() => {
              flushRafId = null;
              flushBuffer();
            });
          }
        };

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
          assistantMsgId,
          handleIncomingDelta,
          (endPayload: any) => {
            flushBuffer();
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            setSessionStartTime(targetSessionId, null);
            setSessionWaiting(targetSessionId, 0);
            const durationMs = Date.now() - startTime;
            const durationFormatted = formatDuration(durationMs);
            const endMeta = endPayload?.metadata || (typeof endPayload === "object" ? endPayload : null);
            const finalContent =
              accumulatedContent ||
              endPayload?.content ||
              (endPayload?.metadata?.cancelled ? "已停止生成。" : "");
            const finalReasoning = accumulatedReasoning || endPayload?.reasoning || "";

            const finalMeta = {
              ...(typeof endMeta === "object" && endMeta ? endMeta : {}),
              durationMs,
              durationFormatted,
              ...(finalReasoning ? { reasoningChars: finalReasoning.length } : {}),
            };

            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: finalContent,
              createdAt: Date.now(),
              metadata: finalMeta,
              reasoning: finalReasoning || undefined,
            });
            updateMessageMetadata(targetSessionId, assistantMsgId, finalMeta);

            // 收尾瞬间注入但未被消费的纠偏指示 -> 回退为排队任务，插入队首
            recoverPendingSteers(
              targetSessionId,
              endPayload?.metadata?.pendingSteers,
              selectedModel,
              enableTools
            );

            // 若非主动取消，检查当前会话队列中是否有待执行任务，自动出队无缝接力
            const isCancelled = Boolean(endPayload?.metadata?.cancelled);
            if (!isCancelled) {
              const nextPrompt = useChatStore.getState().dequeuePrompt(targetSessionId);
              if (nextPrompt) {
                const timer = setTimeout(() => {
                  autoRelayTimers.delete(targetSessionId);
                  // 120ms 窗口内用户可能已手动发起新一轮：把队列项放回队首，绝不再开一条并发流
                  if (useChatStore.getState().generatingBySession[targetSessionId]) {
                    useChatStore.getState().enqueuePrompt(targetSessionId, nextPrompt);
                    useChatStore
                      .getState()
                      .moveQueuedPromptToTop(targetSessionId, nextPrompt.id);
                    return;
                  }
                  sendMessage(
                    nextPrompt.content,
                    nextPrompt.modelId || selectedModel,
                    nextPrompt.enableTools !== undefined ? nextPrompt.enableTools : enableTools,
                    callbacks,
                    nextPrompt.attachments,
                    targetSessionId
                  );
                }, 120);
                autoRelayTimers.set(targetSessionId, { timer, prompt: nextPrompt });
              }
            }
          },
          (err: string) => {
            flushBuffer();
            const errorContent = formatErrorContent(err);
            accumulatedContent += errorContent;
            appendMessageDelta(targetSessionId, assistantMsgId, errorContent);
            setSessionGenerating(targetSessionId, false);
            setSessionPermission(targetSessionId, null);
            setSessionStartTime(targetSessionId, null);
            setSessionWaiting(targetSessionId, 0);
            saveMessageToDb(targetSessionId, {
              id: assistantMsgId,
              role: "assistant",
              content: accumulatedContent,
              createdAt: Date.now(),
              reasoning: accumulatedReasoning || undefined,
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
          currentReasoningEffort,
          (steers: any[]) => {
            if (!Array.isArray(steers) || steers.length === 0) return;
            for (const steer of steers) {
              const content = String(steer?.content || "").trim();
              if (!content) continue;
              addMessage(targetSessionId, {
                id: crypto.randomUUID(),
                role: "user",
                content,
                createdAt: Date.now(),
                metadata: { steering: true, steerRef: steer?.id },
              });
            }
            callbacks?.onSteered?.(steers);
          },
          (info: any) => {
            const idleSec = Number(info?.idleSec) || 0;
            if (idleSec > 0) setSessionWaiting(targetSessionId, idleSec);
          },
          handleIncomingReasoning,
          (data: any) => {
            const current = useChatStore.getState().permissionBySession?.[targetSessionId];
            if (!current) return;
            if (!data?.id || current.id === data.id) {
              setSessionPermission(targetSessionId, null);
            }
          }
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
      appendMessageReasoning,
      saveMessageToDb,
      updateMessageMetadata,
      truncateMessages,
      setContextMetrics,
      refreshOutputs,
    ],
  );

  const cancelMessage = useCallback(() => {
    if (!activeSessionId) return;
    setSessionStartTime(activeSessionId, null);
    // 取消必须本地收敛生成态：主进程可能已无对应 run（end 事件不会再来），
    // 只依赖 end 事件会让会话永久卡在“生成中”。
    setSessionGenerating(activeSessionId, false);
    setSessionWaiting(activeSessionId, 0);
    setSessionPermission(activeSessionId, null);
    if (window.electronAPI?.cancelChat) {
      window.electronAPI.cancelChat(activeSessionId);
    }
  }, [
    activeSessionId,
    setSessionStartTime,
    setSessionGenerating,
    setSessionWaiting,
    setSessionPermission,
  ]);

  const runQueuedPromptNow = useCallback(
    async (prompt: QueuedPrompt, callbacks?: StreamCallbacks) => {
      if (!prompt || !prompt.sessionId) return;
      const targetSessionId = prompt.sessionId;
      // “立即执行”优先：取消该会话尚未触发的自动接力定时器（不重新入队，避免重复执行）
      clearAutoRelayTimer(targetSessionId);
      // 1. 从队列中移除该项
      useChatStore.getState().removeQueuedPrompt(targetSessionId, prompt.id);
      // 2. 若当前会话正在生成，先请求打断并等待当前轮次安全落盘
      if (useChatStore.getState().generatingBySession[targetSessionId]) {
        if (window.electronAPI?.cancelChat) {
          window.electronAPI.cancelChat(targetSessionId);
        }
        // 以 generating 状态归零为信号驱动交接，避免固定延时在慢模型下过早抢跑，
        // 同时保留超时兜底，防止流结束事件丢失导致队列永久卡住。
        await new Promise<void>((resolve) => {
          let finished = false;
          let unsubscribe: (() => void) | null = null;
          const done = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            unsubscribe?.();
            resolve();
          };
          const timeout = setTimeout(done, 5000);
          unsubscribe = useChatStore.subscribe((state) => {
            if (!state.generatingBySession[targetSessionId]) done();
          });
          if (!useChatStore.getState().generatingBySession[targetSessionId]) done();
        });
      }
      // 3. 立即启动当前任务
      await sendMessage(
        prompt.content,
        prompt.modelId || "model_chat_default",
        prompt.enableTools !== undefined ? prompt.enableTools : true,
        callbacks,
        prompt.attachments,
        targetSessionId
      );
    },
    [sendMessage]
  );

  /**
   * 中途动态转向：将用户在 Agent 执行期间追加的纠偏指示注入当前执行流程。
   * 不会打断当前工具链，而是在下一轮模型请求前作为 user 消息插入上下文。
   * @returns 是否成功投递到主进程
   */
  const steerMessage = useCallback(
    (sessionId: string, content: string, id?: string): boolean => {
      const text = String(content || "").trim();
      if (!sessionId || !text) return false;
      if (!window.electronAPI?.steerChat) return false;
      window.electronAPI.steerChat(sessionId, text, id || crypto.randomUUID());
      return true;
    },
    []
  );

  // 纠偏指令投递时若会话已结束，主进程会拒绝；此时自动回退为普通排队任务
  useEffect(() => {
    if (!window.electronAPI?.onSteerRejected) return;
    const unsubscribe = window.electronAPI.onSteerRejected((payload: any) => {
      const sessionId = payload?.sessionId;
      const content = String(payload?.content || "").trim();
      if (!sessionId || !content) return;
      const store = useChatStore.getState();
      const existing = store.promptQueueBySession[sessionId] || [];
      if (existing.some((p) => p.id === payload.id)) return;
      store.enqueuePrompt(sessionId, {
        id: payload.id || crypto.randomUUID(),
        sessionId,
        content,
        createdAt: Date.now(),
      });
    });
    return unsubscribe;
  }, []);

  return {
    isGenerating,
    sendMessage,
    retryMessage,
    cancelMessage,
    runQueuedPromptNow,
    steerMessage,
  };
}
