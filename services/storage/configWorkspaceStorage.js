const path = require("path");

const DEFAULT_MODELS = [
  {
    id: "gpt-4o",
    name: "GPT-4o (Omni 全能旗舰)",
    provider: "openai",
    model_id: "gpt-4o",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    supports_vision: true,
    context_limit: 128000,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini (轻量极速)",
    provider: "openai",
    model_id: "gpt-4o-mini",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    supports_vision: true,
    context_limit: 128000,
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    model_id: "claude-3-5-sonnet-20241022",
    base_url: "https://api.anthropic.com/v1",
    api_key: "",
    supports_vision: true,
    context_limit: 200000,
  },
  {
    id: "deepseek-coder",
    name: "DeepSeek Coder V2",
    provider: "deepseek",
    model_id: "deepseek-coder",
    base_url: "https://api.deepseek.com/v1",
    api_key: "",
    supports_vision: false,
    context_limit: 128000,
  },
];

function inferVisionSupport(modelId = "") {
  return /gpt-4o|claude-3|gemini|vision|vl|qwen-vl|glm-4v/i.test(modelId);
}

function isModelUsable(model) {
  if (!model || typeof model !== "object") return false;
  const apiKey = String(model.api_key ?? model.apiKey ?? "").trim();
  if (apiKey) return true;
  const provider = String(model.provider || "").trim().toLowerCase();
  if (provider === "ollama") return true;
  const baseUrl = String(model.base_url ?? model.baseUrl ?? "").trim();
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(baseUrl);
}

function selectExplicitLiteModel(models = [], parentModel = {}) {
  const usable = (Array.isArray(models) ? models : []).filter(
    (m) => Boolean(m?.is_lite ?? m?.isLite) && isModelUsable(m)
  );
  if (usable.length === 0) return null;

  const parentProvider = String(parentModel?.provider || "").trim().toLowerCase();
  const parentBase = String(parentModel?.baseUrl ?? parentModel?.base_url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();

  if (parentProvider || parentBase) {
    const sameBackend = usable.find((m) => {
      const mProvider = String(m.provider || "").trim().toLowerCase();
      const mBase = String(m.base_url ?? m.baseUrl ?? "")
        .trim()
        .replace(/\/+$/, "")
        .toLowerCase();
      return (
        (parentProvider && mProvider && mProvider === parentProvider) ||
        (parentBase && mBase && mBase === parentBase)
      );
    });
    if (sameBackend) return sameBackend;
  }

  return usable[0];
}

function createConfigWorkspaceStorage({
  memoryConfigs,
  isMemoryOnlyMode,
  getFallbackDb,
  sendToWorker,
}) {
  function getAllConfig() {
    const result = {};
    for (const [k, v] of memoryConfigs.entries()) {
      result[k] = v;
    }
    return result;
  }

  function getConfig(key) {
    if (memoryConfigs.has(key)) {
      return memoryConfigs.get(key);
    }
    // 内存未命中兜底
    if (isMemoryOnlyMode()) return null;
    try {
      const db = getFallbackDb();
      if (!db) return null;
      const row = db.prepare("SELECT value FROM configs WHERE key = ?").get(key);
      if (!row || row.value === null) return null;
      let parsed;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = row.value;
      }
      memoryConfigs.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  function setConfig(key, value) {
    memoryConfigs.set(key, value);
    sendToWorker("SET_CONFIG", { key, value });
    return true;
  }

  function getModels() {
    const models = getConfig("llm_models");
    if (Array.isArray(models) && models.length > 0) {
      return models;
    }
    setConfig("llm_models", DEFAULT_MODELS);
    return DEFAULT_MODELS;
  }

  function addModel(model) {
    const models = getModels();
    const idx = models.findIndex((m) => m.id === model.id);
    const now = Date.now();
    const safeModel = {
      id: model.id || `model_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name: model.name || model.id || "未命名模型",
      provider: model.provider || "openai",
      model_id: model.model_id || model.id,
      base_url: model.base_url || "https://api.openai.com/v1",
      api_key: model.api_key || "",
      supports_vision: model.supports_vision ?? inferVisionSupport(model.model_id || model.id),
      is_lite: Boolean(model.is_lite ?? model.isLite),
      context_limit: Number(model.context_limit) || 128000,
      max_output_tokens: Number(model.max_output_tokens) || 8192,
      input_price: Number(model.input_price) || 0,
      output_price: Number(model.output_price) || 0,
      cache_read_price: Number(model.cache_read_price) || 0,
      cache_write_price: Number(model.cache_write_price) || 0,
    };

    if (idx >= 0) {
      models[idx] = safeModel;
    } else {
      models.push(safeModel);
    }
    setConfig("llm_models", models);
    return { success: true, model: safeModel };
  }

  function deleteModel(id) {
    const models = getModels();
    const filtered = models.filter((m) => m.id !== id);
    setConfig("llm_models", filtered);
    return { success: true };
  }

  function getWorkspaces() {
    const list = getConfig("workspaces");
    if (Array.isArray(list) && list.length > 0) {
      return list;
    }
    const defaultWs = [
      {
        id: "ws_default_omcx",
        name: "OMCX 核心研发空间",
        folders: [
          {
            path: process.cwd(),
            name: path.basename(process.cwd()) || "omcx",
            isPrimary: true,
          },
        ],
        updatedAt: Date.now(),
      },
    ];
    setConfig("workspaces", defaultWs);
    return defaultWs;
  }

  function saveWorkspace(ws) {
    const list = getWorkspaces();
    const idx = list.findIndex((w) => w.id === ws.id);
    const now = Date.now();
    const item = {
      id: ws.id || `ws_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name: ws.name || "新工作空间",
      folders: Array.isArray(ws.folders) ? ws.folders : [],
      updatedAt: now,
    };

    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.unshift(item);
    }
    setConfig("workspaces", list);
    return { success: true, workspace: item };
  }

  function deleteWorkspace(id) {
    const list = getWorkspaces();
    const filtered = list.filter((w) => w.id !== id);
    setConfig("workspaces", filtered);
    return { success: true };
  }

  /**
   * 按指定 ID 顺序重排工作空间并持久化；未包含在 orderedIds 中的项保持原相对顺序追加在末尾。
   * @param {string[]} orderedIds
   */
  function reorderWorkspaces(orderedIds) {
    const list = getWorkspaces();
    if (!Array.isArray(orderedIds) || orderedIds.length === 0 || list.length <= 1) {
      return { success: true, workspaces: list };
    }

    const byId = new Map(list.map((w) => [w.id, w]));
    const seen = new Set();
    const reordered = [];

    for (const id of orderedIds) {
      if (typeof id !== "string" || seen.has(id)) continue;
      const item = byId.get(id);
      if (item) {
        reordered.push(item);
        seen.add(id);
      }
    }

    for (const item of list) {
      if (!seen.has(item.id)) {
        reordered.push(item);
      }
    }

    setConfig("workspaces", reordered);
    return { success: true, workspaces: reordered };
  }

  function getRecentProjects() {
    const list = getConfig("recent_projects");
    if (Array.isArray(list) && list.length > 0) {
      return list;
    }
    return [
      { id: "p1", name: "notifycenter", path: "/opt/projects/notifycenter", hasChanges: true, isLoading: true },
      { id: "p2", name: "silence-fastapi", path: "/opt/projects/silence-fastapi", hasChanges: false, isLoading: false },
      { id: "p3", name: "alarmcenter-fastapi", path: "/opt/projects/alarmcenter-fastapi", hasChanges: false, isLoading: false },
    ];
  }

  function addRecentProject(proj) {
    const list = getRecentProjects().filter((p) => p.path !== proj.path);
    list.unshift(proj);
    if (list.length > 20) list.pop();
    setConfig("recent_projects", list);
    return list;
  }

  return {
    getAllConfig,
    getConfig,
    setConfig,
    getModels,
    addModel,
    deleteModel,
    getWorkspaces,
    saveWorkspace,
    deleteWorkspace,
    reorderWorkspaces,
    getRecentProjects,
    addRecentProject,
  };
}

module.exports = {
  DEFAULT_MODELS,
  inferVisionSupport,
  isModelUsable,
  selectExplicitLiteModel,
  createConfigWorkspaceStorage,
};
