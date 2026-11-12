import React, { useState, useEffect, useRef } from "react";
import {
  Settings as SettingsIcon,
  FolderOpen,
  Save,
  Cpu,
  Trash2,
  Pencil,
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Eye,
  EyeOff,
  Sliders,
  CheckCircle2,
  ArrowLeft,
  Plus,
  ChevronDown,
  Check,
  Image as ImageIcon,
  Sparkles,
  RotateCcw,
  Download,
  ExternalLink,
  AlertCircle,
  ArrowUpCircle,
  Type,
  RotateCw,
  Webhook,
  X,
} from "lucide-react";
import {
  loadTheme,
  setTheme as applyThemePersist,
  getAppearance,
  setAppearance,
  loadAppearance,
  WALLPAPER_PRESETS,
  type ThemeMode,
  type AppearanceConfig,
} from "../theme";
import {
  getFontSettings,
  loadFontSettings,
  resetFontSettings,
  setFontSettings,
  isMonospaceLike,
  buildUiFontFamily,
  buildTerminalFontFamily,
  type FontSettings,
} from "../lib/fontSettings";
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
  anthropic: {
    name: "Anthropic (Claude 原生协议)",
    baseUrl: "https://api.anthropic.com",
    needKey: true,
    defaultContext: 200000,
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
  existingId?: string;
  modelId: string;
  name: string;
  contextLimit: number;
  supportsVision: boolean;
  isManual: boolean;
  maxOutputTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
}

/**
 * 可自由编辑 + 下拉联动选择组合框 (Editable Combobox)
 * - 未拉取模型时：表现为纯输入框
 * - 已拉取模型后：既可展开下拉菜单点选（点选时联动同时修改模型 ID 与显示名称），也可随时在输入框中直接打字编辑
 */
const EditableModelCombobox: React.FC<{
  value: string;
  options: string[];
  placeholder?: string;
  monoFont?: boolean;
  onChange: (val: string) => void;
  onSelectOption: (val: string) => void;
}> = ({ value, options, placeholder, monoFont = false, onChange, onSelectOption }) => {
  const [open, setOpen] = useState(false);
  const [filterByTyping, setFilterByTyping] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilterByTyping(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const hasOptions = options.length > 0;
  const trimmedVal = value.trim().toLowerCase();
  const displayOptions =
    filterByTyping && trimmedVal
      ? options.filter((opt) => opt.toLowerCase().includes(trimmedVal))
      : options;

  const finalList = displayOptions.length > 0 ? displayOptions : options;

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative flex items-center">
        <input
          type="text"
          value={value}
          onFocus={() => {
            if (hasOptions) {
              setFilterByTyping(false);
              setOpen(true);
            }
          }}
          onChange={(e) => {
            onChange(e.target.value);
            if (hasOptions) {
              setFilterByTyping(true);
              setOpen(true);
            }
          }}
          placeholder={placeholder}
          className={`w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 transition-all ${
            hasOptions ? "pr-8" : ""
          } ${monoFont ? "font-mono" : "font-sans"}`}
        />
        {hasOptions && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => {
              setFilterByTyping(false);
              setOpen((v) => !v);
            }}
            className="absolute right-2 p-1 rounded-md text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="展开已获取的模型列表"
          >
            <ChevronDown
              size={13}
              className={`transition-transform duration-150 ${open ? "rotate-180 text-blue-400" : ""}`}
            />
          </button>
        )}
      </div>

      {open && hasOptions && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-52 overflow-y-auto custom-scrollbar rounded-xl bg-[#1b1b1b] border border-[#343434] shadow-2xl py-1">
          {finalList.map((opt, idx) => {
            const isSelected = opt === value;
            return (
              <button
                key={`${opt}-${idx}`}
                type="button"
                onClick={() => {
                  onSelectOption(opt);
                  setOpen(false);
                  setFilterByTyping(false);
                }}
                className={`w-full px-3 py-1.5 text-left text-xs font-mono flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-blue-600/20 text-blue-300 font-semibold"
                    : "text-neutral-200 hover:bg-white/[0.06]"
                }`}
              >
                <span className="truncate">{opt}</span>
                {isSelected && <Check size={12} className="text-blue-400 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const createEmptyRow = (defaultContext = 128000): ModelDraftRow => ({
  rowId: `row_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  modelId: "",
  name: "",
  contextLimit: defaultContext,
  supportsVision: false,
  isManual: false,
  maxOutputTokens: 8192,
  inputPrice: 0,
  outputPrice: 0,
});

interface SettingsViewProps {
  /** 渲染形态：整页路由或覆盖式弹层 */
  variant?: "page" | "modal";
  /** 弹层模式下关闭弹层的回调 */
  onClose?: () => void;
}

const SettingsView: React.FC<SettingsViewProps> = ({ variant = "page", onClose }) => {
  const isModal = variant === "modal";
  const [activeTab, setActiveTab] = useState<"general" | "models">("models");

  // 配置状态
  const [savePath, setSavePath] = useState("");

  // Agent 运行最大轮次 (默认 5000)
  const [maxToolRounds, setMaxToolRounds] = useState(5000);

  // 流式空闲超时（秒）：连续无数据超过该时长将主动中断并提示
  const [streamIdleTimeout, setStreamIdleTimeout] = useState(180);

  // 上下文自动压缩配置
  const [autoCompact, setAutoCompact] = useState(true);
  const [compactThreshold, setCompactThreshold] = useState(85);
  const [compactKeepTokens, setCompactKeepTokens] = useState(20000);

  // 全局 Store 状态提取至顶层 (杜绝在条件 JSX 中调用 Hook 导致白屏崩溃)

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

  // 全局自定义系统提示词
  const [customSystemPrompt, setCustomSystemPrompt] = useState("");

  // 正在重启安装更新
  const [isRestartingUpdate, setIsRestartingUpdate] = useState(false);

  // ─── 软件自动更新状态 ───
  const [currentAppVersion, setCurrentAppVersion] = useState("v2.1.0");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<{
    version?: string;
    releaseDate?: string;
    releaseNotes?: string;
    releaseUrl?: string;
  } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  } | null>(null);
  const [updateErrorMsg, setUpdateErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (window.electronAPI?.getAppVersion) {
      window.electronAPI
        .getAppVersion()
        .then((ver: string) => {
          if (ver) setCurrentAppVersion(ver.startsWith("v") ? ver : `v${ver}`);
        })
        .catch(() => {});
    }

    const unsubChecking = window.electronAPI?.onUpdateChecking?.(() => {
      setUpdateStatus("checking");
      setUpdateErrorMsg(null);
    });
    const unsubAvailable = window.electronAPI?.onUpdateAvailable?.((info: any) => {
      setUpdateStatus("available");
      setUpdateInfo(info);
      setUpdateErrorMsg(null);
    });
    const unsubNotAvailable = window.electronAPI?.onUpdateNotAvailable?.(() => {
      setUpdateStatus("not-available");
      setUpdateErrorMsg(null);
    });
    const unsubProgress = window.electronAPI?.onUpdateDownloadProgress?.((p: any) => {
      setUpdateStatus("downloading");
      setDownloadProgress(p);
    });
    const unsubDownloaded = window.electronAPI?.onUpdateDownloaded?.((info: any) => {
      setUpdateStatus("downloaded");
      if (info) setUpdateInfo((prev: any) => ({ ...(prev || {}), ...info }));
    });
    const unsubError = window.electronAPI?.onUpdateError?.((err: any) => {
      setUpdateStatus("error");
      setUpdateErrorMsg(typeof err === "string" ? err : err?.message || "更新服务连接失败");
    });

    return () => {
      unsubChecking?.();
      unsubAvailable?.();
      unsubNotAvailable?.();
      unsubProgress?.();
      unsubDownloaded?.();
      unsubError?.();
    };
  }, []);

  const handleManualCheckUpdates = async () => {
    setUpdateStatus("checking");
    setUpdateErrorMsg(null);

    // 5 秒安全超时保护：杜绝任何网络无响应导致一直 loading
    const timer = setTimeout(() => {
      setUpdateStatus((prev) => (prev === "checking" ? "not-available" : prev));
    }, 5000);

    try {
      if (window.electronAPI?.checkForUpdates) {
        const res = await window.electronAPI.checkForUpdates();
        clearTimeout(timer);
        if (!res?.success) {
          setUpdateStatus("error");
          setUpdateErrorMsg(res?.error || "检查更新失败，请检查网络或代理连接");
        }
      } else {
        clearTimeout(timer);
        setTimeout(() => setUpdateStatus("not-available"), 800);
      }
    } catch (err: any) {
      clearTimeout(timer);
      setUpdateStatus("error");
      setUpdateErrorMsg(err?.message || "检查更新异常");
    }
  };

  const handleStartDownload = async () => {
    setUpdateStatus("downloading");
    setDownloadProgress({ percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 });
    if (window.electronAPI?.startDownloadUpdate) {
      const res = await window.electronAPI.startDownloadUpdate();
      if (!res?.success) {
        setUpdateStatus("error");
        setUpdateErrorMsg(res?.error || "下载更新失败");
      }
    }
  };

  const handleQuitAndInstall = async () => {
    if (!window.electronAPI?.quitAndInstallUpdate) return;
    setIsRestartingUpdate(true);
    showToast("正在准备退出并重启应用...");
    try {
      const res = await window.electronAPI.quitAndInstallUpdate();
      if (!res?.success) {
        setIsRestartingUpdate(false);
        showToast("重启失败，已为您打开新版安装包位置");
      }
    } catch (err: any) {
      setIsRestartingUpdate(false);
      showToast(`重启失败: ${err?.message || "未知异常"}`);
    }
  };

  const handleOpenReleasePage = () => {
    const targetUrl = updateInfo?.releaseUrl || "https://github.com/moyanach/omcx/releases";
    if (window.electronAPI?.openReleasePage) {
      window.electronAPI.openReleasePage(targetUrl);
    }
  };

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

  // 主题与个性化背景状态
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>("system");
  const [appearance, setAppearanceState] = useState<AppearanceConfig>(getAppearance());
  const { setTheme: setStoreTheme, setActiveNavTab } = useAppStore();

  // 字体设置（界面字体 / 终端字体 / 终端字号）
  const [fontSettings, setFontSettingsState] = useState<FontSettings>(getFontSettings());
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontsLoading, setFontsLoading] = useState(false);

  // Hooks 管理（全局 + 当前会话项目级）
  const settingsSessions = useChatStore((s) => s.sessions);
  const settingsActiveSessionId = useChatStore((s) => s.activeSessionId);
  const hooksWorkDir =
    settingsSessions.find((s) => s.id === settingsActiveSessionId)?.workDir || "";
  const [hooksInfo, setHooksInfo] = useState<any>(null);
  const [hooksBusy, setHooksBusy] = useState(false);

  const loadHooksInfo = async (workDir = hooksWorkDir) => {
    if (!window.electronAPI?.getProjectHooks) return;
    try {
      const info = await window.electronAPI.getProjectHooks(workDir || null);
      setHooksInfo(info);
    } catch {
      setHooksInfo(null);
    }
  };

  const monospaceFonts = systemFonts.filter((f) => isMonospaceLike(f));
  const otherFonts = systemFonts.filter((f) => !isMonospaceLike(f));
  const nerdFonts = systemFonts.filter((f) =>
    /nerd|\bNF\b|NF$|powerline/i.test(f)
  );

  const handleFontChange = async (patch: Partial<FontSettings>) => {
    const next = await setFontSettings(patch);
    setFontSettingsState(next);
  };

  const handleReloadSystemFonts = async (refresh = false) => {
    if (!window.electronAPI?.getSystemFonts) return;
    setFontsLoading(true);
    try {
      const result = await window.electronAPI.getSystemFonts(refresh);
      const list = Array.isArray(result?.fonts) ? result.fonts : [];
      setSystemFonts(list);
      if (refresh) showToast(`已重新扫描系统字体，共 ${list.length} 款`);
    } catch {
      showToast("读取系统字体失败");
    } finally {
      setFontsLoading(false);
    }
  };

  const handleUpdateAppearance = async (patch: Partial<AppearanceConfig>) => {
    const next = { ...appearance, ...patch };
    setAppearanceState(next);
    await setAppearance(patch);
  };

  const handlePickWallpaperFile = async () => {
    if (!window.electronAPI?.selectBackgroundImage) return;
    try {
      const url = await window.electronAPI.selectBackgroundImage();
      if (typeof url === "string" && url.startsWith("local-media://")) {
        const nextOpacity = appearance.surfaceOpacity >= 98 ? 82 : appearance.surfaceOpacity;
        await handleUpdateAppearance({
          bgImage: url,
          surfaceOpacity: nextOpacity,
        });
        showToast("已应用自定义背景壁纸");
      }
    } catch (err) {
      showToast("选择背景图片失败");
    }
  };

  // 提示状态
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  };

  const loadModels = async () => {
    if (window.electronAPI && window.electronAPI.dbGetModels) {
      const list = await window.electronAPI.dbGetModels();
      setModels(list);
    }
  };

  // 编辑已有模型 (支持在编辑当前模型的同时，继续基于该 Provider 追加新模型)
  const handleEditModel = (model: any) => {
    setEditingModelId(model.id);
    setNewModelProvider(model.provider || "custom");
    setNewModelBaseUrl(model.base_url || model.baseUrl || "");
    setNewModelApiKey(model.api_key || model.apiKey || "");
    setFetchedRemoteModels([]);
    setModelRows([
      {
        rowId: `row_edit_${model.id}`,
        existingId: model.id,
        modelId: model.model_id || model.modelId || "",
        name: model.name || "",
        contextLimit: model.context_limit || model.contextLimit || 128000,
        supportsVision: !!model.supports_vision,
        isManual: true,
        maxOutputTokens: model.max_output_tokens || 8192,
        inputPrice: model.input_price || 0,
        outputPrice: model.output_price || 0,
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
          provider: newModelProvider,
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

  // 添加/更新模型配置 (支持编辑现有模型的同时，基于当前 Provider 批量追加新模型)
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

    let updatedCount = 0;
    let addedCount = 0;

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      const targetId =
        row.existingId ||
        (editingModelId && i === 0 && validRows.length === 1 ? editingModelId : "") ||
        `model_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;

      if (row.existingId || (editingModelId && targetId === editingModelId)) {
        updatedCount++;
      } else {
        addedCount++;
      }

      const modelPayload = {
        id: targetId,
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
        max_output_tokens: row.maxOutputTokens || 8192,
        input_price: row.inputPrice || 0,
        output_price: row.outputPrice || 0,
      };
      await window.electronAPI.dbAddModel(modelPayload as any);
    }

    handleCancelEdit();
    if (updatedCount > 0 && addedCount > 0) {
      showToast(`已更新 ${updatedCount} 个模型，并新增 ${addedCount} 个同服务商模型！`);
    } else if (updatedCount > 0) {
      showToast("模型配置已成功更新！");
    } else {
      showToast(`成功保存并生效 ${addedCount} 个模型配置！`);
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

      const savedRounds = await window.electronAPI.getConfig("max_tool_rounds");
      if (savedRounds) setMaxToolRounds(Number(savedRounds) || 5000);

      const savedIdleTimeout = await window.electronAPI.getConfig("stream_idle_timeout");
      if (savedIdleTimeout) setStreamIdleTimeout(Number(savedIdleTimeout) || 180);

      const savedAutoCompact = await window.electronAPI.getConfig("context_auto_compact");
      if (savedAutoCompact !== null) setAutoCompact(savedAutoCompact !== "false");

      const savedThreshold = await window.electronAPI.getConfig("context_compact_threshold_percent");
      if (savedThreshold) setCompactThreshold(Number(savedThreshold) || 85);

      const savedKeepTokens = await window.electronAPI.getConfig("context_compact_keep_tokens");
      if (savedKeepTokens) setCompactKeepTokens(Number(savedKeepTokens) || 20000);

      const savedPrompt = await window.electronAPI.getConfig("custom_system_prompt");
      if (savedPrompt) setCustomSystemPrompt(savedPrompt);

      const savedTheme = await loadTheme();
      setCurrentTheme(savedTheme);
      setStoreTheme(savedTheme);

      const savedAppearance = await loadAppearance();
      setAppearanceState(savedAppearance);

      const savedFonts = await loadFontSettings();
      setFontSettingsState(savedFonts);
      handleReloadSystemFonts(false);
      loadHooksInfo();
    };
    loadConfigs();
    loadModels();
  }, []);

  useEffect(() => {
    loadHooksInfo(hooksWorkDir);
  }, [hooksWorkDir]);

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

  const handleSaveStreamIdleTimeout = async () => {
    if (!window.electronAPI) return;
    try {
      const safeValue = Math.max(30, Math.min(1800, Number(streamIdleTimeout) || 180));
      setStreamIdleTimeout(safeValue);
      await window.electronAPI.setConfig("stream_idle_timeout", String(safeValue));
      showToast(`流式空闲超时已更新为 ${safeValue} 秒`);
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

  const handleSaveCustomSystemPrompt = async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.setConfig("custom_system_prompt", customSystemPrompt.trim());
      showToast("全局自定义系统提示词已保存，将自动注入每个会话！");
    } catch (err: any) {
      showToast(`保存失败: ${err.message}`);
    }
  };

  return (
    <div
      className={`relative flex h-full w-full bg-[#161616] overflow-hidden select-none flex-col ${
        isModal ? "rounded-2xl" : ""
      }`}
    >
      {/* Toast 提示（弹层内定位在面板顶部，整页模式仍固定在窗口顶部） */}
      <div
        className={`${
          isModal ? "absolute top-3" : "fixed top-6"
        } left-1/2 -translate-x-1/2 flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl shadow-2xl transition-all duration-300 z-50 ${
          toastMsg ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4 pointer-events-none"
        }`}
      >
        <CheckCircle2 size={16} />
        <span className="text-xs font-medium">{toastMsg}</span>
      </div>

      {/* 顶部 Header：整页模式返回会话；弹层模式仅保留标题、Esc 提示与关闭按钮 */}
      <div
        className={`h-12 border-b border-[#242424] bg-[#141414] px-5 flex items-center justify-between flex-shrink-0 ${
          isModal ? "" : "titlebar-drag"
        }`}
      >
        <div className="flex items-center gap-2 text-neutral-100 font-semibold text-xs tracking-wide">
          {!isModal && (
            <button
              onClick={() => setActiveNavTab("sessions")}
              className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors titlebar-no-drag"
              title="返回会话"
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <SettingsIcon size={16} className="text-blue-400" />
          <span>系统设置</span>
        </div>

        {isModal && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-neutral-500 px-1.5 py-0.5 rounded border border-[#2e2e2e] bg-[#1a1a1a]">
              Esc
            </span>
            <button
              onClick={onClose}
              className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors"
              title="关闭设置"
            >
              <X size={15} />
            </button>
          </div>
        )}
      </div>

      {/* 内容展示区 (居中自适应展开) */}
      <div className="flex-1 overflow-y-auto p-6 custom-scrollbar flex justify-center">
        <div className="w-full max-w-4xl space-y-6">
          {/* 内容区顶部的 Tab 切换器 (置于渲染内容右上角) */}
          <div className="flex items-center justify-between border-b border-[#242424] pb-4">
            <div>
              <h2 className="text-sm font-bold text-neutral-100">
                {activeTab === "models" && "大模型服务商与模型配置"}
                {activeTab === "general" && "通用设置、外观主题与上下文"}
              </h2>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                {activeTab === "models" && "配置 OpenAI 兼容模型、专属 API Key、上下文上限与视觉输入能力"}
                {activeTab === "general" && "外观主题、Agent 最大执行轮次与长对话上下文自动压缩"}
              </p>
            </div>

            {/* 双 Tab 切换器 */}
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
                        {fetchedRemoteModels.length > 0 && (
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
                          {fetchedRemoteModels.length > 0
                            ? "已拉取模型列表：4、5 均可下拉选择（双向联动）或直接打字修改"
                            : "每行对应一个独立模型，可分别设置模型 ID、显示名称、上下文与视觉"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => addRow("")}
                        className="px-2.5 py-1 rounded-lg bg-[#222222] hover:bg-[#2b2b2b] text-blue-400 text-xs font-medium flex items-center gap-1 border border-[#303030] transition-colors cursor-pointer"
                      >
                        <Plus size={13} />
                        <span>添加一行模型</span>
                      </button>
                    </div>

                    {/* 模型卡片数组 */}
                    <div className="space-y-3">
                      {modelRows.map((row, index) => {
                        const remoteOptionList = Array.from(
                          new Set(
                            fetchedRemoteModels
                              .map((m: any) => String(m.id || m.name || m.model || m || "").trim())
                              .filter(Boolean)
                          )
                        );

                        return (
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
                                {editingModelId && (
                                  <span
                                    className={`px-1.5 py-0.2 rounded text-[10px] font-sans ${
                                      row.existingId
                                        ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                        : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                    }`}
                                  >
                                    {row.existingId ? "原模型更新" : "基于当前服务商新增"}
                                  </span>
                                )}
                              </span>

                              {modelRows.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => removeRow(row.rowId)}
                                  className="p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                                  title="删除此模型配置行"
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </div>

                            {/* 第 1 行：4. 模型 ID + 5. 显示名称 (均为可下拉联动 + 可自由编辑组合框) */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <label className="text-xs font-medium text-neutral-300">
                                    4. 模型 ID (Model ID)
                                  </label>
                                  {remoteOptionList.length > 0 && (
                                    <span className="text-[10px] text-blue-400/80 font-mono">
                                      可下拉选择或直接编辑
                                    </span>
                                  )}
                                </div>

                                <EditableModelCombobox
                                  value={row.modelId}
                                  options={remoteOptionList}
                                  monoFont
                                  placeholder="例如: deepseek-chat, gpt-4o, qwen2.5-coder:32b"
                                  onChange={(val) => {
                                    updateRow(row.rowId, {
                                      modelId: val,
                                      name: row.name === row.modelId || !row.name ? val : row.name,
                                      supportsVision: inferVisionSupport(val),
                                    });
                                  }}
                                  onSelectOption={(val) => {
                                    updateRow(row.rowId, {
                                      modelId: val,
                                      name: val,
                                      supportsVision: inferVisionSupport(val),
                                    });
                                  }}
                                />
                              </div>

                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <label className="text-xs font-medium text-neutral-300">
                                    5. 显示名称 (Display Name)
                                  </label>
                                  {remoteOptionList.length > 0 && (
                                    <span className="text-[10px] text-blue-400/80 font-mono">
                                      可下拉选择或自定义别名
                                    </span>
                                  )}
                                </div>

                                <EditableModelCombobox
                                  value={row.name}
                                  options={remoteOptionList}
                                  placeholder="例如: DeepSeek V3 官方, 我的 GPT-4o"
                                  onChange={(val) => {
                                    updateRow(row.rowId, { name: val });
                                  }}
                                  onSelectOption={(val) => {
                                    updateRow(row.rowId, {
                                      modelId: val,
                                      name: val,
                                      supportsVision: inferVisionSupport(val),
                                    });
                                  }}
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

                            {/* 第 3 行：最大输出 Token 与成本计量 (原生 Anthropic 与成本看板使用) */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                              <div className="space-y-1">
                                <label className="text-xs font-medium text-neutral-300">
                                  8. 单次最大输出 Tokens
                                </label>
                                <input
                                  type="number"
                                  min={256}
                                  step={256}
                                  value={row.maxOutputTokens ?? 8192}
                                  onChange={(e) =>
                                    updateRow(row.rowId, {
                                      maxOutputTokens: Number(e.target.value) || 8192,
                                    })
                                  }
                                  className="w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-mono"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-xs font-medium text-neutral-300">
                                  9. 输入价格 ($/1M tokens)
                                </label>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={row.inputPrice ?? 0}
                                  onChange={(e) =>
                                    updateRow(row.rowId, {
                                      inputPrice: Number(e.target.value) || 0,
                                    })
                                  }
                                  className="w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-mono"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-xs font-medium text-neutral-300">
                                  10. 输出价格 ($/1M tokens)
                                </label>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={row.outputPrice ?? 0}
                                  onChange={(e) =>
                                    updateRow(row.rowId, {
                                      outputPrice: Number(e.target.value) || 0,
                                    })
                                  }
                                  className="w-full bg-[#141414] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 font-mono"
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <button
                      type="button"
                      onClick={() => addRow("")}
                      className="w-full py-2.5 rounded-xl border border-dashed border-[#333333] hover:border-blue-500/50 hover:bg-white/[0.02] text-xs text-neutral-400 hover:text-blue-400 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>
                        {editingModelId
                          ? "基于当前服务商继续添加一行新模型"
                          : "添加一行新模型配置"}
                      </span>
                    </button>
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
                        {editingModelId && modelRows.length === 1
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

            {/* ═════════ 2. 通用设置 TAB ═════════ */}
            {activeTab === "general" && (
              <div className="space-y-5">
                {/* 主题与个性化背景设置 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-5">
                  <div className="flex items-center justify-between border-b border-[#282828] pb-3">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide">
                        外观主题与自定义背景
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        支持亮色与暗色双主题，可自定义背景壁纸、界面通透度与高斯虚化，前景文字与代码始终保持 100% 清晰可读
                      </p>
                    </div>
                    {(appearance.bgImage || appearance.surfaceOpacity < 100) && (
                      <button
                        type="button"
                        onClick={async () => {
                          await handleUpdateAppearance({
                            bgImage: "",
                            surfaceOpacity: 100,
                            bgBlur: 16,
                          });
                          showToast("已恢复默认纯色外观");
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-300 text-[11px] font-medium border border-[#353535] flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <RotateCcw size={12} />
                        <span>恢复默认纯色</span>
                      </button>
                    )}
                  </div>

                  {/* 1. 亮色 / 暗色 / 随系统 切换 */}
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

                  {/* 2. 背景图片与艺术渐变壁纸选择 */}
                  <div className="pt-2 border-t border-[#262626] space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <ImageIcon size={14} className="text-blue-400" />
                        <span className="text-xs font-semibold text-neutral-200">
                          背景壁纸 (支持本地图片或内置氛围壁纸)
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handlePickWallpaperFile}
                          className="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                        >
                          <FolderOpen size={13} />
                          <span>选择本地背景图...</span>
                        </button>
                        {appearance.bgImage && (
                          <button
                            type="button"
                            onClick={async () => {
                              await handleUpdateAppearance({
                                bgImage: "",
                                surfaceOpacity: 100,
                              });
                              showToast("已清除背景图片");
                            }}
                            className="px-2.5 py-1.5 rounded-xl bg-[#252525] hover:bg-[#303030] text-neutral-300 text-xs font-medium border border-[#353535] transition-colors cursor-pointer"
                          >
                            清除背景图
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 预设壁纸与当前自定义图片卡片网格 */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                      {/* 无背景纯色卡 */}
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateAppearance({ bgImage: "", surfaceOpacity: 100 })
                        }
                        className={`h-16 rounded-xl border-2 flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                          !appearance.bgImage
                            ? "border-blue-500 bg-blue-500/10 text-blue-400"
                            : "border-[#2e2e2e] bg-[#171717] text-neutral-400 hover:border-neutral-500"
                        }`}
                      >
                        <span className="text-xs font-semibold">纯净无背景</span>
                        <span className="text-[10px] text-neutral-500">100% 实色</span>
                      </button>

                      {/* 4 款内置氛围渐变壁纸 */}
                      {WALLPAPER_PRESETS.map((preset) => {
                        const isSelected = appearance.bgImage === preset.id;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => {
                              const nextOpacity =
                                appearance.surfaceOpacity >= 98 ? 82 : appearance.surfaceOpacity;
                              handleUpdateAppearance({
                                bgImage: preset.id,
                                surfaceOpacity: nextOpacity,
                              });
                            }}
                            className={`h-16 rounded-xl border-2 relative overflow-hidden flex items-end p-2 transition-all cursor-pointer ${
                              isSelected
                                ? "border-blue-500 shadow-md"
                                : "border-[#2e2e2e] hover:border-neutral-400"
                            }`}
                          >
                            <div
                              className="absolute inset-0"
                              style={{ backgroundImage: preset.css }}
                            />
                            <span className="relative z-10 text-[11px] font-semibold text-white drop-shadow px-1.5 py-0.5 rounded bg-black/45 backdrop-blur-sm">
                              {preset.name}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* 若选择了本地图片，展示当前本地图片预览条 */}
                    {appearance.bgImage &&
                      !appearance.bgImage.startsWith("preset:") && (
                        <div className="flex items-center justify-between p-2.5 rounded-xl bg-[#171717] border border-[#2b2b2b]">
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className="w-12 h-8 rounded-lg bg-cover bg-center border border-[#353535] flex-shrink-0"
                              style={{
                                backgroundImage: `url("${appearance.bgImage}")`,
                              }}
                            />
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-neutral-200 flex items-center gap-1.5">
                                <Sparkles size={12} className="text-blue-400" />
                                <span>已启用自定义本地壁纸</span>
                              </div>
                              <div className="text-[10px] text-neutral-500 font-mono truncate max-w-[380px]">
                                {decodeURI(appearance.bgImage.replace("local-media://local", ""))}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                  </div>

                  {/* 3. 主题面板不透明度与背景高斯虚化滑块 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-[#262626]">
                    {/* 界面不透明度 */}
                    <div className="p-3.5 rounded-xl bg-[#171717] border border-[#2b2b2b] space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold text-neutral-200">
                          主题面板不透明度 (Surface Opacity)
                        </label>
                        <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {appearance.surfaceOpacity}% (透光 {100 - appearance.surfaceOpacity}%)
                        </span>
                      </div>
                      <input
                        type="range"
                        min={35}
                        max={100}
                        step={1}
                        value={appearance.surfaceOpacity}
                        onChange={(e) =>
                          handleUpdateAppearance({
                            surfaceOpacity: Number(e.target.value),
                          })
                        }
                        className="w-full accent-blue-600 cursor-pointer"
                      />
                      <div className="flex justify-between text-[10px] text-neutral-500">
                        <span>35% (高通透毛玻璃)</span>
                        <span>82% (推荐平衡)</span>
                        <span>100% (实色无透光)</span>
                      </div>
                    </div>

                    {/* 背景虚化程度 */}
                    <div className="p-3.5 rounded-xl bg-[#171717] border border-[#2b2b2b] space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold text-neutral-200">
                          背景壁纸虚化程度 (Background Blur)
                        </label>
                        <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          {appearance.bgBlur}px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        step={1}
                        value={appearance.bgBlur}
                        onChange={(e) =>
                          handleUpdateAppearance({
                            bgBlur: Number(e.target.value),
                          })
                        }
                        className="w-full accent-emerald-500 cursor-pointer"
                      />
                      <div className="flex justify-between text-[10px] text-neutral-500">
                        <span>0px (清晰原图)</span>
                        <span>16px (柔和护眼)</span>
                        <span>40px (深度磨砂)</span>
                      </div>
                    </div>
                  </div>

                  {/* 内容面通透开关：让卡片/代码/输入框/消息气泡也跟随背景渐变（毛玻璃） */}
                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#171717] border border-[#2b2b2b] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={appearance.contentTranslucent}
                      onChange={(e) =>
                        handleUpdateAppearance({
                          contentTranslucent: e.target.checked,
                        })
                      }
                      className="mt-0.5 accent-blue-600 cursor-pointer"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-neutral-200">
                        内容面也跟随背景通透（毛玻璃）
                      </span>
                      <span className="text-[11px] text-neutral-500">
                        开启后卡片、代码块、输入框与消息气泡也会透出壁纸渐变，并施加毛玻璃虚化保证文字清晰；关闭则内容面保持高不透明度优先可读
                      </span>
                    </span>
                  </label>

                  {(appearance.surfaceOpacity < 60 || appearance.bgBlur < 6) && (
                    <div className="flex items-start gap-2 p-2.5 rounded-xl bg-[var(--ui-accent-amber-soft)] border border-[color:var(--ui-accent-amber-border)] text-[11px] text-[var(--ui-accent-amber)] leading-relaxed">
                      <Sparkles size={13} className="flex-shrink-0 mt-0.5" />
                      <span>
                        当前通透度较高或虚化较低，壁纸可能干扰阅读。推荐组合：不透明度 82% + 虚化 16px（柔和护眼），外框通透且内容清晰。
                      </span>
                    </div>
                  )}
                </div>

                {/* 字体设置卡片：界面字体 / 终端字体 / 终端字号 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-5">
                  <div className="flex items-center justify-between border-b border-[#282828] pb-3 gap-3">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide flex items-center gap-2">
                        <Type size={13} className="text-emerald-400" />
                        <span>字体设置</span>
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        从系统已安装字体中选择界面与终端字体。终端图标（Powerline / Nerd Font 符号）需要所选字体包含对应字形，推荐使用等宽 Nerd Font
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleReloadSystemFonts(true)}
                        disabled={fontsLoading}
                        className="px-2.5 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-300 text-[11px] font-medium border border-[#353535] flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <RotateCw size={12} className={fontsLoading ? "animate-spin" : ""} />
                        <span>{fontsLoading ? "扫描中…" : "重新扫描"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const next = await resetFontSettings();
                          setFontSettingsState(next);
                          showToast("已恢复默认字体设置");
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-300 text-[11px] font-medium border border-[#353535] flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <RotateCcw size={12} />
                        <span>恢复默认</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* 界面字体 */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-neutral-200">界面字体</span>
                        <span className="text-[10px] text-neutral-500">
                          {systemFonts.length ? `已识别 ${systemFonts.length} 款系统字体` : "读取中…"}
                        </span>
                      </div>
                      <select
                        value={fontSettings.uiFamily}
                        onChange={(e) => handleFontChange({ uiFamily: e.target.value })}
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 cursor-pointer"
                      >
                        <option value="">系统默认（Inter / 系统 UI 字体）</option>
                        {fontSettings.uiFamily &&
                          !systemFonts.includes(fontSettings.uiFamily) && (
                            <option value={fontSettings.uiFamily}>
                              {fontSettings.uiFamily}（当前）
                            </option>
                          )}
                        {monospaceFonts.length > 0 && (
                          <optgroup label="等宽 / 编程字体">
                            {monospaceFonts.map((family) => (
                              <option key={`ui-mono-${family}`} value={family}>
                                {family}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {otherFonts.length > 0 && (
                          <optgroup label="其他系统字体">
                            {otherFonts.map((family) => (
                              <option key={`ui-other-${family}`} value={family}>
                                {family}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      <p
                        className="text-[11px] text-neutral-500 truncate"
                        style={{ fontFamily: buildUiFontFamily(fontSettings.uiFamily) }}
                      >
                        预览：OMCX Desktop · 自主工程研发工作台 · Agent 123
                      </p>
                    </div>

                    {/* 终端字体 */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-neutral-200">终端字体</span>
                        <span className="text-[10px] text-neutral-500">作用于集成 PTY 终端</span>
                      </div>
                      <select
                        value={fontSettings.terminalFamily}
                        onChange={(e) => handleFontChange({ terminalFamily: e.target.value })}
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-emerald-500 cursor-pointer"
                      >
                        <option value="">系统默认（SF Mono / Menlo 等）</option>
                        {fontSettings.terminalFamily &&
                          !systemFonts.includes(fontSettings.terminalFamily) && (
                            <option value={fontSettings.terminalFamily}>
                              {fontSettings.terminalFamily}（当前）
                            </option>
                          )}
                        {nerdFonts.length > 0 && (
                          <optgroup label="Nerd Font（终端图标完整，推荐）">
                            {nerdFonts.map((family) => (
                              <option key={`term-nerd-${family}`} value={family}>
                                {family}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {monospaceFonts.length > 0 && (
                          <optgroup label="等宽 / 编程字体（推荐）">
                            {monospaceFonts.map((family) => (
                              <option key={`term-mono-${family}`} value={family}>
                                {family}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {otherFonts.length > 0 && (
                          <optgroup label="其他系统字体">
                            {otherFonts.map((family) => (
                              <option key={`term-other-${family}`} value={family}>
                                {family}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      <div className="rounded-xl bg-[#0e0e0e] border border-[#262626] px-3 py-2 overflow-hidden">
                        <div
                          className="text-[12px] text-neutral-200 truncate"
                          style={{
                            fontFamily: buildTerminalFontFamily(fontSettings.terminalFamily),
                            fontSize: `${fontSettings.terminalFontSize}px`,
                          }}
                        >
                          ➜ ~/omcx ❯ git status ✓ ● ▲ 󰂄 你好
                        </div>
                      </div>
                      {nerdFonts.length > 0 && fontSettings.terminalFamily !== nerdFonts[0] && (
                        <button
                          type="button"
                          onClick={() => {
                            handleFontChange({ terminalFamily: nerdFonts[0] });
                            showToast(`已应用 Nerd Font：${nerdFonts[0]}`);
                          }}
                          className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors cursor-pointer"
                        >
                          <CheckCircle2 size={12} />
                          <span>检测到 Nerd Font：{nerdFonts[0]}，一键应用以显示终端图标</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 终端字号 */}
                  <div className="pt-2 border-t border-[#262626] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-neutral-200">终端字号</span>
                      <span className="text-[11px] font-mono text-emerald-400">
                        {fontSettings.terminalFontSize}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min={9}
                      max={24}
                      step={1}
                      value={fontSettings.terminalFontSize}
                      onChange={(e) =>
                        handleFontChange({ terminalFontSize: Number(e.target.value) })
                      }
                      className="w-full accent-emerald-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-neutral-500">
                      <span>9px (紧凑)</span>
                      <span>12px (默认)</span>
                      <span>24px (大字号)</span>
                    </div>
                  </div>

                  <div className="flex items-start gap-2 p-2.5 rounded-xl bg-[#171717] border border-[#2b2b2b] text-[11px] text-neutral-400 leading-relaxed">
                    <Sparkles size={13} className="flex-shrink-0 mt-0.5 text-emerald-400" />
                    <span>
                      终端提示符中的 Nerd Font 私有区图标无法由系统普通字体渲染，会显示为方块。安装并选择
                      <span className="text-neutral-200 font-semibold"> MesloLGS NF / JetBrainsMono Nerd Font / Hack Nerd Font </span>
                      后即可正常显示；普通符号已自动回退到 Apple Symbols 与 Apple Color Emoji。
                    </span>
                  </div>
                </div>

                {/* Hooks 生命周期钩子 */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-[#282828] pb-3 gap-3">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide flex items-center gap-2">
                        <Webhook size={13} className="text-sky-400" />
                        <span>Hooks（Agent 生命周期钩子）</span>
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        在 UserPromptSubmit / PreToolUse / PostToolUse / Stop 阶段执行外部命令。命令通过 stdin 接收 JSON；退出码 0 继续、2 阻断，或输出
                        <code className="mx-1 font-mono text-neutral-400">{`{"decision":"block","reason":"..."}`}</code>
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={async () => {
                          const result = await window.electronAPI?.createHooksTemplate?.();
                          if (result?.filePath) {
                            window.electronAPI?.showInFolder?.(result.filePath);
                            showToast("已生成全局 hooks.json 模板");
                            loadHooksInfo();
                          }
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-300 text-[11px] font-medium border border-[#353535] flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <FolderOpen size={12} />
                        <span>打开配置</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => loadHooksInfo()}
                        className="px-2.5 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-300 text-[11px] font-medium border border-[#353535] flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <RefreshCw size={12} />
                        <span>刷新</span>
                      </button>
                    </div>
                  </div>

                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#171717] border border-[#2b2b2b] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={hooksInfo?.enabled !== false}
                      onChange={async (e) => {
                        const next = e.target.checked;
                        await window.electronAPI?.setConfig?.(
                          "hooks_enabled",
                          next ? "true" : "false"
                        );
                        setHooksInfo((prev: any) => (prev ? { ...prev, enabled: next } : prev));
                        showToast(next ? "已启用 Hooks" : "已禁用全部 Hooks");
                      }}
                      className="mt-0.5 accent-sky-500 cursor-pointer"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-neutral-200">启用 Hooks 执行引擎</span>
                      <span className="text-[11px] text-neutral-500">
                        全局配置：{hooksInfo?.globalPath || "~/.omcx/hooks.json"}
                      </span>
                    </span>
                  </label>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map((event) => (
                      <div
                        key={event}
                        className="rounded-xl bg-[#171717] border border-[#2b2b2b] px-3 py-2"
                      >
                        <div className="text-[10px] font-mono text-neutral-400 truncate">{event}</div>
                        <div className="text-lg font-semibold text-neutral-100 font-mono">
                          {hooksInfo?.counts?.[event] ?? 0}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-xl bg-[#171717] border border-[#2b2b2b] p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-neutral-200">项目级 Hooks</div>
                        <div className="text-[10px] font-mono text-neutral-500 truncate">
                          {hooksWorkDir
                            ? hooksInfo?.projectPath || `${hooksWorkDir}/.omcx/hooks.json`
                            : "当前没有绑定工作目录的会话"}
                        </div>
                      </div>
                      {hooksWorkDir && hooksInfo?.hasProjectHooks && (
                        <label className="flex items-center gap-2 text-[11px] text-neutral-300 cursor-pointer select-none flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={Boolean(hooksInfo?.projectTrusted)}
                            disabled={hooksBusy}
                            onChange={async (e) => {
                              setHooksBusy(true);
                              try {
                                const result = await window.electronAPI?.setProjectHooksTrust?.(
                                  hooksWorkDir,
                                  e.target.checked
                                );
                                if (result?.success) {
                                  showToast(
                                    e.target.checked ? "已信任并启用项目 Hooks" : "已撤销项目 Hooks 信任"
                                  );
                                }
                                await loadHooksInfo();
                              } finally {
                                setHooksBusy(false);
                              }
                            }}
                            className="accent-emerald-500 cursor-pointer"
                          />
                          信任并启用
                        </label>
                      )}
                    </div>
                    <p className="text-[10.5px] text-neutral-500 leading-relaxed">
                      项目 hooks 会执行仓库内声明的命令，默认完全禁用；仅在你确认来源可信后手动开启。配置内容变更不会自动重新授权。
                    </p>
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

                {/* 流式空闲超时（防静默卡死） */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3">
                    <h3 className="text-xs font-bold text-neutral-100 tracking-wide">
                      流式空闲超时 (Stream Idle Timeout)
                    </h3>
                    <p className="text-[11px] text-neutral-500 mt-0.5">
                      上游连续超过该时长未返回任何数据时自动中断并提示，避免网关静默掐断后界面无限期干等（默认 180 秒）
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={30}
                      max={1800}
                      step={30}
                      value={streamIdleTimeout}
                      onChange={(e) => setStreamIdleTimeout(Number(e.target.value) || 180)}
                      className="w-48 bg-[#171717] border border-[#2e2e2e] rounded-xl px-3.5 py-2 text-xs font-mono text-neutral-200 outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleSaveStreamIdleTimeout}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5"
                    >
                      <Save size={13} />
                      <span>保存超时时间</span>
                    </button>
                    <span className="text-[11px] text-neutral-500">单位：秒（30 ~ 1800）</span>
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

                {/* 全局自定义系统提示词 (Custom System Prompt) */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide flex items-center gap-2">
                        <span>全局自定义系统提示词 (Custom System Prompt)</span>
                        {customSystemPrompt.trim().length > 0 && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            已注入全局 ({customSystemPrompt.trim().length} 字符)
                          </span>
                        )}
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        作为内置系统提示词与行为准则的补充，在每次对话时一并注入大模型，对当前及后续所有会话全局生效
                      </p>
                    </div>

                    {customSystemPrompt && (
                      <button
                        type="button"
                        onClick={() => setCustomSystemPrompt("")}
                        className="px-2.5 py-1 text-xs text-neutral-400 hover:text-rose-400 transition-colors cursor-pointer"
                      >
                        清空内容
                      </button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <textarea
                      rows={5}
                      value={customSystemPrompt}
                      onChange={(e) => setCustomSystemPrompt(e.target.value)}
                      placeholder="输入您的全局专属指令或研发偏好。例如：&#10;1. 默认使用纯中文回答，代码注释保持详尽且规范&#10;2. 优先采用 TypeScript 严格类型与函数式编程模式&#10;3. 所有重构均优先保证向前兼容性，并在修改前分析影响面"
                      className="w-full bg-[#171717] border border-[#2e2e2e] focus:border-blue-500 rounded-xl p-3.5 text-xs text-neutral-200 placeholder-neutral-600 font-mono leading-relaxed outline-none resize-y custom-scrollbar"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-neutral-500 font-mono">
                        已输入 {customSystemPrompt.length} 个字符
                      </span>
                      <button
                        type="button"
                        onClick={handleSaveCustomSystemPrompt}
                        className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer"
                      >
                        <Save size={13} />
                        <span>保存自定义提示词</span>
                      </button>
                    </div>
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

                {/* 软件版本与自动更新 (Software Auto-Update) */}
                <div className="bg-[#1c1c1c] border border-[#2b2b2b] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide flex items-center gap-2">
                        <span>软件更新与版本管理</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {currentAppVersion}
                        </span>
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        基于 GitHub Releases 的全自动化版本检测、差量下载与无缝重启升级
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={updateStatus === "checking" || updateStatus === "downloading"}
                      onClick={handleManualCheckUpdates}
                      className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
                    >
                      <RefreshCw size={12} className={updateStatus === "checking" ? "animate-spin" : ""} />
                      <span>{updateStatus === "checking" ? "正在检查..." : "检查更新"}</span>
                    </button>
                  </div>

                  {/* 状态展示区 */}
                  {updateStatus === "not-available" && (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2 text-xs text-emerald-400">
                      <CheckCircle2 size={14} className="flex-shrink-0" />
                      <span>当前已是最新版本 ({currentAppVersion})，无需更新。</span>
                    </div>
                  )}

                  {updateStatus === "available" && updateInfo && (
                    <div className="p-3.5 rounded-xl bg-[#171717] border border-blue-500/30 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-neutral-100 flex items-center gap-1.5">
                          <ArrowUpCircle size={14} className="text-blue-400" />
                          <span>发现新版本: v{updateInfo.version}</span>
                        </span>
                        {updateInfo.releaseDate && (
                          <span className="text-[10px] font-mono text-neutral-500">
                            发布日期: {new Date(updateInfo.releaseDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>

                      {updateInfo.releaseNotes && (
                        <div className="p-2.5 rounded-lg bg-[#141414] border border-[#262626] text-[11px] text-neutral-300 font-mono max-h-32 overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                          {typeof updateInfo.releaseNotes === "string"
                            ? updateInfo.releaseNotes.replace(/<[^>]+>/g, "")
                            : "包含多项性能提升与功能优化。"}
                        </div>
                      )}

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={handleStartDownload}
                          className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
                        >
                          <Download size={13} />
                          <span>立即在后台下载</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenReleasePage}
                          className="px-3 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-300 text-xs font-medium border border-[#353535] transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <ExternalLink size={12} />
                          <span>在浏览器中查看 Release</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {updateStatus === "downloading" && downloadProgress && (
                    <div className="p-3.5 rounded-xl bg-[#171717] border border-[#2b2b2b] space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-neutral-200 flex items-center gap-1.5">
                          <Download size={13} className="text-blue-400 animate-bounce" />
                          <span>正在下载更新安装包...</span>
                        </span>
                        <span className="font-mono text-blue-400 font-bold">
                          {downloadProgress.percent}%
                        </span>
                      </div>

                      <div className="w-full h-2 rounded-full bg-[#252525] overflow-hidden">
                        <div
                          className="h-full bg-blue-600 transition-all duration-300 rounded-full"
                          style={{ width: `${downloadProgress.percent}%` }}
                        />
                      </div>

                      <div className="flex items-center justify-between text-[10px] font-mono text-neutral-500">
                        <span>
                          下载速率: {(downloadProgress.bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s
                        </span>
                        <span>
                          {(downloadProgress.transferred / (1024 * 1024)).toFixed(1)} MB / {(downloadProgress.total / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      </div>
                    </div>
                  )}

                  {updateStatus === "downloaded" && (
                    <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />
                          <div>
                            <span className="text-xs font-bold text-neutral-100">
                              新版本已就绪！
                            </span>
                            <p className="text-[11px] text-neutral-400">
                              {isRestartingUpdate
                                ? "正在退出应用并应用更新，请稍候..."
                                : "最新安装包已完成校验，重启客户端即可无缝完成升级。"}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          disabled={isRestartingUpdate}
                          onClick={handleQuitAndInstall}
                          className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer"
                        >
                          <RefreshCw size={13} className={isRestartingUpdate ? "animate-spin" : ""} />
                          <span>{isRestartingUpdate ? "正在重启应用..." : "立即重启并安装更新"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenReleasePage}
                          className="px-3 py-2 rounded-xl bg-[#252525] hover:bg-[#303030] text-neutral-300 text-xs font-medium border border-[#353535] transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <ExternalLink size={12} />
                          <span>备用手动下载</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {updateStatus === "error" && (
                    <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-rose-400 font-semibold">
                        <AlertCircle size={14} className="flex-shrink-0" />
                        <span>检测更新遇到异常</span>
                      </div>
                      <p className="text-[11px] text-neutral-400 font-mono break-all leading-relaxed">
                        {updateErrorMsg || "网络连接超时或无法解析 GitHub Releases 元数据。"}
                      </p>
                      <button
                        type="button"
                        onClick={handleOpenReleasePage}
                        className="px-3 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-200 text-xs font-medium border border-[#353535] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <ExternalLink size={12} />
                        <span>前往 GitHub Releases 查看最新版本</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
    </div>
  );
};

export default SettingsView;
