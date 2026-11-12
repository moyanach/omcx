/**
 * 主题与个性化外观管理：
 * 1. 亮色 (Light) / 暗色 (Dark) / 随系统 (System)
 * 2. 自定义背景图片 / 内置渐变壁纸预设
 * 3. 界面表面不透明度 (Surface Opacity: 35% ~ 100%，只透背景不降文字清晰度)
 * 4. 背景虚化程度 (Background Blur: 0px ~ 40px)
 */

export type ThemeMode = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

export interface AppearanceConfig {
  bgImage: string; // "" | "local-media://..." | "preset:..."
  surfaceOpacity: number; // 35 ~ 100 (默认 100)
  bgBlur: number; // 0 ~ 40 px (默认 16)
  contentTranslucent: boolean; // 内容面（卡片/代码/输入/气泡）是否也跟随背景通透 (默认 false)
}

export const WALLPAPER_PRESETS: Array<{
  id: string;
  name: string;
  css: string;
}> = [
  {
    id: "preset:aurora",
    name: "极光星云",
    css: "radial-gradient(circle at 18% 20%, rgba(56, 189, 248, 0.42), transparent 48%), radial-gradient(circle at 82% 28%, rgba(139, 92, 246, 0.42), transparent 52%), radial-gradient(circle at 50% 82%, rgba(16, 185, 129, 0.32), transparent 55%), linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #090d16 100%)",
  },
  {
    id: "preset:ocean",
    name: "深海晴空",
    css: "radial-gradient(circle at 20% 25%, rgba(14, 165, 233, 0.45), transparent 50%), radial-gradient(circle at 80% 75%, rgba(59, 130, 246, 0.40), transparent 55%), linear-gradient(135deg, #082f49 0%, #0f172a 55%, #1e293b 100%)",
  },
  {
    id: "preset:sunset",
    name: "暮光暖霞",
    css: "radial-gradient(circle at 22% 22%, rgba(251, 146, 60, 0.40), transparent 50%), radial-gradient(circle at 78% 30%, rgba(244, 63, 94, 0.38), transparent 52%), radial-gradient(circle at 50% 80%, rgba(168, 85, 247, 0.35), transparent 55%), linear-gradient(135deg, #1f122b 0%, #31102f 50%, #0f172a 100%)",
  },
  {
    id: "preset:emerald",
    name: "翡翠森林",
    css: "radial-gradient(circle at 25% 20%, rgba(16, 185, 129, 0.42), transparent 50%), radial-gradient(circle at 75% 75%, rgba(20, 184, 166, 0.38), transparent 55%), linear-gradient(135deg, #062c22 0%, #0f172a 60%, #091512 100%)",
  },
];

const THEME_STYLE_TAG_ID = "omcx-light-theme-styles";
const APPEARANCE_STYLE_TAG_ID = "omcx-custom-appearance-styles";

let currentAppearance: AppearanceConfig = {
  bgImage: "",
  surfaceOpacity: 100,
  bgBlur: 16,
  contentTranslucent: false,
};

const themeChangeListeners = new Set<(theme: EffectiveTheme) => void>();
const appearanceChangeListeners = new Set<(cfg: AppearanceConfig) => void>();

// 亮色模式全站定制样式表
const LIGHT_THEME_CSS = `
  /* ─── 1. 基础页面底色与滚动条 ─── */
  html[data-theme="light"],
  html[data-theme="light"] body {
    background-color: #f8fafc;
    color: #0f172a !important;
    color-scheme: light !important;
  }

  /* ─── 2. 最左侧主导航与二级抽屉底色 ─── */
  html[data-theme="light"] .bg-\\[\\#111111\\] {
    background-color: var(--sidebar-bg) !important;
    border-color: var(--ui-border-hairline) !important;
  }
  html[data-theme="light"] .bg-\\[\\#141414\\] {
    background-color: var(--ui-panel-bg) !important;
    border-color: var(--ui-border-hairline) !important;
  }
  html[data-theme="light"] .bg-\\[\\#161616\\] {
    background-color: var(--ui-stage-bg) !important;
    border-color: var(--ui-border-hairline) !important;
  }

  /* ─── 3. 大卡片、容器与卡片底色 ─── */
  html[data-theme="light"] .bg-\\[\\#1a1a1a\\],
  html[data-theme="light"] .bg-\\[\\#1c1c1c\\],
  html[data-theme="light"] .bg-\\[\\#1e1e1e\\] {
    background-color: var(--ui-card-bg) !important;
    border-color: var(--ui-border-hairline) !important;
    box-shadow: 0 1px 2px 0 rgba(15, 23, 42, 0.03) !important;
  }

  /* ─── 4. 所有内嵌小块、列表项与条目底色 ─── */
  html[data-theme="light"] .bg-\\[\\#0b0b0b\\],
  html[data-theme="light"] .bg-\\[\\#121212\\],
  html[data-theme="light"] .bg-\\[\\#131313\\],
  html[data-theme="light"] .bg-\\[\\#151515\\],
  html[data-theme="light"] .bg-\\[\\#171717\\],
  html[data-theme="light"] .bg-\\[\\#181818\\],
  html[data-theme="light"] .bg-\\[\\#191919\\],
  html[data-theme="light"] .bg-\\[\\#1b1b1b\\],
  html[data-theme="light"] .bg-\\[\\#1d1d1d\\],
  html[data-theme="light"] .bg-\\[\\#1f1f1f\\],
  html[data-theme="light"] .bg-\\[\\#202020\\],
  html[data-theme="light"] .bg-\\[\\#222222\\],
  html[data-theme="light"] .bg-\\[\\#222\\],
  html[data-theme="light"] .bg-\\[\\#232323\\],
  html[data-theme="light"] .bg-\\[\\#242424\\],
  html[data-theme="light"] .bg-\\[\\#252525\\],
  html[data-theme="light"] .bg-\\[\\#262626\\],
  html[data-theme="light"] .bg-\\[\\#272727\\],
  html[data-theme="light"] .bg-\\[\\#282828\\],
  html[data-theme="light"] .bg-\\[\\#2c2c2c\\],
  html[data-theme="light"] .bg-\\[\\#2d2d2d\\],
  html[data-theme="light"] .bg-\\[\\#2e2e2e\\],
  html[data-theme="light"] .bg-\\[\\#303030\\],
  html[data-theme="light"] .bg-\\[\\#323232\\],
  html[data-theme="light"] .bg-\\[\\#333\\],
  html[data-theme="light"] .bg-\\[\\#383838\\] {
    background-color: var(--ui-card-inner-bg) !important;
    border-color: var(--ui-border-hairline) !important;
  }

  /* ─── 5. Assistant 消息气泡专项覆盖 ─── */
  html[data-theme="light"] .bg-\\[\\#2a2a2a\\] {
    background-color: var(--ui-card-bg) !important;
    border-color: var(--ui-border-hairline) !important;
    color: #1e293b !important;
    box-shadow: 0 1px 2px 0 rgba(15, 23, 42, 0.03) !important;
  }

  /* ─── 6. 所有表单输入控件专项覆盖 ─── */
  .chat-textarea-seamless,
  .chat-textarea-seamless:focus,
  .chat-textarea-seamless:active,
  html[data-theme="light"] .chat-textarea-seamless,
  html[data-theme="light"] .chat-textarea-seamless:focus,
  html[data-theme="light"] .chat-textarea-seamless:active {
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
    -webkit-box-shadow: none !important;
    background-color: transparent !important;
  }
  html[data-theme="light"] input:not([type="range"]):not([type="checkbox"]),
  html[data-theme="light"] textarea:not(.chat-textarea-seamless),
  html[data-theme="light"] select {
    background-color: var(--ui-input-bg) !important;
    border-color: #cbd5e1 !important;
    color: #0f172a !important;
  }
  html[data-theme="light"] input::placeholder,
  html[data-theme="light"] textarea::placeholder {
    color: #94a3b8 !important;
  }
  html[data-theme="light"] input:not([type="range"]):not([type="checkbox"]):focus,
  html[data-theme="light"] textarea:not(.chat-textarea-seamless):focus,
  html[data-theme="light"] select:focus {
    border-color: #3b82f6 !important;
    box-shadow: 0 0 0 1px #3b82f6 !important;
  }
  html[data-theme="light"] option {
    background-color: #ffffff !important;
    color: #0f172a !important;
  }

  /* ─── 7. 所有硬编码深色边框与分割线统一转换为发丝级微弱浅色线 ─── */
  html[data-theme="light"] .border-\\[\\#202020\\],
  html[data-theme="light"] .border-\\[\\#222222\\],
  html[data-theme="light"] .border-\\[\\#232323\\],
  html[data-theme="light"] .border-\\[\\#242424\\],
  html[data-theme="light"] .border-\\[\\#252525\\],
  html[data-theme="light"] .border-\\[\\#262626\\],
  html[data-theme="light"] .border-\\[\\#282828\\],
  html[data-theme="light"] .border-\\[\\#292929\\],
  html[data-theme="light"] .border-\\[\\#2a2a2a\\],
  html[data-theme="light"] .border-\\[\\#2b2b2b\\],
  html[data-theme="light"] .border-\\[\\#2c2c2c\\],
  html[data-theme="light"] .border-\\[\\#2d2d2d\\],
  html[data-theme="light"] .border-\\[\\#2e2e2e\\],
  html[data-theme="light"] .border-\\[\\#2f2f2f\\],
  html[data-theme="light"] .border-\\[\\#303030\\],
  html[data-theme="light"] .border-\\[\\#333\\],
  html[data-theme="light"] .border-\\[\\#333333\\],
  html[data-theme="light"] .border-\\[\\#353535\\],
  html[data-theme="light"] .border-\\[\\#383838\\],
  html[data-theme="light"] .border-\\[\\#3a3a3a\\],
  html[data-theme="light"] .border-\\[\\#3d3d3d\\],
  html[data-theme="light"] .border-gray-700,
  html[data-theme="light"] .border-gray-700\\/50,
  html[data-theme="light"] .border-gray-700\\/70 {
    border-color: var(--ui-border-hairline) !important;
  }

  html[data-theme="light"] .divide-\\[\\#242424\\] > :not([hidden]) ~ :not([hidden]),
  html[data-theme="light"] .divide-\\[\\#262626\\] > :not([hidden]) ~ :not([hidden]),
  html[data-theme="light"] .divide-y > :not([hidden]) ~ :not([hidden]) {
    border-color: var(--ui-divider-hairline) !important;
  }

  /* ─── 8. 文字对比度与高亮映射 ─── */
  html[data-theme="light"] .text-neutral-100,
  html[data-theme="light"] .text-neutral-200 {
    color: #0f172a !important;
  }
  html[data-theme="light"] .text-neutral-300,
  html[data-theme="light"] .text-neutral-400 {
    color: #475569 !important;
  }
  html[data-theme="light"] .text-neutral-500 {
    color: #64748b !important;
  }

  /* ─── 9. Markdown 格式化内容 ─── */
  html[data-theme="light"] .prose,
  html[data-theme="light"] .markdown-body {
    color: #1e293b !important;
  }
  html[data-theme="light"] .markdown-body h1,
  html[data-theme="light"] .markdown-body h2,
  html[data-theme="light"] .markdown-body h3,
  html[data-theme="light"] .markdown-body h4,
  html[data-theme="light"] .markdown-body h5,
  html[data-theme="light"] .markdown-body h6 {
    color: #0f172a !important;
    font-weight: 700 !important;
  }
  html[data-theme="light"] .markdown-body strong,
  html[data-theme="light"] .markdown-body b {
    color: #0f172a !important;
    font-weight: 700 !important;
  }
  html[data-theme="light"] .markdown-body p,
  html[data-theme="light"] .markdown-body li {
    color: #334155 !important;
  }
  html[data-theme="light"] .markdown-body :not(pre) > code {
    background-color: var(--md-code-bg) !important;
    color: var(--md-code-text) !important;
    border: 1px solid var(--md-code-border) !important;
  }
  html[data-theme="light"] .markdown-body > pre {
    background-color: var(--ui-code-bg) !important;
    border: 1px solid var(--ui-border-hairline) !important;
  }
  html[data-theme="light"] .markdown-body > pre code {
    color: var(--ui-text-primary) !important;
    border: none !important;
  }
`;

export function getEffectiveTheme(): EffectiveTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function subscribeThemeChange(listener: (theme: EffectiveTheme) => void): () => void {
  themeChangeListeners.add(listener);
  return () => {
    themeChangeListeners.delete(listener);
  };
}

export function getAppearance(): AppearanceConfig {
  return { ...currentAppearance };
}

export function subscribeAppearanceChange(
  listener: (cfg: AppearanceConfig) => void
): () => void {
  appearanceChangeListeners.add(listener);
  return () => {
    appearanceChangeListeners.delete(listener);
  };
}

function buildAppearanceCss(cfg: AppearanceConfig): string {
  const hasBg = Boolean(cfg.bgImage && cfg.bgImage.trim());
  const pct = Math.max(35, Math.min(100, Math.round(cfg.surfaceOpacity ?? 100)));

  if (!hasBg && pct >= 100) {
    return "";
  }

  // 分层不透明度 + 内容可读性下限：外层框架/舞台包裹保持通透，承载文字与代码的内容面
  // （卡片/代码/输入框/终端）设最低不透明度，确保低通透度时前景依然清晰可读。
  // 开启「内容面通透」后放宽下限，让壁纸渐变透进内容块，并辅以毛玻璃保证文字清晰。
  const wrapPct = Math.max(20, pct - 18);
  const panelPct = Math.max(46, pct - 8);
  // 模态浮层不随面板一起变透：遮罩后面是整页内容，太透会透出鬼影
  const modalPct = Math.max(92, pct);
  const stagePct = Math.max(58, pct);
  const cardPct = cfg.contentTranslucent
    ? Math.max(40, Math.min(96, pct + 4))
    : Math.max(80, Math.min(96, pct + 4));
  const inputPct = cfg.contentTranslucent
    ? Math.max(50, Math.min(98, pct + 8))
    : Math.max(86, Math.min(98, pct + 8));

  return `
    html[data-theme="dark"], :root {
      --sidebar-bg: color-mix(in srgb, #111111 ${wrapPct}%, transparent) !important;
      --ui-app-bg: transparent !important;
      --ui-panel-bg: color-mix(in srgb, #141414 ${panelPct}%, transparent) !important;
      --ui-modal-bg: color-mix(in srgb, #141414 ${modalPct}%, transparent) !important;
      --ui-stage-wrap-bg: color-mix(in srgb, #131313 ${wrapPct}%, transparent) !important;
      --ui-stage-bg: color-mix(in srgb, #171717 ${stagePct}%, transparent) !important;
      --ui-card-bg: color-mix(in srgb, #1b1b1b ${cardPct}%, transparent) !important;
      --ui-card-header-bg: color-mix(in srgb, #1e1e1e ${cardPct}%, transparent) !important;
      --ui-card-inner-bg: color-mix(in srgb, #222222 ${cardPct}%, transparent) !important;
      --ui-input-bg: color-mix(in srgb, #1d1d1d ${inputPct}%, transparent) !important;
      --ui-input-hover-bg: color-mix(in srgb, #1f1f1f ${inputPct}%, transparent) !important;
      --ui-popover-bg: color-mix(in srgb, #161616 ${panelPct}%, transparent) !important;
      --ui-code-bg: color-mix(in srgb, #121212 ${cardPct}%, transparent) !important;
      --ui-code-header-bg: color-mix(in srgb, #181818 ${cardPct}%, transparent) !important;
      --ui-code-subheader-bg: color-mix(in srgb, #151515 ${cardPct}%, transparent) !important;
      --ui-terminal-bg: color-mix(in srgb, #0f0f10 ${cardPct}%, transparent) !important;
      --ui-bubble-assistant-bg: color-mix(in srgb, #1b1b1b ${cardPct}%, transparent) !important;
      --ui-bubble-user-bg: color-mix(in srgb, #2a2a2a ${inputPct}%, transparent) !important;
      --ui-livebar-bg: color-mix(in srgb, #161616 ${inputPct}%, transparent) !important;
      --ui-block-bg: color-mix(in srgb, #1b1b1b ${cardPct}%, transparent) !important;
      --ui-block-body-bg: color-mix(in srgb, #141414 ${cardPct}%, transparent) !important;
    }

    html[data-theme="light"] {
      --sidebar-bg: color-mix(in srgb, #f1f5f9 ${wrapPct}%, transparent) !important;
      --ui-app-bg: transparent !important;
      --ui-panel-bg: color-mix(in srgb, #f8fafc ${panelPct}%, transparent) !important;
      --ui-modal-bg: color-mix(in srgb, #ffffff ${modalPct}%, transparent) !important;
      --ui-stage-wrap-bg: color-mix(in srgb, #f1f5f9 ${wrapPct}%, transparent) !important;
      --ui-stage-bg: color-mix(in srgb, #ffffff ${stagePct}%, transparent) !important;
      --ui-card-bg: color-mix(in srgb, #ffffff ${cardPct}%, transparent) !important;
      --ui-card-header-bg: color-mix(in srgb, #fafbfd ${cardPct}%, transparent) !important;
      --ui-card-inner-bg: color-mix(in srgb, #f8fafc ${cardPct}%, transparent) !important;
      --ui-input-bg: color-mix(in srgb, #ffffff ${inputPct}%, transparent) !important;
      --ui-input-hover-bg: color-mix(in srgb, #f8fafc ${inputPct}%, transparent) !important;
      --ui-popover-bg: color-mix(in srgb, #ffffff ${panelPct}%, transparent) !important;
      --ui-code-bg: color-mix(in srgb, #f8fafc ${cardPct}%, transparent) !important;
      --ui-code-header-bg: color-mix(in srgb, #f1f5f9 ${cardPct}%, transparent) !important;
      --ui-code-subheader-bg: color-mix(in srgb, #f8fafc ${cardPct}%, transparent) !important;
      --ui-terminal-bg: color-mix(in srgb, #f8fafc ${cardPct}%, transparent) !important;
      --ui-bubble-assistant-bg: color-mix(in srgb, #ffffff ${cardPct}%, transparent) !important;
      --ui-bubble-user-bg: color-mix(in srgb, #f1f5f9 ${inputPct}%, transparent) !important;
      --ui-livebar-bg: color-mix(in srgb, #ffffff ${inputPct}%, transparent) !important;
      --ui-block-bg: color-mix(in srgb, #ffffff ${cardPct}%, transparent) !important;
      --ui-block-body-bg: color-mix(in srgb, #f8fafc ${cardPct}%, transparent) !important;
    }

    /* 同步覆盖设置页、工具页、工作空间页的硬编码深色容器，使其在暗色模式下同样具备通透感 */
    html[data-theme="dark"] .bg-\\[\\#111111\\] {
      background-color: var(--sidebar-bg) !important;
    }
    html[data-theme="dark"] .bg-\\[\\#141414\\],
    html[data-theme="dark"] .bg-\\[\\#161616\\] {
      background-color: var(--ui-panel-bg) !important;
    }
    html[data-theme="dark"] .bg-\\[\\#131313\\] {
      background-color: var(--ui-stage-wrap-bg) !important;
    }
    html[data-theme="dark"] .bg-\\[\\#1a1a1a\\],
    html[data-theme="dark"] .bg-\\[\\#1b1b1b\\],
    html[data-theme="dark"] .bg-\\[\\#1c1c1c\\],
    html[data-theme="dark"] .bg-\\[\\#1e1e1e\\],
    html[data-theme="dark"] .bg-\\[\\#2a2a2a\\] {
      background-color: var(--ui-card-bg) !important;
    }
    html[data-theme="dark"] .bg-\\[\\#0b0b0b\\],
    html[data-theme="dark"] .bg-\\[\\#121212\\],
    html[data-theme="dark"] .bg-\\[\\#151515\\],
    html[data-theme="dark"] .bg-\\[\\#171717\\],
    html[data-theme="dark"] .bg-\\[\\#181818\\],
    html[data-theme="dark"] .bg-\\[\\#191919\\],
    html[data-theme="dark"] .bg-\\[\\#1d1d1d\\],
    html[data-theme="dark"] .bg-\\[\\#1f1f1f\\],
    html[data-theme="dark"] .bg-\\[\\#202020\\],
    html[data-theme="dark"] .bg-\\[\\#222222\\],
    html[data-theme="dark"] .bg-\\[\\#222\\],
    html[data-theme="dark"] .bg-\\[\\#232323\\],
    html[data-theme="dark"] .bg-\\[\\#242424\\],
    html[data-theme="dark"] .bg-\\[\\#252525\\],
    html[data-theme="dark"] .bg-\\[\\#262626\\],
    html[data-theme="dark"] .bg-\\[\\#272727\\],
    html[data-theme="dark"] .bg-\\[\\#282828\\],
    html[data-theme="dark"] .bg-\\[\\#2c2c2c\\],
    html[data-theme="dark"] .bg-\\[\\#2d2d2d\\],
    html[data-theme="dark"] .bg-\\[\\#2e2e2e\\],
    html[data-theme="dark"] .bg-\\[\\#303030\\],
    html[data-theme="dark"] .bg-\\[\\#323232\\],
    html[data-theme="dark"] .bg-\\[\\#333\\],
    html[data-theme="dark"] .bg-\\[\\#383838\\] {
      background-color: var(--ui-card-inner-bg) !important;
    }

    ${
      cfg.contentTranslucent
        ? `
    /* 内容面通透：对承载文字/代码的内容块施加毛玻璃虚化，
       让壁纸渐变透出的同时保证前景文字清晰可读 */
    .bg-\\[var\\(--ui-card-bg\\)\\],
    .bg-\\[var\\(--ui-card-inner-bg\\)\\],
    .bg-\\[var\\(--ui-code-bg\\)\\],
    .bg-\\[var\\(--ui-input-bg\\)\\],
    .bg-\\[var\\(--ui-terminal-bg\\)\\],
    .bg-\\[var\\(--ui-bubble-assistant-bg\\)\\],
    .bg-\\[var\\(--ui-bubble-user-bg\\)\\],
    .bg-\\[var\\(--ui-livebar-bg\\)\\],
    .bg-\\[var\\(--ui-block-bg\\)\\],
    .bg-\\[var\\(--ui-block-body-bg\\)\\] {
      backdrop-filter: blur(12px) saturate(1.05);
      -webkit-backdrop-filter: blur(12px) saturate(1.05);
    }
    `
        : ""
    }
  `;
}

function applyAppearanceToDom(cfg: AppearanceConfig) {
  currentAppearance = {
    bgImage: String(cfg.bgImage || "").trim(),
    surfaceOpacity: Math.max(35, Math.min(100, Number(cfg.surfaceOpacity) || 100)),
    bgBlur: Math.max(0, Math.min(40, Number(cfg.bgBlur ?? 16))),
    contentTranslucent: Boolean(cfg.contentTranslucent),
  };

  const css = buildAppearanceCss(currentAppearance);
  let styleEl = document.getElementById(APPEARANCE_STYLE_TAG_ID) as HTMLStyleElement | null;

  if (!css) {
    if (styleEl) styleEl.remove();
  } else {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = APPEARANCE_STYLE_TAG_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  appearanceChangeListeners.forEach((cb) => {
    try {
      cb(currentAppearance);
    } catch {
      // ignore
    }
  });
}

export async function setAppearance(patch: Partial<AppearanceConfig>) {
  const next: AppearanceConfig = {
    ...currentAppearance,
    ...patch,
  };
  applyAppearanceToDom(next);

  if (window.electronAPI?.setConfig) {
    try {
      await Promise.all([
        window.electronAPI.setConfig("appearance_bg_image", next.bgImage),
        window.electronAPI.setConfig(
          "appearance_surface_opacity",
          String(next.surfaceOpacity)
        ),
        window.electronAPI.setConfig("appearance_bg_blur", String(next.bgBlur)),
        window.electronAPI.setConfig(
          "appearance_content_translucent",
          next.contentTranslucent ? "1" : "0"
        ),
      ]);
    } catch (err) {
      console.error("保存个性化外观失败:", err);
    }
  }
}

export async function loadAppearance(): Promise<AppearanceConfig> {
  if (window.electronAPI?.getConfig) {
    try {
      const [bgImage, opacityStr, blurStr, translucentStr] = await Promise.all([
        window.electronAPI.getConfig("appearance_bg_image"),
        window.electronAPI.getConfig("appearance_surface_opacity"),
        window.electronAPI.getConfig("appearance_bg_blur"),
        window.electronAPI.getConfig("appearance_content_translucent"),
      ]);
      const loaded: AppearanceConfig = {
        bgImage: bgImage ? String(bgImage) : "",
        surfaceOpacity:
          opacityStr !== null && opacityStr !== undefined && opacityStr !== ""
            ? Number(opacityStr)
            : 100,
        bgBlur:
          blurStr !== null && blurStr !== undefined && blurStr !== ""
            ? Number(blurStr)
            : 16,
        contentTranslucent: translucentStr === "1" || translucentStr === "true",
      };
      applyAppearanceToDom(loaded);
      return loaded;
    } catch {
      // ignore
    }
  }
  return currentAppearance;
}

function injectLightStyles() {
  let styleEl = document.getElementById(THEME_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = THEME_STYLE_TAG_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = LIGHT_THEME_CSS;
}

function removeLightStyles() {
  const styleEl = document.getElementById(THEME_STYLE_TAG_ID);
  if (styleEl) {
    styleEl.remove();
  }
}

function applyThemeToDom(effectiveMode: EffectiveTheme) {
  if (effectiveMode === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
    injectLightStyles();
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
    removeLightStyles();
  }
  themeChangeListeners.forEach((cb) => {
    try {
      cb(effectiveMode);
    } catch {
      // ignore listener errors
    }
  });
}

let systemMediaListener: ((e: MediaQueryListEvent) => void) | null = null;

function setupSystemListener(active: boolean) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  if (systemMediaListener) {
    media.removeEventListener("change", systemMediaListener);
    systemMediaListener = null;
  }
  if (active) {
    systemMediaListener = (e: MediaQueryListEvent) => {
      applyThemeToDom(e.matches ? "dark" : "light");
    };
    media.addEventListener("change", systemMediaListener);
  }
}

export async function setTheme(mode: ThemeMode) {
  if (window.electronAPI?.setConfig) {
    try {
      await window.electronAPI.setConfig("theme", mode);
    } catch (err) {
      console.error("保存主题配置失败:", err);
    }
  }

  if (mode === "system") {
    setupSystemListener(true);
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyThemeToDom(isDark ? "dark" : "light");
  } else {
    setupSystemListener(false);
    applyThemeToDom(mode);
  }
}

export async function loadTheme(): Promise<ThemeMode> {
  let savedMode: ThemeMode = "dark";

  if (window.electronAPI?.getConfig) {
    try {
      const val = await window.electronAPI.getConfig("theme");
      if (val === "light" || val === "dark" || val === "system") {
        savedMode = val;
      }
    } catch {
      savedMode = "dark";
    }
  }

  await setTheme(savedMode);
  await loadAppearance();
  return savedMode;
}

export function initTheme() {
  document.documentElement.setAttribute("data-theme", "dark");
  document.documentElement.classList.add("dark");
  removeLightStyles();
}
