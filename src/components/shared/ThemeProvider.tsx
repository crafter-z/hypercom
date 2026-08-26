import React, { useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { fileService } from '../../services/tauri';

/**
 * Applies presentation concerns to `<html>`:
 *  - theme (`dark` / `light` / `system` via matchMedia) as `data-theme`
 *  - user-configured font families + sizes as CSS variables
 *
 * Power management (preventScreenOff / preventSleep) intentionally lives in
 * `usePowerManagement` — call it at the app root instead.
 */
const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const theme = useAppStore((s) => s.config.theme);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);
  const terminalFont = useAppStore((s) => s.config.terminalFont);
  const uiFont = useAppStore((s) => s.config.uiFont);
  const uiFontSize = useAppStore((s) => s.config.uiFontSize);
  const backgroundImage = useAppStore((s) => s.config.backgroundImage);
  const backgroundImageEnabled = useAppStore((s) => s.config.backgroundImageEnabled);
  const backgroundImageOpacity = useAppStore((s) => s.config.backgroundImageOpacity);
  const backgroundImageBlur = useAppStore((s) => s.config.backgroundImageBlur);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const applySystemTheme = () => {
        root.setAttribute('data-theme', mediaQuery.matches ? 'dark' : 'light');
      };
      applySystemTheme();
      mediaQuery.addEventListener('change', applySystemTheme);
      return () => mediaQuery.removeEventListener('change', applySystemTheme);
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-terminal', `${terminalFontSize}px`);
    document.documentElement.style.setProperty('--font-terminal', terminalFont);
    document.documentElement.style.setProperty('--font-size-ui', `${uiFontSize}px`);
    document.documentElement.style.setProperty('--font-ui', uiFont);
  }, [terminalFontSize, terminalFont, uiFontSize, uiFont]);

  // 自定义背景图（issue #13）：把配置映射到 CSS 变量 + html[data-app-bg] 门控。
  // 图片经后端 read_image_data_url 读为 base64 data URL（dev/prod 一致，无需 asset protocol）；
  // 异步读取期间以 cancelled 防竞态。opacity/blur 只改 CSS 变量，不触发读盘——
  // 拆成两个 effect，滑块连续拖动不会反复读图（每次读盘是 20MB 上限的 IO）。
  useEffect(() => {
    const root = document.documentElement;
    let cancelled = false;
    const active = backgroundImageEnabled && backgroundImage !== '';
    root.style.setProperty('--app-bg-opacity', String(Math.max(0, Math.min(100, backgroundImageOpacity)) / 100));
    root.style.setProperty('--app-bg-blur', `${Math.max(0, Math.min(64, backgroundImageBlur))}px`);
    if (!active) {
      root.removeAttribute('data-app-bg');
      root.style.removeProperty('--app-bg-image');
      return undefined;
    }
    root.setAttribute('data-app-bg', 'on');
    fileService
      .readImageDataUrl(backgroundImage)
      .then((dataUrl) => {
        if (cancelled) return;
        if (!dataUrl) {
          root.style.removeProperty('--app-bg-image');
          return;
        }
        root.style.setProperty('--app-bg-image', `url("${dataUrl}")`);
      })
      .catch(() => {
        if (!cancelled) root.style.removeProperty('--app-bg-image');
      });
    return () => {
      cancelled = true;
    };
  }, [backgroundImage, backgroundImageEnabled]);

  return <>{children}</>;
};

export default ThemeProvider;
