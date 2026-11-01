/**
 * 主题管理：亮色 (Light) / 暗色 (Dark) / 随系统 (System)
 *
 * 核心设计：
 * 1. 默认暗色：首次进入或未设置时默认启用暗夜高质感风格
 * 2. 动态亮色：当切换为 light 时，通过精确注入定制样式表完成全站优雅亮白切换
 * 3. 持久化存储：通过 window.electronAPI.setConfig 保存用户偏好至 ~/.omcx/config.json
 * 4. 随系统自适应：监听系统 prefers-color-scheme
 */

export type ThemeMode = "light" | "dark" | "system";

const THEME_STYLE_TAG_ID = "omcx-light-theme-styles";

// 亮色模式全站定制样式表 (彻底消灭所有深色残留，呈现纯净现代的 IDE 质感)
const LIGHT_THEME_CSS = `
  /* ─── 1. 基础页面底色与滚动条 ─── */
  html[data-theme="light"],
  html[data-theme="light"] body {
    background-color: #f8fafc !important;
    color: #0f172a !important;
    color-scheme: light !important;
  }

  /* ─── 2. 最左侧主导航与二级抽屉底色 ─── */
  html[data-theme="light"] .bg-\\[\\#111111\\] {
    background-color: #f1f5f9 !important;
    border-color: #e2e8f0 !important;
  }
  html[data-theme="light"] .bg-\\[\\#141414\\] {
    background-color: #f8fafc !important;
    border-color: #e2e8f0 !important;
  }
  html[data-theme="light"] .bg-\\[\\#161616\\] {
    background-color: #ffffff !important;
    border-color: #e2e8f0 !important;
  }

  /* ─── 3. 大卡片、容器与卡片底色 ─── */
  html[data-theme="light"] .bg-\\[\\#1a1a1a\\],
  html[data-theme="light"] .bg-\\[\\#1c1c1c\\],
  html[data-theme="light"] .bg-\\[\\#1e1e1e\\] {
    background-color: #ffffff !important;
    border-color: #e2e8f0 !important;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04) !important;
  }

  /* ─── 4. 所有内嵌小块、列表项与条目底色 (彻底消灭图 12 与图 13 的黑块) ─── */
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
    background-color: #f8fafc !important;
    border-color: #e2e8f0 !important;
  }

  /* ─── 5. Assistant 消息气泡专项覆盖 (彻底解决图 13 消息气泡黑底) ─── */
  html[data-theme="light"] .bg-\\[\\#2a2a2a\\] {
    background-color: #ffffff !important;
    border-color: #e2e8f0 !important;
    color: #1e293b !important;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05) !important;
  }

  /* ─── 6. 所有表单输入控件专项覆盖 (彻底解决图 12 设置页输入框黑底) ─── */
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
  html[data-theme="light"] input,
  html[data-theme="light"] textarea:not(.chat-textarea-seamless),
  html[data-theme="light"] select {
    background-color: #ffffff !important;
    border-color: #cbd5e1 !important;
    color: #0f172a !important;
  }
  html[data-theme="light"] input::placeholder,
  html[data-theme="light"] textarea:placeholder {
    color: #94a3b8 !important;
  }
  html[data-theme="light"] input:focus,
  html[data-theme="light"] textarea:not(.chat-textarea-seamless):focus,
  html[data-theme="light"] select:focus {
    background-color: #ffffff !important;
    border-color: #3b82f6 !important;
    box-shadow: 0 0 0 1px #3b82f6 !important;
  }
  html[data-theme="light"] option {
    background-color: #ffffff !important;
    color: #0f172a !important;
  }

  /* ─── 7. 所有 19 组硬编码深色边框与分割线统一转换为浅灰 ─── */
  html[data-theme="light"] .border-\\[\\#202020\\],
  html[data-theme="light"] .border-\\[\\#222222\\],
  html[data-theme="light"] .border-\\[\\#232323\\],
  html[data-theme="light"] .border-\\[\\#242424\\],
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
  html[data-theme="light"] .border-\\[\\#353535\\],
  html[data-theme="light"] .border-\\[\\#383838\\],
  html[data-theme="light"] .border-\\[\\#3a3a3a\\],
  html[data-theme="light"] .border-\\[\\#3d3d3d\\],
  html[data-theme="light"] .border-gray-700,
  html[data-theme="light"] .border-gray-700\\/50,
  html[data-theme="light"] .border-gray-700\\/70 {
    border-color: #e2e8f0 !important;
  }

  /* 解决图 19：步骤列表分割线在亮色模式下过深不协调问题 */
  html[data-theme="light"] .divide-\\[\\#242424\\] > :not([hidden]) ~ :not([hidden]),
  html[data-theme="light"] .divide-\\[\\#262626\\] > :not([hidden]) ~ :not([hidden]),
  html[data-theme="light"] .divide-y > :not([hidden]) ~ :not([hidden]) {
    border-color: #f1f5f9 !important;
  }

  /* Tailwind 灰色类在亮色模式下的自适应 */
  html[data-theme="light"] .bg-gray-700 {
    background-color: #e2e8f0 !important;
    color: #475569 !important;
  }
  html[data-theme="light"] .bg-gray-800,
  html[data-theme="light"] .bg-gray-800\\/40,
  html[data-theme="light"] .bg-gray-950\\/60 {
    background-color: #f1f5f9 !important;
    border-color: #e2e8f0 !important;
    color: #334155 !important;
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
  html[data-theme="light"] .text-gray-200,
  html[data-theme="light"] .text-gray-300 {
    color: #0f172a !important;
  }
  html[data-theme="light"] .text-gray-400,
  html[data-theme="light"] .text-gray-500 {
    color: #64748b !important;
  }

  /* ─── 9. Markdown 格式化内容 (解决图 20 标题在亮色模式下发白看不清的问题) ─── */
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
  html[data-theme="light"] .markdown-body code {
    background-color: #f1f5f9 !important;
    color: #2563eb !important;
    border: 1px solid #e2e8f0 !important;
  }
  html[data-theme="light"] .markdown-body pre {
    background-color: #f8fafc !important;
    border: 1px solid #e2e8f0 !important;
  }
  html[data-theme="light"] .markdown-body pre code {
    color: #0f172a !important;
    border: none !important;
  }

  /* ─── 10. 滚动条浅色外观 ─── */
  html[data-theme="light"] ::-webkit-scrollbar-thumb {
    background: #cbd5e1 !important;
  }
  html[data-theme="light"] ::-webkit-scrollbar-thumb:hover {
    background: #94a3b8 !important;
  }
`;

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

/**
 * 将具体模式应用至 DOM
 */
function applyThemeToDom(effectiveMode: "light" | "dark") {
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
}

// 监听系统亮暗变化
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

/**
 * 设置并应用主题
 */
export async function setTheme(mode: ThemeMode) {
  // 持久化保存到配置文件
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

/**
 * 启动时加载已保存的主题（未保存时默认 dark）
 */
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
  return savedMode;
}

/**
 * 同步初始化（避免白屏闪烁）
 */
export function initTheme() {
  document.documentElement.setAttribute("data-theme", "dark");
  document.documentElement.classList.add("dark");
  removeLightStyles();
}
