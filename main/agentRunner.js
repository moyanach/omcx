const path = require("path");
let ipcMain = null;
try {
  const loaded = require("electron");
  if (loaded && typeof loaded === "object") {
    ipcMain = loaded.ipcMain || null;
  }
} catch {}

const {
  activeStreamSnapshotFlushers,
  activeStreamSessions,
  pendingPermissions,
  pendingQuestions,
  getWorkspaceFolders,
  getModelConfig,
  normalizeUsage,
  buildAttachmentMessagesAsync,
  isImageFile,
  extractTextContent,
  hasUnclosedCodeFence,
  sendStreamEvent,
  notifyDesktopIfBackground,
  getStorageService,
  getReasoningPolicy,
  getContextCompactor,
  getContextCalculator,
  getContextBuilder,
  getToolRegistry,
  getMcpClientService,
  getRepoIndexService,
  getRepoWikiService,
  getCommandService,
  getHookService,
  getGitWorktreeService,
  getMentionResolver,
  getPathResolver,
  getSandboxPolicyService,
  getModelErrorService,
} = require("./shared");

const { generateSessionTitleSidecar } = require("./runner/titleSidecar");
const { registerBtwHandlers } = require("./runner/btwHandler");
const { supersedeSessionPermissions, createPermissionChecker } = require("./runner/permissionGate");
const { supersedeSessionQuestions, createQuestionAsker } = require("./runner/questionGate");
const { createStreamTransport } = require("./runner/streamTransport");
const { evaluateNoToolResponse } = require("./runner/continuationPolicy");
const { executeToolBatch } = require("./runner/toolExecutor");
const { initializeTurnContext } = require("./runner/contextInitializer");

function registerAgentRunner() {
  if (!ipcMain) return;
  ipcMain.on("chat-permission-response", (event, { id, allow, decision }) => {
    const entry = pendingPermissions.get(id);
    if (entry) {
      pendingPermissions.delete(id);
      entry.settle({
        allow: !!allow,
        decision: decision || (allow ? "allow_once" : "deny"),
      });
    }
  });

  ipcMain.on("chat-question-response", (event, { id, submitted, skipped, answers } = {}) => {
    const entry = pendingQuestions.get(id);
    if (entry) {
      pendingQuestions.delete(id);
      entry.settle({
        submitted: Boolean(submitted),
        skipped: Boolean(skipped),
        answers: answers && typeof answers === "object" ? answers : {},
      });
    }
  });

  ipcMain.on("chat-cancel", (event, sessionId) => {
    const active = activeStreamSessions.get(sessionId);
    if (active) {
      active.cancelled = true;
      try {
        active.abortController.abort();
      } catch {}

      let rejectedPermissions = 0;
      for (const [permId, entry] of pendingPermissions) {
        if (entry.sessionId !== sessionId) continue;
        pendingPermissions.delete(permId);
        try {
          entry.settle({ allow: false, decision: "cancelled", reason: "用户已取消本次执行" });
        } catch {}
        rejectedPermissions += 1;
      }

      for (const [qId, entry] of pendingQuestions) {
        if (entry.sessionId !== sessionId) continue;
        pendingQuestions.delete(qId);
        try {
          entry.settle({
            submitted: false,
            skipped: true,
            answers: {},
            reason: "用户已取消本次执行",
          });
        } catch {}
      }

      console.log(
        `[chat-cancel] session ${sessionId} cancellation requested` +
          (rejectedPermissions > 0 ? ` (rejected ${rejectedPermissions} pending permissions)` : "")
      );
    }
  });

  ipcMain.on("chat-steer", (event, { sessionId, id, content } = {}) => {
    const text = String(content || "").trim();
    if (!sessionId || !text) return;
    const active = activeStreamSessions.get(sessionId);
    if (!active || active.cancelled) {
      event.reply("chat-steer-rejected", { sessionId, id, content: text });
      return;
    }
    if (!Array.isArray(active.steerQueue)) active.steerQueue = [];
    active.steerQueue.push({ id: id || `steer_${Date.now()}`, content: text, at: Date.now() });
    console.log(`[chat-steer] session ${sessionId} queued steering injection (pending=${active.steerQueue.length})`);
  });

  registerBtwHandlers(ipcMain);

  ipcMain.on("chat-request", async (event, payload) => {
    await runAgentTurn(payload, { event });
  });
}

async function runAgentTurn(payload = {}, options = {}) {
  const event = options.event || null;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  const customCheckPermission =
    typeof options.checkPermission === "function" ? options.checkPermission : null;
  const skipTitleSidecar = Boolean(options.skipTitleSidecar) || !event?.sender;

  const {
    sessionId,
    runId,
    messages,
    model,
    enableTools,
    workDir,
    assistantMsgId,
    permissionMode,
    reasoningEffort,
    agentMode,
  } = payload || {};

  const storageService = getStorageService();
  const reasoningPolicy = getReasoningPolicy();
  const { calculateContextMetrics, estimateTokens } = getContextCalculator();
  const toolRegistry = getToolRegistry();
  const mcpClientService = getMcpClientService();
  const repoIndexService = getRepoIndexService();
  const repoWikiService = getRepoWikiService();
  const commandService = getCommandService();
  const hookService = getHookService();
  const gitWorktreeService = getGitWorktreeService();
  const { buildMentionContext } = getMentionResolver();
  const { isBuiltinTrustedPath } = getPathResolver();
  const {
    buildSystemContext,
    buildTodoSection,
    buildGitReminder,
    appendReminderToLastUserMessage,
    getGitSnapshotAsync,
  } = getContextBuilder();
  const { PERMISSION_MODES, normalizePermissionMode } = getSandboxPolicyService();
  const {
    estimateMessagesTokens,
    getThresholds,
    shouldMicroCompact,
    microCompact,
    truncateToolResult,
    compactMessages,
    hardTruncate,
    isContextOverflowError,
  } = getContextCompactor();

  let fatalError = null;
  let endPayload = null;
  const replyStream = (type, data) => {
    if (type === "error") {
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.type === "MODEL_REQUEST_ERROR" && parsed.summary) {
            fatalError = parsed.summary;
          } else {
            fatalError = data;
          }
        } catch {
          fatalError = data;
        }
      } else {
        fatalError = data?.message || String(data);
      }
    } else if (type === "end") {
      endPayload = data;
    }
    if (onEvent) {
      try {
        onEvent(type, data);
      } catch {}
    }
    if (!event?.sender) return;
    sendStreamEvent(event.sender, sessionId, type, data, runId);
    try {
      if (type === "data") event.reply(`chat-stream-data-${sessionId}`, data);
      else if (type === "tool_status") event.reply(`chat-stream-tool-status-${sessionId}`, data);
      else if (type === "todos") event.reply(`chat-stream-todos-${sessionId}`, data);
      else if (type === "metrics") event.reply(`chat-stream-context-metrics-${sessionId}`, data);
      else if (type === "compaction") event.reply(`chat-stream-compaction-${sessionId}`, data);
      else if (type === "steered") event.reply(`chat-stream-steered-${sessionId}`, data);
      else if (type === "waiting") event.reply(`chat-stream-waiting-${sessionId}`, data);
      else if (type === "permission") event.reply(`chat-permission-request-${sessionId}`, data);
      else if (type === "outputs") event.reply(`session-outputs-updated-${sessionId}`, data);
      else if (type === "end") event.reply(`chat-stream-end-${sessionId}`, data);
      else if (type === "error") event.reply(`chat-stream-error-${sessionId}`, data);
    } catch {}
  };

  const {
    modelBaseUrl,
    modelApiKey,
    provider,
    apiModelId,
    contextLimit,
    maxOutputTokens,
    supportsVision,
  } = getModelConfig(model, "gpt-4o");

  if (!modelApiKey && provider !== "ollama") {
    const msg = "请先在【设置】中配置该模型的 API Key";
    replyStream("error", msg);
    return {
      ok: false,
      cancelled: false,
      error: msg,
      content: "",
      reasoning: "",
      metadata: null,
    };
  }

  let sessionWorkDir = workDir && typeof workDir === "string" && workDir.trim() ? workDir.trim() : null;
  const session = storageService.getSessions().find((s) => s.id === sessionId);
  if (!sessionWorkDir) {
    sessionWorkDir = session?.work_dir || null;
  }

  const sessionReasoningEffort =
    reasoningEffort ||
    session?.reasoning_effort ||
    session?.reasoningEffort ||
    "medium";

  const resolvedPermissionMode = normalizePermissionMode(
    permissionMode ||
      session?.permission_mode ||
      session?.permissionMode ||
      storageService.getConfig("default_permission_mode") ||
      PERMISSION_MODES.AUTO
  );

  const resolvedAgentMode =
    (agentMode ||
      session?.agent_mode ||
      session?.agentMode ||
      storageService.getConfig("default_agent_mode")) === "work"
      ? "work"
      : "code";

  if (
    session &&
    (session.work_dir !== sessionWorkDir ||
      session.permission_mode !== resolvedPermissionMode ||
      session.agent_mode !== resolvedAgentMode ||
      (reasoningEffort && session.reasoning_effort !== reasoningEffort))
  ) {
    session.work_dir = sessionWorkDir;
    session.permission_mode = resolvedPermissionMode;
    session.agent_mode = resolvedAgentMode;
    if (reasoningEffort) {
      session.reasoning_effort = reasoningEffort;
    }
    storageService.saveSession(session);
  }

  let { matchedWorkspace, allowedFolders: workspaceFolders } = getWorkspaceFolders(sessionWorkDir);
  const wtGroup = gitWorktreeService.getSessionWorktreeGroup(sessionId);
  if (wtGroup.length > 0) {
    const wtAllowed = wtGroup.map((item) => path.resolve(item.worktreePath));
    workspaceFolders = wtAllowed;
    matchedWorkspace = {
      id: matchedWorkspace?.id || `wt-group-${sessionId}`,
      name: matchedWorkspace?.name ? `${matchedWorkspace.name} (隔离工作树)` : "隔离工作树工作空间",
      folders: wtGroup.map((item) => ({
        name: item.name,
        path: item.worktreePath,
        isPrimary: Boolean(item.isPrimary),
      })),
    };
  }
  const writableFolders = [...workspaceFolders];
  const allowedFolders = [...workspaceFolders];

  const previousRun = activeStreamSessions.get(sessionId);
  if (previousRun && !previousRun.cancelled) {
    previousRun.cancelled = true;
    try {
      previousRun.abortController.abort();
    } catch {}
    supersedeSessionPermissions(sessionId, replyStream, event);
    supersedeSessionQuestions(sessionId, replyStream, event);
    console.warn(`[chat-request] session ${sessionId} 检测到并发请求，已中断上一轮 run`);
  }

  const sessionAbort = {
    runId,
    abortController: new AbortController(),
    cancelled: false,
    toolContext: null,
    steerQueue: [],
  };
  activeStreamSessions.set(sessionId, sessionAbort);

  const extractLatestUserIntent = () => {
    if (!Array.isArray(messages)) return "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== "user") continue;
      if (typeof m.content === "string") return m.content.slice(0, 1500);
      if (Array.isArray(m.content)) {
        return m.content
          .map((part) => (typeof part === "string" ? part : part?.text || ""))
          .join("\n")
          .slice(0, 1500);
      }
    }
    return "";
  };

  const checkPermissionFn = createPermissionChecker({
    sessionId,
    event,
    replyStream,
    customCheckPermission,
    isBuiltinTrustedPath,
    resolvedPermissionMode,
    PERMISSION_MODES,
    allowedFolders,
    writableFolders,
    sessionAbort,
    storageService,
    workDir: sessionWorkDir || "",
    currentModelId: model || apiModelId || "",
    getUserIntent: extractLatestUserIntent,
  });

  const askUserFn = createQuestionAsker({
    sessionId,
    event,
    replyStream,
    customAskUser: typeof options.askUser === "function" ? options.askUser : null,
  });

  const initialTodos = [];
  let fullGeneratedText = "";
  let fullGeneratedReasoning = "";
  let toolRound = 0;
  const executedToolSteps = [];

  const partialMessageId =
    assistantMsgId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runStartedAt = Date.now();

  const PARTIAL_PERSIST_INTERVAL_MS = 4000;
  const PARTIAL_PERSIST_MIN_GROWTH = 2500;
  let lastPartialPersistAt = 0;
  let lastPartialPersistLength = 0;

  const formatRunDuration = (ms) => {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s < 10 ? "0" : ""}${s}s` : `${s}s`;
  };

  const SNAPSHOT_MAX_TOOL_STEPS = 60;
  const SNAPSHOT_MAX_STRING_CHARS = 4000;
  const truncateSnapshotValue = (value, depth = 0) => {
    if (typeof value === "string") {
      return value.length > SNAPSHOT_MAX_STRING_CHARS
        ? `${value.slice(0, SNAPSHOT_MAX_STRING_CHARS)}…[快照截断，原始 ${value.length} 字符]`
        : value;
    }
    if (value === null || typeof value !== "object" || depth >= 6) return value;
    if (Array.isArray(value)) {
      return value.slice(0, 200).map((item) => truncateSnapshotValue(item, depth + 1));
    }
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      out[key] = truncateSnapshotValue(item, depth + 1);
    }
    return out;
  };
  const buildSnapshotToolSteps = () =>
    executedToolSteps
      .slice(-SNAPSHOT_MAX_TOOL_STEPS)
      .map((step) => truncateSnapshotValue(step));

  const persistPartial = (force = false, overrides = {}) => {
    const now = Date.now();
    if (!force && now - lastPartialPersistAt < PARTIAL_PERSIST_INTERVAL_MS) return;
    if (
      !force &&
      fullGeneratedText.length - lastPartialPersistLength < PARTIAL_PERSIST_MIN_GROWTH
    ) {
      return;
    }
    lastPartialPersistAt = now;
    lastPartialPersistLength = fullGeneratedText.length;
    try {
      storageService.addMessage(sessionId, {
        id: partialMessageId,
        role: "assistant",
        content: fullGeneratedText,
        reasoning: fullGeneratedReasoning,
        createdAt: runStartedAt,
        metadata: {
          streaming: true,
          startedAt: runStartedAt,
          durationMs: now - runStartedAt,
          durationFormatted: formatRunDuration(now - runStartedAt),
          toolRounds: toolRound,
          toolSteps: buildSnapshotToolSteps(),
          todos: initialTodos,
          ...overrides,
        },
      });
    } catch (err) {
      console.warn(`[chat-stream] 运行快照落盘失败 (${partialMessageId}):`, err.message);
    }
  };
  persistPartial(true);

  const persistInterrupted = () => {
    const now = Date.now();
    try {
      storageService.persistMessageSync(sessionId, {
        id: partialMessageId,
        role: "assistant",
        content: fullGeneratedText,
        reasoning: fullGeneratedReasoning,
        createdAt: runStartedAt,
        metadata: {
          streaming: false,
          interrupted: true,
          interruptedAt: now,
          startedAt: runStartedAt,
          durationMs: now - runStartedAt,
          durationFormatted: formatRunDuration(now - runStartedAt),
          toolRounds: toolRound,
          toolSteps: buildSnapshotToolSteps(),
          todos: initialTodos,
        },
      });
    } catch (err) {
      console.warn(`[chat-stream] 退出前快照落盘失败 (${partialMessageId}):`, err.message);
    }
  };
  activeStreamSnapshotFlushers.set(sessionId, { runId, flush: persistInterrupted });

  const sessionToolContext = {
    sessionId,
    workDir: sessionWorkDir,
    allowedFolders,
    writableFolders,
    permissionMode: resolvedPermissionMode,
    agentMode: resolvedAgentMode,
    checkPermission: checkPermissionFn,
    askUser: askUserFn,
    allowedToolNames: null,
    onTodosUpdate: null,
    abortSignal: sessionAbort.abortController.signal,
    sessionAbort,
    modelConfig: {
      baseUrl: modelBaseUrl,
      apiKey: modelApiKey,
      provider,
      modelName: apiModelId,
      contextLimit,
      maxOutputTokens,
    },
    mcpTools: [],
    onFileOutput: (filePath) => {
      if (!filePath) return;
      const fullOutPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(sessionWorkDir || "", filePath);
      const outItem = {
        name: path.basename(filePath),
        filePath: fullOutPath,
        fileType: path.extname(filePath).replace(".", "").toLowerCase() || "file",
      };
      storageService.addSessionOutput(sessionId, outItem);
      replyStream("outputs", outItem);
    },
  };
  sessionAbort.toolContext = sessionToolContext;

  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (modelApiKey) {
      headers["Authorization"] = `Bearer ${modelApiKey}`;
    }

    const turnInit = await initializeTurnContext({
      messages,
      sessionId,
      sessionWorkDir,
      provider,
      apiModelId,
      modelBaseUrl,
      contextLimit,
      enableTools,
      supportsVision,
      agentMode: resolvedAgentMode,
      matchedWorkspace,
      allowedFolders,
      initialTodos,
      sessionToolContext,
      replyStream,
      storageService,
      reasoningPolicy,
      commandService,
      hookService,
      mcpClientService,
      repoIndexService,
      repoWikiService,
      toolRegistry,
      buildMentionContext,
      buildAttachmentMessagesAsync,
      isImageFile,
      extractTextContent,
      buildSystemContext,
      buildGitReminder,
      appendReminderToLastUserMessage,
      getGitSnapshotAsync,
      estimateTokens,
    });
    if (turnInit.aborted) return;

    let apiMessages = turnInit.apiMessages;
    const {
      reasoningReplay,
      buildAssistantReplayMessage,
      slashCommandInfo,
      compactCfg,
      mcpTools,
      hooksEnabled,
      hookOptions,
      getActiveToolDefs,
      toolDefsTokenEstimate,
      getSystemInstruction,
      getCurrentSkillsTokens,
      refreshSystemInstruction,
    } = turnInit;

    let compactionSummary = "";
    const compactionStats = { count: 0, beforeTokens: 0, afterTokens: 0 };
    let lastProviderUsage = null;

    const recordProviderUsageForCompact = (usage) => {
      if (!usage) return;
      const normalized = usage.raw ? usage : normalizeUsage(usage, provider);
      if (!normalized) return;
      lastProviderUsage = normalized;
    };
    let consecutiveCompactFailures = 0;
    let turnCompactionCount = 0;

    const maybeCompact = async (reason = "preflight", options = {}) => {
      if (!compactCfg.enabled) return false;

      const thresholds = getThresholds(contextLimit, compactCfg);
      const nonSystemMessages = apiMessages.filter((message) => message.role !== "system");
      let tokens =
        estimateMessagesTokens(nonSystemMessages) +
        estimateTokens(getSystemInstruction()) +
        toolDefsTokenEstimate;
      if (lastProviderUsage?.prompt_tokens) {
        tokens = Math.max(tokens, Number(lastProviderUsage.prompt_tokens) || 0);
      }

      const force = reason === "overflow" || options.force === true;
      if (!force && !shouldMicroCompact(tokens, thresholds)) return false;

      const urgentMicro = force || tokens >= thresholds.threshold * 0.96;
      const micro = microCompact(apiMessages, {
        ...compactCfg,
        batchWatermark: true,
        urgent: urgentMicro,
      });
      if (micro.cleared > 0) {
        apiMessages = micro.messages;
        lastProviderUsage = null;
        console.log(`[microcompact] saved=${micro.saved} cleared=${micro.cleared}`);
        tokens =
          estimateMessagesTokens(apiMessages.filter((message) => message.role !== "system")) +
          estimateTokens(getSystemInstruction()) +
          toolDefsTokenEstimate;
      }

      if (!force && tokens <= thresholds.threshold) return micro.cleared > 0;
      if (!force && turnCompactionCount >= 1) return false;

      try {
        const systemMessage = apiMessages.find((message) => message.role === "system");
        const result = await compactMessages({
          messages: apiMessages,
          systemMessage,
          thresholds,
          modelCfg: {
            baseUrl: modelBaseUrl,
            apiKey: modelApiKey,
            modelId: apiModelId,
            headers: { ...headers, Accept: "application/json" },
          },
          cfg: compactCfg,
        });

        if (!result.summaryBlock) {
          if (force || tokens > thresholds.threshold) {
            apiMessages = hardTruncate(apiMessages, thresholds.threshold);
            lastProviderUsage = null;
            console.log("[compact] no summarizable history, fallback hardTruncate");
            return true;
          }
          return false;
        }

        apiMessages = result.messages;
        const todosSection = buildTodoSection(initialTodos);
        compactionSummary = todosSection
          ? `${result.summaryBlock}\n\n${todosSection}`
          : result.summaryBlock;
        refreshSystemInstruction(apiMessages, { includeTodos: false, compactionSummary });
        lastProviderUsage = null;
        compactionStats.count += 1;
        compactionStats.beforeTokens += result.before;
        compactionStats.afterTokens += result.after;
        consecutiveCompactFailures = 0;
        turnCompactionCount += 1;

        replyStream("compaction", {
          beforeTokens: result.before,
          afterTokens: result.after,
          keptMessages: result.kept,
          summarizedMessages: result.summarized,
          at: Date.now(),
        });
        console.log(
          `[compact] before=${result.before} after=${result.after} kept=${result.kept} summarized=${result.summarized}`
        );
        return true;
      } catch (err) {
        consecutiveCompactFailures += 1;
        console.error(`[compact] failed (${consecutiveCompactFailures}):`, err.message);
        if (consecutiveCompactFailures >= compactCfg.maxConsecutiveFailures) {
          apiMessages = hardTruncate(apiMessages, thresholds.threshold);
          lastProviderUsage = null;
          console.log("[compact] fallback hardTruncate");
          return true;
        }
        return false;
      }
    };

    sessionToolContext.onTodosUpdate = (nextTodos) => {
      if (!Array.isArray(nextTodos)) return;
      initialTodos.splice(0, initialTodos.length, ...nextTodos);
      replyStream("todos", initialTodos);
      persistPartial(true);
      // 不再重建 System Prompt：工单变更已作为本轮 tool_call/tool_result 追加在消息尾部，
      // 原位保持 apiMessages[0] 字节稳定以避免打穿后续数十万 token 的 Prompt Cache。
      console.log(`[context] todos updated: ${initialTodos.length}`);
    };

    const computeContextMetrics = () =>
      calculateContextMetrics({
        messages: apiMessages,
        tools: getActiveToolDefs(),
        systemPrompt: getSystemInstruction(),
        skillsTokens: getCurrentSkillsTokens(),
        maxTokensLimit: contextLimit,
      });

    const initMetrics = computeContextMetrics();
    replyStream("metrics", initMetrics);

    const MAX_TOOL_ROUNDS = Number(storageService.getConfig("max_tool_rounds")) || 5000;
    const STREAM_IDLE_TIMEOUT_SEC = Math.max(
      30,
      Number(storageService.getConfig("stream_idle_timeout")) || 180
    );

    function sendData(delta) {
      fullGeneratedText += delta;
      replyStream("data", delta);
      persistPartial();
    }

    function sendReasoning(delta) {
      if (!delta) return;
      fullGeneratedReasoning += delta;
      replyStream("reasoning", delta);
      persistPartial();
    }

    const { doStreamRequest } = createStreamTransport({
      provider,
      modelBaseUrl,
      modelApiKey,
      apiModelId,
      maxOutputTokens,
      sessionReasoningEffort,
      headers,
      sessionAbort,
      streamIdleTimeoutSec: STREAM_IDLE_TIMEOUT_SEC,
      replyStream,
      sendData,
      sendReasoning,
      onProviderUsage: (normalized) => {
        lastProviderUsage = normalized;
      },
    });

    let continuationCount = 0;
    let emptyRoundRetry = 0;
    let lastTurnResult = null;
    const MAX_CONTINUATIONS = 4;

    while (toolRound < MAX_TOOL_ROUNDS) {
      let requestBody = {};
      if (enableTools) {
        requestBody.tools = getActiveToolDefs();
        requestBody.tool_choice = "auto";
      }

      if (sessionAbort.cancelled) break;

      if (Array.isArray(sessionAbort.steerQueue) && sessionAbort.steerQueue.length > 0) {
        const steers = sessionAbort.steerQueue.splice(0);
        for (const steer of steers) {
          apiMessages.push({
            role: "user",
            content: `【用户中途更新/追加的需求上下文】\n${steer.content}\n\n[系统引导]：用户在当前任务执行中途补充或更新了上述内容。请自主综合分析用户意图（是补充业务背景、澄清细节、细化边界条件，还是调整/纠偏当前执行路线）：\n- 若属于补充背景、澄清细节或细化约束：请将该上下文无缝融合进当前任务，并在后续步骤与最终答复中予以落实；\n- 若属于方向调整或纠偏：请以最新指示为准调整后续行动，无需推倒已完成且不冲突的工作。`,
          });
        }
        replyStream("steered", steers);
        console.log(`[chat-steer] injected ${steers.length} steering message(s) into context`);
      }

      const result = await (async () => {
        await maybeCompact("preflight");
        try {
          return await doStreamRequest(apiMessages, requestBody);
        } catch (err) {
          if (!isContextOverflowError(err.message)) throw err;
          const compacted = await maybeCompact("overflow", { force: true });
          if (!compacted) throw err;
          return await doStreamRequest(apiMessages, requestBody);
        }
      })();

      recordProviderUsageForCompact(result.usage);
      lastTurnResult = result;

      if (sessionAbort.cancelled) break;

      if (!enableTools || result.toolCalls.length === 0) {
        const decision = evaluateNoToolResponse({
          result,
          steerQueue: sessionAbort.steerQueue,
          initialTodos,
          permissionMode: sessionToolContext.permissionMode,
          planModeValue: PERMISSION_MODES.PLAN,
          fullGeneratedText,
          toolRound,
          emptyRoundRetry,
          continuationCount,
          maxContinuations: MAX_CONTINUATIONS,
          buildAssistantReplayMessage,
        });

        if (decision.action === "steer") {
          apiMessages.push(...decision.messagesToAppend);
          replyStream("steered", decision.steers);
          console.log(
            `[chat-steer] assistant was finishing; injected ${decision.steers.length} steering message(s) and continued the loop`
          );
          sendData("\n\n");
          continue;
        }
        if (decision.action === "retry_empty") {
          emptyRoundRetry++;
          console.warn(decision.log);
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        if (decision.action === "continue") {
          continuationCount++;
          console.log(decision.log);
          apiMessages.push(...decision.messagesToAppend);
          continue;
        }
        break;
      }

      continuationCount = 0;
      toolRound++;

      await executeToolBatch({
        result,
        sessionId,
        sessionWorkDir,
        sessionAbort,
        sessionToolContext,
        mcpTools,
        hooksEnabled,
        hookOptions,
        hookService,
        toolRegistry,
        storageService,
        executedToolSteps,
        persistPartial,
        replyStream,
        apiMessages,
        buildAssistantReplayMessage,
        truncateToolResult,
        contextLimit,
        configuredToolResultMaxChars: compactCfg.configuredToolResultMaxChars,
        toolResultMaxChars: compactCfg.toolResultMaxChars,
        supportsVision,
      });

      const updatedMetrics = computeContextMetrics();
      replyStream("metrics", updatedMetrics);
    }

    const visibleGeneratedText = fullGeneratedText
      .replace(/\btask ready\b/gi, "")
      .trim();

    if (!sessionAbort.cancelled && !visibleGeneratedText && toolRound > 0) {
      apiMessages.push({
        role: "user",
        content:
          "请基于以上工具执行获取到的全部信息、代码与事实，直接给出条理清晰、完整详尽的最终总结分析与答复（不要再调用工具，精简思考过程直接输出正文）。",
      });

      // 保持与主循环一致的 tools 定义以命中前缀缓存，并为兜底总结轮补齐续写保护
      const summaryRequestBody = enableTools
        ? { tools: getActiveToolDefs(), tool_choice: "auto" }
        : {};
      let summaryContinuations = 0;
      let summaryEmptyRetry = 0;

      for (let summaryStep = 0; summaryStep <= MAX_CONTINUATIONS; summaryStep++) {
        if (sessionAbort.cancelled) break;
        await maybeCompact("preflight");
        let finalResult;
        try {
          finalResult = await doStreamRequest(apiMessages, summaryRequestBody);
        } catch (err) {
          if (!isContextOverflowError(err.message)) throw err;
          const compacted = await maybeCompact("overflow", { force: true });
          if (!compacted) throw err;
          finalResult = await doStreamRequest(apiMessages, summaryRequestBody);
        }
        if (!finalResult) break;
        recordProviderUsageForCompact(finalResult.usage);
        lastTurnResult = finalResult;
        if (sessionAbort.cancelled) break;

        if (Array.isArray(finalResult.toolCalls) && finalResult.toolCalls.length > 0) {
          if (summaryContinuations >= MAX_CONTINUATIONS) break;
          summaryContinuations++;
          apiMessages.push(buildAssistantReplayMessage(finalResult));
          for (const tc of finalResult.toolCalls) {
            apiMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "当前已进入最终总结阶段，禁止再调用任何工具，请直接输出最终文本总结。",
            });
          }
          continue;
        }

        const decision = evaluateNoToolResponse({
          result: finalResult,
          steerQueue: [],
          initialTodos: [],
          permissionMode: sessionToolContext.permissionMode,
          planModeValue: PERMISSION_MODES.PLAN,
          fullGeneratedText,
          toolRound,
          emptyRoundRetry: summaryEmptyRetry,
          continuationCount: summaryContinuations,
          maxContinuations: MAX_CONTINUATIONS,
          buildAssistantReplayMessage,
        });

        if (decision.action === "retry_empty") {
          summaryEmptyRetry++;
          console.warn(decision.log);
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        if (decision.action === "continue") {
          summaryContinuations++;
          console.log(`[summary] ${decision.log}`);
          apiMessages.push(...decision.messagesToAppend);
          continue;
        }
        break;
      }
    }

    if (!sessionAbort.cancelled && initialTodos.some((t) => t.status === "in_progress")) {
      for (const todo of initialTodos) {
        if (todo.status === "in_progress") {
          todo.status = "completed";
        }
      }
      replyStream("todos", initialTodos);
    }

    if (hooksEnabled) {
      try {
        await hookService.runHooks(
          "Stop",
          {
            session_id: sessionId,
            cwd: sessionWorkDir,
            tool_rounds: toolRound,
            cancelled: !!sessionAbort.cancelled,
            response: fullGeneratedText,
          },
          hookOptions
        );
      } catch (hookErr) {
        console.warn("[hook] Stop 执行异常:", hookErr.message);
      }
    }

    const finalMetrics = computeContextMetrics();
    replyStream("metrics", finalMetrics);

    const finalVisibleForCheck = fullGeneratedText;
    const outputTruncated = Boolean(
      (!sessionAbort.cancelled &&
        (lastTurnResult?.abruptlyClosed || lastTurnResult?.hitLengthLimit)) ||
        hasUnclosedCodeFence(finalVisibleForCheck)
    );
    replyStream("end", {
      content: fullGeneratedText,
      reasoning: fullGeneratedReasoning,
      metadata: {
        cancelled: !!sessionAbort.cancelled,
        truncated: outputTruncated,
        toolRounds: toolRound,
        toolSteps: executedToolSteps,
        todos: initialTodos,
        pendingSteers: Array.isArray(sessionAbort.steerQueue) ? sessionAbort.steerQueue.slice() : [],
        compaction: {
          count: compactionStats.count,
          beforeTokens: compactionStats.beforeTokens,
          afterTokens: compactionStats.afterTokens,
        },
        model: apiModelId,
        provider,
      },
    });

    try {
      const currentSession = storageService.getSessions().find((s) => s.id === sessionId);
      const elapsedMs = Date.now() - runStartedAt;
      if (!sessionAbort.cancelled && (toolRound > 0 || elapsedMs >= 15000)) {
        notifyDesktopIfBackground({
          title: outputTruncated ? "OMCX 任务输出可能被截断" : "OMCX 任务已完成",
          body: `${currentSession?.title || "Agent 会话"} · 用时 ${formatRunDuration(elapsedMs)}${toolRound > 0 ? ` · ${toolRound} 轮工具` : ""}`,
        });
      }
      const shouldGenTitle =
        currentSession &&
        currentSession.title_source !== "custom" &&
        (!currentSession.title ||
          currentSession.title.includes("新的") ||
          currentSession.title_source === "default");

      if (shouldGenTitle && !skipTitleSidecar) {
        const firstUserMsg = apiMessages.find((m) => m.role === "user");
        const firstUserText = extractTextContent(firstUserMsg?.content);
        if (firstUserText) {
          generateSessionTitleSidecar(sessionId, firstUserText, model, event?.sender).catch(() => {});
        }
      }
    } catch {}
  } catch (err) {
    if ((err.name === "AbortError" && err.code !== "MODEL_CONNECT_TIMEOUT") || sessionAbort.cancelled) {
      console.log(`[chat-stream] session ${sessionId} cancelled by user`);
      try {
        replyStream("end", {
          content: fullGeneratedText,
          metadata: {
            cancelled: true,
            toolRounds: toolRound,
            toolSteps: executedToolSteps,
            todos: initialTodos,
            pendingSteers: Array.isArray(sessionAbort.steerQueue) ? sessionAbort.steerQueue.slice() : [],
          },
        });
      } catch {}
    } else {
      const {
        attachModelErrorContext,
        serializeModelErrorPayload,
        formatModelErrorText,
      } = getModelErrorService();
      const errCtx = {
        provider,
        model: apiModelId,
        baseUrl: modelBaseUrl,
        toolRound,
      };
      attachModelErrorContext(err, errCtx);
      const serializedError = serializeModelErrorPayload(err, errCtx);
      const readableError = formatModelErrorText(err, errCtx);
      console.error(`[chat-stream error ${sessionId}]`, readableError, err);
      notifyDesktopIfBackground({
        title: "OMCX 任务执行中断",
        body: readableError,
      });
      replyStream("error", serializedError);
    }
  } finally {
    try {
      if (event?.sender?.isDestroyed && event.sender.isDestroyed()) {
        const now = Date.now();
        storageService.persistMessageSync(sessionId, {
          id: partialMessageId,
          role: "assistant",
          content: fullGeneratedText,
          createdAt: runStartedAt,
          metadata: {
            streaming: false,
            completed: !sessionAbort.cancelled,
            cancelled: !!sessionAbort.cancelled,
            durationMs: now - runStartedAt,
            durationFormatted: formatRunDuration(now - runStartedAt),
            toolRounds: toolRound,
            toolSteps: buildSnapshotToolSteps(),
            todos: initialTodos,
          },
        });
      }
    } catch {}
    if (activeStreamSnapshotFlushers.get(sessionId)?.runId === runId) {
      activeStreamSnapshotFlushers.delete(sessionId);
    }
    if (activeStreamSessions.get(sessionId) === sessionAbort) {
      activeStreamSessions.delete(sessionId);
    }
  }

  return {
    ok: !fatalError && !sessionAbort.cancelled,
    cancelled: Boolean(sessionAbort.cancelled),
    error: fatalError || null,
    content: fullGeneratedText,
    reasoning: fullGeneratedReasoning,
    metadata: endPayload?.metadata || {
      toolRounds: toolRound,
      toolSteps: executedToolSteps,
      todos: initialTodos,
      model: apiModelId,
      provider,
    },
  };
}

module.exports = { registerAgentRunner, runAgentTurn };
