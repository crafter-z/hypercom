import React, { useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';

/**
 * Applies presentation concerns to `<html>`:
 *  - theme (`dark` / `light` / `system` via matchMedia) as `data-theme`
 *  - user-configured font families + sizes as CSS variables
 *  - optional background image as `--bg-image`
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

  useEffect(() => {
    if (backgroundImage) {
      document.documentElement.style.setProperty('--bg-image', `url("${backgroundImage}")`);
    } else {
      document.documentElement.style.removeProperty('--bg-image');
    }
  }, [backgroundImage]);

  return <>{children}</>;
};

export default ThemeProvider;
