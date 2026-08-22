/**
 * useHotkeys — 全局键盘快捷键（副作用 Hook，在 App.tsx 中挂载一次）
 *
 * Ctrl+L      → 清空当前终端
 * Ctrl+K      → 连接/断开当前活动端口
 * Ctrl+B      → 切换左侧边栏显示/隐藏
 * Ctrl+/      → 切换快捷键帮助弹窗
 * Escape      → 关闭最上层弹窗（快捷键帮助 → 配置弹窗 → 新手引导）
 *
 * Ctrl+F 由 TerminalView 本地处理，此处不拦截。
 * 焦点在 input/textarea/select 时忽略除 Escape 外的所有快捷键。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { clearTerminal } from '../utils/terminal/viewportManager';
import { useSerialConnection } from './useSerialConnection';

function isFormField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function useHotkeys(): void {
  const { toggleConnection } = useSerialConnection();

  // Keep latest callbacks in refs so the keydown listener is registered only once.
  const toggleRef = useRef(toggleConnection);
  toggleRef.current = toggleConnection;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Escape always works — close topmost modal/dialog
      if (e.key === 'Escape') {
        const state = useAppStore.getState();
        if (state.ui.isHotkeyHelpOpen) {
          state.setUIState({ isHotkeyHelpOpen: false });
        } else if (state.ui.isConfigOpen) {
          state.toggleConfigModal(false);
        }
        return;
      }

      // Ignore shortcuts when focus is in a form field
      if (isFormField(e.target)) return;

      if (ctrl && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        const { activeTabId } = useAppStore.getState();
        if (activeTabId) clearTerminal(activeTabId);
      } else if (ctrl && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const { activeTabId } = useAppStore.getState();
        if (activeTabId) void toggleRef.current(activeTabId);
      } else if (ctrl && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        const state = useAppStore.getState();
        state.setUIState({ sidebarCollapsed: !state.ui.sidebarCollapsed });
      } else if (ctrl && e.key === '/') {
        e.preventDefault();
        const state = useAppStore.getState();
        state.setUIState({ isHotkeyHelpOpen: !state.ui.isHotkeyHelpOpen });
      }
      // Ctrl+F is intentionally not handled here — TerminalView owns it locally.
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
