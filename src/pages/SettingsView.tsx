import React, { useState, useEffect } from "react";
import {
  Settings as SettingsIcon,
  FolderOpen,
  Save,
  Cpu,
  Trash2,
  Pencil,
  Globe,
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Eye,
  EyeOff,
  Sliders,
  CheckCircle2,
  Layers,
  AlignJustify,
  ArrowLeft,
  Plus,
} from "lucide-react";
import { loadTheme, setTheme as applyThemePersist, type ThemeMode } from "../theme";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";

// 热门服务商预设 (自动预填官方/常用 Base URL)
const PROVIDER_PRESETS: Record<
  string,
  { name: string; baseUrl: string; needKey: boolean; defaultContext: number }
> = {
  deepseek: {
    name: "DeepSeek (深度求索)",
    baseUrl: "https://api.deepseek.com/v1",
    needKey: true,
    defaultContext: 128000,
  },
  openai: {
    name: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    needKey: true,
    defaultContext: 128000,
  },
  siliconflow: {
    name: "硅基流动 (SiliconFlow)",
    baseUrl: "https://api.siliconflow.cn/v1",
    needKey: true,
    defaultContext: 128000,
  },
  ollama: {
    name: "Ollama (本地私有化)",
    baseUrl: "http://localhost:11434/v1",
    needKey: false,
    defaultContext: 128000,
  },
  moonshot: {
    name: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.cn/v1",
    needKey: true,
    defaultContext: 200000,
  },
  zhipu: {
    name: "智谱清言 (GLM)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    needKey: true,
    defaultContext: 128000,
  },
  custom: {
    name: "Custom (自定义 OpenAI 兼容接口)",
    baseUrl: "https://api.openai.com/v1",
    needKey: true,
    defaultContext: 128000,
  },
};

// 最大上下文大小预设
const CONTEXT_LIMIT_OPTIONS = [
  { value: 128000, label: "128k (128,000 tokens - 推荐)" },
  { value: 200000, label: "200k (200,000 tokens - Claude / GLM)" },
  { value: 1000000, label: "1M (1,000,000 tokens - 超长上下文)" },
  { value: 64000, label: "64k (64,000 tokens)" },
  { value: 32000, label: "32k (32,000 tokens)" },
  { value: 16000, label: "16k (16,000 tokens)" },
];

const VISION_MODEL_HINTS = [
  "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5",
  "claude-3", "claude-4", "claude-sonnet", "claude-opus", "claude-haiku",
  "gemini", "glm-4v", "glm-4.5v", "glm-4.6v",
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl",
  "llava", "pixtral", "vision", "internvl", "minicpm-v", "moondream", "yi-vl",
];

const inferVisionSupport = (modelId: string) => {
  const id = String(modelId || "").toLowerCase();
  if (!id) return false;
  return VISION_MODEL_HINTS.some((hint) => id.includes(hint));
};

export interface ModelDraftRow {
  rowId: string;
  modelId: string;
  name: string;
  contextLimit: number;
  supportsVision: boolean;
  isManual: boolean;
}

const createEmptyRow = (defaultContext = 128000): ModelDraftRow => ({
  rowId: `row_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  modelId: "",
  name: "",
  contextLimit: defaultContext,
  supportsVision: false,
  isManual: false,
});

const SettingsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"general" | "models" | "search">("models");

  // 配置状态
  const [savePath, setSavePath] = useState("");

  // 搜索配置状态
  const [searchProvider, setSearchProvider] = useState("duckduckgo");
  const [searchApiKey, setSearchApiKey] = useState("");
  const [searchMaxResults, setSearchMaxResults] = useState("5");

  // Agent 运行最大轮次 (默认 5000)
  const [maxToolRounds, setMaxToolRounds] = useState(5000);

  // 上下文自动压缩配置
  const [autoCompact, setAutoCompact] = useState(true);
  const [compactThreshold, setCompactThreshold] = useState(85);
  const [compactKeepTokens, setCompactKeepTokens] = useState(20000);

  // 全局 Store 状态提取至顶层 (杜绝在条件 JSX 中调用 Hook 导致白屏崩溃)
  const stepDisplayStyle = useChatStore((s) => s.stepDisplayStyle);
  const setStepDisplayStyle = useChatStore((s) => s.setStepDisplayStyle);

  // 模型管理配置状态
  const [models, setModels] = useState<any[]>([]);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);

  // 表单状态
  const [newModelProvider, setNewModelProvider] = useState("deepseek");
  const [newModelBaseUrl, setNewModelBaseUrl] = useState("https://api.deepseek.com/v1");
  const [newModelApiKey, setNewModelApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  // 远程拉取模型状态
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchedRemoteModels, setFetchedRemoteModels] = useState<Array<{ id: string }>>([]);

  // 4, 5, 6, 7 动态模型行列表 (ArrayList)
  const [modelRows, setModelRows] = useState<ModelDraftRow[]>([
    createEmptyRow(PROVIDER_PRESETS.deepseek.defaultContext),
  ]);

  const updateRow = (rowId: string, patch: Partial<ModelDraftRow>) => {
    setModelRows((prev) =>
      prev.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row))
    );
  };

  const addRow = (initialModelId = "") => {
    const defaultCtx =
      PROVIDER_PRESETS[newModelProvider]?.defaultContext || 128000;
    const cleanId = initialModelId.trim();
    const newRow: ModelDraftRow = {
      rowId: `row_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      modelId: cleanId,
      name: cleanId,
      contextLimit: defaultCtx,
      supportsVision: inferVisionSupport(cleanId),
      isManual: !fetchedRemoteModels.length,
    };
    setModelRows((prev) => [...prev, newRow]);
  };

  const removeRow = (rowId: string) => {
    setModelRows((prev) => {
      if (prev.length <= 1) {
        return [createEmptyRow(PROVIDER_PRESETS[newModelProvider]?.defaultContext || 128000)];
      }
      return prev.filter((row) => row.rowId !== rowId);
    });
  };

  // 一键将所有探测到的远程模型追加为待配置行
  const addAllFetchedModels = () => {
    if (!fetchedRemoteModels.length) return;
    const defaultCtx =
      PROVIDER_PRESETS[newModelProvider]?.defaultContext || 128000;
    const existingIds = new Set(
      modelRows.map((r) => r.modelId.trim()).filter(Boolean)
    );

    const newRows: ModelDraftRow[] = [];
    fetchedRemoteModels.forEach((m: any, idx) => {
      const idVal = String(m.id || m.name || m.model || "").trim();
      if (!idVal || existingIds.has(idVal)) return;
      newRows.push({
        rowId: `row_batch_${Date.now()}_${idx}`,
        modelId: idVal,
        name: idVal,
        contextLimit: defaultCtx,
        supportsVision: inferVisionSupport(idVal),
        isManual: false,
      });
    });

    if (newRows.length === 0) {
      showToast("探测到的模型均已在配置列表中");
      return;
    }

    setModelRows((prev) => {
      // 若当前只有一条未填写的空行，直接替换
      if (prev.length === 1 && !prev[0].modelId.trim()) {
        return newRows;
      }
      return [...prev, ...newRows];
    });
    showToast(`已追加 ${newRows.length} 个模型到配置列表`);
  };

  // 主题状态
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>("system");
  const { setTheme: setStoreTheme, setActiveNavTab } = useAppStore();

  // 提示状态
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  };

  const handleSaveSearchConfig = async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.setConfig("search_provider", searchProvider);
      await window.electronAPI.setConfig("search_api_key", searchApiKey.trim());
      await window.electronAPI.setConfig("search_max_results", searchMaxResults);
      showToast("搜索配置保存成功");
    } catch {
      showToast("配置保存失败");
    }
  };

  const loadModels = async () => {
    if (window.electronAPI && window.electronAPI.dbGetModels) {
      const list = await window.electronAPI.dbGetModels();
      setModels(list);
    }
  };

  // 编辑已有模型 (单行模式)
  const handleEditModel = (model: any) => {
    setEditingModelId(model.id);
    setNewModelProvider(model.provider || "custom");
    setNewModelBaseUrl(model.base_url || model.baseUrl || "");
    setNewModelApiKey(model.api_key || model.apiKey || "");
    setFetchedRemoteModels([]);
    setModelRows([
      {
        rowId: `row_edit_${model.id}`,
        modelId: model.model_id || model.modelId || "",
        name: model.name || "",
        contextLimit: model.context_limit || model.contextLimit || 128000,
        supportsVision: !!model.supports_vision,
        isManual: true,
      },
    ]);
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditingModelId(null);
    setNewModelProvider("deepseek");
    setNewModelBaseUrl(PROVIDER_PRESETS.deepseek.baseUrl);
    setNewModelApiKey("");
    setFetchedRemoteModels([]);
    setModelRows([createEmptyRow(PROVIDER_PRESETS.deepseek.defaultContext)]);
  };

  // 切换服务商厂商
  const handleProviderChange = (providerKey: string) => {
    setNewModelProvider(providerKey);
    const preset = PROVIDER_PRESETS[providerKey];
    if (preset) {
      setNewModelBaseUrl(preset.baseUrl);
      setModelRows((prev) =>
        prev.map((row) => ({ ...row, contextLimit: preset.defaultContext }))
      );
    }
    setFetchedRemoteModels([]);
  };

  // 【获取所有模型】按钮处理逻辑 (动态远程探测)
  const handleFetchRemoteModels = async () => {
    if (!newModelBaseUrl.trim()) {
      showToast("请先填写 Base URL");
      return;
    }
    const preset = PROVIDER_PRESETS[newModelProvider];
    if (preset?.needKey && !newModelApiKey.trim()) {
      showToast("请先填写 API Key 才能获取模型列表");
      return;
    }

    setIsFetchingModels(true);
    try {
      if (window.electronAPI?.apiGetModels) {
        const list = await window.electronAPI.apiGetModels({
          baseUrl: newModelBaseUrl.trim(),
          apiKey: newModelApiKey.trim(),
        });
        if (Array.isArray(list) && list.length > 0) {
          setFetchedRemoteModels(list);
          const first = list[0].id || (list[0] as any).name || (list[0] as any).model;

          // 若当前仅有一行且尚未输入模型 ID，自动以首个模型初始化该行
          setModelRows((prev) => {
            if (prev.length === 1 && !prev[0].modelId.trim() && first) {
              return [
                {
                  ...prev[0],
                  modelId: first,
                  name: first,
                  supportsVision: inferVisionSupport(first),
                  isManual: false,
                },
              ];
            }
            return prev.map((r) => ({ ...r, isManual: false }));
          });

          showToast(`成功探测并拉取到 ${list.length} 个可用模型！`);
        } else {
          showToast("未检测到模型列表，已切换为手动输入模式");
          setModelRows((prev) => prev.map((r) => ({ ...r, isManual: true })));
        }
      }
    } catch (err: any) {
      showToast(`获取失败: ${err.message || "连接超时"}`);
      setModelRows((prev) => prev.map((r) => ({ ...r, isManual: true })));
    } finally {
      setIsFetchingModels(false);
    }
  };

  // 添加/更新模型配置 (支持批量保存与单条编辑)
  const handleAddModel = async () => {
    if (!newModelBaseUrl.trim()) {
      showToast("Base URL 不能为空");
      return;
    }

    const validRows = modelRows.filter((r) => r.modelId.trim());
    if (validRows.length === 0) {
      showToast("请至少填写或选择一个模型 ID");
      return;
    }

    if (!window.electronAPI?.dbAddModel) return;

    if (editingModelId) {
      // 1. 编辑单条模型
      const target = validRows[0];
      const modelPayload = {
        id: editingModelId,
        model_id: target.modelId.trim(),
        modelId: target.modelId.trim(),
        name: target.name.trim() || target.modelId.trim(),
        type: "chat",
        provider: newModelProvider,
        base_url: newModelBaseUrl.trim(),
        baseUrl: newModelBaseUrl.trim(),
        api_key: newModelApiKey.trim(),
        apiKey: newModelApiKey.trim(),
        context_limit: target.contextLimit,
        supports_vision: target.supportsVision,
      };

      await window.electronAPI.dbAddModel(modelPayload as any);
      handleCancelEdit();
      showToast("模型配置已成功更新！");
    } else {
      // 2. 批量保存 N 条模型行
      for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        const rowKey = `model_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
        const modelPayload = {
          id: rowKey,
          model_id: row.modelId.trim(),
          modelId: row.modelId.trim(),
          name: row.name.trim() || row.modelId.trim(),
          type: "chat",
          provider: newModelProvider,
          base_url: newModelBaseUrl.trim(),
          baseUrl: newModelBaseUrl.trim(),
          api_key: newModelApiKey.trim(),
          apiKey: newModelApiKey.trim(),
          context_limit: row.contextLimit,
          supports_vision: row.supportsVision,
        };
        await window.electronAPI.dbAddModel(modelPayload as any);
      }

      handleCancelEdit();
      showToast(`成功保存并生效 ${validRows.length} 个模型配置！`);
    }

    await loadModels();
    // 全局即时广播通知 Agent 会话界面
    await useChatStore.getState().fetchModels();
  };

  // 删除模型
  const handleDeleteModel = async (id: string) => {
    if (window.electronAPI?.dbDeleteModel) {
      await window.electronAPI.dbDeleteModel(id);
      showToast("模型已删除");
      await loadModels();
      await useChatStore.getState().fetchModels();
    }
  };

  // 初始加载配置
  useEffect(() => {
    const loadConfigs = async () => {
      if (!window.electronAPI) return;
      const savedPath = await window.electronAPI.getConfig("save_path");
      if (savedPath) setSavePath(savedPath);

      const provider = await window.electronAPI.getConfig("search_provider");
      if (provider) setSearchProvider(provider);

      const apiKey = await window.electronAPI.getConfig("search_api_key");
      if (apiKey) setSearchApiKey(apiKey);

      const maxResults = await window.electronAPI.getConfig("search_max_results");
      if (maxResults) setSearchMaxResults(maxResults);

      const savedRounds = await window.electronAPI.getConfig("max_tool_rounds");
      if (savedRounds) setMaxToolRounds(Number(savedRounds) || 5000);

      const savedAutoCompact = await window.electronAPI.getConfig("context_auto_compact");
      if (savedAutoCompact !== null) setAutoCompact(savedAutoCompact !== "false");

      const savedThreshold = await window.electronAPI.getConfig("context_compact_threshold_percent");
      if (savedThreshold) setCompactThreshold(Number(savedThreshold) || 85);

      const savedKeepTokens = await window.electronAPI.getConfig("context_compact_keep_tokens");
      if (savedKeepTokens) setCompactKeepTokens(Number(savedKeepTokens) || 20000);

      const savedTheme = await loadTheme();
      setCurrentTheme(savedTheme);
      setStoreTheme(savedTheme);
    };
    loadConfigs();
    loadModels();
  }, []);

  const handleSelectPath = async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.selectSaveDirectory();
    if (path) {
      setSavePath(path);
      showToast("默认输出路径已更新");
    }
  };

  const handleSaveMaxToolRounds = async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.setConfig("max_tool_rounds", String(maxToolRounds));
      showToast(`最大执行轮次已更新为 ${maxToolRounds} 轮`);
    } catch {
      showToast("保存失败");
    }
  };

  const handleSaveContextConfig = async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.setConfig("context_auto_compact", autoCompact ? "true" : "false");
      await window.electronAPI.setConfig(
        "context_compact_threshold_percent",
        String(compactThreshold)
      );
      await window.electronAPI.setConfig("context_compact_keep_tokens", String(compactKeepTokens));
      showToast("上下文压缩配置已保存");
    } catch {
      showToast("保存失败");
    }
  };

  return (
    <div className="flex h-full w-full bg-[#161616] overflow-hidden select-none flex-col">
      {/* Toast 提示 */}
      <div
        className={`fixed top-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl shadow-2xl transition-all duration-300 z-50 ${
          toastMsg ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4 pointer-events-none"
        }`}
      >
        <CheckCircle2 size={16} />
        <span className="text-xs font-medium">{toastMsg}</span>
      </div>

      {/* 顶部 Header：仅保留左侧标题与返回按钮 */}
      <div className="h-12 border-b border-[#242424] bg-[#141414] px-5 flex items-center justify-between flex-shrink-0 titlebar-drag">
        <div className="flex items-center gap-2 text-neutral-100 font-semibold text-xs tracking-wide">
          <button
            onClick={() => setActiveNavTab("sessions")}
            className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors titlebar-no-drag"
            title="返回会话"
          >
            <ArrowLeft size={15} />
          </button>
          <SettingsIcon size={16} className="text-blue-400" />
          <span>系统设置</span>
        </div>
      </div>

      {/* 内容展示区 (居中自适应展开) */}
      <div className="flex-1 overflow-y-auto p-6 custom-scrollbar flex justify-center">
        <div className="w-full max-w-4xl space-y-6">
          {/* 内容区顶部的 Tab 切换器 (置于渲染内容右上角) */}
          <div className="flex items-center justify-between border-b border-[#242424] pb-4">
            <div>
              <h2 className="text-sm font-bold text-neutral-100">
                {activeTab === "models" && "大模型服务商与模型配置"}
                {activeTab === "search" && "联网搜索引擎与网页抓取"}
                {activeTab === "general" && "通用设置、外观主题与上下文"}
              </h2>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                {activeTab === "models" && "配置 OpenAI 兼容模型、专属 API Key、上下文上限与视觉输入能力"}
                {activeTab === "search" && "配置联网搜索提供商、密钥与单次最多检索条数"}
                {activeTab === "general" && "外观主题、Agent 最大执行轮次与长对话上下文自动压缩"}
              </p>
            </div>

            {/* 三 Tab 切换器 */}
            <div className="flex items-center gap-1.5 bg-[#181818] p-1 rounded-xl border border-[#282828] flex-shrink-0">
              <button
                onClick={() => setActiveTab("models")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === "models"
                    ? "bg-blue-600 text-white font-medium shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]"
                }`}
              >
                <Cpu size={14} />
                <span>模型配置</span>
              </button>
              <button
                onClick={() => setActiveTab("search")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === "search"
                    ? "bg-blue-600 text-white font-medium shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]"
                }`}
              >
                <Globe size={14} />
                <span>联网搜索</span>
              </button>
              <button
                onClick={() => setActiveTab("general")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === "general"
                    ? "bg-blue-600 text-white font-medium shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]"
                }`}
              >
                <Sliders size={14} />
                <span>通用与外观</span>
              </button>
            </div>
          </div>
            {/* ═════════ 1. 模型配置 TAB (重塑现代化四步操作流) ═════════ */}
            {activeTab === "models" && (
              <div className="space-y-6">
                {/* 模型添加/编辑卡片 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-5 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-[#282828] pb-3">
                    <div className="flex items-center gap-2">
                      <Cpu size={16} className="text-blue-400" />
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide">
                        {editingModelId ? "编辑模型配置" : "添加并配置新模型 (OpenAI 兼容协议)"}
                      </h3>
                    </div>
                    {editingModelId && (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono">
                        正在修改现有模型
                      </span>
                    )}
                  </div>

                  {/* 第一步：选择厂商 (Provider) */}
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-neutral-300">
                      1. 选择模型服务商 (Provider)
                    </label>
                    <select
                      value={newModelProvider}
                      onChange={(e) => handleProviderChange(e.target.value)}
                      className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 transition-all cursor-pointer font-medium"
                    >
                      {Object.entries(PROVIDER_PRESETS).map(([key, item]) => (
                        <option key={key} value={key} className="bg-[#1a1a1a] text-neutral-200">
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 第二步：填 Base URL 与 API Key */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-1">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-neutral-300">
                        2. 接口 Base URL (必填)
                      </label>
                      <input
                        type="text"
                        value={newModelBaseUrl}
                        onChange={(e) => {
                          setNewModelBaseUrl(e.target.value);
                          setFetchedRemoteModels([]);
                        }}
                        placeholder="例如: https://api.deepseek.com/v1"
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 transition-all font-mono"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-neutral-300">
                          3. API Key {newModelProvider === "ollama" ? "(本地免Key)" : "(必填)"}
                        </label>
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="text-[10px] text-neutral-500 hover:text-neutral-300 flex items-center gap-1"
                        >
                          {showApiKey ? <EyeOff size={11} /> : <Eye size={11} />}
                          <span>{showApiKey ? "隐藏" : "显示"}</span>
                        </button>
                      </div>
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={newModelApiKey}
                        onChange={(e) => {
                          setNewModelApiKey(e.target.value);
                          setFetchedRemoteModels([]);
                        }}
                        placeholder={newModelProvider === "ollama" ? "本地服务无需填写" : "sk-..."}
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 transition-all font-mono"
                      />
                    </div>
                  </div>

                  {/* 第三步：【获取所有模型】按钮与模型快速探测 */}
                  <div className="p-3.5 rounded-xl bg-[#181818] border border-[#292929] space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <Sliders size={13} className="text-blue-400" />
                        <span className="text-xs font-semibold text-neutral-200">
                          3. 探测服务商提供的可用模型
                        </span>
                        {fetchedRemoteModels.length > 0 && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            已发现 {fetchedRemoteModels.length} 个可用模型
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {fetchedRemoteModels.length > 0 && !editingModelId && (
                          <button
                            type="button"
                            onClick={addAllFetchedModels}
                            className="px-2.5 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-200 text-xs font-medium border border-[#383838] transition-colors"
                            title="将所有探测到的模型批量追加到下方列表中"
                          >
                            批量导入全部模型
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleFetchRemoteModels}
                          disabled={isFetchingModels}
                          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
                        >
                          <RefreshCw size={12} className={isFetchingModels ? "animate-spin" : ""} />
                          <span>{isFetchingModels ? "正在拉取模型..." : "获取所有模型"}</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* ═════════ 4, 5, 6, 7 动态模型配置行列表 (ArrayList) ═════════ */}
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-neutral-200 tracking-wide">
                          4, 5, 6, 7 模型参数清单 ({modelRows.length} 条待生效)
                        </span>
                        <span className="text-[11px] text-neutral-500">
                          每行对应一个独立模型，可分别设置模型 ID、显示名称、上下文与视觉
                        </span>
                      </div>
                      {!editingModelId && (
                        <button
                          type="button"
                          onClick={() => addRow("")}
                          className="px-2.5 py-1 rounded-lg bg-[#222222] hover:bg-[#2b2b2b] text-blue-400 text-xs font-medium flex items-center gap-1 border border-[#303030] transition-colors"
                        >
                          <Plus size={13} />
                          <span>添加一行模型</span>
                        </button>
                      )}
                    </div>

                    {/* 模型卡片数组 */}
                    <div className="space-y-3">
                      {modelRows.map((row, index) => (
                        <div
                          key={row.rowId}
                          className="p-4 rounded-xl bg-[#171717] border border-[#2b2b2b] space-y-3 relative group"
                        >
                          <div className="flex items-center justify-between border-b border-[#242424] pb-2">
                            <span className="text-[11px] font-mono font-semibold text-neutral-300 flex items-center gap-1.5">
                              <span className="w-4 h-4 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-[10px]">
                                {index + 1}
                              </span>
                              <span>模型 #{index + 1} 配置</span>
                            </span>

                            {!editingModelId && modelRows.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeRow(row.rowId)}
                                className="p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                                title="删除此模型配置行"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>

                          {/* 第 1 行：4. 模型 ID + 5. 显示名称 */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-xs font-medium text-neutral-300">
                                  4. 模型 ID (Model ID)
                                </label>
                                {fetchedRemoteModels.length > 0 && !editingModelId && (
                                  <button
                                    type="button"
                                    onClick={() => updateRow(row.rowId, { isManual: !row.isManual })}
                                    className="text-[10px] text-blue-400 hover:text-blue-300"
                                  >
                                    {row.isManual ? "选择已拉取列表" : "手动输入"}
                                  </button>
                                )}
                              </div>

                              {fetchedRemoteModels.length > 0 && !row.isManual ? (
                                <select
                                  value={row.modelId}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    updateRow(row.rowId, {
                                      modelId: val,
                                      name: row.name === row.modelId || !row.name ? val : row.name,
                                      supportsVision: inferVisionSupport(val),
                                    });
                                  }}
                                  className="w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-100 outline-none focus:border-blue-500 font-mono cursor-pointer"
                                >
                                  <option value="" disabled className="bg-[#1c1c1c] text-neutral-500">
                                    -- 请选择探测到的模型 --
                                  </option>
                                  {fetchedRemoteModels.map((m: any, idx) => {
                                    const idVal = m.id || m.name || m.model || String(m);
                                    return (
                                      <option key={`${idVal}-${idx}`} value={idVal} className="bg-[#1c1c1c]">
                                        {idVal}
                                      </option>
                                    );
                                  })}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={row.modelId}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    updateRow(row.rowId, {
                                      modelId: val,
                                      name: row.name === row.modelId || !row.name ? val : row.name,
                                      supportsVision: inferVisionSupport(val),
                                    });
                                  }}
                                  placeholder="例如: deepseek-chat, gpt-4o, qwen2.5-coder:32b"
                                  className="w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-mono"
                                />
                              )}
                            </div>

                            <div className="space-y-1">
                              <label className="text-xs font-medium text-neutral-300">
                                5. 显示名称 (Display Name)
                              </label>
                              <input
                                type="text"
                                value={row.name}
                                onChange={(e) => updateRow(row.rowId, { name: e.target.value })}
                                placeholder="例如: DeepSeek V3 官方, 我的 GPT-4o"
                                className="w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-sans"
                              />
                            </div>
                          </div>

                          {/* 第 2 行：6. 最大上下文大小 + 7. 视觉支持开关 */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-neutral-300">
                                6. 最大上下文大小 (Context Limit)
                              </label>
                              <select
                                value={row.contextLimit}
                                onChange={(e) => updateRow(row.rowId, { contextLimit: Number(e.target.value) })}
                                className="w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 cursor-pointer font-sans"
                              >
                                {CONTEXT_LIMIT_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value} className="bg-[#1c1c1c]">
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="flex items-end">
                              <label className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-[#141414] border border-[#2e2e2e] cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={row.supportsVision}
                                  onChange={(e) => updateRow(row.rowId, { supportsVision: e.target.checked })}
                                  className="accent-blue-600 cursor-pointer"
                                />
                                <div className="flex flex-col">
                                  <span className="text-xs font-medium text-neutral-200">
                                    7. 支持图片输入 (Vision)
                                  </span>
                                  <span className="text-[10px] text-neutral-500">
                                    向该模型输入图片时生效
                                  </span>
                                </div>
                              </label>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {!editingModelId && (
                      <button
                        type="button"
                        onClick={() => addRow("")}
                        className="w-full py-2.5 rounded-xl border border-dashed border-[#333333] hover:border-blue-500/50 hover:bg-white/[0.02] text-xs text-neutral-400 hover:text-blue-400 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <Plus size={14} />
                        <span>添加一行新模型配置</span>
                      </button>
                    )}
                  </div>

                  {/* 保存与取消按钮 */}
                  <div className="pt-3 flex justify-end gap-2.5 border-t border-[#262626]">
                    {editingModelId && (
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="px-4 py-2 rounded-xl text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04] text-xs font-semibold transition-colors"
                      >
                        取消编辑
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleAddModel}
                      className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer"
                    >
                      <Save size={13} />
                      <span>
                        {editingModelId
                          ? "更新模型并全局生效"
                          : `保存全部 (${modelRows.filter((r) => r.modelId.trim()).length || modelRows.length}) 个模型配置并生效`}
                      </span>
                    </button>
                  </div>
                </div>

                {/* 2. 已配置模型列表 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-5 shadow-sm space-y-3">
                  <div className="flex items-center justify-between border-b border-[#282828] pb-3">
                    <h3 className="text-xs font-bold text-neutral-100 uppercase tracking-wide">
                      已配置生效的模型列表 ({models.length})
                    </h3>
                    <span className="text-[11px] text-neutral-500">
                      所有此处配置的模型，已在 Agent 会话输入框底部下拉菜单中实时同步
                    </span>
                  </div>

                  <div className="divide-y divide-[#262626] max-h-[300px] overflow-y-auto custom-scrollbar">
                    {models.map((m) => (
                      <div
                        key={m.id}
                        className="py-3 px-2 flex items-center justify-between hover:bg-white/[0.02] rounded-xl transition-colors"
                      >
                        <div className="flex flex-col gap-1 min-w-0 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-xs text-neutral-100">
                              {m.name || m.model_id}
                            </span>
                            <span className="px-2 py-0.2 rounded-full text-[10px] bg-[#272727] text-neutral-400 border border-[#353535] font-mono">
                              {m.provider}
                            </span>
                            <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono">
                              {m.context_limit ? `${m.context_limit / 1000}k` : "128k"}
                            </span>
                            {m.supports_vision && (
                              <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                                视觉
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-[11px] font-mono text-neutral-500 truncate">
                            <span>ID: {m.model_id}</span>
                            <span className="truncate">URL: {m.base_url}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button
                            onClick={() => handleEditModel(m)}
                            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                            title="编辑"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => handleDeleteModel(m.id)}
                            className="p-1.5 rounded-lg text-neutral-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                            title="删除"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ═════════ 2. 搜索配置 TAB ═════════ */}
            {activeTab === "search" && (
              <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-5">
                <h3 className="text-xs font-bold text-neutral-100 tracking-wide border-b border-[#282828] pb-3">
                  联网搜索引擎与正文抓取
                </h3>

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-neutral-300">
                      默认搜索引擎 (提供商)
                    </label>
                    <select
                      value={searchProvider}
                      onChange={(e) => setSearchProvider(e.target.value)}
                      className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-sans"
                    >
                      <option value="duckduckgo">DuckDuckGo (免费 / 免 API Key)</option>
                      <option value="tavily">Tavily (专业 AI 搜索)</option>
                      <option value="mojeek">Mojeek (注重隐私)</option>
                      <option value="google">Google HTML (网页解析)</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-neutral-300">
                      Search API Key (仅 Tavily / Mojeek 需要)
                    </label>
                    <input
                      type="password"
                      value={searchApiKey}
                      onChange={(e) => setSearchApiKey(e.target.value)}
                      placeholder="使用 DuckDuckGo 时留空即可"
                      className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-neutral-300">
                      最大检索结果数
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={searchMaxResults}
                      onChange={(e) => setSearchMaxResults(e.target.value)}
                      className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-mono"
                    />
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      onClick={handleSaveSearchConfig}
                      className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5"
                    >
                      <Save size={13} />
                      <span>保存搜索配置</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ═════════ 3. 通用设置 TAB ═════════ */}
            {activeTab === "general" && (
              <div className="space-y-5">
                {/* 主题设置 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <h3 className="text-xs font-bold text-neutral-100 tracking-wide border-b border-[#282828] pb-3">
                    外观主题
                  </h3>
                  <div className="flex gap-3">
                    {[
                      { value: "light" as const, label: "亮色", icon: Sun },
                      { value: "dark" as const, label: "暗色", icon: Moon },
                      { value: "system" as const, label: "随系统", icon: Monitor },
                    ].map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        onClick={async () => {
                          setCurrentTheme(value);
                          setStoreTheme(value);
                          await applyThemePersist(value);
                          showToast(`已切换为${label}模式`);
                        }}
                        className={`flex-1 flex flex-col items-center gap-2 p-3.5 rounded-xl border-2 transition-all cursor-pointer ${
                          currentTheme === value
                            ? "border-blue-500 bg-blue-500/10 text-blue-400 shadow-sm"
                            : "border-[#2e2e2e] bg-[#171717] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                        }`}
                      >
                        <Icon size={20} />
                        <span className="text-xs font-semibold">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Agent 步骤与调用详情展示风格 (详细 / 简略) */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide">
                        Agent 步骤与调用详情展示风格
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        控制在会话中是否默认展开并呈现每一步调用的入参、命令与返回详情
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    {/* 详细模式 (默认推荐) */}
                    <div
                      onClick={async () => {
                        await setStepDisplayStyle("detailed");
                        showToast("已切换为详细模式：默认展开每一步完整调用详情");
                      }}
                      className={`p-4 rounded-xl border-2 transition-all cursor-pointer flex flex-col gap-2 ${
                        stepDisplayStyle === "detailed"
                          ? "border-blue-500 bg-blue-500/10 text-blue-400 shadow-sm"
                          : "border-[#2e2e2e] bg-[#171717] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Layers size={18} />
                        <span className="font-bold text-xs">详细模式 (Detailed - 默认推荐)</span>
                      </div>
                      <p className="text-[11px] text-neutral-400 leading-relaxed">
                        会话中展开每一步，展示传入的详细参数代码块、执行说明与完整的输出日志。
                      </p>
                    </div>

                    {/* 简略模式 */}
                    <div
                      onClick={async () => {
                        await setStepDisplayStyle("compact");
                        showToast("已切换为简略模式：步骤精炼为单行轻量摘要");
                      }}
                      className={`p-4 rounded-xl border-2 transition-all cursor-pointer flex flex-col gap-2 ${
                        stepDisplayStyle === "compact"
                          ? "border-blue-500 bg-blue-500/10 text-blue-400 shadow-sm"
                          : "border-[#2e2e2e] bg-[#171717] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <AlignJustify size={18} />
                        <span className="font-bold text-xs">简略模式 (Compact)</span>
                      </div>
                      <p className="text-[11px] text-neutral-400 leading-relaxed">
                        仅展示核心操作标题（如修改代码、读取文件）与一行轻量状态，保持对话流轻快极简。
                      </p>
                    </div>
                  </div>
                </div>

                {/* 最大工具调用轮次 (Max Tool Rounds) 设置卡片 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide">
                        Agent 会话最大执行轮次 (Max Tool Rounds)
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        设定 Agent 在单轮用户指令下允许自主调度工具的最大连续轮次上限 (默认 5000 轮)
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={10}
                      max={10000}
                      step={100}
                      value={maxToolRounds}
                      onChange={(e) => setMaxToolRounds(Number(e.target.value) || 5000)}
                      className="w-48 bg-[#171717] border border-[#2e2e2e] rounded-xl px-3.5 py-2 text-xs font-mono text-neutral-200 outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleSaveMaxToolRounds}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5"
                    >
                      <Save size={13} />
                      <span>保存轮次上限</span>
                    </button>
                    <span className="text-[11px] text-neutral-500">
                      足以支持大型工程持续分析、全量编译与持续多文件重构
                    </span>
                  </div>
                </div>

                {/* 上下文自动压缩 (Context Compaction) */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3">
                    <h3 className="text-xs font-bold text-neutral-100 tracking-wide">
                      上下文自动压缩 (Context Compaction)
                    </h3>
                    <p className="text-[11px] text-neutral-500 mt-0.5">
                      接近模型上下文上限时，自动清理旧工具输出并生成结构化摘要；只影响发给模型的请求体，不删除本地会话历史
                    </p>
                  </div>

                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#181818] border border-[#292929] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={autoCompact}
                      onChange={(e) => setAutoCompact(e.target.checked)}
                      className="mt-0.5 accent-blue-600 cursor-pointer"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-neutral-200">启用自动压缩</span>
                      <span className="text-[11px] text-neutral-500">
                        关闭后不再自动压缩，长会话可能触发 provider 的上下文溢出错误
                      </span>
                    </span>
                  </label>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-neutral-300">
                        触发阈值 (%)
                      </label>
                      <input
                        type="number"
                        min={10}
                        max={95}
                        value={compactThreshold}
                        onChange={(e) => setCompactThreshold(Number(e.target.value) || 85)}
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs font-mono text-neutral-200 outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-neutral-300">
                        保留最近 Token 数
                      </label>
                      <input
                        type="number"
                        min={2000}
                        max={200000}
                        step={1000}
                        value={compactKeepTokens}
                        onChange={(e) => setCompactKeepTokens(Number(e.target.value) || 20000)}
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs font-mono text-neutral-200 outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={handleSaveContextConfig}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5"
                    >
                      <Save size={13} />
                      <span>保存压缩配置</span>
                    </button>
                  </div>
                </div>

                {/* Agent 配置文件目录 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-3">
                  <h3 className="text-xs font-bold text-neutral-100 tracking-wide border-b border-[#282828] pb-3">
                    Agent 本地配置根目录 (~/.omcx/)
                  </h3>
                  <p className="text-xs text-neutral-400 leading-relaxed">
                    所有配置完全透明可读，包含 <code>config.json</code>（模型配置）、<code>mcp.json</code>（标准 MCP 服务器）、<code>skills/</code>（自定义技能）与 <code>memory/</code>（长期记忆）。
                  </p>
                  <input
                    type="text"
                    readOnly
                    value="~/.omcx/"
                    className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3.5 py-2 text-neutral-300 font-mono text-xs"
                  />
                </div>

                {/* 文件输出保存目录 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-3">
                  <h3 className="text-xs font-bold text-neutral-100 tracking-wide border-b border-[#282828] pb-3">
                    文件输出默认目录
                  </h3>
                  <div className="flex gap-2.5">
                    <input
                      type="text"
                      readOnly
                      value={savePath || "系统默认下载目录/OMCX"}
                      className="flex-1 bg-[#171717] border border-[#2e2e2e] rounded-xl px-3.5 py-2 text-neutral-400 font-mono text-xs"
                    />
                    <button
                      onClick={handleSelectPath}
                      className="flex items-center gap-1.5 bg-[#252525] hover:bg-[#303030] text-neutral-200 px-3.5 py-2 rounded-xl text-xs font-medium border border-[#353535] transition-colors"
                    >
                      <FolderOpen size={14} />
                      <span>更改目录</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
    </div>
  );
};

export default SettingsView;
