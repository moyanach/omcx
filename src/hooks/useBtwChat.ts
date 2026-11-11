import { useCallback } from "react";
import { useChatStore, type BtwThread, type Message } from "../stores/chatStore";

const MAX_DIGEST_MESSAGES = 6;
const MAX_DIGEST_ITEM_CHARS = 1200;
const MAX_DIGEST_CHARS = 6000;

function trimForDigest(content: string, maxChars: number): string {
  const text = String(content || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * 主任务摘要：只取最近几条 user/assistant 文本，剥离工具轨迹，单向注入旁路上下文。
 * 不会把旁路问答写回主消息列表。
 */
export function buildBtwContextDigest(messages: Message[]): string {
  const tail = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .slice(-MAX_DIGEST_MESSAGES);

  const lines = tail
    .map((message) => {
      const label = message.role === "user" ? "用户" : "助手";
      const text = trimForDigest(message.content, MAX_DIGEST_ITEM_CHARS);
      return text ? `${label}：${text}` : "";
    })
    .filter(Boolean);

  const digest = lines.join("\n\n");
  return digest.length > MAX_DIGEST_CHARS ? digest.slice(-MAX_DIGEST_CHARS) : digest;
}

/**
 * 旁路问答 Hook (/btw)
 *
 * - 独立于 useStreamChat：不设置 generatingBySession，不写消息，不触发主任务状态机；
 * - 主任务生成中仍可调用；
 * - 同一会话只保留一条运行中的旁路请求，新请求自动替换旧请求。
 */
export function useBtwChat() {
  const askBtw = useCallback(
    async (
      question: string,
      options?: { sessionId?: string; model?: string; quotedText?: string }
    ): Promise<string | null> => {
      const api = (window as any).electronAPI;
      const state = useChatStore.getState();
      const sessionId = options?.sessionId || state.activeSessionId;
      const text = String(question || "").trim();
      if (!sessionId || !text) return null;

      // 引用来源：显式传入优先；否则消费当前会话待引用的主会话选中内容
      const quotedText = String(
        options?.quotedText ?? state.btwQuoteBySession[sessionId]?.text ?? ""
      )
        .trim()
        .slice(0, 8000);
      if (!api?.btwChat) {
        console.warn('[btw] 当前窗口未加载旁路问答 API，请重启应用');
        return null;
      }

      // 同一会话的旧旁路请求先取消，避免两路回答交错写入同一线程
      const runningBtwId = state.btwRunningBySession[sessionId];
      if (runningBtwId) {
        state.finishBtwThread(sessionId, runningBtwId, {
          status: "cancelled",
          finishedAt: Date.now(),
        });
        try {
          await api?.cancelBtw?.(runningBtwId);
        } catch {
          // 忽略取消失败：新请求会由主进程自动接管
        }
      }

      const btwId = `btw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const session = state.sessions.find((item) => item.id === sessionId);
      const thread: BtwThread = {
        id: btwId,
        question: text,
        answer: "",
        status: "streaming",
        quotedText: quotedText || undefined,
        toolSteps: [],
        createdAt: Date.now(),
      };

      // 抽屉内 follow-up 的指代上下文：此处 state 尚未包含刚创建的当前线程
      const history = (state.btwThreadsBySession[sessionId] || [])
        .filter((item) => item.status === "done" && item.answer)
        .slice(-3)
        .map((item) => ({ question: item.question, answer: item.answer }));

      state.startBtwThread(sessionId, thread);
      if (quotedText) state.clearBtwQuote(sessionId);

      const digest = buildBtwContextDigest(state.messages[sessionId] || []);

      try {
        const response = await api?.btwChat?.(
          {
            sessionId,
            btwId,
            question: text,
            model: options?.model || session?.model || undefined,
            workDir: session?.workDir || null,
            contextDigest: digest,
            quotedText: quotedText || undefined,
            history,
          },
          {
            onData: (delta: string) => {
              useChatStore.getState().appendBtwDelta(sessionId, btwId, delta);
            },
            onToolStatus: (step: any) => {
              useChatStore.getState().upsertBtwToolStep(sessionId, btwId, step);
            },
            onEnd: (payload: any) => {
              const patch: Partial<BtwThread> = {
                status: payload?.cancelled ? "cancelled" : "done",
                usage: payload?.usage || undefined,
                hitRoundLimit: Boolean(payload?.hitRoundLimit),
                finishedAt: Date.now(),
              };
              if (typeof payload?.content === "string" && payload.content.trim()) {
                patch.answer = payload.content;
              }
              useChatStore.getState().finishBtwThread(sessionId, btwId, patch);
            },
            onError: (payload: any) => {
              useChatStore.getState().finishBtwThread(sessionId, btwId, {
                status: "error",
                error:
                  payload?.message ||
                  payload?.error ||
                  (typeof payload === "string" ? payload : "旁路提问失败"),
                finishedAt: Date.now(),
              });
            },
          }
        );

        if (response && response.ok === false) {
          // 启动阶段被拒绝（如缺少 API Key）：把待引用片段还给用户，避免选中内容丢失
          if (quotedText) {
            useChatStore.getState().setBtwQuote(sessionId, {
              text: quotedText,
              createdAt: Date.now(),
            });
          }
          useChatStore.getState().finishBtwThread(sessionId, btwId, {
            status: "error",
            error: response.error || "旁路提问启动失败",
            finishedAt: Date.now(),
          });
        }
      } catch (err: any) {
        useChatStore.getState().finishBtwThread(sessionId, btwId, {
          status: "error",
          error: err?.message || String(err),
          finishedAt: Date.now(),
        });
      }

      return btwId;
    },
    []
  );

  const cancelBtw = useCallback((btwId: string) => {
    if (!btwId) return;
    const state = useChatStore.getState();
    const sessionId = Object.keys(state.btwRunningBySession).find(
      (key) => state.btwRunningBySession[key] === btwId
    );
    if (sessionId) {
      state.finishBtwThread(sessionId, btwId, {
        status: "cancelled",
        finishedAt: Date.now(),
      });
    }
    try {
      (window as any).electronAPI?.cancelBtw?.(btwId);
    } catch {
      // 忽略取消失败
    }
  }, []);

  const clearBtw = useCallback((sessionId?: string) => {
    const state = useChatStore.getState();
    const targetSessionId = sessionId || state.activeSessionId;
    if (!targetSessionId) return;
    const runningBtwId = state.btwRunningBySession[targetSessionId];
    if (runningBtwId) {
      try {
        (window as any).electronAPI?.cancelBtw?.(runningBtwId);
      } catch {
        // 忽略取消失败
      }
    }
    state.clearBtwThreads(targetSessionId);
  }, []);

  return { askBtw, cancelBtw, clearBtw };
}
