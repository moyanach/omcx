const { ipcMain, dialog, shell } = require("electron");
const {
  safeHandler,
  isSafeExternalUrl,
  getMainWindow,
  getModelConfig,
  getWorkspaceFolders,
  getStorageService,
  getMcpClientService,
  getMcpOAuthService,
  getSkillMarketService,
  getSubagentService,
  getRepoIndexService,
  getRepoWikiService,
  getToolRegistry,
  getContextBuilder,
  getContextCalculator,
} = require("../shared");

function registerMcpSkillsIpc() {
  ipcMain.handle(
    "get-mcp-servers",
    safeHandler((event, workDir) => getStorageService().getMcpServers(workDir))
  );

  ipcMain.handle(
    "save-mcp-servers",
    safeHandler((event, servers) => {
      const saved = getStorageService().saveGlobalMcpServers(servers);
      getMcpClientService().reloadClients();
      return saved;
    })
  );

  ipcMain.handle(
    "trust-project-mcp",
    safeHandler((event, { workDir, trusted } = {}) => {
      const result = getStorageService().setProjectMcpTrust(workDir, Boolean(trusted));
      getMcpClientService().reloadClients();
      return result;
    })
  );

  ipcMain.handle(
    "toggle-mcp-server",
    safeHandler((event, { id, enabled } = {}) => {
      if (!id) return { success: false, error: "缺少服务器 ID" };
      const storageService = getStorageService();
      const globalServers = storageService.getMcpServers(null);
      const nextMap = {};
      for (const server of globalServers) {
        nextMap[server.id] = {
          command: server.command,
          args: server.args,
          env: server.env,
          url: server.url,
          transport: server.transport,
          headers: server.headers,
          authToken: server.authToken,
          disabledTools: server.disabledTools,
          description: server.description,
          enabled: server.id === id ? Boolean(enabled) : server.enabled,
        };
      }
      if (!nextMap[id]) return { success: false, error: "未找到该全局 MCP 服务器" };
      storageService.saveGlobalMcpServers(nextMap);
      getMcpClientService().reloadClients();
      return { success: true };
    })
  );

  ipcMain.handle(
    "delete-mcp-server",
    safeHandler((event, { id } = {}) => {
      const result = getStorageService().deleteGlobalMcpServer(id);
      if (result?.success) getMcpClientService().reloadClients();
      return result;
    })
  );

  ipcMain.handle(
    "get-mcp-tools",
    safeHandler((event, { serverId, workDir } = {}) =>
      getMcpClientService().getServerTools(serverId, workDir)
    )
  );

  ipcMain.handle(
    "toggle-mcp-tool",
    safeHandler((event, { serverId, toolName, enabled, workDir } = {}) => {
      if (!serverId || !toolName) {
        return { success: false, error: "缺少服务器或工具名称" };
      }
      const storageService = getStorageService();
      const allServers = storageService.getMcpServers(workDir);
      const target = allServers.find((server) => server.id === serverId);
      if (!target) return { success: false, error: "未找到该 MCP 服务器" };
      if (target.source === "project") {
        return {
          success: false,
          error: "项目级 MCP 的工具权限请直接编辑项目 .omcx/mcp.json",
        };
      }

      const globalServers = storageService.getMcpServers(null);
      const nextMap = {};
      for (const server of globalServers) {
        const disabled = new Set(
          Array.isArray(server.disabledTools) ? server.disabledTools : []
        );
        if (server.id === serverId) {
          if (enabled) disabled.delete(toolName);
          else disabled.add(toolName);
        }
        nextMap[server.id] = {
          command: server.command,
          args: server.args,
          env: server.env,
          url: server.url,
          transport: server.transport,
          headers: server.headers,
          authToken: server.authToken,
          disabledTools: Array.from(disabled),
          description: server.description,
          enabled: server.enabled,
        };
      }
      storageService.saveGlobalMcpServers(nextMap);
      getMcpClientService().reloadClients();
      return { success: true, disabledTools: nextMap[serverId]?.disabledTools || [] };
    })
  );

  ipcMain.handle(
    "list-mcp-resources",
    safeHandler((event, workDir) => getMcpClientService().listResources(workDir))
  );

  ipcMain.handle(
    "read-mcp-resource",
    safeHandler((event, { uri, workDir } = {}) =>
      getMcpClientService().readResource(uri, workDir)
    )
  );

  ipcMain.handle(
    "list-mcp-prompts",
    safeHandler((event, { workDir } = {}) => getMcpClientService().listPrompts(workDir))
  );

  ipcMain.handle(
    "get-mcp-prompt",
    safeHandler((event, { serverId, promptName, args, workDir } = {}) =>
      getMcpClientService().getPrompt(serverId, promptName, args, workDir)
    )
  );

  ipcMain.handle(
    "mcp-oauth-status",
    safeHandler((event, { workDir } = {}) => {
      const mcpOAuthService = getMcpOAuthService();
      return getStorageService()
        .getMcpServers(workDir)
        .filter((server) => server.url)
        .map((server) => ({
          serverId: server.id,
          ...mcpOAuthService.getStatus(server),
        }));
    })
  );

  ipcMain.handle(
    "mcp-oauth-authorize",
    safeHandler(async (event, { serverId, workDir } = {}) => {
      const server = getStorageService()
        .getMcpServers(workDir)
        .find((item) => item.id === serverId);
      if (!server) return { success: false, error: `MCP 服务器不存在: ${serverId}` };
      const result = await getMcpOAuthService().authorize(server, {
        openExternal: (url) => {
          if (!isSafeExternalUrl(url)) {
            throw new Error(`已拦截不安全的 OAuth 跳转协议: ${String(url || "").slice(0, 64)}`);
          }
          return shell.openExternal(url);
        },
      });
      if (result.success) getMcpClientService().reloadClients();
      return result;
    })
  );

  ipcMain.handle(
    "mcp-oauth-logout",
    safeHandler((event, { serverId, workDir } = {}) => {
      const server = getStorageService()
        .getMcpServers(workDir)
        .find((item) => item.id === serverId);
      if (!server) return { success: false, error: `MCP 服务器不存在: ${serverId}` };
      const result = getMcpOAuthService().logout(server);
      getMcpClientService().reloadClients();
      return result;
    })
  );

  ipcMain.handle(
    "get-skills",
    safeHandler((event, payload) => {
      const workDir =
        typeof payload === "string" ? payload : payload?.workDir || null;
      const includeDisabled =
        payload && typeof payload === "object" ? Boolean(payload.includeDisabled) : false;
      return getStorageService().getSkills(workDir, { includeDisabled });
    })
  );

  ipcMain.handle(
    "toggle-skill",
    safeHandler((event, { name, enabled } = {}) =>
      getStorageService().setSkillEnabled(name, Boolean(enabled))
    )
  );

  ipcMain.handle(
    "delete-skill",
    safeHandler((event, { filePath, workDir } = {}) =>
      getStorageService().deleteSkill({ filePath, workDir })
    )
  );

  ipcMain.handle(
    "import-skill",
    safeHandler(async (event, { mode = "file", sourcePath, overwrite = false, workDir, scope } = {}) => {
      let target = sourcePath;
      if (!target) {
        const result = await dialog.showOpenDialog(getMainWindow(), {
          title: mode === "folder" ? "选择技能文件夹" : "选择技能文件（.md / .zip）",
          properties: mode === "folder" ? ["openDirectory"] : ["openFile"],
          filters:
            mode === "folder"
              ? undefined
              : [{ name: "技能文件", extensions: ["md", "zip"] }],
        });
        if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
        target = result.filePaths[0];
      }
      const resolvedScope = scope === "project" ? "project" : "global";
      return getStorageService().importSkill(target, {
        overwrite: Boolean(overwrite),
        workDir: resolvedScope === "project" ? workDir : null,
        scope: resolvedScope,
      });
    })
  );

  ipcMain.handle(
    "fetch-skill-market",
    safeHandler((event, payload = {}) =>
      getSkillMarketService().fetchMarketPage({
        url: payload.url,
        page: payload.page,
        pageSize: payload.pageSize,
        query: payload.query,
      })
    )
  );

  ipcMain.handle(
    "install-market-skill",
    safeHandler((event, { item, overwrite = false } = {}) =>
      getSkillMarketService().installSkill(item, { overwrite: Boolean(overwrite) })
    )
  );

  ipcMain.handle(
    "get-subagents",
    safeHandler((event, workDir) => getSubagentService().discoverSubagents(workDir || null))
  );

  ipcMain.handle(
    "get-memories",
    safeHandler((event, workDir) => getStorageService().getMemories(workDir))
  );

  ipcMain.handle(
    "get-session-outputs",
    safeHandler((event, sessionId) => getStorageService().getSessionOutputsAsync(sessionId))
  );

  ipcMain.handle(
    "get-repo-index-stats",
    safeHandler((event, { workDir, refresh } = {}) =>
      getRepoIndexService().getRepoStats(workDir, { force: Boolean(refresh) })
    )
  );

  ipcMain.handle(
    "get-repo-map",
    safeHandler((event, { workDir, maxChars, refresh } = {}) =>
      getRepoIndexService().buildRepoMap(workDir, {
        maxChars: Number(maxChars) || 6000,
        force: Boolean(refresh),
      })
    )
  );

  ipcMain.handle(
    "search-repo-symbols",
    safeHandler((event, { workDir, query, limit } = {}) =>
      getRepoIndexService().searchSymbols(workDir, query, { limit: Number(limit) || 40 })
    )
  );

  ipcMain.handle(
    "get-repo-wiki",
    safeHandler((event, workDir) => getRepoWikiService().getRepoWiki(workDir))
  );

  ipcMain.handle(
    "generate-repo-wiki",
    safeHandler(async (event, { workDir, model } = {}) => {
      const storageService = getStorageService();
      const session = storageService
        .getSessions()
        .find((item) => item.workDir === workDir || item.work_dir === workDir);
      const modelId = model || session?.model || storageService.getConfig("default_model");
      const cfg = getModelConfig(modelId, "gpt-4o");
      if (!cfg.modelApiKey && cfg.provider !== "ollama") {
        return { success: false, error: "请先在【设置】中为当前模型配置 API Key" };
      }
      return getRepoWikiService().generateRepoWiki({
        workDir,
        modelConfig: {
          provider: cfg.provider,
          base_url: cfg.modelBaseUrl,
          api_key: cfg.modelApiKey,
          model_id: cfg.apiModelId,
          max_output_tokens: cfg.maxOutputTokens,
        },
      });
    })
  );

  ipcMain.handle(
    "get-context-metrics",
    safeHandler(async (event, params = {}) => {
      const { calculateContextMetrics } = getContextCalculator();
      if (params.sessionId || params.workDir) {
        const storageService = getStorageService();
        const toolRegistry = getToolRegistry();
        const { buildSystemContext, getGitSnapshotAsync } = getContextBuilder();
        const repoIndexService = getRepoIndexService();

        const session = params.sessionId
          ? storageService.getSessions().find((s) => s.id === params.sessionId)
          : null;
        const targetWorkDir =
          (params.workDir && String(params.workDir).trim()) ||
          session?.workDir ||
          session?.work_dir ||
          null;
        const sessionPermissionMode =
          params.permissionMode || session?.permissionMode || "auto-sandbox";

        const rawMessages =
          Array.isArray(params.messages) && params.messages.length > 0
            ? params.messages
            : params.sessionId
            ? await storageService.getMessagesAsync(params.sessionId)
            : [];

        const { matchedWorkspace } = getWorkspaceFolders(targetWorkDir);
        const availableSkills = storageService.getSkills(targetWorkDir);
        const mcpTools = await getMcpClientService().getActiveMcpTools(targetWorkDir);

        const tools = toolRegistry.getToolDefinitions(mcpTools, null, {
          permissionMode: sessionPermissionMode,
        });

        const toolDocs = toolRegistry.getToolPromptDocs(mcpTools, {
          permissionMode: sessionPermissionMode,
        });

        const memories = storageService.getMemories(targetWorkDir);
        const memoryIndex = storageService.getMemoryIndex(targetWorkDir);
        const projectRules = storageService.getProjectInstructions(targetWorkDir);
        const customSystemPrompt = storageService.getConfig("custom_system_prompt") || "";
        const gitInfo = await getGitSnapshotAsync(targetWorkDir);
        const initialTodos = session?.todos || [];
        const wikiInfo = targetWorkDir ? getRepoWikiService().getRepoWiki(targetWorkDir) : null;
        let repoMapText = "";
        if (targetWorkDir && storageService.getConfig("repo_map_enabled") !== "false") {
          try {
            repoMapText = repoIndexService.buildRepoMap(targetWorkDir, {
              maxChars: Number(storageService.getConfig("repo_map_max_chars")) || 6000,
            });
          } catch (repoErr) {
            console.warn(`[repo-map] 指标计算生成失败: ${repoErr.message}`);
          }
        }

        const modelId =
          params.model ||
          session?.model ||
          storageService.getConfig("active_model") ||
          "";
        const models = storageService.getModels();
        const matchedModel = models.find((m) => m.id === modelId);
        const contextLimit =
          Number(params.maxTokensLimit) ||
          Number(matchedModel?.context_limit) ||
          1000000;

        const builtContext = buildSystemContext({
          workDir: targetWorkDir,
          matchedWorkspace,
          skills: availableSkills,
          memories,
          memoryIndex,
          projectRules,
          repoMap: repoMapText,
          repoWiki: wikiInfo?.exists ? String(wikiInfo.content || "").slice(0, 3500) : "",
          repoWikiPath: wikiInfo?.path || "",
          todos: initialTodos,
          toolDocs,
          model: modelId,
          enableTools: true,
          permissionMode: sessionPermissionMode,
          customSystemPrompt,
          gitInfo,
        });

        const skillsTokens =
          builtContext.sections.find((s) => s.name === "skills")?.tokens || 0;

        return calculateContextMetrics({
          messages: rawMessages,
          tools,
          systemPrompt: builtContext.text,
          skillsTokens,
          maxTokensLimit: contextLimit,
        });
      }

      return calculateContextMetrics(params);
    })
  );
}

module.exports = { registerMcpSkillsIpc };
