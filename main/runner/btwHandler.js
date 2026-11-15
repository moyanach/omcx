const {
  asyncPathExists,
  getWorkspaceFolders,
  getModelConfig,
  getStorageService,
  getToolRegistry,
  getBtwService,
  getMentionResolver,
  getSandboxPolicyService,
} = require("../shared");

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

function registerBtwHandlers(ipcMain) {
  if (!ipcMain) return;
  const activeBtwSessions = new Map();

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
}

module.exports = { registerBtwHandlers };
