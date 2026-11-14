import React, { useState, useEffect, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";

// 热门服务商预设 (自动预填官方/常用 Base URL)
export const PROVIDER_PRESETS: Record<
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
export const CONTEXT_LIMIT_OPTIONS = [
  { value: 128000, label: "128k (128,000 tokens - 推荐)" },
  { value: 200000, label: "200k (200,000 tokens - Claude / GLM)" },
  { value: 1000000, label: "1M (1,000,000 tokens - 超长上下文)" },
  { value: 64000, label: "64k (64,000 tokens)" },
  { value: 32000, label: "32k (32,000 tokens)" },
  { value: 16000, label: "16k (16,000 tokens)" },
];

export const VISION_MODEL_HINTS = [
  "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5",
  "claude-3", "claude-4", "claude-sonnet", "claude-opus", "claude-haiku",
  "gemini", "glm-4v", "glm-4.5v", "glm-4.6v",
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl",
  "llava", "pixtral", "vision", "internvl", "minicpm-v", "moondream", "yi-vl",
];

export const inferVisionSupport = (modelId: string) => {
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
export const EditableModelCombobox: React.FC<{
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

export const createEmptyRow = (defaultContext = 128000): ModelDraftRow => ({
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
