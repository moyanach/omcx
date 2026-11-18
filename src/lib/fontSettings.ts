/**
 * 字体设置：界面字体、终端字体与终端字号
 *
 * - 持久化到 ~/.omcx/config.json 的 font_settings 键
 * - localStorage 仅作为启动首帧的本地缓存，避免字体闪烁
 * - 通过 CSS 变量与自定义事件同步到 App / 终端
 */

export interface FontSettings {
  uiFamily: string;
  terminalFamily: string;
  terminalFontSize: number;
}

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  uiFamily: "",
  terminalFamily: "",
  terminalFontSize: 12,
};

const CONFIG_KEY = "font_settings";
const CACHE_KEY = "omcx.font_settings";
const CHANGE_EVENT = "omcx-font-settings-changed";

export const UI_FONT_FALLBACK =
  'Inter, system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Avenir, Helvetica, Arial, sans-serif';

const TERMINAL_FONT_FALLBACK =
  '"SFMono-Regular", "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Maple Mono NF", "MesloLGS NF", "JetBrainsMono Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "CaskaydiaCove Nerd Font", "Symbols Nerd Font", "Apple Symbols", "Arial Unicode MS", "Apple Color Emoji", monospace';

function sanitizeFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // 仅保留字体家族名允许的字符，杜绝拼接 CSS 时的注入风险
  return value.replace(/["\\;{}\n\r]/g, "").trim().slice(0, 80);
}

function normalize(input: Partial<FontSettings> = {}): FontSettings {
  const size = Number(input.terminalFontSize);
  return {
    uiFamily: sanitizeFamily(input.uiFamily),
    terminalFamily: sanitizeFamily(input.terminalFamily),
    terminalFontSize: Number.isFinite(size)
      ? Math.min(24, Math.max(9, Math.round(size)))
      : DEFAULT_FONT_SETTINGS.terminalFontSize,
  };
}

function readCache(): FontSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { ...DEFAULT_FONT_SETTINGS };
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_FONT_SETTINGS };
  }
}

function writeCache(settings: FontSettings) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私窗口或禁用存储时忽略
  }
}

let current: FontSettings = readCache();

// 模块加载即应用本地缓存，尽量缩短启动首帧的字体切换闪烁
try {
  applyToDom(current);
} catch {
  // 非浏览器环境忽略
}

export function buildUiFontFamily(family: string): string {
  const safe = sanitizeFamily(family);
  return safe ? `"${safe}", ${UI_FONT_FALLBACK}` : UI_FONT_FALLBACK;
}

export function buildTerminalFontFamily(family: string): string {
  const safe = sanitizeFamily(family);
  return safe ? `"${safe}", ${TERMINAL_FONT_FALLBACK}` : TERMINAL_FONT_FALLBACK;
}

function applyToDom(settings: FontSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--omcx-ui-font", buildUiFontFamily(settings.uiFamily));
  root.style.setProperty("--omcx-terminal-font", buildTerminalFontFamily(settings.terminalFamily));
  root.style.setProperty("--omcx-terminal-font-size", `${settings.terminalFontSize}px`);
}

export function getFontSettings(): FontSettings {
  return { ...current };
}

function emit() {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: getFontSettings() }));
  } catch {
    // ignore
  }
}

export function subscribeFontSettings(
  listener: (settings: FontSettings) => void
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<FontSettings>).detail || getFontSettings());
  };
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

/** 启动时先应用本地缓存，再从主进程配置校准 */
export function initFontSettings() {
  applyToDom(current);
  emit();
}

export async function loadFontSettings(): Promise<FontSettings> {
  try {
    const raw = await window.electronAPI?.getConfig?.(CONFIG_KEY);
    if (raw) {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      current = normalize(parsed);
      writeCache(current);
      applyToDom(current);
      emit();
    }
  } catch {
    // 配置损坏时保留缓存值
  }
  applyToDom(current);
  return getFontSettings();
}

export async function setFontSettings(patch: Partial<FontSettings>): Promise<FontSettings> {
  current = normalize({ ...current, ...patch });
  writeCache(current);
  applyToDom(current);
  emit();
  try {
    await window.electronAPI?.setConfig?.(CONFIG_KEY, JSON.stringify(current));
  } catch {
    // 落盘失败不影响本次会话生效
  }
  return getFontSettings();
}

export async function resetFontSettings(): Promise<FontSettings> {
  return setFontSettings({ ...DEFAULT_FONT_SETTINGS });
}

/** 判断字体名是否更像编程/等宽字体，用于设置页分组展示 */
export function isMonospaceLike(family: string): boolean {
  return /mono|code|consol|courier|menlo|monaco|hack|iosevka|inconsolata|source ?code|fira|jetbrains|meslo|cascadia|sf mono|andale|PT Mono|Anonymous/i.test(
    family
  );
}
