import React, { useState, useEffect } from "react";
import {
  Sun,
  Moon,
  Monitor,
  Image as ImageIcon,
  Sparkles,
  RotateCcw,
  Type,
  RotateCw,
  FolderOpen,
  CheckCircle2,
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
} from "../../theme";
import {
  getFontSettings,
  loadFontSettings,
  resetFontSettings,
  setFontSettings,
  isMonospaceLike,
  buildUiFontFamily,
  buildTerminalFontFamily,
  type FontSettings,
} from "../../lib/fontSettings";
import { useAppStore } from "../../stores/appStore";

interface AppearanceSettingsSectionProps {
  showToast: (msg: string) => void;
}

export const AppearanceSettingsSection: React.FC<AppearanceSettingsSectionProps> = ({ showToast }) => {
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>("system");
  const [appearance, setAppearanceState] = useState<AppearanceConfig>(getAppearance());
  const setStoreTheme = useAppStore((s) => s.setTheme);

  // 字体设置（界面字体 / 终端字体 / 终端字号）
  const [fontSettings, setFontSettingsState] = useState<FontSettings>(getFontSettings());
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontsLoading, setFontsLoading] = useState(false);
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

  useEffect(() => {
    const init = async () => {
      const savedTheme = await loadTheme();
      setCurrentTheme(savedTheme);
      setStoreTheme(savedTheme);
      const savedAppearance = await loadAppearance();
      setAppearanceState(savedAppearance);
      const savedFonts = await loadFontSettings();
      setFontSettingsState(savedFonts);
      handleReloadSystemFonts(false);
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
                {/* 主题与个性化背景设置 */}
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-5">
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
                          className="px-3 py-1.5 rounded-xl ui-btn-primary text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
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
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-5">
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

    </>
  );
};
