import React, { useState, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  FolderOpen,
  Save,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { SoftwareUpdateSection } from "./SoftwareUpdateSection";

interface GeneralSettingsTabProps {
  showToast: (msg: string) => void;
}

export const GeneralSettingsTab: React.FC<GeneralSettingsTabProps> = ({ showToast }) => {
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

  // 思考内容（Reasoning）保存与协议回传策略
  const [reasoningPersistence, setReasoningPersistence] = useState<
    "full" | "truncated" | "off"
  >("full");
  const [reasoningReplayScope, setReasoningReplayScope] = useState<
    "current-run" | "window" | "off"
  >("window");
  const [reasoningReplayWindow, setReasoningReplayWindow] = useState(3);

  // 全局自定义系统提示词
  const [customSystemPrompt, setCustomSystemPrompt] = useState("");


  const { settingsSessions, settingsActiveSessionId } = useChatStore(
    useShallow((s) => ({
      settingsSessions: s.sessions,
      settingsActiveSessionId: s.activeSessionId,
    }))
  );
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

      const savedReasoningPersistence = await window.electronAPI.getConfig(
        "reasoning_persistence"
      );
      if (
        savedReasoningPersistence === "full" ||
        savedReasoningPersistence === "truncated" ||
        savedReasoningPersistence === "off"
      ) {
        setReasoningPersistence(savedReasoningPersistence);
      }

      const savedReplayScope = await window.electronAPI.getConfig("reasoning_replay_scope");
      if (savedReplayScope === "current-run" || savedReplayScope === "window" || savedReplayScope === "off") {
        setReasoningReplayScope(savedReplayScope);
      }

      const savedReplayWindow = await window.electronAPI.getConfig("reasoning_replay_window");
      const parsedReplayWindow = Number(savedReplayWindow);
      if (Number.isFinite(parsedReplayWindow) && parsedReplayWindow > 0) {
        setReasoningReplayWindow(Math.min(20, Math.max(1, Math.floor(parsedReplayWindow))));
      }

      const savedPrompt = await window.electronAPI.getConfig("custom_system_prompt");
      if (savedPrompt) setCustomSystemPrompt(savedPrompt);

      loadHooksInfo();
    };
    loadConfigs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadHooksInfo(hooksWorkDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleSaveReasoningConfig = async () => {
    if (!window.electronAPI) return;
    try {
      const safeWindow = Math.min(20, Math.max(1, Math.floor(Number(reasoningReplayWindow) || 3)));
      setReasoningReplayWindow(safeWindow);
      await window.electronAPI.setConfig("reasoning_persistence", reasoningPersistence);
      await window.electronAPI.setConfig("reasoning_replay_scope", reasoningReplayScope);
      await window.electronAPI.setConfig("reasoning_replay_window", String(safeWindow));
      showToast("思考内容策略已保存，将在下一次对话请求生效");
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
    <div className="space-y-5">
      <AppearanceSettingsSection showToast={showToast} />
                {/* Hooks 生命周期钩子 */}
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-4">
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
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-4">
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
                      className="px-4 py-2 rounded-xl ui-btn-primary text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
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
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-4">
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
                      className="px-4 py-2 rounded-xl ui-btn-primary text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
                    >
                      <Save size={13} />
                      <span>保存超时时间</span>
                    </button>
                    <span className="text-[11px] text-neutral-500">单位：秒（30 ~ 1800）</span>
                  </div>
                </div>

                {/* 上下文自动压缩 (Context Compaction) */}
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-4">
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
                      className="px-4 py-2 rounded-xl ui-btn-primary text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
                    >
                      <Save size={13} />
                      <span>保存压缩配置</span>
                    </button>
                  </div>
                </div>

                {/* 思考内容保存与回传策略 (Reasoning Persistence & Replay) */}
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3">
                    <h3 className="text-xs font-bold text-neutral-100 tracking-wide">
                      思考内容策略 (Reasoning Persistence &amp; Replay)
                    </h3>
                    <p className="text-[11px] text-neutral-500 mt-0.5">
                      分别控制「思考内容是否落盘」与「是否把思考回传给上游模型」；回传是协议正确性所需（DeepSeek 带工具调用、Anthropic 多轮工具循环），落盘仅影响历史回溯
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-neutral-300">持久化策略</div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                      {[
                        {
                          key: "full" as const,
                          title: "全量保存",
                          desc: "完整落盘思考全文，支持历史回溯与续跑",
                        },
                        {
                          key: "truncated" as const,
                          title: "压缩保存",
                          desc: "保留头 8000 + 尾 2000 字符，控制库体积",
                        },
                        {
                          key: "off" as const,
                          title: "不保存",
                          desc: "仅本次运行内存保留，重启后折叠条消失",
                        },
                      ].map((option) => (
                        <label
                          key={option.key}
                          className={`flex flex-col gap-1 p-3 rounded-xl border cursor-pointer select-none transition-colors ${
                            reasoningPersistence === option.key
                              ? "bg-blue-500/10 border-blue-500/40"
                              : "bg-[#181818] border-[#292929] hover:border-[#343434]"
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="reasoning_persistence"
                              checked={reasoningPersistence === option.key}
                              onChange={() => setReasoningPersistence(option.key)}
                              className="accent-blue-600 cursor-pointer"
                            />
                            <span className="text-xs font-medium text-neutral-200">
                              {option.title}
                            </span>
                          </span>
                          <span className="text-[11px] text-neutral-500 leading-relaxed">
                            {option.desc}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[11px] text-neutral-500">
                      注意：选择「不保存」只影响落盘，不影响当前回合的实时展示与协议回传正确性
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-neutral-300">
                        推理回传范围
                      </label>
                      <select
                        value={reasoningReplayScope}
                        onChange={(e) =>
                          setReasoningReplayScope(
                            e.target.value as "current-run" | "window" | "off"
                          )
                        }
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-blue-500 cursor-pointer"
                      >
                        <option value="current-run">仅当前运行（成本最低）</option>
                        <option value="window">最近 N 个用户轮次（质量更好）</option>
                        <option value="off">不回传（不推荐，可能掉质量）</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-neutral-300">
                        回传窗口轮次
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={reasoningReplayWindow}
                        disabled={reasoningReplayScope !== "window"}
                        onChange={(e) =>
                          setReasoningReplayWindow(Number(e.target.value) || 3)
                        }
                        className="w-full bg-[#171717] border border-[#2e2e2e] rounded-xl px-3 py-2 text-xs font-mono text-neutral-200 outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-neutral-500 leading-relaxed">
                    回传行为随模型厂商自适应：Anthropic 的 thinking block + signature 属协议必需项（始终在同一轮内回传，不受上方开关影响）；OpenAI 兼容端点仅在携带工具时回传 reasoning_content。回填窗口默认为最近 {reasoningReplayWindow} 个用户轮次。
                  </p>

                  <div className="flex justify-end">
                    <button
                      onClick={handleSaveReasoningConfig}
                      className="px-4 py-2 rounded-xl ui-btn-primary text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
                    >
                      <Save size={13} />
                      <span>保存思考策略</span>
                    </button>
                  </div>
                </div>

                {/* 全局自定义系统提示词 (Custom System Prompt) */}
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-4">
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
                        className="px-4 py-2 rounded-xl ui-btn-primary text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
                      >
                        <Save size={13} />
                        <span>保存自定义提示词</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Agent 配置文件目录 */}
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-3">
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
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-3">
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

      <SoftwareUpdateSection showToast={showToast} />
    </div>
  );
};
