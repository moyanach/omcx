import { useEffect, useState } from 'react';
import Layout from './components/layout/Layout';
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

function App() {
  const setTheme = useAppStore((s) => s.setTheme);
  const [appearance, setAppearanceState] = useState<AppearanceConfig>(getAppearance());
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(getEffectiveTheme());

  useEffect(() => {
    loadTheme()
      .then((mode) => setTheme(mode))
      .catch(() => {});

    const unsubApp = subscribeAppearanceChange((cfg) => setAppearanceState({ ...cfg }));
    const unsubTheme = subscribeThemeChange((t) => setEffectiveTheme(t));
    return () => {
      unsubApp();
      unsubTheme();
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

  // 根据壁纸不透明度动态调节底层护眼柔光遮罩，确保无论壁纸多复杂，前景文字与代码始终高对比清晰
  const veilOpacity =
    effectiveTheme === 'light'
      ? Math.max(0.18, (appearance.surfaceOpacity / 100) * 0.45)
      : Math.max(0.22, (appearance.surfaceOpacity / 100) * 0.5);

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
                appearance.bgBlur > 0 ? `blur(${appearance.bgBlur}px)` : undefined,
              transform: appearance.bgBlur > 0 ? 'scale(1.08)' : 'scale(1.01)',
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
        <Layout />
      </div>
    </div>
  );
}

export default App;
