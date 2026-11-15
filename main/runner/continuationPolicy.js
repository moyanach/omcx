const { hasUnclosedCodeFence } = require("../shared");

/**
 * 评估无工具调用时的响应是否需要自动续写或重试（纯决策，便于单测守护）。
 * @returns {{ action: "steer" | "retry_empty" | "continue" | "break", mode?: "A" | "B" | "C" | "D" | "E", messagesToAppend?: Array<object>, log?: string }}
 */
function evaluateNoToolResponse({
  result,
  steerQueue,
  initialTodos,
  permissionMode,
  planModeValue,
  fullGeneratedText,
  toolRound,
  emptyRoundRetry,
  continuationCount,
  maxContinuations,
  buildAssistantReplayMessage,
}) {
  const cleanRoundText = (result.content || "").trim();
  const hasIncompleteTodos =
    Array.isArray(initialTodos) &&
    initialTodos.length > 0 &&
    initialTodos.some((t) => t.status !== "completed");

  if (Array.isArray(steerQueue) && steerQueue.length > 0) {
    const steers = steerQueue.splice(0);
    const messagesToAppend = [];
    if (cleanRoundText) {
      messagesToAppend.push({ role: "assistant", content: result.content });
    }
    for (const steer of steers) {
      messagesToAppend.push({
        role: "user",
        content: `【用户中途更新/追加的需求上下文】\n${steer.content}\n\n[系统引导]：用户在当前任务执行中途补充或更新了上述内容。请自主综合分析用户意图（是补充业务背景、澄清细节、细化边界条件，还是调整/纠偏当前执行路线）：\n- 若属于补充背景、澄清细节或细化约束：请将该上下文无缝融合进当前任务，并在后续步骤与最终答复中予以落实；\n- 若属于方向调整或纠偏：请以最新指示为准调整后续行动，无需推倒已完成且不冲突的工作。`,
      });
    }
    return { action: "steer", steers, messagesToAppend };
  }

  const hasAnyPayload =
    cleanRoundText.length > 0 ||
    Boolean(result.reasoning && String(result.reasoning).trim()) ||
    (Array.isArray(result.toolCalls) && result.toolCalls.length > 0);
  if (!hasAnyPayload) {
    if (emptyRoundRetry < 1) {
      return {
        action: "retry_empty",
        log:
          `[chat-stream] 第 ${toolRound + 1} 轮模型返回空响应 ` +
          `(receivedBytes=${result.receivedBytes || 0}, finishReason=${result.finishReason || "none"})，自动重试 1 次`,
      };
    }
    throw new Error(
      `上游模型未返回任何内容（收到的数据量 ${result.receivedBytes || 0} 字节，finish_reason=${
        result.finishReason || "无"
      }）。可能原因：网关超时/连接被中断、模型服务异常或请求被代理拦截。请重试，或切换其他模型。`
    );
  }

  if (result.hitLengthLimit && cleanRoundText.length > 0 && continuationCount < maxContinuations) {
    const nextCount = continuationCount + 1;
    const tailSnippet = result.content.slice(-80);
    return {
      action: "continue",
      mode: "A",
      log: `[auto-continue] 模式A：正文触发长度上限，发起第 ${nextCount} 次无缝断点续写`,
      messagesToAppend: [
        buildAssistantReplayMessage(result, { content: result.content }),
        {
          role: "user",
          content: `你的上一条回复因达到单次输出长度上限而在末尾中断（中断处末尾字符为：${JSON.stringify(
            tailSnippet
          )}）。请紧接在该位置之后无缝继续输出剩余内容，禁止重复前文或添加任何开场白。`,
        },
      ],
    };
  }

  if (
    (result.hitLengthLimit ||
      result.abruptlyClosed ||
      (result.reasoning && cleanRoundText.length === 0)) &&
    continuationCount < maxContinuations
  ) {
    if (result.abruptlyClosed && cleanRoundText.length > 0) {
      const nextCount = continuationCount + 1;
      const tailSnippet = result.content.slice(-80);
      return {
        action: "continue",
        mode: "E",
        log: `[auto-continue] 模式E：上游流连接提前中断，发起第 ${nextCount} 次断点续写`,
        messagesToAppend: [
          buildAssistantReplayMessage(result, { content: result.content }),
          {
            role: "user",
            content: `你的上一条回复因上游连接意外提前中断而在末尾截断（中断处末尾字符为：${JSON.stringify(
              tailSnippet
            )}）。请紧接在该位置之后无缝继续输出剩余内容，禁止重复前文或添加任何开场白。`,
          },
        ],
      };
    }

    const nextCount = continuationCount + 1;
    return {
      action: "continue",
      mode: "B",
      log: `[auto-continue] 模式B：思考或大工具参数被截断，发起第 ${nextCount} 次增量恢复`,
      messagesToAppend: [
        {
          role: "assistant",
          content: result.reasoning
            ? `已完成阶段思考分析：${result.reasoning.slice(-1200)}`
            : "已完成阶段思考分析。",
        },
        {
          role: "user",
          content:
            "你刚才的思考或工具调用参数因超出单次输出上限被截断，尚未发出工具调用或正文。你已经完成了思考推导，接下来请：(1) 不要再重复长篇思考（保持极简思考）；(2) 若要写入较长文件（如完整 README 或复杂 SVG），请拆分为多步执行——先调用 write_file 写入前半部分或核心骨架，再调用 edit_file 分段追加剩余章节；或者直接输出最终完整代码与回复。",
        },
      ],
    };
  }

  if (
    hasIncompleteTodos &&
    permissionMode !== planModeValue &&
    cleanRoundText.length < 80 &&
    continuationCount < maxContinuations
  ) {
    const nextCount = continuationCount + 1;
    const activeTodo =
      initialTodos.find((t) => t.status === "in_progress") ||
      initialTodos.find((t) => t.status === "pending");
    const messagesToAppend = [];
    if (cleanRoundText) {
      messagesToAppend.push(buildAssistantReplayMessage(result, { content: cleanRoundText }));
    }
    messagesToAppend.push({
      role: "user",
      content: `当前任务规划中仍有未完成的待办项（当前待完成：${
        activeTodo?.text || "剩余任务"
      }），请不要停留在准备阶段，立即调用相应工具（如 write_file / edit_file / run_command）继续执行，并在全部完成后更新 todo_write 及输出最终总结。`,
    });
    return {
      action: "continue",
      mode: "C",
      log: `[auto-continue] 模式C：检测到未完成 Todo (${activeTodo?.text})，督促继续执行 (第 ${nextCount} 次)`,
      messagesToAppend,
    };
  }

  const cumulativeVisibleText = String(fullGeneratedText || "")
    .replace(/\btask ready\b/gi, "")
    .trim();
  if (
    !result.hitLengthLimit &&
    cumulativeVisibleText.length > 0 &&
    hasUnclosedCodeFence(cumulativeVisibleText) &&
    continuationCount < maxContinuations
  ) {
    const nextCount = continuationCount + 1;
    return {
      action: "continue",
      mode: "D",
      log: `[auto-continue] 模式D：代码块未闭合即结束，发起第 ${nextCount} 次断点续写`,
      messagesToAppend: [
        buildAssistantReplayMessage(result, { content: result.content || cleanRoundText }),
        {
          role: "user",
          content:
            "你的上一条回复在一个未闭合的代码块中途停止了（末尾没有正常收尾）。请紧接最后一行继续输出剩余内容，补全代码块并给出完整结论；禁止重复前文、禁止重新开场。",
        },
      ],
    };
  }

  return { action: "break" };
}

module.exports = { evaluateNoToolResponse };
