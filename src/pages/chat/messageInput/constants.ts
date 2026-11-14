import React from "react";
import {
  Compass,
  ShieldCheck,
  ShieldQuestion,
  ShieldAlert,
  Brain,
  Zap,
  Sparkles,
  Flame,
  Rocket,
} from "lucide-react";
import { type PermissionMode, type ReasoningEffort } from "@/stores/chatStore";

export const PERMISSION_MODE_OPTIONS: Array<{
  id: PermissionMode;
  label: string;
  shortLabel: string;
  sandboxTag: string;
  recommended?: boolean;
  description: string;
  icon: React.ElementType;
  badgeClass: string;
  iconClass: string;
}> = [
  {
    id: "plan",
    label: "只读规划",
    shortLabel: "只读规划",
    sandboxTag: "Seatbelt 只读沙箱",
    description: "仅允许检索、阅读代码与架构规划，隐藏写文件工具并锁定只读命令沙箱",
    icon: Compass,
    badgeClass:
      "bg-[var(--ui-accent-sky-soft)] text-[var(--ui-accent-sky)] border-[color:var(--ui-accent-sky-border)]",
    iconClass: "text-[var(--ui-accent-sky)]",
  },
  {
    id: "auto-sandbox",
    label: "工作区沙箱",
    shortLabel: "工作区沙箱",
    sandboxTag: "Seatbelt 写隔离",
    recommended: true,
    description: "工作区内文件读写与常规命令自动放行，内核级拦截越界写入与敏感凭据读取",
    icon: ShieldCheck,
    badgeClass:
      "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]",
    iconClass: "text-[var(--ui-accent-emerald)]",
  },
  {
    id: "ask",
    label: "询问确认",
    shortLabel: "询问确认",
    sandboxTag: "Seatbelt 写隔离",
    description: "每次修改文件或执行命令前请求确认，命令同样受工作区沙箱边界保护",
    icon: ShieldQuestion,
    badgeClass:
      "bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border-[color:var(--ui-accent-amber-border)]",
    iconClass: "text-[var(--ui-accent-amber)]",
  },
  {
    id: "full-access",
    label: "完全访问",
    shortLabel: "完全访问",
    sandboxTag: "关闭命令沙箱",
    description: "解除命令级 OS 沙箱限制，仅对高危破坏性命令与工作区外写入请求确认",
    icon: ShieldAlert,
    badgeClass:
      "bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)] border-[color:var(--ui-accent-rose-border)]",
    iconClass: "text-[var(--ui-accent-rose)]",
  },
];

export interface ReasoningOption {
  id: ReasoningEffort;
  level: number;
  label: string;
  shortLabel: string;
  badge: string;
  description: string;
  icon: React.ElementType;
  colorClass: string;
  bgClass: string;
  recommended?: boolean;
}

export const REASONING_OPTIONS: ReasoningOption[] = [
  {
    id: "off",
    level: 0,
    label: "关闭 (Off)",
    shortLabel: "极速响应",
    badge: "常规",
    description: "无显式思考过程，直接生成答复，响应最快且不消耗额外思考 Token",
    icon: Zap,
    colorClass: "text-neutral-400",
    bgClass: "bg-neutral-500/10 text-neutral-300 border-neutral-700/50",
  },
  {
    id: "low",
    level: 1,
    label: "低 (Low)",
    shortLabel: "轻量思考",
    badge: "轻快",
    description: "约 2k tokens 思考预算，适合简单语法查错、函数注释生成与概念解释",
    icon: Sparkles,
    colorClass: "text-sky-400",
    bgClass: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  },
  {
    id: "medium",
    level: 2,
    label: "中 (Medium)",
    shortLabel: "推荐思考",
    badge: "推荐",
    recommended: true,
    description: "约 4k tokens 思考预算，平衡响应速度与逻辑严密性，适合日常工程开发",
    icon: Brain,
    colorClass: "text-emerald-400",
    bgClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  },
  {
    id: "high",
    level: 3,
    label: "高 (High)",
    shortLabel: "深度思考",
    badge: "深度",
    description: "约 8k tokens 思考预算，适合疑难 Bug 排查、跨模块重构与算法推演",
    icon: Flame,
    colorClass: "text-amber-400",
    bgClass: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  },
  {
    id: "max",
    level: 4,
    label: "极高 (Max)",
    shortLabel: "极限深思",
    badge: "极高",
    description: "16k+ tokens 极限深度演算，针对大型工程系统架构设计与极复杂数学证明",
    icon: Rocket,
    colorClass: "text-rose-400",
    bgClass: "bg-rose-500/10 text-rose-400 border-rose-500/30",
  },
];

export const MENTION_TRIGGER = /(?:^|[\s(（[【"'`\u4e00-\u9fa5])@([^\s@]*)$/;
