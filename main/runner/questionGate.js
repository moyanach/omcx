const {
  pendingQuestions,
  PERMISSION_TIMEOUT_MS,
  notifyDesktopIfBackground,
  clearAppBadge,
} = require("../shared");

function supersedeSessionQuestions(sessionId, replyStream, event) {
  for (const [qId, entry] of pendingQuestions) {
    if (entry.sessionId !== sessionId) continue;
    pendingQuestions.delete(qId);
    try {
      entry.settle({
        submitted: false,
        skipped: true,
        answers: {},
        reason: "新的执行请求已接管当前会话，旧提问自动作废",
      });
    } catch {}
    try {
      if (event?.sender && !event.sender.isDestroyed()) {
        replyStream("user_question_resolved", {
          id: qId,
          reason: "新的执行请求已接管当前会话，旧提问自动作废",
        });
      }
    } catch {}
  }
}

function createQuestionAsker({
  sessionId,
  event,
  replyStream,
  customAskUser,
}) {
  return async ({ title, questions } = {}) => {
    if (typeof customAskUser === "function") {
      return await customAskUser({ title, questions });
    }
    if (!event?.sender) {
      return {
        submitted: false,
        skipped: true,
        headlessFallback: true,
        answers: {},
        note: "当前处于无头非交互模式，请基于上下文与最佳实践自主决策并继续执行。",
      };
    }

    const reqId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      let settled = false;
      let destroyedHandler = null;
      let timer = null;

      const settleOnce = (resp) => {
        if (settled) return;
        settled = true;
        clearAppBadge();
        if (timer) clearTimeout(timer);
        pendingQuestions.delete(reqId);
        if (destroyedHandler && event?.sender) {
          try {
            event.sender.removeListener("destroyed", destroyedHandler);
          } catch {}
        }
        const submitted = Boolean(resp?.submitted);
        const skipped = Boolean(resp?.skipped) || !submitted;
        const answers =
          resp?.answers && typeof resp.answers === "object" && !Array.isArray(resp.answers)
            ? resp.answers
            : {};
        resolve({
          submitted,
          skipped,
          answers,
          ...(resp?.reason ? { reason: String(resp.reason) } : {}),
          ...(skipped && !resp?.reason
            ? { note: "用户选择了跳过/自行决定，请基于上下文与最佳实践自主推进。" }
            : {}),
        });
      };

      const notifyResolved = (reason) => {
        try {
          if (event?.sender && !event.sender.isDestroyed()) {
            replyStream("user_question_resolved", { id: reqId, reason });
          }
        } catch {}
      };

      timer = setTimeout(() => {
        settleOnce({
          submitted: false,
          skipped: true,
          answers: {},
          reason: "等待用户回答超时，已自动跳过，请基于最佳实践自主推进",
        });
        notifyResolved("等待用户回答超时，已自动跳过");
      }, PERMISSION_TIMEOUT_MS);

      destroyedHandler = () => {
        settleOnce({
          submitted: false,
          skipped: true,
          answers: {},
          reason: "窗口已关闭，提问自动结束",
        });
      };
      try {
        event?.sender?.once("destroyed", destroyedHandler);
      } catch {}

      pendingQuestions.set(reqId, { sessionId, settle: settleOnce });
      const firstQuestion = Array.isArray(questions) && questions[0]?.question ? questions[0].question : "";
      notifyDesktopIfBackground({
        title: title || "OMCX 需要你补充信息",
        body: firstQuestion || "请在窗口中确认交互式问题",
        badge: true,
      });
      replyStream("user_question", {
        id: reqId,
        title: title || "需要你的确认",
        questions: Array.isArray(questions) ? questions : [],
      });
    });
  };
}

module.exports = {
  supersedeSessionQuestions,
  createQuestionAsker,
};
