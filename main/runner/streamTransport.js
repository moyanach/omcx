const {
  normalizeUsage,
  buildReasoningPayload,
  getAnthropicClient,
} = require("../shared");

function isTransientSocketError(err) {
  if (!err) return false;
  const msg = String(err.message || "").toLowerCase();
  const causeCode = String(err.cause?.code || "").toUpperCase();
  const causeMsg = String(err.cause?.message || "").toLowerCase();
  return (
    msg.includes("terminated") ||
    msg.includes("fetch failed") ||
    msg.includes("socket") ||
    msg.includes("econnreset") ||
    causeCode === "UND_ERR_SOCKET" ||
    causeCode === "ECONNRESET" ||
    causeCode === "EPIPE" ||
    causeMsg.includes("other side closed")
  );
}

function hasValidToolCalls(list) {
  const valid = (list || []).filter(Boolean);
  if (valid.length === 0) return false;
  return valid.every((tc) => {
    if (!tc.function?.name) return false;
    try {
      JSON.parse(tc.function.arguments || "{}");
      return true;
    } catch {
      return false;
    }
  });
}

function detectAbruptClose({
  cancelled = false,
  streamFinished = false,
  finishReason = null,
  hitLengthLimit = false,
  socketClosedAbruptly = false,
} = {}) {
  if (cancelled) return false;
  if (socketClosedAbruptly) return true;
  if (!streamFinished && !finishReason && !hitLengthLimit) return true;
  return false;
}

function createStreamTransport({
  provider,
  modelBaseUrl,
  modelApiKey,
  apiModelId,
  maxOutputTokens,
  sessionReasoningEffort,
  headers,
  sessionAbort,
  streamIdleTimeoutSec,
  replyStream,
  sendData,
  sendReasoning,
  onProviderUsage,
}) {
  const { isAnthropicProvider, streamAnthropicMessage } = getAnthropicClient();
  const streamIdleTimeoutMs = streamIdleTimeoutSec * 1000;

  async function doStreamRequestOnce(requestMessages, requestBody) {
    if (isAnthropicProvider(provider, modelBaseUrl)) {
      const anthropicResult = await streamAnthropicMessage({
        baseUrl: modelBaseUrl,
        apiKey: modelApiKey,
        model: apiModelId,
        messages: requestMessages,
        tools: requestBody.tools || [],
        maxTokens: maxOutputTokens,
        temperature: 0.2,
        reasoningEffort: sessionReasoningEffort,
        signal: sessionAbort.abortController.signal,
        onText: (delta) => sendData(delta),
        onReasoning: (delta) => sendReasoning(delta),
      });
      if (anthropicResult.usage && onProviderUsage) {
        onProviderUsage(anthropicResult.usage);
      }
      const signatureCount = Array.isArray(anthropicResult.reasoningSignatures)
        ? anthropicResult.reasoningSignatures.filter(Boolean).length
        : 0;
      if (signatureCount > 0) {
        console.log(`[anthropic] 采集到 ${signatureCount} 个 thinking signature，可在工具轮回传`);
      }
      return anthropicResult;
    }

    const reasoningSpec = buildReasoningPayload(apiModelId, provider, sessionReasoningEffort);
    let requestBodyFinal = {
      model: apiModelId,
      messages: requestMessages,
      stream: true,
      temperature: 0.2,
      ...reasoningSpec.payload,
      ...requestBody,
    };
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
      const thinkingActive = Object.keys(reasoningSpec.payload).length > 0;
      requestBodyFinal.max_tokens = thinkingActive
        ? Math.min(64000, maxOutputTokens * 2)
        : maxOutputTokens;
    }

    let resp = await fetch(`${modelBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: sessionAbort.abortController.signal,
      body: JSON.stringify(requestBodyFinal),
    });

    if (!resp.ok && resp.status === 400 && Object.keys(reasoningSpec.payload).length > 0) {
      try {
        const errClone = resp.clone();
        const errText = await errClone.text();
        const lowerErr = errText.toLowerCase();
        if (
          lowerErr.includes("reasoning") ||
          lowerErr.includes("thinking") ||
          lowerErr.includes("unrecognized") ||
          lowerErr.includes("unknown parameter") ||
          lowerErr.includes("extra fields not permitted") ||
          lowerErr.includes("not supported")
        ) {
          console.warn(`[chat-stream] 远端端点不支持思考参数 (${errText.slice(0, 150)})，已自动剥离重试...`);
          delete requestBodyFinal.reasoning_effort;
          delete requestBodyFinal.thinking;
          delete requestBodyFinal.thinking_budget;
          delete requestBodyFinal.reasoning;
          delete requestBodyFinal.max_completion_tokens;
          requestBodyFinal.temperature = 0.2;

          resp = await fetch(`${modelBaseUrl}/chat/completions`, {
            method: "POST",
            headers,
            signal: sessionAbort.abortController.signal,
            body: JSON.stringify(requestBodyFinal),
          });
        }
      } catch (fallbackErr) {
        console.warn("[chat-stream] 自动退避重试执行失败:", fallbackErr.message);
      }
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API 请求失败 (${resp.status}): ${errText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let fullReasoning = "";
    let toolCalls = [];
    let usage = null;
    let streamFinished = false;
    let finishReason = null;
    let hitLengthLimit = false;
    let socketClosedAbruptly = false;
    let receivedBytes = 0;
    let lastDataAt = Date.now();
    let waitingNotifiedSec = 0;

    const waitingTimer = setInterval(() => {
      const idleSec = Math.floor((Date.now() - lastDataAt) / 1000);
      if (idleSec >= 15 && idleSec - waitingNotifiedSec >= 15) {
        waitingNotifiedSec = idleSec;
        try {
          replyStream("waiting", {
            idleSec,
            timeoutSec: streamIdleTimeoutSec,
          });
        } catch {}
      }
    }, 5000);

    const readWithIdleGuard = () =>
      new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const err = new Error(
            `上游连接已连续 ${streamIdleTimeoutSec} 秒未返回任何数据（可能网关超时、代理中断或模型服务卡死）`
          );
          err.name = "StreamIdleTimeoutError";
          err.code = "STREAM_IDLE_TIMEOUT";
          reject(err);
        }, streamIdleTimeoutMs);
        reader.read().then(
          (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
          }
        );
      });

    try {
      while (!streamFinished) {
        if (sessionAbort.cancelled) {
          try {
            await reader.cancel();
          } catch {}
          break;
        }
        const { done, value } = await readWithIdleGuard();
        if (done) break;
        if (value && value.byteLength) {
          receivedBytes += value.byteLength;
          lastDataAt = Date.now();
          waitingNotifiedSec = 0;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            streamFinished = true;
            break;
          }
          try {
            const json = JSON.parse(payload);
            if (json.usage) {
              usage = json.usage;
              if (onProviderUsage) {
                onProviderUsage(normalizeUsage(json.usage, provider));
              }
            }
            const choice = json.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) {
              if (choice.finish_reason === "length" || choice.finish_reason === "max_tokens") {
                hitLengthLimit = true;
              }
              if (!hitLengthLimit) {
                finishReason = choice.finish_reason;
              } else {
                finishReason = "length";
              }
            }
            const delta = choice.delta || {};

            const reasoningDelta = delta.reasoning_content || delta.reasoning;
            if (reasoningDelta) {
              fullReasoning += reasoningDelta;
              sendReasoning(reasoningDelta);
            }

            if (delta.content) {
              if (
                delta.content.trim().toLowerCase() === "task ready" &&
                (hitLengthLimit || fullContent.trim().length === 0)
              ) {
                hitLengthLimit = true;
                continue;
              }
              fullContent += delta.content;
              sendData(delta.content);
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = {
                    index: idx,
                    id: tc.id || "",
                    type: tc.type || "function",
                    function: { name: "", arguments: "" },
                  };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.type) toolCalls[idx].type = tc.type;
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
      }
    } catch (readErr) {
      if (
        !sessionAbort.cancelled &&
        isTransientSocketError(readErr) &&
        (streamFinished ||
          finishReason ||
          hasValidToolCalls(toolCalls) ||
          fullContent.trim().length > 0)
      ) {
        if (!streamFinished && !finishReason) {
          socketClosedAbruptly = true;
        }
        console.warn(
          `[chat-stream] 忽略流尾部的对端 Socket 提前关闭 (${readErr.cause?.code || readErr.message})，保留已接收的完整响应`
        );
      } else {
        console.warn(
          `[chat-stream] 流式读取中断: ${readErr?.name || "Error"} - ${readErr?.message || ""} ` +
            `(receivedBytes=${receivedBytes}, finishReason=${finishReason || "none"})`
        );
        throw readErr;
      }
    } finally {
      clearInterval(waitingTimer);
      try {
        await reader.cancel();
      } catch {}
    }

    const abruptlyClosed = detectAbruptClose({
      cancelled: sessionAbort.cancelled,
      streamFinished,
      finishReason,
      hitLengthLimit,
      socketClosedAbruptly,
    });

    return {
      content: fullContent,
      reasoning: fullReasoning,
      reasoningMeta: { provider: "openai-compatible", signatures: [] },
      toolCalls: toolCalls.filter(Boolean),
      usage,
      hitLengthLimit,
      abruptlyClosed,
      finishReason,
      receivedBytes,
    };
  }

  async function doStreamRequest(requestMessages, requestBody) {
    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (sessionAbort.cancelled) break;
      try {
        return await doStreamRequestOnce(requestMessages, requestBody);
      } catch (err) {
        lastErr = err;
        if (sessionAbort.cancelled || !isTransientSocketError(err) || attempt === maxAttempts) {
          throw err;
        }
        const delayMs = attempt * 400;
        console.warn(
          `[chat-stream] 遇到瞬时 Socket 断开 (${err.cause?.code || err.message})，${delayMs}ms 后进行第 ${attempt + 1}/${maxAttempts} 次重试...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  return { doStreamRequest };
}

module.exports = {
  isTransientSocketError,
  hasValidToolCalls,
  detectAbruptClose,
  createStreamTransport,
};
