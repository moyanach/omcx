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
  getWorkspaceFolders,
  getModelConfig,
  normalizeUsage,
  mergeUsage,
  computeUsageCost,
  buildAttachmentMessagesAsync,
  isImageFile,
  extractTextContent,
  hasUnclosedCodeFence,
  sendStreamEvent,
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
} = require("./shared");

const { generateSessionTitleSidecar } = require("./runner/titleSidecar");
const { registerBtwHandlers } = require("./runner/btwHandler");
const { supersedeSessionPermissions, createPermissionChecker } = require("./runner/permissionGate");
const { createStreamTransport } = require("./runner/streamTransport");
const { evaluateNoToolResponse } = require("./runner/continuationPolicy");
const { executeToolBatch } = require("./runner/toolExecutor");

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
      fatalError = typeof data === "string" ? data : data?.message || String(data);
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
    inputPrice,
    outputPrice,
    cacheReadPrice,
    cacheWritePrice,
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
      PERMISSION_MODES.AUTO_SANDBOX
  );

  if (
    session &&
    (session.work_dir !== sessionWorkDir ||
      session.permission_mode !== resolvedPermissionMode ||
      (reasoningEffort && session.reasoning_effort !== reasoningEffort))
  ) {
    session.work_dir = sessionWorkDir;
    session.permission_mode = resolvedPermissionMode;
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
  });

  const initialTodos = [];
  let fullGeneratedText = "";
  let fullGeneratedReasoning = "";
  let toolRound = 0;
  const executedToolSteps = [];

  const partialMessageId =
    assistantMsgId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runStartedAt = Date.now();

  let turnUsage = null;
  let turnCostUsd = 0;
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
    checkPermission: checkPermissionFn,
    allowedToolNames: null,
    onTodosUpdate: null,
    abortSignal: sessionAbort.abortController.signal,
    sessionAbort,
    modelConfig: {
      baseUrl: modelBaseUrl,
      apiKey: modelApiKey,
      provider,
      modelName: apiModelId,
      maxOutputTokens,
      inputPrice,
      outputPrice,
      cacheReadPrice,
      cacheWritePrice,
    },
    onSubagentUsage: (usage, costUsd) => {
      if (usage) {
        turnUsage = mergeUsage(turnUsage, usage);
      }
      if (Number.isFinite(Number(costUsd)) && Number(costUsd) > 0) {
        turnCostUsd += Number(costUsd);
      }
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

    const historyMessageIds = new WeakMap();
    let apiMessages = (Array.isArray(messages) ? messages : []).map((m) => {
      if (!m || typeof m !== "object") return m;
      const cloned = { ...m };
      if (m.id) historyMessageIds.set(cloned, m.id);
      delete cloned.id;
      if (
        cloned.role === "assistant" &&
        typeof cloned.content === "string" &&
        cloned.content.includes("<think")
      ) {
        cloned.content = storageService.extractLegacyThinking(cloned.content).content;
      }
      return cloned;
    });

    const reasoningReplay = reasoningPolicy.resolveReplayPolicy({
      provider,
      baseUrl: modelBaseUrl,
      modelId: apiModelId,
      hasTools: Boolean(enableTools),
      scope: storageService.getConfig("reasoning_replay_scope"),
      window: storageService.getConfig("reasoning_replay_window"),
    });
    console.log(
      `[reasoning-replay] mode=${reasoningReplay.mode} scope=${reasoningReplay.scope} window=${reasoningReplay.window} includeHistory=${reasoningReplay.includeHistory}`
    );

    if (reasoningReplay.includeHistory && reasoningReplay.mode === "openai-field") {
      const MAX_HISTORY_REPLAY_ITEMS = 12;
      let userTurnsSeen = 0;
      let replayed = 0;
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        if (replayed >= MAX_HISTORY_REPLAY_ITEMS) break;
        const msg = apiMessages[i];
        if (!msg) continue;
        if (msg.role === "user") {
          userTurnsSeen += 1;
          if (userTurnsSeen > reasoningReplay.window) break;
          continue;
        }
        if (msg.role !== "assistant" || msg.reasoning_content) continue;
        const persistedId = historyMessageIds.get(msg);
        if (!persistedId) continue;
        try {
          const text = storageService.getMessageReasoning(persistedId);
          const replay = reasoningPolicy.buildReplayPayload(reasoningReplay, {
            reasoning: text,
          });
          if (replay) {
            msg[replay.field] = replay.value;
            replayed += 1;
          }
        } catch (err) {
          console.warn(`[reasoning-replay] 历史思考回填失败 (${persistedId}):`, err.message);
        }
      }
      if (replayed > 0) {
        console.log(
          `[reasoning-replay] 已回填 ${replayed} 条历史推理 (window=${reasoningReplay.window})`
        );
      }
    }

    const buildAssistantReplayMessage = (result, { toolCalls, content } = {}) => {
      const message = {
        role: "assistant",
        content: content !== undefined ? content : result.content || "",
      };
      if (reasoningReplay.mode === "openai-field") {
        const replayPayload = reasoningPolicy.buildReplayPayload(reasoningReplay, result);
        if (replayPayload) message[replayPayload.field] = replayPayload.value;
      } else if (reasoningReplay.mode === "anthropic-block") {
        const rawReasoning = reasoningPolicy.extractReplayReasoning(result);
        const signatures = Array.isArray(result.reasoningMeta?.signatures)
          ? result.reasoningMeta.signatures
          : [];
        if (rawReasoning && signatures.some(Boolean)) {
          message.reasoning = rawReasoning;
          message.reasoningSignatures = signatures;
        } else if (rawReasoning) {
          console.warn("[reasoning-replay] Anthropic thinking 缺少 signature，本轮跳过推理回传");
        }
      }
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
      return message;
    };

    let slashCommandInfo = null;
    try {
      const lastUserIndex = (() => {
        for (let i = apiMessages.length - 1; i >= 0; i--) {
          if (apiMessages[i]?.role === "user") return i;
        }
        return -1;
      })();
      if (lastUserIndex >= 0) {
        const rawText = extractTextContent(apiMessages[lastUserIndex].content);
        if (/^\/btw(?:\s|$)/i.test(rawText.trim())) {
          replyStream(
            "error",
            "旁路提问请直接在主输入框发送 /btw <问题>：它不会打断主任务，也不会写入主会话。"
          );
          return;
        }
        const expanded = await commandService.expandCommand(rawText, sessionWorkDir);
        if (expanded) {
          slashCommandInfo = {
            command: expanded.command,
            scope: expanded.scope,
            builtin: expanded.builtin,
            original: rawText,
          };
          apiMessages[lastUserIndex] = {
            ...apiMessages[lastUserIndex],
            content: expanded.prompt,
          };
          if (expanded.allowedTools?.length) {
            sessionToolContext.allowedToolNames = new Set([
              ...expanded.allowedTools,
              "todo_write",
              "run_skill_script",
            ]);
          }
          console.log(`[slash-command] 已展开 /${expanded.command} (${expanded.scope})`);
        }
      }
    } catch (slashErr) {
      console.warn("[slash-command] 展开失败，回退原文:", slashErr.message);
    }

    let compactionSummary = "";
    const compactionStats = { count: 0, beforeTokens: 0, afterTokens: 0 };
    let lastProviderUsage = null;
    const modelPricing = {
      inputPrice,
      outputPrice,
      cacheReadPrice,
      cacheWritePrice,
    };

    const recordUsage = (usage) => {
      if (!usage) return;
      const normalized = usage.raw ? usage : normalizeUsage(usage, provider);
      if (!normalized) return;
      lastProviderUsage = normalized;
      turnUsage = mergeUsage(turnUsage, normalized);
      turnCostUsd += computeUsageCost(normalized, modelPricing);
    };

    const withUsageMetrics = (metrics) => ({
      ...metrics,
      usage: turnUsage,
      costUsd: Math.round(turnCostUsd * 100_000_000) / 100_000_000,
    });
    let consecutiveCompactFailures = 0;
    let turnCompactionCount = 0;
    const compactCfg = {
      enabled: storageService.getConfig("context_auto_compact") !== "false",
      thresholdPercent: Number(storageService.getConfig("context_compact_threshold_percent")) || 85,
      keepTokens: Number(storageService.getConfig("context_compact_keep_tokens")) || 20000,
      toolResultMaxChars: Number(storageService.getConfig("context_tool_result_max_chars")) || 8000,
      keepRecentToolResults: Number(storageService.getConfig("context_microcompact_keep_results")) || 5,
      outputReserve: 4096,
      maxConsecutiveFailures: 3,
    };
    const availableSkills = storageService.getSkills(sessionWorkDir);
    const memories = storageService.getMemories(sessionWorkDir);

    for (const skill of availableSkills) {
      if (skill?.filePath) {
        const skillDir = path.resolve(path.dirname(skill.filePath));
        if (!allowedFolders.includes(skillDir)) {
          allowedFolders.push(skillDir);
        }
      }
    }
    for (const mem of memories) {
      if (mem?.path) {
        const memDir = path.resolve(path.dirname(mem.path));
        if (!allowedFolders.includes(memDir)) {
          allowedFolders.push(memDir);
        }
      }
    }

    const hasAnyAttachments = apiMessages.some(
      (m) => Array.isArray(m.attachments) && m.attachments.length > 0
    );

    const hasRealImageAttachments = apiMessages.some(
      (m) => Array.isArray(m.attachments) && m.attachments.some(isImageFile)
    );

    if (hasRealImageAttachments && !supportsVision) {
      replyStream("error", "当前模型不支持图片输入，请切换到支持视觉的模型");
      return;
    }

    if (hasAnyAttachments) {
      const attached = await buildAttachmentMessagesAsync(apiMessages);
      apiMessages = attached.messages;
      console.log(
        `[attachment-pipeline] resolved ${attached.imageCount} images / ${attached.textAttachmentCount} text inlines / ${attached.binaryAttachmentCount} file guides`
      );
    }

    const memoryIndex = storageService.getMemoryIndex(sessionWorkDir);
    const projectRules = storageService.getProjectInstructions(sessionWorkDir);

    const mentionUserMsg = apiMessages.slice().reverse().find((m) => m.role === "user");
    const mentionText = extractTextContent(mentionUserMsg?.content);
    let mentionBlock = "";
    let mentionContext = null;
    if (mentionText) {
      mentionContext = buildMentionContext(mentionText, sessionWorkDir, allowedFolders, {
        skills: availableSkills,
        mcpServers: storageService
          .getMcpServers(sessionWorkDir)
          .filter((s) => s.source !== "project" || s.trusted === true),
      });
      if (mentionContext.block) {
        mentionBlock = mentionContext.block;
        console.log(
          `[mention] resolved ${mentionContext.skills.length} skills / ${mentionContext.mcps.length} mcps / ${mentionContext.files.length} files / ${mentionContext.dirs.length} dirs` +
            (mentionContext.skipped.length > 0 ? ` / skipped ${mentionContext.skipped.length}` : "")
        );
      }
      if (Array.isArray(mentionContext.allowedTools) && mentionContext.allowedTools.length > 0) {
        sessionToolContext.allowedToolNames = new Set([
          ...mentionContext.allowedTools,
          "todo_write",
          "run_skill_script",
        ]);
        console.log(
          `[skill-permission] 本轮工具白名单: ${[...sessionToolContext.allowedToolNames].join(", ")}`
        );
      }
    }

    const hooksEnabled = storageService.getConfig("hooks_enabled") !== "false";
    const hooksTrusted = storageService.isProjectHooksTrusted(sessionWorkDir);
    const hookOptions = {
      workDir: sessionWorkDir,
      sessionId,
      projectTrusted: hooksTrusted,
      enabled: hooksEnabled,
    };
    if (hooksEnabled) {
      try {
        const promptHook = await hookService.runHooks(
          "UserPromptSubmit",
          {
            prompt: mentionText,
            slash_command: slashCommandInfo?.command || null,
            session_id: sessionId,
            cwd: sessionWorkDir,
          },
          hookOptions
        );
        if (promptHook.blocked) {
          replyStream("error", `Hook 阻断了本次请求：${promptHook.reason}`);
          return;
        }
        if (promptHook.additionalContext) {
          mentionBlock = mentionBlock
            ? `${mentionBlock}\n\n【Hooks 注入的额外上下文】\n${promptHook.additionalContext}`
            : `【Hooks 注入的额外上下文】\n${promptHook.additionalContext}`;
        }
      } catch (hookErr) {
        console.warn("[hook] UserPromptSubmit 执行异常:", hookErr.message);
      }
    }

    const [gitInfo, mcpTools] = await Promise.all([
      getGitSnapshotAsync(sessionWorkDir),
      enableTools ? mcpClientService.getActiveMcpTools(sessionWorkDir) : Promise.resolve([]),
    ]);
    sessionToolContext.mcpTools = mcpTools;

    const getActiveToolPromptDocs = () =>
      enableTools && (toolRegistry.size > 0 || mcpTools.length > 0)
        ? toolRegistry.getToolPromptDocs(mcpTools, {
            permissionMode: sessionToolContext.permissionMode,
          })
        : [];

    const globalCustomSystemPrompt = storageService.getConfig("custom_system_prompt") || "";

    let repoMapText = "";
    if (sessionWorkDir && storageService.getConfig("repo_map_enabled") !== "false") {
      try {
        repoMapText = repoIndexService.buildRepoMap(sessionWorkDir, {
          maxChars: Number(storageService.getConfig("repo_map_max_chars")) || 6000,
        });
      } catch (repoErr) {
        console.warn(`[repo-map] 生成失败: ${repoErr.message}`);
      }
    }

    let wikiInfo = null;
    if (sessionWorkDir) {
      try {
        wikiInfo = repoWikiService.getRepoWiki(sessionWorkDir);
      } catch (wikiErr) {
        console.warn(`[repo-wiki] 读取失败: ${wikiErr.message}`);
      }
    }

    const buildInstruction = ({ includeTodos = false } = {}) =>
      buildSystemContext({
        workDir: sessionWorkDir,
        matchedWorkspace,
        skills: availableSkills,
        memories,
        memoryIndex,
        projectRules,
        repoMap: repoMapText,
        repoWiki: wikiInfo?.exists ? String(wikiInfo.content || "").slice(0, 3500) : "",
        repoWikiPath: wikiInfo?.path || "",
        todos: includeTodos ? initialTodos : [],
        toolDocs: getActiveToolPromptDocs(),
        model: `${provider}/${apiModelId}`,
        enableTools,
        permissionMode: sessionToolContext.permissionMode,
        customSystemPrompt: globalCustomSystemPrompt,
        gitInfo,
        includeTodosInSystem: includeTodos,
        includeGitInSystem: false,
      });

    const buildInstructionText = (built) =>
      mentionBlock ? `${built.text}\n\n${mentionBlock}` : built.text;

    const composeSystemInstruction = (built) => {
      const base = buildInstructionText(built);
      return compactionSummary ? `${base}\n\n${compactionSummary}` : base;
    };

    const initialContext = buildInstruction({ includeTodos: false });
    let systemInstruction = composeSystemInstruction(initialContext);
    console.log(
      `[context] ${initialContext.sections.map((section) => `${section.name}=${section.chars}`).join(" ")}`
    );

    let currentSkillsTokens =
      initialContext.sections.find((s) => s.name === "skills")?.tokens || 0;
    if (mentionContext && Array.isArray(mentionContext.skills) && mentionContext.skills.length > 0) {
      currentSkillsTokens += estimateTokens(mentionBlock);
    }

    const systemIndex = apiMessages.findIndex((m) => m.role === "system");
    const baseSystemContent = systemIndex >= 0 ? apiMessages[systemIndex].content || "" : "";
    if (systemIndex >= 0) {
      apiMessages[systemIndex].content = `${baseSystemContent}\n\n${systemInstruction}`;
    } else {
      apiMessages.unshift({ role: "system", content: systemInstruction });
    }

    // 易变的 Git 快照只附着到本轮请求末尾最后一条 user 消息，避免破环跨轮次 System 前缀缓存
    const gitReminder = buildGitReminder(gitInfo);
    if (gitReminder) {
      appendReminderToLastUserMessage(apiMessages, gitReminder);
    }

    const refreshSystemInstruction = ({ includeTodos = false } = {}) => {
      const rebuilt = buildInstruction({ includeTodos });
      systemInstruction = composeSystemInstruction(rebuilt);
      currentSkillsTokens =
        rebuilt.sections.find((s) => s.name === "skills")?.tokens || 0;
      if (mentionContext && Array.isArray(mentionContext.skills) && mentionContext.skills.length > 0) {
        currentSkillsTokens += estimateTokens(mentionBlock);
      }
      const idx = apiMessages.findIndex((m) => m.role === "system");
      if (idx >= 0) {
        apiMessages[idx].content = baseSystemContent
          ? `${baseSystemContent}\n\n${systemInstruction}`
          : systemInstruction;
      }
    };

    const getActiveToolDefs = () =>
      enableTools
        ? toolRegistry.getToolDefinitions(
            mcpTools,
            sessionToolContext.allowedToolNames || null,
            {
              permissionMode: sessionToolContext.permissionMode,
            }
          )
        : [];

    const toolDefsTokenEstimate = (() => {
      try {
        const defs = getActiveToolDefs();
        return defs.length > 0 ? estimateTokens(JSON.stringify(defs)) : 0;
      } catch {
        return 0;
      }
    })();

    const maybeCompact = async (reason = "preflight", options = {}) => {
      if (!compactCfg.enabled) return false;

      const thresholds = getThresholds(contextLimit, compactCfg);
      const nonSystemMessages = apiMessages.filter((message) => message.role !== "system");
      let tokens =
        estimateMessagesTokens(nonSystemMessages) +
        estimateTokens(systemInstruction) +
        toolDefsTokenEstimate;
      if (lastProviderUsage?.prompt_tokens) {
        tokens = Math.max(tokens, Number(lastProviderUsage.prompt_tokens) || 0);
      }

      const force = reason === "overflow" || options.force === true;
      if (!force && !shouldMicroCompact(tokens, thresholds)) return false;

      const micro = microCompact(apiMessages, compactCfg);
      if (micro.cleared > 0) {
        apiMessages = micro.messages;
        lastProviderUsage = null;
        console.log(`[microcompact] saved=${micro.saved} cleared=${micro.cleared}`);
        tokens =
          estimateMessagesTokens(apiMessages.filter((message) => message.role !== "system")) +
          estimateTokens(systemInstruction) +
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
        refreshSystemInstruction({ includeTodos: false });
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
        systemPrompt: systemInstruction,
        skillsTokens: currentSkillsTokens,
        maxTokensLimit: contextLimit,
      });

    const initMetrics = computeContextMetrics();
    replyStream("metrics", withUsageMetrics(initMetrics));

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

      recordUsage(result.usage);

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
        toolResultMaxChars: compactCfg.toolResultMaxChars,
        supportsVision,
      });

      const updatedMetrics = computeContextMetrics();
      replyStream("metrics", withUsageMetrics(updatedMetrics));
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
      await maybeCompact("preflight");
      let finalResult;
      try {
        finalResult = await doStreamRequest(apiMessages, { reasoning_effort: "low" });
      } catch (err) {
        if (!isContextOverflowError(err.message)) throw err;
        const compacted = await maybeCompact("overflow", { force: true });
        if (!compacted) throw err;
        finalResult = await doStreamRequest(apiMessages, { reasoning_effort: "low" });
      }
      if (finalResult) recordUsage(finalResult.usage);
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
    replyStream("metrics", withUsageMetrics(finalMetrics));

    const finalVisibleForCheck = fullGeneratedText;
    const outputTruncated = hasUnclosedCodeFence(finalVisibleForCheck);
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
        usage: turnUsage,
        costUsd: Math.round(turnCostUsd * 100_000_000) / 100_000_000,
        model: apiModelId,
        provider,
      },
    });

    try {
      const currentSession = storageService.getSessions().find((s) => s.id === sessionId);
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
    if (err.name === "AbortError" || sessionAbort.cancelled) {
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
            usage: turnUsage,
            costUsd: Math.round(turnCostUsd * 100_000_000) / 100_000_000,
          },
        });
      } catch {}
    } else {
      console.error(`[chat-stream error ${sessionId}]`, err);
      replyStream("error", err.message);
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
      usage: turnUsage,
      costUsd: Math.round(turnCostUsd * 100_000_000) / 100_000_000,
      model: apiModelId,
      provider,
    },
  };
}

module.exports = { registerAgentRunner, runAgentTurn };
