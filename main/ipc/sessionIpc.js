const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const { ipcMain, BrowserWindow, dialog } = require("electron");
const {
  safeHandler,
  asyncPathExists,
  getApiConfig,
  getStorageService,
  getFontService,
  getGitWorktreeService,
  getCommandService,
  getSpecService,
  getHookService,
  getSessionTransferService,
  getSandboxPolicyService,
  activeStreamSessions,
} = require("../shared");

function registerSessionIpc() {
  ipcMain.handle(
    "get-config",
    safeHandler((event, key) => getStorageService().getConfig(key))
  );

  ipcMain.handle(
    "set-config",
    safeHandler((event, key, value) => getStorageService().setConfig(key, value))
  );

  ipcMain.handle(
    "get-system-fonts",
    safeHandler((event, { refresh } = {}) => getFontService().getSystemFonts({ force: Boolean(refresh) }))
  );

  ipcMain.handle(
    "get-user-info",
    safeHandler(() => {
      try {
        return { username: os.userInfo().username || "本地用户" };
      } catch {
        return { username: "本地用户" };
      }
    })
  );

  ipcMain.handle(
    "db-get-models",
    safeHandler(() => getStorageService().getModels())
  );

  ipcMain.handle(
    "db-add-model",
    safeHandler((event, model) => getStorageService().addModel(model))
  );

  ipcMain.handle(
    "db-delete-model",
    safeHandler((event, id) => getStorageService().deleteModel(id))
  );

  ipcMain.handle(
    "api-get-models",
    safeHandler(async (event, params = {}) => {
      const globalCfg = getApiConfig();
      const activeBaseUrl = (params.baseUrl || globalCfg.baseUrl || "").trim().replace(/\/+$/, "");
      const activeApiKey = params.apiKey !== undefined ? params.apiKey.trim() : (globalCfg.apiKey || "").trim();

      if (!activeBaseUrl) {
        throw new Error("Base URL 不能为空");
      }

      const headers = {};
      const isAnthropicEndpoint =
        params.provider === "anthropic" ||
        /anthropic\.com|claude/i.test(activeBaseUrl);
      if (activeApiKey) {
        if (isAnthropicEndpoint) {
          headers["x-api-key"] = activeApiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${activeApiKey}`;
        }
      }

      try {
        const fetchUrl = isAnthropicEndpoint
          ? /\/v1$/i.test(activeBaseUrl)
            ? `${activeBaseUrl}/models`
            : `${activeBaseUrl}/v1/models`
          : `${activeBaseUrl}/models`;
        const response = await fetch(fetchUrl, {
          headers,
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
        }

        const data = await response.json();
        if (Array.isArray(data.data)) {
          return data.data;
        } else if (Array.isArray(data)) {
          return data;
        } else if (Array.isArray(data.models)) {
          return data.models.map((m) => ({ id: m.name || m.model }));
        }
        return [];
      } catch (err) {
        console.error("[api-get-models] 拉取远程模型失败:", err.message);
        throw new Error(err.message || "连接失败");
      }
    })
  );

  ipcMain.handle(
    "db-get-sessions",
    safeHandler(() => getStorageService().getSessions())
  );

  ipcMain.handle(
    "db-add-session",
    safeHandler((event, session) => getStorageService().saveSession(session))
  );

  ipcMain.handle(
    "db-update-session-title",
    safeHandler((event, id, title) => {
      const storageService = getStorageService();
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.title = title;
        session.title_source = "custom";
        storageService.saveSession(session);
        return true;
      }
      return false;
    })
  );

  ipcMain.handle(
    "db-update-session-work-dir",
    safeHandler((event, id, workDir) => {
      const storageService = getStorageService();
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.work_dir = workDir || null;
        storageService.saveSession(session);
        return true;
      }
      return false;
    })
  );

  ipcMain.handle(
    "db-update-session-workspace",
    safeHandler((event, { id, workspaceId, workDir }) =>
      getStorageService().updateSessionWorkspace(id, workspaceId, workDir)
    )
  );

  ipcMain.handle(
    "db-update-session-reasoning-effort",
    safeHandler((event, { id, reasoningEffort }) => {
      const storageService = getStorageService();
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.reasoning_effort = reasoningEffort || "off";
        storageService.saveSession(session);
        return true;
      }
      return false;
    })
  );

  ipcMain.handle(
    "db-get-session-work-dir",
    safeHandler((event, id) => {
      const session = getStorageService().getSessions().find((s) => s.id === id);
      return session?.work_dir || null;
    })
  );

  ipcMain.handle(
    "db-update-session-permission-mode",
    safeHandler((event, { id, permissionMode }) => {
      const { normalizePermissionMode } = getSandboxPolicyService();
      const storageService = getStorageService();
      const normalized = normalizePermissionMode(permissionMode);
      const session = storageService.getSessions().find((s) => s.id === id);
      if (session) {
        session.permission_mode = normalized;
        storageService.saveSession(session);
      }
      const active = activeStreamSessions.get(id);
      if (active && active.toolContext) {
        active.toolContext.permissionMode = normalized;
      }
      return { success: true, permissionMode: normalized };
    })
  );

  ipcMain.handle(
    "db-delete-session",
    safeHandler((event, id) => {
      getGitWorktreeService().removeSessionWorktreeGroup(id);
      return getStorageService().deleteSession(id);
    })
  );

  ipcMain.handle(
    "db-get-messages",
    safeHandler(async (event, sessionId) => {
      const storageService = getStorageService();
      const msgs = await storageService.getMessagesAsync(sessionId);

      const toIpcMessage = (m) => {
        if (!m || m.role !== "assistant") return m;
        const chars = Number(m.reasoning_chars || m.reasoningChars || m.metadata?.reasoningChars || 0);
        if (chars > 0) {
          return {
            ...m,
            reasoningChars: chars,
            metadata: {
              ...(m.metadata && typeof m.metadata === "object" ? m.metadata : {}),
              reasoningChars: chars,
            },
          };
        }
        if (typeof m.content === "string" && m.content.includes("<think")) {
          const { content, reasoning } = storageService.extractLegacyThinking(m.content);
          if (reasoning) {
            return {
              ...m,
              content,
              reasoningChars: reasoning.length,
              metadata: {
                ...(m.metadata && typeof m.metadata === "object" ? m.metadata : {}),
                reasoningChars: reasoning.length,
              },
            };
          }
        }
        return m;
      };

      if (activeStreamSessions.has(sessionId)) return msgs.map(toIpcMessage);
      const stale = msgs.filter(
        (m) => m.metadata && typeof m.metadata === "object" && m.metadata.streaming
      );
      if (stale.length === 0) return msgs.map(toIpcMessage);

      const interruptedAt = Date.now();
      for (const m of stale) {
        const metadata = {
          ...m.metadata,
          streaming: false,
          interrupted: true,
          interruptedAt,
        };
        storageService.addMessage(sessionId, {
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          metadata,
        });
        m.metadata = metadata;
      }
      return msgs.map(toIpcMessage);
    })
  );

  ipcMain.handle(
    "db-get-message-reasoning",
    safeHandler(async (event, messageId) => {
      const storageService = getStorageService();
      const id = String(messageId || "").trim();
      if (!id) return "";
      const reasoning = await storageService.getMessageReasoningAsync(id);
      if (reasoning) return reasoning;
      const message = await storageService.getMessageByIdAsync(id);
      if (!message || !message.content) return "";
      return storageService.extractLegacyThinking(message.content).reasoning;
    })
  );

  ipcMain.handle(
    "db-add-message",
    safeHandler((event, { id, sessionId, role, content, metadata, reasoning }) =>
      getStorageService().addMessage(sessionId, { id, role, content, metadata, reasoning })
    )
  );

  ipcMain.handle(
    "db-delete-messages-after",
    safeHandler((event, { sessionId, timestamp }) =>
      getStorageService().deleteMessagesAfter(sessionId, timestamp)
    )
  );

  ipcMain.handle(
    "get-slash-commands",
    safeHandler((event, { workDir } = {}) => getCommandService().listCommands(workDir))
  );

  ipcMain.handle(
    "spec-list",
    safeHandler((event, { workDir } = {}) => getSpecService().listSpecs(workDir))
  );
  ipcMain.handle(
    "spec-read",
    safeHandler((event, { workDir, id } = {}) => getSpecService().readSpec(workDir, id))
  );
  ipcMain.handle(
    "spec-save",
    safeHandler((event, payload = {}) => getSpecService().saveSpec(payload.workDir, payload))
  );
  ipcMain.handle(
    "spec-update-status",
    safeHandler((event, { workDir, id, status } = {}) =>
      getSpecService().updateSpecStatus(workDir, id, status)
    )
  );
  ipcMain.handle(
    "spec-delete",
    safeHandler((event, { workDir, id } = {}) => getSpecService().deleteSpec(workDir, id))
  );

  ipcMain.handle(
    "get-project-hooks",
    safeHandler(async (event, { workDir } = {}) => {
      const storageService = getStorageService();
      const info = getHookService().listHooks(workDir, {
        projectTrusted: storageService.isProjectHooksTrusted(workDir),
      });
      return {
        ...info,
        enabled: storageService.getConfig("hooks_enabled") !== "false",
        globalExists: await asyncPathExists(info.globalPath),
      };
    })
  );

  ipcMain.handle(
    "create-hooks-template",
    safeHandler(async () => {
      const target = getHookService().hooksFilePath(null, "global");
      if (!(await asyncPathExists(target))) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(
          target,
          JSON.stringify(
            {
              hooks: {
                UserPromptSubmit: [],
                PreToolUse: [],
                PostToolUse: [],
                Stop: [],
              },
              _readme:
                "Hook 配置：command 通过 stdin 接收 JSON，退出码 0 继续，2 阻断；也可输出 {decision:'block',reason,additionalContext}。项目级 hooks 位于 <workDir>/.omcx/hooks.json，需在设置中显式信任。",
            },
            null,
            2
          ),
          "utf-8"
        );
      }
      return { success: true, filePath: target };
    })
  );

  ipcMain.handle(
    "set-project-hooks-trust",
    safeHandler((event, { workDir, trusted } = {}) =>
      getStorageService().setProjectHooksTrust(workDir, Boolean(trusted))
    )
  );

  ipcMain.handle(
    "fork-session",
    safeHandler((event, { sessionId, upToMessageId } = {}) =>
      getSessionTransferService().forkSession(sessionId, { upToMessageId })
    )
  );

  ipcMain.handle(
    "export-session",
    safeHandler(async (event, { sessionId } = {}) => {
      const built = getSessionTransferService().buildSessionMarkdown(sessionId);
      if (!built.success) return built;
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win, {
        title: "导出会话为 Markdown",
        defaultPath: built.suggestedFileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      await fsp.writeFile(result.filePath, built.markdown, "utf-8");
      return { success: true, filePath: result.filePath };
    })
  );
}

module.exports = { registerSessionIpc };
