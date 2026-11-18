import { useEffect, useState } from 'react';
import Layout from './components/layout/Layout';
import ErrorBoundary from './components/common/ErrorBoundary';
import { Sparkles, RefreshCw, X } from 'lucide-react';
import {
  loadTheme,
  getAppearance,
  subscribeAppearanceChange,
  getEffectiveTheme,
  subscribeThemeChange,
  WALLPAPER_PRESETS,
  type AppearanceConfig,
  type EffectiveTheme,
} from './theme';
import { useAppStore } from './stores/appStore';
import { initFontSettings, loadFontSettings } from './lib/fontSettings';

function App() {
  const setTheme = useAppStore((s) => s.setTheme);
  const [appearance, setAppearanceState] = useState<AppearanceConfig>(getAppearance());
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(getEffectiveTheme());
  const [downloadedUpdate, setDownloadedUpdate] = useState<{ version: string } | null>(null);

  useEffect(() => {
    loadTheme()
      .then((mode) => setTheme(mode))
      .catch(() => {});

    // 先用本地缓存立即应用字体，再从配置校准，避免启动字体闪烁
    initFontSettings();
    loadFontSettings().catch(() => {});

    const unsubApp = subscribeAppearanceChange((cfg) => setAppearanceState({ ...cfg }));
    const unsubTheme = subscribeThemeChange((t) => setEffectiveTheme(t));
    const unsubUpdate = window.electronAPI?.onUpdateDownloaded?.((info: any) => {
      if (info?.version) {
        setDownloadedUpdate({ version: info.version });
      }
    });

    return () => {
      unsubApp();
      unsubTheme();
      unsubUpdate?.();
    };
  }, [setTheme]);

  const presetItem = WALLPAPER_PRESETS.find((p) => p.id === appearance.bgImage);
  const isTransparent = appearance.surfaceOpacity < 100;
  // 只要选择了壁纸或调低了不透明度，就渲染底层背景；未选壁纸时用主题氛围渐变兜底，确保透明效果始终可见
  const hasBackdrop = Boolean(appearance.bgImage) || isTransparent;

  const defaultAmbientGradient =
    effectiveTheme === 'light'
      ? 'radial-gradient(circle at 20% 20%, rgba(148,163,184,0.35), transparent 55%), radial-gradient(circle at 80% 75%, rgba(191,219,254,0.45), transparent 55%), linear-gradient(135deg, #eef2f7 0%, #e2e8f0 55%, #f5f7fa 100%)'
      : 'radial-gradient(circle at 20% 22%, rgba(56,189,248,0.20), transparent 52%), radial-gradient(circle at 80% 75%, rgba(139,92,246,0.20), transparent 55%), linear-gradient(135deg, #0b1120 0%, #111827 55%, #0f0f12 100%)';

  const backdropImage = presetItem
    ? presetItem.css
    : appearance.bgImage
      ? `url("${appearance.bgImage}")`
      : defaultAmbientGradient;

  // 根据壁纸类型与不透明度保留极轻量柔光保护，把主要通透控制权留给单层面板自身，
  // 从而让极光/深海/暮光/翡翠等渐变色彩完整透入三栏界面
  const veilOpacity = presetItem
    ? effectiveTheme === 'light'
      ? Math.max(0.04, (appearance.surfaceOpacity / 100) * 0.16)
      : Math.max(0.06, (appearance.surfaceOpacity / 100) * 0.18)
    : effectiveTheme === 'light'
      ? Math.max(0.08, (appearance.surfaceOpacity / 100) * 0.22)
      : Math.max(0.1, (appearance.surfaceOpacity / 100) * 0.24);

  return (
    <div
      className='w-screen h-screen relative overflow-hidden text-[var(--ui-text-primary)]'
      style={{
        backgroundColor: effectiveTheme === 'light' ? '#f5f7fa' : '#121212',
      }}
    >
      {/* 全局底层背景图片 / 渐变壁纸与高斯虚化层 */}
      {hasBackdrop && (
        <div className='fixed inset-0 z-0 pointer-events-none overflow-hidden'>
          <div
            className='w-full h-full bg-cover bg-center bg-no-repeat transition-all duration-300'
            style={{
              backgroundImage: backdropImage,
              filter:
                appearance.bgBlur > 0
                  ? `blur(${Math.max(1, Math.round(appearance.bgBlur * 0.65))}px)`
                  : undefined,
              transform: appearance.bgBlur > 0 ? 'scale(1.06)' : 'scale(1.01)',
            }}
          />
          {/* 亮/暗主题自适应护眼对比度遮罩，防止壁纸高光或暗部干扰正文阅读 */}
          <div
            className='absolute inset-0 transition-colors duration-300'
            style={{
              backgroundColor:
                effectiveTheme === 'light'
                  ? `rgba(248, 250, 252, ${veilOpacity})`
                  : `rgba(14, 14, 18, ${veilOpacity})`,
            }}
          />
        </div>
      )}

      {/* 主应用布局层 */}
      <div className='relative z-10 w-full h-full'>
        <ErrorBoundary>
          <Layout />
        </ErrorBoundary>
      </div>

      {/* 全局新版本就绪通知浮条 (右下角优雅弹出) */}
      {downloadedUpdate && (
        <div className='fixed bottom-5 right-5 z-[99999] w-[340px] p-3.5 rounded-2xl bg-[var(--ui-popover-bg)] border border-emerald-500/40 shadow-2xl backdrop-blur-2xl flex flex-col gap-2 select-none animate-in fade-in slide-in-from-bottom-3 duration-200'>
          <div className='flex items-start justify-between gap-2'>
            <div className='flex items-center gap-2'>
              <div className='w-6 h-6 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0'>
                <Sparkles size={13} />
              </div>
              <span className='text-xs font-bold text-neutral-100'>
                新版本 v{downloadedUpdate.version} 已就绪
              </span>
            </div>
            <button
              onClick={() => setDownloadedUpdate(null)}
              className='p-1 rounded text-neutral-400 hover:text-white transition-colors cursor-pointer'
              title='稍后提醒'
            >
              <X size={13} />
            </button>
          </div>

          <p className='text-[11px] text-neutral-400 leading-relaxed pl-8'>
            最新版本已在后台下载校验完毕，立即重启即可无缝应用所有优化。
          </p>

          <div className='flex items-center justify-end gap-2 pt-1'>
            <button
              onClick={() => setDownloadedUpdate(null)}
              className='px-2.5 py-1 text-xs text-neutral-400 hover:text-white transition-colors cursor-pointer'
            >
              稍后
            </button>
            <button
              onClick={() => {
                if (window.electronAPI?.quitAndInstallUpdate) {
                  window.electronAPI.quitAndInstallUpdate();
                }
              }}
              className='px-3 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer'
            >
              <RefreshCw size={11} />
              <span>立即重启生效</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
