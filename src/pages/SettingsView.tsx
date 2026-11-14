import React, { useState } from "react";
import {
  Settings as SettingsIcon,
  Cpu,
  Sliders,
  CheckCircle2,
  ArrowLeft,
  X,
} from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { type ModelDraftRow } from "./settings/providerPresets";
import { ModelsSettingsTab } from "./settings/ModelsSettingsTab";
import { GeneralSettingsTab } from "./settings/GeneralSettingsTab";

export type { ModelDraftRow };

interface SettingsViewProps {
  /** 渲染形态：整页路由或覆盖式弹层 */
  variant?: "page" | "modal";
  /** 弹层模式下关闭弹层的回调 */
  onClose?: () => void;
}

const SettingsView: React.FC<SettingsViewProps> = ({ variant = "page", onClose }) => {
  const isModal = variant === "modal";
  const [activeTab, setActiveTab] = useState<"general" | "models">("models");
  const setActiveNavTab = useAppStore((s) => s.setActiveNavTab);
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  };

  return (
    <div
      className={`relative flex h-full w-full overflow-hidden select-none flex-col ${
        isModal
          ? "bg-transparent rounded-2xl"
          : "bg-[var(--ui-panel-bg)] backdrop-blur-xl backdrop-saturate-150"
      }`}
    >
      {/* Toast 提示（弹层内定位在面板顶部，整页模式仍固定在窗口顶部） */}
      <div
        className={`${
          isModal ? "absolute top-3" : "fixed top-6"
        } left-1/2 -translate-x-1/2 flex items-center gap-2 ui-btn-primary backdrop-blur-xl px-4 py-2 rounded-xl shadow-lg transition-all duration-300 z-50 ${
          toastMsg ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4 pointer-events-none"
        }`}
      >
        <CheckCircle2 size={16} />
        <span className="text-xs font-medium">{toastMsg}</span>
      </div>

      {/* 顶部 Header：整页模式返回会话；弹层模式仅保留标题、Esc 提示与关闭按钮 */}
      <div
        className={`h-12 border-b border-[color:var(--ui-divider-hairline)] px-5 flex items-center justify-between flex-shrink-0 ${
          isModal ? "" : "bg-transparent titlebar-drag"
        }`}
      >
        <div className="flex items-center gap-2 text-[var(--ui-text-primary)] font-semibold text-xs tracking-wide">
          {!isModal && (
            <button
              onClick={() => setActiveNavTab("sessions")}
              className="p-1 rounded-md text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors titlebar-no-drag"
              title="返回会话"
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <SettingsIcon size={16} className="text-[var(--ui-accent-blue)]" />
          <span>系统设置</span>
        </div>

        {isModal && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-[var(--ui-text-muted)] px-1.5 py-0.5 rounded border border-[color:var(--ui-border-hairline)] bg-[var(--ui-chip-bg)]">
              Esc
            </span>
            <button
              onClick={onClose}
              className="p-1 rounded-md text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors"
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
          <div className="flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] pb-4">
            <div>
              <h2 className="text-sm font-bold text-[var(--ui-text-primary)]">
                {activeTab === "models" && "大模型服务商与模型配置"}
                {activeTab === "general" && "通用设置、外观主题与上下文"}
              </h2>
              <p className="text-[11px] text-[var(--ui-text-muted)] mt-0.5">
                {activeTab === "models" && "配置 OpenAI 兼容模型、专属 API Key、上下文上限与视觉输入能力"}
                {activeTab === "general" && "外观主题、Agent 最大执行轮次与长对话上下文自动压缩"}
              </p>
            </div>

            {/* 双 Tab 切换器 */}
            <div className="flex items-center gap-1.5 bg-[var(--ui-card-inner-bg)] p-1 rounded-xl border border-[color:var(--ui-border-hairline)] flex-shrink-0">
              <button
                onClick={() => setActiveTab("models")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === "models"
                    ? "ui-btn-primary font-medium shadow-sm"
                    : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
                }`}
              >
                <Cpu size={14} />
                <span>模型配置</span>
              </button>
              <button
                onClick={() => setActiveTab("general")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
                  activeTab === "general"
                    ? "ui-btn-primary font-medium shadow-sm"
                    : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]"
                }`}
              >
                <Sliders size={14} />
                <span>通用与外观</span>
              </button>
            </div>
          </div>
            {/* ═════════ 1. 模型配置 TAB (重塑现代化四步操作流) ═════════ */}
            {activeTab === "models" && <ModelsSettingsTab showToast={showToast} />}
            {activeTab === "general" && <GeneralSettingsTab showToast={showToast} />}
          </div>
        </div>
    </div>
  );
};

export default SettingsView;
