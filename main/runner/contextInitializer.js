const path = require("path");
const { resolveToolResultMaxChars } = require("../../services/contextCompactor");

/**
 * Turn 上下文初始化器：
 * 1. 清洗历史消息并按 reasoningPolicy 回填历史窗口推理
 * 2. 展开斜杠命令与附件（含视觉模型能力校验）
 * 3. 解析 @mention 引用、执行 UserPromptSubmit Hook、并行拉取 Git / MCP / RepoMap / Wiki
 * 4. 组装字节级稳定的 System Prompt 并将易变 Git 快照附着在末尾 user 消息副本上
 */
async function initializeTurnContext({
  messages,
  sessionId,
  sessionWorkDir,
  provider,
  apiModelId,
  modelBaseUrl,
  contextLimit,
  enableTools,
  supportsVision,
  agentMode = "code",
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
}) {
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
        return { aborted: true };
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

  const rawToolMaxChars = Number(storageService.getConfig("context_tool_result_max_chars"));
  const configuredToolResultMaxChars =
    Number.isFinite(rawToolMaxChars) && rawToolMaxChars > 0 ? rawToolMaxChars : null;

  const compactCfg = {
    enabled: storageService.getConfig("context_auto_compact") !== "false",
    thresholdPercent: Number(storageService.getConfig("context_compact_threshold_percent")) || 85,
    keepTokens: Number(storageService.getConfig("context_compact_keep_tokens")) || 20000,
    configuredToolResultMaxChars,
    toolResultMaxChars: resolveToolResultMaxChars({
      contextLimit,
      configuredMaxChars: configuredToolResultMaxChars,
    }),
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
    return { aborted: true };
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
        "ask_user_question",
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
        return { aborted: true };
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

  const resolvedAgentMode = agentMode === "work" ? "work" : "code";
  const isWorkMode = resolvedAgentMode === "work";

  const [gitInfo, mcpTools] = await Promise.all([
    isWorkMode ? Promise.resolve(null) : getGitSnapshotAsync(sessionWorkDir),
    enableTools ? mcpClientService.getActiveMcpTools(sessionWorkDir) : Promise.resolve([]),
  ]);
  sessionToolContext.mcpTools = mcpTools;

  const getActiveToolPromptDocs = () =>
    enableTools && (toolRegistry.size > 0 || mcpTools.length > 0)
      ? toolRegistry.getToolPromptDocs(mcpTools, {
          permissionMode: sessionToolContext.permissionMode,
          agentMode: sessionToolContext.agentMode || resolvedAgentMode,
        })
      : [];

  const globalCustomSystemPrompt = storageService.getConfig("custom_system_prompt") || "";

  let repoMapText = "";
  if (!isWorkMode && sessionWorkDir && storageService.getConfig("repo_map_enabled") !== "false") {
    try {
      repoMapText = await repoIndexService.buildRepoMapAsync(sessionWorkDir, {
        maxChars: Number(storageService.getConfig("repo_map_max_chars")) || 6000,
      });
    } catch (repoErr) {
      console.warn(`[repo-map] 生成失败: ${repoErr.message}`);
    }
  }

  const workspaceRepoDirs =
    Array.isArray(matchedWorkspace?.folders) && matchedWorkspace.folders.length > 0
      ? matchedWorkspace.folders.map((f) => f?.path).filter(Boolean)
      : sessionWorkDir
      ? [sessionWorkDir]
      : [];

  let wikiContext = { text: "", primaryPath: "", isMulti: false };
  if (!isWorkMode && workspaceRepoDirs.length > 0) {
    try {
      if (typeof repoWikiService.buildWorkspaceRepoWikiContext === "function") {
        wikiContext = repoWikiService.buildWorkspaceRepoWikiContext({
          workDirs: workspaceRepoDirs,
          primaryWorkDir: sessionWorkDir,
          maxTotalChars: 12000,
        });
      } else if (sessionWorkDir && typeof repoWikiService.getRepoWiki === "function") {
        const single = repoWikiService.getRepoWiki(sessionWorkDir);
        wikiContext = {
          text: single?.exists ? String(single.content || "").slice(0, 12000) : "",
          primaryPath: single?.path || "",
          isMulti: false,
        };
      }
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
      repoWiki: wikiContext?.text || "",
      repoWikiPath: wikiContext?.primaryPath || "",
      repoWikiIsMulti: Boolean(wikiContext?.isMulti),
      todos: includeTodos ? initialTodos : [],
      toolDocs: getActiveToolPromptDocs(),
      model: `${provider}/${apiModelId}`,
      enableTools,
      permissionMode: sessionToolContext.permissionMode,
      agentMode: sessionToolContext.agentMode || resolvedAgentMode,
      customSystemPrompt: globalCustomSystemPrompt,
      gitInfo,
      includeTodosInSystem: includeTodos,
      includeGitInSystem: false,
    });

  const buildInstructionText = (built) =>
    mentionBlock ? `${built.text}\n\n${mentionBlock}` : built.text;

  const composeSystemInstruction = (built, compactionSummary = "") => {
    const base = buildInstructionText(built);
    return compactionSummary ? `${base}\n\n${compactionSummary}` : base;
  };

  const initialContext = buildInstruction({ includeTodos: false });
  let systemInstruction = composeSystemInstruction(initialContext, "");
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

  const refreshSystemInstruction = (
    targetMessages,
    { includeTodos = false, compactionSummary = "" } = {}
  ) => {
    const rebuilt = buildInstruction({ includeTodos });
    systemInstruction = composeSystemInstruction(rebuilt, compactionSummary);
    currentSkillsTokens =
      rebuilt.sections.find((s) => s.name === "skills")?.tokens || 0;
    if (mentionContext && Array.isArray(mentionContext.skills) && mentionContext.skills.length > 0) {
      currentSkillsTokens += estimateTokens(mentionBlock);
    }
    const list = Array.isArray(targetMessages) ? targetMessages : apiMessages;
    const idx = list.findIndex((m) => m.role === "system");
    if (idx >= 0) {
      list[idx].content = baseSystemContent
        ? `${baseSystemContent}\n\n${systemInstruction}`
        : systemInstruction;
    }
    return systemInstruction;
  };

  const getActiveToolDefs = () =>
    enableTools
      ? toolRegistry.getToolDefinitions(
          mcpTools,
          sessionToolContext.allowedToolNames || null,
          {
            permissionMode: sessionToolContext.permissionMode,
            agentMode: sessionToolContext.agentMode || resolvedAgentMode,
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

  return {
    aborted: false,
    apiMessages,
    reasoningReplay,
    buildAssistantReplayMessage,
    slashCommandInfo,
    compactCfg,
    mcpTools,
    hooksEnabled,
    hookOptions,
    getActiveToolDefs,
    toolDefsTokenEstimate,
    getSystemInstruction: () => systemInstruction,
    getCurrentSkillsTokens: () => currentSkillsTokens,
    refreshSystemInstruction,
  };
}

module.exports = { initializeTurnContext };
