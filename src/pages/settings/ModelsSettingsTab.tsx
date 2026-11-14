import React, { useState, useEffect } from "react";
import {
  Cpu,
  Trash2,
  Pencil,
  RefreshCw,
  Eye,
  EyeOff,
  Plus,
  Sliders,
  Save,
} from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import {
  PROVIDER_PRESETS,
  CONTEXT_LIMIT_OPTIONS,
  inferVisionSupport,
  EditableModelCombobox,
  createEmptyRow,
  type ModelDraftRow,
} from "./providerPresets";

interface ModelsSettingsTabProps {
  showToast: (msg: string) => void;
}

export const ModelsSettingsTab: React.FC<ModelsSettingsTabProps> = ({ showToast }) => {
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

  useEffect(() => {
    loadModels();
  }, []);

  return (
              <div className="space-y-6">
                {/* 模型添加/编辑卡片 */}
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-5 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] pb-3">
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
                          className="px-3 py-1.5 rounded-lg ui-btn-primary disabled:opacity-50 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
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
                      className="px-5 py-2 rounded-xl ui-btn-primary text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
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
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-5 shadow-sm space-y-3">
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
  );
};
