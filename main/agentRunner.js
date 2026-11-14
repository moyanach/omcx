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
  PERMISSION_TIMEOUT_MS,
  asyncPathExists,
  asyncStatSafe,
  getWorkspaceFolders,
  getModelConfig,
  pickLiteModel,
  normalizeUsage,
  mergeUsage,
  computeUsageCost,
  buildReasoningPayload,
  buildAttachmentMessagesAsync,
  isImageFile,
  extractTextContent,
  hasUnclosedCodeFence,
  sendStreamEvent,
  getStorageService,
  getReasoningPolicy,
  getAnthropicClient,
  getContextCompactor,
  getContextCalculator,
  getContextBuilder,
  getToolRegistry,
  getMcpClientService,
  getRepoIndexService,
  getRepoWikiService,
  getCommandService,
  getHookService,
  getBtwService,
  getGitWorktreeService,
  getMentionResolver,
  getPathResolver,
  getSandboxPolicyService,
} = require("./shared");

async function generateSessionTitleSidecar(sessionId, userPrompt, currentModelId, webContents) {
  const storageService = getStorageService();
  const { isAnthropicProvider, completeAnthropicMessage } = getAnthropicClient();

  try {
    const session = storageService.getSessions().find((s) => s.id === sessionId);
    if (!session || session.title_source === "custom") {
      return;
    }

    let cleanPrompt = String(userPrompt || "").trim();
    cleanPrompt = cleanPrompt
      .replace(/\[image\s*#?\d+\]/gi, "")
      .replace(/@\S+/g, "")
      .trim();
    if (!cleanPrompt || cleanPrompt.length < 2) return;

    const applyLocalFallbackTitle = () => {
      let snippet = cleanPrompt
        .replace(/^(请问|帮我|请帮我|如何|怎么|麻烦|想问下|我想|分析一下|看一下|看看)[：:，,\s]*/i, "")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
      if (snippet.length > 15) {
        snippet = snippet.slice(0, 15);
      }
      if (snippet.length >= 2) {
        const updated = storageService.updateSessionGeneratedTitle(sessionId, snippet);
        if (updated && webContents && !webContents.isDestroyed()) {
          webContents.send("session-title-updated", { sessionId, title: snippet });
          console.log(`[title-sidecar:fallback] applied local fallback title for ${sessionId}: "${snippet}"`);
        }
      }
    };

    let { modelBaseUrl, modelApiKey, apiModelId, provider } = getModelConfig(
      currentModelId,
      "gpt-4o"
    );
    if (!modelBaseUrl || (!modelApiKey && currentModelId !== "ollama")) {
      const liteChoice = pickLiteModel(currentModelId);
      const liteCfg = getModelConfig(liteChoice, "gpt-4o");
      if (liteCfg.modelBaseUrl && (liteCfg.modelApiKey || liteChoice === "ollama")) {
        modelBaseUrl = liteCfg.modelBaseUrl;
        modelApiKey = liteCfg.modelApiKey;
        apiModelId = liteCfg.apiModelId;
        provider = liteCfg.provider;
      } else {
        applyLocalFallbackTitle();
        return;
      }
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 6000);

    let rawTitle = "";
    try {
      if (isAnthropicProvider(provider, modelBaseUrl)) {
        const anthropicTitle = await completeAnthropicMessage({
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
          model: apiModelId,
          system:
            "你是会话命名助手。根据用户提问的核心意图，提炼出一个简短、精准的中文标题（4到10个汉字）。禁止回答问题，禁止输出任何标点符号、引号、书名号或“标题：”等前缀，直接输出纯文本标题本身。",
          messages: [
            {
              role: "user",
              content: `<message>\n${cleanPrompt.slice(0, 400)}\n</message>`,
            },
          ],
          maxTokens: 40,
          temperature: 0.2,
          signal: controller.signal,
        });
        rawTitle = String(anthropicTitle.content || "").trim();
      } else {
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (modelApiKey) {
          headers["Authorization"] = `Bearer ${modelApiKey}`;
        }

        const response = await fetch(`${modelBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: apiModelId,
            messages: [
              {
                role: "system",
                content:
                  "你是会话命名助手。根据用户提问的核心意图，提炼出一个简短、精准的中文标题（4到10个汉字）。禁止回答问题，禁止输出任何标点符号、引号、书名号或“标题：”等前缀，直接输出纯文本标题本身。",
              },
              {
                role: "user",
                content: `<message>\n${cleanPrompt.slice(0, 400)}\n</message>`,
              },
            ],
            max_tokens: 30,
            temperature: 0.2,
            stream: false,
          }),
        });

        if (!response.ok) {
          console.warn(`[title-sidecar] AI 标题接口返回 HTTP ${response.status}，切换本地规则提纯命名`);
          clearTimeout(timeoutTimer);
          applyLocalFallbackTitle();
          return;
        }

        const data = await response.json();
        rawTitle = data?.choices?.[0]?.message?.content?.trim() || "";
      }
    } finally {
      clearTimeout(timeoutTimer);
    }

    if (!rawTitle) {
      applyLocalFallbackTitle();
      return;
    }

    let title = rawTitle
      .replace(/^[`"'“‘《【\[(（\s]+|[`"'”’》】\])）\s]+$/g, "")
      .replace(/^(会话标题|会话名称|标题|Title|Topic)[：:]\s*/i, "")
      .trim();

    title = title.split(/\r?\n/)[0].trim().slice(0, 20);

    if (title.length >= 2) {
      const updated = storageService.updateSessionGeneratedTitle(sessionId, title);
      if (updated && webContents && !webContents.isDestroyed()) {
        webContents.send("session-title-updated", { sessionId, title });
        console.log(`[title-sidecar] generated AI title for ${sessionId}: "${title}"`);
      }
    } else {
      applyLocalFallbackTitle();
    }
  } catch (err) {
    console.warn(`[title-sidecar] 异常 (${err.message})，使用本地规则提纯命名`);
    try {
      let snippet = String(userPrompt || "")
        .replace(/\[image\s*#?\d+\]/gi, "")
        .replace(/@\S+/g, "")
        .replace(/^(请问|帮我|请帮我|如何|怎么|麻烦|想问下|我想|分析一下|看一下|看看)[：:，,\s]*/i, "")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
      if (snippet.length > 15) snippet = snippet.slice(0, 15);
      if (snippet.length >= 2) {
        const updated = storageService.updateSessionGeneratedTitle(sessionId, snippet);
        if (updated && webContents && !webContents.isDestroyed()) {
          webContents.send("session-title-updated", { sessionId, title: snippet });
        }
      }
    } catch {}
  }
}

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

  const activeBtwSessions = new Map();
  const BTW_READONLY_TOOL_NAMES = new Set([
    "read_file",
    "search_code",
    "find_references",
    "repo_map",
  ]);

  function sendBtwEvent(sender, envelope, type, data) {
    if (!sender || (sender.isDestroyed && sender.isDestroyed())) return;
    try {
      sender.send("btw-stream-event", { ...envelope, type, data });
    } catch {}
  }

  ipcMain.handle("btw-request", async (event, payload = {}) => {
    const sessionId = String(payload.sessionId || "").trim();
    const btwId = String(payload.btwId || "").trim();
    const runId = String(payload.runId || "").trim();
    const question = String(payload.question || "").trim();

    if (!sessionId || !btwId || !question) {
      return { ok: false, error: "旁路请求参数不完整" };
    }

    for (const [existingId, existing] of activeBtwSessions) {
      if (existing.sessionId !== sessionId) continue;
      try {
        existing.controller.abort();
      } catch {}
      activeBtwSessions.delete(existingId);
      sendBtwEvent(existing.sender, existing.envelope, "end", {
        cancelled: true,
        superseded: true,
        content: "",
      });
    }

    const {
      modelBaseUrl,
      modelApiKey,
      provider,
      apiModelId,
      maxOutputTokens,
    } = getModelConfig(payload.model, "gpt-4o");

    if (!modelApiKey && provider !== "ollama") {
      return { ok: false, error: "请先在【设置】中配置该模型的 API Key" };
    }

    const storageService = getStorageService();
    const toolRegistry = getToolRegistry();
    const { buildMentionContext } = getMentionResolver();
    const { PERMISSION_MODES } = getSandboxPolicyService();
    const btwService = getBtwService();

    const session = storageService.getSessions().find((s) => s.id === sessionId);
    let workDir =
      payload.workDir && typeof payload.workDir === "string" && payload.workDir.trim()
        ? payload.workDir.trim()
        : session?.work_dir || null;
    if (workDir && !(await asyncPathExists(workDir))) workDir = null;

    const { allowedFolders } = getWorkspaceFolders(workDir);

    let userContent = question;
    if (workDir) {
      try {
        const mention = buildMentionContext(question, workDir, allowedFolders, {
          skills: [],
          mcpServers: [],
        });
        if (mention?.block) {
          userContent = `${mention.block}\n\n【旁路问题】\n${question}`;
        }
        if (Array.isArray(mention?.skipped) && mention.skipped.length > 0) {
          console.log(`[btw] 跳过 ${mention.skipped.length} 个无法解析的 @ 引用`);
        }
      } catch (err) {
        console.warn("[btw] @ 引用解析失败，回退原始问题:", err.message);
      }
    }

    const quotedText = String(payload.quotedText || "").trim().slice(0, 8000);

    const controller = new AbortController();
    const envelope = { sessionId, btwId, runId };
    const entry = {
      sessionId,
      btwId,
      runId,
      controller,
      sender: event.sender,
      envelope,
    };
    activeBtwSessions.set(btwId, entry);

    const abortTimer = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, 6 * 60 * 1000);

    const onSenderDestroyed = () => {
      try {
        controller.abort();
      } catch {}
    };
    try {
      event.sender.once("destroyed", onSenderDestroyed);
    } catch {}

    const toolDefinitions = toolRegistry.getToolDefinitions(
      [],
      BTW_READONLY_TOOL_NAMES,
      { permissionMode: PERMISSION_MODES.PLAN }
    );

    const toolContext = {
      sessionId: `${sessionId}::btw::${btwId}`,
      workDir,
      allowedFolders,
      writableFolders: [],
      permissionMode: PERMISSION_MODES.PLAN,
      checkPermission: null,
      allowedToolNames: BTW_READONLY_TOOL_NAMES,
      abortSignal: controller.signal,
      mcpTools: [],
      modelConfig: {
        baseUrl: modelBaseUrl,
        apiKey: modelApiKey,
        provider,
        modelName: apiModelId,
      },
    };

    void (async () => {
      try {
        const result = await btwService.runBtw({
          question: userContent,
          quotedText,
          digest: payload.contextDigest,
          history: Array.isArray(payload.history) ? payload.history : [],
          workDir,
          modelConfig: {
            baseUrl: modelBaseUrl,
            apiKey: modelApiKey,
            provider,
            modelName: apiModelId,
            maxOutputTokens,
          },
          toolDefinitions,
          toolContext,
          allowedToolNames: BTW_READONLY_TOOL_NAMES,
          toolRegistry,
          abortSignal: controller.signal,
          onDelta: (delta) => sendBtwEvent(event.sender, envelope, "data", delta),
          onToolStatus: (status) =>
            sendBtwEvent(event.sender, envelope, "tool_status", status),
        });

        if (controller.signal.aborted || result.cancelled) {
          sendBtwEvent(event.sender, envelope, "end", {
            cancelled: true,
            content: result.content || "",
            usage: result.usage || null,
            rounds: result.rounds,
          });
        } else {
          sendBtwEvent(event.sender, envelope, "end", {
            cancelled: false,
            content: result.content || "",
            usage: result.usage || null,
            rounds: result.rounds,
            hitRoundLimit: Boolean(result.hitRoundLimit),
          });
        }
        console.log(
          `[btw] ${btwId} 完成：${result.rounds} 轮，${result.content?.length || 0} 字符`
        );
      } catch (err) {
        const cancelled = controller.signal.aborted;
        if (cancelled) {
          sendBtwEvent(event.sender, envelope, "end", {
            cancelled: true,
            content: "",
          });
        } else {
          console.error("[btw] 请求失败:", err?.message || err);
          sendBtwEvent(event.sender, envelope, "error", {
            message: err?.message || String(err),
          });
        }
      } finally {
        clearTimeout(abortTimer);
        try {
          event.sender.removeListener("destroyed", onSenderDestroyed);
        } catch {}
        if (activeBtwSessions.get(btwId) === entry) {
          activeBtwSessions.delete(btwId);
        }
      }
    })();

    return { ok: true, btwId };
  });

  ipcMain.handle("btw-cancel", async (_event, { btwId } = {}) => {
    const entry = activeBtwSessions.get(String(btwId || "").trim());
    if (!entry) return { ok: true, alreadyEnded: true };
    try {
      entry.controller.abort();
    } catch {}
    return { ok: true };
  });

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
      const { isAnthropicProvider, streamAnthropicMessage } = getAnthropicClient();
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
      const { buildSystemContext, getGitSnapshotAsync } = getContextBuilder();
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
        for (const [permId, entry] of pendingPermissions) {
          if (entry.sessionId !== sessionId) continue;
          pendingPermissions.delete(permId);
          try {
            entry.settle({
              allow: false,
              decision: "superseded",
              reason: "新的执行请求已接管当前会话，旧审批自动作废",
            });
          } catch {}
          try {
            if (event?.sender && !event.sender.isDestroyed()) {
              replyStream("permission_resolved", {
                id: permId,
                reason: "新的执行请求已接管当前会话，旧审批自动作废",
              });
            }
          } catch {}
        }
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

      const checkPermissionFn = async (targetPath, actionDesc, meta = {}) => {
        if (customCheckPermission) {
          return await customCheckPermission(targetPath, actionDesc, meta);
        }
        const kind = meta?.kind || "external_path";
        if (
          kind === "external_path" &&
          actionDesc === "读取" &&
          isBuiltinTrustedPath(targetPath, sessionId)
        ) {
          return true;
        }
        if (!event?.sender) {
          return resolvedPermissionMode === PERMISSION_MODES.FULL_ACCESS;
        }
        const reqId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        return new Promise((resolve) => {
          let settled = false;
          let destroyedHandler = null;
          let timer = null;
          const settleOnce = async (resp) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            pendingPermissions.delete(reqId);
            if (destroyedHandler && event?.sender) {
              try {
                event.sender.removeListener("destroyed", destroyedHandler);
              } catch {}
            }
            const allow = typeof resp === "object" ? !!resp.allow : !!resp;
            const decision =
              typeof resp === "object" && resp.decision
                ? resp.decision
                : allow
                ? "allow_once"
                : "deny";

            if (allow) {
              if (decision === "allow_session" && kind === "external_path" && targetPath) {
                const resolvedTarget = path.resolve(targetPath);
                const st = await asyncStatSafe(resolvedTarget);
                const folderToTrust =
                  st && st.isDirectory() ? resolvedTarget : path.dirname(resolvedTarget);
                if (!allowedFolders.includes(folderToTrust)) {
                  allowedFolders.push(folderToTrust);
                }
                if (actionDesc !== "读取" && actionDesc !== "浏览目录") {
                  if (!writableFolders.includes(folderToTrust)) {
                    writableFolders.push(folderToTrust);
                  }
                }
              } else if (decision === "switch_auto_sandbox") {
                if (sessionAbort.toolContext) {
                  sessionAbort.toolContext.permissionMode = PERMISSION_MODES.AUTO_SANDBOX;
                }
                const targetSess = storageService.getSessions().find((s) => s.id === sessionId);
                if (targetSess) {
                  targetSess.permission_mode = PERMISSION_MODES.AUTO_SANDBOX;
                  storageService.saveSession(targetSess);
                }
                event?.reply?.("session-permission-mode-updated", {
                  sessionId,
                  permissionMode: PERMISSION_MODES.AUTO_SANDBOX,
                });
              }
            }
            resolve(allow);
          };

          const notifyResolved = (reason) => {
            try {
              if (event?.sender && !event.sender.isDestroyed()) {
                replyStream("permission_resolved", { id: reqId, reason });
              }
            } catch {}
          };

          timer = setTimeout(() => {
            void settleOnce({
              allow: false,
              decision: "deny",
              reason: "审批等待超时，已自动拒绝",
            });
            notifyResolved("审批等待超时，已自动拒绝");
          }, PERMISSION_TIMEOUT_MS);

          destroyedHandler = () => {
            void settleOnce({
              allow: false,
              decision: "deny",
              reason: "窗口已关闭，审批自动作废",
            });
          };
          try {
            event?.sender?.once("destroyed", destroyedHandler);
          } catch {}

          pendingPermissions.set(reqId, { sessionId, settle: settleOnce });
          replyStream("permission", {
            id: reqId,
            path: targetPath,
            action: actionDesc,
            kind,
            command: meta?.command || undefined,
            allowSwitchAutoSandbox: Boolean(meta?.allowSwitchAutoSandbox),
            reason:
              meta?.reason ||
              "该路径位于当前已选定的工作空间源文件夹之外，请确认是否允许 Agent 访问该外部路径",
          });
        });
      };

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
        if (
          sessionWorkDir &&
          storageService.getConfig("repo_map_enabled") !== "false"
        ) {
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

        const buildInstruction = () =>
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
            todos: initialTodos,
            toolDocs: getActiveToolPromptDocs(),
            model: `${provider}/${apiModelId}`,
            enableTools,
            permissionMode: sessionToolContext.permissionMode,
            customSystemPrompt: globalCustomSystemPrompt,
            gitInfo,
          });

        const buildInstructionText = (built) =>
          mentionBlock ? `${built.text}\n\n${mentionBlock}` : built.text;

        const composeSystemInstruction = (built) => {
          const base = buildInstructionText(built);
          return compactionSummary ? `${base}\n\n${compactionSummary}` : base;
        };

        const initialContext = buildInstruction();
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

        const refreshSystemInstruction = () => {
          const rebuilt = buildInstruction();
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
            compactionSummary = result.summaryBlock;
            refreshSystemInstruction();
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
          refreshSystemInstruction();
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
        const STREAM_IDLE_TIMEOUT_MS = STREAM_IDLE_TIMEOUT_SEC * 1000;

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
            if (anthropicResult.usage) {
              lastProviderUsage = anthropicResult.usage;
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
                  timeoutSec: STREAM_IDLE_TIMEOUT_SEC,
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
                  `上游连接已连续 ${STREAM_IDLE_TIMEOUT_SEC} 秒未返回任何数据（可能网关超时、代理中断或模型服务卡死）`
                );
                err.name = "StreamIdleTimeoutError";
                err.code = "STREAM_IDLE_TIMEOUT";
                reject(err);
              }, STREAM_IDLE_TIMEOUT_MS);
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
                    lastProviderUsage = normalizeUsage(json.usage, provider);
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

          return {
            content: fullContent,
            reasoning: fullReasoning,
            reasoningMeta: { provider: "openai-compatible", signatures: [] },
            toolCalls: toolCalls.filter(Boolean),
            usage,
            hitLengthLimit,
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
            const cleanRoundText = (result.content || "").trim();
            const hasIncompleteTodos =
              initialTodos.length > 0 && initialTodos.some((t) => t.status !== "completed");

            if (Array.isArray(sessionAbort.steerQueue) && sessionAbort.steerQueue.length > 0) {
              const steers = sessionAbort.steerQueue.splice(0);
              if (cleanRoundText) {
                apiMessages.push({ role: "assistant", content: result.content });
              }
              for (const steer of steers) {
                apiMessages.push({
                  role: "user",
                  content: `【用户中途更新/追加的需求上下文】\n${steer.content}\n\n[系统引导]：用户在当前任务执行中途补充或更新了上述内容。请自主综合分析用户意图（是补充业务背景、澄清细节、细化边界条件，还是调整/纠偏当前执行路线）：\n- 若属于补充背景、澄清细节或细化约束：请将该上下文无缝融合进当前任务，并在后续步骤与最终答复中予以落实；\n- 若属于方向调整或纠偏：请以最新指示为准调整后续行动，无需推倒已完成且不冲突的工作。`,
                });
              }
              replyStream("steered", steers);
              console.log(
                `[chat-steer] assistant was finishing; injected ${steers.length} steering message(s) and continued the loop`
              );
              sendData("\n\n");
              continue;
            }

            const hasAnyPayload =
              cleanRoundText.length > 0 ||
              Boolean(result.reasoning && String(result.reasoning).trim()) ||
              result.toolCalls.length > 0;
            if (!hasAnyPayload) {
              if (emptyRoundRetry < 1) {
                emptyRoundRetry++;
                console.warn(
                  `[chat-stream] 第 ${toolRound + 1} 轮模型返回空响应 ` +
                    `(receivedBytes=${result.receivedBytes || 0}, finishReason=${result.finishReason || "none"})，自动重试 1 次`
                );
                await new Promise((r) => setTimeout(r, 600));
                continue;
              }
              throw new Error(
                `上游模型未返回任何内容（收到的数据量 ${result.receivedBytes || 0} 字节，finish_reason=${
                  result.finishReason || "无"
                }）。可能原因：网关超时/连接被中断、模型服务异常或请求被代理拦截。请重试，或切换其他模型。`
              );
            }

            if (result.hitLengthLimit && cleanRoundText.length > 0 && continuationCount < MAX_CONTINUATIONS) {
              continuationCount++;
              const tailSnippet = result.content.slice(-80);
              console.log(`[auto-continue] 模式A：正文触发长度上限，发起第 ${continuationCount} 次无缝断点续写`);
              apiMessages.push(buildAssistantReplayMessage(result, { content: result.content }));
              apiMessages.push({
                role: "user",
                content: `你的上一条回复因达到单次输出长度上限而在末尾中断（中断处末尾字符为：${JSON.stringify(
                  tailSnippet
                )}）。请紧接在该位置之后无缝继续输出剩余内容，禁止重复前文或添加任何开场白。`,
              });
              continue;
            }

            if (
              (result.hitLengthLimit || (result.reasoning && cleanRoundText.length === 0)) &&
              continuationCount < MAX_CONTINUATIONS
            ) {
              continuationCount++;
              console.log(`[auto-continue] 模式B：思考或大工具参数被截断，发起第 ${continuationCount} 次增量恢复`);
              apiMessages.push({
                role: "assistant",
                content: result.reasoning
                  ? `已完成阶段思考分析：${result.reasoning.slice(-1200)}`
                  : "已完成阶段思考分析。",
              });
              apiMessages.push({
                role: "user",
                content:
                  "你刚才的思考或工具调用参数因超出单次输出上限被截断，尚未发出工具调用或正文。你已经完成了思考推导，接下来请：(1) 不要再重复长篇思考（保持极简思考）；(2) 若要写入较长文件（如完整 README 或复杂 SVG），请拆分为多步执行——先调用 write_file 写入前半部分或核心骨架，再调用 edit_file 分段追加剩余章节；或者直接输出最终完整代码与回复。",
              });
              continue;
            }

            if (
              hasIncompleteTodos &&
              sessionToolContext.permissionMode !== PERMISSION_MODES.PLAN &&
              cleanRoundText.length < 80 &&
              continuationCount < MAX_CONTINUATIONS
            ) {
              continuationCount++;
              const activeTodo =
                initialTodos.find((t) => t.status === "in_progress") ||
                initialTodos.find((t) => t.status === "pending");
              console.log(`[auto-continue] 模式C：检测到未完成 Todo (${activeTodo?.text})，督促继续执行`);
              if (cleanRoundText) {
                apiMessages.push(buildAssistantReplayMessage(result, { content: cleanRoundText }));
              }
              apiMessages.push({
                role: "user",
                content: `当前任务规划中仍有未完成的待办项（当前待完成：${
                  activeTodo?.text || "剩余任务"
                }），请不要停留在准备阶段，立即调用相应工具（如 write_file / edit_file / run_command）继续执行，并在全部完成后更新 todo_write 及输出最终总结。`,
              });
              continue;
            }

            const cumulativeVisibleText = fullGeneratedText
              .replace(/\btask ready\b/gi, "")
              .trim();
            if (
              !result.hitLengthLimit &&
              cumulativeVisibleText.length > 0 &&
              hasUnclosedCodeFence(cumulativeVisibleText) &&
              continuationCount < MAX_CONTINUATIONS
            ) {
              continuationCount++;
              console.log(
                `[auto-continue] 模式D：代码块未闭合即结束，发起第 ${continuationCount} 次断点续写`
              );
              apiMessages.push(
                buildAssistantReplayMessage(result, { content: result.content || cleanRoundText })
              );
              apiMessages.push({
                role: "user",
                content:
                  "你的上一条回复在一个未闭合的代码块中途停止了（末尾没有正常收尾）。请紧接最后一行继续输出剩余内容，补全代码块并给出完整结论；禁止重复前文、禁止重新开场。",
              });
              continue;
            }

            break;
          }

          continuationCount = 0;
          toolRound++;

          const READ_ONLY_TOOLS = new Set([
            "read_file",
            "list_directory",
            "search_code",
            "search_symbols",
            "repo_map",
            "web_search",
            "web_fetch",
          ]);

          const preparedCalls = result.toolCalls.map((tc, idx) => {
            const callId = tc.id || `call_${Date.now()}_${idx}`;
            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = { _parseError: tc.function.arguments };
            }
            return { tc, callId, args };
          });

          for (const item of preparedCalls) {
            replyStream("tool_status", {
              tool: item.tc.function.name,
              status: "running",
              args: item.args,
              callId: item.callId,
            });
          }

          const executeSingleCall = async ({ tc, callId, args }) => {
            if (sessionAbort.cancelled) {
              return { tc, callId, args, execResult: { success: false, error: "已取消" } };
            }

            if (
              sessionToolContext.allowedToolNames &&
              !sessionToolContext.allowedToolNames.has(tc.function.name)
            ) {
              const whitelistBlockedResult = {
                success: false,
                error: `当前激活的技能限制了可用工具范围，已拒绝调用 ${tc.function.name}`,
              };
              executedToolSteps.push({
                tool: tc.function.name,
                status: "done",
                args,
                result: whitelistBlockedResult,
                callId,
              });
              replyStream("tool_status", {
                tool: tc.function.name,
                status: "done",
                args,
                result: whitelistBlockedResult,
                callId,
              });
              persistPartial(true);
              return {
                tc,
                callId,
                args,
                execResult: whitelistBlockedResult,
              };
            }

            if (hooksEnabled) {
              try {
                const preHook = await hookService.runHooks(
                  "PreToolUse",
                  {
                    tool_name: tc.function.name,
                    tool_input: args,
                    session_id: sessionId,
                    cwd: sessionWorkDir,
                  },
                  hookOptions
                );
                if (preHook.blocked) {
                  const blockedResult = {
                    success: false,
                    error: `Hook 阻断了工具 ${tc.function.name}：${preHook.reason}`,
                  };
                  executedToolSteps.push({
                    tool: tc.function.name,
                    status: "done",
                    args,
                    result: blockedResult,
                    callId,
                  });
                  replyStream("tool_status", {
                    tool: tc.function.name,
                    status: "done",
                    args,
                    result: blockedResult,
                    callId,
                  });
                  return { tc, callId, args, execResult: blockedResult };
                }
              } catch (hookErr) {
                console.warn("[hook] PreToolUse 执行异常:", hookErr.message);
              }
            }

            let currentSubSteps = [];
            const callScopedContext =
              tc.function.name === "dispatch_subagent"
                ? {
                    ...sessionToolContext,
                    onSubagentProgress: (subSteps) => {
                      currentSubSteps = subSteps;
                      replyStream("tool_status", {
                        tool: tc.function.name,
                        status: "running",
                        args,
                        callId,
                        subSteps,
                      });
                    },
                  }
                : sessionToolContext;

            const execResult = await toolRegistry.execute(
              tc.function.name,
              args,
              callScopedContext,
              mcpTools
            );

            if (hooksEnabled) {
              try {
                await hookService.runHooks(
                  "PostToolUse",
                  {
                    tool_name: tc.function.name,
                    tool_input: args,
                    tool_response: execResult,
                    session_id: sessionId,
                    cwd: sessionWorkDir,
                  },
                  hookOptions
                );
              } catch (hookErr) {
                console.warn("[hook] PostToolUse 执行异常:", hookErr.message);
              }
            }

            if (
              (tc.function.name === "write_file" || tc.function.name === "edit_file") &&
              execResult?.success &&
              execResult?.data?.success !== false
            ) {
              const fullOutPath = path.isAbsolute(args.path)
                ? args.path
                : path.join(sessionWorkDir || "", args.path);
              const outItem = {
                name: path.basename(args.path),
                filePath: fullOutPath,
                fileType: path.extname(args.path).replace(".", "").toLowerCase() || "file",
                action: execResult?.data?.action || "modified",
              };
              storageService.addSessionOutput(sessionId, outItem);
              replyStream("outputs", outItem);
            }

            executedToolSteps.push({
              tool: tc.function.name,
              status: "done",
              args,
              result: execResult,
              callId,
              ...(currentSubSteps.length > 0 ? { subSteps: currentSubSteps } : {}),
            });

            persistPartial(true);

            replyStream("tool_status", {
              tool: tc.function.name,
              status: "done",
              args,
              result: execResult,
              callId,
              ...(currentSubSteps.length > 0 ? { subSteps: currentSubSteps } : {}),
            });

            return { tc, callId, args, execResult };
          };

          const isParallelSafeCall = (item) => {
            const name = item.tc.function.name;
            if (READ_ONLY_TOOLS.has(name)) return true;
            if (name === "dispatch_subagent") {
              const a = item.args || {};
              if (Array.isArray(a.tasks)) {
                return a.tasks.every((t) => t.readOnly !== false && t.agent !== "general");
              }
              return a.readOnly !== false && a.agent !== "general";
            }
            return false;
          };

          const allReadOnly =
            preparedCalls.length > 1 &&
            preparedCalls.every((item) => isParallelSafeCall(item));

          let completedCalls = [];
          if (allReadOnly) {
            completedCalls = await Promise.all(preparedCalls.map((item) => executeSingleCall(item)));
          } else {
            for (const item of preparedCalls) {
              if (sessionAbort.cancelled) break;
              const res = await executeSingleCall(item);
              completedCalls.push(res);
            }
          }

          if (completedCalls.length > 0) {
            apiMessages.push(
              buildAssistantReplayMessage(result, {
                toolCalls: completedCalls.map(({ tc, callId }) => ({
                  id: callId,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                })),
              })
            );

            const pendingVisionShots = [];
            for (const { callId, execResult } of completedCalls) {
              let sanitizedResult = execResult;
              if (sanitizedResult && typeof sanitizedResult === "object") {
                if ("__visionImageDataUrl" in sanitizedResult) {
                  if (sanitizedResult.__visionImageDataUrl) {
                    pendingVisionShots.push(sanitizedResult.__visionImageDataUrl);
                  }
                  const { __visionImageDataUrl, ...rest } = sanitizedResult;
                  sanitizedResult = rest;
                }
                if (
                  sanitizedResult.data &&
                  typeof sanitizedResult.data === "object" &&
                  "originalContent" in sanitizedResult.data
                ) {
                  sanitizedResult = {
                    ...sanitizedResult,
                    data: { ...sanitizedResult.data, originalContent: undefined },
                  };
                }
              }
              apiMessages.push({
                role: "tool",
                tool_call_id: callId,
                content: truncateToolResult(JSON.stringify(sanitizedResult), compactCfg.toolResultMaxChars),
              });
            }
            if (supportsVision && pendingVisionShots.length > 0) {
              const latestShot = pendingVisionShots[pendingVisionShots.length - 1];
              apiMessages.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "以上浏览器工具已截取当前页面画面，请结合截图内容继续分析或执行下一步操作：",
                  },
                  {
                    type: "image_url",
                    image_url: { url: latestShot },
                  },
                ],
              });
            }
          }

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
